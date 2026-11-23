import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { validateSpec } from '../gamespec3d.js';

// authored.js loads three.js through the page's import map. Here 'three' and its addons resolve to an empty stub (module
// scope only makes a few vectors) and the placement methods run on the entity records buildEntity keeps.
const stub = `data:text/javascript,${encodeURIComponent(['Vector3', 'Color', 'Box3', 'Object3D', 'Group', 'RoomEnvironment',
  'RoundedBoxGeometry', 'GLTFLoader', 'DRACOLoader', 'clone', 'EffectComposer', 'RenderPass', 'UnrealBloomPass', 'ShaderPass',
  'OutputPass', 'RGBELoader', 'GroundedSkybox'].map((name) => `export class ${name} {}`).join('\n'))}`;
registerHooks({ resolve: (specifier, context, next) => (/^three(\/|$)/.test(specifier)
  ? { url: stub, shortCircuit: true } : next(specifier, context)) });
globalThis.matchMedia ??= () => ({ matches: false });
const { AuthoredMode } = await import('../authored.js');

/** The garden quest with its collectible at (0, 5) and `platforms` over that spot, as the runtime builds it: the
 * validated spec, then each entity recorded like buildEntity does (sizes defaulted, a platform's box walkable). */
function placed(platforms, mechanics = {}) {
  const input = JSON.parse(readFileSync(new URL('../dev/spec-authored-garden.json', import.meta.url)));
  input.world.entities.push(...platforms.map((p, i) => ({ id: `span-${i}`, kind: 'platform', x: 0, z: 5, width: 6, depth: 3, ...p })));
  Object.assign(input.mechanics, mechanics);
  const { ok, errors, spec } = validateSpec(input);
  assert.equal(ok, true, errors?.join('; '));
  const mode = new AuthoredMode({ scene: { add() {} } }, spec, {}, {});
  for (const e of spec.world.entities) {
    const w = e.width ?? 2, d = e.depth ?? 2, h = e.height ?? 2, y = e.y ?? 0;
    mode.entities.set(e.id, { ...e, width: w, depth: d, height: h });
    if (e.kind === 'platform') mode.walkable.push({ box: { min: { x: e.x - w / 2, y, z: e.z - d / 2 }, max: { x: e.x + w / 2, y: y + h, z: e.z + d / 2 } } });
  }
  const { x, z } = spec.world.propPlacements[0];
  const seat = mode.platformUnder(x, z); // build(): the prop sits on this platform's top, else at groundAt
  return { mode, seat, y: seat ? seat.y + seat.height : mode.groundAt(x, z) };
}

test('outside a platformer a collectible under a bridge stays on the floor, where the hero picks it up', () => {
  // on the bridge's top (3.5 m) it is out of reach of a 1.2 m jump and the 1.35 m pickup radius. A low thin bridge
  // (top 2.2 m) is no better: one jump lands on 1.4 m at most, and its underside keeps the hero from jumping under
  // the item.
  for (const bridge of [{ y: 3, height: .5 }, { y: 1.8, height: .4 }]) for (const mechanics of [{}, { style: 'arpg' }]) {
    const { seat, y } = placed([bridge], mechanics);
    assert.equal(seat, null, JSON.stringify({ bridge, mechanics }));
    assert.equal(y, 0);
  }
});

test('a platformer (fallRespawn) seats it on the climb above, as the server seats its collectibles', () => {
  const { seat, y } = placed([{ y: 3, height: .5 }], { jump: true, fallRespawn: true });
  assert.equal(seat.id, 'span-0');
  assert.equal(y, 3.5);
});

test('a ledge or block the hero cannot walk under still holds it on its top', () => {
  // server/tests/test_genre_modules.py stair step: its underside is lower than the hero's head, nobody stands below
  assert.equal(placed([{ y: 1.4, height: .6 }]).y, 2);
  assert.equal(placed([{ y: 0, height: 1 }]).y, 1); // a crate-like block standing on the floor
  assert.equal(placed([{ y: 0, height: 1 }], { jump: false }).y, 0); // without a jump only a step-up top counts
});

test('a step under a bridge holds it on the step; a coin lifted onto the bridge still rides it', () => {
  const { mode, y } = placed([{ y: 0, height: .6 }, { y: 3, height: .5, motion: { axis: 'x', distance: 4 } }]);
  assert.equal(y, .6);
  assert.equal(mode.platformUnder(0, 5, true).id, 'span-1'); // build(): coins ride what the lift put them on
});
