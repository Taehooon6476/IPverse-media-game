import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MissionDirector } from '../mission.js';

test('race counts a lap only after every checkpoint in order, and only while driving', () => {
  const cps = [{ id: 'a', x: 0, z: 100 }, { id: 'b', x: 100, z: 0 }, { id: 'c', x: 0, z: -100 }];
  const d = new MissionDirector({ stages: [{ id: 'race', type: 'race', target: 2, entityIds: ['a', 'b', 'c'] }] });
  const at = (p, driving = true) => d.update(.016, { position: p, targets: cps, driving });
  at(cps[1]); assert.equal(d.snapshot().checkpoint, 0); // b before a does not count
  at(cps[0], false); assert.equal(d.snapshot().checkpoint, 0); // on foot
  at(cps[0]); at(cps[1]); at(cps[2]);
  assert.deepEqual([d.snapshot().progress, d.snapshot().checkpoint], [1, 0]);
  at(cps[0]); at(cps[1]); assert.equal(d.completed, false);
  assert.equal(at(cps[2]).id, 'race'); assert.equal(d.completed, true);
});

test('a raised reach goal counts on its level, and a vehicle goal only while driving', () => {
  const flag = { id: 'flag', x: 0, z: 0, y: 7.6, radius: 2 };
  const d = new MissionDirector({ stages: [{ id: 'top', type: 'reach', target: 1, entityIds: ['flag'], holdSec: 0 }] });
  d.update(.1, { position: { x: 0, y: 0, z: 0 }, targets: [flag] });
  assert.equal(d.completed, false); // under it on the ground
  d.update(.1, { position: { x: 0, y: 7.6, z: 0 }, targets: [flag] });
  assert.equal(d.completed, true);
  const gate = { id: 'dock', x: 0, z: 0, radius: 6 };
  const car = new MissionDirector({ stages: [{ id: 'arrive', type: 'reach', target: 1, entityIds: ['dock'], holdSec: 0, vehicle: true }] });
  car.update(.1, { position: { x: 0, y: 0, z: 0 }, targets: [gate], driving: false });
  assert.equal(car.completed, false);
  car.update(.1, { position: { x: 0, y: 0, z: 0 }, targets: [gate], driving: true });
  assert.equal(car.completed, true);
});

test('a pickup target counts when the mode has taken it, not by passing under it', () => {
  const coin = { id: 'coin', x: 0, z: 0, pickup: true };
  const d = new MissionDirector({ stages: [{ id: 'coins', type: 'reach', target: 1, entityIds: ['coin'] }] });
  d.update(.016, { position: { x: 0, z: 0 }, targets: [coin] });
  assert.equal(d.completed, false);
  coin.taken = true;
  d.update(.016, { position: { x: 30, z: 0 }, targets: [coin] });
  assert.equal(d.completed, true);
});

test('drive measures positive accepted movement of the specified car in the active stage', () => {
  const d = new MissionDirector({ stages: [
    { id: 'core', type: 'collect', target: 1, entityIds: ['core'] },
    { id: 'road', type: 'drive', target: 1, entityIds: ['car'], distanceMeters: 140 },
    { id: 'finish', type: 'reach', target: 1, entityIds: ['gate'] },
  ] });
  assert.equal(d.record({ type: 'drive', entityId: 'car', distanceMeters: 300 }), false);
  d.record({ type: 'collect', entityId: 'core' }); d.update(.01);
  for (const distanceMeters of [0, -1, NaN, Infinity]) assert.equal(d.record({ type: 'drive', entityId: 'car', distanceMeters }), false);
  assert.equal(d.record({ type: 'drive', entityId: 'other-car', distanceMeters: 300 }), false);
  d.update(100, { position: { x: 500, z: 0 } });
  assert.equal(d.snapshot().distanceMeters, 0);
  d.record({ type: 'drive', entityId: 'car', distanceMeters: 139 }); d.update(.01);
  assert.equal(d.stage.id, 'road');
  d.record({ type: 'drive', entityId: 'car', distanceMeters: 1 }); d.update(.01);
  assert.equal(d.stage.id, 'finish');
  assert.equal(d.history[1].distanceMeters, 140);
  assert.equal(d.driveDistance, 0);
  assert.equal(d.record({ type: 'drive', entityId: 'car', distanceMeters: 100 }), false);
});

test('future and wrong-IP events cannot complete the active stage', () => {
  const d = new MissionDirector({ stages: [
    { id: 'collect', type: 'collect', target: 1, entityIds: ['key'], propIndex: 0 },
    { id: 'fight', type: 'kills', target: 1, entityIds: ['guard'] },
  ] });
  assert.equal(d.record({ type: 'kills', entityId: 'guard' }), false);
  assert.equal(d.record({ type: 'collect', entityId: 'key', propIndex: 1 }), false);
  assert.equal(d.record({ type: 'collect', entityId: 'other', propIndex: 0 }), false);
  assert.equal(d.record({ type: 'collect', entityId: 'key', propIndex: 0 }), true);
  assert.equal(d.record({ type: 'collect', entityId: 'key', propIndex: 0 }), false);
  d.update(.01);
  assert.equal(d.stage.id, 'fight');
  assert.equal(d.progress, 0);
  d.record({ type: 'kills', entityId: 'guard' }); d.update(.01);
  assert.equal(d.completed, true);
  assert.deepEqual(d.history.map((s) => s.id), ['collect', 'fight']);
});

