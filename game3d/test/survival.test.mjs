import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { validateSpec } from '../gamespec3d.js';
import { RESUME_GRACE_SEC, RESUME_CLEARANCE, SPAWN_CLEARANCE } from '../arpg-data.js';

// authored.js loads three.js through the page's import map; here it resolves to a stub with real vector math, and the
// gameplay methods run on plain records (no rendering).
const stub = new URL('./fixtures/three-stub.mjs', import.meta.url).href;
registerHooks({ resolve: (specifier, context, next) => (/^three(\/|$)/.test(specifier)
  ? { url: stub, shortCircuit: true } : next(specifier, context)) });
globalThis.matchMedia ??= () => ({ matches: false });
const THREE = await import(stub);
const { AuthoredMode } = await import('../authored.js');

/** A wave game (two survive waves, supply crates between them, a boss) and a forest (3 crates, then 7 guards), on
 * the dev fixture's assets. */
function survivalSpec(kind = 'wave', mechanics = {}) {
  const input = JSON.parse(readFileSync(new URL('../dev/spec-authored-garden.json', import.meta.url)));
  Object.assign(input, { genre: 'sf-survival', difficulty: 'normal', rules: { playerHp: 150, timeLimitSec: 0, enemyRate: 1.2 } });
  input.enemies = [
    { name: '방사능 돌연변이', color: '#8fb23a', shape: 'square', speed: 2, hp: 2, ipId: 'ip_dev_mutant', spriteUrl: 'dev/assets/hero.png' },
    { name: '거대 보스 괴물', color: '#b5442a', shape: 'circle', speed: 2, hp: 3, ipId: 'ip_dev_boss', spriteUrl: 'dev/assets/hero.png' },
  ];
  input.props[0].effect = 'heal';
  Object.assign(input.mechanics, { autoFire: true, fireIntervalSec: .6, weaponDamage: 2, dash: true, ...mechanics });
  delete input.world.npc;
  input.world.entities = input.world.entities.filter((e) => e.kind !== 'beacon');
  if (kind === 'wave') {
    Object.assign(input.world, { width: 90, depth: 40, spawn: { x: -34, z: 0 } });
    input.world.entities = [];
    input.world.propPlacements = [{ id: 'crate1', propIndex: 0, x: -22, z: -12, stageId: 'supply1' }, { id: 'crate2', propIndex: 0, x: -12, z: 12, stageId: 'supply1' }];
    input.world.enemySpawns = [
      ...['a', 'b', 'c', 'd'].map((k, i) => ({ id: `w1${k}`, enemyIndex: 0, x: [40, 40, 0, -40][i], z: [-15, 15, -17, 15][i], stageId: 'wave1' })),
      ...['a', 'b', 'c', 'd'].map((k, i) => ({ id: `w2${k}`, enemyIndex: 0, x: [40, 40, 0, -40][i], z: [-15, 15, -17, 15][i], stageId: 'wave2' })),
      { id: 'boss1', enemyIndex: 1, x: 38, z: 0, stageId: 'boss' }];
    input.mission = { title: '승강장 방어전', stages: [
      { id: 'wave1', type: 'survive', label: '1웨이브: 45초 버텨라', target: 45 },
      { id: 'supply1', type: 'collect', label: '보급 상자 2개를 주워라', target: 2, entityIds: ['crate1', 'crate2'], propIndex: 0 },
      { id: 'wave2', type: 'survive', label: '2웨이브: 60초 버텨라', target: 60 },
      { id: 'boss', type: 'boss', label: '보스를 쓰러뜨려라', target: 1, entityIds: ['boss1'], enemyIndex: 1 }] };
  } else {
    Object.assign(input.world, { width: 90, depth: 90, spawn: { x: -38, z: 38 } });
    input.world.entities = [];
    input.world.propPlacements = [{ id: 'crate_2', propIndex: 0, x: -3, z: 28, stageId: 'collect_crates' }];
    input.world.enemySpawns = [[-10, 24], [14, 22], [-24, -6], [12, -8]].map(([x, z], i) => ({ id: `mut_${i + 1}`, enemyIndex: 0, x, z, stageId: 'kill_guards' }));
    input.mission = { title: '안개 숲', stages: [
      { id: 'collect_crates', type: 'collect', label: '보급 상자를 모은다', target: 1, entityIds: ['crate_2'], propIndex: 0 },
      { id: 'kill_guards', type: 'kills', label: '돌연변이 4마리를 처치한다', target: 4, entityIds: input.world.enemySpawns.map((s) => s.id), enemyIndex: 0 }] };
  }
  const { ok, errors, spec } = validateSpec(input);
  assert.equal(ok, true, errors?.join('; '));
  return spec;
}

