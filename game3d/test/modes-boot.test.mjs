import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RUNTIME, THREE, authoredMode, cityMode, published, trackMode, validateSpec } from './fixtures/headless.mjs';
import { citySpec } from './fixtures/city-spec.mjs';
import { STAGE_TYPES } from '../authored-contract.js';

// Every mode of the runtime, booted on a stored spec as far as Node goes. A game's spec.json as it is served, one
// per mode:
const MODES = [
  { mode: 'authored', id: 'gm_9539d06a71', file: './authored.js', create: 'createAuthored' }, // a 30 s survival
  { mode: 'city', id: 'gm_1a22c1dc81', file: './city.js', create: 'createCity' }, // a city race
  { mode: 'track', id: 'gm_2ceb5d2311', file: './track.js', create: 'createTrack' }, // an open-track race
  { mode: 'version-1 sf', id: 'gm_c153ff5ceb', file: './sf.js', create: 'createSf' },
  { mode: 'version-1 rpg', id: 'gm_87e5e315b0', file: './rpg.js', create: 'createRpg' },
];
// What Node cannot do: a mode's build() and its drawing need three.js (0.170 from the CDN through the page's import
// map, not in the repo) and a WebGL context; the version-1 modes build their arena and village in their constructors.
// The smallest check of that part is one page per mode in a browser: game3d/dev/qa-modes.mjs.

// boot()'s own routing, read out of runtime3d.js: the four flags, the module it imports and the function it calls
const FLAGS = /const sf = [^\n]+\n +const authored = [^\n]+\n +const city = [^\n]+\n +const track = [^\n]+/.exec(RUNTIME)?.[0];
const FILE = /import\('\.\/world\.js'\), (city \? [^\]]+)\]\)/.exec(RUNTIME)?.[1];
const CREATE = /create: (city \? modeMod\.[^}]+?) \};/.exec(RUNTIME)?.[1];
const route = FLAGS && FILE && CREATE
  ? new Function('spec', `${FLAGS};\nreturn { file: ${FILE.replaceAll('import(', '(')}, create: (modeMod) => ${CREATE} };`) : null;

test('runtime3d.js routes a spec to its mode where this file reads it', () => {
  assert.ok(route, 'the genre flags, the mode\'s import and its create function in boot()');
});

for (const { mode, id, file, create } of MODES) {
  test(`${mode} (${id}): its stored spec passes the runtime's validator, boot() routes it to ${file} and the module loads with ${create}`, async () => {
    const spec = published(id);
    const routed = route(spec);
    assert.equal(routed.file, file);
    const module = await import(new URL(`../${routed.file}`, import.meta.url)); // the whole import graph of the mode
    assert.equal(routed.create(module), module[create]);
    assert.equal(typeof module[create], 'function');
    // every file the mode's module imports is one its game folder gets: make_game (server/tools.py) copies the shared
    // list, and the city's or the track's own on top
    const tools = readFileSync(new URL('../../server/tools.py', import.meta.url), 'utf8');
    const list = (name) => [.../"([^"]+)"/g[Symbol.matchAll](new RegExp(`^${name} = \\(([^)]+)\\)`, 'm').exec(tools)[1])].map((f) => f[1]);
    const copied = new Set([...list('RUNTIME3D_FILES'), ...(mode === 'city' ? list('CITY_RUNTIME_FILES') : mode === 'track' ? list('TRACK_RUNTIME_FILES') : [])]);
    const seen = new Set(), walk = (name) => {
      if (seen.has(name)) return;
      seen.add(name);
      for (const m of readFileSync(new URL(`../${name}`, import.meta.url), 'utf8').matchAll(/from '\.\/([\w.-]+\.js)'|import\('\.\/([\w.-]+\.js)'\)/g)) walk(m[1] ?? m[2]);
    };
    walk(routed.file.slice(2));
    for (const name of seen) assert.ok(copied.has(name), `${name} is copied into a game folder`);
  });
}

/** The briefing is up for two frames, Enter starts the round, and a second of it runs. */
function firstSecond(mode) {
  const input = mode.world.input;
  mode.update(1 / 60); input.endFrame(); mode.update(1 / 60); input.endFrame();
  assert.equal(mode.phase, 'ready', 'nobody pressed 임무 시작');
  dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter' })); dispatchEvent(new KeyboardEvent('keyup', { code: 'Enter' }));
  for (let i = 0; i < 60; i++) { mode.update(1 / 60); input.endFrame(); }
  input.dispose();
  assert.deepEqual([mode.phase, mode.ended], ['playing', false]);
  assert.ok(mode.elapsed > .9 && mode.hud.lines.length > 0, 'the round clock runs and the HUD has its objective');
  return mode;
}

