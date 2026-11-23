import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { THREE, authoredMode, published } from './fixtures/headless.mjs';
import * as rules from '../arpg-data.js';
import { MissionDirector } from '../mission.js';

// An ARPG crypt (gm_b870737b47): three rooms in a row, a wall between each two with one door (x -6 … 6 in the wall
// at z -18, x -40 … -30 in the one at z 22). The arrow names the way on foot through the door, not the straight
// bearing through the wall, and the wall the ARPG's camera cuts away keeps a low edge.
const SOURCE = readFileSync(new URL('../authored.js', import.meta.url), 'utf8');
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const foe = (id, x, z, more = {}) => ({ id, enemyIndex: 0, pos: new THREE.Vector3(x, 0, z), hp: 3, ...more });
/** The arrow this frame: null when hidden, else what its label names, the metres on it and its bearing on screen. */
function arrow(m) {
  m.pointToGoal(m.director.stage);
  const a = m.goalArrow, label = a.firstChild;
  if (a.hidden) return null;
  const [, word, metres] = /^➤ (?:(\S+) )?(\d+)m$/.exec(label.textContent) ?? [];
  assert.ok(metres, `the label reads '${label.textContent}'`);
  return { word: word ?? '', metres: Number(metres), bearing: Math.atan2(parseFloat(label.style.left), -parseFloat(label.style.top)) };
}
/** Where the arrow's line from the hero meets the line z = `z` (a wall's face): its x there, or null when it points away. */
function meets(m, shown, z) {
  const p = m.player.pos, world = shown.bearing - m.world.rig.yaw; // atan2(dx, -dz)
  const dx = Math.sin(world), dz = -Math.cos(world), t = (z - p.z) / dz;
  return t > 0 ? p.x + dx * t : null;
}
/** The crypt in play at stage `stage` (the ones before it done), the hero at `at`, with these enemies alive. Their
 * models do not load here: they are the records the fight keeps. The camera is the ARPG's (arpg.js setup). */
function crypt(stage, at, enemies = []) {
  const m = authoredMode(published('gm_b870737b47'), { autoplay: false });
  m.phase = 'playing';
  for (let k = 0; k < stage; k++) {
    m.director.progress = m.director.stage.target;
    m.completeStage(m.director.update(.016, { position: { x: 0, y: 0, z: -52 }, targets: m.targets }));
  }
  assert.equal(m.director.index, stage);
  Object.assign(m, { pendingSpawns: [], enemies });
  m.world.rig.yaw = Math.PI / 4;
  m.player.pos.set(at.x, 0, at.z);
  return m;
}
/** A person who holds the keys toward the arrow (W up the screen, D to its right: the nearest of the eight ways the
 * keys give) for up to `seconds`. → the seconds until the arrow hid (its goal is at hand), or null: still walking. */
function follow(m, seconds) {
  const keys = { x: 0, y: 0 };
  const input = { moveAxes: () => { const len = Math.hypot(keys.x, keys.y); return len > 1 ? { x: keys.x / len, y: keys.y / len } : { ...keys }; },
    down: () => false, hit: () => false, pad: null };
  for (let t = 0; t < seconds; t += 1 / 60) {
    const shown = arrow(m);
    if (!shown) return t;
    const way = Math.round(shown.bearing / (Math.PI / 4)) * Math.PI / 4;
    Object.assign(keys, { x: Math.round(Math.sin(way)), y: Math.round(Math.cos(way)) });
    m.elapsed += 1 / 60;
    m.player.update(1 / 60, input, m.world.rig);
  }
  return null;
}

test('ARPG gm_b870737b47, stage 2: the arrow leads to the door, not through the wall between the rooms', () => {
  // room 1, east of the door, the enemies that count in room 2
  const elite = foe('wr2_a', 0, -4, { enemyIndex: 1 });
  const m = crypt(1, { x: 13.46, z: -24.18 }, [elite, foe('sk2_d', 12, 6), foe('sk1_b~1', 30, -40, { packMate: true })]);
  const shown = arrow(m);
  assert.ok(shown, 'no arrow');
  assert.equal(shown.word, '적');
  const x = meets(m, shown, -18.75);
  assert.ok(x != null && Math.abs(x) < 6 - .45, `the arrow's line meets the wall between the rooms at x ${x?.toFixed(1)}: its door is x -6 … 6`);
  // the label is the way to walk, not the line through the wall
  const straight = Math.hypot(elite.pos.x - 13.46, elite.pos.z + 24.18);
  assert.ok(shown.metres > Math.round(straight) && shown.metres < straight * 1.5, `'적 ${shown.metres}m' for a walk round the wall (${straight.toFixed(1)} m in a straight line)`);
  m.world.input.dispose();
});

