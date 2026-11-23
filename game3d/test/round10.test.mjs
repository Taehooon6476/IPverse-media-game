import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { validateSpec } from '../gamespec3d.js';

// The night harbor, upright skeleton soldiers, the platformer's shield and the camera behind a blocked hero.
// Gameplay methods run on plain records with the three.js stub.
const stub = new URL('./fixtures/three-stub.mjs', import.meta.url).href;
registerHooks({ resolve: (specifier, context, next) => (/^three(\/|$)/.test(specifier)
  ? { url: stub, shortCircuit: true } : next(specifier, context)) });
globalThis.matchMedia ??= () => ({ matches: false });
const THREE = await import(stub);
const { AuthoredMode, enemyClips } = await import('../authored.js');
const { cameraBoom, cameraFloor } = await import('../world.js');
const { groundLook, harborPlan, harborSide, isContainer, nightStrength } = await import('../biome.js');
Object.assign(globalThis, { innerWidth: 1600, innerHeight: 1000, document: {
  getElementById: () => ({ append() {} }),
  createElement: () => {
    const node = { style: {}, hidden: false, setAttribute() {}, remove() {} };
    Object.defineProperty(node, 'innerHTML', { set() { node.firstChild = { style: {}, textContent: '' }; } });
    return node;
  } } });

const fixture = (id) => JSON.parse(readFileSync(new URL(`./fixtures/${id}.spec.json`, import.meta.url)));
function published(id) {
  const { ok, errors, spec } = validateSpec(fixture(id));
  assert.equal(ok, true, errors?.join('; '));
  return spec;
}
const idle = { look: { x: 0, y: 0 }, down: () => false, hit: () => false, clicked: false, fireHeld: false, pad: null };
function mode(spec, hud = {}) {
  const actor = () => ({ root: new THREE.Group(), body: new THREE.Group(), height: 1.8, kind: 'billboard' });
  const world = { scene: new THREE.Group(), flash() {}, particles: { emit() {} }, input: idle,
    rig: { yaw: 0, pitch: .25, shake() {}, forward: () => new THREE.Vector3(0, 0, -1), right: () => new THREE.Vector3(1, 0, 0) },
    makeActor: async () => actor() };
  const quiet = { popup() {}, say() {}, float() {}, notice() {}, objective() {}, status() {}, health() {}, dash() {},
    crosshair() {}, end() {}, ...hud };
  const m = new AuthoredMode(world, spec, quiet, actor());
  m.player = { pos: new THREE.Vector3(spec.world.spawn.x, 0, spec.world.spawn.z), vel: new THREE.Vector3(), dashCooldown: 0 };
  return m;
}

// --- camera: a solid right behind the hero (backing into a 3 m container) ---
// hitAt(pitch): how far the ray from the hero's head (1.5 m up) runs at that pitch before it meets the box, which
// stands `near`..`far` metres behind the hero, `top` metres above the head.
// Over its near top edge the rising ray clears the whole box; below it, it meets the near face.
const boxBehind = ({ near, top }) => (pitch) => (Math.tan(pitch) * near >= top ? Infinity : near / Math.cos(pitch));

test('camera: a container right behind the hero lifts the shot over it at full distance, not down onto the hero', () => {
  const hit = boxBehind({ near: 1.5, top: 1.5 }); // a 3 m container, its face 1.5 m behind the hero
  const boom = cameraBoom({ pitch: .25, distance: 6.2, hitAt: hit, pullMin: 3 });
  assert.equal(boom.dist, 6.2, 'the camera keeps its distance');
  assert.ok(Math.tan(boom.pitch) * 1.5 >= 1.5, 'and looks over the container');
  const above = Math.sin(boom.pitch) * boom.dist, back = Math.cos(boom.pitch) * boom.dist;
  assert.ok(above >= 2 && back >= 3, `camera ${back.toFixed(1)} m back, ${above.toFixed(1)} m over the head`);
  assert.ok(boom.pitch <= 1.0 + 1e-9, 'never straight down');
});

