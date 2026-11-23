import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

// world.js loads three.js through the page's import map; here it resolves to an empty stub (module scope only).
const stub = `data:text/javascript,${encodeURIComponent(['Vector3', 'Color', 'Box3', 'GLTFLoader', 'DRACOLoader', 'clone',
  'EffectComposer', 'RenderPass', 'UnrealBloomPass', 'ShaderPass', 'OutputPass'].map((name) => `export class ${name} {}`).join('\n'))}`;
registerHooks({ resolve: (specifier, context, next) => (/^three(\/|$)/.test(specifier)
  ? { url: stub, shortCircuit: true } : next(specifier, context)) });
globalThis.matchMedia ??= () => ({ matches: false });
const { SKIN_PAD, padSkinBounds } = await import('../world.js');

test('a skinned GLB gets a padded rest-pose bounding sphere once, so its clones are frustum-culled off screen', () => {
  // the rest pose of a 1.8 m mutant: a sphere around its middle; a stride, a swing or a fall must stay inside
  const skinned = { isSkinnedMesh: true, isMesh: true, frustumCulled: true, boundingSphere: null,
    computeBoundingSphere() { this.boundingSphere = { center: { x: 0, y: .9, z: 0 }, radius: .95 }; } };
  const prop = { isMesh: true, frustumCulled: true };
  const scene = { updated: false, updateMatrixWorld(force) { this.updated = force; }, traverse(fn) { [this, skinned, prop].forEach(fn); } };
  assert.equal(padSkinBounds(scene), scene);
  assert.equal(scene.updated, true, 'bones posed before the sphere is taken');
  assert.ok(SKIN_PAD >= 2);
  assert.equal(skinned.boundingSphere.radius, .95 * SKIN_PAD); // SkinnedMesh.copy hands it to every clone
  assert.equal(skinned.frustumCulled, true);
  assert.equal(prop.boundingSphere, undefined);
  // skinned meshes are culled: a mutant behind the camera is neither drawn nor skinned
  const source = readFileSync(new URL('../world.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /isSkinnedMesh\) o\.frustumCulled = false/);
});

test('a skin whose sphere cannot be taken is drawn as before (never culled) and its model still loads', () => {
  const broken = { isSkinnedMesh: true, isMesh: true, frustumCulled: true, name: 'mutant',
    computeBoundingSphere() { throw new TypeError("Cannot read properties of undefined (reading 'bones')"); } };
  const scene = { updateMatrixWorld() {}, traverse(fn) { [this, broken].forEach(fn); } };
  const warn = console.warn;
  console.warn = () => {};
  try { assert.equal(padSkinBounds(scene), scene); } finally { console.warn = warn; }
  assert.equal(broken.frustumCulled, false);
});
