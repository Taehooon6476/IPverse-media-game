import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THREE, authoredMode, cityMode, trackMode, published } from './fixtures/headless.mjs';
import { xpFor } from '../arpg-data.js';

// (sky.js imports three.js: loaded here, after headless.mjs has put its stand-in in place, not with the imports above)
const { islandAt } = await import('../sky.js');

// A one-shot tip (the jump tip, the car's keys, an ARPG's new skill, a race's GO!) stays on screen: written with
// hud.notice() inside update(), refreshHud() at the end of the same update() would write the stage's label over it.

/** What the notice pill reads when each frame is painted: the last text update() left in it. */
function screen(mode) {
  const frames = [];
  let last = '';
  mode.hud.notice = (text) => { last = text; };
  const frame = (dt = 1 / 30) => { mode.update(dt); mode.world.input.endFrame(); frames.push(last); return last; };
  return { frames, frame, run: (seconds) => { for (let t = 0; t < seconds - 1e-9; t += 1 / 30) frame(); return last; } };
}
const tap = (code) => { dispatchEvent(new KeyboardEvent('keydown', { code })); dispatchEvent(new KeyboardEvent('keyup', { code })); };
/** The briefing's Enter, and the round's first frame. */
function start(mode, view) {
  tap('Enter');
  view.frame();
  assert.equal(mode.phase, 'playing');
}

test('sky gm_8f1fc9a181: the first fall says how to jump, and the tip stays up long enough to read', () => {
  const mode = authoredMode(published('gm_8f1fc9a181'), { autoplay: false }), view = screen(mode);
  start(mode, view);
  view.run(3); // the stage's own label has had its 2.5 s
  assert.equal(view.frames.at(-1), '');
  const { spawn } = mode.spec.world, off = { x: spawn.x + 30, z: spawn.z };
  assert.equal(islandAt(mode.islands, off.x, off.z), null, 'open sky beside the start island');
  mode.player.pos.set(off.x, 0, off.z);
  mode.player.grounded = false;
  let shown = null;
  for (let n = 0; n < 90 && !mode.skyFalls; n++) shown = view.frame();
  assert.equal(mode.skyFalls, 1, 'the hero fell and was put back');
  assert.match(shown, /점프/, `the frame of the fall reads '${shown}': the tip was written and wiped in one update()`);
  assert.match(shown, /Shift/, 'this game sprints: the longer jump is told');
  const since = view.frames.length;
  view.run(3);
  assert.ok(view.frames.slice(since).every((text) => text === shown), 'it stays for the seconds it takes to read');
  view.run(2);
  assert.equal(view.frames.at(-1), '', 'and goes by itself');
  // once a round: the second fall brings only its popup
  mode.player.pos.set(off.x, 0, off.z);
  mode.player.grounded = false;
  for (let n = 0; n < 90 && mode.skyFalls < 2; n++) view.frame();
  assert.equal(mode.skyFalls, 2);
  assert.equal(view.frames.at(-1), '');
});

test('a game without sprint is not told to hold Shift', () => {
  const spec = published('gm_8f1fc9a181');
  spec.mechanics = { ...spec.mechanics, sprint: false };
  const mode = authoredMode(spec, { autoplay: false }), view = screen(mode);
  start(mode, view);
  mode.player.pos.set(spec.world.spawn.x + 30, 0, spec.world.spawn.z);
  mode.player.grounded = false;
  let shown = null;
  for (let n = 0; n < 90 && !mode.skyFalls; n++) shown = view.frame();
  assert.match(shown, /점프/);
  assert.doesNotMatch(shown, /Shift/);
});

test('city gm_7a41fcae9e: E at the delivery car shows the driving keys; a refused exit says why', () => {
  const mode = cityMode(published('gm_7a41fcae9e'), { autoplay: false, stage: 1 }), view = screen(mode);
  start(mode, view);
  view.run(3);
  const van = mode.cars.find((c) => c.id === 'van1');
  mode.player.pos.set(van.group.position.x + 2.5, 0, van.group.position.z); // beside the car
  assert.equal(view.frame(), 'E · 차량 탑승');
  tap('KeyE');
  const boarded = view.frame();
  assert.equal(mode.activeCar, van);
  assert.match(boarded, /W/, `in the car the pill reads '${boarded}': the keys were written and wiped in one update()`);
  assert.match(boarded, /Space/);
  const since = view.frames.length;
  view.run(3);
  assert.ok(view.frames.slice(since).every((text) => text === boarded), 'for the seconds it takes to read');
  view.run(4); // (a long line: it has 6 s)
  assert.equal(view.frames.at(-1), '');
  // E at speed: the car does not let the driver out, and says what to do
  dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
  view.run(2);
  assert.ok(Math.abs(van.controller.stateSnapshot().speed) > 1.5);
  tap('KeyE');
  const refused = view.frame();
  dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
  assert.equal(mode.activeCar, van);
  assert.match(refused, /멈/, `'${refused}'`);
  mode.world.input.dispose();
});

test('ARPG gm_b870737b47: level 3 says which key the new skill is on', () => {
  const mode = authoredMode(published('gm_b870737b47'), { autoplay: false }), view = screen(mode);
  assert.ok(mode.arpg, 'an ARPG');
  mode.phase = 'playing';
  mode.stageNotice = 0;
  mode.arpg.level = 2;
  mode.arpg.addXp(xpFor(2));
  assert.equal(mode.arpg.level, 3);
  mode.refreshHud(); // the end of the update() that brought the kill
  let last = null;
  mode.hud.notice = (text) => { last = text; };
  mode.refreshHud();
  assert.match(last ?? '', /R/, `after the level-up the pill reads '${last}'`);
  assert.match(last, /회오리 베기/);
  void view;
});

test('track gm_2ceb5d2311: GO! is on screen for more than a frame', () => {
  const mode = trackMode(published('gm_2ceb5d2311'), { autoplay: false }), view = screen(mode);
  start(mode, view);
  view.run(4); // the 3 s countdown and a second of the race
  const go = view.frames.filter((text) => text === 'GO!').length / 30;
  assert.ok(go >= .5 && go <= 1.5, `GO! was up for ${go.toFixed(2)} s`);
  assert.deepEqual([...new Set(view.frames.filter((text) => /^\d$/.test(text)))], ['3', '2', '1'], 'after the countdown');
  mode.world.input.dispose();
  void THREE;
});
