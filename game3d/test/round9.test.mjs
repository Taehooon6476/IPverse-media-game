import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { validateSpec } from '../gamespec3d.js';
import { RESUME_CLEARANCE } from '../arpg-data.js';

// The published specs themselves (fixtures/gm_*.spec.json): authored.js's gameplay methods on plain records with the
// three.js stub (real vector math, no rendering).
const stub = new URL('./fixtures/three-stub.mjs', import.meta.url).href;
registerHooks({ resolve: (specifier, context, next) => (/^three(\/|$)/.test(specifier)
  ? { url: stub, shortCircuit: true } : next(specifier, context)) });
globalThis.matchMedia ??= () => ({ matches: false });
const THREE = await import(stub);
const { AuthoredMode } = await import('../authored.js');
const { Arpg } = await import('../arpg.js');
Object.assign(globalThis, { innerWidth: 1600, innerHeight: 1000, document: {
  getElementById: () => ({ append() {} }),
  createElement: () => {
    const node = { style: {}, hidden: false, setAttribute() {}, remove() {} };
    Object.defineProperty(node, 'innerHTML', { set() { node.firstChild = { style: {}, textContent: '' }; } });
    return node;
  } } });

function published(id) {
  const { ok, errors, spec } = validateSpec(JSON.parse(readFileSync(new URL(`./fixtures/${id}.spec.json`, import.meta.url))));
  assert.equal(ok, true, errors?.join('; '));
  return spec;
}
const said = [];
const hud = { popup() {}, say(line) { said.push(line); }, float() {}, notice() {}, objective() {}, status() {}, health() {}, dash() {},
  crosshair() {}, end() {} };
const idle = { look: { x: 0, y: 0 }, down: () => false, hit: () => false, clicked: false, fireHeld: false, pad: null };
function mode(spec, at = spec.world.spawn) {
  const actor = () => ({ root: new THREE.Group(), body: new THREE.Group(), height: 1.8, kind: 'billboard' });
  const world = { scene: new THREE.Group(), flash() {}, particles: { emit() {} }, input: idle,
    rig: { yaw: 0, pitch: .25, shake() {}, forward: () => new THREE.Vector3(0, 0, -1), right: () => new THREE.Vector3(1, 0, 0) },
    makeActor: async () => actor() };
  const m = new AuthoredMode(world, spec, hud, actor());
  m.player = { pos: new THREE.Vector3(at.x, 0, at.z), vel: new THREE.Vector3() };
  // the placed props as build() makes them (the rendering bits are plain groups here)
  for (const placement of spec.world.propPlacements) {
    const group = new THREE.Group(); group.position.set(placement.x, 0, placement.z);
    m.pickups.push(m.pickupFor(placement, group, new THREE.Group(), 'billboard', null));
  }
  return m;
}
const walkTo = (m, p) => { m.player.pos.set(p.x, 0, p.z); m.updatePickups(1 / 30); };

test('ARPG gm_b870737b47: the 6 potions and 3 shields the agent placed (no collect stage) are on the map and work', () => {
  const m = mode(published('gm_b870737b47'));
  m.activateStage();
  assert.equal(m.director.stage.type, 'kills');
  assert.equal(m.pickups.length, 9);
  // no stage asks for them: they are bonus pickups, on the map from the first stage on
  for (const p of m.pickups) assert.ok(p.bonus && p.group.visible, `${p.id} is not on the map`);
  m.hp = 100;
  walkTo(m, m.pickups.find((p) => p.id === 'potion_1').group.position);
  assert.ok(m.hp > 100, 'the potion IP heals');
  assert.equal(m.director.progress, 0, 'a bonus pickup does not count for the kills stage');
  const score = m.score;
  walkTo(m, m.pickups.find((p) => p.id === 'shield_1').group.position);
  assert.ok(m.score > score, 'the shield (effect score) scores');
  assert.equal(m.pickups.filter((p) => p.taken).length, 2);
  m.director.index = 3; m.activateStage(); // the boss stage: the ones not taken are still there
  assert.equal(m.pickups.filter((p) => p.group.visible).length, 7);
});

test('platformer gm_5e7199df8f: the shield on the moving platform shows from the start and gives a shield', () => {
  const m = mode(published('gm_5e7199df8f'));
  m.activateStage();
  const shield = m.pickups.find((p) => p.id === 'shield1');
  assert.ok(shield.bonus && shield.group.visible);
  // the potions still belong to their collect stage
  assert.ok(m.pickups.filter((p) => p.propIndex === 0).every((p) => p.stage === 'collect-potions' && !p.bonus));
  m.director.index = 1; m.activateStage();
  assert.ok(shield.group.visible, 'still there in the next stage');
  walkTo(m, shield.group.position);
  assert.ok(shield.taken);
  const hp = m.hp;
  m.hurt(20);
  assert.equal(m.hp, hp, 'the shield blocks the next hits');
});

