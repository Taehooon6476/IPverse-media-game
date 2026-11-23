// A real fixture asset request is held to reproduce slow model/texture loading.
// All game interaction uses the browser's native keyboard and pointer inputs.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const evidence = resolve('game3d/dev/evidence');
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const checks = [], errors = [];
page.on('pageerror', (error) => errors.push(error.message));
let releaseAsset;
const held = new Promise((resolve) => { releaseAsset = resolve; });
await page.route('**/dev/assets/prop.png', async (route) => { await held; await route.continue(); });
const check = (name, passed, observation) => {
  checks.push({ name, passed: !!passed, observation });
  if (!passed) throw new Error(name);
};
let failure;
try {
  await page.goto('http://127.0.0.1:8099/index.html?spec=dev/spec-authored-city.json');
  const button = page.getByRole('button', { name: /^게임 불러오는 중…/ }); // (with its progress: "게임 불러오는 중… 62%")
  await button.waitFor({ state: 'attached' });
  check('start-disabled-while-real-prop-request-pending', await button.isDisabled(),
    { buttonText: await button.textContent(), gameState: await page.evaluate(() => window.__ipverseGameState?.()) });
  await button.click({ force: true });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  check('early-native-click-and-enter-cannot-start', await page.evaluate(() => window.__ipverseGameState?.() === null));
  await page.screenshot({ path: resolve(evidence, 'city-loading-disabled.png') });
  releaseAsset();
  await page.waitForFunction(() => window.__ipverseGameState?.()?.phase === 'ready');
  const start = page.getByRole('button', { name: '임무 시작', exact: true });
  await start.waitFor({ state: 'visible' });
  check('start-enabled-after-build-and-no-ad-complete', await start.isEnabled());
  const before = await page.evaluate(() => window.__ipverseGameState().player);
  await start.click();
  await page.waitForFunction(() => window.__ipverseGameState?.()?.phase === 'playing');
  await page.keyboard.down('w');
  await page.waitForTimeout(250);
  await page.keyboard.up('w');
  const after = await page.evaluate(() => window.__ipverseGameState().player);
  check('native-click-start-and-movement-after-readiness', after[2] < before[2] - .2, { before, after });
  check('no-browser-errors', errors.length === 0, errors);
} catch (error) {
  failure = error.message;
} finally {
  releaseAsset();
  await browser.close();
  await writeFile(resolve(evidence, 'authored-readiness-verification.json'), JSON.stringify({
    status: failure ? 'FAIL' : 'PASS', observedAt: new Date().toISOString(),
    scope: 'Local authored fixture, actual WebGL and native input; a real asset request was deliberately delayed. Not deployed/model-generation proof.',
    checks, errors, failure: failure || null,
  }, null, 2));
}
if (failure) throw new Error(failure);
console.log(`PASS ${checks.length}/${checks.length}: slow-asset start readiness`);
