import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RUNTIME, THREE, fightMode, playFight, published } from './fixtures/headless.mjs';

// gm_b1188dcc0c (hard; four minions, then a boss with three more) under the built-in player. The boss's blow (24,
// then 29 once it is enraged) comes every 3.1 s and lands within 3.6 m, and the auto-fire needs about 24 s for the
// boss: the built-in player must step out of the blows to win.
// The rounds here are the stored spec's, with stand-ins for the models (fixtures/headless.mjs fightMode, playFight).
const say = (r, mode) => `${r.won ? 'clear' : 'loss'} after ${r.seconds} s (${r.failure ?? r.reason}; stage ${r.mission.stageIndex + 1}, ${Math.round(mode.hp)} HP left)`;

test('gm_b1188dcc0c: the built-in player beats the boss at any frame rate, with HP to spare', async () => {
  for (const fps of [20, 30, 45, 60]) {
    const mode = fightMode(published('gm_b1188dcc0c'));
    const round = await playFight(mode, { seconds: 240, fps });
    assert.deepEqual([round.won, round.reason], [true, 'clear'], `${fps} frames a second: ${say(round, mode)}`);
    assert.ok(mode.hp >= mode.maxHp / 2, `${fps} frames a second: ${say(round, mode)}: won by a hair`);
    assert.ok(round.seconds > 36 && round.seconds < 56, `${fps} frames a second: ${say(round, mode)} (lost at 0:39-0:45 before)`);
  }
});

test('it steps back only from a boss that is winding up within reach, facing it; a horde is fought as before', () => {
  const mode = fightMode(published('gm_b1188dcc0c'));
  const foe = (x, z, more) => ({ id: 'e', enemyIndex: 0, pos: new THREE.Vector3(x, 0, z), hp: 3, telegraph: 0, ...more });
  mode.player.pos.set(0, 0, 0);
  mode.world.rig.yaw = 1;
  for (const [enemies, why] of [
    [[], 'no enemy'],
    [[foe(0, -2, { telegraph: .5 })], 'a minion winding up beside the hero'],
    [[foe(0, -3, { boss: true })], 'a boss that is not winding up'],
    [[foe(0, -9, { boss: true, telegraph: .8 })], 'a boss winding up 9 m away: its bolt is side-stepped'],
  ]) {
    mode.enemies = enemies;
    assert.equal(mode.autoDodge(), false, why);
    assert.equal(mode.world.rig.yaw, 1, `${why}: the camera was turned`);
  }
  // a boss winding up 3 m to the east, a minion nearer to the north: back away from the boss
  mode.enemies = [foe(0, -1), foe(3, 0, { boss: true, telegraph: .8 })];
  assert.equal(mode.autoDodge(), true);
  const back = mode.world.rig.forward().multiplyScalar(-1); // where S walks
  assert.ok(back.x < -.99 && Math.abs(back.z) < .01, `S walks toward (${back.x.toFixed(2)}, ${back.z.toFixed(2)}), not straight away from the boss`);
  mode.world.input.dispose();
  // the built-in player's loop: S for the step back and no W in it; S let go where it walks to a goal
  assert.match(RUNTIME, /const dodge = !!mode\.autoDodge\?\.\(\);\n      hold\('KeyW', !dodge && t % 60 < 20\);\n      hold\('KeyS', dodge\);/);
  assert.match(RUNTIME, /hold\('KeyF', false\);\n        hold\('KeyS', false\);/);
});

test('a game without a boss is played as it was: the 30-second survival keeps its round and its HP', async () => {
  const mode = fightMode(published('gm_9539d06a71'));
  let stepped = 0;
  const dodge = mode.autoDodge.bind(mode);
  mode.autoDodge = () => { const on = dodge(); stepped += on ? 1 : 0; return on; };
  const round = await playFight(mode, { seconds: 120, fps: 30 });
  assert.deepEqual([round.won, round.seconds, stepped], [true, 30, 0]);
});
