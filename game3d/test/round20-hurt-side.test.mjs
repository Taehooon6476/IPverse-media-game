import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { authoredMode, published } from './fixtures/headless.mjs';

// A blow that has a side reddens the picture's rim (world.js's vignette) on that side only: a wedge toward the
// attacker.
const world = readFileSync(new URL('../world.js', import.meta.url), 'utf8');
const authored = readFileSync(new URL('../authored.js', import.meta.url), 'utf8');
const near = (a, b) => Math.abs(a - b) < 1e-9;

test('a blow tells the side of the picture it came from: right, ahead (the top), behind (the bottom), by where the camera looks', () => {
  const mode = authoredMode(published('gm_9539d06a71'), { autoplay: false });
  mode.phase = 'playing';
  const at = mode.player.pos, rig = mode.world.rig;
  const blow = (from) => { mode.hurtFor = 0; mode.world.hurt = 0; mode.hurt(5, from); return mode.world.hurtFrom; };
  rig.yaw = 0; // the camera looks along -Z
  let side = blow({ x: at.x + 4, z: at.z });
  assert.ok(side && near(side.x, 1) && near(side.y, 0), `an attacker on the hero's right: ${JSON.stringify(side)}`);
  assert.equal(mode.world.hurt, .9, 'the rim reddens as before');
  side = blow({ x: at.x, z: at.z - 6 });
  assert.ok(near(side.x, 0) && near(side.y, 1), `ahead: the top of the picture: ${JSON.stringify(side)}`);
  side = blow({ x: at.x, z: at.z + 6 });
  assert.ok(near(side.x, 0) && near(side.y, -1), `behind, out of sight: the bottom: ${JSON.stringify(side)}`);
  rig.yaw = Math.PI / 2; // the camera turned to look along -X
  side = blow({ x: at.x - 5, z: at.z });
  assert.ok(near(side.x, 0) && near(side.y, 1), `ahead of the turned camera: ${JSON.stringify(side)}`);
  // a trap underfoot has no side: the whole rim
  assert.equal(blow(), null);
  // and a blow the hero does not take (still blinking from the last one) moves nothing
  mode.world.hurtFrom = { x: 1, y: 0 };
  mode.hurt(5, { x: at.x, z: at.z - 6 });
  assert.deepEqual(mode.world.hurtFrom, { x: 1, y: 0 });
  mode.world.input.dispose();
});

test('who strikes tells where from: an enemy its place, a bolt the way it flew; the rim\'s shader takes the side', () => {
  assert.match(authored, /this\.hurt\(enemyHit\(blow\), e\.pos\);/, 'a melee blow: the enemy\'s place');
  assert.match(authored, /this\.hurt\(b\.damage, \{ x: before\.x - b\.velocity\.x, z: before\.z - b\.velocity\.z \}\);/, 'a bolt: back along its flight');
  assert.match(world, /uniform vec2 hurtFrom;/);
  assert.match(world, /hurtFrom: \{ value: \[0, 0\] \}/, 'no side: the whole rim (a version-1 mode, a trap)');
  assert.match(world, /const side = this\.vignette\.uniforms\.hurtFrom\.value;\n\s*side\[0\] = this\.hurtFrom\?\.x \?\? 0; side\[1\] = this\.hurtFrom\?\.y \?\? 0;/);
});
