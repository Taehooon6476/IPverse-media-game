import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

// The first frame after the page says it is ready must not link every program and upload every texture on the
// page's one thread (seconds without an answer when the shader text is new to the machine): World.warm does that
// work ahead, under the loading screen.
const stub = new URL('./fixtures/three-stub.mjs', import.meta.url).href;
registerHooks({ resolve: (specifier, context, next) => (/^three(\/|$)/.test(specifier)
  ? { url: stub, shortCircuit: true } : next(specifier, context)) });
globalThis.matchMedia ??= () => ({ matches: false });
const { World } = await import('../world.js');

const runtime = readFileSync(new URL('../runtime3d.js', import.meta.url), 'utf8');
function sliceOf(from, to) {
  const start = runtime.indexOf(from), end = runtime.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `runtime3d.js: ${from} … ${to}`);
  return runtime.slice(start, end);
}
const turn = () => new Promise((resolve) => setImmediate(resolve)); // every promise job that is ready has run

/** A World as warm() needs it: a scene of three drawn objects and a light, the composer, a renderer that records. */
function stage({ lite = false, linked = Promise.resolve('scene'), upload = () => {} } = {}) {
  const calls = [];
  const texture = (name, more = {}) => ({ isTexture: true, name, ...more });
  const backdrop = texture('backdrop'), ground = texture('ground'), normal = texture('ground normal');
  const objects = [
    { material: { map: ground, normalMap: normal, alphaMap: null, roughness: 1, color: { isColor: true } } }, // the floor
    { material: [{ map: ground }, { emissiveMap: texture('umbrella') }] }, // a second user of the floor's map, a pickup
    { isLight: true },
    { material: { map: backdrop } }, // the sky dome shows the backdrop too
  ];
  const shown = (twin) => `${twin.material.name}${twin.material.transparent ? ', transparent' : ''}`;
  const world = { lite, camera: { id: 'camera' }, frameTimes: [], frameCount: 0, lastRenderedAt: null, rig: { occluders: [] },
    scene: { background: backdrop, traverse: (visit) => objects.forEach(visit) },
    composer: { readBuffer: 'the composer buffer', render: (dt) => calls.push(['frame', dt]) },
    renderer: { setRenderTarget: (target) => calls.push(['target', target]),
      compileAsync: (object, camera, target) => {
        // the scene itself, or objects that are not in it, linked as the scene `target` would draw them
        calls.push(object === world.scene ? ['link', true, camera.id] : ['link stand-ins', object.children.map(shown), camera.id, target === world.scene]);
        return linked;
      },
      initTexture: (t) => { calls.push(['upload', t.name]); upload(t); },
      render: (scene, camera) => calls.push(['frame on the canvas', scene === world.scene, camera.id]) } };
  return { world, calls };
}

test('before the game is shown: programs link for the buffer the scene is drawn into, every texture goes up once, then one frame is drawn', async () => {
  assert.equal(typeof World.prototype.warm, 'function', 'World.warm: the first frame was made after the page said it was ready');
  const { world, calls } = stage();
  await World.prototype.warm.call(world);
  assert.deepEqual(calls, [
    // tone mapping and the output colour space are in a program's key: linked against the canvas, the composer's
    // frame would make every program again
    ['target', 'the composer buffer'], ['link', true, 'camera'], ['link stand-ins', [], 'camera', true], ['target', null],
    ['upload', 'backdrop'], ['upload', 'ground'], ['upload', 'ground normal'], ['upload', 'umbrella'],
    ['frame', 0],
  ]);
  // not a played frame: the frame times a verifier reads (performanceSnapshot) start with the game's loop
  assert.deepEqual([world.frameCount, world.frameTimes.length, world.lastRenderedAt], [0, 0, null]);
});

test('the broadcaster on a software renderer draws straight to the canvas: its programs link for the canvas', async () => {
  const { world, calls } = stage({ lite: true });
  await World.prototype.warm.call(world);
  assert.deepEqual(calls.filter(([what]) => what !== 'upload'),
    [['target', null], ['link', true, 'camera'], ['link stand-ins', [], 'camera', true], ['target', null], ['frame on the canvas', true, 'camera']]);
});

// The camera's fade (world.js fadeTo) makes an occluder's materials transparent: another variant of each program, and
// compileAsync links only what the scene holds now, so the first fade would link it in play, on the page's thread.
test('the variants the camera\'s fade will ask for are linked ahead, on stand-ins: one for each material it makes transparent', async () => {
  const material = (name, more = {}) => ({ name, transparent: false, clone() { return { ...this }; }, ...more });
  const mesh = (m, more = {}) => ({ isMesh: true, visible: true, material: m, clone() { return { ...this }; }, ...more });
  const steel = material('container steel'), trim = material('neon trim'), glass = material('lamp glass', { transparent: true });
  const { world, calls } = stage();
  world.rig.occluders = [
    // two walls of one container, its hit box (never drawn, never faded), a light
    { root: { traverse: (visit) => [mesh(steel), mesh(steel), mesh(material('hit box'), { visible: false }), { isLight: true }].forEach(visit) } },
    // a street lamp: steel again, its trim, and glass that is transparent already (the program it has)
    { root: { traverse: (visit) => [mesh([steel, trim]), mesh(glass)].forEach(visit) } },
  ];
  await World.prototype.warm.call(world);
  assert.deepEqual(calls.filter(([what]) => what.startsWith('link')), [['link', true, 'camera'],
    ['link stand-ins', ['container steel, transparent', 'neon trim, transparent'], 'camera', true]],
  'the first fade linked its program in play');
  assert.deepEqual([steel.transparent, trim.transparent], [false, false], 'the occluders themselves are untouched');
  assert.deepEqual(calls.filter(([what]) => what === 'target'), [['target', 'the composer buffer'], ['target', null]], 'both for the composer\'s buffer');
});