const hud = { popup() {}, say() {}, float() {}, notice() {}, objective() {}, status() {}, health() {}, dash() {}, crosshair() {}, end() {} };
function mode(spec, at = spec.world.spawn) {
  const actorFor = () => ({ root: new THREE.Group(), body: new THREE.Group(), height: 1.8, kind: 'billboard' });
  const world = { scene: new THREE.Group(), flash() {}, particles: { emit() {} }, rig: { yaw: 0, shake() {}, forward: () => new THREE.Vector3(0, 0, -1) },
    makeActor: async () => actorFor() };
  const m = new AuthoredMode(world, spec, hud, actorFor());
  m.player = { pos: new THREE.Vector3(at.x, 0, at.z), vel: new THREE.Vector3() };
  return m;
}
const enemy = (m, x, z, extra = {}) => ({ id: `e${x},${z}`, enemyIndex: 0, actor: { root: new THREE.Group(), body: new THREE.Group() },
  pos: new THREE.Vector3(x, 0, z), hp: 2, maxHp: 2, speed: 2.2, cooldown: 0, telegraph: 0, windup: .75, phase: 0, ...extra });

test('다시 시작 at a checkpoint: the hero blinks invulnerable for a moment and no enemy appears next to them', () => {
  const spec = survivalSpec('forest', { autoFire: false });
  const first = mode(spec, { x: -3, z: 28 }); // the third crate taken at (-3, 28): the guard stage begins there
  first.director.index = 1;
  first.activateStage(); // the checkpoint 다시 시작 returns to
  const resumed = mode(spec);
  assert.equal(resumed.resumed?.stage, 1);
  resumed.resume(resumed.resumed);
  assert.deepEqual(resumed.player.pos.toArray(), [-3, 0, 28]);
  resumed.activateStage();
  resumed.begin(); // Enter
  assert.ok(resumed.hurtFor >= RESUME_GRACE_SEC, `i-frames ${resumed.hurtFor}`);
  // mut_1 is placed 8 m away: every guard appears 12 m away or more
  const hero = resumed.player.pos;
  for (const p of resumed.pendingSpawns) {
    const at = resumed.spawnPoint(p);
    assert.ok(Math.hypot(at.x - hero.x, at.z - hero.z) >= RESUME_CLEARANCE - .01, `${p.id} at ${at.x},${at.z}`);
  }
  // mut_2 at (14, 22) is 18 m away: it keeps its own place
  const far = resumed.pendingSpawns.find((p) => p.id === 'mut_2');
  assert.deepEqual(resumed.spawnPoint(far), { x: 14, z: 22 });
  // later on (and in a fresh run) only the everyday clearance applies
  resumed.elapsed += 30;
  const close = resumed.spawnPoint({ x: hero.x + 2, z: hero.z });
  assert.ok(Math.abs(Math.hypot(close.x - hero.x, close.z - hero.z) - SPAWN_CLEARANCE) < .01);
  const fresh = mode(survivalSpec('forest', { autoFire: false }));
  fresh.begin();
  assert.equal(fresh.hurtFor, 0);
});

