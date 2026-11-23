import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RUNTIME, authoredMode, published } from './fixtures/headless.mjs';
import * as rules from '../arpg-data.js';
import { endCardPage } from './fixtures/end-card.mjs';

// The end card and what 다시 시작 does:
// - a key pressed in the card's first 0.8 s (Enter or Space still held from the round) does not press 다시 시작.
// - 다시 시작 in the first stage is a fresh start: no checkpoint notice, no invulnerability.
// - under ?autoplay=1 the card's reason is 해요체, as its other lines.
const { endCard, restartLine, RESUME_GRACE_SEC } = rules;
function sliceOf(from, to) {
  const start = RUNTIME.indexOf(from), end = RUNTIME.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `runtime3d.js: ${from} … ${to}`);
  return RUNTIME.slice(start, end);
}

test('the end card takes no key for its first 0.8 s: an Enter or a Space pressed as the round ends does not press 다시 시작', () => {
  // Enter 0.12 s after the card came up, Space 0.39 s after
  for (const [code, ms] of [['Enter', 120], ['Space', 390], ['Enter', 790]]) {
    const page = endCardPage();
    page.end(true);
    page.wait(ms);
    const e = page.key(code);
    assert.deepEqual([page.restarts, page.shown()], [0, true], `${code} ${ms} ms after the card came up pressed 다시 시작: the reason and the result were never read`);
    assert.equal(e.defaultPrevented, true, 'the key is the card\'s: it scrolls nothing and presses no button by itself');
    // the same key again, once the card has been up 0.8 s: 다시 시작
    page.wait(800 - ms);
    page.key(code);
    assert.deepEqual([page.restarts, page.shown()], [1, false], `${code} after 0.8 s`);
  }
  assert.equal(rules.END_KEYS_MS, 800);
});

test('a key held down since the round is no press of the card; a click and the keys work as before after 0.8 s', () => {
  // Space held as the round ended (a jump): its repeats never press 다시 시작, a new press does
  const held = endCardPage();
  held.end(false);
  for (let ms = 0; ms < 2000; ms += 50) { held.wait(50); held.key('Space', { repeat: true }); }
  assert.deepEqual([held.restarts, held.shown()], [0, true], 'a held Space pressed 다시 시작');
  held.key('Space');
  assert.equal(held.restarts, 1);
  // other keys do nothing, and are left to the page
  const other = endCardPage();
  other.end(true);
  other.wait(1000);
  assert.equal(other.key('KeyW').defaultPrevented, false);
  assert.equal(other.restarts, 0);
  // a click on 다시 시작
  other.click();
  assert.equal(other.restarts, 1);
  // the button still takes the focus as the card comes up (a screen reader lands on it)
  const focus = endCardPage();
  focus.end(true);
  assert.ok(focus.focused, 'the button is not focused');
});

test('the built-in player\'s restart and a broadcast\'s hold are not delayed by the card\'s keys', () => {
  const bot = endCardPage({ autoplay: true });
  bot.end(false);
  bot.wait(3999);
  assert.equal(bot.restarts, 0);
  bot.wait(1);
  assert.equal(bot.restarts, 1, 'the built-in player\'s next round comes 4 s after the end, as before');
  // its timer and the hold (round19-ad-timing.test.mjs runs them)
  assert.match(RUNTIME, /const again = \(\) => \(performance\.now\(\) < holdUntil \? setTimeout\(again, 250\) : restart\(\)\);\n      setTimeout\(again, 4000\);/);
  assert.match(RUNTIME, /window\.ipverseHoldEnd = \(ms\) => \{ holdUntil = Math\.max\(holdUntil, performance\.now\(\) \+ Math\.min\(Number\(ms\) \|\| 0, 20000\)\); \};/);
  // the rule itself
  assert.deepEqual([rules.endKey(0), rules.endKey(799), rules.endKey(800), rules.endKey(5000, true)], [false, false, true, false]);
});

test('다시 시작 in the first stage is a fresh start: no checkpoint popup, no invulnerability, and the card\'s words agree', () => {
  for (const id of ['gm_9539d06a71', 'gm_8f1fc9a181']) { // a one-stage survival and a sky climb
    const spec = published(id);
    const first = authoredMode(spec, { autoplay: false }); // the round that is left on the pause card, in its first stage
    assert.equal(restartLine(first.endSummary(false).resumeStage), '처음부터 다시 해요.', 'what the pause card says of its 다시 시작');
    first.world.input.dispose();
    const again = authoredMode(spec, { autoplay: false });
    const popups = [];
    again.hud.popup = (text) => popups.push(text);
    again.begin(); // 임무 시작, pressed by the page itself
    assert.deepEqual(popups.filter((text) => /체크포인트|무적/.test(text)), [], `${id}: the round opened with a checkpoint's words`);
    assert.equal(again.hurtFor, 0, `${id}: the hero is invulnerable for ${again.hurtFor} s`);
    assert.equal(again.resumed, null);
    assert.equal(again.debugState().resumedAt, null);
    again.world.input.dispose();
  }
});

test('a later stage is still a checkpoint: its popup, its moment of invulnerability', () => {
  const spec = published('gm_b870737b47');
  const first = authoredMode(spec, { autoplay: false });
  first.phase = 'playing';
  first.director.progress = 6; // the first room cleared
  first.completeStage(first.director.update(.016, { position: first.player.pos, targets: [] }));
  assert.equal(restartLine(first.endSummary(false).resumeStage), '2단계부터 이어서 해요.');
  first.world.input.dispose();
  const again = authoredMode(spec, { autoplay: false });
  const popups = [];
  again.hud.popup = (text) => popups.push(text);
  assert.equal(again.resumed?.stage, 1);
  again.begin();
  assert.deepEqual(popups.filter((text) => /체크포인트/.test(text)), ['체크포인트 · 2단계부터 다시 · 잠시 무적']);
  assert.ok(again.hurtFor >= RESUME_GRACE_SEC);
  again.world.input.dispose();
});

test('the built-in player\'s end reasons are 해요체, as the card\'s other lines', () => {
  const [, cap, stuck] = /const BOT_END = \{ cap: '([^']+)', stuck: '([^']+)' \};/.exec(RUNTIME) ?? [];
  assert.deepEqual([cap, stuck], ['자동 플레이 시간이 다 돼서 이번 판을 마쳐요.', '진행이 멈춰서 이번 판을 마쳐요.']);
  // on the card they stand where '체력이 다했어요.' does
  assert.equal(endCard({ won: false, timeout: true, failure: stuck }).reason, stuck);
  for (const line of [cap, stuck, endCard({ won: false }).reason, endCard({ won: false, timeout: true }).reason]) {
    assert.match(line, /요\.$/, line);
    assert.doesNotMatch(line, /니다/, line);
  }
});
