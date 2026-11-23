import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authoredMode, published } from './fixtures/headless.mjs';

// The HUD's status line of a version-2 game names no score in a game that never scores, as the end card
// (endSummary) and a version-1 RPG's HUD (rpg.js).
test('a version-2 game\'s HUD names no score until the game scores', () => {
  const mode = authoredMode(published('gm_9539d06a71'), { autoplay: false });
  const said = [];
  mode.hud.status = (text) => said.push(text);
  mode.refreshHud();
  assert.equal(said.at(-1), '', `the status line reads '${said.at(-1)}' before anything was scored`);
  mode.score = 100; // (a kill)
  mode.refreshHud();
  assert.equal(said.at(-1), '점수 100');
  assert.deepEqual(mode.endSummary(true).result.filter((line) => /점수/.test(line)), ['점수 100'], 'as the end card');
  mode.world.input.dispose();
});
