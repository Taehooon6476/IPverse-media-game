// Browser checks of the game page: what a first-time player sees and can do, with real key events, on this
// checkout's runtime. Each scene writes screenshots and what it read from the page into --out.
//
//   node game3d/dev/qa-round20.mjs --cdp=9871 [--out=evidence/round20/G] [--only=briefing,pause] [--site=https://…]
//
// The browser is one already running with a GPU (as dev/qa-modes.mjs: --headless=new --use-angle=metal --enable-gpu
// --ignore-gpu-blocklist --remote-debugging-port=<port> --user-data-dir=<its own>). Nothing is written to the site: a
// stored game's assets and the shared kits are read from it (GET) and kept in --cache (a folder, default the system's
// temp), the runtime comes from this checkout and the spec from test/fixtures. The local fixtures (dev/spec-*.json)
// need no network. Node 22 or later (its WebSocket).
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split(/=(.*)/s)));
const SITE = args.site ?? 'https://d12ka835iwfpnx.cloudfront.net';
const ROOT = fileURLToPath(new URL('..', import.meta.url)); // game3d/
const OUT = resolve(args.out ?? 'evidence/round20/G'), CACHE = resolve(args.cache ?? join(tmpdir(), 'qa-round20-cache'));
const PORT = Number(args.cdp);
if (!PORT) { console.error('qa-round20: --cdp=<the DevTools port of a running browser>'); process.exit(2); }
mkdirSync(OUT, { recursive: true }); mkdirSync(CACHE, { recursive: true });
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json',
  '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg', '.hdr': 'application/octet-stream' };
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ---- the page's server ----
// /index.html?spec=dev/…   a local fixture, served from game3d/ as it is
// /games/<id>/…            a stored game: this checkout's runtime, test/fixtures/<id>.spec.json, its assets from the site
// anything else            the site's (the env kit, the city kit), kept in the cache folder
const serve = { release: '{"publishedAt":null,"ad":null}', bytesPerSec: 0, sizes: new Map() }; // bytesPerSec: a slow link for the assets
const cacheFile = (path) => join(CACHE, createHash('sha1').update(path).digest('hex') + extname(path));
async function fromSite(path) {
  const file = cacheFile(path);
  if (existsSync(file)) return { status: 200, body: readFileSync(file), type: TYPES[extname(path)] };
  const r = await fetch(SITE + path);
  const body = Buffer.from(await r.arrayBuffer());
  if (r.status === 200) writeFileSync(file, body);
  return { status: r.status, body, type: r.headers.get('content-type') };
}
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname), [, top, id, ...rest] = path.split('/'), name = rest.join('/');
  const send = async (status, body, type, slow = false) => {
    res.writeHead(status, { 'Content-Type': type ?? 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Length': body.length });
    if (req.method === 'HEAD') return res.end();
    if (!slow || !serve.bytesPerSec) return res.end(body);
    for (let at = 0; at < body.length && !res.destroyed; at += serve.bytesPerSec / 10) { // a tenth of a second a slice
      res.write(body.subarray(at, at + serve.bytesPerSec / 10));
      await sleep(100);
    }
    res.end();
  };
  try {
    if (path.includes('..')) return send(400, Buffer.from('no'));
    const local = (file) => (existsSync(file) ? send(200, readFileSync(file), TYPES[extname(file)]) : send(404, Buffer.from('not in this runtime')));
    if (top === 'games' && /^gm_[a-z0-9]+$/.test(id ?? '') && existsSync(join(ROOT, 'test/fixtures', `${id}.spec.json`))) {
      if (name === 'spec.json') return send(200, readFileSync(join(ROOT, 'test/fixtures', `${id}.spec.json`)), TYPES['.json']);
      if (name === 'release.json') return send(200, Buffer.from(serve.release), TYPES['.json']);
      if (!name.startsWith('assets/')) return local(join(ROOT, name));
    } else if (path === '/index-old.html') return local(join(ROOT, 'test/fixtures/index.round19.html')); // an older game folder's page
    else if (top !== 'games') return local(join(ROOT, path)); // the runtime and the local fixtures
    if (req.method === 'HEAD' && !existsSync(cacheFile(path))) { // a size asked ahead: the site's own answer, not a download
      const r = await fetch(SITE + path, { method: 'HEAD' });
      res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') ?? 'application/octet-stream', 'Cache-Control': 'no-store',
        'Content-Length': r.headers.get('content-length') ?? 0 });
      return res.end();
    }
    const hit = await fromSite(path);
    if (hit.status === 200) serve.sizes.set(path, hit.body.length);
    return send(hit.status, hit.body, hit.type, true);
  } catch (error) { return send(502, Buffer.from(String(error))); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://localhost:${server.address().port}`;
const game = (id, query = '') => `${origin}/games/${id}/index.html${query}`;
const fixture = (name, query = '') => `${origin}/index.html?spec=dev/${name}.json${query}`;

// ---- the browser, over the DevTools protocol ----
const version = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(10000) }).then((r) => r.json()).catch(() => null);
if (!version) { console.error(`qa-round20: no browser on port ${PORT}`); process.exit(2); }
const ws = new WebSocket(version.webSocketDebuggerUrl), waiting = new Map(), thrown = new Map();
let seq = 0;
ws.onmessage = ({ data }) => {
  const m = JSON.parse(data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') thrown.get(m.sessionId)?.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
};
await new Promise((done) => { ws.onopen = done; });
const call = (method, params = {}, sessionId) => new Promise((done, fail) => {
  const id = ++seq, late = setTimeout(() => { waiting.delete(id); fail(new Error(`${method}: no answer from the browser in 90 s`)); }, 90000);
  waiting.set(id, (m) => { clearTimeout(late); if (m.error) fail(new Error(`${method}: ${m.error.message}`)); else done(m.result); });
  ws.send(JSON.stringify({ id, method, params, sessionId }));
});
const KEYS = { Enter: ['Enter', 13], Escape: ['Escape', 27], Space: [' ', 32], ShiftLeft: ['Shift', 16], Digit1: ['1', 49],
  ...Object.fromEntries([...'ADEFPQRSW'].map((c) => [`Key${c}`, [c.toLowerCase(), c.charCodeAt(0)]])) };
// A key goes as a keyboard sends it. Enter and Space carry their character: without it a focused button is not
// pressed by them, as it is in a real browser. And no native key code, ever: a Windows code sent as the native one
// is another key on a Mac (13 is W, 49 is Space), and the page hears a second, phantom key.
const TEXT = { Enter: '\r', Space: ' ' };
const keyDown = (code, more = {}) => ({ type: TEXT[code] ? 'keyDown' : 'rawKeyDown', code, key: KEYS[code][0], windowsVirtualKeyCode: KEYS[code][1],
  ...(TEXT[code] ? { text: TEXT[code], unmodifiedText: TEXT[code] } : {}), ...more });

/** A page of `width` × `height` (touch: a phone's coarse pointer and no hover) at `url`. Its keys are real key events. */
async function open(url, { width = 1280, height = 720, touch = false } = {}) {
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
  thrown.set(sessionId, []);
  const send = (method, params) => call(method, params, sessionId);
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: touch ? 2 : 1, mobile: touch });
  if (touch) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await call('Target.activateTarget', { targetId });
  await send('Page.navigate', { url });
  const page = {
    errors: thrown.get(sessionId),
    /** The value of a JavaScript expression in the page. */
    read: async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value,
    /** Until `expression` is truthy (polled; the machine may be slow). */
    async until(expression, seconds = 120, what = expression) {
      for (const t0 = Date.now(); Date.now() - t0 < seconds * 1000; await sleep(250)) {
        const value = await page.read(expression).catch(() => null);
        if (value) return value;
      }
      throw new Error(`not within ${seconds} s: ${what} (errors: ${page.errors.join(' | ') || 'none'}; page: ${await page.read(SEEN).then(JSON.stringify).catch(() => '?')})`);
    },
    /** `more`: { autoRepeat: true } for a key held down that repeats. */
    down: (code, more) => send('Input.dispatchKeyEvent', keyDown(code, more)),
    up: (code) => send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: KEYS[code][0], windowsVirtualKeyCode: KEYS[code][1] }),
    async tap(code, ms = 90) { await page.down(code); await sleep(ms); await page.up(code); await sleep(120); },
    async hold(code, ms) { await page.down(code); await sleep(ms); await page.up(code); },
    async click(x, y) {
      for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
      await sleep(120);
    },
    /** A click in the middle of the element `selector` (a real pointer event at its place on the page). */
    async clickOn(selector) {
      const box = await page.read(`(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r && r.width ? [r.left + r.width / 2, r.top + r.height / 2] : null; })()`);
      if (!box) throw new Error(`nothing to click at ${selector}`);
      await page.click(box[0], box[1]);
    },
    /** A finger's tap in the middle of the element `selector` (a touch screen's own events). */
    async tapOn(selector) {
      const box = await page.read(`(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r && r.width ? [r.left + r.width / 2, r.top + r.height / 2] : null; })()`);
      if (!box) throw new Error(`nothing to tap at ${selector}`);
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box[0], y: box[1] }] });
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await sleep(150);
    },
    async shot(name) {
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
      return `${name}.png`;
    },
    resize: (w, h) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }),
    front: () => call('Target.activateTarget', { targetId }),
    close: () => call('Target.closeTarget', { targetId }).catch(() => {}),
  };
  return page;
}

