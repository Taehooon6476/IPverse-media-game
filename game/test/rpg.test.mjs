import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.Phaser = { Scene: class {} }; // rpg.js extends Phaser.Scene at import time
const { knockbackTile } = await import('../rpg.js');

// 7x5 map, '#' wall, N the NPC. The left loop is open; column 5 is reachable only through the NPC tile.
const MAP = [
  '#######',
  '#...#.#',
  '#.#.#.#',
  '#...N.#',
  '#######',
];
const walls = MAP.map((row) => [...row].map((c) => c === '#'));
const npc = { x: 4, y: 3 };

test('far from the spawn: the monster returns to its spawn', () => {
  const wide = Array.from({ length: 12 }, (_, y) => Array.from({ length: 12 }, (_, x) => x === 0 || y === 0 || x === 11 || y === 11));
  assert.deepEqual(knockbackTile(wide, { x: 10, y: 10 }, { x: 9, y: 2 }, { x: 2, y: 2 }), { x: 9, y: 2 });
});

test('near the spawn: farthest reachable floor tile, never a wall or the NPC tile', () => {
  const to = knockbackTile(walls, npc, { x: 1, y: 2 }, { x: 1, y: 1 });
  assert.deepEqual(to, { x: 3, y: 3 }); // 4 steps from the player; column 5 is behind the NPC
  assert.equal(walls[to.y][to.x], false);
  assert.notDeepEqual(to, npc);
});

test('a spawn on the player tile still moves the monster away', () => {
  const to = knockbackTile(walls, npc, { x: 3, y: 3 }, { x: 3, y: 3 });
  assert.notDeepEqual(to, { x: 3, y: 3 });
  assert.equal(walls[to.y][to.x], false);
  assert.notDeepEqual(to, npc);
});
