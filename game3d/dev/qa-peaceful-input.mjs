// Behavioral regression: native F/pointer input in a peaceful world cannot fire,
// while a game with an actual selected enemy template still can.
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const browser = await chromium.launch({ headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const checks = [], errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const state = () => page.evaluate(() => window.__ipverseGameState?.());
const check = (name, passed, observation) => {
  checks.push({ name, passed: !!passed, observation });
  if (!passed) throw new Error(name);
};
async function open(fixture) {
  await page.goto(`http://127.0.0.1:8099/index.html?spec=dev/spec-authored-${fixture}.json`);
  await page.waitForFunction(() => window.__ipverseGameState?.()?.phase === 'ready');
  await page.getByRole('button', { name: '임무 시작', exact: true }).click();
  await page.waitForFunction(() => window.__ipverseGameState?.()?.phase === 'playing');
}
let failure;
try {
  await open('garden');
  await page.keyboard.down('f');
  await page.waitForTimeout(180);
  const afterF = await state();
  await page.keyboard.up('f');
  check('peaceful-world-native-f-produces-no-projectile', afterF.projectiles === 0, afterF);
  await page.mouse.move(1100, 450);
  await page.mouse.down();
  await page.waitForTimeout(180);
  const afterPointer = await state();
  await page.mouse.up();
  check('peaceful-world-native-pointer-produces-no-projectile', afterPointer.projectiles === 0, afterPointer);
  await page.screenshot({ path: resolve('game3d/dev/evidence/garden-peaceful-controls.png') });
  await open('city');
  await page.keyboard.down('f');
  await page.waitForTimeout(120);
  const afterCombatF = await state();
  await page.keyboard.up('f');
  check('selected-enemy-game-retains-native-f-fire', afterCombatF.projectiles > 0, afterCombatF);
  check('no-browser-errors', errors.length === 0, errors);
} catch (error) { failure = error.message; }
finally {
  await browser.close();
  await writeFile(resolve('game3d/dev/evidence/peaceful-input-verification.json'), JSON.stringify({
    status: failure ? 'FAIL' : 'PASS', observedAt: new Date().toISOString(),
    scope: 'Actual WebGL native input on authored local fixtures, not AI/deployed game proof.',
    checks, errors, failure: failure || null,
  }, null, 2) + '\n');
}
if (failure) throw new Error(failure);
console.log(`PASS ${checks.length}/${checks.length}: peaceful/combat native input`);
