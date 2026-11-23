import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VehicleController, carOverlap, footprint } from '../city-controller.js';

const vehicle = (options = {}, adapters = {}) => new VehicleController({
  id: 'car', position: { x: 0, z: 0 }, ...options,
}, adapters);
function run(car, seconds, input, fps = 60) {
  for (let i = 0; i < Math.round(seconds * fps); i++) car.step(1 / fps, input);
  return car.stateSnapshot();
}

test('accelerates, rolls to a halt, and service braking never reverses the vehicle', () => {
  const coast = vehicle(), brake = vehicle();
  const moving = run(coast, 4, { throttle: 1 });
  run(brake, 4, { throttle: 1 });
  assert.ok(moving.speed > 20 && moving.speed <= 22);
  assert.ok(moving.position.z < -25 && moving.distance > 25);
  const coasting = run(coast, .5, {});
  const braking = run(brake, .5, { throttle: 1, brake: true });
  assert.ok(coasting.speed > braking.speed);
  const stopped = run(brake, 2, { brake: true });
  assert.equal(stopped.speed, 0);
  const parkedDistance = stopped.distance;
  run(brake, 1, { brake: true });
  assert.equal(brake.stateSnapshot().distance, parkedDistance);
  assert.equal(run(coast, 25, {}).speed, 0);
});

test('reverse input brakes forward motion first and reverses at a bounded speed', () => {
  const car = vehicle();
  run(car, 1, { throttle: 1 });
  assert.ok(car.step(1 / 120, { throttle: -1 }).speed > 0);
  const reversed = run(car, 4, { throttle: -1 });
  assert.ok(reversed.speed < -5 && reversed.speed >= -6.5);
  const before = reversed.position.z;
  run(car, 1, { throttle: -1 });
  assert.ok(car.stateSnapshot().position.z > before);
});

test('steering turns according to motion, stays finite at speed, and cannot rotate a parked car', () => {
  const parked = vehicle();
  const parkedState = run(parked, 2, { steer: 1 });
  assert.equal(parkedState.yaw, 0);
  assert.equal(parkedState.distance, 0);
  assert.ok(parkedState.steeringAngle > .5);
  const forward = vehicle();
  const f = run(forward, 2, { throttle: 1, steer: 1 });
  assert.ok(f.yaw < 0 && f.position.x > 0);
  const reverse = vehicle();
  const r = run(reverse, 2, { throttle: -1, steer: 1 });
  assert.ok(r.yaw > 0 && r.position.x > 0);
  const fast = vehicle();
  run(fast, 5, { throttle: 1 });
  const turning = run(fast, .5, { throttle: 1, steer: 1 });
  assert.ok(turning.steeringAngle < .1);
  assert.ok(Number.isFinite(turning.yaw));
});

test('fixed substeps keep throttle/steering outcomes consistent across normal frame rates', () => {
  const states = [20, 30, 60, 120].map((fps) => {
    const car = vehicle();
    run(car, 3, { throttle: 1 }, fps);
    run(car, 2, { throttle: 1, steer: .7 }, fps);
    return run(car, 1, { brake: true, steer: -.5 }, fps);
  });
  for (const state of states.slice(1)) {
    for (const key of ['speed', 'yaw', 'distance', 'wheelRotation'])
      assert.ok(Math.abs(state[key] - states[0][key]) < 1e-8, key);
    assert.ok(Math.hypot(state.position.x - states[0].position.x, state.position.z - states[0].position.z) < 1e-8);
  }
});

test('swept checks stop a fast vehicle at a thin wall and count only accepted travel', () => {
  let previous;
  const car = vehicle({ collisionRadius: .1, maxSpeed: 60, acceleration: 40 }, {
    collide: (p, radius, from) => {
      assert.ok(Math.hypot(p.x - from.x, p.z - from.z) <= .180001);
      previous = from;
      return p.z - radius < -15;
    },
  });
  const state = run(car, 2, { throttle: 1 }, 20);
  assert.ok(state.collided);
  assert.equal(state.speed, 0);
  assert.ok(state.position.z >= -14.900001);
  assert.ok(state.distance <= 14.900001);
  assert.ok(Math.abs(state.distance + state.position.z) < 1e-8);
  assert.ok(previous.z >= -14.900001);
  const frozenDistance = state.distance;
  run(car, 1, { throttle: 1 });
  assert.ok(car.stateSnapshot().distance <= frozenDistance + .02);
});

