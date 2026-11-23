// Verify already-generated games. This tool makes no AWS/API writes and exposes
// no telemetry mutation, teleport, synthetic game input or generated-code path.
// Every movement, aim, attack and interaction uses native Playwright inputs.
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ||
  '/opt/homebrew/Cellar/agent-browser/0.16.3/libexec/lib/node_modules/agent-browser/node_modules/playwright-core');
const exec = promisify(execFile);
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${name} needs a value`);
  return args[i + 1];
};
const allowedOptions = new Set(['--report', '--game-type', '--output', '--evidence-dir', '--artifact-dir']);
for (let i = 0; i < args.length; i += 2) if (!allowedOptions.has(args[i])) throw new Error(`Unknown option ${args[i]}`);
const sourcePath = option('--report', 'evidence/three-game-showcase-generation.json');
const selectedType = option('--game-type', null);
const output = resolve(option('--output', selectedType
  ? `evidence/three-game-showcase-play-${selectedType}.json` : 'evidence/three-game-showcase-play.json'));
const sourceBytes = await readFile(sourcePath);
const generated = JSON.parse(sourceBytes.toString('utf8'));
if (!Array.isArray(generated.cases)) throw new Error('Generation report needs a cases array');
const cases = generated.cases.filter((c) => !selectedType || c.type === selectedType);
if (!cases.length) throw new Error(`No generated case for ${selectedType ?? 'showcase'}`);
const evidenceDir = option('--evidence-dir', 'evidence/three-game-showcase');
const artifactDir = option('--artifact-dir', 'artifacts/three-game-showcase');
await Promise.all([mkdir(dirname(output), { recursive: true }), mkdir(evidenceDir, { recursive: true }),
  mkdir(artifactDir, { recursive: true })]);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const report = {
  status: 'RUNNING', startedAt: new Date().toISOString(), sourceReport: sourcePath,
  sourceReportSha256: sha(sourceBytes), selectedType,
  input: 'Native Playwright keyboard.down/up/press and mouse movement/buttons. Public telemetry is read only.',
  scope: cases.every((c) => !['127.0.0.1', 'localhost'].includes(new URL(c.previewUrl).hostname))
    ? 'Actual already-generated public browser games; user-owned IP assets; Three.js, not Unreal.'
    : 'Local authored fixture diagnostics only; not AI/deployed proof.',
  cases: [],
};
const save = () => writeFile(output, JSON.stringify(report, null, 2) + '\n');
await save();
const browser = await chromium.launch({ headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const angle = (r) => Math.atan2(Math.sin(r), Math.cos(r));

// Conservative path planning reads the authored geometry. Execution remains
// keyboard feedback against observed positions, never a path/position setter.
function planRoute(spec, current, target) {
  const w = spec.world;
  const blocked = (x, z) => Math.abs(x) > w.width / 2 - 1 || Math.abs(z) > w.depth / 2 - 1 ||
    w.entities.some((e) => {
      if ((!e.solid && e.kind !== 'hazard') || (e.y ?? 0) > 1.8) return false;
      const c = Math.abs(Math.cos(e.rotation ?? 0)), s = Math.abs(Math.sin(e.rotation ?? 0));
      const rx = ((e.width ?? 2) * c + (e.depth ?? 2) * s) / 2 + .8;
      const rz = ((e.width ?? 2) * s + (e.depth ?? 2) * c) / 2 + .8;
      return Math.abs(x - e.x) < rx && Math.abs(z - e.z) < rz;
    });
  const key = (p) => p.join(',');
  const from = [Math.round(current[0]), Math.round(current[2])];
  const to = [Math.round(target.x), Math.round(target.z)];
  const queue = [from], parents = new Map([[key(from), null]]);
  let found;
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i];
    if (Math.hypot(p[0] - to[0], p[1] - to[1]) <= .8) { found = p; break; }
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const next = [p[0] + dx, p[1] + dz];
      if (parents.has(key(next)) || blocked(...next)) continue;
      parents.set(key(next), p); queue.push(next);
    }
  }
  if (!found) throw new Error(`No safe keyboard route to ${target.id}`);
  const points = [];
  for (let p = found; p; p = parents.get(key(p))) points.unshift(p);
  const clearLine = (a, b) => {
    const n = Math.ceil(Math.hypot(a[0] - b[0], a[1] - b[1]) * 4);
    for (let i = 1; i <= n; i++) if (blocked(a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n)) return false;
    return true;
  };
  const simplified = [];
  for (let start = 0; start < points.length - 1;) {
    let end = start + 1;
    while (end + 1 < points.length && clearLine(points[start], points[end + 1])) end++;
    simplified.push(points[end]); start = end;
  }
  return simplified.length ? simplified : [[target.x, target.z]];
}

function stageTargets(spec, stage) {
  const refs = (e) => (!stage.entityIds?.length || stage.entityIds.includes(e.id)) &&
    (!e.stageId || e.stageId === stage.id) &&
    (stage.propIndex == null || e.propIndex === stage.propIndex) &&
    (stage.enemyIndex == null || e.enemyIndex === stage.enemyIndex);
  if (stage.type === 'collect') return spec.world.propPlacements.filter(refs);
  if (['kills', 'boss'].includes(stage.type)) return spec.world.enemySpawns.filter(refs);
  if (stage.type === 'talk') return [spec.world.npc].filter(Boolean).filter(refs);
  return [...spec.world.entities.filter((e) => e.kind === 'beacon'), spec.world.npc].filter(Boolean).filter(refs);
}

try {
  for (const item of cases) {
    if (!/^[a-z0-9-]+$/.test(item.type ?? '')) throw new Error('Each case needs a safe type key');
    const spec = item.spec;
    if (spec?.version !== 2 || spec.engine !== 'three' || !spec.world || !spec.mission?.stages)
      throw new Error(`${item.type}: missing actual authored v2 spec`);
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 },
      recordVideo: { dir: artifactDir, size: { width: 1280, height: 720 } } });
    const pageCreatedStart = Date.now();
    const page = await context.newPage();
    const observed = { type: item.type, name: item.name, gameId: item.gameId, status: 'RUNNING',
      previewUrl: item.previewUrl, specSha256: item.specSha256 ?? null, checks: [], actions: [], screenshots: [],
      pageErrors: [], videoPath: join(artifactDir, `${item.type}.webm`) };
    report.cases.push(observed);
    page.on('pageerror', (error) => observed.pageErrors.push(error.message));
    const state = () => page.evaluate(() => window.__ipverseGameState?.());
    const wait = (ms) => page.waitForTimeout(ms);
    const check = (name, ok, detail) => {
      observed.checks.push({ name, ok: !!ok, detail });
      if (!ok) throw new Error(name);
    };
    const screenshot = async (suffix) => {
      const path = join(evidenceDir, `${item.type}-${suffix}.png`);
      const bytes = await page.screenshot({ path });
      observed.screenshots.push({ path, bytes: bytes.length, sha256: sha(bytes) });
    };
    // Starts at the runtime's authored camera heading. Only native mouse drags
    // change this estimate; no engine camera or input property is read/written.
    let yaw = 0;
    async function aimAt(enemy) {
      const s = await state(), dx = enemy.position[0] - s.player[0], dz = enemy.position[2] - s.player[2];
      const wanted = Math.atan2(-dx, -dz);
      let pixels = Math.round(-angle(wanted - yaw) / .0042);
      const moved = [];
      while (Math.abs(pixels) > 0) {
        const step = Math.max(-400, Math.min(400, pixels));
        await page.keyboard.press('Escape'); // exits browser pointer lock, not game state
        await page.mouse.move(700, 450);
        await page.mouse.down({ button: 'right' });
        await page.mouse.move(700 + step, 450, { steps: Math.max(1, Math.ceil(Math.abs(step) / 80)) });
        await page.mouse.up({ button: 'right' });
        yaw = angle(yaw - step * .0042);
        pixels -= step; moved.push(step);
      }
      await wait(45);
      observed.actions.push({ action: 'native-mouse-aim', enemyId: enemy.id, horizontalDragPixels: moved });
    }
    async function walkTo(target, tolerance = .75) {
      const path = planRoute(spec, (await state()).player, target);
      observed.actions.push({ action: 'native-keyboard-route', target: target.id, waypoints: path });
      const held = new Set();
      if (spec.mechanics?.sprint !== false) await page.keyboard.down('Shift');
      try {
        for (const [x, z] of path) {
          const started = Date.now();
          while (Date.now() - started < 25000) {
            const s = await state();
            if (s.ended) {
              if (s.phase === 'won' && s.mission.completed) return;
              throw new Error(`Round ended before ${target.id}`);
            }
            const dx = x - s.player[0], dz = z - s.player[2];
            if (Math.hypot(dx, dz) < tolerance) break;
            const forward = -dx * Math.sin(yaw) - dz * Math.cos(yaw);
            const right = dx * Math.cos(yaw) - dz * Math.sin(yaw);
            const wanted = new Set();
            if (Math.abs(forward) > .26) wanted.add(forward > 0 ? 'w' : 's');
            if (Math.abs(right) > .26) wanted.add(right > 0 ? 'd' : 'a');
            for (const k of held) if (!wanted.has(k)) { await page.keyboard.up(k); held.delete(k); }
            for (const k of wanted) if (!held.has(k)) { await page.keyboard.down(k); held.add(k); }
            await wait(60);
          }
          const s = await state();
          if (s.phase === 'won' && s.mission.completed) return;
          if (Math.hypot(x - s.player[0], z - s.player[2]) > 1.2) throw new Error(`Keyboard route stuck near ${target.id}`);
        }
      } finally {
        for (const k of held) await page.keyboard.up(k);
        await page.keyboard.up('Shift');
      }
    }
    async function combat(stage, stageIndex) {
      const deadline = Date.now() + 65000;
      let burstCount = 0;
      while (Date.now() < deadline) {
        const s = await state();
        if (s.mission.stageIndex > stageIndex) return;
        if (s.ended) throw new Error('Combat round ended without completing the stage');
        const matches = s.enemies.filter((e) => (!stage.entityIds?.length || stage.entityIds.includes(e.id)) &&
          (stage.enemyIndex == null || e.enemyIndex === stage.enemyIndex));
        if (!matches.length) { await wait(150); continue; }
        const enemy = matches.reduce((a, b) =>
          Math.hypot(b.position[0] - s.player[0], b.position[2] - s.player[2]) <
          Math.hypot(a.position[0] - s.player[0], a.position[2] - s.player[2]) ? b : a);
        const dx = enemy.position[0] - s.player[0], dz = enemy.position[2] - s.player[2], distance = Math.hypot(dx, dz);
        const melee = spec.player.weaponType === 'melee';
        const ideal = melee ? 2.3 : 8;
        if (distance > (melee ? 3 : 16) || (burstCount > 4 && distance > ideal + 1)) {
          const ratio = Math.max(0, (distance - ideal) / distance);
          await walkTo({ id: `approach-${enemy.id}`, x: s.player[0] + dx * ratio, z: s.player[2] + dz * ratio });
        }
        const before = await state();
        const latest = before.enemies.find((e) => e.id === enemy.id);
        if (!latest) continue;
        await aimAt(latest);
        await page.keyboard.down('f');
        await wait(320);
        await page.keyboard.up('f');
        await wait(150);
        const after = await state();
        observed.actions.push({ action: 'native-f-burst', enemyId: enemy.id, hpBefore: latest.hp,
          hpAfter: after.enemies.find((e) => e.id === enemy.id)?.hp ?? 0,
          killsBefore: before.kills, killsAfter: after.kills, playerHp: after.hp });
        burstCount++;
        if (after.kills > before.kills) await screenshot(`combat-kill-${after.kills}`);
      }
      throw new Error(`Native combat did not complete ${stage.id}`);
    }
    try {
      await page.goto(item.previewUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__ipverseGameState?.()?.phase === 'ready', undefined, { timeout: 180000 });
      const start = page.getByRole('button', { name: '임무 시작', exact: true });
      await start.waitFor({ state: 'visible' });
      check('actual-selected-3d-player', ['model', 'rigged'].includes((await state()).actorKind)
        && (await state()).playerIpId === spec.player.ipId, (await state()).actorKind);
      check('all-stages-initially-uncompleted', (await state()).mission.stageIndex === 0
        && !(await state()).mission.completed, (await state()).mission);
      check('three-authored-mission-stages', spec.mission.stages.length === 3, spec.mission.stages.map((s) => s.type));
      await screenshot('briefing');
      await start.click();
      await page.waitForFunction(() => window.__ipverseGameState?.()?.phase === 'playing');
      observed.videoPlayingOffsetSeconds = +( (Date.now() - pageCreatedStart) / 1000).toFixed(3);
      await wait(250);
      await screenshot('playing');
      const hint = await page.locator('#hint').innerText();
      check('controls-follow-actual-movement-settings',
        hint.includes('점프 Space') === (spec.mechanics?.jump !== false) &&
        hint.includes('대시 Q') === (spec.mechanics?.dash !== false) &&
        hint.includes('달리기 Shift') === (spec.mechanics?.sprint !== false), hint);
      const combatAllowed = !!(spec.enemies.length || spec.player.weaponUrl || spec.mechanics?.autoFire);
      check('controls-follow-actual-combat-and-interaction',
        hint.includes('공격') === combatAllowed &&
        hint.includes('상호작용 E') === spec.mission.stages.some((s) => ['talk', 'interact'].includes(s.type)), hint);
      if (!combatAllowed) {
        await page.keyboard.down('f'); await wait(250); const noFire = await state(); await page.keyboard.up('f');
        check('peaceful-native-f-has-no-projectile', noFire.projectiles === 0, noFire.projectiles);
      }
      await page.keyboard.down('Space'); await wait(180); const jumped = await state(); await page.keyboard.up('Space');
      check('actual-jump-setting', spec.mechanics?.jump !== false ? jumped.player[1] > .1 : jumped.player[1] < .05,
        { enabled: spec.mechanics?.jump !== false, y: jumped.player[1] });
      await wait(700);
      const beforeDash = await state();
      await page.keyboard.press('q'); await wait(200);
      const afterDash = await state();
      const dashDistance = Math.hypot(afterDash.player[0] - beforeDash.player[0], afterDash.player[2] - beforeDash.player[2]);
      check('actual-dash-setting', spec.mechanics?.dash !== false ? dashDistance > 1 : dashDistance < .1,
        { enabled: spec.mechanics?.dash !== false, distance: dashDistance });
      for (let index = 0; index < spec.mission.stages.length; index++) {
        const stage = spec.mission.stages[index], targets = stageTargets(spec, stage);
        if (['kills', 'boss'].includes(stage.type)) await combat(stage, index);
        else if (stage.type === 'survive') {
          await page.waitForFunction((n) => window.__ipverseGameState?.()?.mission.stageIndex > n,
            index, { timeout: (stage.target * 2 + 10) * 1000 });
        } else {
          if (targets.length < stage.target) throw new Error(`Missing actual targets for ${stage.id}`);
          for (const target of targets.slice(0, stage.target)) {
            const beforeTravel = await state();
            await walkTo(target);
            const before = await state();
            if (before.mission.stageIndex > index) break;
            if (['talk', 'interact'].includes(stage.type)) {
              await wait(150);
              const idle = await state();
              check(`stage-${stage.id}-${target.id}-requires-input`,
                idle.mission.stageIndex === index && idle.mission.progress === before.mission.progress, idle.mission);
              if ((stage.holdSec ?? 0) > .4) {
                await page.keyboard.down('e');
                await wait(Math.min(350, stage.holdSec * 350));
                await page.keyboard.up('e'); await wait(120);
                check(`stage-${stage.id}-${target.id}-rejects-partial-hold`,
                  (await state()).mission.stageIndex === index &&
                  (await state()).mission.progress === before.mission.progress, (await state()).mission);
              }
              await page.keyboard.down('e');
              await wait(Math.max(350, ((stage.holdSec ?? 0) + .75) * 1000));
              await page.keyboard.up('e');
            }
            await page.waitForFunction(({ n, progress }) => {
              const s = window.__ipverseGameState?.();
              return s?.mission.stageIndex > n || s?.mission.progress > progress;
            }, { n: index, progress: beforeTravel.mission.progress },
            { timeout: Math.max(12000, ((stage.holdSec ?? 1) + 3) * 1000) });
          }
        }
        await page.waitForFunction((n) => window.__ipverseGameState?.()?.mission.stageIndex > n,
          index, { timeout: 12000 });
        const after = await state();
        check(`stage-${stage.id}-completed-by-native-input`, after.mission.history[index]?.id === stage.id,
          after.mission.history[index]);
        observed.actions.push({ action: 'stage-completed', stageId: stage.id, player: after.player,
          kills: after.kills, collected: after.collected });
        await screenshot(`stage-${index + 1}`);
      }
      const final = await state();
      check('round-won-with-all-ordered-stages', final.phase === 'won' && final.mission.completed &&
        final.mission.history.length === spec.mission.stages.length, final);
      if (spec.mission.stages.some((s) => ['kills', 'boss'].includes(s.type)))
        check('actual-native-combat-kill-count', final.kills >= spec.mission.stages
          .filter((s) => ['kills', 'boss'].includes(s.type)).reduce((n, s) => n + s.target, 0), final.kills);
      check('no-browser-errors', observed.pageErrors.length === 0, observed.pageErrors);
      await screenshot('victory');
      observed.status = 'PASS'; observed.finalState = final;
    } catch (error) {
      observed.status = 'FAIL'; observed.failure = error.message;
      observed.lastState = await state().catch(() => null);
      await screenshot('failure').catch(() => {});
    } finally {
      const video = page.video();
      await context.close();
      if (video) {
        const originalVideo = await video.path();
        await video.saveAs(observed.videoPath);
        if (resolve(originalVideo) !== resolve(observed.videoPath)) await unlink(originalVideo);
        const bytes = await readFile(observed.videoPath);
        observed.video = { path: observed.videoPath, bytes: bytes.length, sha256: sha(bytes) };
        try {
          const probe = await exec('ffprobe', ['-v', 'error', '-show_entries',
            'format=duration:stream=codec_name,width,height', '-of', 'json', observed.videoPath]);
          observed.video.media = JSON.parse(probe.stdout);
          await exec('ffmpeg', ['-v', 'error', '-i', observed.videoPath, '-f', 'null', '-']);
          observed.video.fullDecode = 'PASS';
        } catch (error) {
          observed.video.fullDecode = 'FAIL'; observed.video.error = error.message;
          observed.status = 'FAIL';
        }
      }
      await writeFile(resolve(evidenceDir, `${item.type}-play.json`), JSON.stringify(observed, null, 2) + '\n');
      await save();
      console.log(`${item.type}: ${observed.status}${observed.failure ? `: ${observed.failure}` : ''}`);
    }
  }
} finally {
  await browser.close();
  report.status = report.cases.length === cases.length && report.cases.every((c) => c.status === 'PASS')
    ? 'PLAY_VERIFIED' : 'FAIL';
  report.allThreeTypesVerified = !selectedType && report.status === 'PLAY_VERIFIED' &&
    ['exploration', 'combat', 'escape'].every((type) => report.cases.some((c) => c.type === type));
  report.completedAt = new Date().toISOString();
  await save();
}
if (report.status !== 'PLAY_VERIFIED') process.exitCode = 1;
