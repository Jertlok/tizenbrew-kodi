// Self-check for service.js and kodi-service.js: serves a fake release (with a redirect,
// like GitHub) and kodi-service.js, runs the loader in a sandbox as TizenBrew does, and
// checks the downloaded files, the status, resuming a stalled download, unpacking gzipped
// assets, the port handover, /reload, finding DevTools and /install through a fake sdb.
// Usage: node test-service.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

// The release the service downloads, as publish.sh reads it.
const RELEASE = /^var KODI_RELEASE = '(.*)';/m.exec(fs.readFileSync(new URL('./kodi-service.js', import.meta.url), 'utf8'))[1];
const wasm = Buffer.from(Array.from({ length: 300000 }, (_, i) => i * 7 % 251));
const files = { 'files.txt': 'index.html\nkodi.wasm.gz\nmedia/splash.jpg\n', 'index.html': '<p>kodi</p>',
                'kodi.wasm.gz': zlib.gzipSync(wasm, { level: 0 }), 'media/splash.jpg': 'jpg', 'Kodi.wgt': 'PK widget' };
let serviceCode;
// The second request for kodi.wasm.gz, made by the second copy below, sends 50 kB and then
// goes silent.
let wasmRequests = 0;
const release = http.createServer((req, res) => {
  if (req.url.startsWith('/kodi-service.js?')) return res.end(serviceCode);
  const m = req.url.match(new RegExp('^/releases/download/' + RELEASE + '/(.+)$'));
  if (m) { res.writeHead(302, { location: '/storage/' + m[1] }); return res.end(); }
  const name = decodeURIComponent(req.url.replace('/storage/', '')).replace(/__/g, '/');
  if (!(name in files)) { res.writeHead(404); return res.end(); }
  const range = /^bytes=(\d+)-$/.exec(req.headers.range || ''), from = range ? Number(range[1]) : 0;
  const body = files[name].slice(from);
  if (range) res.writeHead(206, { 'content-length': body.length, 'content-range': `bytes ${from}-${files[name].length - 1}/${files[name].length}` });
  else res.writeHead(200, { 'content-length': body.length });
  if (name === 'kodi.wasm.gz' && ++wasmRequests === 2) return res.write(body.slice(0, 50000));
  res.end(body);
}).listen(0, '127.0.0.1');
await new Promise((r) => release.on('listening', r));
const base = `http://127.0.0.1:${release.address().port}/`;
serviceCode = fs.readFileSync(new URL('./kodi-service.js', import.meta.url), 'utf8')
  .replace('https://github.com/Jertlok/tizenbrew-kodi/', base);

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'kodi-svc-'));
// Left by an earlier Kodi release; removed once this one is installed.
fs.mkdirSync(path.join(data, 'kodi', 'v0.0.0'), { recursive: true });

// A fake sdb: answers CNXN, OPEN and WRTE like the TV's, and records the shell command
// and whether the widget was there when it ran.
let sdbCommand = null, sdbSawFile = false;
const pkt = (cmd, a, b, d = Buffer.alloc(0)) => { const h = Buffer.alloc(24); h.write(cmd, 0, 'ascii');
  h.writeUInt32LE(a, 4); h.writeUInt32LE(b, 8); h.writeUInt32LE(d.length, 12); return Buffer.concat([h, d]); };