test('when a wave ends its leftover horde stops attacking and leaves: the supply stage starts on a clear field', async () => {
  const spec = survivalSpec('wave');
  const m = mode(spec, { x: -20, z: 0 });
  m.activateStage();
  m.enemies = [enemy(m, -16, 0, { telegraph: .3 }), enemy(m, -28, 6)];
  for (const e of m.enemies) m.root.add(e.actor.root);
  m.enemyBolts = [{ mesh: { position: new THREE.Vector3(-18, 1, 0), geometry: { dispose() {} }, material: { dispose() {} } },
    velocity: new THREE.Vector3(-9.5, 0, 0), life: 2, damage: 5 }];
  m.director.index = 1; // wave 1's clock ran out
  m.completeStage({ id: 'wave1', type: 'survive' });
  assert.equal(m.director.stage.id, 'supply1');
  assert.equal(m.enemies.length, 0, 'nobody is left to attack during the supply stage');
  assert.equal(m.enemyBolts.length, 0, 'bolts in the air fizzle out');
  assert.equal(m.leaving.length, 2);
  assert.ok(m.leaving.every((e) => e.telegraph === 0));
  const hp = m.hp;
  for (let i = 0; i < 60; i++) m.updateLeaving(.05);
  assert.equal(m.leaving.length, 0, 'gone within 3 s');
  assert.equal(m.hp, hp);
  assert.equal(m.root.children.length, 0);
  // a mutant of the old wave still loading when the wave ended never joins the supply stage
  const late = mode(survivalSpec('wave'), { x: -20, z: 0 }); // a fresh run (the one above left a checkpoint)
  late.activateStage();
  let finish;
  late.world.makeActor = () => new Promise((resolve) => { finish = resolve; });
  const spawning = late.spawnEnemy({ id: 'w1a~w3', enemyIndex: 0, x: 40, z: -15 });
  late.director.index = 1;
  late.completeStage({ id: 'wave1', type: 'survive' });
  finish({ root: new THREE.Group(), body: new THREE.Group(), height: 1.8, kind: 'billboard' });
  await spawning;
  assert.equal(late.enemies.length, 0);
});

test('a boss\'s minions run when it falls; an ARPG pack keeps fighting for its XP after its leaders die', () => {
  const spec = survivalSpec('wave');
  spec.mission.stages.push({ id: 'escape', type: 'collect', label: '탈출', target: 1, entityIds: ['crate1'], propIndex: 0 });
  const m = mode(spec);
  // a city's street patrol (city.js) is not part of the boss fight: it keeps walking its beat
  const patrol = enemy(m, -30, 5, { patrol: { route: [{ x: -30, z: 5 }, { x: 30, z: 5 }], leg: 1 } });
  m.enemies = [enemy(m, 10, 0, { minion: true }), patrol];
  m.director.index = 4;
  m.completeStage({ id: 'boss', type: 'boss' });
  assert.equal(m.ended, false);
  assert.deepEqual(m.enemies, [patrol]);
  assert.equal(m.leaving.length, 1);
  assert.equal(m.leaves({ type: 'kills' }), true); // guards left over from a kills stage go too
  const a = mode(survivalSpec('forest', { style: 'arpg', autoFire: false }));
  a.enemies = [enemy(a, 10, 0, { packMate: true })];
  a.director.index = 1;
  a.completeStage({ id: 'collect_crates', type: 'collect' }); // a non-combat stage never sends anyone away
  assert.equal(a.enemies.length, 1);
  assert.equal(a.leaves({ type: 'kills' }), false);
  assert.equal(a.leaves({ type: 'survive' }), true);
});

test('aim assist: a manual bolt fired a few degrees off a walking guard is bent onto it, leading its walk', () => {
  const m = mode(survivalSpec('forest', { autoFire: false }), { x: 0, z: 0 }); // the crosshair looks down -z (yaw 0)
  const off = 6 * Math.PI / 180, speed = 42; // authored.js BOLT_SPEED
  const guard = enemy(m, 14 * Math.sin(off), -14 * Math.cos(off), { vel: new THREE.Vector3(2.2, 0, 0) }); // walking right
  m.enemies = [guard];
  const origin = new THREE.Vector3(0, 1.1, 0);
  // the bolt's closest pass by the guard's chest while both move (a hit is under .7 m, authored.js updateBolts)
  const pass = (dir) => {
    let best = Infinity;
    for (let t = 0; t < 1.4; t += .002) {
      const bolt = origin.clone().addScaledVector(dir, speed * t), chest = guard.pos.clone().setY(1).addScaledVector(guard.vel, t);
      best = Math.min(best, bolt.distanceTo(chest));
    }
    return best;
  };
  assert.ok(pass(new THREE.Vector3(0, 0, -1)) > 1.4, 'straight down the crosshair it flies past');
  assert.equal(m.assisted(origin), guard);
  assert.ok(pass(m.leadAt(guard, origin)) < .25, `assisted pass ${pass(m.leadAt(guard, origin))} m`);
  // nobody near the crosshair: the bolt keeps the player's aim
  guard.pos.set(9, 0, -9);
  assert.equal(m.assisted(origin), null);
});
