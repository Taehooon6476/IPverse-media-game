// The smallest browser check of every mode: what test/modes-boot.test.mjs cannot run in Node (a mode's build() needs
// three.js from the CDN and a WebGL context). One page per mode, on this checkout's runtime, with the mode's stored
// spec (test/fixtures/<id>.spec.json) and that game's own assets and kits read from the site, under ?autoplay=1: the
// page must boot, the built-in player must get somewhere, and no round may end by the watchdog.
//
//   node game3d/dev/qa-modes.mjs --chrome="/path/to/Google Chrome for Testing"      launches it headless with a GPU
//   node game3d/dev/qa-modes.mjs --cdp=9222                                       a browser already running
//   options: --site=https://d12ka835iwfpnx.cloudfront.net  --only=track,city  --seconds=90
//            with --chrome: --port=<its DevTools port>  --profile=<its profile folder, kept> (else a temporary one)
// Node 22 or later (its WebSocket). Nothing is written to the site: GET only. Exit code 1 when a mode fails.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split(/=(.*)/s)));
const SITE = args.site ?? 'https://d12ka835iwfpnx.cloudfront.net', SECONDS = Number(args.seconds ?? 90);
const ROOT = fileURLToPath(new URL('..', import.meta.url)); // game3d/
const MODES = [ // as test/modes-boot.test.mjs; `gain`: what the built-in player must reach within --seconds
  { mode: 'authored', id: 'gm_9539d06a71', gain: (s) => s.mission?.progress >= 5 || s.mission?.completed, say: '5 s of its 30 s survived' },
  { mode: 'city', id: 'gm_1a22c1dc81', gain: (s) => s.mission?.checkpoint >= 2 || s.mission?.progress >= 1, say: '2 gates of the city race' },
  { mode: 'track', id: 'gm_2ceb5d2311', gain: (s) => s.mission?.checkpoint >= 3 || s.mission?.progress >= 1, say: '3 gates of the track race' },
  { mode: 'version-1 sf', id: 'gm_c153ff5ceb', gain: (s) => s.kills >= 1, say: 'a kill' },
  { mode: 'version-1 rpg', id: 'gm_87e5e315b0', gain: (s) => Array.isArray(s.player) && s.frames >= 120, say: '120 frames of the village drawn' },
].filter((m) => !args.only || args.only.split(',').some((name) => m.mode.includes(name)));
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png' };

