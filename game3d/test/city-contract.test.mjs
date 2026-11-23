import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSpec } from '../gamespec3d.js';
import { citySpec } from './fixtures/city-spec.mjs';

function rejects(change, reason) {
  const spec = citySpec();
  change(spec);
  const result = validateSpec(spec);
  assert.equal(result.ok, false, `accepted invalid city: ${reason}`);
  assert.ok(result.errors.some((e) => e.includes(reason)), result.errors.join('; '));
}

test('city fixtures at both supported bounds and rectangular extents preserve their selected IP roles', () => {
  for (const dimensions of [{ width: 300 }, { width: 1200 }, { width: 1200, depth: 300 }]) {
    const spec = citySpec(dimensions), before = structuredClone(spec);
    const result = validateSpec(spec);
    assert.equal(result.ok, true, result.errors?.join('; '));
    assert.deepEqual(spec, before);
    assert.equal(result.spec.props[result.spec.world.npc.propIndex].ipId, 'ip_guide');
    assert.equal(result.spec.world.city.pedestrians[0].propIndex, result.spec.world.npc.propIndex);
    assert.equal(result.spec.mission.stages[2].entityIds[0], result.spec.world.city.vehicles[0].id);
  }
});

test('city rejects unsupported asset URLs, executable fields and corrupt numerical values', () => {
  for (const [key, value] of [['assetUrl', 'https://foreign.invalid/city.glb'], ['script', 'alert(1)']])
    rejects((s) => { s.world.city[key] = value; }, 'unsupported fields');
  for (const value of [NaN, Infinity, true, '16'])
    rejects((s) => { s.world.city.streets[0].width = value; }, 'width');
  for (const value of [-1, 2147483648, .5, true])
    rejects((s) => { s.world.city.seed = value; }, 'seed');
  for (const value of [-1, 17, .5, true])
    rejects((s) => { s.world.city.trafficCount = value; }, 'trafficCount');
});

test('road graph needs both axes, interior clearance and usable gaps between parallel streets', () => {
  rejects((s) => { s.world.city.streets.forEach((r) => { r.axis = 'x'; }); }, 'two z streets');
  rejects((s) => { s.world.city.streets[0].coordinate = 280; }, 'fit inside world');
  rejects((s) => { s.world.city.streets[1].coordinate = s.world.city.streets[0].coordinate + 20; }, 'block between');
  rejects((s) => { s.world.city.streets[0].axis = 'y'; }, 'axis');
});

test('districts fit the declared world and cannot substitute unsupported scene styles', () => {
  rejects((s) => { s.world.city.districts[0].width = 601; }, '80-600');
  rejects((s) => { s.world.city.districts[0].x = -280; }, 'fit inside world');
  rejects((s) => { s.world.city.districts[0].style = 'download-scene'; }, 'style');
  rejects((s) => { s.world.city.districts[0].modelUrl = 'elsewhere.glb'; }, 'unsupported fields');
});

test('parked vehicles must remain on roads and within world and yaw bounds', () => {
  rejects((s) => { Object.assign(s.world.city.vehicles[0], { x: 70, z: 70 }); }, 'on a road');
  rejects((s) => { s.world.city.vehicles[0].kind = 'aircraft'; }, 'kind');
  rejects((s) => { s.world.city.vehicles[0].yaw = Math.PI + .01; }, 'yaw');
  rejects((s) => { s.world.city.vehicles[0].x = 600; }, 'world bounds');
});

test('pedestrian routes use the selected NPC, follow connected streets and return without diagonal shortcuts', () => {
  rejects((s) => { s.world.city.pedestrians[0].propIndex = 0; }, 'selected NPC');
  rejects((s) => { delete s.world.npc.propIndex; }, 'selected NPC');
  rejects((s) => { s.world.city.pedestrians[0].route = [{ x: -12, z: 96 }, { x: -12, z: 96 }]; }, 'distinct');
  rejects((s) => { s.world.city.pedestrians[0].route = [{ x: -12, z: 96 }, { x: 192, z: 0 }]; }, 'connected roads');
  rejects((s) => { s.world.city.pedestrians[0].route[1].z = 600; }, 'world bounds');
  rejects((s) => { s.world.city.pedestrians[0].route[1].script = 'run()'; }, 'unsupported fields');
});

