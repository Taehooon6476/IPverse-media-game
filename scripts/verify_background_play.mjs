// Verify a game created through the actual studio using native keys and pointer.
// window.__ipverseGameState is used only as an observer; no state is assigned.
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/homebrew/Cellar/agent-browser/0.16.3/libexec/lib/node_modules/agent-browser/node_modules/playwright-core');
const args = process.argv.slice(2);
const arg = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const sourcePath = arg('--source', 'evidence/background-studio-live.json');
const source = JSON.parse(await readFile(sourcePath));
const item = source.case ?? source.game ?? source.cases?.[0];
if (!item?.spec || !item.previewUrl || !item.backgroundIpId) throw new Error('Actual studio game and background evidence are required');
const spec = item.spec;
if (new URL(item.previewUrl).host !== 'd12ka835iwfpnx.cloudfront.net' || !/^\/games\/gm_[a-zA-Z0-9_-]+\/index.html$/.test(new URL(item.previewUrl).pathname))
  throw new Error('Expected existing demo public game');
const output = resolve(arg('--output', 'evidence/background-gameplay-live.json'));
const dir = resolve('evidence/background-play');
await mkdir(dir, { recursive: true });
const report = {
  status: 'RUNNING', startedAt: new Date().toISOString(), sessionId: item.sessionId,
  gameId: item.gameId, backgroundIpId: item.backgroundIpId, previewUrl: item.previewUrl,
  sourceReport: sourcePath,
  scope: 'Actual game created through the native existing studio after actual background-image creation',
  input: 'Native keyboard/pointer input; game-state snapshots are read only',
  automatic3DTerrain: false, checks: [], actions: [], errors: [],
};
const save = () => writeFile(output, JSON.stringify(report, null, 2) + '\n');
const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 },
  recordVideo: { dir, size: { width: 1280, height: 720 } } });
