import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THREE, AuthoredMode, cityMode, published, validateSpec } from './fixtures/headless.mjs';
import { citySpec } from './fixtures/city-spec.mjs';
import { MissionDirector } from '../mission.js';
import { clearOf } from '../arpg-data.js';

// The goal arrow:
// - a kills or boss stage points at the enemies that count once none is near (the others may stand past the 32 m
//   they come from).
// - a city stage done by car, on foot: it points at the car to take, not the address, and never over the dialogue box.

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
/** An authored mode in play on these stages (goal-arrow.test.mjs), the hero at `at`, with these enemies alive. */
function mode(stages, { at = { x: 0, z: 0 }, enemies = [], targets = [] } = {}) {
  return Object.assign(Object.create(AuthoredMode.prototype), { phase: 'playing', director: new MissionDirector({ stages }),
    targets, enemies, player: { pos: { ...at } }, world: { rig: { yaw: 0 } } });
}
const foe = (id, x, z, more = {}) => ({ id, enemyIndex: 0, pos: new THREE.Vector3(x, 0, z), hp: 3, ...more });
/** The arrow this frame: null when hidden, else what its label names, the metres on it and its bearing on screen. */
function arrow(m) {
  m.pointToGoal(m.director.stage);
  const a = m.goalArrow, label = a.firstChild;
  if (a.hidden) return null;
  const [, word, metres] = /^➤ (?:(\S+) )?(\d+)m$/.exec(label.textContent) ?? [];
  assert.ok(metres, `the label reads '${label.textContent}'`);
  return { word: word ?? '', metres: Number(metres), bearing: Math.atan2(parseFloat(label.style.left), -parseFloat(label.style.top)) };
}
/** Whether the arrow shown points at the place t, by its distance and its bearing from the camera. */
function names(m, shown, t) {
  const p = m.player.pos;
  return shown.metres === Math.round(Math.hypot(t.x - p.x, t.z - p.z))
    && Math.abs(wrap(shown.bearing - Math.atan2(t.x - p.x, -(t.z - p.z)) - m.world.rig.yaw)) < 1e-6;
}

test('a kills stage: the arrow names the nearest enemy that counts for it, once none of them is in the fight', () => {
  // an ARPG's first room: four soldiers dead, the hero in the far corner
  const stage = { id: 'clear_room1', type: 'kills', label: '첫 번째 방의 해골 병사를 처치하라', target: 6, enemyIndex: 0,
    entityIds: ['sk1_a', 'sk1_b', 'sk1_c', 'sk1_d', 'sk1_e', 'sk1_f'] };
  const far = foe('sk1_b', 35, -45), farther = foe('sk1_d', 35, -30); // 91 m and 93 m from that corner
  const m = mode([stage], { at: { x: -55, z: -55 }, enemies: [farther, far,
    foe('sk1_a~1', -40, -50, { packMate: true }), // a pack mate nearby: its kill is XP, not the stage's count
    foe('wr2_a', -50, -40, { enemyIndex: 1 })] }); // another stage's enemy
  m.director.progress = 4;
  const shown = arrow(m);
  assert.ok(shown, 'no arrow on a kills stage: "(4/6)" and nothing to follow');
  assert.equal(shown.word, '적');
  assert.ok(names(m, shown, far.pos), `it points at the nearest soldier of the stage: ${JSON.stringify(shown)}`);
  // one of them near enough to fight: nothing to point at
  Object.assign(m.player.pos, { x: 27, z: -24 });
  assert.equal(arrow(m), null);
  // the stage's enemies all dead (the next ones not up yet): no arrow, and no error
  m.enemies = m.enemies.filter((e) => e.packMate);
  Object.assign(m.player.pos, { x: -55, z: -55 });
  assert.equal(arrow(m), null);
  // a stage that names no enemies counts any of them
  const any = mode([{ id: 's', type: 'kills', label: '적을 처치하라', target: 3 }], { enemies: [foe('e1', 0, -40), foe('e2', 30, 0)] });
  assert.ok(names(any, arrow(any), { x: 30, z: 0 }));
});