test('malformed model-written route values return validation errors without throwing', () => {
  for (const route of [1, {}, 'not-a-route', null, [null, null]]) {
    const spec = citySpec();
    spec.world.city.pedestrians[0].route = route;
    let result;
    assert.doesNotThrow(() => { result = validateSpec(spec); }, `route ${JSON.stringify(route)}`);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes('route')));
  }
});

test('mission and city identifiers share a single namespace', () => {
  for (const list of ['districts', 'streets', 'vehicles', 'pedestrians'])
    rejects((s) => { s.world.city[list][0].id = s.world.npc.id; }, 'unique identifier');
});

test('drive stages bind exactly one declared vehicle and bounded travel rather than elapsed time', () => {
  rejects((s) => { s.mission.stages[2].entityIds = ['guide']; }, 'reference one vehicle');
  rejects((s) => { s.mission.stages[2].entityIds = ['quest_car', 'walker']; }, 'reference one vehicle');
  rejects((s) => { delete s.mission.stages[2].distanceMeters; }, 'distanceMeters');
  for (const distance of [19, 1501, NaN, true])
    rejects((s) => { s.mission.stages[2].distanceMeters = distance; }, 'distanceMeters');
  for (const key of ['holdSec', 'propIndex', 'enemyIndex'])
    rejects((s) => { s.mission.stages[2][key] = 1; }, 'cannot include');
  rejects((s) => { s.mission.stages[0].distanceMeters = 50; }, 'only for drive');
});

test('mission targets must exist and selected-IP collection counts remain achievable', () => {
  rejects((s) => { s.mission.stages[3].entityIds = ['missing_delivery']; }, 'world targets');
  rejects((s) => { s.mission.stages[1].target = 2; }, 'collect target');
  const spec = citySpec();
  spec.mission.stages[0].entityIds = ['walker'];
  const result = validateSpec(spec);
  assert.equal(result.ok, true, result.errors?.join('; '));
});

test('city spawn must remain reachable from the declared streets', () => {
  rejects((s) => { s.world.spawn = { x: 70, z: 70 }; }, 'spawn must be on a road');
});

test('city mission beacons must remain reachable from streets or sidewalks', () => {
  rejects((s) => { Object.assign(s.world.entities[0], { x: 70, z: 70 }); }, 'mission target');
});

test('solid authored landmarks cannot block roads or a pedestrian route', () => {
  rejects((s) => {
    s.world.entities.push({ id: 'road_wall', kind: 'box', x: 0, z: 100, width: 10, depth: 10, height: 5 });
  }, 'block a city road');
  rejects((s) => {
    s.world.entities.push({ id: 'sidewalk_wall', kind: 'box', x: -14, z: 140, width: 5, depth: 4, height: 4 });
  }, 'route overlaps solid geometry');
});

const carBodyEntity = (s, extra = {}) => {
  const v = s.world.city.vehicles[0];
  s.world.entities.push({ id: 'ray_car', kind: 'model', ipId: 'ip_car', car: 'player', x: v.x, z: v.z, solid: false,
    modelUrl: 'assets/ip_car.set.glb', ...extra });
  v.modelId = 'ray_car';
};

test('a city vehicle can drive as the selected IP car: modelId names a car-body model entity', () => {
  const spec = citySpec();
  carBodyEntity(spec);
  const result = validateSpec(spec);
  assert.equal(result.ok, true, result.errors?.join('; '));
  assert.equal(result.spec.world.city.vehicles[0].modelId, 'ray_car');
  rejects((s) => { carBodyEntity(s); s.world.city.vehicles[0].modelId = 'missing_car'; }, 'modelId');
  rejects((s) => { s.world.city.vehicles[0].modelId = 'delivery'; }, 'modelId'); // a beacon is not a car body
  rejects((s) => { carBodyEntity(s, { car: undefined }); }, 'modelId'); // a static set piece is not a car body
  rejects((s) => { carBodyEntity(s); s.world.city.vehicles[0].modelId = 7; }, 'modelId');
});

test('a city can take the selected background image as its sky', () => {
  const spec = citySpec();
  spec.world.background = { ipId: 'ip_neon_street', mode: 'image', rotation: 0, imageUrl: 'assets/ip_neon_street.background.png' };
  const result = validateSpec(spec);
  assert.equal(result.ok, true, result.errors?.join('; '));
  assert.equal(result.spec.world.background.mode, 'image');
});
