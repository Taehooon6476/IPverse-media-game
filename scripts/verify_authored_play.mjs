// Real public game URLs; native keyboard input; read-only runtime telemetry.
// Does not set positions, counters, time, health, stage IDs, or renderer state.
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ||
  '/opt/homebrew/Cellar/agent-browser/0.16.3/libexec/lib/node_modules/agent-browser/node_modules/playwright-core');
const input = JSON.parse(await readFile('evidence/authored-generation-live.json', 'utf8'));
const output = resolve('evidence/authored-gameplay-live.json');
await mkdir('evidence', { recursive: true });
const report = { status: 'RUNNING', input: 'Native Playwright keyboard/down/up and pointer clicks; telemetry read only.',
  startedAt: new Date().toISOString(),
  scope: 'Actual CloudFront games from real Bedrock generation with user-owned 3D IPs; not Unreal.',
  cases: [] };
const save = () => writeFile(output, JSON.stringify(report, null, 2));
const browser = await chromium.launch({ headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });

function route(spec, current, target) {
  const w = spec.world, halfW = w.width / 2, halfD = w.depth / 2;
  const blocked = (x, z) => {
    if (Math.abs(x) > halfW - 1 || Math.abs(z) > halfD - 1) return true;
    return w.entities.some(e => {
      if (!e.solid && e.kind !== 'hazard') return false;
      if ((e.y ?? 0) > 1.8) return false;
      const a = e.rotation ?? 0, c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
      const rx = ((e.width ?? 2) * c + (e.depth ?? 2) * s) / 2 + .8;
      const rz = ((e.width ?? 2) * s + (e.depth ?? 2) * c) / 2 + .8;
      return Math.abs(x - e.x) < rx && Math.abs(z - e.z) < rz;
    });
  };
  const key = (x, z) => `${x},${z}`;
  const from = [Math.round(current[0]), Math.round(current[2])];
  const to = [Math.round(target.x), Math.round(target.z)];
  const queue = [from], parents = new Map([[key(...from), null]]);
  let found = null;
  for (let q = 0; q < queue.length; q++) {
    const p = queue[q];
    if (Math.hypot(p[0] - to[0], p[1] - to[1]) <= .8) { found = p; break; }
    for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const n = [p[0] + dx, p[1] + dz], k = key(...n);
      if (parents.has(k) || blocked(...n)) continue;
      parents.set(k, p); queue.push(n);
    }
  }
  if (!found) throw new Error(`No safe keyboard route to ${target.id}`);
  const points = [];
  for (let p = found; p; p = parents.get(key(...p))) points.unshift(p);
  const clearLine = (a, b) => {
    const steps = Math.ceil(Math.hypot(a[0]-b[0],a[1]-b[1])*4);
    for (let n = 1; n <= steps; n++) if (blocked(a[0]+(b[0]-a[0])*n/steps, a[1]+(b[1]-a[1])*n/steps)) return false;
    return true;
  };
  const simplified = [];
  let start = 0;
  while (start < points.length - 1) {
    let end = start + 1;
    while (end + 1 < points.length && clearLine(points[start], points[end+1])) end++;
    simplified.push(points[end]); start = end;
  }
  return simplified.length ? simplified : [[target.x, target.z]];
}