test('a person who holds the keys toward the arrow walks through the door and reaches the fight', () => {
  for (const at of [{ x: 13.46, z: -24.18 }, { x: -40, z: -50 }, { x: 50, z: -20 }]) {
    const m = crypt(1, at, [foe('wr2_a', 0, -4, { enemyIndex: 1 }), foe('wr2_c', 38, 14, { enemyIndex: 1 }), foe('wr2_b', -38, 14, { enemyIndex: 1 })]);
    const first = arrow(m);
    const took = follow(m, 30), p = m.player.pos;
    assert.ok(took != null, `from (${at.x}, ${at.z}): 30 s toward '➤ 적 ${first?.metres}m' and the hero stands at (${p.x.toFixed(1)}, ${p.z.toFixed(1)})`);
    assert.ok(p.z > -17.25, `the hero is in the second room (z ${p.z.toFixed(1)})`);
    m.world.input.dispose();
  }
});

test('a reach stage past a wall: the arrow leads through that wall\'s door', () => {
  // stage 3, '왼쪽 문을 지나 해골 왕의 홀 입구로 가라': the gate stands behind the wall at z 22, its door is x -40 … -30
  const m = crypt(2, { x: 20, z: 0 });
  const shown = arrow(m);
  const x = meets(m, shown, 21.25);
  assert.ok(x != null && x > -40 + .45 && x < -30 - .45, `the arrow's line meets the hall's wall at x ${x?.toFixed(1)}: its door is x -40 … -30`);
  const took = follow(m, 40);
  assert.ok(took != null && m.player.pos.z > 22.75, `the hero reached the gate's room: ${JSON.stringify(m.player.pos.toArray().map((n) => +n.toFixed(1)))}`);
  m.world.input.dispose();
});

test('in plain sight the arrow is the straight line and the straight distance, as before', () => {
  const enemy = foe('sk2_a', -20, -10);
  const m = crypt(1, { x: 10, z: -10 }, [enemy]);
  const shown = arrow(m), p = m.player.pos;
  assert.equal(shown.metres, 30);
  assert.ok(Math.abs(wrap(shown.bearing - Math.atan2(enemy.pos.x - p.x, -(enemy.pos.z - p.z)) - m.world.rig.yaw)) < 1e-6);
  // within the fight's reach of it: hidden
  m.player.pos.set(-10, 0, -10);
  assert.equal(arrow(m), null);
  // behind the wall the same 10 m are no fight: the arrow stays, to the door
  m.player.pos.set(-20, 0, -22);
  const behind = arrow(m);
  assert.ok(behind && behind.metres > 12, `10 m from it through the wall: ${JSON.stringify(behind)}`);
  m.world.input.dispose();
});

test('of the enemies that count the arrow names the one nearest on foot, not the one nearest through a wall', () => {
  // from the first room's east end: the elite at (38, 14) is 36 m off through the wall, the one at (0, -4) is 52 m off
  // and the nearer walk (the door is at x 0)
  const m = crypt(1, { x: 50, z: -20 }, [foe('wr2_c', 38, 14, { enemyIndex: 1 }), foe('wr2_a', 0, -4, { enemyIndex: 1 })]);
  const shown = arrow(m);
  assert.ok(shown.metres >= 58 && shown.metres <= 66, `'적 ${shown.metres}m': the walk to the elite by the door is about 62 m, to the other about 95 m`);
  // the number goes down as the hero walks the way (it does not jump between the two)
  const seen = [shown.metres];
  for (const x of [44, 38, 32, 26, 20, 14, 8]) { m.player.pos.set(x, 0, -20); m.elapsed += 1; seen.push(arrow(m).metres); }
  assert.ok(seen.every((metres, n) => n === 0 || (metres < seen[n - 1] && metres > seen[n - 1] - 9)), `the label along the way: ${seen.join(', ')}`);
  m.world.input.dispose();
});

