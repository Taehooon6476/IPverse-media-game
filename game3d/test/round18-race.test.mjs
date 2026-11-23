import { test } from 'node:test';
import assert from 'node:assert/strict';
import { published, trackMode, cityMode, playRound, validateSpec, RUNTIME } from './fixtures/headless.mjs';
import { citySpec } from './fixtures/city-spec.mjs';
const { holdKeys } = await import('../race.js'); // after headless.mjs: race.js loads three.js through its stub

// The built-in player (?autoplay=1) drives: a track race, a city race and a city drive stage. Its walking loop's
// fight keys would steer a car off the road and leave every round to the watchdog. The rounds below are run as
// boot() runs them (fixtures/headless.mjs).
const STALLED = '진행이 멈춰서 이번 판을 마쳐요.'; // (the watchdog's sentence: runtime3d.js BOT_END)

/** A round under the built-in player with what a viewer would see of the car: gates passed in order, the laps, its top
 * speed, the share of the race off the asphalt, its longest stop, and the longest the watchdog's key stood still. */
function race(mode, options = {}) {
  const seen = { gates: 0, order: true, top: 0, off: 0, frames: 0, stop: 0, stall: 0, exits: 0 };
  let next = mode.director.raceNext, still = 0, key = null, keyAt = 0;
  const round = playRound(mode, { ...options, each: (m, t) => {
    const s = m.activeCar?.controller.stateSnapshot(), route = m.raceRoute.length, dt = 1 / (options.fps ?? 30);
    if (m.director.raceNext !== next) { // the director's next gate moves on one at a time
      seen.order &&= m.director.raceNext === (next + 1) % route || m.director.completed;
      seen.gates += 1; next = m.director.raceNext;
    }
    if (m.phase !== 'playing' || m.raceHold > 0) { keyAt = t; return; } // the countdown is no stall
    seen.frames += 1;
    seen.off += s && m.offRoad(s.position) ? 1 : 0;
    seen.top = Math.max(seen.top, Math.abs(s?.speed ?? 0));
    still = s && Math.abs(s.speed) < .5 ? still + dt : 0; seen.stop = Math.max(seen.stop, still);
    if (m.progressKey() !== key) { key = m.progressKey(); keyAt = t; }
    seen.stall = Math.max(seen.stall, t - keyAt);
    seen.exits = m.exitCount ?? 0;
  } });
  return { ...round, ...seen, offShare: seen.off / Math.max(1, seen.frames), done: mode.raceState().done };
}
const say = (r) => JSON.stringify({ seconds: r.seconds, reason: r.reason, failure: r.failure, gates: r.gates, done: r.done, objective: r.objective });

// --- the open track ---------------------------------------------------------------------------------------------------

test('gm_2ceb5d2311 under the built-in player: the car is driven round the road, every gate counts in order, both laps, and the race ends the round', () => {
  const spec = published('gm_2ceb5d2311'), stage = spec.mission.stages[0];
  const r = race(trackMode(spec));
  assert.notEqual(r.failure, STALLED, `the watchdog ended the round: ${say(r)}`);
  assert.equal(r.stalled, false, say(r));
  assert.equal(r.gates, stage.entityIds.length * stage.target, `10 gates a lap, 2 laps: ${say(r)}`);
  assert.ok(r.order, 'the gates were passed in the race\'s order');
  assert.deepEqual(r.mission.history.map((h) => [h.id, h.progress]), [['race1', 2]], 'the race stage completed with its laps');
  assert.ok(r.done && r.done.rank <= stage.finishRank, `finished in the first ${stage.finishRank}: ${say(r)}`);
  assert.deepEqual([r.won, r.reason], [true, 'clear'], say(r));
  assert.equal(r.objective, spec.mission.successText);
  assert.ok(r.seconds < spec.rules.timeLimitSec / 2, `well inside its 600 s: ${r.seconds} s`);
});

test('the built-in player keeps the car on the asphalt at the car\'s pace, never stands still, and the watchdog always sees it gain', () => {
  const r = race(trackMode(published('gm_2ceb5d2311')));
  assert.ok(r.offShare < .01, `off the road ${(r.offShare * 100).toFixed(1)} % of the race`);
  assert.ok(r.top > 20, `top speed ${r.top.toFixed(1)} m/s of the car's 22`);
  assert.ok(r.stop < 1, `stood still ${r.stop.toFixed(1)} s`);
  assert.ok(r.stall < 5, `the watchdog's key stood still ${r.stall.toFixed(1)} s (it unsticks at 10 s, ends the round at 40 s)`);
});

test('the race is driven at the frame rates a broadcast gets: 60 and 20 a second, and the 5 of a software renderer', () => {
  for (const fps of [60, 20, 5]) {
    const r = race(trackMode(published('gm_2ceb5d2311')), { fps });
    assert.equal(r.gates, 20, `${fps} fps: ${say(r)}`);
    assert.deepEqual([r.reason, r.stalled], ['clear', false], `${fps} fps: ${say(r)}`);
    assert.ok(r.offShare < .02 && r.stop < 1, `${fps} fps: off the road ${(r.offShare * 100).toFixed(1)} %, stood still ${r.stop.toFixed(1)} s`);
  }
});

