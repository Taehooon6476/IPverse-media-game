import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateSpec } from '../gamespec3d.js';
const fixture = (name = 'city') => JSON.parse(readFileSync(new URL(`../dev/spec-authored-${name}.json`, import.meta.url)));
function rejects(edit, reason) {
  const spec = fixture(); edit(spec);
  const result = validateSpec(spec);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((s) => s.includes(reason)), result.errors.join('; '));
}
test('distinct authored city and garden worlds validate without mutating input', () => {
  for (const name of ['city', 'garden']) {
    const s = fixture(name), before = structuredClone(s);
    const result = validateSpec(s);
    assert.equal(result.ok, true, result.errors?.join('; '));
    assert.deepEqual(s, before);
    assert.equal(result.spec.version, 2);
  }
});
test('v2 requires the authored world and cannot silently run a legacy mode', () => {
  rejects((s) => { delete s.world; }, 'world');
  rejects((s) => { delete s.mission; }, 'mission');
  rejects((s) => { s.engine = 'phaser'; }, 'engine');
});
test('bad cast indices, dangling stage targets and impossible collection fail before rendering', () => {
  rejects((s) => { s.world.propPlacements[0].propIndex = 99; }, 'propIndex');
  rejects((s) => { s.world.enemySpawns[0].enemyIndex = 99; }, 'enemyIndex');
  rejects((s) => { s.mission.stages[0].entityIds = ['does-not-exist']; }, 'entityIds');
  rejects((s) => { s.mission.stages[0].target = 2; }, 'collect target');
});
test('nonfinite geometry, unsupported kind and unbounded mechanics are rejected', () => {
  rejects((s) => { s.world.entities[0].width = Infinity; }, 'width');
  rejects((s) => { s.world.entities[0].kind = 'javascript'; }, 'kind');
  rejects((s) => { s.mechanics.weaponDamage = 100; }, 'weaponDamage');
  rejects((s) => { s.world.entities[1].id = s.world.entities[0].id; }, 'unique');
});
test('peaceful SF v2 keeps an empty cast; v1 SF still requires enemies', () => {
  const peaceful = fixture('garden');
  peaceful.genre = 'sf-shooter';
  const result = validateSpec(peaceful);
  assert.equal(result.ok, true, result.errors?.join('; '));
  assert.deepEqual(result.spec.enemies, []);
  assert.deepEqual(peaceful.enemies, []);
  const missingCast = { ...peaceful };
  delete missingCast.enemies;
  assert.deepEqual(validateSpec(missingCast).spec.enemies, []);
  const legacy = { ...peaceful, version: 1, objective: { type: 'kills', target: 1 } };
  assert.equal(validateSpec(legacy).ok, false);
});
