// Self-check for service.js and kodi-service.js: serves a fake release (with a redirect,
// like GitHub) and kodi-service.js, runs the loader in a sandbox as TizenBrew does, and
// checks the downloaded files, the status, resuming a stalled download, the port handover
// and /reload.
// Usage: node test-service.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const files = { 'files.txt': 'index.html\nkodi.wasm\nmedia/splash.jpg\n', 'index.html': '<p>kodi</p>', 'kodi.wasm': 'x'.repeat(300000), 'media/splash.jpg': 'jpg' };
let serviceCode;
// The second request for kodi.wasm, made by the second copy below, sends 50 kB and then
// goes silent.
let wasmRequests = 0;
const release = http.createServer((req, res) => {
  if (req.url.startsWith('/kodi-service.js?')) return res.end(serviceCode);
  const m = req.url.match(/^\/releases\/download\/v0\.0\.1\/(.+)$/);
  if (m) { res.writeHead(302, { location: '/storage/' + m[1] }); return res.end(); }
  const name = decodeURIComponent(req.url.replace('/storage/', '')).replace(/__/g, '/');
  if (!(name in files)) { res.writeHead(404); return res.end(); }
  const range = /^bytes=(\d+)-$/.exec(req.headers.range || ''), from = range ? Number(range[1]) : 0;
  const body = files[name].slice(from);
  if (range) res.writeHead(206, { 'content-length': body.length, 'content-range': `bytes ${from}-${files[name].length - 1}/${files[name].length}` });
  else res.writeHead(200, { 'content-length': body.length });
  if (name === 'kodi.wasm' && ++wasmRequests === 2) return res.write(body.slice(0, 50000));
  res.end(body);
}).listen(0, '127.0.0.1');
await new Promise((r) => release.on('listening', r));
const base = `http://127.0.0.1:${release.address().port}/`;
serviceCode = fs.readFileSync(new URL('./kodi-service.js', import.meta.url), 'utf8')
  .replace('https://github.com/Jertlok/tizenbrew-kodi/', base);

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'kodi-svc-'));
process.env.KODI_DATA_DIR = data;
process.env.KODI_SERVICE_SRC = base + 'kodi-service.js';
process.env.KODI_STALL_MS = '300';
const loader = fs.readFileSync(new URL('./service.js', import.meta.url), 'utf8');
// Like TizenBrew's serviceLauncher.js: every global, plus require and module.
const run = () => { const sandbox = {};
  for (const k of Object.getOwnPropertyNames(globalThis)) if (!['global', 'module'].includes(k)) sandbox[k] = globalThis[k];
  Object.assign(sandbox, { require: createRequire(import.meta.url), module: { exports: {} } });
  vm.runInContext(loader, vm.createContext(sandbox)); return sandbox.module.exports; };
const until = async (f) => { for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 50)); assert.ok(f()); };
const status = async () => (await fetch('http://127.0.0.1:8083/status')).json();

const dir = path.join(data, 'kodi', 'v0.0.1');
const old = run();   // an older copy still holding the port, as after a module update
await until(() => old.current() && old.current().status.state === 'ready');
// Make the second copy download kodi.wasm again.
fs.rmSync(path.join(dir, 'kodi.wasm')); fs.rmSync(path.join(dir, '.complete'));
const svc = run();
await until(() => svc.current() && svc.current().server.listening);
assert.equal(old.current().server.listening, false);   // the old copy handed the port over
assert.notEqual(old.current().status.state, 'error');

const first = svc.current();
await until(() => first.status.state === 'ready' || first.status.state === 'error');
assert.equal(first.status.error, null);
assert.equal(first.status.state, 'ready');
for (const f of ['index.html', 'kodi.wasm', 'media/splash.jpg']) assert.equal(fs.readFileSync(path.join(dir, f), 'utf8'), files[f]);
assert.equal(first.status.url, 'file://' + dir + '/index.html');
const events = first.status.log.join('\n');
assert.match(events, /retry kodi\.wasm \(no data for 0\.3 s\)/);
assert.match(events, /get kodi\.wasm from byte \d+/);
assert.equal((await status()).state, 'ready');

// /reload runs the newest service code: here a copy that marks its status.
serviceCode = serviceCode.replace('node: process.version,', 'node: process.version, reloaded: true,');
assert.equal((await (await fetch('http://127.0.0.1:8083/reload')).json()).reloading, true);
await until(() => svc.current() !== first && svc.current().server.listening);
assert.equal((await status()).reloaded, true);
assert.equal(first.status.state, 'ready');   // a copy that was already done keeps its state
assert.equal((await status()).state, 'ready');   // already installed: no new download

svc.current().server.close(); release.close();
fs.rmSync(data, { recursive: true });
console.log('ok');