test('camera: a wall too tall to look over pulls in no closer than the minimum, an open view is left alone', () => {
  const wall = boxBehind({ near: 1.5, top: 30 });
  const boom = cameraBoom({ pitch: .25, distance: 6.2, hitAt: wall, pullMin: 3 });
  assert.ok(boom.dist >= 3, `pulled to ${boom.dist.toFixed(2)} m (was 1.8 m: the hero filled the screen)`);
  assert.equal(boom.pitch, .25, 'no lift when lifting does not clear it');
  assert.deepEqual(cameraBoom({ pitch: .4, distance: 6.2, hitAt: () => Infinity, pullMin: 3 }), { pitch: .4, dist: 6.2 });
  // a blocker past the camera does not count
  assert.deepEqual(cameraBoom({ pitch: .4, distance: 6.2, hitAt: () => 9, pullMin: 3 }), { pitch: .4, dist: 6.2 });
});

test('camera: pulled in over a low container it hovers a metre above its top, never inside or skimming it', () => {
  const container = { min: { x: -32, y: 0, z: 28.5 }, max: { x: -24, y: 3, z: 31.5 } };
  const head = 1.5;
  // hero at z 28.05 against it, camera pulled to 3 m: (-28, 3.14, 30.96), just over the top face
  assert.equal(cameraFloor({ x: -28, y: 3.14, z: 30.96 }, [container], head), 4);
  assert.equal(cameraFloor({ x: -28, y: 4.5, z: 30.96 }, [container], head), -Infinity, 'already well over it');
  assert.equal(cameraFloor({ x: -20, y: 2, z: 30.96 }, [container], head), -Infinity, 'beside it');
  const warehouse = { min: { x: 27, y: 0, z: -45 }, max: { x: 39, y: 7, z: -35 } };
  assert.equal(cameraFloor({ x: 33, y: 3, z: -38 }, [warehouse], head), -Infinity, 'too tall to hover over: it fades instead');
});

// --- ARPG: skeleton soldiers walk upright ---
test('ARPG gm_b870737b47: humanoid skeleton soldiers get the upright clips, a zombie still shambles', async () => {
  const spec = published('gm_b870737b47');
  for (const e of spec.enemies) assert.equal(enemyClips(e, false).zombie, false, `${e.name} hunches`);
  assert.equal(enemyClips({ name: '좀비', humanoid: true }, false).zombie, true);
  assert.equal(enemyClips({ name: 'Ghoul walker', humanoid: true }, false).zombie, true);
  assert.equal(enemyClips({ name: '해골 왕', humanoid: true }, true).zombie, false, 'a boss stands upright');
  // spawnEnemy asks the world for those clips
  const m = mode(spec);
  m.activateStage();
  const asked = [];
  m.world.makeActor = async (data, height, fallback, opts) => { asked.push(opts); return { root: new THREE.Group(), body: new THREE.Group(), height, kind: 'rigged' }; };
  await m.spawnEnemy(spec.world.enemySpawns.find((p) => spec.enemies[p.enemyIndex].name === '해골 병사'));
  assert.equal(asked[0]?.zombie, false);
});

// --- platformer: the shield shows in the HUD with its countdown ---
test('platformer gm_5e7199df8f: a taken shield shows in the HUD and counts down, with a readable popup over the hero', () => {
  const healths = [], popups = [];
  const m = mode(published('gm_5e7199df8f'), { health: (frac, shield) => healths.push(shield), popup: (text, pos, cls, ms) => popups.push({ text, pos, cls, ms }) });
  m.activateStage();
  m.player.pos.set(3, 0, 4);
  m.applyEffect({ name: '방패', effect: 'shield' }, new THREE.Vector3(3, .65, 4));
  m.refreshHud();
  assert.equal(healths.at(-1), 5, 'the HUD gets the 5 s shield');
  m.updatePickups(1.2); m.refreshHud();
  assert.ok(Math.abs(healths.at(-1) - 3.8) < 1e-6, `then ${healths.at(-1)}`);
  m.updatePickups(4); m.refreshHud();
  assert.equal(healths.at(-1), 0, 'and hides when it runs out');
  const line = popups.find((p) => p.text.includes('방어막 5초'));
  assert.ok(line, 'the shield line pops up');
  assert.equal(line.cls, 'effect', 'in the big effect style');
  assert.ok(line.ms >= 1800, `for ${line.ms} ms (was 900)`);
  assert.ok(line.pos.y >= 2.4 && Math.hypot(line.pos.x - 3, line.pos.z - 4) < .01, 'over the hero\'s head, not on the floor');
});

