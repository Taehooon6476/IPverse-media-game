import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { noseSign } from '../city-controller.js';

// race.js loads three.js through the page's import map: here an empty stub (floorSlab is plain arithmetic)
const stub = new URL('./fixtures/three-stub.mjs', import.meta.url).href;
registerHooks({ resolve: (specifier, context, next) => (/^three(\/|$)/.test(specifier)
  ? { url: stub, shortCircuit: true } : next(specifier, context)) });
globalThis.matchMedia ??= () => ({ matches: false });
const { floorSlab } = await import('../race.js');

// A car-like point cloud along `axis` (x or z) from -2 to 2 m: height(t) for t in 0..1 from the - end to the + end.
function body(axis, height, n = 4000) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = (i % 400) / 399, along = -2 + 4 * t, across = (Math.floor(i / 400) / 9 - .5) * 1.8;
    for (const y of [0, height(t) * (.3 + .7 * ((i * 7919) % 101) / 100)]) // floor and a spread up to the roof line
      out.push(...(axis === 'x' ? [along, y, across] : [across, y, along]));
  }
  return out;
}
const tailAtMinus = (t) => t < .12 ? 1.3 : .55 + .5 * Math.max(0, 1 - Math.abs(t - .45) / .3) - .25 * t; // wing aft, low nose
const sedan = (t) => .7 + .55 * Math.max(0, 1 - Math.abs(t - .42) / .26) - .12 * t; // cabin aft of centre, boot above the bonnet

test('a generated car\'s nose is the low end of its long axis, whichever way the mesh was built', () => {
  assert.equal(noseSign(body('z', tailAtMinus), 'z'), 1); // the race "Ray"/"Viper" meshes: wing at -Z, nose at +Z
  assert.equal(noseSign(body('z', (t) => tailAtMinus(1 - t)), 'z'), -1);
  assert.equal(noseSign(body('x', tailAtMinus), 'x'), 1); // older side-view meshes: nose at +X
  assert.equal(noseSign(body('x', (t) => tailAtMinus(1 - t)), 'x'), -1);
  assert.equal(noseSign(body('x', sedan), 'x'), 1);
  assert.equal(noseSign(body('z', (t) => sedan(1 - t)), 'z'), -1);
});

test('no clear height cue keeps the caller\'s default instead of guessing', () => {
  assert.equal(noseSign(body('z', () => 1), 'z'), 0);
  assert.equal(noseSign(body('x', (t) => 1 + .01 * t), 'x'), 0);
  assert.equal(noseSign([], 'z'), 0);
  assert.equal(noseSign(new Float32Array(body('z', tailAtMinus)), 'z'), 1);
});

/** A box's 12 triangles as flat [x, y, z, ...] positions, wound outward (glTF's front faces): x, y, z are [lo, hi]. */
function cuboid(x, y, z) {
  const out = [], span = [x, y, z], mid = span.map(([a, b]) => (a + b) / 2);
  for (let axis = 0; axis < 3; axis++) for (const end of [0, 1]) {
    const [u, v] = [0, 1, 2].filter((k) => k !== axis);
    const corner = (i, j) => { const p = []; p[axis] = span[axis][end]; p[u] = span[u][i]; p[v] = span[v][j]; return p; };
    let quad = [corner(0, 0), corner(1, 0), corner(1, 1), corner(0, 1)];
    const e1 = quad[1].map((c, k) => c - quad[0][k]), e2 = quad[2].map((c, k) => c - quad[0][k]);
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    if (n[axis] * (quad[0][axis] - mid[axis]) < 0) quad = quad.reverse();
    out.push(...quad[0], ...quad[1], ...quad[2], ...quad[0], ...quad[2], ...quad[3]);
  }
  return out;
}
// a generated car 0.55 high, 2 long and 0.84 wide, its four tyres standing on `ground` (the Viper GLB's proportions)
const car = (ground) => [cuboid([-.42, .42], [.06, .55], [-1, 1]),
  ...[[-.8, -.54], [.54, .8]].flatMap((z) => [[-.42, -.32], [.32, .42]].map((x) => cuboid(x, [ground, ground + .26], z)))].flat();
// the floor slab image-to-3D fused under the Viper: a 2.7 %-of-the-height plate under its tyres, wider than its body
const SLAB = cuboid([-.51, .51], [0, .015], [-.9, .9]);
const triangles = (p) => Array.from({ length: p.length / 9 }, (_, t) => p.slice(9 * t, 9 * t + 9));
const topOf = (tri) => Math.max(tri[1], tri[4], tri[7]); // a triangle's highest vertex

test('a generated car standing on a fused floor slab loses the slab, and only what lies in it', () => {
  const body = car(.015), positions = [...body, ...SLAB], [drop] = floorSlab([{ positions, index: null }]);
  const tris = triangles(positions), band = .55 * .035;
  for (const [t, tri] of tris.entries()) assert.equal(drop.has(t), topOf(tri) < band, `triangle ${t} (top ${topOf(tri).toFixed(3)} m) ${drop.has(t) ? 'dropped' : 'kept'}`);
  for (let t = body.length / 9; t < tris.length; t++) assert.ok(drop.has(t), `slab triangle ${t} dropped`);
  // what is left stands on its tyres and is as wide as its body: the footprint the race measures (carSize)
  const kept = tris.filter((_, t) => !drop.has(t)).flat(), xs = kept.filter((_, i) => i % 3 === 0), ys = kept.filter((_, i) => i % 3 === 1);
  assert.equal(Math.min(...ys), .015);
  assert.equal(Math.max(...xs) - Math.min(...xs), .84);
  // the same with the slab a mesh of its own and both indexed (the GLB's one textured mesh is indexed)
  const index = (p) => Uint32Array.from({ length: p.length / 3 }, (_, i) => i);
  const parts = floorSlab([{ positions: Float32Array.from(body), index: index(body) }, { positions: Float32Array.from(SLAB), index: index(SLAB) }]);
  assert.equal(parts[1].size, SLAB.length / 9, 'the whole slab mesh dropped');
  assert.deepEqual([...parts[0]], [...drop].filter((t) => t < body.length / 9), 'the car mesh loses the same tyre soles');
});

test('a generated car whose tyres touch the ground keeps every triangle', () => {
  const positions = car(0);
  assert.equal(floorSlab([{ positions, index: null }])[0].size, 0); // four tyre soles cover 5 % of its footprint
  assert.equal(floorSlab([{ positions: [], index: null }])[0].size, 0);
});
