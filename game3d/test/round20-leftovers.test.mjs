import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { THREE, AuthoredMode, authoredMode, published } from './fixtures/headless.mjs';

// What a round must not leave on the graphics card: its light probe (a render target kept only as its texture:
// texture.dispose() frees nothing of a render target), its sun's shadow map, and the bone texture of every rigged
// enemy and passer-by it has drawn. dev/qa-round20.mjs --only=textures lists them in a browser.
const { disposeTree, releaseDrawn } = await import('../world.js');
const { applySky, applyIndoor, disposeBiome } = await import('../biome.js');
const { SfMode } = await import('../sf.js');
const { RpgMode } = await import('../rpg.js');
const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

/** A rigged model as three.js leaves it once drawn: a skinned mesh whose skeleton holds a bone texture. */
function rigged() {
  const mesh = Object.assign(new THREE.Mesh(), { skeleton: { boneTexture: { held: true }, dispose() { this.boneTexture = null; } } });
  return Object.assign(new THREE.Group().add(mesh), { mesh });
}
/** A sun with its shadow map (three.js: DirectionalLight.dispose() frees the map), and a light that has none. */
const sun = () => Object.assign(new THREE.Group(), { isLight: true, map: { held: true }, dispose() { this.map = null; } });
/** PMREMGenerator's answer: a render target. Only its own dispose() frees it. */
function probes() {
  const made = [];
  const probe = (of) => { made.push({ of, freed: 0, texture: { dispose() {} }, dispose() { this.freed += 1; } }); return made.at(-1); };
  return { made, pmrem: { fromEquirectangular: probe, fromScene: probe } };
}

test('a tree that is disposed frees its rigged models\' bone textures and its lights\' shadow maps', () => {
  const root = new THREE.Group(), soldier = rigged(), light = sun(), fill = Object.assign(new THREE.Group(), { isLight: true, dispose() {} });
  root.add(new THREE.Group().add(soldier), light, fill);
  disposeTree(root);
  assert.equal(soldier.mesh.skeleton.boneTexture, null, 'the bone texture stayed on the graphics card');
  assert.equal(light.map, null, 'the 2048² shadow map stayed on the graphics card');
  // and by itself, for what leaves a round before its end (its geometry and materials are the cached model\'s)
  const other = rigged();
  releaseDrawn(other);
  assert.equal(other.mesh.skeleton.boneTexture, null);
});

test('a kit\'s light probe is freed as the render target it is: with the next round\'s sky, and when the round goes', () => {
  for (const apply of [applySky, applyIndoor]) {
    const { made, pmrem } = probes(), world = { scene: new THREE.Group(), pmrem };
    const kit = { name: 'desert', fog: '#c8b8a0', hdr: {}, backdrop: null, disposables: [], sky: null };
    apply(world, kit, 300);
    assert.equal(world.scene.environment, made[0].texture);
    apply(world, kit, 300); // the next round
    assert.deepEqual(made.map((p) => p.freed), [1, 0], `${apply.name}: the last round's probe was not freed`);
    assert.equal(world.scene.environment, made[1].texture);
    disposeBiome(kit, world);
    assert.deepEqual(made.map((p) => p.freed), [1, 1]);
    assert.equal(kit.disposables.length, 0);
  }
});

test('a round that is disposed frees its own light probe: a version-2 world, an arena, a quest', () => {
  const world = () => ({ rig: {}, scene: new THREE.Group(), particles: { clear() {} } });
  const hud = { say() {}, float() {}, crosshair() {} };
  const hero = { root: new THREE.Group() };
  // version 2 (a city and a track end in this one too)
  const { made, pmrem } = probes(), passerBy = rigged(), light = sun();
  const round = { world: world(), hud, root: new THREE.Group().add(hero.root, passerBy, light), actor: hero, envTarget: pmrem.fromScene('room'),
    pickups: [], targets: [], enemies: [], leaving: [] };
  AuthoredMode.prototype.dispose.call(round);
  assert.equal(made[0].freed, 1, 'authored.js: the probe was not freed');
  assert.deepEqual([passerBy.mesh.skeleton.boneTexture, light.map], [null, null]);
  // an arena: its walkers at rest in the pool are not under the root
  const atRest = rigged(), arena = { world: world(), hud, root: new THREE.Group().add(hero.root), playerActor: hero, pickups: [],
    pools: new Map([[0, [{ root: atRest }]]]), envTarget: pmrem.fromScene('room') };
  SfMode.prototype.dispose.call(arena);
  assert.equal(made[1].freed, 1, 'sf.js: the probe was not freed');
  assert.equal(atRest.mesh.skeleton.boneTexture, null, 'a walker at rest kept its bone texture');
  // a quest
  const quest = { world: world(), hud, root: new THREE.Group().add(hero.root), playerActor: hero, envTarget: pmrem.fromScene('sky') };
  RpgMode.prototype.dispose.call(quest);
  assert.equal(made[2].freed, 1, 'rpg.js: the probe was not freed');
  // no mode keeps a probe only as its texture (nothing could free it then)
  for (const file of ['authored.js', 'biome.js', 'city.js', 'sf.js', 'rpg.js']) {
    const src = read(file);
    assert.match(src, /pmrem\.from(Scene|Equirectangular)\(/, file);
    assert.doesNotMatch(src, /pmrem\.from\w+\([^;\n]*\)\.texture/, `${file}: a light probe kept only as its texture`);
  }
});

test('an enemy that leaves the round before its end frees its bone texture: one that died, one that ran off', () => {
  const mode = authoredMode(published('gm_b870737b47'), { autoplay: false });
  const dead = rigged(), gone = rigged();
  mode.root.add(dead, gone);
  mode.dying = [{ deadFor: 0, deathLength: 0, actor: { root: dead, animator: null } }];
  mode.updateDying(1);
  assert.deepEqual([mode.dying.length, mode.root.children.includes(dead)], [0, false]);
  assert.equal(dead.mesh.skeleton.boneTexture, null, 'the dead soldier\'s bone texture stayed');
  mode.leaving = [{ leaveFor: 60, pos: new THREE.Vector3(8, 0, 8), speed: 2, enemyIndex: 0, actor: { root: gone, animator: null, billboard: null } }];
  mode.updateLeaving(.1);
  assert.deepEqual([mode.leaving.length, mode.root.children.includes(gone)], [0, false]);
  assert.equal(gone.mesh.skeleton.boneTexture, null, 'the one that ran off kept its bone texture');
  mode.world.input.dispose();
});
