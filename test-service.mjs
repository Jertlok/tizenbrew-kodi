// Self-check for service.js: serves a fake release (with a redirect, like GitHub),
// runs the service in a vm sandbox as TizenBrew does, and checks the files and status.
// Usage: node test-service.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const files = { 'files.txt': 'index.html\nkodi.wasm\nmedia/splash.jpg\n', 'index.html': '<p>kodi</p>', 'kodi.wasm': 'x'.repeat(300000), 'media/splash.jpg': 'jpg' };
const release = http.createServer((req, res) => {
  const m = req.url.match(/^\/releases\/download\/v0\.0\.1\/(.+)$/);
  if (m) { res.writeHead(302, { location: '/storage/' + m[1] }); return res.end(); }
  const name = decodeURIComponent(req.url.replace('/storage/', '')).replace(/__/g, '/');
  if (!(name in files)) { res.writeHead(404); return res.end(); }
  res.end(files[name]);
}).listen(0, '127.0.0.1');
await new Promise((r) => release.on('listening', r));

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'kodi-svc-'));
process.env.KODI_DATA_DIR = data;
const src = fs.readFileSync(new URL('./service.js', import.meta.url), 'utf8')
  .replace('https://github.com/Jertlok/tizenbrew-kodi/', `http://127.0.0.1:${release.address().port}/`);
const sandbox = { require: createRequire(import.meta.url), module: { exports: {} }, process, URL, Buffer, console };
vm.runInContext(src, vm.createContext(sandbox));
const { status, server } = sandbox.module.exports;

for (let i = 0; i < 100 && status.state !== 'ready' && status.state !== 'error'; i++) await new Promise((r) => setTimeout(r, 50));
assert.equal(status.error, null);
assert.equal(status.state, 'ready');
assert.equal(status.done, 3);
const dir = path.join(data, 'kodi', 'v0.0.1');
for (const f of ['index.html', 'kodi.wasm', 'media/splash.jpg']) assert.equal(fs.readFileSync(path.join(dir, f), 'utf8'), files[f]);
assert.ok(fs.existsSync(path.join(dir, '.complete')));
assert.equal(status.url, 'file://' + dir + '/index.html');
assert.equal((await (await fetch('http://127.0.0.1:8082/status')).json()).state, 'ready');

server.close(); release.close();
fs.rmSync(data, { recursive: true });
console.log('ok');
