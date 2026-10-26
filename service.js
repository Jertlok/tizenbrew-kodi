// TizenBrew service of the Kodi app module: a loader that stays the same in every release.
//
// TizenBrew gets this file from jsDelivr, whose newest-tag alias can lag for hours, and
// starts it once per run of its service process, which outlives the TizenBrew app. So the
// real service, kodi-service.js, comes from the main branch instead. The last copy is kept
// in the data directory and started at once, so Kodi opens at boot before the network is
// up and without waiting for GitHub; the main branch is checked right after (and each
// time the module's page asks for /reload), and a changed copy takes over.

var fs = require('fs');
var http = require('http');
var https = require('https');

var SRC = process.env.KODI_SERVICE_SRC ||
  'https://api.github.com/repos/Jertlok/tizenbrew-kodi/contents/kodi-service.js?ref=main';
var DATA = (typeof tizen === 'object')
  ? '/opt/usr/home/owner/apps_rw/' + tizen.application.getAppInfo().packageId + '/data'
  : process.env.KODI_DATA_DIR;
var CACHED = DATA + '/kodi-service.js';
// Over the TV's Wi-Fi a request can go silent without ever failing; nothing else would
// end it.
var TIMEOUT_MS = Number(process.env.KODI_STALL_MS) || 20000;

// What the loader did, served on http://127.0.0.1:8084 from the start, so a loader that
// cannot get the service code is not a black box.
var events = [];
function note(msg) {
  events.push(new Date().toISOString().slice(11, 23) + ' ' + msg);
  if (events.length > 50) events.shift();
}
var logServer = http.createServer(function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ node: process.version, tries: tries, running: !!current, events: events }));
}).on('error', function (e) { note('log server: ' + e.message); }).listen(8084, '127.0.0.1');

// GET of the service code. With an ETag from before, GitHub answers 304 when nothing
// changed, which does not count against its rate limit: resolves null then.
function fetchCode(url, etag) {
  return new Promise(function (resolve, reject) {
    var headers = { 'Accept': 'application/vnd.github.raw', 'User-Agent': 'tizenbrew-kodi' };
    if (etag) headers['If-None-Match'] = etag;
    // autoSelectFamily: try IPv4 too when IPv6 does not connect, instead of hanging.
    var req = (url.indexOf('https:') === 0 ? https : http).get(url, { headers: headers, autoSelectFamily: true }, function (res) {
      var text = '';
      if (res.statusCode === 304) { res.resume(); return resolve(null); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' ' + url)); }
      res.setEncoding('utf8');
      res.on('data', function (c) { text += c; });
      res.on('end', function () { resolve({ code: text, etag: res.headers.etag || null }); });
      res.on('error', reject);
      res.on('aborted', function () { reject(new Error('connection closed')); });
    });
    req.setTimeout(TIMEOUT_MS, function () { reject(new Error('no answer for ' + TIMEOUT_MS / 1000 + ' s')); req.destroy(); });
    req.on('error', reject);
  });
}

var current = null;   // module.exports of the running kodi-service.js
var currentCode = null;
var tries = 0;
var checking = null;

// For kodi-service.js: what this loader can do for it.
var loader = { version: 2, check: check };

function run(code) {
  var mod = { exports: {} };
  new Function('require', 'tizen', 'module', 'reload', 'loader', code)(
    require, typeof tizen === 'object' ? tizen : undefined, mod, check, loader);
  current = mod.exports;
  currentCode = code;
}

function readCached() {
  try {
    return { code: fs.readFileSync(CACHED, 'utf8'), etag: fs.readFileSync(CACHED + '.etag', 'utf8') || null };
  } catch (e) {
    return null;
  }
}

function save(got) {
  try {
    fs.writeFileSync(CACHED + '.part', got.code);
    fs.renameSync(CACHED + '.part', CACHED);
    fs.writeFileSync(CACHED + '.etag', got.etag || '');
  } catch (e) { note('could not keep the service code: ' + e.message); }
}

// Fetches the newest kodi-service.js and runs it if it is not the code running already.
// The new copy takes the port over from the old one itself.
function check() {
  if (checking) return checking;
  var t = Date.now(), cached = readCached();
  note('fetch ' + SRC);
  // The query defeats caches between the TV and GitHub.
  checking = fetchCode(SRC + (SRC.indexOf('?') < 0 ? '?' : '&') + 't=' + t, currentCode && cached && cached.etag).then(function (got) {
    checking = null;
    tries = 0;
    if (!got) return note('up to date (' + (Date.now() - t) + ' ms)');
    note('got ' + got.code.length + ' bytes in ' + (Date.now() - t) + ' ms' + (got.code === currentCode ? ', the same code' : ', starting it'));
    save(got);
    if (got.code !== currentCode) run(got.code);
  }, function (e) {
    checking = null;
    throw e;
  });
  return checking;
}

// Without any copy yet, retried until one is there.
function retry(e) {
  var delay = Math.min(60000, 2000 * Math.pow(2, tries++));
  note('failed: ' + (e && e.message || e) + '; retry in ' + delay / 1000 + ' s');
  console.error('kodi loader: ' + (e && e.message || e) + ', trying again in ' + delay / 1000 + ' s');
  setTimeout(function () { check().catch(current ? function (e) { note('check failed: ' + e.message); } : retry); }, delay);
}

var cached = readCached();
if (cached) {
  note('starting the kept copy (' + cached.code.length + ' bytes)');
  try { run(cached.code); } catch (e) { note('kept copy failed: ' + e.message); current = null; currentCode = null; }
}
check().catch(current ? function (e) { note('check failed: ' + e.message); } : retry);

module.exports = {
  current: function () { return current; },
  logServer: logServer,
  // TizenBrew (from 2.1) opens the page this names instead of the module's appPath.
  launchUrl: function () { return current && current.launchUrl ? current.launchUrl() : null; },
  onStop: function () { return current && current.onStop ? current.onStop() : null; }
};
