// A repeatable run of one Kodi action on the TV, driven from this PC. It starts the app in
// debug mode, waits for Kodi's home screen, runs one plugin URL and samples Kodi's memory,
// its Workers and the page's long tasks until a line of kodi.log matches or the app dies.
//
//   node tools/kodi-run.mjs --app tizenbrew|standalone --plugin '<plugin:// url>' \
//        --until '<kodi.log regex>' --out <file.json> [--cmd 'RunPlugin(%s)'] [--settle s] [--wait s] [--runs N] [--timeout s] [--tv ip]
//   node tools/kodi-run.mjs --app standalone --eval-python '<python code>' --out <file.json>
//   node tools/kodi-run.mjs --app sim [--profile <dump.json>] [--addon <dir>] [--cpu 4] [--mem MB] ...
//
// --app sim runs on this PC instead of the TV: kodi-tizen-wasm's tools/wasm/tizen/tv-sim.mjs
// (Chrome 120 as the TV, a build made with TV_SIM=1; see "TV simulation" in its README), a
// fresh browser profile per run. --profile writes a dump of Kodi's FS (scratchpad fscopy.mjs
// format: path -> base64 parts) and --addon an add-on directory into the profile, enables
// the add-ons, and restarts Kodi before the run. --cpu (default 4) slows the CPU, --mem sets
// the stand-in's memory (memMB), --kill the free memory under which it closes the app,
// --sim-cfg '<json>' any other of its settings (tools/wasm/tv_sim_pre.js), e.g. '{"bufferS":10}',
// --build the build directory (default ../kodi-work/build), --headed shows the window. The
// stand-in's state is in sim: free memory, why it closed the app, the TV player's tracks.
//
// --wait: seconds between the home screen and the action (default 0), e.g. for Kodi to fill its
// pool of Workers first, as it does when a user starts a search.
//
// --page-eval '<js>': evaluated on the page (awaited) just before the action; its value is in pageEval.
// --count '<regex>': counted is, per matched text, the number of kodi.log lines after the action
// that match it (so 'a|b' counts a and b apart).
//
// --eval-python writes the code as a script into Kodi's FS and runs it with RunScript; what it
// prints is in logMatches as one line, "EVALPY:<output>", with "ERR <exception> | <traceback>"
// after the output if the code raised.
//
// Writes one JSON object per run (an array when --runs > 1), also when the app is closed
// mid-run (then crashedAt is set). Times are in ms. homeMs: page start to "initialize done";
// actionMs: page start to the moment the action ran; doneMs and crashedAt: from the action.
// workersMade: every Worker the page made, with madeDuringAction the number from the action
// to doneMs.
// Needs sdb connected to the TV (SDB=<path> if it is not the default) and `npm install` in tools/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findDevtools, devtools } from './tv.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]]] : a), []));
const EVAL = '/home/web_user/.kodi/temp/evalpy.py';
if (args['eval-python']) {
  Object.assign(args, { plugin: EVAL, cmd: 'RunScript(%s)', until: 'EVALPY:' });
  args.evalSource = `import io, contextlib, traceback, xbmc\n_b = io.StringIO()\ntry:\n    with contextlib.redirect_stdout(_b):\n        exec(compile(${JSON.stringify(args['eval-python'])}, '<evalpy>', 'exec'))\nexcept BaseException as _e:\n    _b.write(' ERR ' + traceback.format_exception_only(_e)[-1].strip() + ' | ' + traceback.format_exc())\nxbmc.log('EVALPY:' + _b.getvalue().strip().replace('\\n', ' | '), xbmc.LOGINFO)\n`;
}
const SIM = args.app === 'sim';
const tv = SIM ? '127.0.0.1' : args.tv || process.env.TV_IP;
if (!tv) { console.error('give the TV address: --tv <ip> or TV_IP'); process.exit(2); }
const sdb = process.env.SDB || path.join(os.homedir(), '.local/opt/sdb-dl/data/tools/sdb');
const STANDALONE = 'KodiWasmTv.Kodi';
const LOG = '/home/web_user/.kodi/temp/kodi.log';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sdbShell = (...a) => execFileSync(sdb, ['shell', '0', ...a], { encoding: 'utf8', timeout: 60000 });

