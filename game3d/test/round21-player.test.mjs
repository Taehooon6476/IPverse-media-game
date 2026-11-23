import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { RUNTIME, climbMode, playRound, published } from './fixtures/headless.mjs';

// The built-in player (?autoplay=1) climbs:
// - a sky climb whose first island stands on the start island (their footprints overlap, 1.2 m up): it is stepped
//   onto from beside it, and the start camera faces it.
// - platformers on a floor (no sky setting): they have a climb too. Their first platform is 1.6 m and 1.4 m up, over
//   the contract's 1.2 m step and within what the hero jumps beside a top.
// The rounds are run as boot() runs them (fixtures/headless.mjs climbMode: the tops, the moving platforms, the coins and
// the props of the stored spec; the built-in player's loop read out of runtime3d.js).
const { CLIMB, canStep, climbNodes, climbStep, skyIslands } = await import('../sky.js');
const STUCK = /const BOT_END = \{ cap: '([^']+)', stuck: '([^']+)' \};/.exec(RUNTIME).slice(1);

/** A round of `id` under the built-in player. `phase`: where its moving platforms are in their travel (0-1; else as
 * the spec's seed puts them). → the round, with the hero's jumps, its falls and where the camera looked at the start */
function play(id, { fps = 30, phase = null, trace = null } = {}) {
  const mode = climbMode(published(id));
  if (phase != null) mode.movers.forEach((m, i) => { m.phase = (phase + i * .37) * Math.PI * 2; });
  const startYaw = mode.world.rig.yaw, popup = mode.hud.popup;
  let falls = 0, jumps = 0, air = false;
  mode.hud.popup = (text, ...rest) => { if (/추락/.test(text)) falls += 1; popup(text, ...rest); };
  const round = playRound(mode, { seconds: 200, fps, each: (m) => {
    if (!m.player.grounded && !air) jumps += 1;
    air = !m.player.grounded;
    trace?.push(`${m.player.pos.toArray().map((n) => n.toFixed(4)).join(',')}|${m.world.rig.yaw.toFixed(4)}`);
  } });
  return { ...round, falls, jumps, startYaw, hp: mode.hp };
}
const say = (r) => `${r.won ? 'clear' : 'loss'} after ${r.seconds} s (${r.failure ?? r.reason}; stage ${r.mission.stageIndex + 1}, ${r.jumps} jumps, ${r.falls} falls)`;

test('sky gm_8e8d7902ed: the start camera faces the first island, and the built-in player climbs to the post office', () => {
  const r = play('gm_8e8d7902ed');
  // the first island (plat_start) is due east (+x) of the spawn: yaw -90° looks that way (yaw 0 looks along -z)
  assert.ok(Math.abs(r.startYaw + Math.PI / 2) < 1e-6, `the start camera's yaw is ${r.startYaw.toFixed(2)}: it looks away from the first island`);
  assert.deepEqual([r.won, r.reason], [true, 'clear'], say(r));
  assert.ok(r.jumps >= 14 && r.seconds < 60, say(r)); // 15 tops to the post office
  assert.equal(r.falls, 0, say(r));
});

test('a first goal that stands on the start island itself is what the start camera faces, as before', () => {
  const mode = climbMode(published('gm_8f1fc9a181'));
  Object.assign(mode.targets.find((t) => t.id === 'coin1'), { x: 3, z: 27 }); // on the start island (x -4 … 4, z 20 … 28), by the spawn (0, 24)
  mode.world.rig.yaw = 0;
  mode.faceFirstGoal();
  assert.ok(Math.abs(mode.world.rig.yaw - Math.atan2(-3, -3)) < 1e-9, `yaw ${mode.world.rig.yaw.toFixed(2)}: the camera does not face the coin 4 m away`);
  mode.world.input.dispose();
});

test('platformers on a floor, gm_1e7d17bbb0 and gm_5e7199df8f: the built-in player jumps onto the first platform and plays the round out', () => {
  for (const id of ['gm_1e7d17bbb0', 'gm_5e7199df8f']) {
    const r = play(id);
    assert.ok(r.jumps > 0, `${id}: it never jumped: ${say(r)}`);
    assert.deepEqual([r.won, r.reason], [true, 'clear'], `${id}: ${say(r)}`);
    assert.ok(!STUCK.includes(r.failure), `${id}: ${say(r)}`);
    assert.ok(r.seconds < 60, `${id}: ${say(r)}`);
  }
});

test('wherever the moving platforms are and whatever the frame rate, the three rounds are cleared', () => {
  // (a broadcast's built-in player may draw 20 frames a second; a platform's place in its travel is the build's)
  for (const id of ['gm_8e8d7902ed', 'gm_1e7d17bbb0', 'gm_5e7199df8f']) {
    for (const fps of [20, 60]) for (const phase of [0, .25, .5, .75]) {
      const r = play(id, { fps, phase });
      assert.deepEqual([r.won, r.reason], [true, 'clear'], `${id} at ${fps} fps, phase ${phase}: ${say(r)}`);
      assert.ok(r.falls <= 2 && r.hp > 50, `${id} at ${fps} fps, phase ${phase}: ${say(r)}`);
    }
  }
});

test('the sky game it wins (gm_8f1fc9a181, the same climb as gm_494550db34) is played as before, frame for frame', () => {
  // the hero's place and the camera's yaw in every frame of the round, as recorded for this fixture: the same frames
  // at each frame rate
  const BEFORE = { 20: ['105781a2abb9', 176, 8.8], 30: ['fab2d7509c38', 245, 8.2], 60: ['df9229634810', 505, 8.4] };
  for (const [fps, [hash, frames, seconds]] of Object.entries(BEFORE)) {
    const trace = [], r = play('gm_8f1fc9a181', { fps: Number(fps), trace });
    assert.deepEqual([r.won, r.falls, r.seconds, trace.length], [true, 0, seconds, frames], `${fps} fps: ${say(r)}`);
    assert.equal(createHash('sha1').update(trace.join('\n')).digest('hex').slice(0, 12), hash, `${fps} fps: the round is not the one it played before`);
  }
});

test('a step up beside the hero may be as high as the hero gets; a step across a gap keeps the contract\'s limits', () => {
  const top = (id, x, z, width, depth, y) => ({ id, x, z, width, depth, rotation: 0, top: y });
  const floor = top('floor', 0, 0, 80, 80, 0), first = top('plat_start', -34, 0, 6, 6, 1.6); // a first step 1.6 m up
  assert.equal(canStep(floor, first), false, 'by the contract a 1.6 m step is none');
  assert.equal(canStep(floor, first, 1.66), true, 'the hero gets onto it from beside it');
  assert.equal(canStep(floor, top('high', 0, 0, 4, 4, 2), 1.66), false);
  // across a gap the limits are the contract's, whatever the reach
  const a = top('a', 0, 0, 4, 4, 1), b = top('b', 5, 0, 4, 4, 2.5);
  assert.equal(canStep(a, b, 1.66), false, 'a 1 m gap and 1.5 m up');
  assert.equal(canStep(a, top('c', 5, 0, 4, 4, 1 + CLIMB.rise), 1.66), true);
});

test('a top that stands on the one underfoot is stepped onto from beside it: the jump comes before its side stops the hero', () => {
  const world = published('gm_8e8d7902ed').world;
  const nodes = climbNodes(skyIslands(world), world.entities.filter((e) => e.kind === 'platform'));
  const home = nodes.find((n) => n.id === 'home'), letter = { x: -9, z: 3 }, state = {};
  // the spawn: straight at the island's near side (x -37), no run back to a point behind
  const first = climbStep(nodes, { x: -38.5, z: 0 }, letter, home, state, { x: 0, z: 0 });
  assert.equal(first.next.id, 'plat_start');
  assert.ok(first.x > -37 && first.x < -35 && Math.abs(first.z) < 1e-9, `it aims at (${first.x}, ${first.z})`);
  assert.equal(first.jump, false, 'not yet at its side');
  // running at it, three quarters of a metre before its side (the hero's body is stopped .45 m from it): jump
  const at = climbStep(nodes, { x: -37.6, z: 0 }, letter, home, state, { x: 6.4, z: 0 });
  assert.deepEqual([at.jump, at.stop], [true, false]);
  // pressed against the side, still running into it: jump (the start island's edge, x -34.5, lies behind that side)
  assert.equal(climbStep(nodes, { x: -37.45, z: 0 }, letter, home, state, { x: 6.4, z: 0 }).jump, true);
  // in the air over it the aim stays on it
  const over = climbStep(nodes, { x: -36.5, z: 0 }, letter, home, state, { x: 6.4, z: 0 });
  assert.ok(over.x > -36.5 && over.jump === false);
});

test('on a platformer\'s floor a goal that is down there is walked to as before (round the walls), and a stage with no climb is left alone', () => {
  const mode = climbMode(published('gm_5e7199df8f'));
  assert.equal(mode.climbToward({ x: 20, z: 20 }), null, 'a goal on the floor: the walk grid\'s way');
  const up = mode.climbToward({ x: -24, z: -30 }); // the first potion, on the first platform
  assert.equal(up.next.id, 'p1');
  mode.world.input.dispose();
  // a world that is neither sky nor platformer has no climb at all
  const crypt = climbMode(published('gm_b870737b47'));
  assert.equal(crypt.climbGrounds, null);
  assert.equal(crypt.climbToward({ x: 0, z: -4 }), null);
  crypt.world.input.dispose();
});

// autoUnstick() puts climbBest back to Infinity every 10 s: the next frame's first reading must not count as a
// gain, or the watchdog never ends a stalled climb.
test('a climb that makes no way is ended by the watchdog, not by the round\'s cap', () => {
  const mode = climbMode(published('gm_1e7d17bbb0'));
  const start = mode.player.pos.clone();
  const round = playRound(mode, { seconds: 200, fps: 30, each: (m) => { m.player.pos.copy(start); m.player.velocity?.set?.(0, 0, 0); } });
  assert.equal(round.won, false);
  assert.equal(round.failure, STUCK[1], `ended by "${round.failure ?? round.reason}" after ${round.seconds} s`);
  assert.ok(round.seconds < 70, `ended after ${round.seconds} s`);
});