try {
  for (const generated of input.cases) {
    const spec = generated.spec;
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 },
      recordVideo: { dir: 'build/game-personalization/gameplay-video', size: { width: 1280, height: 720 } } });
    const page = await context.newPage();
    const errors = [], checks = [];
    const observed = { gameId: generated.gameId, name: generated.name, previewUrl: generated.previewUrl,
      checks, pageErrors: errors, actions: [], status: 'RUNNING' };
    report.cases.push(observed);
    page.on('pageerror', e => errors.push(e.message));
    const state = () => page.evaluate(() => window.__ipverseGameState?.());
    const check = (name, ok, detail) => {
      checks.push({ name, ok: !!ok, detail });
      if (!ok) throw new Error(name);
    };
    async function walkTo(target) {
      const before = await state();
      const path = route(spec, before.player, target);
      observed.actions.push({ action: 'keyboard-route', target: target.id, waypoints: path });
      const held = new Set();
      await page.keyboard.down('Shift');
      try {
        for (const [x, z] of path) {
          const started = Date.now();
          while (Date.now() - started < 25000) {
            const s = await state();
            if (s.ended) {
              if (s.phase === 'won' && s.mission.completed) return;
              throw new Error(`Round ended before reaching ${target.id}`);
            }
            const dx = x - s.player[0], dz = z - s.player[2];
            if (Math.hypot(dx,dz) < .75) break;
            const wanted = new Set();
            if (Math.abs(dx) > .32) wanted.add(dx > 0 ? 'd' : 'a');
            if (Math.abs(dz) > .32) wanted.add(dz > 0 ? 's' : 'w');
            for (const k of held) if (!wanted.has(k)) { await page.keyboard.up(k); held.delete(k); }
            for (const k of wanted) if (!held.has(k)) { await page.keyboard.down(k); held.add(k); }
            await page.waitForTimeout(60);
          }
          const s = await state();
          if (Math.hypot(x-s.player[0],z-s.player[2]) > 1.2) throw new Error(`Keyboard route stuck near ${target.id}`);
        }
      } finally {
        for (const key of held) await page.keyboard.up(key);
        await page.keyboard.up('Shift');
      }
    }
    try {
      await page.goto(generated.previewUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__ipverseGameState?.()?.phase === 'ready', undefined, { timeout: 120000 });
      const first = await state();
      check('actual-selected-3d-player', ['model','rigged'].includes(first.actorKind)
        && first.playerIpId === spec.player.ipId, first.actorKind);
      check('all-stages-start-uncompleted', first.mission.stageIndex === 0 && !first.mission.completed, first.mission);
      await page.screenshot({ path: `evidence/${generated.gameId}-briefing.png` });
      await page.getByRole('button', { name: '임무 시작', exact: true }).click();
      await page.waitForFunction(() => window.__ipverseGameState?.()?.phase === 'playing');
      const hint = await page.locator('#hint').innerText();
      check('instructions-match-requested-movement',
        hint.includes('점프 Space') === spec.mechanics.jump
          && hint.includes('대시 Q') === spec.mechanics.dash
          && hint.includes('달리기 Shift') === spec.mechanics.sprint, hint);
      if (!spec.enemies.length && !spec.player.weaponUrl && !spec.mechanics.autoFire) {
        await page.keyboard.down('f');
        await page.waitForTimeout(300);
        await page.keyboard.up('f');
        await page.mouse.move(1100, 600);
        await page.mouse.down();
        await page.waitForTimeout(300);
        await page.mouse.up();
        const peaceful = await state();
        check('peaceful-game-has-no-manual-fire', peaceful.projectiles === 0
          && !hint.includes('공격'), { projectiles: peaceful.projectiles, hint });
      }
      await page.screenshot({ path: `evidence/${generated.gameId}-start.png` });
      for (let stageIndex = 0; stageIndex < spec.mission.stages.length; stageIndex++) {
        const stage = spec.mission.stages[stageIndex];
        const targets = stage.entityIds.map(id =>
          [...spec.world.entities, ...spec.world.propPlacements, ...spec.world.enemySpawns, spec.world.npc]
            .filter(Boolean).find(e => e.id === id));
        for (const target of targets.slice(0, stage.target)) {
          await walkTo(target);
          if (stage.type === 'interact' || stage.type === 'talk') {
            await page.keyboard.down('e');
            await page.waitForTimeout(Math.max(1600, ((stage.holdSec ?? 0) + .8) * 1000));
            await page.keyboard.up('e');
          }
          await page.waitForTimeout(250);
        }
        await page.waitForFunction(index => window.__ipverseGameState?.()?.mission.stageIndex > index,
          stageIndex, { timeout: 12000 });
        const after = await state();
        observed.actions.push({ action: 'stage-completed-by-input', stageId: stage.id,
          player: after.player, actualHistory: after.mission.history });
        await page.screenshot({ path: `evidence/${generated.gameId}-stage-${stageIndex+1}.png` });
        check(`stage-${stage.id}-completed`, after.mission.stageIndex > stageIndex, after.mission.history.at(-1));
      }
      const final = await state();
      check('round-won-with-all-ordered-stages', final.phase === 'won' && final.mission.completed
        && final.mission.history.length === spec.mission.stages.length, final);
      check('no-page-errors', errors.length === 0, errors);
      observed.status = 'PASS';
      observed.finalState = final;
      // Restart and verify the real control contract without touching gameplay state.
      await page.getByRole('button', { name: '다시 시작', exact: true }).click();
      await page.waitForFunction(() => window.__ipverseGameState?.()?.phase === 'ready');
      await page.setViewportSize({ width: 390, height: 844 });
      const button = await page.getByRole('button', { name: '임무 시작', exact: true }).boundingBox();
      check('mobile-start-fits', button.x >= 0 && button.y >= 0
        && button.x + button.width <= 390 && button.y + button.height <= 844, button);
      await page.screenshot({ path: `evidence/${generated.gameId}-mobile.png` });
      await page.setViewportSize({ width: 1400, height: 900 });
      await page.getByRole('button', { name: '임무 시작', exact: true }).click();
      await page.waitForFunction(() => window.__ipverseGameState?.()?.phase === 'playing');
      await page.keyboard.down('Space');
      await page.waitForTimeout(200);
      const jumped = await state();
      await page.keyboard.up('Space');
      check('actual-jump-setting', spec.mechanics.jump ? jumped.player[1] > .1 : jumped.player[1] < .05,
        { requested: spec.mechanics.jump, y: jumped.player[1] });
      await page.waitForTimeout(700);
      const dashBefore = await state();
      await page.keyboard.press('q');
      await page.waitForTimeout(200);
      const dashAfter = await state();
      const dashDistance = Math.hypot(dashAfter.player[0]-dashBefore.player[0], dashAfter.player[2]-dashBefore.player[2]);
      check('actual-dash-setting', spec.mechanics.dash ? dashDistance > 1 : dashDistance < .1,
        { requested: spec.mechanics.dash, distance: dashDistance });
      check('no-automatic-projectiles', dashAfter.projectiles === 0, dashAfter.projectiles);
    } catch (error) {
      observed.status = 'FAIL'; observed.failure = String(error.message);
      observed.lastState = await state().catch(() => null);
      await page.screenshot({ path: `evidence/${generated.gameId}-failure.png` }).catch(() => {});
    } finally {
      const video = page.video();
      await context.close();
      if (video) await video.saveAs(`build/game-personalization/gameplay-video/${generated.gameId}.webm`);
      await save();
      console.log(generated.name, observed.status, observed.failure ?? '');
    }
  }
} finally {
  await browser.close();
  report.status = report.cases.length === input.cases.length && report.cases.every(c => c.status === 'PASS')
    ? 'PLAY_VERIFIED' : 'FAIL';
  report.completedAt = new Date().toISOString();
  await save();
}
if (report.status !== 'PLAY_VERIFIED') process.exitCode = 1;
