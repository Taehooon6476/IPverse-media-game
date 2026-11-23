import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BALANCE, RARITIES, assistTarget, attackSlots, better, billboardPose, clearSpawn, enemyHit, fireInterval, itemLine, rollItem, rollRarity, toughness, xpFor } from '../arpg-data.js';
import { validateAuthoredSpec } from '../authored-contract.js';

const seq = (...values) => { let i = 0; return () => values[i++ % values.length]; };

test('XP needed per level grows', () => {
  assert.equal(xpFor(1), 60);
  assert.ok(xpFor(5) > xpFor(4) && xpFor(4) > xpFor(3));
});

test('rarity weights: mostly common; bosses drop rare or better', () => {
  assert.equal(rollRarity(seq(0)).id, 'common');
  assert.equal(rollRarity(seq(.999)).id, 'legendary');
  for (const r of [0, .3, .6, .99]) assert.ok(['rare', 'legendary'].includes(rollRarity(seq(r), true).id));
});

test('items scale with level and rarity, and only better gear replaces worn gear', () => {
  const weak = rollItem(seq(0, 0), 1); // weapon, common
  const strong = rollItem(seq(0, .999), 8); // weapon, legendary
  assert.equal(weak.slot, 'weapon');
  assert.ok(strong.value > weak.value);
  assert.match(strong.name, /^전설 /);
  assert.ok(better(strong, weak) && !better(weak, strong) && better(weak, null));
  const armor = rollItem(seq(.5, 0), 3);
  assert.equal(armor.slot, 'armor');
  assert.ok(armor.value > 0 && armor.value <= .6);
  assert.match(itemLine(armor), /받는 피해 −\d+%/);
  assert.equal(RARITIES.length, 4);
});

test('the authored contract accepts mechanics.style arpg and artDirection.biome, rejects others', () => {
  const minimal = (extra) => ({ version: 2, engine: 'three', title: 'T', genre: 'sf-shooter',
    palette: { bg: '#000000', accent: '#00e5ff', text: '#ffffff' }, player: { ipId: 'ip_a', speed: 2 }, enemies: [], props: [],
    world: { width: 40, depth: 40, spawn: { x: 0, z: 0 }, entities: [], propPlacements: [], enemySpawns: [] },
    mission: { stages: [{ id: 's1', type: 'survive', label: 'L', target: 10 }] }, ...extra });
  const ok = validateAuthoredSpec(minimal({ mechanics: { style: 'arpg' }, artDirection: { biome: 'ruins' } }));
  const bad = validateAuthoredSpec(minimal({ mechanics: { style: 'moba' }, artDirection: { biome: 'mars' } }));
  const msgs = (r) => (r.errors ?? []).join(' | ');
  assert.ok(!/style|biome/.test(msgs(ok)), msgs(ok));
  assert.match(msgs(bad), /mechanics\.style/);
  assert.match(msgs(bad), /artDirection\.biome/);
});

test('a set piece is its prop IP: the server GLB, or the server cutout as a standing panel (never for a car)', () => {
  const spec = (piece) => ({ version: 2, engine: 'three', title: 'T', genre: 'sf-survival',
    palette: { bg: '#000000', accent: '#00e5ff', text: '#ffffff' }, player: { ipId: 'ip_a', speed: 2 }, enemies: [], props: [],
    world: { width: 40, depth: 40, groundColor: '#223344', spawn: { x: 0, z: 0 }, propPlacements: [], enemySpawns: [],
      entities: [{ id: 'wire', kind: 'model', ipId: 'ip_wire', x: 5, z: 5, width: 4, depth: .8, height: 1.4, ...piece }] },
    mission: { stages: [{ id: 's1', type: 'survive', label: 'L', target: 10 }] } });
  const errors = (piece) => (validateAuthoredSpec(spec(piece)).errors ?? []).join(' | ');
  assert.equal(errors({ modelUrl: 'assets/ip_wire.set.glb' }), '');
  assert.equal(errors({ spriteUrl: 'assets/ip_wire.png' }), '');
  assert.match(errors({}), /modelUrl/); // nothing resolved: not playable
  assert.match(errors({ spriteUrl: 'https://evil.example/x.png' }), /modelUrl/);
  assert.match(errors({ spriteUrl: 'assets/ip_other.png' }), /modelUrl/); // another IP's image
  assert.match(errors({ spriteUrl: 'assets/ip_wire.png', car: 'player' }), /modelUrl/);
});

test('enemy blows rise by tier and stage, follow difficulty, and never take a big slice of the hero at once', () => {
  const hit = (o) => enemyHit({ maxHp: 240, ...o });
  assert.ok(hit({ tier: 'regular' }) < hit({ tier: 'champion' }) && hit({ tier: 'champion' }) < hit({ tier: 'boss' }));
  assert.ok(hit({ stage: 3 }) > hit({ stage: 0 }));
  assert.ok(hit({ ranged: true }) < hit({}));
  assert.ok(hit({ difficulty: 'easy' }) < hit({}) && hit({}) < hit({ difficulty: 'hard' }));
  assert.ok(hit({ tier: 'boss', enraged: true }) > hit({ tier: 'boss' }));
  assert.equal(hit({ difficulty: 'nope' }), hit({})); // unknown difficulty plays as normal
  // a stage-1 skeleton chips; the stage-4 elite and the boss hit harder than it
  assert.equal(hit({}), 6);
  assert.ok(hit({ tier: 'champion', stage: 3, maxHp: 255 }) >= 14);
  // a 50 HP hero is never two-shot by a boss, whatever the stage
  for (let stage = 0; stage < 8; stage++) assert.ok(enemyHit({ tier: 'boss', enraged: true, stage, maxHp: 50, difficulty: 'hard' }) <= 8);
  assert.ok(enemyHit({ maxHp: 1 }) >= 1);
});

