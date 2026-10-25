// Installs a widget (.wgt) on the TV from this PC, with Developer Mode left at 127.0.0.1.
//
//   node tools/tv.mjs install <widget.wgt> --tv <tv-ip>   sign, then install on the TV
//   node tools/tv.mjs sign <in.wgt> <out.wgt>             only sign
//
// The widget is signed with the user's own Samsung certificate, the one TizenBrew
// Installer Desktop made (~/share/tizenbrewInstallerConfig.json, or TB_CERTS=<file>), and
// served on the LAN for one download. Through TizenBrew's DevTools, a page of TizenBrew
// asks the Kodi module's service (kodi-service.js) to fetch it and install it with the
// TV's own sdb. The certificate never leaves this PC. Run `npm install` in tools/ first.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const JSZip = require('jszip');
const forge = require('node-forge');
const { Signature } = require('tizen');

// Signs like TizenBrew Installer's resignPackage: author signature, then distributor
// signature over the files and the author signature.
export async function sign(buffer, certs) {
  const zip = await JSZip.loadAsync(buffer);
  const files = [];
  for (const name of Object.keys(zip.files)) {
    const f = zip.files[name];
    if (f.dir || /signature.*\.xml$/.test(name)) continue;
    files.push({ uri: encodeURIComponent(name), data: await f.async('nodebuffer') });
  }
  const p12 = (b64) => forge.pkcs12.pkcs12FromAsn1(
    forge.asn1.fromDer(Buffer.from(b64, 'base64').toString('binary')), false, certs.password);
  const author = await new Signature('AuthorSignature', files).sign(p12(certs.authorCert));
  const signed = await new Signature('DistributorSignature', author).sign(p12(certs.distributorCert));
  const out = new JSZip();
  for (const f of signed) out.file(decodeURIComponent(f.uri), f.data);
  return out.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

export async function packageId(buffer) {
  const xml = await (await JSZip.loadAsync(buffer)).file('config.xml').async('string');
  const m = /<tizen:application\b[^>]*\bpackage="([A-Za-z0-9]{10})"/.exec(xml);
  if (!m) throw new Error('config.xml names no package id');
  return m[1];
}

function readCerts() {
  const file = process.env.TB_CERTS || path.join(os.homedir(), 'share', 'tizenbrewInstallerConfig.json');
  const c = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!c.authorCert || !c.distributorCert || !c.password) throw new Error(file + ' has no certificate; make one with TizenBrew Installer');
  return c;
}

// The address of this PC on the way to the TV (no packet is sent).
function localAddressTowards(host) {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    s.connect(9, host, () => { const a = s.address().address; s.close(); resolve(a); });
    s.on('error', reject);
  });
}

// TizenBrew runs its pages with DevTools on a random port of the TV.
async function findDevtools(tv) {
  const hit = async (port) => {
    try { return { port, list: await (await fetch(`http://${tv}:${port}/json/list`, { signal: AbortSignal.timeout(800) })).json() }; } catch { return null; }
  };
  for (let p = 1024; p < 65536; p += 400) {
    const found = (await Promise.all(Array.from({ length: Math.min(400, 65536 - p) }, (_, i) => hit(p + i)))).find(Boolean);
    if (found) return found;
  }
  throw new Error('no DevTools on ' + tv + ': is TizenBrew open?');
}

async function devtools(target, tv) {
  const ws = new WebSocket(target.webSocketDebuggerUrl.replace(/\/\/[^/]+/, '//' + tv + ':' + new URL(target.webSocketDebuggerUrl).port));
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('DevTools WebSocket failed')); });
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } };
  const call = (method, params) => new Promise((resolve) => { waiting.set(++id, resolve); ws.send(JSON.stringify({ id, method, params })); });
  // Evaluates an expression on the page, awaiting it; throws what the page threw.
  const evaluate = async (expression) => {
    const m = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (m.error) throw new Error(m.error.message);
    if (m.result.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description || m.result.exceptionDetails.text);
    return m.result.result.value;
  };
  return { call, evaluate, close: () => ws.close() };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const status = "fetch('http://127.0.0.1:8083/status').then((r) => r.json())";