test('held against a solid the car backs out and drives on: by its own count after 1.5 s, and when the watchdog asks', () => {
  const mode = trackMode(published('gm_2ceb5d2311')), car = mode.activeCar.controller, free = car.collide;
  // something solid at its nose on the grid: no way forward until it has backed off
  let wall = true, backed = 0;
  car.collide = (p, radius, from) => (wall && (p.x - from.x) * -Math.sin(car.yaw) + (p.z - from.z) * -Math.cos(car.yaw) > 0) || free(p, radius);
  const r = playRound(mode, { each: (m, t) => {
    if (wall && t > 3.5) assert.ok(Math.abs(car.speed) < .6 || car.speed < 0, 'held on the grid');
    if (car.speed < -.5) { backed += 1; wall = false; }
  } });
  assert.ok(backed > 0, 'it reversed off the wall');
  // seconds behind the field by then, it still races both laps to the finish (its place is the race's own verdict)
  assert.deepEqual([r.stalled, r.mission.history[0]?.progress], [false, 2], JSON.stringify(r));
  assert.ok(r.seconds < 200, `no lap lost on the way through the field: ${r.seconds} s`);
  // the watchdog's unstick (runtime3d.js calls mode.autoUnstick after 10 s without a gain) is the same way out
  const asked = trackMode(published('gm_2ceb5d2311'));
  Object.assign(asked, { raceHold: 0, phase: 'playing' });
  assert.ok(asked.raceKeys(1 / 30).has('KeyW'));
  asked.autoUnstick();
  const keys = asked.raceKeys(1 / 30);
  assert.ok(keys.has('KeyS') && !keys.has('KeyW'), 'it reverses');
  asked.world.input.dispose();
});

test('without ?autoplay=1 nothing drives for the player: the car waits on the grid for their keys', () => {
  const mode = trackMode(published('gm_2ceb5d2311'), { autoplay: false });
  assert.equal(!!mode.selfDriven, false);
  const input = mode.world.input, at = { ...mode.activeCar.controller.stateSnapshot().position };
  dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter' }));
  for (let i = 0; i < 30 * 8; i++) { mode.update(1 / 30); input.endFrame(); }
  assert.equal(mode.phase, 'playing');
  assert.deepEqual([...input.keys].filter((k) => k !== 'Enter'), [], 'no key is held for them');
  assert.deepEqual(mode.activeCar.controller.stateSnapshot().position, at);
  dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' })); // their own throttle
  for (let i = 0; i < 30 * 2; i++) { mode.update(1 / 30); input.endFrame(); }
  assert.ok(mode.activeCar.controller.stateSnapshot().speed > 10);
  input.dispose();
});

// A person at the keyboard has no watchdog (it lives in the `if (autoplay)` block of runtime3d.js) and the car
// answers their keys through the same drive().
test('a person drives the race with no ?autoplay=1: left alone for a minute the round still waits for them, then their keys take every gate, both laps, and the race ends the round', () => {
  const loop = /\n  if \(autoplay\) \{\n([\s\S]*?)\n  \}\n/.exec(RUNTIME)[1];
  assert.ok(loop.includes('roundWatch(') && !RUNTIME.replace(loop, '').includes('roundWatch('), 'the round watchdog runs under ?autoplay=1 only');
  const spec = published('gm_2ceb5d2311'), mode = trackMode(spec, { autoplay: false }), input = mode.world.input, dt = 1 / 30;
  let ended = null, gates = 0, next = mode.director.raceNext;
  mode.hud.end = (won) => { ended ??= { won }; };
  const frame = () => {
    mode.update(dt); input.endFrame();
    if (mode.director.raceNext !== next) { next = mode.director.raceNext; gates += 1; }
  };
  dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter' })); dispatchEvent(new KeyboardEvent('keyup', { code: 'Enter' }));
  for (let t = 0; t < 60; t += dt) frame(); // hands off the keys for a minute
  assert.deepEqual([ended, mode.phase, gates], [null, 'playing', 0], 'nothing ends a round a person has not played');
  // their hands: the keys a driver would press for the road ahead, as key events on the page and nothing else
  for (let t = 0; t < 400 && !ended; t += dt) { holdKeys(input, mode.raceKeys(dt)); frame(); }
  input.dispose();
  assert.equal(gates, 20, '10 gates a lap, 2 laps');
  assert.deepEqual(mode.director.snapshot().history.map((h) => [h.id, h.progress]), [['race1', 2]]);
  assert.ok(ended && mode.raceState().done, 'the race ended the round'); // (a minute behind the field: its place is the race's verdict)
  assert.equal(mode.failure === STALLED, false);
});

