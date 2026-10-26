// A repeatable run of one Kodi action on the TV, driven from this PC. It starts the app in
// debug mode, waits for Kodi's home screen, runs one plugin URL and samples Kodi's memory,
// its Workers and the page's long tasks until a line of kodi.log matches or the app dies.
//
//   node tools/kodi-run.mjs --app tizenbrew|standalone --plugin '<plugin:// url>' \
//        --until '<kodi.log regex>' --out <file.json> [--cmd 'RunPlugin(%s)'] [--settle s] [--runs N] [--timeout s] [--tv ip]
//
// Writes one JSON object per run (an array when --runs > 1), also when the app is closed
// mid-run (then crashedAt is set). Times are in ms. homeMs: page start to "initialize done";
// actionMs: page start to the moment the action ran; doneMs and crashedAt: from the action.
// Needs sdb connected to the TV (SDB=<path> if it is not the default) and `npm install` in tools/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findDevtools, devtools } from './tv.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]]] : a), []));
const tv = args.tv || process.env.TV_IP;
if (!tv) { console.error('give the TV address: --tv <ip> or TV_IP'); process.exit(2); }
const sdb = process.env.SDB || path.join(os.homedir(), '.local/opt/sdb-dl/data/tools/sdb');
const STANDALONE = 'KodiWasmTv.Kodi';
const LOG = '/home/web_user/.kodi/temp/kodi.log';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sdbShell = (...a) => execFileSync(sdb, ['shell', '0', ...a], { encoding: 'utf8', timeout: 60000 });

// Added before the page loads: long tasks of the main thread, kept for the sampler to drain.
const observe = `(() => { window.__long = []; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push([e.startTime, e.duration]); }).observe({ entryTypes: ['longtask'] }); } catch (e) {} })()`;

// One sample. Kodi is only called after its first frame: before it, a call aborts Kodi.
const sample = (off) => `(() => { const r = { now: performance.now(), long: window.__long.splice(0), off: ${off} };
  try { r.buf = Module.wasmMemory.buffer.byteLength; } catch (e) {}
  r.frame = (window.kodiStartup || []).some((m) => m[0] === 'first frame');
  if (r.frame) {
    try { r.heap = Module.ccall('kodi_wasm_memory_usage', 'number', ['number'], [0]); r.workers = Module.kodiThreads(); } catch (e) { r.err = String(e).slice(0, 80); }
  }
  try { const n = FS.stat('${LOG}').size;
    if (n > r.off) { const s = FS.open('${LOG}', 'r'), b = new Uint8Array(n - r.off); FS.read(s, b, 0, b.length, r.off); FS.close(s); r.off = n;
      r.lines = new TextDecoder().decode(b).split('\\n').map((l) => { const m = /^(\\d+)-(\\d+)-(\\d+) (\\d+):(\\d+):(\\d+)\\.(\\d+)/.exec(l); return m ? [new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]).getTime(), l] : [null, l]; }); } } catch (e) {}
  return JSON.stringify(r); })()`;

// Starts the app with DevTools and returns a connection to its page, reloaded so that the
// observer is in place from the first script on.
async function open() {
  let d;
  if (args.app === 'standalone') {
    try { sdbShell('was_kill', STANDALONE); } catch {}
    await sleep(2000);
    const port = /port: (\d+)/.exec(sdbShell('debug', STANDALONE))?.[1];
    if (!port) throw new Error('no DevTools port from sdb');
    console.log('DevTools port', port);
    const list = await (await fetch(`http://${tv}:${port}/json/list`)).json();
    d = await devtools(list.find((t) => t.type === 'page'), tv);
  } else {
    const { list } = await findDevtools(tv);
    d = await devtools(list.find((t) => t.type === 'page'), tv);
    // TizenBrew's page opens Kodi through its tile.
    const tile = `(() => { const h = [...document.querySelectorAll('h3')].find((x) => /Kodi/.test(x.textContent)); if (h) h.click(); return !!h; })()`;
    for (let i = 0; i < 60 && !(await d.evaluate(tile).catch(() => false)); i++) await sleep(500);
    for (let i = 0; i < 60 && !/\/kodi\/.*index\.html/.test(await d.evaluate('location.href').catch(() => '')); i++) await sleep(500);
  }
  await d.call('Page.enable');
  await d.call('Page.addScriptToEvaluateOnNewDocument', { source: observe });
  await d.call('Page.reload');
  return d;
}

