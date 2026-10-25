// Self-check for service.js and kodi-service.js: serves a fake release (with a redirect,
// like GitHub) and kodi-service.js, runs the loader in a sandbox as TizenBrew does, and
// checks the downloaded files, the status, the port handover and /reload.
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
const release = http.createServer((req, res) => {
  if (req.url.startsWith('/kodi-service.js?')) return res.end(serviceCode);
  const m = req.url.match(/^\/releases\/download\/v0\.0\.1\/(.+)$/);
  if (m) { res.writeHead(302, { location: '/storage/' + m[1] }); return res.end(); }
  const name = decodeURIComponent(req.url.replace('/storage/', '')).replace(/__/g, '/');
  if (!(name in files)) { res.writeHead(404); return res.end(); }
  res.end(files[name]);
}).listen(0, '127.0.0.1');
await new Promise((r) => release.on('listening', r));
const base = `http://127.0.0.1:${release.address().port}/`;
serviceCode = fs.readFileSync(new URL('./kodi-service.js', import.meta.url), 'utf8')
  .replace('https://github.com/Jertlok/tizenbrew-kodi/', base);

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'kodi-svc-'));
process.env.KODI_DATA_DIR = data;
process.env.KODI_SERVICE_SRC = base + 'kodi-service.js';
const loader = fs.readFileSync(new URL('./service.js', import.meta.url), 'utf8');
// Like TizenBrew's serviceLauncher.js: every global, plus require and module.
const run = () => { const sandbox = {};
  for (const k of Object.getOwnPropertyNames(globalThis)) if (!['global', 'module'].includes(k)) sandbox[k] = globalThis[k];
  Object.assign(sandbox, { require: createRequire(import.meta.url), module: { exports: {} } });
  vm.runInContext(loader, vm.createContext(sandbox)); return sandbox.module.exports; };
const until = async (f) => { for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 50)); assert.ok(f()); };
const status = async () => (await fetch('http://127.0.0.1:8083/status')).json();

const old = run();   // an older copy still holding the port, as after a module update
await until(() => old.current() && old.current().server.listening);
const svc = run();
await until(() => svc.current() && svc.current().server.listening);
assert.equal(old.current().server.listening, false);   // the old copy handed the port over

const first = svc.current();
await until(() => first.status.state === 'ready' || first.status.state === 'error');
assert.equal(first.status.error, null);
assert.equal(first.status.state, 'ready');
const dir = path.join(data, 'kodi', 'v0.0.1');
for (const f of ['index.html', 'kodi.wasm', 'media/splash.jpg']) assert.equal(fs.readFileSync(path.join(dir, f), 'utf8'), files[f]);
assert.equal(first.status.url, 'file://' + dir + '/index.html');
assert.equal((await status()).state, 'ready');

// /reload runs the newest service code: here a copy that marks its status.
serviceCode = serviceCode.replace('node: process.version,', 'node: process.version, reloaded: true,');
assert.equal((await (await fetch('http://127.0.0.1:8083/reload')).json()).reloading, true);
await until(() => svc.current() !== first && svc.current().server.listening);
assert.equal((await status()).reloaded, true);
assert.equal((await status()).state, 'ready');   // already installed: no new download

svc.current().server.close(); release.close();
fs.rmSync(data, { recursive: true });
console.log('ok');
