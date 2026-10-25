// The Kodi app module's service. service.js, the loader TizenBrew starts, fetches this file
// from the main branch and runs it with `require`, `tizen`, `module` and `reload`.
//
// Kodi's WASM build needs SharedArrayBuffer, which the TV's web engine only gives to
// file:// documents (COOP/COEP headers do not isolate an http page there). So the
// service downloads the build into TizenBrew's data directory once, and the module's
// page then navigates to it. Progress is served on http://127.0.0.1:8083/status.

var fs = require('fs');
var path = require('path');
var http = require('http');
var https = require('https');

// The GitHub release holding the Kodi build. Module code is released under its own tags
// (jsDelivr serves TizenBrew the newest one), so a module update does not download Kodi again.
var KODI_RELEASE = 'v0.0.1';
var BASE = 'https://github.com/Jertlok/tizenbrew-kodi/releases/download/' + KODI_RELEASE + '/';
var DATA = (typeof tizen === 'object')
  ? '/opt/usr/home/owner/apps_rw/' + tizen.application.getAppInfo().packageId + '/data'
  : process.env.KODI_DATA_DIR;
var DIR = path.join(DATA, 'kodi', KODI_RELEASE);
var DONE = path.join(DIR, '.complete');

var status = { state: 'starting', done: 0, total: 0, bytes: 0, error: null, url: 'file://' + DIR + '/index.html',
               node: process.version, log: [] };

// The last download events, served with the status: the TV gives no other view of them.
function log(msg) {
  status.log.push(new Date().toISOString().slice(11, 19) + ' ' + msg);
  if (status.log.length > 20) status.log.shift();
}

// An exception in a stream callback would leave its promise pending forever, so callbacks
// report it as the download's error instead.
function guard(reject, fn) {
  return function () {
    try { return fn.apply(this, arguments); } catch (e) { reject(e); }
  };
}

function mkdirp(dir) {
  if (fs.existsSync(dir)) return;
  mkdirp(path.dirname(dir));
  fs.mkdirSync(dir);
}

// GET following redirects (GitHub release assets redirect to their storage host). Accepts
// 200, and 206 for a request with a Range header.
function get(url, headers, redirects) {
  return new Promise(function (resolve, reject) {
    (url.indexOf('https:') === 0 ? https : http).get(url, { headers: headers || {} }, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if ((redirects || 0) > 5) return reject(new Error('too many redirects: ' + url));
        return resolve(get(new URL(res.headers.location, url).href, headers, (redirects || 0) + 1));
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' ' + url));
      }
      resolve(res);
    }).on('error', reject);
  });
}

// Set when a newer copy of this service takes over: the download in progress is cut off,
// so the two copies do not write the same files.
var stopped = false;
var transfer = null;   // { res, out } of the download in progress

function stop() {
  stopped = true;
  if (transfer) { transfer.res.destroy(); transfer.out.destroy(); }
}

// Over the TV's Wi-Fi a connection can go silent without ever failing. A download that
// gets no data for this long is cut off and resumed from where it stopped.
var STALL_MS = Number(process.env.KODI_STALL_MS) || 30000;
var TRIES = 8;
var savedBytes = 0;   // bytes of the files already saved, for status.bytes

function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function download(name, attempt) {
  attempt = attempt || 1;
  if (stopped) return Promise.reject(new Error('stopped: a newer copy of the service took over'));
  var dest = path.join(DIR, name), part = dest + '.part';
  mkdirp(path.dirname(dest));
  var have = fs.existsSync(part) ? fs.statSync(part).size : 0;
  log('get ' + name + (have ? ' from byte ' + have : ''));
  // Release assets are flat: publish.sh uploads media/splash.jpg as media__splash.jpg.
  var url = BASE + encodeURIComponent(name.replace(/\//g, '__'));
  return get(url, have ? { Range: 'bytes=' + have + '-' } : {}).then(function (res) {
    // 206: the server continues the .part file; 200: it sends the whole file again.
    if (res.statusCode !== 206) have = 0;
    var size = have + Number(res.headers['content-length']);
    log('response ' + res.statusCode + ', ' + size + ' bytes');
    return new Promise(function (resolve, reject) {
      var out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
      var got = have;
      transfer = { res: res, out: out };
      out.on('error', reject);
      res.on('error', reject);
      res.on('aborted', function () { reject(new Error('connection closed')); });
      res.setTimeout(STALL_MS, function () { reject(new Error('no data for ' + STALL_MS / 1000 + ' s')); res.destroy(); });
      res.on('data', guard(reject, function (chunk) {
        got += chunk.length;
        status.bytes = savedBytes + got;
        // Wait for the disk when its buffer is full, instead of holding the file in memory.
        if (!out.write(chunk)) { res.pause(); out.once('drain', function () { res.resume(); }); }
      }));
      res.on('end', guard(reject, function () {
        out.end(guard(reject, function () {
          if (got !== size) return reject(new Error('got ' + got + ' of ' + size + ' bytes'));
          fs.renameSync(part, dest);
          savedBytes += size;
          log('saved ' + name);
          resolve();
        }));
      }));
    });
  }).catch(function (e) {
    if (transfer) { transfer.out.destroy(); transfer = null; }
    if (stopped || attempt >= TRIES) throw e;
    log('retry ' + name + ' (' + e.message + ')');
    return wait(2000).then(function () { return download(name, attempt + 1); });
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
    fs.writeFileSync(DONE, KODI_RELEASE);
    status.state = 'ready';
  });
}

// 8082 was taken by v0.0.1 of this service, which cannot be asked to hand it over.
var PORT = 8083;
var server = http.createServer(function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/shutdown') { stop(); res.end('{}'); return server.close(); }
  // The module's page asks for this each time it opens, so the loader runs the newest
  // copy of this file. A download in progress stops; the new copy resumes it.
  if (req.url === '/reload') {
    var ok = typeof reload === 'function';
    res.end(JSON.stringify({ reloading: ok }));
    if (ok) { stop(); server.close(function () { reload(); }); }
    return;
  }
  res.end(JSON.stringify(status));
});
// TizenBrew's service process outlives the TizenBrew app, so an older copy of this service
// (from before a module update) may still hold the port: ask it to close, then retry.
var listenTries = 0;
server.on('error', function (e) {
  if (e.code !== 'EADDRINUSE' || ++listenTries > 10) { status.error = String(e); return; }
  http.get('http://127.0.0.1:' + PORT + '/shutdown', function (res) { res.resume(); }).on('error', function () {});
  setTimeout(function () { server.listen(PORT, '127.0.0.1'); }, 500);
});
server.listen(PORT, '127.0.0.1');

// Only once the port is ours: an older copy that held it has stopped its download by then.
server.once('listening', function () {
  install().catch(function (e) { status.state = 'error'; status.error = String(e && e.stack || e); log('error ' + e); });
});

module.exports = { status: status, server: server };