// what the page shows: every HUD text that is on screen, the overlays, and the round's own state where the page tells it
const SEEN = `(() => { const t = (id) => { const n = document.getElementById(id); return n && !n.hidden && n.getClientRects().length ? n.innerText.trim().replace(/\\s+/g, ' ') : null; };
  const s = window.__ipverseGameState?.() ?? window.__g3d?.state?.() ?? null, b = document.querySelector('.briefing');
  return { loading: t('loading'), errors: t('errors'), ad: !document.getElementById('ad').hidden, briefing: b && !b.hidden ? b.innerText.replace(/\\s+/g, ' ') : null,
    start: (() => { const n = document.querySelector('.briefing-start'); return n ? { text: n.textContent, disabled: n.disabled } : null; })(),
    objective: t('objective'), status: t('status'), notice: t('notice'), hint: t('hint'), say: t('say'), end: t('end'), pause: t('pause'),
    arrow: (() => { const n = document.querySelector('.goal-arrow'); return n && !n.hidden ? n.textContent : null; })(),
    vitals: document.getElementById('vitals').dataset.kind, dash: !document.getElementById('dash').hidden, crosshair: !document.getElementById('crosshair').hidden,
    rounds: window.ipverseRounds ?? 0, endsIn: window.ipverseRoundEndsIn?.() ?? null,
    phase: s ? s.phase ?? (s.ended ? 'ended' : 'playing') : null, hp: s?.hp ?? null, player: s?.player ?? null, stage: s?.mission?.stageIndex ?? null,
    frames: window.__g3d?.world?.performanceSnapshot?.().totalFrames ?? null }; })()`;