test('the frame waits for the programs: nothing is drawn while they link, the textures go up meanwhile', async () => {
  let done;
  const { world, calls } = stage({ linked: new Promise((resolve) => { done = resolve; }) });
  let warmed = false;
  const warming = World.prototype.warm.call(world).then(() => { warmed = true; });
  await turn(); await turn();
  assert.equal(calls.filter(([what]) => what === 'upload').length, 4, 'the textures do not wait for the programs');
  assert.ok(!warmed && !calls.some(([what]) => what === 'frame'), 'a frame drawn now would wait for every program on the page\'s thread');
  done('scene');
  await warming;
  assert.deepEqual(calls.at(-1), ['frame', 0]);
});

test('a slow upload gives the page a turn before the next one', async () => {
  const order = [];
  const spin = () => { const until = performance.now() + 25; while (performance.now() < until); }; // a 4096 px backdrop: 240 ms
  const { world } = stage({ upload: (t) => { order.push(t.name); spin(); } });
  setImmediate(() => order.push('the page'));
  await World.prototype.warm.call(world);
  assert.equal(order.filter((name) => name !== 'the page').length, 4);
  assert.ok(order.indexOf('the page') < order.indexOf('umbrella'), `the uploads ran in one go: ${order.join(', ')}`);
});

test('programs that never say they are linked (a lost context) do not hold the loading screen', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const warned = [], warn = console.warn;
  console.warn = (...args) => warned.push(args.join(' '));
  try {
    const { world, calls } = stage({ linked: new Promise(() => {}) });
    let warmed = false;
    const warming = World.prototype.warm.call(world).then(() => { warmed = true; });
    await turn();
    assert.ok(!warmed, 'it waits for the programs first');
    for (let n = 0; n < 120 && !warmed; n++) { t.mock.timers.tick(1000); await turn(); }
    await warming;
    assert.deepEqual(calls.at(-1), ['frame', 0], 'the frame is drawn anyway');
    assert.match(warned.join('\n'), /still linking/);
  } finally { console.warn = warn; }
});

/** runtime3d.js boot, from the build to the page saying it is ready, run on recording stand-ins. `warm`: World.warm. */
function boot({ warm, events = [] }) {
  const lines = sliceOf('  let held = false;', '  const clock = new THREE.Clock();');
  const node = (id) => ({ set hidden(value) { events.push(`#${id} hidden=${value}`); } });
  const world = { input: { keys: { clear() {} }, pressed: { clear() {} } }, canvas: { focus() {} },
    update: (dt) => events.push(`world.update(${dt})`), warm: () => { events.push('world.warm'); return warm(); } };
  const mode = { idle: (dt) => events.push(`mode.idle(${dt})`), update: () => events.push('mode.update') };
  // (the pre-roll is started before this, with the release: `adDone`; the loading screen is told the phase)
  const run = new Function('build', 'adDone', 'loading', 'world', 'mode', 'setStartReady', 'autoplay', 'playableSec', 'standby',
    'briefingStart', '$', 'console', `return (async () => {\n${lines}\n})();`);
  return run(async () => { events.push('built'); }, Promise.resolve(), { to() {} }, world, mode,
    (ready) => events.push(`start enabled=${ready}`), false, 0, false, null, node,
    { warn: (...args) => events.push(`warn: ${args.join(' ')}`) });
}

test('boot: the first frame is made under the loading screen, from where the round starts, before the start button is enabled', async () => {
  const events = [];
  let drawn;
  const booting = boot({ events, warm: () => new Promise((resolve) => { drawn = resolve; }) });
  await turn(); await turn();
  // the camera at the hero without a round update: under ?autoplay=1 an ARPG's update starts the round itself
  assert.deepEqual(events, ['built', 'mode.idle(0)', 'world.update(0)', 'world.warm'],
    'the page said it was ready with nothing drawn: its first frame then held the thread');
  drawn();
  await booting;
  assert.deepEqual(events.slice(4), ['start enabled=true', '#loading hidden=true', '#hud hidden=false']);
});

test('boot: a warm-up that fails does not keep the game from starting', async () => {
  const events = [];
  await boot({ events, warm: async () => { throw new Error('no compileAsync'); } });
  assert.deepEqual(events.slice(3), ['world.warm', 'warn: warm Error: no compileAsync', 'start enabled=true', '#loading hidden=true', '#hud hidden=false']);
});
