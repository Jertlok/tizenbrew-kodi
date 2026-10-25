// TizenBrew service of the Kodi app module: a loader that stays the same in every release.
//
// TizenBrew gets this file from jsDelivr, whose newest-tag alias can lag for hours, and
// starts it once per run of its service process, which outlives the TizenBrew app. So the
// real service, kodi-service.js, is fetched from the main branch instead, and fetched again
// whenever the module's page asks for /reload: an update reaches the TV the next time Kodi
// is opened, without adding the module again or restarting the TV.

var http = require('http');
var https = require('https');

var SRC = process.env.KODI_SERVICE_SRC ||
  'https://raw.githubusercontent.com/Jertlok/tizenbrew-kodi/main/kodi-service.js';

function fetchText(url) {
  return new Promise(function (resolve, reject) {
    (url.indexOf('https:') === 0 ? https : http).get(url, function (res) {
      var text = '';
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' ' + url)); }
      res.setEncoding('utf8');
      res.on('data', function (c) { text += c; });
      res.on('end', function () { resolve(text); });
      res.on('error', reject);
    }).on('error', reject);
  });
}

var current = null;   // module.exports of the running kodi-service.js

function load() {
  // The query defeats caches between the TV and GitHub.
  return fetchText(SRC + '?t=' + Date.now()).then(function (code) {
    var mod = { exports: {} };
    new Function('require', 'tizen', 'module', 'reload', code)(
      require, typeof tizen === 'object' ? tizen : undefined, mod, reload);
    current = mod.exports;
  });
}

// Called by kodi-service.js once its server has closed after a /reload request.
function reload() {
  load().catch(retry);
}

function retry(e) {
  console.error('kodi loader: ' + (e && e.message || e) + ', trying again in 10 s');
  setTimeout(reload, 10000);
}

load().catch(retry);

module.exports = { current: function () { return current; } };
