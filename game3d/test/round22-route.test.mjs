import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { authoredMode, fightMode, playFight, published } from './fixtures/headless.mjs';
import { navGrid, navNearest, navPath } from '../arpg-data.js';

// navPath, the built-in player's route, keeps its costs in doubles, as it queues and compares them. A cost read
// back from a Float32Array is not the one that was queued: past about 16 m the rounding is more than the 1e-6 the
// "stale entry" test allows, the entry is thrown away and the search stops there (no way found, or a longer one).
// Checked in the crypt (gm_b870737b47, three rooms in a row, 120 x 120 m, 1 m cells).
const length = (path, from) => path.reduce((sum, p, i) => sum + Math.hypot(p.x - (i ? path[i - 1] : from).x, p.z - (i ? path[i - 1] : from).z), 0);
function cryptGrid() {
  const mode = authoredMode(published('gm_b870737b47'), { autoplay: false });
  const grid = navGrid(mode.navRects(), mode.spec.world, { radius: .55 }); // as authored.js navToward builds it
  mode.world.input.dispose();
  return grid;
}

test('navPath finds the long ways of the crypt: from the boss hall back through both doors', () => {
  const grid = cryptGrid();
  for (const [from, to] of [[{ x: 0, z: 48 }, { x: 0, z: -4 }], [{ x: 0, z: 48 }, { x: 38, z: 14 }], [{ x: 0, z: 48 }, { x: 0, z: -52 }]]) {
    const path = navPath(grid, from, to);
    assert.ok(path, `from (${from.x}, ${from.z}) no way to (${to.x}, ${to.z}): the search dropped the route`);
    assert.deepEqual(path.at(-1), to);
    // every step is a neighbour cell's: a way, not a jump through a wall
    for (let n = 1; n < path.length - 1; n++) assert.ok(Math.hypot(path[n].x - path[n - 1].x, path[n].z - path[n - 1].z) < 1.5);
  }
});

test('and its way is the short one: as long as the search of every cell finds (navNearest), not a quarter longer', () => {
  const grid = cryptGrid();
  for (const [from, to] of [[{ x: 55, z: -55 }, { x: 0, z: 48 }], [{ x: 0, z: -52 }, { x: 0, z: 48 }], [{ x: 55, z: -55 }, { x: -35, z: 30 }], [{ x: 0, z: 48 }, { x: 0, z: -4 }]]) {
    const path = navPath(grid, from, to), least = navNearest(grid, from, [to]).path;
    // (within a cell or so: the two end in the goal's cell by different last steps)
    assert.ok(path && Math.abs(length(path, from) - length(least, from)) < 1.5,
      `from (${from.x}, ${from.z}) to (${to.x}, ${to.z}): ${path && length(path, from).toFixed(1)} m where ${length(least, from).toFixed(1)} m exists`);
  }
  assert.match(readFileSync(new URL('../arpg-data.js', import.meta.url), 'utf8').split('export function navPath')[1].split('\nexport ')[0], /new Float64Array/,
    'navPath keeps its costs in the doubles it compares them with');
});

test('the built-in player still clears the crypt, in the time it took', async () => {
  // (its rooms are short ways, which the search always finds)
  const round = await playFight(fightMode(published('gm_b870737b47')), { seconds: 200, fps: 30 });
  assert.deepEqual([round.won, round.reason], [true, 'clear'], `${round.failure ?? round.reason} after ${round.seconds} s`);
  assert.ok(round.seconds > 60 && round.seconds < 76, `${round.seconds} s (69.9 s before)`);
});
