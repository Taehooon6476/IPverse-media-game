import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const stub = new URL('./fixtures/three-stub.mjs', import.meta.url).href;
registerHooks({ resolve: (specifier, context, next) => (/^three(\/|$)/.test(specifier)
  ? { url: stub, shortCircuit: true } : next(specifier, context)) });
globalThis.matchMedia ??= () => ({ matches: false });
const { ringSpot, groundReach, RING_GAP } = await import('../biome.js');
const { mulberry32 } = await import('../world.js');

// a 70 x 70 m wave arena: boulders 2-14 m outside the bounds must stand on opaque floor (not where it has faded
// into the photo dome), and an orbiting camera at the edge (up to ~6.3 m outside) must not end up inside one.
const CAMERA_REACH = 6.4; // the authored rig 6.2 m behind a hero clamped .6 m inside the bounds; the ARPG's 11 m at pitch .95
const outside = ({ x, z }, { width, depth }) => Math.max(Math.abs(x) - width / 2, Math.abs(z) - depth / 2);

test('the outer dressing ring stands past the camera\'s reach and on the opaque floor', () => {
  for (const world of [{ width: 70, depth: 70 }, { width: 36, depth: 100 }, { width: 120, depth: 120 }]) {
    const rnd = mulberry32(7), reach = groundReach(world.width, world.depth);
    for (let i = 0; i < 400; i++) {
      const r = .5 + rnd() * 3; // a rock or a tree trunk's footprint radius
      const at = ringSpot(rnd(), rnd(), world, r);
      assert.ok(outside(at, world) - r >= CAMERA_REACH, `${JSON.stringify(at)} r ${r.toFixed(1)} is within the camera's reach`);
      assert.ok(Math.hypot(at.x, at.z) + r <= reach, `${JSON.stringify(at)} stands past the opaque floor (${reach.toFixed(0)} m)`);
    }
  }
  assert.ok(RING_GAP > CAMERA_REACH);
});
