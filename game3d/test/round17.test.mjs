import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

// A sky climb: the first coin's island is 2 m up and out of reach from the start (the first step, 1 m up, stands
// beside it). The built-in player climbs the tops one step at a time (sky.js climbStep) and jumps at the edge; the
// camera starts on the first step.
const stub = new URL('./fixtures/three-stub.mjs', import.meta.url).href;
registerHooks({ resolve: (specifier, context, next) => (/^three(\/|$)/.test(specifier)
  ? { url: stub, shortCircuit: true } : next(specifier, context)) });
globalThis.matchMedia ??= () => ({ matches: false });
const THREE = await import(stub);
const { PlayerController } = await import('../world.js');
const { SKY, CLIMB, skyIslands, climbNodes, climbPath, climbStep, nodeAt, canStep } = await import('../sky.js');
const { STEP_UP, AuthoredMode } = await import('../authored.js');

const KAIRO = JSON.parse(readFileSync(new URL('./fixtures/gm_8f1fc9a181.spec.json', import.meta.url), 'utf8'));
const platformsOf = (world) => world.entities.filter((e) => e.kind === 'platform');
const nodesOf = (world) => climbNodes(skyIslands(world), platformsOf(world));

test('the climb rule is the contract one', () => {
  const src = readFileSync(new URL('../../server/authored_contract.py', import.meta.url), 'utf8');
  assert.equal(CLIMB.rise, Number(src.match(/^STEP_RISE = ([\d.]+)/m)[1]));
  assert.equal(CLIMB.gap, Number(src.match(/^STEP_GAP = ([\d.]+)/m)[1]));
});

test("kairo's first coin is two steps up: the start island, the first step, then the coin's island", () => {
  const nodes = nodesOf(KAIRO.world);
  const home = nodes.find((n) => n.id === 'home'), coin1 = KAIRO.world.entities.find((e) => e.id === 'coin1');
  const path = climbPath(nodes, home, nodeAt(nodes, coin1.x, coin1.z));
  assert.deepEqual(path.map((n) => n.id), ['home', 'isle1', 'isle2']);
  assert.ok(!canStep(home, nodes.find((n) => n.id === 'isle2')), 'the island it faced was out of reach');
  assert.ok(canStep(home, path[1]) && path[1].top <= CLIMB.rise, 'the first step is within one jump of the start island');
});

/** Ground and walls of a sky world as AuthoredMode has them: the islands and the platform tops are floors, a platform's
 * side a wall below its top (less STEP_UP). */
function physics(world) {
  const nodes = nodesOf(world);
  const boxes = platformsOf(world).map((p) => ({ min: { x: p.x - p.width / 2, y: p.y ?? 0, z: p.z - p.depth / 2 },
    max: { x: p.x + p.width / 2, y: (p.y ?? 0) + p.height, z: p.z + p.depth / 2 } }));
  const groundAt = (x, z, y = 0) => {
    let floor = nodes.some((n) => n.top === 0 && Math.abs(x - n.x) <= n.width / 2 && Math.abs(z - n.z) <= n.depth / 2) ? 0 : SKY.noFloor;
    for (const b of boxes) if (x >= b.min.x && x <= b.max.x && z >= b.min.z && z <= b.max.z && b.max.y <= y + .32) floor = Math.max(floor, b.max.y);
    return floor;
  };
  const collide = (p, r) => {
    for (const b of boxes) {
      if (p.y >= b.max.y - STEP_UP || p.y + 1.6 < b.min.y) continue;
      const x = Math.min(Math.max(p.x, b.min.x), b.max.x), z = Math.min(Math.max(p.z, b.min.z), b.max.z);
      const dx = p.x - x, dz = p.z - z, d = Math.hypot(dx, dz);
      if (d < r && d > 1e-4) { p.x = x + dx / d * r; p.z = z + dz / d * r; }
    }
  };
  return { nodes, groundAt, collide };
}

/** The built-in player on kairo's islands: every 80 ms (runtime3d.js) it asks climbStep for the nearest coin left,
 * faces that point, holds W and taps Space when told to jump. → {coins, falls, seconds} */
