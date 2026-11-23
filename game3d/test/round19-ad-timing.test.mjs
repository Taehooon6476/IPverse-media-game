import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { published, trackMode, playRound } from './fixtures/headless.mjs';
import { steadyEstimate, wallSeconds } from '../arpg-data.js';

// A broadcast's ad timing. A race ends by a clear long before its time limit, so its end is not known ahead by a
// clock: the game estimates it on the last stretch (the pre-cue), and for an end not known ahead the end screen is
// held until the ad has taken the picture. On a loaded PC the game's clock runs behind the wall's, so the end is
// told in wall seconds.
const runtime = readFileSync(new URL('../runtime3d.js', import.meta.url), 'utf8');
function sliceOf(from, to) {
  const start = runtime.indexOf(from), end = runtime.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `runtime3d.js: ${from} … ${to}`);
  return runtime.slice(start, end);
}

test('a game clock that runs behind the wall clock: the seconds left are told in wall seconds, never fewer', () => {
  // 4.30 s left by the game's clock when 4.96 s of wall time are left (the clock at 0.87)
  let state = null, said = null;
  for (let wall = 0; wall <= 6; wall += .25) ({ state, seconds: said } = wallSeconds(state, 9.5 - wall * .87, wall));
  assert.ok(Math.abs(said - (9.5 - 6 * .87) / .87) < .15, `4.28 s of game clock left is ${said.toFixed(2)} s of wall time`);
  // a clock in step is told as it is, and so is one that seems to run ahead (never fewer seconds than the game says)
  state = null;
  for (let wall = 0; wall <= 6; wall += .25) ({ state, seconds: said } = wallSeconds(state, 9.5 - wall, wall));
  assert.equal(said, 3.5);
  state = null;
  for (let wall = 0; wall <= 6; wall += .25) ({ state, seconds: said } = wallSeconds(state, 9.5 - wall * 1.2, wall));
  assert.equal(+said.toFixed(2), 2.3);
  // the next round's clock starts over: nothing of the last round's pace is kept
  ({ state, seconds: said } = wallSeconds(state, 30, 6.25));
  assert.equal(said, 30);
});

test('an estimate counts only while it shrinks with the clock: a car that slows takes it back', () => {
  let state = null, got = null;
  const feed = (t, s) => { ({ state, seconds: got } = steadyEstimate(state, s, t)); return got; };
  for (let t = 0; t < 1.4; t += .25) assert.equal(feed(t, 6 - t), null, `not yet steady at ${t} s`);
  assert.equal(feed(1.5, 4.5), 4.5); // 1.5 s at the same pace
  assert.equal(feed(1.75, 4.25), 4.25);
  assert.equal(feed(2, 4.6), null, 'the car lost speed: the end moved 0.6 s away'); // (a bump, a bend it brakes for)
  for (let t = 2.25; t < 3.4; t += .25) assert.equal(feed(t, 6.6 - t), null);
  assert.equal(feed(3.5, 3.1), 3.1); // steady again at the new pace
  assert.equal(feed(3.75, null), null); // no estimate (not the last stretch any more)
  assert.equal(feed(4, 2.6), null);
});

test('gm_2ceb5d2311 under the built-in player: the last stretch tells the race\'s end 3.5 s ahead, within half a second', () => {
  const mode = trackMode(published('gm_2ceb5d2311'));
  assert.equal(mode.raceEndsIn(), null); // before the start
  let state = null;
  const told = []; // [t, the steady estimate]
  let early = 0;
  const round = playRound(mode, { each: (m, t) => {
    const raw = m.raceEndsIn();
    const last = Math.floor(m.director.progress) === m.director.stage?.target - 1 && m.director.raceNext === m.raceRoute.length - 1;
    if (raw != null && !last) early += 1;
    const got = steadyEstimate(state, raw, t);
    state = got.state;
    if (got.seconds != null) told.push([t, got.seconds]);
  } });
  assert.deepEqual([round.won, round.reason], [true, 'clear']);
  assert.equal(early, 0, 'an estimate before the last checkpoint of the last lap');
  // what the play window acts on: the estimate when 4.5 s or less are left by it (the lead and the picks' time)
  const first = told.find(([, s]) => s <= 4.5);
  assert.ok(first, `no steady estimate inside the last 4.5 s (${told.length} told)`);
  const [at, said] = first, real = round.seconds - at;
  assert.ok(said >= 3.5, `told only ${said.toFixed(2)} s ahead`);
  // the server sends an estimated end's break PRECUE_EST_MARGIN_SEC (1 s) later: a round that ends up to 1 s after
  // its estimate still has its ad after its end
  assert.ok(real - said < .5 && said - real < 1, `said ${said.toFixed(2)} s, the round ended ${real.toFixed(2)} s later`);
  for (const [t, s] of told.filter(([, s]) => s <= 4.5)) {
    assert.ok(round.seconds - t - s < .5, `at ${t.toFixed(1)} s: said ${s.toFixed(2)}, real ${(round.seconds - t).toFixed(2)}`);
  }
});