async function run() {
  const res = { startedAt: new Date().toISOString(), homeMs: null, actionMs: null, doneMs: null, crashedAt: null,
    peak: { kodiHeapMB: 0, wasmBufMB: 0, workersRunning: 0, workersCreated: 0 }, longTasks: [], logMatches: [] };
  const d = await open();
  let dead = false;
  d.closed.then(() => { dead = true; });
  const until = new RegExp(args.until);
  const deadline = Date.now() + (+args.timeout || 240) * 1000;
  const settle = +args.settle || 0;
  let lastMatch = null, lastMatchWall = 0;
  let off = 0, origin = null, actionPerf = null, actionWall = null, actionEpoch = null, sentAt = 0;
  const mb = (n) => Math.round(n / 1e5) / 10;
  // The page counts as gone from its last answer on: a killed app does not always close the socket.
  let lastAnswer = 0;
  const crash = () => { if (res.crashedAt === null && actionWall) res.crashedAt = lastAnswer - actionWall; };
  try {
    while (!dead && Date.now() < deadline && res.doneMs === null) {
      await sleep(1000);
      let s;
      try {
        // A frozen page does not answer; the TV closes the app after a while.
        s = JSON.parse(await Promise.race([d.evaluate(sample(off)), sleep(25000).then(() => { throw new Error('page not answering'); })]));
      } catch (e) { if (/DevTools closed|not answering/.test(e.message) || dead) throw e; continue; }
      off = s.off;
      lastAnswer = Date.now();
      if (origin === null) origin = await d.evaluate('performance.timeOrigin');
      if (s.buf) res.peak.wasmBufMB = Math.max(res.peak.wasmBufMB, mb(s.buf));
      if (s.heap) res.peak.kodiHeapMB = Math.max(res.peak.kodiHeapMB, mb(s.heap));
      if (s.workers) {
        res.peak.workersRunning = Math.max(res.peak.workersRunning, s.workers.running);
        res.peak.workersCreated = Math.max(res.peak.workersCreated, s.workers.created);
      }
      for (const [at, ms] of s.long) if (actionPerf !== null) res.longTasks.push({ at: Math.round(at - actionPerf), ms: Math.round(ms) });
      for (const [ts, line] of s.lines || []) {
        if (res.homeMs === null && /initialize done/.test(line) && ts >= origin) res.homeMs = ts - origin;
        else if (actionEpoch !== null && ts >= sentAt && until.test(line)) {
          res.logMatches.push(line.slice(0, 300));
          if (res.firstMatchMs === undefined) res.firstMatchMs = ts - actionEpoch;
          lastMatch = ts - actionEpoch; lastMatchWall = Date.now();
          if (!settle) res.doneMs = lastMatch;
        }
      }
      // Home is up and the first frame is out (a call into Kodi before it aborts Kodi): run the action.
      if (res.homeMs !== null && actionEpoch === null && s.frame) {
        actionPerf = await d.evaluate('performance.now()');
        actionWall = Date.now();
        actionEpoch = await d.evaluate('Date.now()');
        res.actionMs = Math.round(actionPerf);
        sentAt = actionEpoch;
        await d.evaluate(`Module.ccall('kodi_wasm_execute_builtin', null, ['string'], [${JSON.stringify((args.cmd || 'ActivateWindow(Videos,%s)').replace('%s', args.plugin))}])`);
      }
      // With --settle, the run is done when no line has matched for that many seconds.
      if (settle && lastMatch !== null && Date.now() - lastMatchWall > settle * 1000) res.doneMs = lastMatch;
    }
  } catch (e) { dead = true; res.error = e.message; }
  if (dead) crash();
  if (!dead && res.doneMs === null) res.timedOut = true;
  // Matches without a quiet period (--settle) before the deadline still give a time.
  if (res.doneMs === null && lastMatch !== null) res.doneMs = lastMatch;
  if (res.homeMs !== null) res.homeMs = Math.round(res.homeMs);
  try { d.close(); } catch {}
  return res;
}

if (!args.plugin || !args.until || !args.out || !['tizenbrew', 'standalone'].includes(args.app)) {
  console.error('usage: kodi-run.mjs --app tizenbrew|standalone --plugin <plugin:// url> --until <regex> --out <file.json> [--runs N] [--timeout s] [--tv ip]');
  process.exit(2);
}
const runs = [];
for (let i = 0; i < (+args.runs || 1); i++) {
  runs.push(await run());
  fs.writeFileSync(args.out, JSON.stringify(runs.length === 1 ? runs[0] : runs, null, 1));
  console.log(`run ${i + 1}:`, JSON.stringify({ ...runs.at(-1), longTasks: runs.at(-1).longTasks.length, logMatches: runs.at(-1).logMatches.length }));
}
process.exit(0);