test('bounds and adjusted-position adapters resolve contact without counting a teleport', () => {
  const bounded = vehicle({ collisionRadius: .5 }, {
    clampBounds: (p, radius) => ({ x: p.x, z: Math.max(-5 + radius, p.z) }),
  });
  const state = run(bounded, 3, { throttle: 1 });
  assert.ok(state.position.z >= -4.5);
  assert.ok(state.distance <= 4.5 + 1e-8);
  const invalidCorrection = vehicle({}, {
    collide: () => ({ x: 100, z: -100 }),
  });
  const rejected = run(invalidCorrection, 1, { throttle: 1 });
  assert.equal(rejected.distance, 0);
  assert.deepEqual(rejected.position, { x: 0, z: 0 });
  assert.equal(rejected.speed, 0);
});

test('safe exits test the player footprint, reject blocked or out-of-bounds sides, and require a slow car', () => {
  const car = vehicle({}, {
    collide: (p, radius) => p.x - radius < -1,
    clampBounds: (p, radius) => ({ x: Math.min(2.5 - radius, p.x), z: p.z }),
  });
  const exits = car.getExitCandidates();
  assert.deepEqual(exits.map((e) => e.side), ['rear', 'front']);
  assert.ok(car.canExit());
  assert.equal(car.canExit({ isBlocked: () => true }), false);
  const fast = vehicle();
  run(fast, 1, { throttle: 1 });
  assert.equal(fast.canExit(), false);
  run(fast, 1, { brake: true });
  assert.equal(fast.canExit(), true);
});

test('snapshots and collision adapter arguments cannot mutate the live controller position', () => {
  const original = { x: 0, z: 0 };
  const car = vehicle({ position: original }, {
    collide: (_candidate, _radius, previous) => { previous.x = 999; return false; },
  });
  original.x = 400;
  const snapshot = car.step(.1, { throttle: 1 });
  snapshot.position.x = 900;
  assert.equal(car.stateSnapshot().position.x, 0);
  assert.ok(car.stateSnapshot().distance > 0);
});

test('wheel motion uses accepted signed travel, while large hitches have explicit capped simulation time', () => {
  const car = vehicle({ wheelRadius: .5 });
  const forward = run(car, .5, { throttle: 1 });
  const expected = Math.atan2(Math.sin(forward.distance / .5), Math.cos(forward.distance / .5));
  assert.ok(Math.abs(forward.wheelRotation - expected) < 1e-8);
  const hitch = vehicle().step(2, { throttle: 1 });
  assert.ok(Math.abs(hitch.simulatedSeconds - .25) < 1e-8);
  assert.equal(hitch.droppedSeconds, 1.75);
  assert.ok(hitch.distance < 1);
});

test('invalid coordinates, time and input fail explicitly instead of propagating NaN', () => {
  assert.throws(() => vehicle({ position: { x: NaN, z: 0 } }), /position/);
  assert.throws(() => vehicle().step(NaN), /dt/);
  assert.throws(() => vehicle().step(-.1), /dt/);
  assert.throws(() => vehicle().step(.1, { steer: Infinity }), /finite/);
});

// ---- car-to-car contact: other cars are capsules the car slides off, never a wall it sticks to
const parkedAt = (x, z, yaw = 0, id = 'other') => ({ id, x, z, yaw, length: 4.4, width: 1.9 });
const depthTo = (car, others) => Math.max(...others.map((o) => carOverlap(footprint({ ...car.stateSnapshot().position,
  yaw: car.stateSnapshot().yaw, length: 4.4, width: 1.9 }), footprint(o)).depth));

test('car footprints are capsules: side by side, nose to tail, crossed and apart', () => {
  const side = carOverlap(footprint(parkedAt(0, 0)), footprint(parkedAt(1.5, 0)));
  assert.ok(Math.abs(side.depth - .4) < 1e-9 && Math.abs(side.nx + 1) < 1e-9 && Math.abs(side.nz) < 1e-9, JSON.stringify(side));
  const tail = carOverlap(footprint(parkedAt(0, 0)), footprint(parkedAt(0, -4)));
  assert.ok(Math.abs(tail.depth - .4) < 1e-9 && Math.abs(tail.nz - 1) < 1e-9, JSON.stringify(tail)); // pushed back, +Z
  assert.ok(carOverlap(footprint(parkedAt(0, 0)), footprint(parkedAt(0, -4.5))).depth < 0);
  assert.ok(carOverlap(footprint(parkedAt(0, 0)), footprint(parkedAt(2.1, 0))).depth < 0);
  const crossed = carOverlap(footprint(parkedAt(0, 0)), footprint(parkedAt(0, 0, Math.PI / 2)));
  assert.ok(crossed.depth > 1.8 && Math.abs(Math.hypot(crossed.nx, crossed.nz) - 1) < 1e-9, JSON.stringify(crossed));
});

