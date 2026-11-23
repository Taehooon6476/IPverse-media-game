import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LoadMeter, loadLine } from '../arpg-data.js';

// With a cutout enemy the loading figure must not stand at 99 % before the start button lights. The figure counts
// the files sized ahead (runtime3d.js sizeAhead: the clips and the hero's model), all in when the hero stands. The
// last step waits for the world: the setting's kit (found only as the world is built), its textures, the backdrop
// and the cutouts (images, not counted), and the build itself. The step is named in place of a standing 99.
const MB = 1048576;
const RUNTIME = readFileSync(new URL('../runtime3d.js', import.meta.url), 'utf8');
/** runtime3d.js's own loadingScreen on stand-in elements (as round20-loading.test.mjs). */
function screen(meter) {
  const start = RUNTIME.indexOf('function loadingScreen('), src = RUNTIME.slice(start, RUNTIME.indexOf('\n}\n', start));
  const node = (id) => ({ id, hidden: false, textContent: '', value: 0, max: 1, children: [], childNodes: [],
    setAttribute() {}, replaceChildren(...kids) { this.children = kids; },
    get shown() { return this.children.map((k) => (typeof k === 'string' ? k : k.textContent)).join(''); } });
  const nodes = { loading: node('loading') };
  const ui = new Function('$', 'ensure', 'el', 'loadLine', `${src}\n}\nreturn loadingScreen;`)(
    (id) => nodes[id], (id) => (nodes[id] ??= node(id)), () => node(), loadLine)(meter);
  return { ui, nodes };
}

test('a game whose counted files are all in while its world is built names that step: no figure standing at 99 %', async () => {
  const meter = new LoadMeter(), { ui, nodes } = screen(meter), labels = [];
  ui.onlabel = (label) => labels.push(label);
  // the clips (1.1 MB) and the hero's model (7.6 MB) are what was sized ahead; the enemy is a cutout
  meter.expect('assets/ual.glb', 1.1 * MB);
  meter.expect('assets/hero.rig.glb', 7.6 * MB);
  ui.ready();
  ui.to('hero');
  await meter.watch('assets/ual.glb', () => Promise.resolve());
  await meter.watch('assets/hero.rig.glb', () => Promise.resolve());
  labels.length = 0; // (the hero's last bytes: 99 for the moment the hero is made, before the briefing is up)
  ui.to('world');
  const seen = [[nodes['loading-text'].shown, nodes['loading-detail'].shown]];
  // the kit's files are found one by one as the world is built, and come in
  for (const [file, size] of [['sky.hdr', 1.6], ['aircon.glb', 1.2], ['bench.glb', 2.7]]) {
    let progress;
    const load = meter.watch(`/games/env-kit/v1/${file}`, (onProgress) => { progress = onProgress; return Promise.resolve(); });
    progress({ loaded: size * MB / 2, total: size * MB });
    seen.push([nodes['loading-text'].shown, nodes['loading-detail'].shown]);
    await load;
    seen.push([nodes['loading-text'].shown, nodes['loading-detail'].shown]);
  }
  for (const [text] of seen) assert.equal(text, '게임 불러오는 중… 장면 준비 중', `the screen read '${text}' while the world was built`);
  assert.equal(seen[0][1], '세계를 만들고 있어요 · 8.7 / 8.7MB');
  assert.equal(seen.at(-1)[1], '세계를 만들고 있어요 · 14.2 / 14.2MB', 'the megabytes go on counting under the step\'s name');
  assert.equal(ui.label, '게임 불러오는 중… 장면 준비 중', 'the briefing\'s busy start button says the same');
  assert.equal(nodes['loading-bar'].value, 99);
  ui.to('frame');
  assert.equal(nodes['loading-text'].shown, '게임 불러오는 중… 100%');
  assert.ok(!labels.some((label) => /99%/.test(label)), `the start button read ${labels.filter((label) => /99%/.test(label))[0]}`);
});

test('a figure that still has megabytes to come is told as before, and the step\'s name does not go back to a figure', () => {
  // a game whose enemies are models: their bytes come while the world is built
  assert.equal(loadLine({ loaded: 18.2 * MB, total: 30.3 * MB }, 'world').text, '게임 불러오는 중… 60%');
  assert.equal(loadLine({ loaded: 30.2 * MB, total: 30.3 * MB }, 'world').text, '게임 불러오는 중… 장면 준비 중');
  // the hero's model alone, all in while the hero is made: that is no scene yet
  assert.equal(loadLine({ loaded: 8 * MB, total: 8 * MB }, 'hero').text, '게임 불러오는 중… 99%');
  // 99 was shown; a kit file found now would put the bytes at 61 %: the step's name stays
  assert.deepEqual(loadLine({ loaded: 8.7 * MB, total: 14.2 * MB }, 'world', true, 99),
    { percent: 99, text: '게임 불러오는 중… 장면 준비 중', what: '세계를 만들고 있어요', bytes: '8.7 / 14.2MB' });
  // and a figure shown never goes back
  assert.equal(loadLine({ loaded: 8 * MB, total: 24 * MB }, 'world', true, 50).text, '게임 불러오는 중… 50%');
  assert.equal(loadLine({ loaded: 30 * MB, total: 30 * MB }, 'frame', true, 99).text, '게임 불러오는 중… 100%');
});
