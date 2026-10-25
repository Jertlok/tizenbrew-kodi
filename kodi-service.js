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
var crypto = require('crypto');
var net = require('net');
var zlib = require('zlib');
var stream = require('stream');

// The GitHub release holding the Kodi build. Module code is released under its own tags
// (jsDelivr serves TizenBrew the newest one), so a module update does not download Kodi again.
var KODI_RELEASE = 'v0.0.5';
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
    var req = (url.indexOf('https:') === 0 ? https : http).get(url, { headers: headers || {} }, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if ((redirects || 0) > 5) return reject(new Error('too many redirects: ' + url));
        return resolve(get(new URL(res.headers.location, url).href, headers, (redirects || 0) + 1));
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' ' + url));
      }
      resolve(res);
    });
    // Until the response starts; download() watches the body itself.
    req.setTimeout(STALL_MS, function () { req.destroy(new Error('no response for ' + STALL_MS / 1000 + ' s: ' + url)); });
    req.on('response', function () { req.setTimeout(0); });
    req.on('error', reject);
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
          resolve(/\.gz$/.test(name) ? gunzip(dest) : undefined);
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

// The release has the large files gzipped, which halves the download: kodi.wasm.gz
// becomes kodi.wasm. The .gz file is only removed once the whole file is unpacked, so a
// failure here unpacks it again on the next try instead of downloading it again.
function gunzip(file) {
  var out = file.replace(/\.gz$/, '');
  log('unpack ' + path.basename(file));
  return new Promise(function (resolve, reject) {
    stream.pipeline(fs.createReadStream(file), zlib.createGunzip(), fs.createWriteStream(out + '.part'), function (e) {
      if (e) return reject(e);
      fs.renameSync(out + '.part', out);
      fs.unlinkSync(file);
      resolve();
    });
  });
}

// Earlier Kodi releases, left behind in the data directory by an update.
function removeOldReleases() {
  fs.readdirSync(path.dirname(DIR)).forEach(function (d) {
    if (d === KODI_RELEASE) return;
    fs.rmSync(path.join(path.dirname(DIR), d), { recursive: true, force: true });
    log('removed old release ' + d);
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
      return p.then(function () {
        // Already unpacked by an earlier try that failed later on.
        if (/\.gz$/.test(name) && fs.existsSync(path.join(DIR, name.replace(/\.gz$/, ''))) &&
            !fs.existsSync(path.join(DIR, name))) return;
        if (/\.gz$/.test(name) && fs.existsSync(path.join(DIR, name))) return gunzip(path.join(DIR, name));
        return download(name);
      }).then(function () { status.done++; });
    }, Promise.resolve());
  }).then(function () {
    fs.writeFileSync(DONE, KODI_RELEASE);
    status.state = 'ready';
  });
}

// 8082 was taken by v0.0.1 of this service, which cannot be asked to hand it over.
var PORT = 8083;
// The newest copy of this file. The loader (service.js) can fetch it too, but without a
// timeout, and a fetch that hangs there leaves no copy running at all. So this copy
// fetches its successor itself and hands over only once it has the code. It asks the
// GitHub API: raw.githubusercontent.com serves a pushed file up to minutes late, and
// cannot be purged.
var SELF = process.env.KODI_SERVICE_SRC ||
  'https://api.github.com/repos/Jertlok/tizenbrew-kodi/contents/kodi-service.js?ref=main';
var reloading = false;

function reloadSelf() {
  if (reloading) return;
  reloading = true;
  log('fetching the newest service code');
  get(SELF + (SELF.indexOf('?') < 0 ? '?' : '&') + 't=' + Date.now(),
    { 'Accept': 'application/vnd.github.raw', 'User-Agent': 'tizenbrew-kodi' }).then(function (res) {
    return new Promise(function (resolve, reject) {
      var code = '';
      res.setEncoding('utf8');
      res.setTimeout(STALL_MS, function () { reject(new Error('no data for ' + STALL_MS / 1000 + ' s')); res.destroy(); });
      res.on('data', function (c) { code += c; });
      res.on('end', function () { resolve(code); });
      res.on('error', reject);
    });
  }).then(function (code) {
    stop();
    closeServer(function () {
      new Function('require', 'tizen', 'module', 'reload', code)(
        require, typeof tizen === 'object' ? tizen : undefined, { exports: {} }, reload);
    });
  }).catch(function (e) {
    // Keep running this copy; the page asks again next time Kodi is opened.
    reloading = false;
    log('reload failed: ' + e.message);
  });
}

