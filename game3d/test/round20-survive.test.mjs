// A survive stage cannot be cleared by standing still.
//
// The server settles a new game's survive stage on three numbers (server/authored_contract.py settle_survive): four
// spawn points 12–16 m from the start and first in the list, no automatic attack unless it was asked for, and HP an
// idle hero loses inside the clock. gm_9539d06a71.settled.spec.json is that function's output on the stored spec
// gm_9539d06a71.spec.json (server/tests/test_round20_games.py keeps the two in step).
//
// The rounds run without a browser on the runtime as it stands (fixtures/headless.mjs): the mode's update, the hero's
// controller, the waves, the wind-ups, blows and bolts. An enemy's model is a bare group, and nothing is drawn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THREE, authoredMode, published } from './fixtures/headless.mjs';

/** One round. `steer(mode, seconds)` holds the keys and turns the camera as a player would, every frame; without it
 * the hero stands where the round began. Enter starts the mission; a frame's enemy (its model loads behind a promise)
 * appears before the next one, as on the page. `cover`: no enemy bolt is ever fired, as if cover stopped every one
 * (only blows from within reach land). → {won, at: the round's clock at its end, hp, kills, first: the clock at the
 * hero's first lost HP, blows} */
async function round(spec, steer = null, { fps = 30, limit = 240, cover = false } = {}) {
  const mode = authoredMode(spec, { autoplay: false });
  mode.world.makeActor = async () => ({ root: new THREE.Group(), body: new THREE.Group(), height: 1.8, kind: 'model' });
  if (cover) mode.enemyShoot = () => {};
  let end = null, first = null, blows = 0;
  mode.hud.end = (won) => { end ??= { won, at: mode.elapsed }; };
  dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter' })); dispatchEvent(new KeyboardEvent('keyup', { code: 'Enter' }));
  for (let t = 0, dt = 1 / fps; t < limit && !end; t += dt) {
    const hp = mode.hp;
    steer?.(mode, mode.elapsed);
    mode.update(dt);
    mode.world.input.endFrame();
    await null; await null; await null;
    if (mode.hp < hp - 1e-9) { blows += 1; first ??= mode.elapsed; }
  }
  mode.world.input.dispose();
  assert.equal(mode.failure ?? null, null);
  assert.ok(end, 'the round ended');
  return { ...end, hp: mode.hp, maxHp: mode.maxHp, kills: mode.kills, first, blows };
}
/** A player who only walks: W held while the camera turns at a steady rate (a circle 8–16 m across), no attack. */
const walks = (turn) => (mode, seconds) => { mode.world.input.keys.add('KeyW'); mode.world.rig.yaw = seconds * turn; };

test('as it was made, the first 30초 생존 game is cleared by a hero who never moves', async () => {
  const made = published('gm_9539d06a71');
  assert.deepEqual([made.rules.playerHp, made.mechanics.autoFire, made.difficulty, made.mission.stages[0].target], [150, true, 'normal', 30]);
  const idle = await round(made);
  assert.equal(idle.won, true, 'the round the verifier played: 클리어! without a key');
  assert.ok(idle.kills >= 10, `the automatic attack fought for the hero: ${idle.kills} kills`);
  assert.ok(idle.hp > 90, `HP ${idle.hp} of 150 left`);
  assert.ok(idle.first > 7, `the horde needed ${idle.first.toFixed(1)} s to land its first hit`);
});

test('settled by the server, standing still loses it well inside the clock', async () => {
  const settled = published('gm_9539d06a71.settled');
  assert.deepEqual([settled.rules.playerHp, settled.mechanics.autoFire], [70, false]);
  const idle = await round(settled);
  assert.equal(idle.won, false);
  assert.ok(idle.at < 30 * .8, `the idle hero fell at ${idle.at.toFixed(1)} s of 30`);
  assert.ok(idle.first < 6, `the first hit landed at ${idle.first.toFixed(1)} s`);
  assert.equal(idle.kills, 0);
});

test('... and a hero who only keeps walking clears it', async () => {
  const settled = published('gm_9539d06a71.settled');
  for (const turn of [.4, .6, .8]) {
    const walked = await round(settled, walks(turn));
    assert.equal(walked.won, true, `turning ${turn} rad/s`);
    assert.ok(walked.hp >= settled.rules.playerHp / 2, `turning ${turn} rad/s: HP ${walked.hp} of ${walked.maxHp} left, ${walked.blows} hits`);
  }
});

test('the settled numbers hold at each difficulty, for longer stages and behind cover that stops every bolt', async () => {
  // server/authored_contract.py survive_hp_cap: what an idle hero loses in 70 % of the clock from the first blow on
  const rate = { easy: 3.0, normal: 4.4, hard: 8.0 };
  const cap = (seconds, difficulty) => Math.max(50, Math.floor(rate[difficulty] * (.7 * seconds - 5)));
  assert.deepEqual([cap(30, 'easy'), cap(30, 'normal'), cap(30, 'hard'), cap(60, 'normal')], [50, 70, 128, 162]);
  for (const difficulty of ['easy', 'normal', 'hard']) for (const seconds of [30, 60]) for (const cover of [false, true]) {
    const spec = structuredClone(published('gm_9539d06a71.settled'));
    Object.assign(spec, { difficulty, rules: { ...spec.rules, playerHp: cap(seconds, difficulty) } });
    spec.mission.stages[0].target = spec.objective.target = seconds;
    spec.enemies[0].speed = 1; // the slowest enemy the contract allows: 1.55 m/s
    const idle = await round(spec, null, { cover }), where = `${difficulty} ${seconds} s${cover ? ', no bolt lands' : ''}`;
    assert.equal(idle.won, false, `${where}: HP ${idle.hp} left`);
    // in the open they fall at 65–80 % of the clock; behind cover at 75–89 %, and at 쉬움's 30 s (HP at the contract's
    // floor of 50) at 96 %
    if (!cover) assert.ok(idle.at <= seconds * .9, `${where}: fell at ${idle.at.toFixed(1)} s`);
  }
});
