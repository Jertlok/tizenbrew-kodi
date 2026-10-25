// TizenBrew service for the Kodi app module. It runs in TizenBrew's Node process
// (a vm sandbox that gets `require` and `tizen`).
//
// Kodi's WASM build needs SharedArrayBuffer, which the TV's web engine only gives to
// file:// documents (COOP/COEP headers do not isolate an http page there). So the
// service downloads the build into TizenBrew's data directory once, and the module's
// page then navigates to it. Progress is served on http://127.0.0.1:8082/status.

var fs = require('fs');
var path = require('path');
var http = require('http');
var https = require('https');

var VERSION = '0.0.1';
var BASE = 'https://github.com/Jertlok/tizenbrew-kodi/releases/download/v' + VERSION + '/';
var DATA = (typeof tizen === 'object')
  ? '/opt/usr/home/owner/apps_rw/' + tizen.application.getAppInfo().packageId + '/data'
  : process.env.KODI_DATA_DIR;
var DIR = path.join(DATA, 'kodi', VERSION);
var DONE = path.join(DIR, '.complete');

var status = { state: 'starting', done: 0, total: 0, bytes: 0, error: null, url: 'file://' + DIR + '/index.html' };

function mkdirp(dir) {
  if (fs.existsSync(dir)) return;
  mkdirp(path.dirname(dir));
  fs.mkdirSync(dir);
}

// GET following redirects (GitHub release assets redirect to their storage host).
function get(url, redirects) {
  return new Promise(function (resolve, reject) {
    (url.indexOf('https:') === 0 ? https : http).get(url, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if ((redirects || 0) > 5) return reject(new Error('too many redirects: ' + url));
        return resolve(get(new URL(res.headers.location, url).href, (redirects || 0) + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' ' + url)); }
      resolve(res);
    }).on('error', reject);
  });
}

function download(name) {
  var dest = path.join(DIR, name);
  mkdirp(path.dirname(dest));
  // Release assets are flat: publish.sh uploads media/splash.jpg as media__splash.jpg.
  return get(BASE + encodeURIComponent(name.replace(/\//g, '__'))).then(function (res) {
    return new Promise(function (resolve, reject) {
      var out = fs.createWriteStream(dest + '.part');
      res.on('data', function (chunk) { status.bytes += chunk.length; });
      res.on('error', reject);
      out.on('error', reject);
      out.on('finish', function () { fs.renameSync(dest + '.part', dest); resolve(); });
      res.pipe(out);
    });
  });
}

function install() {
  if (fs.existsSync(DONE)) { status.state = 'ready'; return Promise.resolve(); }
  status.state = 'downloading';
  mkdirp(DIR);
  return get(BASE + 'files.txt').then(function (res) {
    return new Promise(function (resolve, reject) {
      var text = '';
      res.on('data', function (c) { text += c; });
      res.on('end', function () { resolve(text.split('\n').map(function (l) { return l.trim(); }).filter(Boolean)); });
      res.on('error', reject);
    });
  }).then(function (files) {
    status.total = files.length;
    // One file at a time: kodi.data and kodi.wasm are large and the TV is short of memory.
    return files.reduce(function (p, name) {
      return p.then(function () { return download(name); }).then(function () { status.done++; });
    }, Promise.resolve());
  }).then(function () {
    fs.writeFileSync(DONE, VERSION);
    status.state = 'ready';
  });
}

var server = http.createServer(function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(status));
});
// TizenBrew may start the service again in the same process; the first one keeps serving.
server.on('error', function (e) { if (e.code !== 'EADDRINUSE') status.error = String(e); });
server.listen(8082, '127.0.0.1');

install().catch(function (e) { status.state = 'error'; status.error = String(e && e.message || e); });

module.exports = { status: status, server: server };
