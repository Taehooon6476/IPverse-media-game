import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// The browser checks that ship with the runtime (dev/) send keys as a keyboard does: no native key code (a Windows
// code sent as the native one is another key on a Mac, and the page hears a phantom key), and Enter and Space with
// their character (without it they do not press a focused button).

test('the browser checks send a key as a keyboard does: no native key code, Enter and Space with their character', () => {
  const dev = new URL('../dev/', import.meta.url);
  const scripts = readdirSync(dev).filter((name) => /\.(mjs|js)$/.test(name));
  for (const name of scripts) {
    const code = readFileSync(new URL(name, dev), 'utf8').replace(/^\s*\/\/.*$/gm, ''); // (a comment may name it)
    assert.doesNotMatch(code, /nativeVirtualKeyCode/, `dev/${name} sends a native key code: on a Mac the Windows code is another key, and the page hears a phantom key`);
  }
  const harness = readFileSync(new URL('qa-round20.mjs', dev), 'utf8');
  assert.match(harness, /const TEXT = \{ Enter: '\\r', Space: ' ' \};/);
  assert.match(harness, /type: TEXT\[code\] \? 'keyDown' : 'rawKeyDown'/, 'Enter and Space go as key presses with their character: a focused button is pressed by them as in a real browser');
  assert.match(harness, /down: \(code, more\) => send\('Input\.dispatchKeyEvent', keyDown\(code, more\)\)/);
});
