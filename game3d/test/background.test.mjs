import test from 'node:test';
import assert from 'node:assert/strict';
import { backgroundCover, backgroundModelScale, validateBackground } from '../background-data.js';

const validate = (v) => {
  const errors = [];
  validateBackground(v, (ok, message) => { if (!ok) errors.push(message); });
  return errors;
};
const ipId = 'ip_a123456789';
test('background is optional for existing city and authored games', () => {
  assert.deepEqual(validate(undefined), []);
  assert.deepEqual(validate(null), []);
});
test('background accepts raw IP selection and server-owned image snapshot', () => {
  assert.deepEqual(validate({ ipId, mode: 'image' }), []);
  assert.deepEqual(validate({ ipId, mode: 'image', imageUrl: `assets/${ipId}.background.png` }), []);
});
test('background accepts full model selection with rotation and its own snapshot', () => {
  assert.deepEqual(validate({ ipId, mode: 'model', rotation: -Math.PI,
    modelUrl: `assets/${ipId}.background.glb` }), []);
});
test('external URLs, other IP snapshots and the cutout slot cannot replace the background', () => {
  for (const imageUrl of ['https://example.com/bg.png', 'assets/ip_other.background.png',
    `assets/${ipId}.png`, `assets/${ipId}.glb`])
    assert.ok(validate({ ipId, mode: 'image', imageUrl }).length);
});
test('executable fields, path IDs, invalid modes and misleading image rotation fail', () => {
  for (const bg of [{ ipId, mode: 'script' }, { ipId: 'ip_../other', mode: 'image' },
    { ipId, mode: 'model', rotation: Infinity }, { ipId, mode: 'image', rotation: 1 },
    { ipId, mode: 'image', modelUrl: `assets/${ipId}.background.glb` },
    { ipId, mode: 'model', imageUrl: `assets/${ipId}.background.png` },
    { ipId, mode: 'image', shader: 'execute()' }])
    assert.ok(validate(bg).length);
});
test('wide viewport crops image height and portrait viewport crops width without distortion', () => {
  assert.deepEqual(backgroundCover(1000, 1000, 1600, 900),
    { repeatX: 1, repeatY: .5625, offsetX: 0, offsetY: .21875 });
  const portrait = backgroundCover(1600, 900, 390, 844);
  assert.equal(portrait.repeatY, 1);
  assert.ok(portrait.repeatX < .3 && portrait.offsetX > .35);
});
test('image and viewport dimensions must be real positive values', () => {
  assert.throws(() => backgroundCover(0, 100, 100, 100));
  assert.throws(() => backgroundCover(100, NaN, 100, 100));
});
test('GLB uniform fit keeps large scenes inside world bounds instead of pickup size', () => {
  const size = { x: 20, y: 5, z: 10 };
  const scale = backgroundModelScale(size, 60, 40);
  assert.equal(scale, 2.8);
  assert.equal(size.x * scale, 56);
  assert.equal(size.z * scale, 28);
  assert.equal(size.y * scale, 14);
  assert.equal(backgroundModelScale({ x: 20, y: 0, z: 10 }, 60, 40), 2.8);
  assert.throws(() => backgroundModelScale({ x: 0, y: 1, z: 2 }, 60, 40));
  assert.throws(() => backgroundModelScale(size, 4, 40));
});