test('a boss stage: the arrow names the boss, not its minions', () => {
  const stage = { id: 'boss_king', type: 'boss', label: '해골 왕을 쓰러뜨려라', target: 1, entityIds: ['king_spawn'], enemyIndex: 2 };
  const king = foe('king_spawn', 0, 48, { enemyIndex: 2, boss: true });
  const m = mode([stage], { at: { x: -30, z: 20 }, enemies: [foe('king_spawn~rage0', -20, 22, { minion: true }), king] });
  const shown = arrow(m);
  assert.ok(shown && names(m, shown, king.pos), JSON.stringify(shown));
  assert.equal(shown.word, '보스');
});

test('city gm_7a41fcae9e: on foot in a stage done by car the arrow names the car; in the car, the address', () => {
  const m = cityMode(published('gm_7a41fcae9e'), { autoplay: false, stage: 1 });
  m.phase = 'playing';
  const van = m.cars.find((c) => c.id === 'van1').group.position, address = m.targets.find((t) => t.id === 'addrBeacon1');
  m.player.pos.set(-74, 0, 10); // at the NPC, where the stage begins
  const walking = arrow(m);
  assert.ok(walking, 'no arrow');
  assert.ok(names(m, walking, van), `on foot it reads '➤ ${walking.word} ${walking.metres}m' (the address is ${Math.round(Math.hypot(address.x + 74, address.z - 10))} m away, the car ${Math.round(Math.hypot(van.x + 74, van.z - 10))} m)`);
  assert.equal(walking.word, '차');
  m.player.pos.set(van.x + 3, 0, van.z); // at the car: the E prompt takes over
  assert.equal(arrow(m), null);
  m.activeCar = m.cars.find((c) => c.id === 'van1');
  const driving = arrow(m);
  assert.ok(names(m, driving, address) && driving.word === '', JSON.stringify(driving));
  m.world.input.dispose();
});

test('a drive stage on foot names its own car, not a nearer one', () => {
  const input = citySpec();
  input.world.city.vehicles.push({ id: 'taxi', kind: 'taxi', x: 100, z: 192, yaw: 1.5708 }); // parked on the north street
  const { ok, errors, spec } = validateSpec(input);
  assert.equal(ok, true, errors?.join('; '));
  const m = cityMode(spec, { autoplay: false, stage: spec.mission.stages.findIndex((s) => s.type === 'drive') });
  m.phase = 'playing';
  const own = m.cars.find((c) => c.id === 'quest_car').group.position, other = m.cars.find((c) => c.id === 'taxi').group.position;
  m.player.pos.set(other.x + 8, 0, other.z); // 8 m from the taxi, over 100 m from the stage's car
  const shown = arrow(m);
  assert.ok(shown && shown.word === '차' && names(m, shown, own), JSON.stringify(shown));
  m.world.input.dispose();
});

test('the label keeps off the story box and the notice pill', () => {
  // a label centred on a box is put just outside it, on the side of the screen's middle
  const say = { left: 440, right: 1160, top: 800, bottom: 950 }, pill = { left: 600, right: 1000, top: 220, bottom: 260 };
  assert.deepEqual(clearOf(800, 820, [say, pill], 500), { x: 800, y: 788 });
  assert.deepEqual(clearOf(900, 215, [say, pill], 500), { x: 900, y: 272 });
  assert.deepEqual(clearOf(300, 820, [say, pill], 500), { x: 300, y: 820 }, 'beside the box: left alone');
  assert.deepEqual(clearOf(800, 500, [], 500), { x: 800, y: 500 });
  // on the page: the goal straight behind the camera, the story box up (its rectangle read from the page)
  const m = mode([{ id: 's', type: 'reach', label: '목표', target: 1 }], { targets: [{ id: 'goal', x: 0, z: 60 }] });
  const page = globalThis.document.getElementById;
  globalThis.document.getElementById = (id) => (id === 'say' ? { hidden: false, getBoundingClientRect: () => say } : page(id));
  try {
    m.pointToGoal(m.director.stage);
    const label = m.goalArrow.firstChild;
    assert.equal(m.goalArrow.hidden, false);
    assert.equal(parseFloat(label.style.top) + innerHeight / 2, 788, `drawn at y ${parseFloat(label.style.top) + innerHeight / 2}, inside the box (800-950)`);
  } finally { globalThis.document.getElementById = page; }
});