test('the driver\'s keys: none during the countdown, the throttle on a straight, the brake in time for a bend', () => {
  const mode = trackMode(published('gm_2ceb5d2311'));
  mode.phase = 'playing';
  assert.deepEqual([...mode.raceKeys(1 / 30)], [], 'the countdown: hands off');
  mode.raceHold = 0;
  assert.ok(mode.raceKeys(1 / 30).has('KeyW'), 'GO: the throttle');
  // at the car's top speed 8 m before the tightest bend of the lap (31 m: 13.6 m/s at 6 m/s² sideways) it brakes; 40 m
  // before it there is room left to brake in, and at the bend's own speed nothing to brake for
  const { pts, m, step } = mode.raceLine, car = mode.activeCar.controller;
  const heading = (k) => { const a = mode.roadAt(k); return Math.atan2(a.fx, a.fz); };
  let tight = 0, most = 0;
  for (let k = 0; k < m; k++) {
    const turn = Math.abs(Math.atan2(Math.sin(heading((k + 3) % m) - heading(k)), Math.cos(heading((k + 3) % m) - heading(k))));
    if (turn > most) { most = turn; tight = k; }
  }
  const radius = 3 * step / most;
  const keysAt = (metres, speed) => {
    const k = (tight - Math.round(metres / step) + m) % m, way = mode.roadAt(k);
    Object.assign(car, { position: { x: pts[k].x, z: pts[k].z }, yaw: Math.atan2(-way.fx, -way.fz), speed });
    mode.botK = null;
    return mode.raceKeys(1 / 30);
  };
  assert.ok(radius > 25 && radius < 40, `the tightest bend: ${radius.toFixed(1)} m`);
  assert.ok(keysAt(8, 22).has('Space'), '22 m/s, 8 m before the bend: the brake');
  assert.ok(keysAt(40, 22).has('KeyW'), '40 m before it: still the throttle');
  assert.ok(!keysAt(8, 12).has('Space'), 'at the bend\'s speed: no brake');
  // a gate 30 m to the car's left: A until the wheels are turned for it; and with no road at all it makes for the gate
  const gate = mode.raceRoute[mode.director.raceNext], side = { x: gate.x + 30 * Math.cos(car.yaw), z: gate.z - 30 * Math.sin(car.yaw) };
  Object.assign(car, { position: side, yaw: car.yaw, speed: 5, steeringAngle: 0 });
  mode.raceLine = null;
  assert.deepEqual([...mode.raceKeys(1 / 30)].sort(), ['KeyA', 'KeyW']);
  mode.world.input.dispose();
});

// --- the city ---------------------------------------------------------------------------------------------------------

test('gm_1a22c1dc81 (a city race) under the built-in player: it stays in the car and drives the ring, 8 gates a lap for 3 laps', () => {
  const spec = published('gm_1a22c1dc81'), stage = spec.mission.stages[0];
  const mode = cityMode(spec);
  mode.offRoad = () => false; // a city has no road of its own to leave
  const r = race(mode);
  assert.notEqual(r.failure, STALLED, `the watchdog ended the round: ${say(r)}`);
  assert.equal(r.exits, 0, 'the hero never left the car');
  assert.equal(r.gates, stage.entityIds.length * stage.target, say(r));
  assert.ok(r.order && r.stop < 2, `in order, never held: stood still ${r.stop.toFixed(1)} s`);
  assert.deepEqual([r.reason, r.stalled], ['clear', false], say(r));
  assert.ok(r.seconds < spec.rules.timeLimitSec, `inside its 360 s: ${r.seconds} s`);
  assert.ok(r.stall < 5, `the watchdog's key stood still ${r.stall.toFixed(1)} s`);
});

test('a city drive stage under the built-in player: it walks to the stage\'s car, gets in, drives its metres and the mission goes on', () => {
  const { spec } = validateSpec(citySpec()), at = spec.mission.stages.findIndex((s) => s.type === 'drive');
  const mode = cityMode(spec, { stage: at });
  const r = playRound(mode, { seconds: 300 });
  assert.notEqual(r.failure, STALLED, JSON.stringify(r));
  const drive = r.mission.history.find((h) => h.id === 'drive');
  assert.ok(drive && drive.distanceMeters >= spec.mission.stages[at].distanceMeters, `the drive stage's 150 m: ${JSON.stringify(r.mission.history)}`);
  assert.equal(mode.enterCount, 1, 'it got into the car once');
  assert.deepEqual([r.reason, r.stalled], ['clear', false], 'and delivered on foot after it');
});

test('a drive stage counts its own car: in another one the built-in player gets out and walks to the right one', () => {
  const base = citySpec(); // its quest car at (0, 236), another car parked 14 m down the same street
  const { spec } = validateSpec({ ...base, world: { ...base.world, city: { ...base.world.city,
    vehicles: [{ id: 'other_car', kind: 'sedan', x: 4, z: 222, yaw: 0 }, ...base.world.city.vehicles] } } });
  const mode = cityMode(spec, { stage: spec.mission.stages.findIndex((s) => s.type === 'drive') });
  const other = mode.cars.find((c) => c.id === 'other_car');
  mode.activeCar = other; mode.enterCount = 1; // the hero sits in the wrong car
  const r = playRound(mode, { seconds: 300 });
  assert.ok(r.mission.history.some((h) => h.id === 'drive'), JSON.stringify(r));
  assert.equal(mode.exitCount >= 1 && mode.enterCount >= 2, true, 'out of the other car, into the quest car');
});
