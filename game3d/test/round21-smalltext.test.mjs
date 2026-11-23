import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// At phone width (and in the studio's inline frame, which the same rule covers) the line under the game and the
// ARPG panel's text stay readable.
const css = readFileSync(new URL('../ui.css', import.meta.url), 'utf8');

test('at phone width the line under the game and the ARPG\'s panel are 12 px or more', () => {
  const px = (rule) => Number(/font-size: (\d+)px/.exec(rule ?? '')?.[1]);
  const small = /@media \(max-width: 600px\), \(max-height: 560px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
  const hint = /#hint \{([^}]*)\}/.exec(small)?.[1];
  assert.ok(hint, 'ui.css: the key line\'s rule for a small window');
  assert.ok(px(hint) >= 12, `the key line is ${px(hint)} px`);
  const phone = /@media \(max-width: 600px\) \{ #arpg \{([^}]*)\}([^@]*)\}/.exec(css);
  assert.ok(phone, 'ui.css: the panel\'s rule under 600 px');
  const own = /font: 600 (\d+)px/.exec(/#arpg \{([^}]*)\}/.exec(css)[1])[1]; // the panel's size everywhere else
  const panel = /font-size/.test(phone[1]) ? px(phone[1]) : Number(own);
  assert.ok(panel >= 12, `the panel's text is ${panel} px`);
  for (const [, rule] of phone[2].matchAll(/\{([^}]*font-size[^}]*)\}/g)) assert.ok(px(rule) >= 12, rule);
});