// /games/<id>/…: the runtime from this checkout, the spec from the fixtures, no ad; everything else from the site
const cache = new Map();
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname), [, , id, ...rest] = path.split('/'), name = rest.join('/');
  const send = (status, body, type) => { res.writeHead(status, { 'Content-Type': type ?? 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(body); };
  try {
    if (path.startsWith('/games/') && MODES.some((m) => m.id === id) && !name.includes('..')) {
      if (name === 'spec.json') return send(200, readFileSync(join(ROOT, 'test/fixtures', `${id}.spec.json`)), TYPES['.json']);
      if (name === 'release.json') return send(200, '{"publishedAt":null,"ad":null}', TYPES['.json']);
      if (!name.startsWith('assets/')) return existsSync(join(ROOT, name)) ? send(200, readFileSync(join(ROOT, name)), TYPES[extname(name)]) : send(404, 'not in this runtime');
    }
    if (!cache.has(path)) {
      const r = await fetch(SITE + path);
      cache.set(path, { status: r.status, body: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') });
    }
    const hit = cache.get(path);
    send(hit.status, hit.body, hit.type);
  } catch (error) { send(502, String(error)); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://localhost:${server.address().port}`;

// the browser, over the DevTools protocol
let chrome = null, profile = null, port = Number(args.cdp);
if (!port) {
  if (!args.chrome) { console.error('qa-modes: --chrome=<binary> or --cdp=<port>'); process.exit(2); }
  profile = args.profile ? null : mkdtempSync(join(tmpdir(), 'qa-modes-'));
  port = Number(args.port) || 9400 + Math.floor(Math.random() * 500);
  chrome = spawn(args.chrome, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${args.profile ?? profile}`, '--no-first-run', '--no-default-browser-check',
    '--no-sandbox', '--use-mock-keychain', '--password-store=basic', // (macOS: no keychain prompt holds a headless start)
    '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--window-size=1280,720', 'about:blank'], { stdio: 'ignore' });
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
let version = null;
for (let i = 0; i < 60 && !version; i++) version = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json()).catch(() => sleep(1000));
if (!version) { console.error(`qa-modes: no browser on port ${port}`); chrome?.kill(); process.exit(2); }
const ws = new WebSocket(version.webSocketDebuggerUrl), waiting = new Map(), thrown = new Map();
let seq = 0;
ws.onmessage = ({ data }) => {
  const m = JSON.parse(data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') thrown.get(m.sessionId)?.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
};
const bye = (code) => { ws.close(); server.close(); chrome?.kill(); if (profile) rmSync(profile, { recursive: true, force: true }); process.exit(code); };
process.on('unhandledRejection', (error) => { console.error(`qa-modes: ${error.message}`); bye(2); });
await new Promise((done) => { ws.onopen = done; });
const call = (method, params = {}, sessionId) => new Promise((done, fail) => {
  const id = ++seq, late = setTimeout(() => { waiting.delete(id); fail(new Error(`${method}: no answer from the browser in 60 s`)); }, 60000);
  waiting.set(id, (m) => { clearTimeout(late); if (m.error) fail(new Error(`${method}: ${m.error.message}`)); else done(m.result); });
  ws.send(JSON.stringify({ id, method, params, sessionId }));
});

// what a page shows of its round: the HUD's error box, and the mode's own telemetry (the localhost dev hook)
const PROBE = `(() => { const s = window.__g3d?.state?.() ?? null, e = document.getElementById('errors');
  return { errors: e && !e.hidden ? e.textContent : null, loading: !document.getElementById('loading')?.hidden, rounds: window.ipverseRounds ?? 0,
    state: s && { phase: s.phase ?? (s.ended ? 'ended' : 'playing'), ended: !!s.ended, failure: s.failure ?? null, kills: s.kills ?? 0, player: s.player,
      mission: s.mission ? { progress: s.mission.progress, checkpoint: s.mission.checkpoint, completed: s.mission.completed, stage: s.mission.stageIndex } : null,
      frames: window.__g3d.world.performanceSnapshot?.().totalFrames ?? 0 } }; })()`;
const STALLED = '진행이 멈춰서 이번 판을 마쳐요.';
let failed = 0;
for (const m of MODES) {
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
  thrown.set(sessionId, []);
  await call('Runtime.enable', {}, sessionId);
  await call('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);
  await call('Target.activateTarget', { targetId });
  await call('Page.navigate', { url: `${origin}/games/${m.id}/index.html?autoplay=1&noads=1` }, sessionId);
  const t0 = Date.now();
  let verdict = null, last = null, started = null;
  while (!verdict) {
    await sleep(2000);
    const seconds = (Date.now() - t0) / 1000;
    last = (await call('Runtime.evaluate', { expression: PROBE, returnByValue: true }, sessionId).catch(() => null))?.result?.value ?? last;
    const s = last?.state;
    if (s && s.phase !== 'ready' && started == null) started = seconds;
    if (last?.errors) verdict = `FAIL the page shows: ${last.errors.slice(0, 200)}`;
    else if (thrown.get(sessionId).length) verdict = `FAIL uncaught: ${thrown.get(sessionId)[0].slice(0, 300)}`;
    else if (s?.failure === STALLED) verdict = `FAIL the watchdog ended its round after ${(seconds - started).toFixed(0)} s: ${STALLED}`;
    else if (s && m.gain(s)) verdict = `ok   ${m.say}, ${(seconds - started).toFixed(0)} s into the round (the page was ready after ${started.toFixed(0)} s)`;
    else if (started == null && seconds > 120) verdict = `FAIL no round after 120 s (loading: ${last?.loading})`;
    else if (started != null && seconds - started > SECONDS) verdict = `FAIL not ${m.say} within ${SECONDS} s of its round: ${JSON.stringify(s)}`;
  }
  failed += verdict.startsWith('FAIL') ? 1 : 0;
  console.log(`${m.mode.padEnd(14)} ${m.id}  ${verdict}`);
  await call('Target.closeTarget', { targetId }).catch(() => {});
}
bye(failed ? 1 : 0);
