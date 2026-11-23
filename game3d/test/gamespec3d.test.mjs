import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateSpec, defaultSpec } from '../gamespec3d.js';
import { validateSpec as validate2d, defaultSpec as default2d } from '../../game/gamespec.js';

const devSpec = (name) => JSON.parse(readFileSync(new URL(`../dev/${name}`, import.meta.url), 'utf8'));
const spec2d = (name) => JSON.parse(readFileSync(new URL(`../../game/dev/${name}`, import.meta.url), 'utf8'));

function assertRejected(spec, field) {
  const result = validateSpec(spec);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes(field)), `no error mentions ${field}: ${result.errors}`);
}

// ── the 2D cases (game/test/gamespec.test.mjs), run against the 3D copy ──

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
  spec.objective = { type: 'talk', target: 3 };
  assertRejected(spec, 'objective.type');
});

test('3D-only SF objectives, environment and rules; Phaser keeps the 2D objectives', () => {
  const spec = devSpec('spec-sf.json');
  Object.assign(spec, {
    objective: { type: 'boss', target: 60, label: '거대 전투 로봇을 쓰러뜨려라' },
    environment: { theme: 'lava-forge', sky: 'night', layout: 'maze', size: 36, obstacles: 14 },
    rules: { timeLimitSec: 180, enemyRate: 1.5, playerHp: 150 },
  });
  assert.ok(validateSpec(spec).ok, String(validateSpec(spec).errors));
  assertRejected({ ...spec, engine: 'phaser' }, 'objective.type');
  assertRejected({ ...spec, environment: { theme: 'moon' } }, 'environment.theme');
  assertRejected({ ...spec, rules: { enemyRate: 9 } }, 'rules.enemyRate');
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
  assert.equal(result.spec.engine, 'three');
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

test('never mutates its input', () => {
  const spec = devSpec('spec-rpg.json');
  delete spec.props;
  const before = structuredClone(spec);
  validateSpec(spec);
  assert.deepEqual(spec, before);
});

// ── new optional 3D fields ──

test('engine is optional and must be phaser|three', () => {
  const spec = devSpec('spec-sf.json');
  delete spec.engine;
  assert.ok(validateSpec(spec).ok);
  for (const engine of ['phaser', 'three', null]) assert.ok(validateSpec({ ...spec, engine }).ok, String(engine));
  for (const engine of ['unity', 3, true, '']) assertRejected({ ...spec, engine }, 'engine');
});

test('modelUrl is optional on player and props and must be a non-empty string', () => {
  const spec = devSpec('spec-sf.json');
  delete spec.player.modelUrl;
  assert.ok(validateSpec(spec).ok);
  spec.player.modelUrl = 42;
  assertRejected(spec, 'player.modelUrl');
  spec.player.modelUrl = 'assets/ip_1.glb';
  spec.props[1].modelUrl = '';
  assertRejected(spec, 'props[1].modelUrl');
  spec.props[1].modelUrl = 'assets/ip_2.glb';
  assert.ok(validateSpec(spec).ok);
});

// ── drift guard: on 2D specs (no 3D fields) both validators agree exactly ──

test('agrees with game/gamespec.js on 2D specs and their broken variants', () => {
  const cases = [spec2d('spec-sf.json'), spec2d('spec-rpg.json'), ...['sf-shooter', 'sf-survival', 'rpg-explore', 'rpg-quest'].map(default2d)];
  const breakers = [
    (s) => { s.version = 3; },
    (s) => { s.genre = 'puzzle'; },
    (s) => { s.palette.bg = 'red'; },
    (s) => { s.player.speed = '2'; },
    (s) => { s.player.speed = 2.0; },
    (s) => { s.objective.target = 0; },
    (s) => { s.difficulty = 'insane'; },
    (s) => { s.enemies = []; },
    (s) => { s.enemies = Array(6).fill(s.enemies[0] ?? {}); },
    (s) => { s.props = [{ effect: 'fly' }]; },
    (s) => { s.dialogue = [{ text: '가'.repeat(141) }]; },
    (s) => { s.dialogue = [{ text: '😀'.repeat(140) }]; },
    (s) => { s.quest = 'x'; },
    (s) => { s.map = { width: 31, height: 9 }; },
    (s) => { delete s.map; delete s.props; delete s.dialogue; delete s.quest; },
  ];
  for (const base of cases) {
    for (const breaker of [() => {}, ...breakers]) {
      const spec = structuredClone(base);
      delete spec.engine;
      breaker(spec);
      assert.deepEqual(validateSpec(spec), validate2d(spec), `${base.genre}: ${breaker}`);
    }
  }
});

test('animated 3D fields are optional and typed', () => {
  const spec = devSpec('spec-sf-anim.json');
  assert.ok(validateSpec(spec).ok, String(validateSpec(spec).errors));
  const cases = [
    [(s) => { s.animUrl = ''; }, 'animUrl'],
    [(s) => { s.player.weaponUrl = 3; }, 'player.weaponUrl'],
    [(s) => { s.player.weaponType = 'bow'; }, 'player.weaponType'],
    [(s) => { s.enemies[0].modelUrl = ''; }, 'enemies[0].modelUrl'],
    [(s) => { s.enemies[1].weaponUrl = false; }, 'enemies[1].weaponUrl'],
    [(s) => { s.enemies[0].humanoid = 'yes'; }, 'enemies[0].humanoid'],
  ];
  for (const [breaker, field] of cases) {
    const bad = structuredClone(spec);
    breaker(bad);
    assertRejected(bad, field);
  }
});