test('authored (gm_9539d06a71): the mode takes the spec, waits behind the briefing and runs once it is started', () => {
  const mode = firstSecond(authoredMode(published('gm_9539d06a71')));
  assert.equal(mode.director.stage.type, 'survive');
  assert.match(mode.hud.lines.at(-1), /^1\/1 · .+ \([01]\/30\)/, 'its 30 s count from the start');
});
test('track (gm_2ceb5d2311): the mode takes the spec, waits behind the briefing, and the race counts down once it is started', () => {
  const mode = firstSecond(trackMode(published('gm_2ceb5d2311')));
  assert.equal(mode.rivals.length, 4);
  assert.ok(mode.raceHold > 1.9 && mode.raceHold < 2.1, 'a second into the 3 s countdown');
});
test('city (gm_1a22c1dc81): the mode takes the spec, the hero sits in the race\'s car, and the race counts down once it is started', () => {
  const mode = firstSecond(cityMode(published('gm_1a22c1dc81')));
  assert.equal(mode.activeCar.id, 'playerCar');
  assert.equal(mode.rivals.length, 3);
});

// --- the built-in player has a way through every kind of stage ---------------------------------------------------------
// (runtime3d.js's watchdog ends a round whose progress stands still for 40 s; a stage it cannot play is a round that
// never gets further)

/** An AuthoredMode on one stage of `type`, the hero at the spawn in a started round. */
function onStage(type, extra = {}) {
  const spec = published('gm_9539d06a71');
  spec.mission = { ...spec.mission, stages: [{ id: 's1', type, label: type, target: 1, ...extra }] };
  const mode = authoredMode(spec);
  mode.phase = 'playing';
  return mode;
}
const WAYS = {
  collect: () => {
    const mode = onStage('collect'), at = new THREE.Vector3(8, 0, -6);
    mode.pickups.push({ id: 'p1', stage: 's1', taken: false, group: { position: at } });
    assert.equal(mode.autoGoal(), at, 'it walks to the pickup');
  },
  reach: () => {
    const mode = onStage('reach', { entityIds: ['flag'] });
    mode.targets.push({ id: 'flag', x: 9, z: 4, radius: 2 });
    assert.deepEqual([mode.autoGoal().x, mode.autoGoal().z, !!mode.autoInteract], [9, 4, false], 'it walks to the target');
  },
  talk: () => {
    const mode = onStage('talk', { entityIds: ['guide'] });
    mode.targets.push({ id: 'guide', x: -5, z: 7, radius: 2 });
    assert.deepEqual([mode.autoGoal().x, mode.autoGoal().z, mode.autoInteract], [-5, 7, true], 'it walks up and holds E');
  },
  interact: () => {
    const mode = onStage('interact', { entityIds: ['lever'] });
    mode.targets.push({ id: 'lever', x: 3, z: -9, radius: 2 });
    assert.deepEqual([mode.autoGoal().x, mode.autoGoal().z, mode.autoInteract], [3, -9, true], 'it walks up and holds E');
  },
  kills: () => WAYS.fight('kills'),
  boss: () => WAYS.fight('boss'),
  fight: (type) => {
    const mode = onStage(type), far = { pos: new THREE.Vector3(mode.player.pos.x + 30, 0, mode.player.pos.z), hp: 3 };
    mode.enemies.push(far);
    assert.equal(mode.autoGoal(), far.pos, 'it walks up to a far enemy');
    far.pos.x = mode.player.pos.x + 6;
    assert.equal(mode.autoGoal(), null);
    assert.equal(mode.debugFaceNearest(), true, 'and turns on a near one (the loop holds F)');
  },
  survive: () => {
    const mode = onStage('survive', { target: 30 }), before = mode.progressKey();
    mode.director.update(1.5, {});
    assert.notEqual(mode.progressKey(), before, 'the stage\'s clock is its progress');
  },
  drive: () => {
    const { spec } = validateSpec(citySpec()), mode = cityMode(spec, { stage: spec.mission.stages.findIndex((s) => s.type === 'drive') });
    mode.phase = 'playing';
    const car = mode.cars.find((c) => c.id === 'quest_car');
    assert.deepEqual([mode.autoGoal(), mode.autoInteract], [car.group.position, true], 'on foot it walks to the stage\'s car and holds E');
    mode.activeCar = car;
    assert.equal(mode.selfDriven, true);
    mode.botDrive(1 / 30);
    assert.ok(mode.world.input.keys.has('KeyW'), 'in it, it drives');
  },
  race: () => {
    const track = trackMode(published('gm_2ceb5d2311')), city = cityMode(published('gm_1a22c1dc81'));
    for (const mode of [track, city]) {
      Object.assign(mode, { phase: 'playing', raceHold: 0 });
      assert.equal(mode.selfDriven, true, 'the runtime\'s walking player stands aside');
      mode.botDrive(1 / 30);
      assert.ok(mode.world.input.keys.has('KeyW'), 'it drives for the next gate');
      for (const code of [...mode.world.input.keys]) dispatchEvent(new KeyboardEvent('keyup', { code }));
      mode.world.input.dispose();
    }
  },
};

test('every stage type of the contract has a way for the built-in player: a goal to walk to, a fight, a clock or a car to drive', () => {
  assert.deepEqual([...STAGE_TYPES].sort(), Object.keys(WAYS).filter((type) => type !== 'fight').sort(),
    'a new stage type needs its way here (and in the mode the built-in player plays it in)');
  for (const type of STAGE_TYPES) WAYS[type]();
});
