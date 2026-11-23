import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { END_KEYS_MS } from '../arpg-data.js';
import { endCardPage } from './fixtures/end-card.mjs';

// The end card:
// - a click on 다시 시작 waits 0.8 s, as the keys do: in an ARPG a click is the attack, and the button comes up near
//   the screen's middle.
// - a playable ad's card has no 다시 시작 and takes no key.
const CSS = readFileSync(new URL('../ui.css', import.meta.url), 'utf8');

test('a click on 다시 시작 in the card\'s first 0.8 s starts nothing; the same click after it does', () => {
  for (const ms of [36, 400, 790]) {
    const page = endCardPage();
    page.end(true);
    page.wait(ms);
    page.click();
    assert.deepEqual([page.restarts, page.shown()], [0, true], `a click ${ms} ms after the card came up pressed 다시 시작`);
    page.wait(800 - ms);
    page.click();
    assert.deepEqual([page.restarts, page.shown()], [1, false], 'a click once the card has been up 0.8 s');
  }
});

test('until then the button looks as one that cannot be pressed yet, for as long as the keys and the click wait', () => {
  const rule = /#end:not\(\[hidden\]\) #restart \{ animation: ([\w-]+) ([\d.]+)s step-end; \}/.exec(CSS);
  assert.ok(rule, 'ui.css: the button\'s wait as the card comes up');
  assert.equal(Number(rule[2]) * 1000, END_KEYS_MS, 'the look lasts as long as the guard');
  const frames = new RegExp(`@keyframes ${rule[1]} \\{ from \\{ ([^}]+)\\} \\}`).exec(CSS);
  assert.ok(frames && /opacity: \.55;/.test(frames[1]) && /cursor: default;/.test(frames[1]), 'it looks as a disabled button does (button:disabled)');
  assert.match(CSS, /button:disabled \{ opacity: \.55; cursor: default; \}/);
});

test('the built-in player\'s own restart and a broadcast\'s hold do not come through the click', () => {
  const bot = endCardPage({ autoplay: true });
  bot.end(false);
  bot.wait(3999);
  assert.equal(bot.restarts, 0);
  bot.wait(1);
  assert.equal(bot.restarts, 1, 'the built-in player\'s next round comes 4 s after the end, as before');
});

test('a playable ad\'s end card takes no key: Enter and Space do not start the trial\'s round again', () => {
  const ad = endCardPage({ playableSec: 45 });
  ad.end(false);
  for (const ms of [100, 900, 5000]) {
    ad.wait(ms);
    for (const code of ['Enter', 'Space']) ad.key(code);
    assert.deepEqual([ad.restarts, ad.shown()], [0, true], `a key ${ms} ms later started the round again: the trial is the ad page's`);
  }
  // a game opened by its link still takes them
  const game = endCardPage();
  game.end(false);
  game.wait(900);
  game.key('Enter');
  assert.equal(game.restarts, 1);
});
