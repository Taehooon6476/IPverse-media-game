import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// world.js loads three.js through the page's import map. Here 'three' and its addons resolve to a stub with real vector
// math and a plane mesh (the billboard makeActor builds); the cut check reads plain RGBA pixels.
const stub = new URL('./fixtures/three-stub.mjs', import.meta.url).href;
registerHooks({ resolve: (specifier, context, next) => (/^three(\/|$)/.test(specifier)
  ? { url: stub, shortCircuit: true } : next(specifier, context)) });
globalThis.matchMedia ??= () => ({ matches: false });
const { CUT_SINK, World, bandShade, cutAtBottom } = await import('../world.js');
const { billboardPose } = await import('../arpg-data.js');

/** A 240 x 160 cutout of opaque boxes [x0, y0, x1, y1), as server/tests/test_cutout.py paints them. → the arguments
 * loadCutout passes: the pixels, the frame size and the subject's bounds (x0, x1 and its lowest row y1). */
function cutout(boxes, width = 240, height = 160) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (const [a, b, c, d] of boxes) for (let y = b; y < d; y++) for (let x = a; x < c; x++) data[(y * width + x) * 4 + 3] = 255;
  const xs = boxes.flatMap(([a, , c]) => [a, c - 1]);
  return [data, width, height, Math.min(...xs), Math.max(...xs), Math.max(...boxes.map(([, , , d]) => d - 1))];
}
// the server test's figures: one in A-pose (head, torso, arms out, two legs to `legs`) and one cut at the hips
const figure = (legs) => [[110, 10, 130, 30], [105, 30, 135, 90], [85, 35, 105, 70], [135, 35, 155, 70], [108, 90, 118, legs],
  [122, 90, 132, legs]];
const hips = [[90, 20, 150, 160], [60, 30, 90, 100], [150, 30, 180, 100], [105, 0, 135, 20]];

test('a full-body figure standing on the bottom edge keeps its feet', () => {
  // the server passes it (its soles cover 20 of its 70 px at the edge, under CUT figure 0.45): its feet are not frayed
  assert.equal(cutAtBottom(...cutout(figure(160))), false);
});

test('a figure the frame cuts off at the hips still frays out', () => {
  assert.equal(cutAtBottom(...cutout(hips)), true); // 60 of its 120 px at the edge: the server calls it cut
  const above = hips.map(([a, b, c, d]) => [a, b, c, Math.min(d, 159)]); // its last row 1 px above the edge
  assert.equal(cutAtBottom(...cutout(above)), true);
});

test('a subject clear of the bottom edge is never frayed', () => {
  assert.equal(cutAtBottom(...cutout(figure(150))), false);
  assert.equal(cutAtBottom(...cutout(hips.map(([a, b, c, d]) => [a, b, c, Math.min(d, 150)]))), false);
});

test('a figure the frame cut off stands in the floor, deeper than its walking hop; a full figure stands on it', async () => {
  // a cutout cut at the thighs: its frayed end must not hover above the floor
  const billboard = (cut) => World.prototype.makeActor.call({ loadCutout: async () => ({ texture: {}, aspect: .8, cut }) },
    { spriteUrl: 'assets/ip_515b406e5f.png' }, 1.8, () => assert.fail('the cutout is there'));
  const cut = await billboard(true), full = await billboard(false);
  const bottom = (actor) => actor.billboard.geometry.offset.y - actor.billboard.geometry.parameters.height / 2;
  assert.equal(cut.kind, 'billboard');
  assert.equal(cut.cut, true);
  assert.ok(Math.abs(bottom(cut) + 1.8 * CUT_SINK) < 1e-9, `the cut end ${bottom(cut)} m is under the floor`);
  assert.equal(full.cut, false);
  assert.ok(Math.abs(bottom(full)) < 1e-9, 'a full figure keeps its feet on the ground');
  // the hop of a walking cutout (lift, in actor heights) never brings the cut end back above the floor
  let lift = 0;
  for (let t = 0; t < 6; t += .01) lift = Math.max(lift, billboardPose({ time: t, speed: 3 }).lift);
  assert.ok(lift > 0 && lift < CUT_SINK, `hop ${lift}`);
  // and the frayed band darkens on the way down, so what is left of the cut melts into the dark pool around it
  assert.equal(bandShade(0), 1);
  assert.ok(bandShade(1) <= .25 && bandShade(1) > 0);
  for (let t = .1; t <= 1; t += .1) assert.ok(bandShade(t) < bandShade(t - .1));
});