test('the search for the nearest goal on foot: one search for all of them, no way through a wall, none when walled in', () => {
  const { navGrid, navNearest, navPath } = rules;
  assert.equal(typeof navNearest, 'function');
  // a 40 × 20 m hall cut in two by a wall along z 0 with a door at its east end (x 16 … 19)
  const walls = [{ minX: -20, maxX: 16, minZ: -.5, maxZ: .5 }, { minX: 19, maxX: 20, minZ: -.5, maxZ: .5 }];
  const g = navGrid(walls, { width: 40, depth: 20 }, { radius: .55 });
  const length = (from, path) => path.reduce((n, p, i) => n + Math.hypot(p.x - (i ? path[i - 1].x : from.x), p.z - (i ? path[i - 1].z : from.z)), 0);
  const from = { x: -15, z: -5 }, across = { x: -15, z: 5 }, sameRoom = { x: 10, z: -6 };
  // 10 m off through the wall, 25 m off in the same room: the second is the nearer walk
  const near = navNearest(g, from, [across, sameRoom]);
  assert.equal(near.index, 1);
  assert.deepEqual(near.path.at(-1), sameRoom, 'the way ends at the goal itself');
  // alone, the one across is reached through the door, by a way as long as navPath's own
  const round = navNearest(g, from, [across]);
  assert.equal(round.index, 0);
  assert.ok(round.path.some((p) => p.x > 16 && p.x < 19 && Math.abs(p.z) < 1), 'the way goes through the door');
  assert.ok(Math.abs(length(from, round.path) - length(from, navPath(g, from, across))) < 1, `${length(from, round.path).toFixed(1)} m`);
  // the door shut: no way
  const shut = navGrid([...walls, { minX: 16, maxX: 19, minZ: -.5, maxZ: .5 }], { width: 40, depth: 20 }, { radius: .55 });
  assert.equal(navNearest(shut, from, [across]), null);
  assert.equal(navNearest(g, from, []), null);
  // a way longer than a 32-bit cost keeps exact (a 300 m hall, wall to wall): found, and no longer than it has to be
  const long = navGrid([{ minX: -150, maxX: 140, minZ: -.5, maxZ: .5 }], { width: 300, depth: 20 }, { radius: .55, cell: 1 });
  const far = navNearest(long, { x: -140, z: -5 }, [{ x: -140, z: 5 }]);
  assert.ok(far && length({ x: -140, z: -5 }, far.path) < 620, `a ${far ? length({ x: -140, z: -5 }, far.path).toFixed(0) : 'missing'} m way round a 290 m wall`);
});

test('the way is searched twice a second, not every frame: also for pickups, whose places are listed anew each frame', () => {
  // a collect stage's crate behind the wall (a stand-in: the crypt's own pickups are bonus potions)
  const m = crypt(1, { x: 13.46, z: -24.18 });
  m.director = new MissionDirector({ stages: [{ id: 'supply', type: 'collect', label: '보급 상자를 주워라', target: 1 }] });
  m.pickups = [{ taken: false, stage: 'supply', group: { position: new THREE.Vector3(20, 0, -5) } }];
  const first = arrow(m), plan = m.arrowPlan;
  assert.ok(first && plan?.path, 'the arrow leads round to the crate');
  for (let frame = 0; frame < 20; frame++) { m.elapsed += 1 / 60; arrow(m); } // a third of a second
  assert.equal(m.arrowPlan, plan, 'a new search every frame');
  m.elapsed += .4;
  arrow(m);
  assert.notEqual(m.arrowPlan, plan, 'and a new one after half a second');
  // an enemy that counts: the same, and at once when it is felled
  const a = foe('wr2_a', 0, -4, { enemyIndex: 1 }), b = foe('wr2_c', 38, 14, { enemyIndex: 1 });
  const fight = crypt(1, { x: 13.46, z: -24.18 }, [a, b]);
  arrow(fight);
  const before = fight.arrowPlan;
  fight.elapsed += .1; arrow(fight);
  assert.equal(fight.arrowPlan, before);
  assert.equal(before.goal, a.pos);
  fight.enemies = [b];
  fight.elapsed += .1; arrow(fight);
  assert.equal(fight.arrowPlan.goal, b.pos, 'the arrow went on pointing at a felled enemy');
  m.world.input.dispose(); fight.world.input.dispose();
});

