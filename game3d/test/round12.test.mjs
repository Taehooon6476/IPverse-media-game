import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

// 1) A hero's raw mesh (its rig failed) hops, waddles and leans, and never squashes. 2) A sky setting (sky.js) has
// no floor: ground islands at y = 0, a cloud sea far below, and a fall that respawns.
const stub = new URL('./fixtures/three-stub.mjs', import.meta.url).href;
registerHooks({ resolve: (specifier, context, next) => (/^three(\/|$)/.test(specifier)
  ? { url: stub, shortCircuit: true } : next(specifier, context)) });
globalThis.matchMedia ??= () => ({ matches: false });
const THREE = await import(stub);
const { animateBody, STATIC_GAIT } = await import('../world.js');
const { SKY, skyIslands, islandAt, islandRoot } = await import('../sky.js');
const { AuthoredMode } = await import('../authored.js');
const { validateAuthoredSpec, SETTINGS } = await import('../authored-contract.js');

const RUMI = JSON.parse(readFileSync(new URL('./fixtures/gm_1e7d17bbb0.spec.json', import.meta.url), 'utf8'));

/** Walk an actor for `seconds` at `speed01` the way PlayerController drives animateBody; samples per frame. */
function walk(actor, { speed01 = 1, seconds = 2, squash = 0, grounded = true } = {}) {
  const rows = [];
  let phase = 0;
  for (let t = 0; t < seconds; t += 1 / 60) {
    phase += (6 + 5 * speed01) / 60;
    animateBody(actor, 1 / 60, { speed01, phase, squash, grounded });
    rows.push({ y: actor.body.position.y, rx: actor.body.rotation.x, ry: actor.body.rotation.y, rz: actor.body.rotation.z,
      scale: actor.body.scale.toArray() });
  }
  return rows;
}
const span = (rows, key) => Math.max(...rows.map((r) => r[key])) - Math.min(...rows.map((r) => r[key]));

test('a raw mesh (a refused or dropped rig) hops, waddles, twists and leans when it walks', () => {
  const fox = { body: new THREE.Group(), kind: 'model', height: 1.15, rigDropped: true };
  const rows = walk(fox).slice(30); // past the damping
  const k = 1.15 / 1.8;
  assert.ok(span(rows, 'y') > STATIC_GAIT.hop * k * .9, `hop ${span(rows, 'y')}`);
  assert.ok(span(rows, 'rz') > STATIC_GAIT.waddle, `waddle ${span(rows, 'rz')}`); // side to side, both ways
  assert.ok(Math.min(...rows.map((r) => r.rz)) < 0 && Math.max(...rows.map((r) => r.rz)) > 0);
  assert.ok(span(rows, 'ry') > STATIC_GAIT.twist);
  assert.ok(rows.at(-1).rx > .08, 'leans into the walk');
  // the hop lands every step: the feet come back to the ground twice per cycle
  assert.ok(rows.filter((r) => r.y < .005).length >= 4);
});

test('a raw mesh never squashes: not on landing, not on the jump, not breathing', () => {
  const fox = { body: new THREE.Group(), kind: 'model', height: 1.8 };
  for (const squash of [.28, -.18, 0]) {
    for (const r of walk(fox, { squash, seconds: .5 })) assert.deepEqual(r.scale, [1, 1, 1]);
  }
  // the landing nods it forward instead
  const still = { body: new THREE.Group(), kind: 'model', height: 1.8 };
  const landing = walk(still, { speed01: 0, squash: .28, seconds: .4 });
  assert.ok(landing.at(-1).rx > .05, `nod ${landing.at(-1).rx}`);
  // in the air: no hop, no waddle
  const air = walk({ body: new THREE.Group(), kind: 'model', height: 1.8 }, { grounded: false, seconds: 1 });
  assert.ok(Math.max(...air.map((r) => r.y)) < .02 && Math.max(...air.map((r) => Math.abs(r.rz))) < .02);
});

test('standing still, a raw mesh breathes a little and stays put', () => {
  const rows = walk({ body: new THREE.Group(), kind: 'model', height: 1.8 }, { speed01: 0, seconds: 4 });
  assert.ok(span(rows, 'y') > .004 && span(rows, 'y') < STATIC_GAIT.breathe + .001, `breathe ${span(rows, 'y')}`);
  assert.ok(Math.max(...rows.map((r) => Math.abs(r.rz) + Math.abs(r.ry))) < 1e-6);
});

test('cutouts keep their cartoon squash and rigged bodies their clips', () => {
  const card = { body: new THREE.Group(), kind: 'billboard', billboard: {} };
  walk(card, { squash: .28, seconds: .1 });
  assert.notEqual(card.body.scale.y, 1);
  const rigged = { body: new THREE.Group(), kind: 'rigged', animator: {} };
  const rows = walk(rigged, { squash: .28 });
  assert.ok(rows.every((r) => r.y === 0 && r.ry === 0) && rows.every((r) => r.scale.every((v) => v === 1)));
});

// ── sky ──────────────────────────────────────────────────────────────────────

const skySpec = () => {
  const spec = structuredClone(RUMI);
  spec.artDirection.setting = 'sky';
  return spec;
};

