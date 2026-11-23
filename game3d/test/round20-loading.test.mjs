import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RUNTIME } from './fixtures/headless.mjs';
import { LoadMeter, loadLine } from '../arpg-data.js';

// A first visit downloads 19–54 MB: the loading screen shows how much is in, as a figure and a bar, and a published
// game's pre-roll ad starts with the loading, not after the engine and the hero's model are in.
const { World } = await import('../world.js');
const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
function sliceOf(from, to) {
  const start = RUNTIME.indexOf(from), end = RUNTIME.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `runtime3d.js: ${from} … ${to}`);
  return RUNTIME.slice(start, end);
}
const MB = 1048576;

test('the meter counts a file from when it is asked for: its bytes as they arrive, its size once it is known', async () => {
  const meter = new LoadMeter(), moves = [];
  meter.onchange = () => moves.push(meter.state);
  assert.deepEqual(meter.state, { loaded: 0, total: 0, files: 0, done: 0 });
  meter.expect('assets/hero.rig.glb', 8 * MB); // sized ahead
  meter.expect('assets/set.glb', 22 * MB);
  assert.deepEqual(meter.state, { loaded: 0, total: 30 * MB, files: 2, done: 0 });
  let progress, finish;
  const loading = meter.watch('assets/hero.rig.glb', (onProgress) => { progress = onProgress; return new Promise((resolve) => { finish = resolve; }); });
  progress({ loaded: 2 * MB, total: 8 * MB });
  assert.deepEqual(meter.state, { loaded: 2 * MB, total: 30 * MB, files: 2, done: 0 });
  progress({ loaded: 6 * MB, total: 8 * MB });
  finish('the model');
  assert.equal(await loading, 'the model', 'the loader\'s own answer');
  assert.deepEqual(meter.state, { loaded: 8 * MB, total: 30 * MB, files: 2, done: 1 });
  assert.ok(moves.length >= 5, 'every move is told');
  // a file nobody sized ahead (the env kit): its size comes with its first bytes
  let kit;
  const hdr = meter.watch('/games/env-kit/v1/desert.hdr', (onProgress) => { kit = onProgress; return Promise.resolve('sky'); });
  kit({ loaded: MB, total: 4 * MB });
  assert.equal(meter.state.total, 34 * MB);
  await hdr;
  // one that fails is done too (the loading screen does not wait for it), and one without a size counts what came
  await assert.rejects(meter.watch('assets/gone.glb', () => Promise.reject(new Error('403'))));
  let raw;
  const blind = meter.watch('assets/blind.glb', (onProgress) => { raw = onProgress; return Promise.resolve(); });
  raw({ loaded: 3 * MB, total: 0 });
  await blind;
  assert.deepEqual(meter.state, { loaded: 15 * MB, total: 37 * MB, files: 5, done: 4 });
});

test('the loading screen\'s words: a figure of the bytes, what is being fetched, the megabytes', () => {
  assert.deepEqual(loadLine({ loaded: 0, total: 0 }, 'engine'), { percent: null, text: '게임 불러오는 중…', what: '게임 엔진을 받고 있어요', bytes: '' });
  assert.deepEqual(loadLine({ loaded: 18.2 * MB, total: 30.3 * MB }, 'world'),
    { percent: 60, text: '게임 불러오는 중… 60%', what: '세계를 만들고 있어요', bytes: '18.2 / 30.3MB' });
  assert.equal(loadLine({ loaded: 2 * MB, total: 8 * MB }, 'hero').what, '캐릭터를 받고 있어요');
  // every file asked for so far is in, and the world is still being built: not "100 %" (a kit's files may yet be found)
  assert.equal(loadLine({ loaded: 30 * MB, total: 30 * MB }, 'world').percent, 99);
  assert.deepEqual(loadLine({ loaded: 30 * MB, total: 30 * MB }, 'frame'), { percent: 100, text: '게임 불러오는 중… 100%', what: '첫 화면을 준비하고 있어요', bytes: '30.0 / 30.0MB' });
  // before the sizes asked ahead are in, the total is only the first file's: no figure of it, the megabytes received
  assert.deepEqual(loadLine({ loaded: .5 * MB, total: 1.1 * MB }, 'hero', false), { percent: null, text: '게임 불러오는 중…', what: '캐릭터를 받고 있어요', bytes: '0.5MB' });
});