// --- the night harbor ---
test('night is night: the night city at night darkens fully, a rainy night floor is dark and wet', () => {
  assert.equal(nightStrength('night-city', 'night'), 1, 'a requested night is no longer the evening photo');
  assert.ok(nightStrength('night-city', 'dusk') < 1, 'dusk over the evening street stays light');
  assert.equal(nightStrength('forest', 'night'), 1);
  assert.equal(nightStrength('forest', 'day'), 0);
  const wet = groundLook({ timeOfDay: 'night', weather: 'rain' });
  assert.ok(wet.tint <= .45, `night rain floor tint ${wet.tint}`);
  assert.ok(wet.roughness <= .35, 'wet: glossy');
  const day = groundLook({});
  assert.deepEqual(day, { tint: 1, roughness: 1, envMapIntensity: 1 });
  assert.ok(groundLook({ weather: 'rain' }).tint < 1 && groundLook({ timeOfDay: 'night' }).tint < 1);
});

test('the harbor gm_4baaf38a5b: the water lies past the edge with the dock, cranes over it, container stacks on land', () => {
  const raw = fixture('gm_4baaf38a5b');
  const { ok, errors, spec } = validateSpec({ ...raw, artDirection: { ...raw.artDirection, setting: 'harbor' } });
  assert.equal(ok, true, errors?.join('; '));
  assert.equal(validateSpec({ ...raw, artDirection: { ...raw.artDirection, setting: 'moon' } }).ok, false);
  // the delivery point at the 부두 끝 (z -44) is next to the north edge (z -50)
  assert.equal(harborSide(spec), 'north');
  assert.equal(harborSide({ ...spec, world: { ...spec.world, entities: spec.world.entities.filter((e) => e.id !== 'dock-beacon') } }), 'north',
    'without a dock the water lies opposite the spawn (z 42)');
  const plan = harborPlan(spec, () => .5);
  const { width, depth } = spec.world;
  assert.equal(plan.side, 'north');
  assert.ok(plan.quay <= -depth / 2 && plan.quay >= -depth / 2 - 2, `quay edge at z ${plan.quay}`);
  assert.ok(plan.cranes.length >= 2);
  for (const c of plan.cranes) assert.ok(c.z < plan.quay, 'cranes stand at the water');
  assert.ok(plan.stacks.length >= 8);
  for (const s of plan.stacks) {
    const inside = Math.abs(s.x) < width / 2 + 2 && Math.abs(s.z) < depth / 2 + 2;
    assert.ok(!inside, `a stack at ${s.x},${s.z} is in the play area`);
    assert.ok(s.z > plan.quay, 'and on land');
    assert.ok(s.levels >= 1 && s.levels <= 3);
  }
});

test('the spec\'s containers are drawn as shipping containers: box entities named container / 컨테이너', () => {
  const spec = published('gm_4baaf38a5b');
  const boxes = spec.world.entities.filter((e) => e.kind === 'box');
  assert.equal(boxes.filter(isContainer).length, 6);
  assert.equal(isContainer({ kind: 'building', label: '컨테이너' }), false, 'a building stays a building');
  assert.equal(isContainer({ kind: 'box', id: 'crate', label: '상자' }), false);
});