test('a car never drives into another car: a head-on hit stops it, and reversing and steering always get it past', () => {
  const others = [parkedAt(0, -14)];
  const car = vehicle({}, { cars: () => others });
  let deepest = 0;
  for (let i = 0; i < 180; i++) { car.step(1 / 60, { throttle: 1 }); deepest = Math.max(deepest, depthTo(car, others)); }
  const stopped = car.stateSnapshot();
  assert.ok(stopped.position.z > -14 + 4.4 - .05, `stopped at the other car's tail, z ${stopped.position.z}`);
  assert.ok(Math.abs(stopped.speed) < 1, `a head-on hit leaves no speed, ${stopped.speed}`);
  assert.ok(deepest < .02, `never deeper than contact, ${deepest}`);
  // back off with the wheel turned, then drive round it: the stopped car is an obstacle, not a trap
  run(car, 1.2, { throttle: -1, steer: -1 });
  for (let i = 0; i < 60 * 6 && car.stateSnapshot().position.z > -20; i++) {
    car.step(1 / 60, { throttle: 1, steer: car.stateSnapshot().position.x < 2.4 ? 1 : -1 });
    deepest = Math.max(deepest, depthTo(car, others));
  }
  assert.ok(car.stateSnapshot().position.z < -20, `got past the stopped car, ${JSON.stringify(car.stateSnapshot().position)}`);
  assert.ok(deepest < .02, `never drove into it, ${deepest}`);
});

test('a glancing contact slides along the other car with a speed loss instead of a dead stop', () => {
  const others = [parkedAt(1.6, -30)];
  const car = vehicle({}, { cars: () => others });
  run(car, 2.5, { throttle: 1 });
  const before = car.stateSnapshot().speed;
  let slowest = Infinity, contact = false, deepest = 0;
  for (let i = 0; i < 600 && car.stateSnapshot().position.z > -40; i++) {
    const s = car.step(1 / 60, { throttle: 0 });
    slowest = Math.min(slowest, s.speed); contact ||= s.contacts.includes('other');
    deepest = Math.max(deepest, depthTo(car, others));
  }
  assert.ok(contact, 'the contact is reported');
  assert.ok(slowest < before - .3 && slowest > before * .5, `speed ${before.toFixed(2)} -> ${slowest.toFixed(2)}`);
  assert.ok(car.stateSnapshot().position.x < -.05, 'pushed aside, away from the other car');
  assert.ok(deepest < .02, `never deeper than contact, ${deepest}`);
});

test('an overlap the other car caused never pins this car: it can drive on, back off or turn away', () => {
  for (const input of [{ throttle: 1 }, { throttle: -1 }, { throttle: 1, steer: -1 }]) {
    const others = [parkedAt(1.2, 0)]; // a rival pushed into its side
    const car = vehicle({}, { cars: () => others });
    const start = depthTo(car, others);
    let worst = start;
    for (let i = 0; i < 120; i++) { car.step(1 / 60, input); worst = Math.max(worst, depthTo(car, others)); }
    assert.ok(car.stateSnapshot().distance > 1.5, `moved with ${JSON.stringify(input)}: ${car.stateSnapshot().distance}`);
    assert.ok(worst <= start + 1e-6, `never deeper than the overlap it was given, ${start} -> ${worst}`);
  }
});

test('car contact keeps walls and bounds authoritative and needs no adapter by default', () => {
  const walled = vehicle({}, { collide: (p, radius) => p.z - radius < -8, cars: () => [parkedAt(9, -50)] });
  const s = run(walled, 3, { throttle: 1 });
  assert.ok(s.position.z >= -5.75 - 1e-6 && s.speed === 0);
  assert.deepEqual(vehicle().step(.1, { throttle: 1 }).contacts, []);
});
