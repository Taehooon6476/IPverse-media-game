import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

// A rig whose legs differ (a knee misread: one leg 1.28 m of bone, the other 0.92 m) is dropped for the raw mesh,
// a rigged body keeps its shape (uniform scale from its height, no squash), and the platformer jump clears the
// authored contract's step limits (server/authored_contract.py).
const stub = new URL('./fixtures/three-stub.mjs', import.meta.url).href;
registerHooks({ resolve: (specifier, context, next) => (/^three(\/|$)/.test(specifier)
  ? { url: stub, shortCircuit: true } : next(specifier, context)) });
globalThis.matchMedia ??= () => ({ matches: false });
const THREE = await import(stub);
const { legImbalance, LEG_IMBALANCE_MAX, rawModelUrl } = await import('../ualclips.js');
const { animateBody, PlayerController, JUMP, jumpApex } = await import('../world.js');
const { STEP_UP, AuthoredMode } = await import('../authored.js');

// world-space bone heads of a broken rig (assets/ip_1c9d09f834.rig.glb), and of a sound rig
const RUMI = { thigh_l: [.095, .858, .294], calf_l: [.095, .419, .291], foot_l: [.095, -.061, .252],
  thigh_r: [-.085, .859, .299], calf_r: [-.085, .223, .294], foot_r: [-.085, -.42, .243] };
const SOUND = { thigh_l: [.1265, .098, .9098], calf_l: [.1265, .1009, .494], foot_l: [.1265, .1327, .0987],
  thigh_r: [-.0983, .0737, .9126], calf_r: [-.0983, .0766, .5022], foot_r: [-.0983, .1101, .0847] };

test('a rig whose legs differ in length is broken; a sound one is not', () => {
  assert.ok(legImbalance(RUMI) > LEG_IMBALANCE_MAX, `rumi ${legImbalance(RUMI)}`);
  assert.ok(legImbalance(SOUND) < LEG_IMBALANCE_MAX / 2, `sound ${legImbalance(SOUND)}`);
  assert.equal(legImbalance({ thigh_l: [0, 1, 0] }), 0); // not a UAL leg chain: nothing to judge
  // sound rigs are within 5 %, broken ones 18-46 %
  assert.ok(LEG_IMBALANCE_MAX > .05 && LEG_IMBALANCE_MAX < .18);
  assert.equal(rawModelUrl('assets/ip_1c9d09f834.rig.glb'), 'assets/ip_1c9d09f834.glb');
  assert.equal(rawModelUrl('assets/ip_1c9d09f834.glb'), null);
});

test('a rigged body keeps its proportions: no squash or stretch on top of its clips', () => {
  const rigged = { body: new THREE.Group(), animator: {}, kind: 'rigged' };
  const plain = { body: new THREE.Group(), kind: 'billboard' }; // a raw mesh does not squash either
  for (const squash of [.28, -.18]) {
    animateBody(rigged, 1 / 60, { squash, speed01: 1 });
    assert.deepEqual(rigged.body.scale.toArray(), [1, 1, 1]);
    animateBody(plain, 1 / 60, { squash, speed01: 1 });
    assert.notEqual(plain.body.scale.y, 1); // the procedural landing squash stays for cutouts
  }
});

function jumpOnce(mechanics) {
  const actor = { root: new THREE.Group(), body: new THREE.Group(), kind: 'model' };
  const world = { particles: { emit() {} } };
  const player = new PlayerController(world, actor, { bounds: { minX: -50, maxX: 50, minZ: -50, maxZ: 50 }, mechanics });
  const rig = { forward: () => new THREE.Vector3(0, 0, -1), right: () => new THREE.Vector3(1, 0, 0), yaw: 0 };
  let frame = 0, apex = 0;
  const input = { moveAxes: () => ({ x: 0, y: 0 }), hit: (code) => code === 'Space' && frame === 1, down: () => false, pad: null };
  for (frame = 0; frame < 90; frame++) { player.update(1 / 60, input, rig); apex = Math.max(apex, player.pos.y); }
  return apex;
}

test('the platformer jump clears the contract step with a margin, and the measured apex matches', () => {
  const src = readFileSync(new URL('../../server/authored_contract.py', import.meta.url), 'utf8');
  const rise = Number(src.match(/^STEP_RISE = ([\d.]+)/m)[1]), gap = Number(src.match(/^STEP_GAP = ([\d.]+)/m)[1]);
  const platformer = { jump: true, fallRespawn: true };
  const apex = jumpOnce(platformer);
  assert.ok(Math.abs(apex - jumpApex(platformer)) < .02, `simulated ${apex} vs ${jumpApex(platformer)}`);
  assert.ok(jumpApex(platformer) > jumpApex({ jump: true }), 'the platformer jumps higher than the other genres');
  assert.ok(jumpApex(platformer) < 1.6, 'a bit higher, not a moon jump');
  // a top is landed on once the feet are within STEP_UP of it; a 1.6 m first island needs the platformer's jump
  assert.ok(jumpApex({ jump: true }) + STEP_UP < 1.6);
  assert.ok(jumpApex(platformer) + STEP_UP >= rise + .5, `reach ${jumpApex(platformer) + STEP_UP} vs step ${rise}`);
  // across: airborne until the feet come back down to rise - STEP_UP, at the slowest walk (speed 1), no sprint
  const v = JUMP.platformer, g = JUMP.gravity, h = rise - STEP_UP;
  const air = (v + Math.sqrt(v * v - 2 * g * h)) / g;
  const walk = 4.2 + 1.1 * 1;
  assert.ok(walk * air >= gap + .5, `carry ${walk * air} vs gap ${gap}`);
});

test('a dropped rig without its raw mesh stands as the cutout instead of failing the game', () => {
  const strict = (actor) => () => AuthoredMode.prototype.strictActor.call({}, actor, { modelUrl: 'assets/ip_x.rig.glb', spriteUrl: 'assets/ip_x.png' }, '루미');
  assert.doesNotThrow(strict({ kind: 'billboard', rigDropped: true }));
  assert.doesNotThrow(strict({ kind: 'model', rigDropped: true })); // the raw mesh
  assert.throws(strict({ kind: 'billboard' }), /GLB를 불러오지 못했습니다/); // a GLB that did not load still fails visibly
});