test('the runtime tells an exact end as it is and an estimated one only for the built-in player', () => {
  const lines = sliceOf('window.ipverseRoundEnd = () => {', '\n  };\n');
  const run = (exact, raceEndsIn, autoplay, nowSec = [0]) => {
    const window = { ipverseRoundEndsIn: () => exact };
    const mode = { raceEndsIn };
    const fn = new Function('window', 'mode', 'ended', 'autoplay', 'performance', 'steadyEstimate', 'wallSeconds',
      `let estimate = null, paced = null;\n${lines}\n};\nreturn window.ipverseRoundEnd;`)(
      window, mode, false, autoplay, { now: () => nowSec[0] * 1000 }, steadyEstimate, wallSeconds);
    return fn;
  };
  assert.deepEqual(run(4.2, () => 3, true)(), { seconds: 4.2, estimated: false }); // a clock's end wins
  assert.equal(run(null, () => 3, false)(), null); // a person drives: no estimate
  const now = [0], end = run(null, () => 6 - now[0], true, now);
  let got = null;
  for (; now[0] <= 2; now[0] += .25) got = end();
  assert.deepEqual(got, { seconds: 4, estimated: true });
});

test('a race under a time limit: its last stretch is told, not the limit\'s clock (gm_2ceb5d2311 on air)', () => {
  // a time limit's clock is always there: the race's estimate must be looked at first
  const lines = sliceOf('window.ipverseRoundEnd = () => {', '\n  };\n');
  const now = [0];
  const left = { clock: () => 460 - now[0], race: () => 6 - now[0] };
  const end = new Function('window', 'mode', 'ended', 'autoplay', 'performance', 'steadyEstimate', 'wallSeconds',
    `let estimate = null, paced = null;\n${lines}\n};\nreturn window.ipverseRoundEnd;`)(
    { ipverseRoundEndsIn: () => left.clock() }, { raceEndsIn: () => left.race() }, false, true,
    { now: () => now[0] * 1000 }, steadyEstimate, wallSeconds);
  assert.deepEqual(end(), { seconds: 460, estimated: false }); // the estimate is not steady yet: the clock
  let got = null;
  for (now[0] = .25; now[0] <= 2; now[0] += .25) got = end();
  assert.deepEqual(got, { seconds: 4, estimated: true });
  left.clock = () => 3 - now[0] / 2; // the limit runs out before the car is home: the clock's end, exact
  got = end();
  assert.equal(got.estimated, false);
  assert.ok(Math.abs(got.seconds - left.clock()) < .5 && got.seconds < left.race());
});

test('the end screen of a round whose ad was cued at its report stays up while the play window asks for it', () => {
  // boot()'s lines: window.ipverseHoldEnd and the built-in player's restart after a round
  const hold = sliceOf('  let holdUntil = 0;', '  release.then(');
  const again = sliceOf('      const again = ', '\n    }\n');
  const timers = [];
  const clock = { t: 0 };
  const api = new Function('window', 'performance', 'setTimeout', 'restart',
    `${hold}\n${again}\nreturn { again, hold: window.ipverseHoldEnd };`)(
    {}, { now: () => clock.t }, (fn, ms) => timers.push([clock.t + ms, fn]), () => timers.push('restart'));
  const runTo = (ms) => {
    for (;;) {
      const i = timers.findIndex((x) => Array.isArray(x) && x[0] <= ms);
      if (i < 0) break;
      const [at, fn] = timers.splice(i, 1)[0];
      clock.t = at; fn();
    }
    clock.t = ms;
  };
  timers.push([4000, api.again]); // hud.end: setTimeout(again, 4000)
  runTo(900);
  api.hold(8000); // the round report's answer (0.9 s after the round end): holdSec 8
  runTo(8800);
  assert.ok(!timers.includes('restart'), 'the next round started under the end screen\'s ad');
  runTo(9300);
  assert.ok(timers.includes('restart'), 'the next round never started');
  // no hold asked (a pre-cued round, a corner round): the next round after 4 s
  timers.length = 0; clock.t = 20000;
  timers.push([24000, api.again]);
  runTo(24100);
  assert.ok(timers.includes('restart'));
});