// Added before the page loads: long tasks of the main thread, and every Worker made (when,
// how long its constructor took, and when it first answered: Emscripten's 'loaded'), kept for
// the sampler to drain.
const observe = `(() => { window.__long = []; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push([e.startTime, e.duration]); }).observe({ entryTypes: ['longtask'] }); } catch (e) {}
  window.__made = []; const W = window.Worker;
  window.Worker = class extends W { constructor(...a) { const t0 = performance.now(); super(...a); const e = [t0, performance.now() - t0, null]; window.__made.push(e);
    this.addEventListener('message', () => { e[2] = performance.now() - t0; }, { once: true }); } }; })()`;

// One sample. Kodi is only called after its first frame: before it, a call aborts Kodi.
const sample = (off) => `(() => { const r = { now: performance.now(), long: window.__long.splice(0), off: ${off} };
  r.made = window.__made.filter((e) => e[2] !== null); window.__made = window.__made.filter((e) => e[2] === null); r.pending = window.__made.map((e) => [e[0], e[1]]);
  try { r.buf = Module.wasmMemory.buffer.byteLength; } catch (e) {}
  try { r.avail = tizen.systeminfo.getAvailableMemory(); } catch (e) {}
  r.frame = (window.kodiStartup || []).some((m) => m[0] === 'first frame');
  if (window.kodiTvSimState) r.sim = window.kodiTvSimState;
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
  if (SIM) return openSim();
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

// The simulation: a new browser and serve.py per run, the profile written in and Kodi
// restarted, then the run's page with the observer from its first script on.
let sim = null;
async function openSim() {
  const { startSim } = await import(path.resolve(process.env.KODI_SRC || path.join(import.meta.dirname, '../../kodi-tizen-wasm'), 'tools/wasm/tizen/tv-sim.mjs'));
  const simCfg = args['sim-cfg'] ? JSON.parse(args['sim-cfg']) : {};
  if (args.mem) simCfg.memMB = +args.mem;
  if (args.kill) simCfg.killMB = +args.kill;
  sim = await startSim({ build: args.build, cpu: args.cpu ?? 4, port: args.port, headed: 'headed' in args, navigate: false, sim: simCfg });
  const d = await devtools(sim.page, tv);
  await d.call('Page.enable');
  await d.call('Page.addScriptToEvaluateOnNewDocument', { source: observe });
  await sim.open();
  const files = {};
  if (args.profile) Object.assign(files, JSON.parse(fs.readFileSync(args.profile, 'utf8')));
  if (args.addon) {
    const walk = (dir, rel) => { for (const n of fs.readdirSync(dir, { withFileTypes: true })) n.isDirectory() ? walk(path.join(dir, n.name), rel + '/' + n.name) : files[rel + '/' + n.name] = [fs.readFileSync(path.join(dir, n.name)).toString('base64')]; };
    walk(args.addon, '/home/web_user/.kodi/addons/' + path.basename(path.resolve(args.addon)));
  }
  const ids = [...new Set(Object.keys(files).map((p) => /^\/home\/web_user\/\.kodi\/addons\/([^/]+)\/addon\.xml$/.exec(p)?.[1]).filter(Boolean))];
  if (!Object.keys(files).length) return d;
  const frame = `(window.kodiStartup || []).some((m) => m[0] === 'first frame')`;
  for (let i = 0; i < 180 && !(await d.evaluate(frame).catch(() => false)); i++) await sleep(1000);
  // In batches of about 4 MB of base64.
  let batch = [], size = 0;
  const flush = async () => {
    if (!batch.length) return;
    await d.evaluate(`(() => { for (const [p, parts] of ${JSON.stringify(batch)}) { FS.mkdirTree(p.slice(0, p.lastIndexOf('/')));
      const t = atob(parts.join('')), b = new Uint8Array(t.length); for (let i = 0; i < t.length; i++) b[i] = t.charCodeAt(i); FS.writeFile(p, b); } return 1; })()`);
    batch = []; size = 0;
  };
  for (const [p, parts] of Object.entries(files)) {
    // Parts are base64 of pieces of the file each; one string decodes only if each piece is whole.
    const whole = Buffer.concat(parts.map((x) => Buffer.from(x, 'base64'))).toString('base64');
    batch.push([p, [whole]]); size += whole.length;
    if (size > 4e6) await flush();
  }
  await flush();
  const enable = `import xbmc, json\nxbmc.executebuiltin('UpdateLocalAddons', True)\nfor a in ${JSON.stringify(ids)}:\n    xbmc.executeJSONRPC(json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'Addons.SetAddonEnabled', 'params': {'addonid': a, 'enabled': True}}))\nxbmc.log('TVSIM-ENABLED ' + ' '.join(${JSON.stringify(ids)}), xbmc.LOGINFO)\n`;
  await d.evaluate(`FS.writeFile('/home/web_user/.kodi/temp/tvsim-enable.py', ${JSON.stringify(enable)}); Module.ccall('kodi_wasm_execute_builtin', null, ['string'], ['RunScript(/home/web_user/.kodi/temp/tvsim-enable.py)']); 1`);
  const enabled = `FS.readFile('${LOG}', { encoding: 'utf8' }).includes('TVSIM-ENABLED')`;
  for (let i = 0; i < 60 && !(await d.evaluate(enabled).catch(() => false)); i++) await sleep(1000);
  console.log('profile:', Object.keys(files).length, 'files, enabled', ids.join(' '));
  await d.evaluate(`new Promise((r) => FS.syncfs(false, (e) => r(String(e))))`);
  await d.call('Page.reload');
  return d;
}

async function run() {
  const res = { startedAt: new Date().toISOString(), homeMs: null, actionMs: null, doneMs: null, crashedAt: null,
    peak: { kodiHeapMB: 0, wasmBufMB: 0, workersRunning: 0, workersCreated: 0, workersAlive: 0, minAvailMB: null }, longTasks: [], longTasksBefore: [], workersMade: [], logMatches: [] };
  const d = await open();
  let dead = false;
  d.closed.then(() => { dead = true; });
  const until = new RegExp(args.until);
  const deadline = Date.now() + (+args.timeout || 240) * 1000;
  const settle = +args.settle || 0;
  let lastMatch = null, lastMatchWall = 0, homeWall = 0, pending = [];
  const count = args.count ? new RegExp(args.count) : null;
  if (count) res.counted = {};
  let off = 0, origin = null, actionPerf = null, actionWall = null, actionEpoch = null, sentAt = 0;
  const mb = (n) => Math.round(n / 1e5) / 10;
  // The page counts as gone from its last answer on: a killed app does not always close the socket.
  let lastAnswer = 0;
  const crash = () => { if (res.crashedAt === null && actionWall) res.crashedAt = lastAnswer - actionWall; };
  try {
    while (!dead && Date.now() < deadline && res.doneMs === null) {
      await sleep(1000);
      // The stand-in closed the app as the TV would (Chrome keeps the DevTools socket open).
      if (sim?.log.some((l) => /the app is closed$/.test(l))) throw new Error('closed by the TV simulation');
      let s;
      try {
        // A frozen page does not answer; the TV closes the app after a while.
        s = JSON.parse(await Promise.race([d.evaluate(sample(off)), sleep(25000).then(() => { throw new Error('page not answering'); })]));
      } catch (e) { if (/DevTools closed|not answering/.test(e.message) || dead) throw e; continue; }
      off = s.off;
      lastAnswer = Date.now();
      if (origin === null) origin = await d.evaluate('performance.timeOrigin');
      if (s.buf) res.peak.wasmBufMB = Math.max(res.peak.wasmBufMB, mb(s.buf));
      // The TV's free memory (Tizen's systeminfo), lowest seen.
      if (s.avail) res.peak.minAvailMB = Math.min(res.peak.minAvailMB ?? Infinity, mb(s.avail));
      if (s.heap) res.peak.kodiHeapMB = Math.max(res.peak.kodiHeapMB, mb(s.heap));
      if (s.workers) {
        res.peak.workersRunning = Math.max(res.peak.workersRunning, s.workers.running);
        res.peak.workersCreated = Math.max(res.peak.workersCreated, s.workers.created);
        res.peak.workersAlive = Math.max(res.peak.workersAlive, s.workers.running + s.workers.unused);
      }
      // Long tasks before the action (at: from the page start) go to longTasksBefore.
      for (const [at, ms] of s.long) (actionPerf !== null ? res.longTasks : res.longTasksBefore).push({ at: Math.round(at - (actionPerf ?? 0)), ms: Math.round(ms) });
      // Every Worker, at: from the action (from the page start before it), ms: constructor, loadMs: to its first message.
      for (const [at, ms, loadMs] of s.made) res.workersMade.push({ at: Math.round(at - (actionPerf ?? 0)), ms: Math.round(ms), loadMs: Math.round(loadMs), beforeAction: actionPerf === null || at < actionPerf });
      pending = s.pending || [];
      res.last = { workers: s.workers, availMB: s.avail ? mb(s.avail) : null };
      if (s.sim) res.sim = { minFreeMB: s.sim.minFreeMB, freeMB: s.sim.freeMB, workersAlive: s.sim.workersAlive, killed: s.sim.killed, emss: s.sim.emss };
      for (const [ts, line] of s.lines || []) {
        if (res.homeMs === null && /initialize done/.test(line) && ts >= origin) { res.homeMs = ts - origin; homeWall = Date.now(); }
        else if (actionEpoch !== null && ts >= sentAt && count && count.test(line)) { const k = count.exec(line)[0]; res.counted[k] = (res.counted[k] || 0) + 1; }
        if (actionEpoch !== null && ts >= sentAt && until.test(line)) {
          res.logMatches.push(line.slice(0, 300));
          if (res.firstMatchMs === undefined) res.firstMatchMs = ts - actionEpoch;
          lastMatch = ts - actionEpoch; lastMatchWall = Date.now();
          if (!settle) res.doneMs = lastMatch;
        }
      }
      // Home is up and the first frame is out (a call into Kodi before it aborts Kodi): run the action.
      if (res.homeMs !== null && actionEpoch === null && s.frame && Date.now() - homeWall >= (+args.wait || 0) * 1000) {
        if (args['page-eval']) res.pageEval = await d.evaluate(args['page-eval']);
        actionPerf = await d.evaluate('performance.now()');
        actionWall = Date.now();
        actionEpoch = await d.evaluate('Date.now()');
        res.actionMs = Math.round(actionPerf);
        sentAt = actionEpoch;
        if (args.evalSource) await d.evaluate(`FS.writeFile('${EVAL}', ${JSON.stringify(args.evalSource)})`);
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
  // Workers that never answered (still loading, or the app died): loadMs null.
  for (const [at, ms] of pending) res.workersMade.push({ at: Math.round(at - (actionPerf ?? 0)), ms: Math.round(ms), loadMs: null, beforeAction: actionPerf === null || at < actionPerf });
  res.madeDuringAction = res.workersMade.filter((w) => !w.beforeAction && (res.doneMs === null || w.at <= res.doneMs)).length;
  try { d.close(); } catch {}
  if (sim) {
    res.sim = { ...res.sim, killed: sim.log.find((l) => /the app is closed$/.test(l)) || null, log: sim.log.slice(-20) };
    await sim.close(); sim = null;
  }
  return res;
}

if (!args.plugin || !args.until || !args.out || !['tizenbrew', 'standalone', 'sim'].includes(args.app)) {
  console.error('usage: kodi-run.mjs --app tizenbrew|standalone|sim --plugin <plugin:// url> --until <regex> --out <file.json> | --eval-python <code> --out <file.json> [--runs N] [--wait s] [--timeout s] [--tv ip]');
  process.exit(2);
}
const runs = [];
for (let i = 0; i < (+args.runs || 1); i++) {
  runs.push(await run());
  fs.writeFileSync(args.out, JSON.stringify(runs.length === 1 ? runs[0] : runs, null, 1));
  console.log(`run ${i + 1}:`, JSON.stringify({ ...runs.at(-1), longTasks: runs.at(-1).longTasks.length, longTasksBefore: runs.at(-1).longTasksBefore.length, workersMade: runs.at(-1).workersMade.length, logMatches: runs.at(-1).logMatches.length }));
}
process.exit(0);
