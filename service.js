// TizenBrew service of the Kodi app module: a loader that stays the same in every release.
//
// TizenBrew gets this file from jsDelivr, whose newest-tag alias can lag for hours, and
// starts it once per run of its service process, which outlives the TizenBrew app. So the
// real service, kodi-service.js, is fetched from the main branch instead; after that,
// each copy of kodi-service.js fetches its own successor when the module's page asks
// for /reload. An update reaches the TV the next time Kodi is opened, without adding the
// module again or restarting the TV.

var http = require('http');
var https = require('https');

var SRC = process.env.KODI_SERVICE_SRC ||
  'https://raw.githubusercontent.com/Jertlok/tizenbrew-kodi/main/kodi-service.js';
// Over the TV's Wi-Fi a request can go silent without ever failing; nothing else would
// end it, and no service would run.
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

function fetchText(url) {
  return new Promise(function (resolve, reject) {
    // autoSelectFamily: try IPv4 too when IPv6 does not connect, instead of hanging.
    var req = (url.indexOf('https:') === 0 ? https : http).get(url, { autoSelectFamily: true }, function (res) {
      var text = '';
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' ' + url)); }
      res.setEncoding('utf8');
      res.on('data', function (c) { text += c; });
      res.on('end', function () { resolve(text); });
      res.on('error', reject);
      res.on('aborted', function () { reject(new Error('connection closed')); });
    });
    req.setTimeout(TIMEOUT_MS, function () { reject(new Error('no answer for ' + TIMEOUT_MS / 1000 + ' s')); req.destroy(); });
    req.on('error', reject);
  });
}

var current = null;   // module.exports of the first kodi-service.js
var tries = 0;

function load() {
  var t = Date.now();
  note('fetch ' + SRC);
  // The query defeats caches between the TV and GitHub.
  return fetchText(SRC + '?t=' + t).then(function (code) {
    note('got ' + code.length + ' bytes in ' + (Date.now() - t) + ' ms, starting it');
    var mod = { exports: {} };
    new Function('require', 'tizen', 'module', 'reload', code)(
      require, typeof tizen === 'object' ? tizen : undefined, mod, reload);
    current = mod.exports;
  });
}

// For copies of kodi-service.js that hand over through the loader.
function reload() {
  load().catch(retry);
}

function retry(e) {
  var delay = Math.min(60000, 2000 * Math.pow(2, tries++));
  note('failed: ' + (e && e.message || e) + '; retry in ' + delay / 1000 + ' s');
  console.error('kodi loader: ' + (e && e.message || e) + ', trying again in ' + delay / 1000 + ' s');
  setTimeout(reload, delay);
}

load().catch(retry);

module.exports = { current: function () { return current; }, logServer: logServer };