test('wave game gm_e0ebd94446: a supply stage points the goal arrow at the nearest crate left, to the last one', () => {
  const m = mode(published('gm_e0ebd94446'), { x: 20, z: 10 });
  m.phase = 'playing';
  m.director.index = 3; m.activateStage(); // supply 2
  const left = () => m.pickups.filter((p) => p.stage === 'supply2' && !p.taken);
  assert.equal(left().length, 3);
  for (let n = 0; n < 3; n++) {
    m.pointToGoal(m.director.stage);
    assert.equal(m.goalArrow.hidden, false, `no arrow with ${left().length} crates left`);
    const p = m.player.pos;
    const nearest = left().reduce((a, b) => (a && a.group.position.distanceTo(p) < b.group.position.distanceTo(p) ? a : b), null);
    assert.equal(m.goalArrow.firstChild.textContent, `➤ ${Math.round(Math.hypot(nearest.x - p.x, nearest.z - p.z))}m`);
    // the arrow is not the only way to see it: a tall light beam stands over every crate the stage wants
    assert.ok(nearest.beam?.visible, `${nearest.id} has no beam`);
    walkTo(m, nearest.group.position);
    m.player.pos.set(-20, 0, 20); // walk off somewhere else
  }
  assert.equal(left().length, 0);
});

test('ARPG gm_b870737b47: an idle hero is not ambushed while the stage-1 story box is up', async () => {
  const spec = published('gm_b870737b47');
  const m = mode(spec);
  m.activateStage();
  said.length = 0;
  m.begin(); // 임무 시작: the first story box shows
  assert.equal(said.at(-1)?.text, spec.mission.stages[0].story.text);
  // the room-1 pack appears away from the spawn (one was authored 8 m from it)
  const hero = m.player.pos;
  for (const p of m.pendingSpawns) {
    const at = m.spawnPoint(p);
    assert.ok(Math.hypot(at.x - hero.x, at.z - hero.z) >= RESUME_CLEARANCE - .01, `${p.id} at ${at.x},${at.z}`);
  }
  // and holds while the box is up: 6 s of no input, no blow lands and nobody closes in
  m.enemies = m.pendingSpawns.map((p) => {
    const at = m.spawnPoint(p);
    return { ...p, actor: { root: new THREE.Group(), body: new THREE.Group() }, pos: new THREE.Vector3(at.x, 0, at.z),
      hp: 3, maxHp: 3, speed: 2.2, cooldown: 0, telegraph: 0, windup: .75, phase: 0, humanoid: true };
  });
  const start = m.enemies.map((e) => e.pos.clone());
  const hp = m.hp;
  for (let t = 0; t < 6; t += 1 / 30) { m.updateCalm(1 / 30); m.sayFor -= 1 / 30; m.updateEnemies(1 / 30); }
  assert.equal(m.hp, hp);
  assert.ok(m.enemies.every((e, i) => e.pos.distanceTo(start[i]) < .01 && e.telegraph <= 0), 'they wait');
  // the box closes (its 7 s, or E / Enter): they come
  for (let t = 0; t < 2; t += 1 / 30) { m.sayFor -= 1 / 30; m.updateCalm(1 / 30); m.updateEnemies(1 / 30); }
  assert.ok(m.enemies.some((e, i) => e.pos.distanceTo(start[i]) > .5), 'the fight starts once the story is read');
});

test('the story box closes on E or Enter (not on the Enter that started the mission), and an attack ends the wait', () => {
  const m = mode(published('gm_b870737b47'));
  m.activateStage();
  m.begin();
  const keys = (...codes) => ({ ...idle, hit: (...c) => c.some((k) => codes.includes(k)) });
  m.world.input = keys('Enter');
  m.updateCalm(1 / 30); // the same frame as the briefing's Enter
  assert.ok(m.sayFor > 0 && m.calm);
  m.elapsed += .5;
  m.updateCalm(1 / 30);
  assert.ok(m.sayFor <= 0 && !m.calm, 'Enter closes the box');
  const n = mode(published('gm_b870737b47'));
  n.activateStage(); n.begin(); n.elapsed += .5;
  n.world.input = { ...idle, down: (c) => c === 'KeyF' };
  n.updateCalm(1 / 30);
  assert.equal(n.calm, false, 'the first swing starts the fight');
});

test('ARPG boss: the skeleton king stands well over the hero, lit, and the camera drops for the fight', async () => {
  const spec = published('gm_b870737b47');
  const m = mode(spec);
  m.arpg = new Arpg(m); m.arpg.yaw = Math.PI / 4; // setup()'s diagonal view
  m.director.index = 3; m.activateStage();
  const heights = [];
  m.world.makeActor = async (data, height) => { heights.push(height); return { root: new THREE.Group(), body: new THREE.Group(), height, kind: 'rigged' }; };
  m.bossLight = { position: new THREE.Vector3(), intensity: 0 };
  await m.spawnEnemy(spec.world.enemySpawns.find((p) => p.id === 'king_spawn'));
  const boss = m.enemies.find((e) => e.boss);
  assert.ok(heights[0] >= 3.2, `boss model ${heights[0]} m (the hero is 1.8 m)`);
  m.player.pos.set(boss.pos.x, 0, boss.pos.z - 8);
  const pitch = [];
  for (let t = 0; t < 1.5; t += 1 / 30) { m.arpg.frame(1 / 30); m.updateBossLight(1 / 30); pitch.push(m.world.rig.pitch); }
  assert.ok(pitch.at(-1) < .8, `pitch ${pitch.at(-1).toFixed(2)}: a lower camera sees the king standing, not his cloak from above`);
  assert.ok(m.bossLight.intensity > 0 && m.bossLight.position.distanceTo(boss.pos) < 6, 'a key light follows the boss');
  m.enemies = []; // the boss falls: the usual top-down view comes back
  for (let t = 0; t < 2; t += 1 / 30) m.arpg.frame(1 / 30);
  assert.ok(Math.abs(m.world.rig.pitch - .95) < .02);
});
