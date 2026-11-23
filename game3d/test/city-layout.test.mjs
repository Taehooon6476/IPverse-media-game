import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cityPlan, districtAt, loopPose, patrolRoute, roadDistance, roundedLoop, SpatialGrid } from '../city-layout.js';
import { citySpec } from './fixtures/city-spec.mjs';

const boxes = (plan) => plan.buildings.map((b) => ({
  minX: b.x - b.width / 2, maxX: b.x + b.width / 2,
  minZ: b.z - b.depth / 2, maxZ: b.z + b.depth / 2,
}));

test('road axes describe travel direction, not the coordinate held constant', () => {
  assert.equal(roadDistance({ x: 900, z: 12 }, { axis: 'x', coordinate: 10 }), 2);
  assert.equal(roadDistance({ x: 12, z: -900 }, { axis: 'z', coordinate: 10 }), 2);
  const world = citySpec().world;
  const plan = cityPlan(world);
  assert.ok(plan.roadsX.every((r) => r.axis === 'z'));
  assert.ok(plan.roadsZ.every((r) => r.axis === 'x'));
  assert.deepEqual(plan.roadsX.map((r) => r.coordinate), [-192, 0, 192]);
});

test('same seed and city data reproduce the complete layout without input mutation', () => {
  const world = citySpec().world, before = structuredClone(world);
  const first = cityPlan(world);
  assert.deepEqual(cityPlan(structuredClone(world)), first);
  assert.deepEqual(world, before);
  const changed = cityPlan(citySpec({ seed: world.city.seed + 1 }).world);
  assert.notDeepEqual(changed.buildings, first.buildings);
  assert.deepEqual(changed.roadsX, first.roadsX);
  assert.deepEqual(changed.roadsZ, first.roadsZ);
});

test('city layouts scale across 300–1200m and keep complete footprints inside bounds', () => {
  let previous = 0;
  for (const size of [300, 450, 600, 900, 1200]) {
    const world = citySpec({ width: size }).world, plan = cityPlan(world);
    assert.ok(plan.buildings.length > previous, `${size}m must add usable city blocks`);
    previous = plan.buildings.length;
    assert.equal(new Set(plan.buildings.map((b) => b.id)).size, plan.buildings.length);
    for (const [i, b] of boxes(plan).entries()) {
      assert.ok(b.minX >= -size / 2 && b.maxX <= size / 2, `${size}: building ${i} x bounds`);
      assert.ok(b.minZ >= -size / 2 && b.maxZ <= size / 2, `${size}: building ${i} z bounds`);
    }
  }
});

test('rectangular worlds use depth for x-axis roads and width for z-axis roads', () => {
  const world = citySpec({ width: 1200, depth: 300 }).world;
  const plan = cityPlan(world);
  assert.ok(plan.buildings.length > 0);
  for (const b of boxes(plan)) {
    assert.ok(b.minX >= -600 && b.maxX <= 600);
    assert.ok(b.minZ >= -150 && b.maxZ <= 150);
  }
  assert.deepEqual(plan.roadsX.map((s) => s.coordinate), [-384, 0, 384]);
  assert.deepEqual(plan.roadsZ.map((s) => s.coordinate), [-96, 0, 96]);
});

test('building footprints never overlap carriageways, including mixed road widths', () => {
  for (const size of [300, 600, 1200]) {
    const world = citySpec({ width: size }).world;
    world.city.streets.forEach((s, i) => { s.width = [8, 16, 24][i % 3]; });
    for (const b of cityPlan(world).buildings) {
      for (const road of world.city.streets) {
        const halfFootprint = road.axis === 'x' ? b.depth / 2 : b.width / 2;
        assert.ok(roadDistance(b, road) - halfFootprint > road.width / 2,
          `${size}: ${b.id} encroaches on ${road.id}`);
      }
    }
  }
});

