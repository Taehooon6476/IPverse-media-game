// Local authored fixture QA through real Playwright keyboard/pointer input.
// Never writes game state, actor positions, mission counters or model output.
// PLAYWRIGHT_MODULE points to an already installed playwright-core package.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const evidence = resolve('game3d/dev/evidence');
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 },
  recordVideo: { dir: evidence, size: { width: 1280, height: 720 } } });
const page = await context.newPage();
const checks = [], errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const state = () => page.evaluate(() => window.__ipverseGameState?.());
const pause = (ms) => page.waitForTimeout(ms);
const check = (name, passed, observation) => {
  checks.push({ name, passed: !!passed, observation });
  if (!passed) throw new Error(name);
};
async function keyFor(key, milliseconds) {
  await page.keyboard.down(key);
  await pause(milliseconds);
  await page.keyboard.up(key);
  await pause(150);
}
async function walkTo(x, z, maximum = 15000) {
  const started = Date.now(), held = new Set();
  try {
    while (Date.now() - started < maximum) {
      const current = await state();
      const dx = x - current.player[0], dz = z - current.player[2];
      if (Math.hypot(dx, dz) < .5) return current;
      const wanted = new Set();
      if (Math.abs(dx) > .22) wanted.add(dx > 0 ? 'd' : 'a');
      if (Math.abs(dz) > .22) wanted.add(dz > 0 ? 's' : 'w');
      for (const key of held) if (!wanted.has(key)) { await page.keyboard.up(key); held.delete(key); }
      for (const key of wanted) if (!held.has(key)) { await page.keyboard.down(key); held.add(key); }
      await pause(60);
    }
    throw new Error(`Movement could not reach (${x},${z})`);
  } finally {
    for (const key of held) await page.keyboard.up(key);
    await pause(120);
  }
}
let video;
try {
  await page.goto('http://127.0.0.1:8099/index.html?spec=dev/spec-authored-city.json&fps=1');
  await page.waitForFunction(() => window.__ipverseGameState?.()?.phase === 'ready');
  const cityReady = await state();
  check('city-authored-geometry-and-selected-model', cityReady.entities.some((e) => e.kind === 'building')
    && cityReady.actorKind === 'model' && cityReady.playerIpId === 'ip_dev_hero', cityReady);
  await page.screenshot({ path: resolve(evidence, 'city-briefing.png') });
  await page.getByRole('button', { name: '임무 시작', exact: true }).click();
  await page.waitForFunction(() => window.__ipverseGameState?.()?.phase === 'playing');
  const before = await state();
  await keyFor('d', 1000);
  const collision = await state();
  check('physical-movement-and-authored-cover-collision', collision.player[0] > before.player[0] + 1
    && collision.player[0] < 3.7, { before: before.player, after: collision.player });
  await page.screenshot({ path: resolve(evidence, 'city-collision.png') });
  await walkTo(0, 9);
  await page.screenshot({ path: resolve(evidence, 'city-playing.png') });
  await walkTo(0, 2);
  await page.waitForFunction(() => window.__ipverseGameState?.()?.mission.stageId === 'clear');
  check('physical-collection-advances-first-stage', (await state()).collected === 1, await state());
  await page.waitForFunction(() => window.__ipverseGameState?.()?.enemies.length > 0);
  await pause(500);
  check('no-idle-auto-fire', (await state()).kills === 0 && (await state()).mechanics.autoFire === false, await state());
  await page.keyboard.down('f');
  await page.waitForFunction(() => window.__ipverseGameState?.()?.mission.stageId === 'connect', { timeout: 20000 });
  await page.keyboard.up('f');
  check('physical-fire-kills-selected-enemy-and-advances-stage', (await state()).kills === 1, await state());
  await walkTo(0, -6);
  await pause(300);
  check('interaction-needs-input', (await state()).mission.stageId === 'connect', await state());
  await keyFor('e', 450);
  check('partial-hold-does-not-complete-interaction', (await state()).mission.stageId === 'connect', await state());
  await keyFor('e', 1200);
  check('complete-physical-hold-advances-interaction', (await state()).mission.stageId === 'extract', await state());
  await walkTo(0, -15);
  await page.waitForFunction(() => window.__ipverseGameState?.()?.phase === 'won');
  check('physical-city-mission-complete', (await state()).mission.history.length === 4, await state());
  await page.screenshot({ path: resolve(evidence, 'city-won.png') });
  // 다시 시작 starts the next round by itself (no second briefing)
  await page.getByRole('button', { name: '다시 시작', exact: true }).click();
  await page.waitForFunction(() => window.__ipverseGameState?.()?.phase === 'playing');
  check('restart-resets-stage-counter-and-spawn', (await state()).collected === 0
    && (await state()).mission.stageId === 'recover', await state());

  await page.goto('http://127.0.0.1:8099/index.html?spec=dev/spec-authored-garden.json&fps=1');
  await page.waitForFunction(() => window.__ipverseGameState?.()?.phase === 'ready');
  const gardenReady = await state();
  check('different-geometry-and-selected-cutout', gardenReady.entities.some((e) => e.kind === 'tree')
    && !gardenReady.entities.some((e) => e.kind === 'building')
    && gardenReady.actorKind === 'billboard' && gardenReady.mechanics.dash === false, gardenReady);
  await page.screenshot({ path: resolve(evidence, 'garden-briefing.png') });
  await page.getByRole('button', { name: '임무 시작', exact: true }).click();
  await walkTo(0, 5);
  await page.waitForFunction(() => window.__ipverseGameState?.()?.mission.stageId === 'greet');
  await walkTo(0, -5);
  // E opens the talk and passes each of its lines; the stage counts once the last one is passed
  for (let press = 0; press < 13 && (await state()).mission.stageId !== 'journey'; press++) { await page.keyboard.press('e'); await pause(250); }
  await page.waitForFunction(() => window.__ipverseGameState?.()?.mission.stageId === 'journey');
  check('physical-npc-interaction-advances-garden', (await state()).mission.history.length === 2, await state());
  await page.screenshot({ path: resolve(evidence, 'garden-playing.png') });
  await walkTo(0, -20);
  await page.waitForFunction(() => window.__ipverseGameState?.()?.phase === 'won');
  check('physical-garden-mission-complete', (await state()).mission.history.length === 3, await state());
  // the briefing at phone width (a first visit: 다시 시작 does not lead back to it)
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://127.0.0.1:8099/index.html?spec=dev/spec-authored-garden.json&fps=1');
  await page.waitForFunction(() => window.__ipverseGameState?.()?.phase === 'ready');
  const compact = await page.getByRole('button', { name: '임무 시작', exact: true }).boundingBox();
  check('390px-start-button-visible', compact.x >= 0 && compact.y >= 0
    && compact.x + compact.width <= 390 && compact.y + compact.height <= 844, compact);
  await page.screenshot({ path: resolve(evidence, 'garden-mobile.png') });
  check('no-page-errors', errors.length === 0, errors);
} catch (error) {
  checks.push({ name: 'required-runtime-route', passed: false, observation: String(error.message) });
  await page.screenshot({ path: resolve(evidence, 'failure.png') }).catch(() => {});
} finally {
  video = page.video();
  await context.close();
  if (video) await video.saveAs(resolve(evidence, 'authored-physical-play.webm'));
  await browser.close();
  const report = { status: checks.every((c) => c.passed) ? 'PASS' : 'FAIL', observedAt: new Date().toISOString(),
    provenance: 'locally authored data fixtures and existing attributed dev assets, not AI-generated or deployed proof',
    input: 'Playwright native keyboard.down/up/press and physical pointer clicks; telemetry read only',
    engine: 'Three.js WebGL, not Unreal Engine', checks, errors };
  await writeFile(resolve(evidence, 'authored-runtime-verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, passed: checks.filter((c) => c.passed).length, total: checks.length,
    errors, last: checks.at(-1) }, null, 2));
  if (report.status !== 'PASS') process.exitCode = 1;
}