function climb(world, { seconds = 90, speed = KAIRO.player.speed } = {}) {
  const { nodes, groundAt, collide } = physics(world);
  const actor = { root: new THREE.Group(), body: new THREE.Group(), kind: 'model' };
  const player = new PlayerController({ particles: { emit() {} } }, actor, {
    speed, groundAt, collide, mechanics: { jump: true, sprint: true, fallRespawn: true },
    bounds: { minX: -60, maxX: 60, minZ: -60, maxZ: 60 } });
  player.place(world.spawn.x, world.spawn.z);
  const coins = world.entities.filter((e) => e.pickup).map((e) => ({ ...e }));
  const state = {};
  let dir = { x: 0, z: -1 }, jump = false, walk = true, from = nodeAt(nodes, player.pos.x, player.pos.z, 0), safe = from, falls = 0, got = 0;
  const rig = { forward: () => new THREE.Vector3(dir.x, 0, dir.z), right: () => new THREE.Vector3(-dir.z, 0, dir.x) };
  const input = { moveAxes: () => ({ x: 0, y: walk ? 1 : 0 }), hit: (code) => code === 'Space' && jump, down: () => false, pad: null };
  for (let frame = 0; frame < seconds * 60 && got < coins.length; frame++) {
    const p = player.pos;
    if (player.grounded) from = nodeAt(nodes, p.x, p.z, p.y) ?? from;
    if (player.grounded && from) safe = from;
    jump = false;
    if (frame % 5 === 0) {
      const left = coins.filter((c) => !c.taken);
      const goal = left.reduce((a, c) => (!a || Math.hypot(c.x - p.x, c.z - p.z) < Math.hypot(a.x - p.x, a.z - p.z) ? c : a), null);
      const step = climbStep(nodes, p, goal, from, state, player.vel);
      assert.ok(step, `a climb to ${goal.id} from ${from?.id}`);
      const d = Math.hypot(step.x - p.x, step.z - p.z) || 1;
      dir = { x: (step.x - p.x) / d, z: (step.z - p.z) / d };
      jump = step.jump && player.grounded;
      walk = !step.stop;
    }
    player.update(1 / 60, input, rig);
    for (const c of coins) if (!c.taken && Math.hypot(c.x - p.x, c.z - p.z) < 1.1 && Math.abs(p.y - (c.y ?? 0)) < 2.2) { c.taken = true; got += 1; }
    if (p.y < SKY.fallY) { falls += 1; p.set(safe.x, safe.top + .05, safe.z); player.vel.set(0, 0, 0); }
  }
  return { coins: got, falls, total: coins.length };
}

test('the built-in player climbs kairo\'s islands and takes all six coins without a fall, at any hero speed', () => {
  for (const speed of [1, 2, 3]) { // walk 5.3–7.5 m/s (world.js PlayerController)
    const run = climb(KAIRO.world, { speed });
    assert.equal(run.falls, 0, `speed ${speed}: fell ${run.falls} times`);
    assert.equal(run.coins, run.total, `speed ${speed}`);
  }
});

test('a step is taken square: the run-up point inside the edge first, then the landing point across', () => {
  const nodes = nodesOf(KAIRO.world), byId = (id) => nodes.find((n) => n.id === id);
  const coin1 = KAIRO.world.entities.find((e) => e.id === 'coin1'), state = {};
  // just landed on isle1's far corner from home: it must not jump on toward isle2's middle, off its side
  const first = climbStep(nodes, { x: -1.5, z: 14.4 }, coin1, byId('isle1'), state);
  assert.equal(first.next.id, 'isle2');
  assert.equal(first.jump, false, 'no jump before the run-up');
  assert.ok(Math.abs(first.x - (2 - CLIMB.runup)) < 1e-9 && Math.abs(first.z - 16) < 1e-9, `run-up at ${first.x},${first.z}`);
  const go = climbStep(nodes, { x: first.x, z: first.z }, coin1, byId('isle1'), state);
  assert.ok(Math.abs(go.x - (4 + CLIMB.land)) < 1e-9 && Math.abs(go.z - 16) < 1e-9, 'then straight at the landing point');
  assert.equal(climbStep(nodes, { x: 1.5, z: 16 }, coin1, byId('isle1'), state).jump, true, 'and a jump at the edge');
  // at the edge still carrying its turn (+z): it brakes and runs up again
  const turning = climbStep(nodes, { x: 1.5, z: 16.8 }, coin1, byId('isle1'), state, { x: 4, z: 3 });
  assert.deepEqual([turning.jump, turning.stop, state.runup], [false, true, false]);
  assert.equal(climbStep(nodes, { x: 1.5, z: 16 }, coin1, byId('isle1'), { next: 'isle2', runup: true }, { x: 6.4, z: 0 }).jump, true);
});