const results = {};
const only = args.only?.split(',');
/** Runs a scene: its checks into results[name], a failed one named; the page it opened is closed whatever happens. */
async function scene(name, run) {
  if (only && !only.includes(name)) return;
  const said = { checks: [], shots: [] }, pages = [];
  const check = (what, ok, seen) => { said.checks.push({ what, ok: !!ok, seen }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${what}${ok ? '' : ` — ${JSON.stringify(seen)}`}`); };
  const use = async (...a) => { const p = await open(...a); pages.push(p); return p; };
  try { await run({ open: use, check, said }); }
  catch (error) { said.checks.push({ what: 'the scene ran to its end', ok: false, seen: String(error.message ?? error) }); console.log(`FAIL ${name}: ${error.message ?? error}`); }
  for (const p of pages) { if (p.errors.length) check('no uncaught error on the page', false, p.errors.slice(0, 3)); await p.close(); }
  results[name] = said;
}

await (await import('./qa-round20-scenes.mjs')).default({ scene, game, fixture, serve, sleep, SEEN });
await (await import('./qa-round21-scenes.mjs')).default({ scene, game, fixture, serve, sleep, SEEN }); // (--only=wall,endkeys,…)
await (await import('./qa-round22-scenes.mjs')).default({ scene, game, fixture, serve, sleep, SEEN }); // (--only=endclick,boss,…)
writeFileSync(join(OUT, 'result.json'), JSON.stringify({ at: new Date().toISOString(), site: SITE, sizes: Object.fromEntries(serve.sizes), results }, null, 1));
const failed = Object.values(results).flatMap((r) => r.checks).filter((c) => !c.ok).length;
console.log(failed ? `qa-round20: ${failed} check(s) failed` : 'qa-round20: every check passed');
ws.close(); server.close();
process.exit(failed ? 1 : 0);