const sdb = net.createServer((sock) => {
  let buf = Buffer.alloc(0);
  sock.on('data', (c) => {
    buf = Buffer.concat([buf, c]);
    while (buf.length >= 24 && buf.length >= 24 + buf.readUInt32LE(12)) {
      const cmd = buf.toString('ascii', 0, 4), local = buf.readUInt32LE(4), d = buf.slice(24, 24 + buf.readUInt32LE(12));
      buf = buf.slice(24 + d.length);
      if (cmd === 'CNXN') sock.write(pkt('CNXN', 0x01000000, 4096, Buffer.from('device::\0')));
      if (cmd === 'OPEN') {
        sdbCommand = d.toString().replace(/\0$/, '');
        sdbSawFile = fs.existsSync(sdbCommand.split(' ').pop());
        sock.write(/ debug /.test(sdbCommand)
          ? Buffer.concat([pkt('OKAY', 77, local), pkt('WRTE', 77, local, Buffer.from('... successfully launched pid = 1 with debug 1 port: 41234\n'))])
          : Buffer.concat([pkt('OKAY', 77, local), pkt('WRTE', 77, local, Buffer.from('install KodiWasmTv\n')),
                           pkt('WRTE', 77, local, Buffer.from('spend time for wascmd is [1200]ms\n'))]));
      }
    }
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => sdb.on('listening', r));
process.env.KODI_SDB_PORT = String(sdb.address().port);
process.env.KODI_SDK_TOOLS = path.join(data, 'sdk_tools');
process.env.KODI_DATA_DIR = data;
process.env.KODI_SERVICE_SRC = base + 'kodi-service.js';
process.env.KODI_STALL_MS = '300';
process.env.KODI_NO_OPEN = '1';
const loader = fs.readFileSync(new URL('./service.js', import.meta.url), 'utf8');
// Like TizenBrew's serviceLauncher.js: every global, plus require and module.
const run = () => { const sandbox = {};
  for (const k of Object.getOwnPropertyNames(globalThis)) if (!['global', 'module'].includes(k)) sandbox[k] = globalThis[k];
  Object.assign(sandbox, { require: createRequire(import.meta.url), module: { exports: {} } });
  vm.runInContext(loader, vm.createContext(sandbox)); return sandbox.module.exports; };
const until = async (f) => { for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 50)); assert.ok(f()); };
const status = async () => (await fetch('http://127.0.0.1:8083/status')).json();

const dir = path.join(data, 'kodi', RELEASE);
const old = run();   // an older copy still holding the port, as after a module update
await until(() => old.current() && old.current().status.state === 'ready');
// Make the second copy download kodi.wasm again.
assert.deepEqual(fs.readdirSync(path.join(data, 'kodi')), [RELEASE]);
fs.rmSync(path.join(dir, 'kodi.wasm')); fs.rmSync(path.join(dir, '.complete'));
const svc = run();
await until(() => svc.current() && svc.current().server.listening);
assert.equal(old.current().server.listening, false);   // the old copy handed the port over
assert.notEqual(old.current().status.state, 'error');

const first = svc.current();
await until(() => first.status.state === 'ready' || first.status.state === 'error');
assert.equal(first.status.error, null);
assert.equal(first.status.state, 'ready');
for (const f of ['index.html', 'media/splash.jpg']) assert.equal(fs.readFileSync(path.join(dir, f), 'utf8'), files[f]);
assert.ok(fs.readFileSync(path.join(dir, 'kodi.wasm')).equals(wasm));
assert.equal(fs.existsSync(path.join(dir, 'kodi.wasm.gz')), false);
assert.equal(first.status.url, 'file://' + dir + '/index.html');
const events = first.status.log.join('\n');
assert.match(events, /retry kodi\.wasm\.gz \(no data for 0\.3 s\)/);
assert.match(events, /get kodi\.wasm\.gz from byte \d+/);
assert.equal((await status()).state, 'ready');

// /reload runs the newest service code: here a copy that marks its status.
serviceCode = serviceCode.replace('node: process.version,', 'node: process.version, reloaded: true,');
assert.equal((await (await fetch('http://127.0.0.1:8083/reload')).json()).reloading, true);
// The copy fetches its successor itself and hands the port over to it.
let after = {};
for (let i = 0; i < 100 && !after.reloaded; i++) {
  await new Promise((r) => setTimeout(r, 50));
  after = await status().catch(() => ({}));
}
assert.equal(after.reloaded, true);
assert.equal(first.server.listening, false);
assert.equal(first.status.state, 'ready');   // a copy that was already done keeps its state
assert.equal((await status()).state, 'ready');   // already installed: no new download

// DevTools is found among the ports in /proc/net/tcp, without the full scan.
const devtools = http.createServer((req, res) => res.end(JSON.stringify([{ type: 'page', url: 'x' }]))).listen(0, '127.0.0.1');
await new Promise((r) => devtools.on('listening', r));
const svcNow = svc.current();
const t0 = Date.now(), found = await svcNow.findDevtools();
assert.ok(found && found.list.length === 1 && Date.now() - t0 < 3000, 'DevTools found quickly');
devtools.close();

// /install: refused without the module page's origin; with it, the widget is fetched and
// handed to sdb, then removed.
const ask = (q, origin, route = '/install?') => new Promise((resolve) => http.get({ host: '127.0.0.1', port: 8083, path: route + q,
  headers: origin ? { origin } : {} }, (res) => { let t = ''; res.on('data', (c) => t += c); res.on('end', () => resolve([res.statusCode, JSON.parse(t)])); }));
const q = 'id=KodiWasmTv&url=' + encodeURIComponent(base + 'releases/download/' + RELEASE + '/Kodi.wgt');
assert.equal((await ask(q))[0], 400);
assert.equal((await ask(q, 'http://evil.example'))[0], 400);
assert.equal((await ask('id=Kodi;reboot&url=' + encodeURIComponent(base), 'http://127.0.0.1:8081'))[0], 400);
assert.deepEqual(await ask(q, 'http://127.0.0.1:8081'), [200, { installing: true }]);
let inst = {};
for (let i = 0; i < 100 && !/done|error/.test(inst.state); i++) { await new Promise((r) => setTimeout(r, 50)); inst = (await status()).install || {}; }
assert.equal(inst.error, null);
assert.equal(inst.state, 'done');
assert.match(inst.output, /spend time/);
assert.equal(sdbCommand, 'shell:0 vd_appinstall KodiWasmTv ' + path.join(data, 'sdk_tools', 'tizenbrew-kodi-install.wgt'));
assert.ok(sdbSawFile);
assert.deepEqual(fs.readdirSync(path.join(data, 'sdk_tools')), []);

// /debug: starts an app with DevTools through sdb and replies with the port.
assert.equal((await ask('app=KodiWasmTv.Kodi', null, '/debug?'))[0], 400);
assert.equal((await ask('app=KodiWasmTv.Kodi;reboot', 'http://127.0.0.1:8081', '/debug?'))[0], 400);
assert.deepEqual(await ask('app=KodiWasmTv.Kodi', 'http://127.0.0.1:8081', '/debug?'), [200, { port: 41234 }]);
assert.equal(sdbCommand, 'shell:0 debug KodiWasmTv.Kodi');

const loaderLog = await (await fetch('http://127.0.0.1:8084')).json();
assert.match(loaderLog.events.join('\n'), /got \d+ bytes in \d+ ms, starting it/);
await fetch('http://127.0.0.1:8083/shutdown'); release.close(); sdb.close();
old.logServer.close(); svc.logServer.close();
fs.rmSync(data, { recursive: true });
console.log('ok');
