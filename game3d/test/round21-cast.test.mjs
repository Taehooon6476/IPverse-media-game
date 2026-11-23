import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RUNTIME, AuthoredMode, authoredMode, published } from './fixtures/headless.mjs';

// A version-2 game's enemy models are part of the loading figure and are in before the round starts, not downloaded
// at their first appearance.
const SOURCE = readFileSync(new URL('../authored.js', import.meta.url), 'utf8');

test('a version-2 game\'s enemies load with the game, under the loading figure, not at their first appearance', async () => {
  for (const [id, want] of [
    ['gm_b870737b47', ['assets/ip_9417dee010.rig.glb', 'assets/ip_6a5d46afb7.rig.glb', 'assets/ip_db7535d83e.rig.glb']], // the crypt's three skeletons
    ['gm_9539d06a71', ['assets/ip_6e05239eda.glb']]]) { // the 30-second survival's one enemy
    const mode = authoredMode(published(id), { autoplay: false });
    assert.equal(typeof mode.loadCast, 'function', 'AuthoredMode has no loadCast: an enemy\'s model is downloaded when it first appears');
    const asked = [];
    Object.assign(mode.world, { loadModel: async (url) => { asked.push(url); return {}; }, loadCutout: async (url) => { asked.push(url); return {}; } });
    await mode.loadCast();
    assert.deepEqual(asked.sort(), [...want].sort(), id);
    mode.world.input.dispose();
  }
  // an enemy with a weapon brings it; one with no model, its cutout; one with neither, nothing
  const cast = Object.assign(Object.create(AuthoredMode.prototype), { asked: [], spec: { enemies: [
    { modelUrl: 'assets/a.rig.glb', weaponUrl: 'assets/axe.glb', spriteUrl: 'assets/a.png' }, { spriteUrl: 'assets/b.png' }, { color: '#fff' }] } });
  cast.world = { loadModel: async (url) => { cast.asked.push(url); }, loadCutout: async (url) => { cast.asked.push(url); } };
  await cast.loadCast();
  assert.deepEqual(cast.asked, ['assets/a.rig.glb', 'assets/axe.glb', 'assets/b.png']);
  // a model that cannot load does not stop the game here (world.js loadModel answers null): where it is used says which
  cast.world.loadModel = async () => null;
  await cast.loadCast();
  // build() asks for them as it starts and the round does not begin before they are in
  const build = SOURCE.slice(SOURCE.indexOf('  async build() {'), SOURCE.indexOf('  /** A placed prop as the round keeps it.'));
  assert.match(build, /const cast = this\.loadCast\(\);/);
  assert.ok(build.indexOf('await cast;') > build.indexOf('this.arpg?.setup();') && build.indexOf('await cast;') < build.indexOf('this.activateStage();'), 'awaited before the first stage is on');
  // and the loading figure's total holds them from the start, for every version of game
  assert.match(RUNTIME, /\.\.\.spec\.props\.map\(\(p\) => p\.modelUrl\),\n    \.\.\.spec\.enemies\.flatMap\(\(e\) => \[e\.modelUrl, e\.weaponUrl\]\),/);
  assert.doesNotMatch(RUNTIME, /authored \? \[\] : spec\.enemies/, 'a version-2 game\'s enemies are left out of the figure');
});