test('every model the game loads goes through the meter: the hero, the kits, the set pieces, the clips', async () => {
  const meter = new LoadMeter(), asked = [];
  const world = { meter, gltfCache: new Map(), gltf: World.prototype.gltf,
    loader: { loadAsync: (url, onProgress) => { asked.push(url); onProgress({ loaded: 5 * MB, total: 10 * MB }); return Promise.resolve({ scene: { updateMatrixWorld() {}, traverse() {} }, animations: [] }); } } };
  const model = await World.prototype.loadModel.call(world, 'assets/ip_hero.rig.glb');
  assert.ok(model.scene);
  assert.deepEqual(meter.state, { loaded: 10 * MB, total: 10 * MB, files: 1, done: 1 });
  await World.prototype.loadModel.call(world, 'assets/ip_hero.rig.glb'); // a second actor of the same model: no second download
  assert.deepEqual([asked.length, meter.state.files], [1, 1]);
  // no loader is called past it: world.js, the set pieces, the env kit's models and its sky
  assert.equal(read('world.js').match(/this\.loader\.loadAsync\(/g).length, 1, 'world.js: only gltf() calls the loader');
  assert.doesNotMatch(read('authored.js'), /world\.loader\.loadAsync/);
  assert.doesNotMatch(read('biome.js'), /world\.loader\.loadAsync/);
  assert.match(read('biome.js'), /world\.meter\.watch\(base \+ b\.hdri, \(onProgress\) => new RGBELoader\(\)\.loadAsync\(base \+ b\.hdri, onProgress\)\)/);
});

/** runtime3d.js's own loadingScreen on stand-in elements. → the screen, and what the page shows. */
function screen(meter) {
  const src = sliceOf('function loadingScreen(', '\n}\n');
  const node = (id) => ({ id, hidden: false, textContent: '', value: 0, max: 1, children: [], attrs: {},
    setAttribute(name, value) { this.attrs[name] = value; },
    replaceChildren(...kids) { this.children = kids; },
    get shown() { return this.children.map((k) => (typeof k === 'string' ? k : k.textContent)).join(''); } });
  const nodes = { loading: Object.assign(node('loading'), { childNodes: [{ nodeType: 3, remove() { nodes.loading.stale = true; } }] }) };
  const loadingScreen = new Function('$', 'ensure', 'el', 'loadLine', `${src}\n}\nreturn loadingScreen;`)(
    (id) => nodes[id], (id) => (nodes[id] ??= node(id)), () => node(), loadLine);
  return { ui: loadingScreen(meter), nodes };
}

test('the loading screen shows the figure, a bar and what is being fetched; the figure never goes back', async () => {
  const meter = new LoadMeter(), { ui, nodes } = screen(meter), labels = [];
  ui.onlabel = (label) => labels.push(label);
  assert.equal(nodes.loading.stale, true, 'an older index.html\'s bare "불러오는 중…" is taken out');
  assert.deepEqual([nodes['loading-text'].shown, nodes['loading-detail'].shown, nodes['loading-bar'].hidden], ['게임 불러오는 중…', '게임 엔진을 받고 있어요', true]);
  // the clips' first bytes come before the sizes asked ahead: no figure of that one file (it would run to 100 %)
  ui.to('hero');
  let clips, hero;
  const first = meter.watch('assets/ual.glb', (onProgress) => { clips = onProgress; return Promise.resolve(); });
  clips({ loaded: .5 * MB, total: MB });
  assert.deepEqual([nodes['loading-text'].shown, nodes['loading-detail'].shown, nodes['loading-bar'].hidden], ['게임 불러오는 중…', '캐릭터를 받고 있어요 · 0.5MB', true]);
  await first;
  // the sizes are in: the hero's 7 MB and a set piece's 8 MB with the clips' 1 MB
  meter.expect('assets/hero.glb', 7 * MB);
  meter.expect('assets/set.glb', 8 * MB);
  ui.ready();
  const second = meter.watch('assets/hero.glb', (onProgress) => { hero = onProgress; return Promise.resolve(); });
  hero({ loaded: 3 * MB, total: 7 * MB });
  assert.deepEqual([nodes['loading-text'].shown, nodes['loading-detail'].shown, nodes['loading-bar'].value, nodes['loading-bar'].hidden],
    ['게임 불러오는 중… 25%', '캐릭터를 받고 있어요 · 4.0 / 16.0MB', 25, false]);
  assert.equal(ui.label, '게임 불러오는 중… 25%', 'the briefing\'s busy start button shows the same figure');
  await second;
  assert.equal(nodes['loading-text'].shown, '게임 불러오는 중… 50%');
  // the env kit's files are found only now (nobody sized them): the figure holds at 50 %, it does not fall back to 33 %
  ui.to('world');
  meter.expect('/games/env-kit/v1/rock.glb', 8 * MB);
  assert.deepEqual([nodes['loading-text'].shown, nodes['loading-detail'].shown], ['게임 불러오는 중… 50%', '세계를 만들고 있어요 · 8.0 / 24.0MB']);
  await meter.watch('assets/set.glb', () => Promise.resolve());
  await meter.watch('/games/env-kit/v1/rock.glb', () => Promise.resolve());
  // (the figure does not stand at 99 while the world is built: that step is named; round22-loading.test.mjs)
  assert.equal(nodes['loading-text'].shown, '게임 불러오는 중… 장면 준비 중', 'everything asked for is in, the world is still built: not yet 100');
  ui.to('frame');
  assert.deepEqual([nodes['loading-text'].shown, nodes['loading-detail'].shown], ['게임 불러오는 중… 100%', '첫 화면을 준비하고 있어요 · 24.0 / 24.0MB']);
  assert.deepEqual(labels, ['게임 불러오는 중… 6%', '게임 불러오는 중… 25%', '게임 불러오는 중… 50%', '게임 불러오는 중… 66%', '게임 불러오는 중… 장면 준비 중', '게임 불러오는 중… 100%']);
  // the ticking numbers are not read out: a screen reader hears the phases
  assert.equal(nodes['loading-text'].children[1].attrs['aria-hidden'], 'true');
});

test('the files the boot loads are sized ahead, so the total stands from the start', async () => {
  const src = sliceOf('function sizeAhead(', '\n}\n');
  const asked = [], sizes = { 'assets/hero.rig.glb': 8 * MB, 'assets/ual.glb': 2 * MB };
  const fetch = (url, init) => { asked.push([url, init.method]);
    return url in sizes ? Promise.resolve({ ok: true, headers: { get: () => String(sizes[url]) } }) : url.endsWith('gone.glb')
      ? Promise.resolve({ ok: false, headers: { get: () => '243' } }) : Promise.reject(new Error('offline')); };
  const timers = [];
  const sizeAhead = new Function('fetch', 'setTimeout', `${src}\n}\nreturn sizeAhead;`)(fetch, (fn, ms) => timers.push([ms, fn]));
  const meter = new LoadMeter();
  await sizeAhead(meter, ['assets/hero.rig.glb', undefined, 'assets/ual.glb', 'assets/hero.rig.glb', 'assets/gone.glb', 'assets/offline.glb', null]);
  assert.deepEqual(asked, [['assets/hero.rig.glb', 'HEAD'], ['assets/ual.glb', 'HEAD'], ['assets/gone.glb', 'HEAD'], ['assets/offline.glb', 'HEAD']]);
  assert.deepEqual(meter.state, { loaded: 0, total: 10 * MB, files: 2, done: 0 }, 'a missing file\'s error page is not a size');
  // an answer that does not come: the figure does not wait for it past 3 s
  const never = new Function('fetch', 'setTimeout', `${src}\n}\nreturn sizeAhead;`)(() => new Promise(() => {}), (fn, ms) => timers.push([ms, fn]));
  let told = false;
  never(new LoadMeter(), ['assets/slow.glb']).then(() => { told = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(told, false);
  assert.equal(timers.at(-1)[0], 3000);
  timers.at(-1)[1]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(told, true);
  // boot(): the hero, its weapon, the clips, the props, the set pieces; a version-1 game's enemies too; then the figure
  assert.match(RUNTIME, /sizeAhead\(meter, \[spec\.animUrl, spec\.player\.modelUrl, spec\.player\.weaponUrl, \.\.\.spec\.props\.map\(\(p\) => p\.modelUrl\),/);
  assert.match(RUNTIME, /spec\.world\?\.background\?\.modelUrl\]\)\.then\(loading\.ready\);/);
  assert.match(RUNTIME, /new engine\.World\(\$\('game'\), \{ fps: showFps, meter \}\)/);
});

test('boot(): the figure is on the briefing\'s busy start button, and the pre-roll plays from the start, over the loading', () => {
  assert.match(RUNTIME, /replay \? '다시 시작하는 중…' : loading\.label;/);
  assert.match(RUNTIME, /loading\.onlabel = \(\) => \{ if \(!startReady\) setStartReady\(false\); \};/);
  // the ad is started with the release, before the engine is imported, and awaited with the build
  const ad = RUNTIME.indexOf('const adDone = release.then((r) => playAd(r?.ad));'), engine = RUNTIME.indexOf("import('./world.js')");
  assert.ok(ad > 0 && ad < engine, 'the ad waited for the engine and the hero\'s model');
  assert.match(RUNTIME, /await Promise\.all\(\[build\(\)\.then\(prime\), adDone\]\);/);
  // what boot() is at is told to the screen
  for (const phase of ['hero', 'world', 'frame']) assert.ok(RUNTIME.includes(`loading.to('${phase}');`), phase);
});