test('a goal no way leads to keeps the straight arrow; the built-in player\'s own plan is not touched', () => {
  const enemy = foe('sk2_a', 30, -5);
  const m = crypt(1, { x: 13.46, z: -24.18 }, [enemy]);
  // (walled in on all four sides)
  for (const [x, z, w, d] of [[30, -9, 10, 1], [30, -1, 10, 1], [26, -5, 1, 9], [34, -5, 1, 9]]) {
    m.boxes.push({ min: new THREE.Vector3(x - w / 2, 0, z - d / 2), max: new THREE.Vector3(x + w / 2, 5, z + d / 2) });
  }
  const shown = arrow(m), p = m.player.pos;
  assert.equal(shown.metres, Math.round(Math.hypot(enemy.pos.x - p.x, enemy.pos.z - p.z)));
  assert.ok(Math.abs(wrap(shown.bearing - Math.atan2(enemy.pos.x - p.x, -(enemy.pos.z - p.z)) - m.world.rig.yaw)) < 1e-6);
  for (const key of ['navFor', 'navBest', 'navGain', 'navPath', 'navGoal', 'navAt']) assert.equal(m[key], undefined, `the arrow wrote the built-in player's ${key}`);
  m.world.input.dispose();
});

test('a platformer\'s arrow stays the straight line: its way is a climb, not a walk round', () => {
  const m = authoredMode(published('gm_5e7199df8f'), { autoplay: false });
  m.phase = 'playing';
  m.director.index = 2; // '탑 꼭대기 깃발에 도착하기'
  const flag = m.targets.find((t) => t.id === 'flag'), p = m.player.pos;
  const shown = arrow(m);
  assert.equal(shown.metres, Math.round(Math.hypot(flag.x - p.x, flag.z - p.z)));
  assert.ok(Math.abs(wrap(shown.bearing - Math.atan2(flag.x - p.x, -(flag.z - p.z)) - m.world.rig.yaw)) < 1e-6);
  m.world.input.dispose();
});

test('a wall the ARPG\'s camera cuts away keeps a low edge: its footprint, in sight under the faded wall', () => {
  const { EDGE, wallEdge } = rules;
  assert.equal(typeof wallEdge, 'function', 'arpg-data.js has no wallEdge: a cut-away wall leaves nothing to see');
  const box = (x0, y0, z0, x1, y1, z1) => ({ min: new THREE.Vector3(x0, y0, z0), max: new THREE.Vector3(x1, y1, z1) });
  // w1_d, the wall the probe walked into: x 6 … 20, z -18.75 … -17.25, 5 m high
  const edge = wallEdge(box(6, 0, -18.75, 20, 5, -17.25));
  assert.ok(edge, 'no edge for the wall between the rooms');
  assert.ok(Math.abs(edge.x - 13) < 1e-9 && Math.abs(edge.z + 18) < 1e-9, 'under the wall');
  assert.ok(edge.width > 14 && edge.width < 14.2 && edge.depth > 1.5 && edge.depth < 1.7, `the wall's own footprint, a little proud of it: ${edge.width} × ${edge.depth}`);
  assert.ok(edge.height === EDGE.height && edge.height >= .3 && edge.height <= .6, `a low edge the hero is seen over: ${edge.height} m`);
  assert.ok(Math.abs(edge.y - edge.height / 2) < 1e-9, 'standing on the floor');
  // not what is no wall on the floor: an arch's beam overhead, a step the hero walks onto, a slab no higher than the edge
  assert.equal(wallEdge(box(-34, 8.2, -13, -26, 9, -11)), null);
  assert.equal(wallEdge(box(0, 0, 0, 4, .3, 4)), null);
  // it is drawn outside the group the camera fades (world.js fadeTo clones and fades every mesh under an occluder's
  // root), only under the ARPG's fixed camera, for the dungeon's own shell too
  assert.match(SOURCE, /this\.root\.add\(edge\)/);
  assert.match(SOURCE, /if \(!this\.arpg\b[^\n]*\) return;[^\n]*\n[^\n]*wallEdge\(/, 'only where the camera is the ARPG\'s');
  assert.match(SOURCE, /for \(const wall of this\.shellWalls[^\n]*\) this\.edge\(/);
  // a wall turned off the world's axes gets none: its collider is the box around it, and that is not the wall's shape
  assert.match(SOURCE, /WALLS\.has\(e\.kind\) && Math\.abs\(Math\.sin\(2 \* \(e\.rotation \?\? 0\)\)\) < 1e-3\) for \(const box of own\) this\.edge\(box, mat, e\.kind === 'cylinder'\);/); // (a pillar's is round)
});