// Opening Kodi. Chromium does not let the module's page (http://127.0.0.1:8081) navigate
// to a file:// URL ("Not allowed to load local resource"), but DevTools' Page.navigate
// may. TizenBrew runs its pages with DevTools open on a random port of the TV, which it
// uses itself; this finds the port and has the module's page open Kodi.
var devtoolsPort = 0;
var opening = false;

function devtoolsCall(wsUrl, method, params, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var u = new URL(wsUrl);
    var req = http.request({
      host: u.hostname, port: u.port, path: u.pathname,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
                 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64') }
    });
    var timer = setTimeout(function () { req.destroy(); reject(new Error('no answer from DevTools')); }, timeoutMs || 10000);
    req.on('error', function (e) { clearTimeout(timer); reject(e); });
    req.on('response', function (res) { clearTimeout(timer); res.resume(); reject(new Error('DevTools refused the WebSocket: HTTP ' + res.statusCode)); });
    req.on('upgrade', function (res, socket, head) {
      var payload = Buffer.from(JSON.stringify({ id: 1, method: method, params: params || {} }));
      var mask = crypto.randomBytes(4), len = payload.length, header;
      if (len < 126) header = Buffer.from([0x81, 0x80 | len]);
      else if (len < 65536) { header = Buffer.from([0x81, 0x80 | 126, 0, 0]); header.writeUInt16BE(len, 2); }
      else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
      for (var i = 0; i < len; i++) payload[i] ^= mask[i % 4];
      socket.write(Buffer.concat([header, mask, payload]));

      var buf = head && head.length ? head : Buffer.alloc(0), text = '';
      function done(err, value) { clearTimeout(timer); socket.destroy(); err ? reject(err) : resolve(value); }
      socket.on('data', function (chunk) {
        buf = Buffer.concat([buf, chunk]);
        // Parse whole frames; replies from the server are not masked.
        while (buf.length >= 2) {
          var fin = buf[0] & 0x80, opcode = buf[0] & 0x0f, n = buf[1] & 0x7f, off = 2;
          if (n === 126) { if (buf.length < 4) return; n = buf.readUInt16BE(2); off = 4; }
          else if (n === 127) { if (buf.length < 10) return; n = Number(buf.readBigUInt64BE(2)); off = 10; }
          if (buf.length < off + n) return;
          var data = buf.slice(off, off + n);
          buf = buf.slice(off + n);
          if (opcode === 0x8) return done(new Error('DevTools closed the connection'));
          if (opcode === 0x1 || opcode === 0x0) {
            text += data.toString('utf8');
            if (!fin) continue;
            var msg;
            try { msg = JSON.parse(text); } catch (e) { return done(e); }
            text = '';
            if (msg.id === 1) return done(null, msg);
          }
        }
      });
      socket.on('error', function (e) { done(e); });
    });
    req.end();
  });
}

function devtoolsList(port) {
  return new Promise(function (resolve) {
    var req = http.get({ host: '127.0.0.1', port: port, path: '/json/list', timeout: 1000 }, function (res) {
      var text = '';
      res.on('data', function (c) { text += c; });
      res.on('end', function () {
        try { var list = JSON.parse(text); resolve(Array.isArray(list) ? list : null); } catch (e) { resolve(null); }
      });
    });
    req.on('timeout', function () { req.destroy(); resolve(null); });
    req.on('error', function () { resolve(null); });
  });
}

function listeningPorts() {
  var ports = [];
  ['/proc/net/tcp', '/proc/net/tcp6'].forEach(function (file) {
    var lines;
    try { lines = fs.readFileSync(file, 'utf8').split('\n').slice(1); } catch (e) { return; }
    lines.forEach(function (line) {
      // local_address is <hex address>:<hex port>; state 0A is LISTEN.
      var cols = line.trim().split(/\s+/);
      if (cols[3] !== '0A') return;
      var port = parseInt(cols[1].split(':')[1], 16);
      if (port >= 1024 && ports.indexOf(port) < 0) ports.push(port);
    });
  });
  return ports;
}

function findDevtools() {
  if (devtoolsPort) {
    return devtoolsList(devtoolsPort).then(function (list) {
      if (list) return { port: devtoolsPort, list: list };
      devtoolsPort = 0;
      return findDevtools();
    });
  }
  var t = Date.now(), next = 1024, found = null;
  // The ports the TV listens on are in /proc/net/tcp: asking those few takes milliseconds,
  // where scanning every port took about 30 s on the TV.
  var listening = listeningPorts();
  function quick() {
    return Promise.all(listening.map(function (port) {
      return devtoolsList(port).then(function (list) { if (list && !found) found = { port: port, list: list }; });
    })).then(function () { return found; });
  }
  // Closed ports on 127.0.0.1 refuse at once, so a full scan takes seconds.
  function batch() {
    if (found || next > 65535) return Promise.resolve(found);
    var probes = [];
    for (var i = 0; i < 500 && next <= 65535; i++, next++) {
      probes.push((function (port) {
        return devtoolsList(port).then(function (list) { if (list && !found) found = { port: port, list: list }; });
      })(next));
    }
    return Promise.all(probes).then(batch);
  }
  return quick().then(function (f) { return f || batch(); }).then(function (f) {
    log(f ? 'DevTools on port ' + f.port + ' (scan ' + (Date.now() - t) + ' ms)' : 'DevTools not found');
    if (f) devtoolsPort = f.port;
    return f;
  });
}