test('the camera starts on the first step of the climb, not on the first coin out of reach', () => {
  const nodes = nodesOf(KAIRO.world);
  const pos = new THREE.Vector3(KAIRO.world.spawn.x, 0, KAIRO.world.spawn.z);
  const coin1 = KAIRO.world.entities.find((e) => e.id === 'coin1');
  const mode = Object.assign(Object.create(AuthoredMode.prototype), {
    islands: skyIslands(KAIRO.world), arpg: null, mechanics: { jump: true, fallRespawn: true },
    entities: new Map(platformsOf(KAIRO.world).map((e) => [e.id, { ...e, group: { position: new THREE.Vector3(e.x, e.y, e.z) } }])),
    director: { stage: { id: 'collect-crystals', type: 'reach', entityIds: ['coin1'] } },
    targets: [{ id: 'coin1', x: coin1.x, z: coin1.z }], pickups: [], spec: KAIRO,
    player: { pos, grounded: true, yaw: 0 }, world: { rig: { yaw: 0 } },
  });
  mode.faceFirstGoal();
  const isle1 = nodes.find((n) => n.id === 'isle1');
  assert.ok(Math.abs(mode.world.rig.yaw - Math.atan2(-(isle1.x - pos.x), -(isle1.z - pos.z))) < 1e-9, 'faces isle1');
  // and the bot's own aim on that climb: the first step, with a jump at the start island's edge
  pos.set(0, 0, 21.6); // the run-up point, 1.6 m inside the start island's edge facing isle1
  assert.equal(mode.climbToward({ x: coin1.x, z: coin1.z }).jump, false);
  pos.set(0, 0, 20.6); // .6 m from the edge: jump
  const step = mode.climbToward({ x: coin1.x, z: coin1.z });
  assert.equal(step.next.id, 'isle1');
  assert.equal(step.jump, true);
});

test('a pickup is sized against the hero: a flat disc no wider than PICKUP_MAX, a character by its height', async () => {
  const { fitScale, PICKUP_MAX } = await import('../world.js');
  const HERO = 1.8; // runtime3d.js makeActor(spec.player, 1.8)
  assert.ok(PICKUP_MAX >= .6 * HERO - .05 && PICKUP_MAX <= HERO, `cap ${PICKUP_MAX}`);
  const disc = { x: 1, y: .1, z: 1 }; // the sun compass GLB: thin and round
  const s = fitScale(disc, .85, PICKUP_MAX);
  assert.ok(Math.max(disc.x, disc.z) * s <= PICKUP_MAX + 1e-9, `disc ${disc.x * s} m wide`);
  assert.equal(fitScale(disc, .85), 8.5); // uncapped: .85 m by its thickness makes it 8.5 m across
  assert.equal(fitScale({ x: .5, y: 1, z: .4 }, .85, PICKUP_MAX), .85); // a small upright item keeps its height
  assert.equal(fitScale({ x: .6, y: 1.8, z: .4 }, 1.8), 1); // characters are never capped
  for (const file of ['authored.js', 'sf.js', 'rpg.js']) { // every mode's pickups pass the cap
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.match(src, /makeActor\([^\n]*maxExtent: PICKUP_MAX/, file);
  }
});