test('interacting requires actual proximity and the complete held duration', () => {
  const d = new MissionDirector({ stages: [{ id: 'hack', type: 'interact', target: 1, entityIds: ['terminal'], holdSec: 1 }] });
  const targets = [{ id: 'terminal', x: 10, z: 0, radius: 2 }];
  d.update(2, { position: { x: 0, z: 0 }, targets, interacting: true });
  assert.equal(d.completed, false);
  d.update(.6, { position: { x: 10, z: 0 }, targets, interacting: true });
  assert.equal(d.completed, false);
  d.update(.1, { position: { x: 10, z: 0 }, targets, interacting: false });
  d.update(.6, { position: { x: 10, z: 0 }, targets, interacting: true });
  assert.equal(d.completed, false);
  d.update(.4, { position: { x: 10, z: 0 }, targets, interacting: true });
  assert.equal(d.completed, true);
});

test('survival counts its stage duration and reach hold resets outside the target', () => {
  const d = new MissionDirector({ stages: [
    { id: 'wait', type: 'survive', target: 2 },
    { id: 'exit', type: 'reach', target: 1, entityIds: ['gate'], holdSec: .5 },
  ] });
  d.update(1.5); assert.equal(d.stage.id, 'wait');
  d.update(.5); assert.equal(d.stage.id, 'exit');
  const targets = [{ id: 'gate', x: 0, z: 0 }];
  d.update(.3, { position: { x: 0, z: 0 }, targets });
  d.update(.3, { position: { x: 8, z: 0 }, targets });
  d.update(.3, { position: { x: 0, z: 0 }, targets });
  assert.equal(d.completed, false);
  d.update(.2, { position: { x: 0, z: 0 }, targets });
  assert.equal(d.completed, true);
});

test('talk events preserve the actual NPC IP index and reject a different or missing IP', () => {
  const d = new MissionDirector({ stages: [{
    id: 'talk_kai', type: 'talk', target: 1, entityIds: ['npc_kai'], propIndex: 1,
  }] });
  const position = { x: -19.51, z: 25.19 };
  const npc = { id: 'npc_kai', x: -20, z: 25, radius: 3 };
  d.update(.02, { position, targets: [{ ...npc, propIndex: 0 }], interacting: true });
  assert.equal(d.completed, false);
  d.update(.02, { position, targets: [npc], interacting: true });
  assert.equal(d.completed, false);
  d.update(.02, { position, targets: [{ ...npc, propIndex: 1 }], interacting: false });
  assert.equal(d.completed, false);
  d.update(.02, { position, targets: [{ ...npc, propIndex: 1 }], interacting: true });
  assert.equal(d.completed, true);
  assert.deepEqual(d.history.map((s) => s.id), ['talk_kai']);
});

test('a checkpoint resumes at the reached stage: earlier stages are done, later ones still run in order', () => {
  const stages = [
    { id: 'hall', type: 'kills', target: 1, entityIds: ['a'] },
    { id: 'loot', type: 'collect', target: 1, entityIds: ['p'] },
    { id: 'boss', type: 'boss', target: 1, entityIds: ['b'] },
  ];
  const d = new MissionDirector({ stages }, { startAt: 2 });
  assert.equal(d.stage.id, 'boss');
  assert.equal(d.snapshot().stageIndex, 2);
  assert.equal(d.record({ type: 'kills', entityId: 'a' }), false); // a passed stage does not count again
  assert.equal(d.record({ type: 'boss', entityId: 'b' }), true);
  assert.equal(d.update(.01).id, 'boss');
  assert.equal(d.completed, true);
  for (const startAt of [-3, 99, NaN]) assert.equal(new MissionDirector({ stages }, { startAt }).index, startAt > 2 ? 2 : 0);
});

test('held target interaction forwards both role indices without bypassing either filter', () => {
  const d = new MissionDirector({ stages: [{
    id: 'identify', type: 'interact', target: 1, entityIds: ['target'],
    propIndex: 0, enemyIndex: 1, holdSec: .5,
  }] });
  const position = { x: 0, z: 0 };
  const target = { id: 'target', x: 0, z: 0, radius: 2, propIndex: 0 };
  d.update(.5, { position, targets: [{ ...target, enemyIndex: 0 }], interacting: true });
  assert.equal(d.completed, false);
  d.update(.1, { position, targets: [{ ...target, enemyIndex: 1 }], interacting: false });
  d.update(.2, { position, targets: [{ ...target, enemyIndex: 1 }], interacting: true });
  assert.equal(d.completed, false);
  d.update(.3, { position, targets: [{ ...target, enemyIndex: 1 }], interacting: true });
  assert.equal(d.completed, true);
});
