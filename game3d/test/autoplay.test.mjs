// The built-in player of the live broadcast (?autoplay=1): it walks around walls, and its rounds always end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { navClear, navGrid, navNext, navPath, roundWatch, WATCHDOG } from '../arpg-data.js';

// an entrance room and corridor: the hero at (-3.1, 37), pressed against the corner of the room's north wall
// (x -14..-3 at z 36), walking straight at a skeleton in the hall beyond
const box = (x, z, w, d) => ({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 });
const dungeon = [box(-8.5, 36, 11, 1), box(8.5, 36, 11, 1), box(-3, 30, 1, 12), box(3, 30, 1, 12),
  box(-11.5, 24, 17, 1), box(11.5, 24, 17, 1), box(-14, 46, 1, 20), box(14, 46, 1, 20)];
const world = { width: 120, depth: 120 };

test('the walk grid blocks walls with the body radius and leaves the corridor open', () => {
  const g = navGrid(dungeon, world, { radius: .5 });
  assert.equal(navClear(g, { x: -3.1, z: 37.5 }, { x: -12, z: 20 }), false); // straight through the wall corner
  assert.equal(navClear(g, { x: 0, z: 37 }, { x: 0, z: 25 }), true); // down the 5 m corridor
});

test('the path from the stuck corner to the hall goes through the corridor, not into the wall', () => {
  const g = navGrid(dungeon, world, { radius: .5 });
  const path = navPath(g, { x: -3.1, z: 37 }, { x: -12, z: 20 });
  assert.ok(path && path.length > 5);
  assert.deepEqual(path.at(-1), { x: -12, z: 20 });
  // every point is walkable and the walk passes the corridor (|x| < 2.5 at z 30)
  for (let n = 1; n < path.length; n++) assert.ok(navClear(g, path[n - 1], path[n]), `segment ${n}`);
  assert.ok(path.some((p) => Math.abs(p.z - 30) < 1 && Math.abs(p.x) < 2.5));
  const next = navNext(g, { x: -3.1, z: 37 }, path);
  assert.ok(navClear(g, { x: -3.1, z: 37 }, next) && next.x > -3, 'first heads off the corner toward the corridor');
});

test('no way there: null; a goal inside a wall margin snaps to the nearest walkable cell', () => {
  const sealed = navGrid([box(0, 0, 10, 1), box(0, 10, 10, 1), box(-5, 5, 1, 11), box(5, 5, 1, 11)], { width: 40, depth: 40 });
  assert.equal(navPath(sealed, { x: 0, z: 5 }, { x: 15, z: 15 }), null);
  const g = navGrid(dungeon, world);
  assert.ok(navPath(g, { x: 0, z: 40 }, { x: -3, z: 36.2 })); // on the wall itself
});

test('a big city world gets coarse cells (bounded work)', () => {
  const g = navGrid([], { width: 600, depth: 600 });
  assert.ok(g.w <= 160 && g.h <= 160 && g.cell >= 3.75);
});

test('the watchdog: progress resets it; a stall asks for one unstick, then ends the round as a loss', () => {
  let w = roundWatch(null, 'a', 0);
  assert.equal(w.action, null);
  w = roundWatch(w.state, 'b', 5); // progress
  w = roundWatch(w.state, 'b', 5 + WATCHDOG.unstickSec - .1);
  assert.equal(w.action, null);
  w = roundWatch(w.state, 'b', 5 + WATCHDOG.unstickSec);
  assert.equal(w.action, 'unstick');
  w = roundWatch(w.state, 'b', 5 + WATCHDOG.unstickSec + 1);
  assert.equal(w.action, null, 'one unstick per stall');
  w = roundWatch(w.state, 'b', 5 + WATCHDOG.limitSec);
  assert.equal(w.action, 'end');
  w = roundWatch(w.state, 'c', 5 + WATCHDOG.limitSec + 1); // a new round (or any progress) starts over
  assert.equal(w.action, null);
});

// what the play window relies on, read from the runtime source (it needs a browser to run)
const runtime = readFileSync(new URL('../runtime3d.js', import.meta.url), 'utf8');

test('every round end counts: hud.end raises the count and fires ipverse:round for a clear, a death and a timeout', () => {
  const end = runtime.slice(runtime.indexOf('hud.end = (won'), runtime.indexOf('let held = false'));
  assert.match(end, /rounds \+= 1;/);
  assert.doesNotMatch(end.slice(0, end.indexOf('rounds += 1')), /if \(!?won\)|won \?.*return/, 'no outcome gate before the count');
  assert.match(end, /new CustomEvent\('ipverse:round', \{ detail: \{ rounds, won, reason/);
});

test('autoplay: the briefing is started by the built-in player, and again whenever it still waits', () => {
  assert.match(runtime, /if \(autoplay \|\| \(playableSec && !standby\)\) setTimeout\(\(\) => briefingStart\?\.onclick\?\.\(\), 300\)/);
  assert.match(runtime, /mode\?\.phase === 'ready' && startReady[\s\S]{0,120}briefingStart\?\.onclick\?\.\(\)/);
});