test('spawn and mission IP targets retain clearance when placed within city blocks', () => {
  const world = citySpec().world;
  const candidate = cityPlan(world).buildings.find((b) => b.x > 20 && b.z > 20);
  assert.ok(candidate);
  const locations = [
    ['spawn', null],
    ['npc', null],
    ['propPlacements', 'core'],
    ['enemySpawns', 'guard'],
    ['entities', 'delivery'],
  ];
  for (const [key, id] of locations) {
    const altered = structuredClone(world);
    const p = { id, x: candidate.x, z: candidate.z };
    if (key === 'entities') altered.entities = [{ ...p, kind: 'beacon' }];
    else if (['propPlacements', 'enemySpawns'].includes(key)) altered[key] = [p];
    else altered[key] = p;
    const plan = cityPlan(altered), grid = new SpatialGrid();
    boxes(plan).forEach((b) => grid.insert(b));
    assert.equal(grid.blocked(p.x, p.z, 4), false, key);
    assert.ok(plan.buildings.every((b) => Math.abs(b.x - p.x) >= 19 || Math.abs(b.z - p.z) >= 19), key);
  }
});

test('street furniture follows sidewalks, avoids intersections and guarded spawn targets', () => {
  const world = citySpec().world, plan = cityPlan(world);
  assert.ok(plan.props.length > 0);
  assert.equal(new Set(plan.props.map((p) => p.id)).size, plan.props.length);
  const exclusions = [world.spawn, world.npc, ...world.propPlacements, ...world.enemySpawns, ...world.entities];
  for (const p of plan.props) {
    const owner = world.city.streets.find((s) => Math.abs(roadDistance(p, s) - (s.width / 2 + 1.8)) < 1e-9);
    assert.ok(owner, p.id);
    assert.equal(p.category, 'streetlight');
    assert.ok(world.city.streets.filter((s) => s.axis !== owner.axis)
      .every((s) => roadDistance(p, s) >= s.width / 2 + 3), p.id);
    assert.ok(exclusions.every((e) => Math.hypot(e.x - p.x, e.z - p.z) >= 4), p.id);
  }
});

test('district lookup honors containing district before falling back to nearest center', () => {
  const city = citySpec().world.city;
  assert.equal(districtAt(city, -200, 0).id, 'west');
  assert.equal(districtAt(city, 0, 0).id, 'center');
  assert.equal(districtAt(city, 200, 0).id, 'east');
  assert.equal(districtAt(city, -200, 280).id, 'west');
  const plan = cityPlan(citySpec().world);
  for (const b of plan.buildings) {
    const district = districtAt(city, b.x, b.z);
    assert.equal(b.districtId, district.id);
    assert.equal(b.style, district.style);
    assert.ok(Number.isFinite(b.height) && b.height > 0);
  }
});

test('spatial lookup crosses positive, negative and zero cell boundaries without duplicate boxes', () => {
  const grid = new SpatialGrid(10);
  const spanning = { minX: -12, maxX: 12, minZ: -12, maxZ: 12 };
  grid.insert(spanning);
  assert.equal(grid.key(-.01, -.01), '-1,-1');
  assert.equal(grid.key(0, 0), '0,0');
  assert.equal(grid.key(-10, -10), '-1,-1');
  for (const [x, z] of [[-11, -11], [-.01, .01], [0, 0], [11, 11]]) {
    assert.deepEqual(grid.nearby(x, z, 15), [spanning]);
    assert.equal(grid.blocked(x, z, 1), true);
  }
  assert.deepEqual(grid.nearby(100, -100, 1), []);
});

test('circle collision rejects false positive corner hits and handles exact tangency', () => {
  for (const origin of [-20, 20]) {
    const grid = new SpatialGrid(10);
    grid.insert({ minX: origin, maxX: origin + 4, minZ: origin, maxZ: origin + 4 });
    assert.equal(grid.blocked(origin - .5, origin + 2, 1), true);
    assert.equal(grid.blocked(origin - 1, origin + 2, 1), false);
    assert.equal(grid.blocked(origin - .9, origin - .9, 1), false);
    assert.equal(grid.blocked(origin - .6, origin - .6, 1), true);
  }
});

test('collision resolution clears both embedded and edge-contact bodies in all quadrants', () => {
  for (const [x, z] of [[-40, -40], [-40, 40], [40, -40], [40, 40]]) {
    const grid = new SpatialGrid(16);
    grid.insert({ minX: x, maxX: x + 8, minZ: z, maxZ: z + 8 });
    for (const initial of [{ x: x + 4, z: z + 4 }, { x: x - .5, z: z + 4 }, { x: x - .4, z: z - .4 }]) {
      assert.equal(grid.blocked(initial.x, initial.z, 1), true);
      const p = { ...initial, y: 2 };
      assert.equal(grid.resolve(p, 1), p);
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.z));
      assert.equal(p.y, 2);
      assert.equal(grid.blocked(p.x, p.z, 1 - 1e-9), false);
    }
  }
});

