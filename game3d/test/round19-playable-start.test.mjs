import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RUNTIME, THREE } from './fixtures/headless.mjs';

// A playable ad's SF round (version-1 arenas, sf.js) opens with its enemies in front of the player: a published
// game keeps sf.js's own opening (START_GRACE without an enemy, then drones that come up at the arena's rim, 14 m
// or more away), which in a trial of a few seconds reads as a round that has not started.
const { SfMode, openingSpot } = await import('../sf.js');
const sfSource = readFileSync(new URL('../sf.js', import.meta.url), 'utf8');

const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
/** The angle between the camera's forward (world.js CameraRig.forward: (-sin yaw, 0, -cos yaw)) and the spot, degrees. */
function offAim(spot, player, yaw) {
  const to = { x: spot.x - player.x, z: spot.z - player.z }, len = Math.hypot(to.x, to.z);
  return Math.acos(Math.min(1, (to.x * -Math.sin(yaw) + to.z * -Math.cos(yaw)) / len)) * 180 / Math.PI;
}

test('a playable round\'s first enemies come up in front of the camera, a short way off, one of them on the aim', () => {
  for (const yaw of [0, 1.1, -2.4, Math.PI]) {
    const player = { x: 0, z: 6 };
    const spots = [0, 1, 2].map((i) => openingSpot(i, 3, player, yaw, 30));
    for (const spot of spots) {
      const d = flat(spot, player);
      assert.ok(d >= 8 && d <= 13, `yaw ${yaw}: ${d.toFixed(1)} m from the player (the rim is 14 m or more away)`);
      assert.ok(offAim(spot, player, yaw) <= 30, `yaw ${yaw}: on screen, ${offAim(spot, player, yaw).toFixed(0)}° off the aim`);
    }
    assert.ok(offAim(spots[1], player, yaw) < 1, 'the middle one is on the aim: the auto-fire answers at once');
    assert.ok(flat(spots[0], spots[2]) > 4, 'fanned out, not on top of each other');
  }
});

test('the first enemies stay inside the arena and out of its cover', () => {
  // the player in a corner, looking at the wall
  const corner = openingSpot(0, 1, { x: 26, z: 26 }, Math.PI, 30); // forward = +z
  assert.ok(Math.abs(corner.x) <= 27 && Math.abs(corner.z) <= 27, JSON.stringify(corner));
  // a pillar where the spot would be: the next free distance on the same line
  const player = { x: 0, z: 6 };
  const open = openingSpot(0, 1, player, 0, 30);
  const blocked = (x, z) => Math.hypot(x - open.x, z - open.z) < 1.5;
  const moved = openingSpot(0, 1, player, 0, 30, blocked);
  assert.ok(!blocked(moved.x, moved.z), 'not inside the pillar');
  assert.ok(offAim(moved, player, 0) < 1 && flat(moved, player) >= 8 && flat(moved, player) <= 14);
});

/** The mode as its HUD and its opening need it (the arena itself needs WebGL). */
function round(fields = {}) {
  const notices = [], spawned = [];
  const hud = { objective() {}, status() {}, health() {}, dash() {}, notice: (text) => notices.push(text) };
  const mode = Object.assign(Object.create(SfMode.prototype), {
    spec: { objective: { type: 'kills' }, difficulty: 'normal' }, target: 20, kills: 0, elapsed: 0, hp: 100, maxHp: 100, shield: 0,
    score: 0, spawnIn: 5, grace: 5, opening: 0, boxes: [], hud, player: { dashCooldown: 0, pos: new THREE.Vector3(0, 0, 6) },
    world: { rig: { yaw: 0 } }, spawnDrone: (at) => { spawned.push(at); return {}; }, ...fields });
  return { mode, notices, spawned };
}

test('a published game keeps its opening: 5 s without an enemy, counted down on the HUD', () => {
  const { mode, notices, spawned } = round();
  mode.elapsed = 0.5;
  mode.refreshHud();
  assert.equal(notices.at(-1), '적 출현까지 5초');
  mode.spawnOpening();
  assert.deepEqual(spawned, [], 'no enemy placed in front of the player');
  assert.match(sfSource, /spawnIn: START_GRACE, grace: START_GRACE, opening: 0,/, 'a new round starts with the grace');
});

test('a playable ad\'s round (openNow) has its enemies there at its first frame: no grace, no countdown', () => {
  const { mode, notices, spawned } = round();
  mode.elapsed = 0; mode.refreshHud(); // build() wrote the HUD before the runtime knew the round
  assert.equal(notices.at(-1), '적 출현까지 5초');
  mode.openNow();
  assert.equal(notices.at(-1), '', 'the round holds for the first input under a HUD that promises no wait');
  assert.equal(mode.grace, 0);
  assert.ok(mode.spawnIn <= 0, 'the rim\'s spawns start at once too');
  mode.spawnOpening();
  assert.equal(spawned.length, 3);
  for (const at of spawned) assert.ok(flat(at, mode.player.pos) <= 13 && offAim(at, mode.player.pos, 0) <= 30, JSON.stringify(at));
  mode.spawnOpening();
  assert.equal(spawned.length, 3, 'once');
  mode.elapsed = 0.5; mode.spawnIn = 1.1; // update() has set the next rim spawn
  mode.refreshHud();
  assert.equal(notices.at(-1), '', 'nothing says 적 출현까지 over enemies that are there');
  // update() places them before the round's first spawn tick, and spawnDrone takes the spot
  assert.match(sfSource, /if \(this\.opening\) this\.spawnOpening\(\);\n\s+this\.spawnIn -= dt;/);
  assert.match(sfSource, /spawnDrone\(at = null\) \{[\s\S]{0,200}let x = at\?\.x, z = at\?\.z;\n\s+for \(let t = 0; !at && t < 12; t\+\+\)/);
  assert.match(sfSource, /this\.elapsed > this\.grace\) this\.spawnBoss\(\)/, 'a boss round\'s boss does not wait either');
});

// runtime3d.js needs a browser: build()'s own lines, run on a mode
function built(next, playableSec) {
  const from = RUNTIME.indexOf('const surviveSec ='), to = RUNTIME.indexOf('    ended = false;\n    mode = next;', from);
  assert.ok(from >= 0 && to > from, 'runtime3d.js: build()\'s limits');
  new Function('spec', 'next', 'autoplay', 'playableSec', 'AUTOPLAY_ROUND_SEC', `let botCap = 0;\n${RUNTIME.slice(from, to)}`)(
    { objective: { type: 'kills' }, mission: null }, next, false, playableSec, 180);
  return next;
}

test('runtime3d.js: only a playable ad (?playable=) opens the round at once; every mode without an opening is left alone', () => {
  let opened = 0;
  const sf = () => ({ timeLimit: 0, openNow() { opened += 1; } });
  built(sf(), 0);
  assert.equal(opened, 0, 'a published game, the broadcast\'s own game: the 5 s stay');
  assert.equal(built(sf(), 90).timeLimit, 90);
  assert.equal(opened, 1);
  assert.doesNotThrow(() => built({ timeLimit: 0 }, 90), 'authored, race and RPG modes have no openNow');
});