// Starts the Kodi module's service through TizenBrew's own WebSocket, as its UI does.
const startService = `(async () => {
  const sock = new WebSocket('ws://127.0.0.1:8081');
  await new Promise((r, j) => { sock.onopen = r; sock.onerror = () => j(new Error('no TizenBrew service')); });
  const modules = await new Promise((r) => { sock.onmessage = (e) => { const m = JSON.parse(e.data); if (m.type === 4) r(m.payload); };
    sock.send(JSON.stringify({ type: 4 })); });
  const kodi = (modules || []).find((m) => /tizenbrew-kodi/i.test(m.fullName));
  if (!kodi) throw new Error('the tizenbrew-kodi module is not added to TizenBrew');
  sock.send(JSON.stringify({ type: 6, payload: kodi }));
  await new Promise((r) => setTimeout(r, 300));
  sock.close();
})()`;

async function install(file, tv) {
  const signed = await sign(fs.readFileSync(file), readCerts());
  const id = await packageId(signed);
  const token = crypto.randomBytes(16).toString('hex');
  // One download of the signed widget, at a path nobody can guess.
  const server = http.createServer((req, res) => {
    if (req.url !== '/' + token + '.wgt') { res.statusCode = 404; return res.end(); }
    res.setHeader('Content-Length', signed.length);
    res.end(signed);
  }).listen(0, '0.0.0.0');
  await new Promise((r) => server.on('listening', r));
  const url = `http://${await localAddressTowards(tv)}:${server.address().port}/${token}.wgt`;
  console.log(`signed ${path.basename(file)} (${id}, ${(signed.length / 1e6).toFixed(1)} MB)`);

  const { port, list } = await findDevtools(tv);
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('no TizenBrew page among the DevTools targets');
  console.log(`DevTools on port ${port}, page ${page.url}`);
  const d = await devtools(page, tv);
  try {
    // The service only takes /install from a page of TizenBrew's module server.
    await d.call('Page.navigate', { url: 'http://127.0.0.1:8081/' });
    await wait(1500);
    try { await d.evaluate(status); } catch {
      console.log('starting the Kodi module service');
      await d.evaluate(startService);
      for (let i = 0; ; i++) {
        await wait(1000);
        try { await d.evaluate(status); break; } catch (e) { if (i > 30) throw new Error('the Kodi module service did not start'); }
      }
    }
    const r = await d.evaluate(`fetch('http://127.0.0.1:8083/install?id=${id}&url=' + encodeURIComponent(${JSON.stringify(url)})).then((r) => r.json())`);
    if (r.error) throw new Error(r.error);
    let s;
    for (;;) {
      await wait(1000);
      s = (await d.evaluate(status)).install;
      process.stdout.write(`\r${s.state} ${(s.bytes / 1e6).toFixed(1)} MB   `);
      if (s.state === 'done' || s.state === 'error') break;
    }
    console.log('\n' + (s.error || s.output.trim()));
    if (s.state === 'error') process.exitCode = 1;
  } finally {
    // Back to what the TV showed.
    await d.call('Page.navigate', { url: page.url });
    d.close();
    server.close();
  }
}

if (import.meta.url === 'file://' + process.argv[1]) {
  const [cmd, a, b] = process.argv.slice(2);
  const tvArg = process.argv.indexOf('--tv');
  const tv = tvArg > 0 ? process.argv[tvArg + 1] : process.env.TV_IP;
  if (cmd === 'sign' && a && b) fs.writeFileSync(b, await sign(fs.readFileSync(a), readCerts()));
  else if (cmd === 'install' && a && tv) await install(a, tv);
  else {
    console.error('usage: tv.mjs install <widget.wgt> --tv <tv-ip>  |  tv.mjs sign <in.wgt> <out.wgt>');
    process.exitCode = 2;
  }
}