function openKodi() {
  if (opening || process.env.KODI_NO_OPEN) return;   // KODI_NO_OPEN: set by the self-check
  opening = true;
  log('opening Kodi');
  findDevtools().then(function (d) {
    if (!d) throw new Error('DevTools of TizenBrew not found');
    var page = d.list.filter(function (t) { return t.type === 'page' && t.url.indexOf('tizenbrew-kodi') >= 0; })[0];
    if (!page) throw new Error('module page not found among ' + d.list.length + ' DevTools targets');
    return devtoolsCall(page.webSocketDebuggerUrl, 'Page.navigate', { url: status.url }).then(function (r) {
      if (r.error || (r.result && r.result.errorText)) throw new Error((r.error && r.error.message) || r.result.errorText);
    });
  }).then(function () {
    log('opened Kodi');
    // Only now: until the page shows this release, it may still run an older one, which
    // reloads from its own files after a crash.
    removeOldReleases();
  }, function (e) { log('could not open Kodi: ' + e.message); })
    .then(function () { opening = false; });
}

// Also closes the connections the page keeps open, so its next request reaches the newer
// copy instead of this one.
function closeServer(then) {
  server.close(then);
  if (server.closeAllConnections) setImmediate(function () { server.closeAllConnections(); });
}

// Installing a widget (.wgt) on the TV, for tools/tv.mjs on a PC: it signs the widget
// with the user's certificate, serves it on the LAN and asks for /install through the
// module's page. The TV's sdb (on 127.0.0.1, where Developer Mode points) installs it, so
// Developer Mode never has to point at the PC.
var SDK_TOOLS = process.env.KODI_SDK_TOOLS || '/home/owner/share/tmp/sdk_tools';
var SDB_PORT = Number(process.env.KODI_SDB_PORT) || 26101;
// Only the module's own page may ask: any web page on the TV can send a request to
// 127.0.0.1, but the browser names its origin, and a request without one (an <img>, say)
// is refused too.
var PAGE_ORIGIN = 'http://127.0.0.1:8081';
status.install = null;

// Runs one shell command through sdb, which speaks the ADB protocol: CNXN, then OPEN of
// "shell:<command>", whose output comes in WRTE packets that each need an OKAY.
// The output is complete once it matches done (vd_appinstall may leave the stream open
// after its last line).
function sdbShell(command, timeoutMs, done) {
  done = done || /spend time/;
  return new Promise(function (resolve, reject) {
    var sock = net.connect(SDB_PORT, '127.0.0.1'), buf = Buffer.alloc(0), out = '', ended = false;
    var timer = setTimeout(function () { finish(new Error('sdb: no end after ' + timeoutMs / 1000 + ' s')); }, timeoutMs);
    function packet(cmd, arg0, arg1, data) {
      data = data || Buffer.alloc(0);
      var h = Buffer.alloc(24), sum = 0;
      for (var i = 0; i < data.length; i++) sum = (sum + data[i]) >>> 0;
      h.write(cmd, 0, 'ascii');
      h.writeUInt32LE(arg0, 4); h.writeUInt32LE(arg1, 8); h.writeUInt32LE(data.length, 12);
      h.writeUInt32LE(sum, 16); h.writeUInt32LE((h.readUInt32LE(0) ^ 0xffffffff) >>> 0, 20);
      sock.write(Buffer.concat([h, data]));
    }
    function finish(e) {
      if (ended) return;
      ended = true; clearTimeout(timer); sock.destroy();
      e ? reject(e) : resolve(out);
    }
    sock.on('connect', function () { packet('CNXN', 0x01000000, 4096, Buffer.from('host::\0')); });
    sock.on('data', function (chunk) {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 24) {
        var len = buf.readUInt32LE(12);
        if (buf.length < 24 + len) return;
        var cmd = buf.toString('ascii', 0, 4), remote = buf.readUInt32LE(4), data = buf.slice(24, 24 + len);
        buf = buf.slice(24 + len);
        if (cmd === 'CNXN') packet('OPEN', 1, 0, Buffer.from('shell:' + command + '\0'));
        else if (cmd === 'WRTE') {
          out += data.toString('utf8');
          packet('OKAY', 1, remote);
          if (done.test(out)) return finish();
        } else if (cmd === 'CLSE') return finish();
      }
    });
    sock.on('error', finish);
    sock.on('close', function () { finish(); });
  });
}