test('full city collision records remain available far beyond a visible rendering chunk', () => {
  const plan = cityPlan(citySpec({ width: 1200 }).world), grid = new SpatialGrid(32);
  boxes(plan).forEach((b) => grid.insert(b));
  const distant = plan.buildings.find((b) => Math.abs(b.x) > 500 && Math.abs(b.z) > 400);
  assert.ok(distant);
  assert.equal(grid.blocked(distant.x, distant.z, 1.4), true);
  assert.equal(grid.blocked(0, 0, 1.4), false);
});

test('traffic lanes round every corner: the heading turns through an arc instead of snapping', () => {
  const corners = [{ x: -50, z: -50 }, { x: 50, z: -50 }, { x: 50, z: 50 }, { x: -50, z: 50 }];
  const loop = roundedLoop(corners, 7);
  const arc = 8 * 2 * 7 * Math.sin(Math.PI / 32);
  assert.ok(Math.abs(loop.total - (4 * (100 - 14) + 4 * arc)) < 1e-6, `length ${loop.total}`);
  let turned = 0, prev = loopPose(loop, 0), worstStep = 0, worstOffset = 0;
  const edge = (p) => Math.min(...corners.map((a, i) => {
    const b = corners[(i + 1) % 4], t = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.z - a.z) * (b.z - a.z)) / 100 ** 2));
    return Math.hypot(p.x - a.x - t * (b.x - a.x), p.z - a.z - t * (b.z - a.z));
  }));
  for (let s = .25; s <= loop.total + 1e-9; s += .25) {
    const pose = loopPose(loop, s), step = Math.atan2(Math.sin(pose.yaw - prev.yaw), Math.cos(pose.yaw - prev.yaw));
    worstStep = Math.max(worstStep, Math.abs(step)); turned += step; prev = pose;
    worstOffset = Math.max(worstOffset, edge(pose));
    assert.ok(Math.hypot(pose.x - loopPose(loop, s - .25).x, pose.z - loopPose(loop, s - .25).z) < .26, `no jump at ${s}`);
  }
  const back = loopPose(loop, loop.total); // close the lap
  turned += Math.atan2(Math.sin(back.yaw - prev.yaw), Math.cos(back.yaw - prev.yaw));
  assert.ok(worstStep < .2, `largest heading change per 25 cm: ${worstStep.toFixed(3)} rad`);
  assert.ok(Math.abs(Math.abs(turned) - 2 * Math.PI) < 1e-6, `one full turn per lap, ${turned}`);
  assert.ok(worstOffset < 3, `stays in its lane, ${worstOffset.toFixed(2)} m off at most`);
  const wrapped = loopPose(loop, loop.total + 3), again = loopPose(loop, 3);
  assert.ok(Math.abs(wrapped.x - again.x) < 1e-9 && Math.abs(wrapped.z - again.z) < 1e-9);
  // heading convention: yaw 0 faces -Z, as for every car
  const east = loopPose(loop, 20);
  assert.ok(Math.abs(Math.atan2(Math.sin(east.yaw + Math.PI / 2), Math.cos(east.yaw + Math.PI / 2))) < 1e-9, `driving +X has yaw -pi/2, ${east.yaw}`);
});

test('a street patrol runs along the street its spawn point stands on and stays inside the city', () => {
  const world = citySpec().world, streets = world.city.streets;
  const [a, b] = patrolRoute({ x: 40, z: 0 }, streets, world);
  assert.ok(a.z === 0 && b.z === 0 && a.x < 40 && b.x > 40 && b.x - a.x > 30, JSON.stringify([a, b]));
  const [c, d] = patrolRoute({ x: 194, z: -60 }, streets, world); // beside the x=192 street
  assert.ok(c.x === 194 && d.x === 194 && c.z < -60 && d.z > -60, JSON.stringify([c, d]));
  for (const p of patrolRoute({ x: 270, z: 0 }, streets, world))
    assert.ok(Math.abs(p.x) <= world.width / 2 - 20 && Math.abs(p.z) <= world.depth / 2 - 20, JSON.stringify(p));
});