test('the contract takes the sky setting the server writes and refuses an unknown one', () => {
  assert.deepEqual(SETTINGS, ['harbor', 'sky']);
  const ok = validateAuthoredSpec(skySpec());
  assert.ok(ok.ok, ok.errors?.join('; '));
  const bad = skySpec(); bad.artDirection.setting = 'moonbase';
  assert.ok(validateAuthoredSpec(bad).errors.includes('artDirection.setting is unsupported'));
  const server = readFileSync(new URL('../../server/authored_contract.py', import.meta.url), 'utf8');
  assert.match(server, /^SETTINGS = \("harbor", "sky"\)/m);
  for (const [key, py] of [['home', 'SKY_HOME'], ['pad', 'SKY_PAD'], ['spot', 'SKY_SPOT']]) {
    assert.equal(Number(server.match(new RegExp(`^${py} = ([\\d.]+)`, 'm'))[1]), SKY[key], key);
  }
});

test("rumi's world has one ground island, under the spawn, and every island floats above the cloud sea", () => {
  const islands = skyIslands(skySpec().world);
  assert.deepEqual(islands.map((i) => i.id), ['home']);
  assert.deepEqual([islands[0].x, islands[0].z, islands[0].width], [-38.5, 0, SKY.home]);
  assert.ok(SKY.seaY < SKY.fallY - 15, 'the clouds are far below where a fall is caught');
  const root = islandRoot(6, 6, () => .5);
  const cone = root.children[0];
  assert.equal(cone.rotation.x, Math.PI); // tip down: an island's rock root
  assert.ok(cone.position.y < 0);
});

test('a floor entity, an enemy spawn, the NPC and a prop off the platforms each stand on a ground island', () => {
  const world = { spawn: { x: 0, z: 0 }, entities: [
    { id: 'p', kind: 'platform', x: 10, z: 0, y: 0, width: 4, depth: 4, height: 1, rotation: 0 },
    { id: 'tower', kind: 'building', x: -20, z: 5, width: 3, depth: 5, height: 6 },
    { id: 'flag', kind: 'beacon', x: 10, z: 0, y: 1 }],
  enemySpawns: [{ id: 'e1', enemyIndex: 0, x: 20, z: 20 }], npc: { x: -5, z: -5 },
  propPlacements: [{ id: 'gem', propIndex: 0, x: 10.5, z: .5 }, { id: 'far', propIndex: 0, x: 30, z: 0 }] };
  const islands = skyIslands(world);
  assert.deepEqual(islands.map((i) => i.id).sort(), ['e1', 'far', 'home', 'npc', 'tower']);
  assert.equal(islands.find((i) => i.id === 'tower').width, 5 + 2 * SKY.pad);
  assert.equal(islandAt(islands, -20, 7.5)?.id, 'tower');
  assert.equal(islandAt(islands, 5, 5), null);
});

/** An AuthoredMode stand-in with the sky's islands and one platform top. */
function skyMode() {
  const islands = skyIslands(skySpec().world);
  const box = { min: { x: -37, y: 0, z: -3 }, max: { x: -31, y: 1.2, z: 3 } }; // plat_start
  const popups = [];
  const mode = Object.assign(Object.create(AuthoredMode.prototype), {
    islands, walkable: [{ box }], mechanics: { fallRespawn: true }, hp: 100,
    player: { pos: new THREE.Vector3(-38.5, 0, 0), vel: new THREE.Vector3(), grounded: true },
    world: { rig: { shake() {} } }, hud: { popup: (text) => popups.push(text), notice() {} },
  });
  return { mode, box, popups };
}

test('in the sky the floor is solid only on the ground islands and the platform tops', () => {
  const { mode } = skyMode();
  assert.equal(mode.groundAt(-38.5, 0), 0); // the start island
  assert.equal(mode.groundAt(-38.5, 6), SKY.noFloor); // off its edge: nothing under the hero
  assert.equal(mode.groundAt(-34, 0, 1.2), 1.2); // the first platform's top
  assert.equal(mode.groundAt(0, 0), SKY.noFloor); // the air between the islands
  const ground = Object.assign(Object.create(AuthoredMode.prototype), { islands: null, walkable: [] });
  assert.equal(ground.groundAt(0, 0), 0); // a world with a floor keeps it
});

test('a fall off a platform comes back on its middle, a fall off the start island on the start island', () => {
  const { mode, box, popups } = skyMode();
  const p = mode.player.pos;
  mode.fallCheck(1 / 60); // standing on the start island
  p.set(-34, 1.2, 0); mode.fallCheck(1 / 60); // then on plat_start
  assert.equal(mode.safe.box, box);
  mode.player.grounded = false;
  p.set(-30, -1, 4); mode.fallCheck(1 / 60);
  assert.equal(mode.skyFalls ?? 0, 0, 'still falling: above SKY.fallY');
  p.set(-30, SKY.fallY - .1, 4); mode.fallCheck(1 / 60);
  assert.deepEqual(p.toArray(), [-34, 1.25, 0]);
  assert.equal(mode.skyFalls, 1); assert.equal(mode.hp, 95); assert.match(popups[0], /추락/);
  const fresh = skyMode().mode; // never stood on a platform: back on the start island
  fresh.player.grounded = false;
  fresh.player.pos.set(-38.5, -10, 9); fresh.fallCheck(1 / 60);
  assert.deepEqual(fresh.player.pos.toArray(), [-38.5, .05, 0]);
});