function installWidget(url, id) {
  var file = path.join(SDK_TOOLS, 'tizenbrew-kodi-install.wgt');
  status.install = { state: 'downloading', id: id, bytes: 0, output: '', error: null };
  log('install ' + id + ' from ' + url);
  mkdirp(SDK_TOOLS);
  return get(url).then(function (res) {
    return new Promise(function (resolve, reject) {
      res.setTimeout(STALL_MS, function () { res.destroy(new Error('no data for ' + STALL_MS / 1000 + ' s')); });
      res.on('data', function (c) { status.install.bytes += c.length; });
      stream.pipeline(res, fs.createWriteStream(file), function (e) { e ? reject(e) : resolve(); });
    });
  }).then(function () {
    status.install.state = 'installing';
    return sdbShell('0 vd_appinstall ' + id + ' ' + file, 600000);
  }).then(function (output) {
    status.install.output = output;
    status.install.state = 'done';
    log('installed ' + id);
  }).catch(function (e) {
    status.install.state = 'error';
    status.install.error = e.message;
    log('install failed: ' + e.message);
  }).then(function () {
    try { fs.unlinkSync(file); } catch (e) {}
  });
}

var server = http.createServer(function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/shutdown') { stop(); res.end('{}'); return closeServer(); }
  if (req.url.indexOf('/install?') === 0) {
    var q = new URL(req.url, 'http://127.0.0.1').searchParams, url = q.get('url') || '', id = q.get('id') || '';
    var why = req.headers.origin !== PAGE_ORIGIN ? 'only the module page may install apps'
      : !/^https?:\/\//.test(url) ? 'url has to be http or https'
      // A package id is 10 letters or digits; it goes into a shell command.
      : !/^[A-Za-z0-9]{10}$/.test(id) ? 'id has to be a package id'
      : status.install && /downloading|installing/.test(status.install.state) ? 'an install is running' : null;
    if (why) { res.statusCode = 400; return res.end(JSON.stringify({ error: why })); }
    installWidget(url, id);
    return res.end('{"installing":true}');
  }
  // The TV's TCP connections, to debug apps whose sockets hang (pages cannot read /proc).
  if (req.url === '/tcp') {
    return res.end(JSON.stringify(['/proc/net/tcp', '/proc/net/tcp6'].map(function (file) {
      try { return fs.readFileSync(file, 'utf8'); } catch (e) { return ''; }
    })));
  }
  // Starts an installed app with its DevTools open, as TizenBrew starts itself, so that
  // tools/tv.mjs can debug apps outside TizenBrew. Replies with the DevTools port.
  if (req.url.indexOf('/debug?') === 0) {
    var app = new URL(req.url, 'http://127.0.0.1').searchParams.get('app') || '';
    // It goes into a shell command: <package id>.<name>.
    if (req.headers.origin !== PAGE_ORIGIN || !/^[A-Za-z0-9]{10}\.[A-Za-z0-9_]+$/.test(app)) {
      res.statusCode = 400;
      return res.end('{"error":"only the module page may debug apps, by app id"}');
    }
    sdbShell('0 debug ' + app, 30000, /port\s*:\s*\d+/).then(function (out) {
      var m = /port\s*:\s*(\d+)/.exec(out);
      if (!m) throw new Error('sdb: ' + (out.trim() || 'no output'));
      res.end(JSON.stringify({ port: Number(m[1]) }));
    }).catch(function (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: e.message }));
    });
    return;
  }
  // The module's page asks for this each time it opens, so the loader runs the newest
  // copy of this file. A download in progress stops; the new copy resumes it.
  if (req.url === '/reload') {
    res.end('{"reloading":true}');
    reloadSelf();
    return;
  }
  // The page asks for /status until Kodi is ready, then tries to open it itself, which
  // Chromium blocks; so the service opens it.
  // Any other path (tools/tv.mjs asks /status?peek) only reports the status.
  if (req.url === '/status' && status.state === 'ready') openKodi();
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
  install().catch(function (e) {
    // Being stopped for a newer copy is not an error the page should show.
    if (stopped) { status.state = 'stopped'; log('stopped'); return; }
    status.state = 'error'; status.error = String(e && e.stack || e); log('error ' + e);
  });
});

module.exports = { status: status, server: server, findDevtools: findDevtools };