const page = await context.newPage();
page.on('pageerror', (e) => report.errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && /THREE|WebGL|shader/i.test(m.text())) report.errors.push(m.text()); });
const state = () => page.evaluate(() => window.__ipverseGameState?.());
const wait = (ms) => page.waitForTimeout(ms);
const check = (name, passed, detail) => {
  report.checks.push({ name, passed: !!passed, detail });
  if (!passed) throw new Error(name);
};
const shot = async (name) => {
  const path = resolve(dir, `${name}.png`);
  await page.screenshot({ path });
  (report.screenshots ??= {})[name] = path;
};
const held = new Set();
const keys = async (wanted) => {
  const next = new Set(wanted);
  for (const key of held) if (!next.has(key)) { await page.keyboard.up(key); held.delete(key); }
  for (const key of next) if (!held.has(key)) { await page.keyboard.down(key); held.add(key); }
};
// The deliberately simple studio test requests a clear central path and a
// default camera facing -Z. Real WASD movement follows the observed position.
let travelled = 0;
async function walk(x, z, tolerance = .7) {
  const start = Date.now();
  let previous = (await state()).player;
  try {
    while (Date.now() - start < 60000) {
      const s = await state(), dx = x - s.player[0], dz = z - s.player[2];
      travelled += Math.hypot(s.player[0] - previous[0], s.player[2] - previous[2]);
      previous = s.player;
      if (Math.hypot(dx, dz) < tolerance || s.phase === 'won') return;
      const wanted = [];
      if (Math.abs(dz) > .18) wanted.push(dz < 0 ? 'w' : 's');
      if (Math.abs(dx) > .18) wanted.push(dx > 0 ? 'd' : 'a');
      await keys(wanted);
      await wait(70);
    }
    throw new Error(`Native movement failed to reach target ${x},${z}`);
  } finally {
    await keys([]); await wait(150);
  }
}
try {
  await save();
  await page.goto(item.previewUrl);
  await page.waitForFunction(() => window.__ipverseGameState?.()?.phase === 'ready' || !document.getElementById('errors')?.hidden,
    null, { timeout: 120000 });
  const initial = await state();
  check('actual-generated-game-ready', initial?.phase === 'ready', initial);
  check('selected-original-image-loaded', initial.background?.loaded && initial.background.ipId === item.backgroundIpId
    && initial.background.mode === 'image' && initial.background.sourceUrl === spec.world.background.imageUrl
    && initial.background.width > 0 && initial.background.height > 0, initial.background);
  check('background-is-static-environment-not-a-pickup', initial.background.static && !initial.background.collectible
    && !initial.propIpIds.includes(item.backgroundIpId) && initial.pickups.length === 1, initial);
  check('image-has-no-automatic-3D-terrain-claim', initial.background.automatic3DTerrain === false
    && initial.background.collisionSource === 'declared-world-entities', initial.background);
  check('selected-owned-player-and-core-used', initial.actorKind === 'rigged'
    && initial.playerIpId === spec.design.playerIpId && initial.propIpIds.length === 1
    && initial.propIpIds[0] === spec.design.propIpIds[0], initial);
  check('exact-requested-collect-and-reach-mission', spec.mission.stages.length === 2
    && spec.mission.stages[0].type === 'collect' && spec.mission.stages[1].type === 'reach', spec.mission);
  report.initial = initial;
  await shot('briefing');
  await page.getByRole('button', { name: '임무 시작', exact: true }).click();
  await page.waitForFunction(() => window.__ipverseGameState?.()?.phase === 'playing');
  await shot('start');
  for (let i = 0; i < spec.mission.stages.length; i++) {
    const stage = spec.mission.stages[i];
    const before = await state();
    check('stage-begins-' + stage.id, before.mission.stageIndex === i, before.mission);
    const targets = stage.type === 'collect' ? spec.world.propPlacements : spec.world.entities;
    const target = targets.find((entity) => stage.entityIds.includes(entity.id));
    check('native-test-target-present-' + stage.id, target && Math.abs(target.x) <= 1, target);
    await walk(target.x, target.z, stage.type === 'reach' ? .7 : .55);
    await wait(350);
    const after = await state();
    check('native-stage-complete-' + stage.id, after.mission.stageIndex > i, { before: before.mission, after: after.mission });
    check('original-background-persists-' + stage.id, after.background?.loaded
      && after.background.ipId === item.backgroundIpId && after.background.sourceUrl === initial.background.sourceUrl, after.background);
    report.actions.push({ stage: stage.id, nativeInput: 'WASD', player: after.player, mission: after.mission });
    await shot(i === 0 ? 'core-collected' : 'won'); await save();
  }
  const final = await state();
  check('mission-won-through-native-play', final.phase === 'won' && final.mission.history.length === 2
    && final.collected === 1 && final.mission.completed, final);
  check('actual-movement-across-level', travelled > 20 && final.player[2] < -7, { observedDistanceMeters: travelled, finalPlayer: final.player });
  check('zero-runtime-errors', report.errors.length === 0, report.errors);
  report.final = final; report.observedDistanceMeters = travelled;
  await wait(1200);
  await page.getByRole('button', { name: '다시 시작', exact: true }).click();
  await page.waitForFunction(() => window.__ipverseGameState?.()?.phase === 'ready', null, { timeout: 120000 });
  const restarted = await state();
  check('native-restart-restores-mission-and-background', restarted.mission.stageIndex === 0
    && restarted.collected === 0 && restarted.background?.loaded && restarted.background.ipId === item.backgroundIpId
    && Math.hypot(restarted.player[0] - spec.world.spawn.x, restarted.player[2] - spec.world.spawn.z) < .1, restarted);
  report.restarted = restarted;
  await shot('restarted');
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL'; report.failure = error.message;
  report.failureState = await state().catch(() => null);
  await shot('failure').catch(() => {});
} finally {
  await keys([]).catch(() => {});
  const video = page.video();
  await context.close();
  if (video) {
    report.video = resolve(dir, 'native-play.webm');
    await video.saveAs(report.video);
  }
  await browser.close();
  report.completedAt = new Date().toISOString();
  await save();
}
console.log(JSON.stringify({ status: report.status, gameId: report.gameId,
  checks: report.checks.length, travelledMeters: report.observedDistanceMeters, failure: report.failure }));
if (report.status !== 'PASS') process.exitCode = 1;