test('attack slots and i-frames by difficulty; bosses and elites scale with the hero\'s damage', () => {
  assert.deepEqual(['easy', 'normal', 'hard'].map((d) => attackSlots(d)), [1, 2, 3]);
  assert.equal(attackSlots('normal', true), 4); // an arpg horde presses harder, with smaller blows
  assert.ok(BALANCE.easy.iframes > BALANCE.normal.iframes && BALANCE.normal.iframes > BALANCE.hard.iframes);
  // weapon 2 every 0.5 s = 4 DPS: a 3-HP template boss (×8 = 24) lasts 15 s
  assert.equal(toughness(24, 2 / .5, 15), 60);
  assert.equal(toughness(500, 4, 15), 500); // a template that is already tough keeps its HP
});

test('a flat cutout enemy walks, winds up, lunges and flashes instead of sliding', () => {
  const at = (o) => billboardPose({ time: 0, speed: 0, ...o });
  const walk = [.1, .25, .4, .55].map((time) => at({ time, speed: 2.2 }));
  assert.ok(Math.max(...walk.map((p) => p.lift)) > .03, 'walking hops'); // a step, in actor heights
  assert.ok(new Set(walk.map((p) => Math.sign(p.tilt))).size === 2, 'walking sways side to side');
  assert.equal(at({ time: .3 }).lift, 0); // standing still does not hop
  const windup = at({ windup: 1 });
  assert.ok(windup.squash > .1 && windup.tilt < 0, 'winding up crouches and leans back');
  const strike = at({ strike: .5 });
  assert.ok(strike.lunge > .3 && strike.tilt > 0, 'the blow lunges at the hero');
  assert.equal(at({ strike: 0 }).lunge, 0);
  assert.equal(at({ hit: .7 }).flash, .7);
  for (const p of [...walk, windup, strike]) for (const v of Object.values(p)) assert.ok(Math.abs(v) < .5 && Number.isFinite(v));
});

test('an enemy never appears next to the hero: a close placement moves out along its bearing, inside the world', () => {
  const hero = { x: -3, z: 28 };
  assert.deepEqual(clearSpawn({ x: 14, z: 22 }, hero, 12), { x: 14, z: 22 }); // already far enough
  const out = clearSpawn({ x: -10, z: 24 }, hero, 12); // an enemy placed 8 m from the resume point
  assert.ok(Math.abs(Math.hypot(out.x - hero.x, out.z - hero.z) - 12) < 1e-9);
  assert.ok(Math.abs(Math.atan2(out.z - hero.z, out.x - hero.x) - Math.atan2(-4, -7)) < 1e-9, 'same side of the hero');
  const bounds = { minX: -44.4, maxX: 44.4, minZ: -44.4, maxZ: 44.4 };
  const wall = clearSpawn({ x: 42, z: 40 }, { x: 40, z: 40 }, 12, bounds); // pushing east would leave the map
  assert.ok(wall.x <= bounds.maxX && wall.z <= bounds.maxZ && wall.x >= bounds.minX && wall.z >= bounds.minZ);
  assert.ok(Math.hypot(wall.x - 40, wall.z - 40) >= 12 - 1e-9);
  const onTop = clearSpawn({ x: 5, z: 5 }, { x: 5, z: 5 }, 6, bounds);
  assert.ok(Math.abs(Math.hypot(onTop.x - 5, onTop.z - 5) - 6) < 1e-9);
});

test('aim assist: a manual shot goes to the enemy nearest the crosshair, never to one off to the side or behind', () => {
  const from = { x: 0, z: 0 }; // yaw 0 looks down -z
  const pack = [{ x: 1.2, z: -14 }, { x: -6, z: -10 }, { x: 0, z: 9 }];
  assert.equal(assistTarget(from, 0, pack), 0); // 4.9° off the line at 14 m: the crossbow bends to it
  assert.equal(assistTarget(from, 0, [pack[1], pack[2]]), -1); // 31° to the side, and one behind
  assert.equal(assistTarget(from, Math.atan2(6, 10), pack), 1); // turn toward it and it is the one
  assert.equal(assistTarget(from, 0, [{ x: 3.5, z: -8 }]), -1); // 23.6°: not the crosshair's target
  assert.equal(assistTarget(from, 0, [{ x: 3.5, z: -8, boss: true }]), -1);
  assert.equal(assistTarget(from, 0, [{ x: 2.4, z: -8, boss: true }]), 0); // a boss is a bigger target
  assert.equal(assistTarget(from, 0, [{ x: 0, z: -60 }]), -1); // out of range
  assert.equal(assistTarget(from, 0, [{ x: 1, z: -20 }, { x: .2, z: -21 }]), 1); // the nearest to the line wins
});

test('auto-fire aims for the hero but at a slower rate, while a boss lasts its 15 s of the hero\'s aimed fire', () => {
  const mechanics = { fireIntervalSec: .5, weaponDamage: 2 };
  assert.equal(fireInterval(mechanics), .5);
  assert.ok(fireInterval(mechanics, true) >= .75, 'hands-off auto-fire is at least a third slower');
  // the boss lasts 24 s of auto-fire, about 1.6× its blows, unless the hero steps out of them
  const boss = toughness(24, mechanics.weaponDamage / mechanics.fireIntervalSec, 15);
  assert.equal(boss, 60);
  assert.ok(boss / (mechanics.weaponDamage / fireInterval(mechanics, true)) >= 22);
});
