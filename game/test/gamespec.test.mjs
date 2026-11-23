import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateSpec, defaultSpec } from '../gamespec.js';

const devSpec = (name) => JSON.parse(readFileSync(new URL(`../dev/${name}`, import.meta.url), 'utf8'));

function assertRejected(spec, field) {
  const result = validateSpec(spec);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes(field)), `no error mentions ${field}: ${result.errors}`);
}

test('accepts the dev sf spec', () => {
  const result = validateSpec(devSpec('spec-sf.json'));
  assert.ok(result.ok, String(result.errors));
});

test('accepts the dev rpg spec', () => {
  const result = validateSpec(devSpec('spec-rpg.json'));
  assert.ok(result.ok, String(result.errors));
});

test('rejects wrong objective for genre', () => {
  const spec = devSpec('spec-sf.json');
  spec.objective = { type: 'collect', target: 3 };
  assertRejected(spec, 'objective.type');
});

test('rejects bad hex', () => {
  const spec = devSpec('spec-sf.json');
  spec.palette.accent = '#5de6c';
  assertRejected(spec, 'palette.accent');
});

test('rejects enemy speed 4', () => {
  const spec = devSpec('spec-sf.json');
  spec.enemies[0].speed = 4;
  assertRejected(spec, 'enemies[0].speed');
});

test('defaultSpec("rpg-quest") validates', () => {
  const result = validateSpec(defaultSpec('rpg-quest'));
  assert.ok(result.ok, String(result.errors));
  assert.equal(result.spec.genre, 'rpg-quest');
});

test('fills optional fields with defaults', () => {
  const spec = devSpec('spec-rpg.json');
  for (const key of ['props', 'enemies', 'dialogue', 'quest', 'map']) delete spec[key];
  const result = validateSpec(spec);
  assert.ok(result.ok, String(result.errors));
  assert.deepEqual(
    [result.spec.props, result.spec.enemies, result.spec.dialogue, result.spec.quest, result.spec.map],
    [[], [], [], null, { width: 20, height: 15, seed: 1234 }],
  );
});
