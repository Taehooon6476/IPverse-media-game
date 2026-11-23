// Execute the existing city runtime with native keyboard/mouse input.
// The observer supplies snapshots only; this script never writes game state.
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { cityPlan } from '../game3d/city-layout.js';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/homebrew/Cellar/agent-browser/0.16.3/libexec/lib/node_modules/agent-browser/node_modules/playwright-core');
const args = process.argv.slice(2), arg = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const local = args.includes('--local');
const sourceFile = arg('--report', 'evidence/city-generation-live.json');
const source = local ? { cases: [{ type: 'local', name: 'Local authored city fixture', previewUrl: 'http://127.0.0.1:5199/?fps=1',
  spec: JSON.parse(await readFile('.build/city-local/spec.json')) }] } : JSON.parse(await readFile(sourceFile));
const selected = arg('--type', null);
const cases = source.cases.filter((c) => !selected || c.type === selected);
if (!cases.length) throw new Error('No city games to verify');
const output = resolve(arg('--output', local ? 'evidence/city-local-play.json' : `evidence/city-play${selected ? '-' + selected : ''}.json`));
const dir = resolve(local ? 'evidence/city-local' : 'evidence/city-play');
await mkdir(dir, { recursive: true });
const report = { status: 'RUNNING', startedAt: new Date().toISOString(),
  scope: local ? 'Local manually authored diagnostic fixture; not live/model generation proof' : 'Actual platform chat-generated public city games',
  input: 'Native Playwright keyboard and pointer input; __ipverseGameState snapshots read only', cases: [] };
const save = () => writeFile(output, JSON.stringify(report, null, 2) + '\n');
const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const wrap = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));
try {
  for (const item of cases) {
    const spec = item.spec;
    const observed = { type: item.type, gameId: item.gameId, previewUrl: item.previewUrl, status: 'RUNNING', checks: [], actions: [], errors: [] };
    report.cases.push(observed); await save();
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, recordVideo: { dir, size: { width: 1280, height: 720 } } });
    const page = await context.newPage();
    page.on('pageerror', (e) => observed.errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && /THREE|WebGL|shader/i.test(m.text())) observed.errors.push(m.text()); });
    const state = () => page.evaluate(() => window.__ipverseGameState?.());
    const wait = (ms) => page.waitForTimeout(ms);
    const check = (name, ok, detail) => {
      observed.checks.push({ name, passed: !!ok, detail });
      if (!ok) throw new Error(name);
    };
    const shot = async (name) => {
      const path = resolve(dir, `${item.type}-${name}.png`);
      await page.screenshot({ path }); return path;
    };
    const held = new Set();
    const keys = async (wanted) => {
      const set = new Set(wanted);
      for (const key of held) if (!set.has(key)) { await page.keyboard.up(key); held.delete(key); }
      for (const key of set) if (!held.has(key)) { await page.keyboard.down(key); held.add(key); }
    };
    async function walk(x, z, tolerance = .6, limit = 120000) {
      const start = Date.now();
      try {
        while (Date.now() - start < limit) {
          const s = await state(), dx = x - s.player[0], dz = z - s.player[2];
          const distance = Math.hypot(dx, dz);
          if (distance < tolerance) return;
          if (s.phase === 'won') return;
          const yaw = s.city.cameraYaw, forward = -Math.sin(yaw) * dx - Math.cos(yaw) * dz, right = Math.cos(yaw) * dx - Math.sin(yaw) * dz;
          const next = [];
          if (Math.abs(forward) > .25) next.push(forward > 0 ? 'w' : 's');
          if (Math.abs(right) > .25) next.push(right > 0 ? 'd' : 'a');
          if (distance > 8) next.push('Shift');
          await keys(next); await wait(65);
        }
        throw new Error(`Walking did not reach ${x},${z}: ${JSON.stringify((await state()).player)}`);
      } finally { await keys([]); await wait(160); }
    }
    async function brake() {
      await keys(['Space']);
      await page.waitForFunction(() => {
        const s = window.__ipverseGameState?.(); const car = s?.city?.vehicles.find((v) => v.id === s.city.activeVehicle);
        return !car || Math.abs(car.speed) < .2;
      }, { timeout: 20000 });
      await keys([]); await wait(150);
    }
    async function drive(x, z, tolerance = 3.8, limit = 120000) {
      const start = Date.now();
      try {
        while (Date.now() - start < limit) {
          const s = await state(), car = s.city.vehicles.find((v) => v.id === s.city.activeVehicle);
          if (!car) throw new Error('Driver is not in a vehicle');
          const dx = x - car.position.x, dz = z - car.position.z, d = Math.hypot(dx, dz);
          if (d < tolerance || s.phase === 'won') break;
          const delta = wrap(Math.atan2(-dx, -dz) - car.yaw);
          const targetSpeed = d < 12 || Math.abs(delta) > .25 ? 3.2 : d < 35 ? 7 : 12;
          const next = [];
          if (Math.abs(delta) > .025) next.push(delta > 0 ? 'a' : 'd');
          if (car.speed > targetSpeed + .8) next.push('Space');
          else if (car.speed < targetSpeed - .2) next.push('w');
          await keys(next); await wait(65);
          if (Date.now() - start > limit - 200) throw new Error(`Drive did not reach ${x},${z}: ${JSON.stringify(car)}`);
        }
      } finally { await brake(); }
    }
    async function enter(id) {
      const s = await state(), car = s.city.vehicles.find((v) => v.id === id);
      await walk(car.position.x - 3, car.position.z, .7);
      await page.keyboard.press('e'); await wait(300);
      check('native-E-enter-' + id, (await state()).city.activeVehicle === id, (await state()).city);
    }
    async function exit() {
      await brake(); await page.keyboard.press('e'); await wait(300);
      check('native-E-safe-exit', !(await state()).city.activeVehicle, (await state()).city);
    }
    const roadOf = (p) => spec.world.city.streets.reduce((best, road) => {
      const d = Math.abs((road.axis === 'x' ? p.z : p.x) - road.coordinate);
      return !best || d < best.distance ? { ...road, distance: d } : best;
    }, null);
    async function driveRoute(target) {
      const s = await state(), car = s.city.vehicles.find((v) => v.id === s.city.activeVehicle);
      const from = roadOf(car.position), to = roadOf(target), roads = spec.world.city.streets;
      if (from.axis !== to.axis) {
        const x = (from.axis === 'z' ? from : to).coordinate, z = (from.axis === 'x' ? from : to).coordinate;
        await drive(x, z, 4.5);
      } else if (from.id !== to.id) {
        const cross = roads.filter((r) => r.axis !== from.axis).reduce((best, r) =>
          !best || Math.abs(r.coordinate - (from.axis === 'z' ? car.position.z : car.position.x)) < Math.abs(best.coordinate - (from.axis === 'z' ? car.position.z : car.position.x)) ? r : best, null);
        await drive(from.axis === 'z' ? from.coordinate : cross.coordinate, from.axis === 'z' ? cross.coordinate : from.coordinate, 4.5);
        await drive(to.axis === 'z' ? to.coordinate : cross.coordinate, to.axis === 'z' ? cross.coordinate : to.coordinate, 4.5);
      }
      await drive(to.axis === 'z' ? to.coordinate : target.x, to.axis === 'x' ? to.coordinate : target.z, 4);
    }
    try {
      await page.goto(item.previewUrl);
      await page.waitForFunction(() => window.__ipverseGameState?.()?.phase === 'ready' || !document.getElementById('errors')?.hidden, { timeout: 120000 });
      const initial = await state();
      check('actual-city-loaded', initial?.phase === 'ready' && initial.city?.buildings > 100 && initial.city.assetModelsLoaded > 10, initial);
      check('selected-owned-player-and-NPC-models', ['model', 'rigged'].includes(initial.actorKind) && initial.playerIpId === spec.player.ipId
        && initial.city.pedestrians.every((p) => ['model', 'rigged'].includes(p.kind) && p.propIndex === spec.world.npc.propIndex), initial.city.pedestrians);
      await shot('briefing');
      await page.getByRole('button', { name: '임무 시작', exact: true }).click();
      await page.waitForFunction(() => window.__ipverseGameState?.()?.phase === 'playing');
      await shot('start');
      for (let i = 0; i < spec.mission.stages.length; i++) {
        const stage = spec.mission.stages[i];
        if ((await state()).mission.stageIndex !== i) throw new Error(`Unexpected stage before ${stage.id}`);
        const before = await state();
        if (stage.type === 'talk' || stage.type === 'interact') {
          const target = [spec.world.npc, ...spec.world.entities, ...spec.world.city.pedestrians].find((p) => stage.entityIds.includes(p.id));
          await walk(target.x, target.z, 1);
          await page.keyboard.down('e'); await wait((stage.holdSec ?? .2) * 1000 + 200); await page.keyboard.up('e');
        } else if (stage.type === 'collect') {
          const target = spec.world.propPlacements.find((p) => stage.entityIds.includes(p.id));
          if ((await state()).city.activeVehicle) { await driveRoute(target); await exit(); }
          await walk(target.x, target.z, .7);
        } else if (stage.type === 'drive') {
          await enter(stage.entityIds[0]);
          const car = (await state()).city.vehicles.find((v) => v.id === stage.entityIds[0]);
          const next = spec.mission.stages[i + 1];
          const target = next && (next.type === 'collect' ? spec.world.propPlacements : spec.world.entities).find((p) => next.entityIds.includes(p.id));
          if (!target) throw new Error('QA requires drive followed by a spatial destination');
          await driveRoute(target);
          check('drive-distance-counts-actual-specified-car', (await state()).city.vehicles.find((v) => v.id === car.id).distance >= stage.distanceMeters,
            (await state()).city.vehicles);
          await shot('driving');
        } else if (stage.type === 'reach') {
          const target = spec.world.entities.find((p) => stage.entityIds.includes(p.id));
          if (!(await state()).city.activeVehicle && Math.hypot((await state()).player[0] - target.x, (await state()).player[2] - target.z) > 35)
            await enter(spec.world.city.vehicles[0].id);
          if ((await state()).city.activeVehicle) { await driveRoute(target); await exit(); }
          await walk(target.x, target.z, 1); await wait(1400);
        } else throw new Error('Unhandled city stage ' + stage.type);
        await wait(350);
        const after = await state();
        check('native-stage-complete-' + stage.id, after.mission.stageIndex > i, { before: before.mission, after: after.mission });
        observed.actions.push({ stage: stage.id, player: after.player, city: after.city, performance: after.performance });
        await shot('stage-' + i); await save();
      }
      const final = await state();
      check('mission-won-with-all-generated-stages', final.phase === 'won' && final.mission.history.length === spec.mission.stages.length, final.mission);
      check('actual-chunk-streaming', final.city.loadedChunkHistory.length > initial.city.activeChunks && final.city.unloadedChunks > 0, final.city);
      check('city-traffic-and-selected-IP-pedestrians-move', final.city.traffic.every((v) => v.moved > 5) && final.city.pedestrians.every((p) => p.walked > 3), final.city);
      check('actual-vehicle-enter-and-exit', final.city.enterCount > 0 && final.city.exitCount > 0, final.city);
      check('selected-NPC-skeletal-animation', final.city.npcKind === 'rigged' && final.city.npcAnimationSeconds > 3
        && final.city.pedestrians.every((p) => p.kind === 'rigged' && p.animationSeconds > 3), final.city.pedestrians);
      check('no-runtime-page-errors', observed.errors.length === 0, observed.errors);
      observed.final = final; observed.status = 'PASS'; await shot('won');
      await page.getByRole('button', { name: '다시 시작', exact: true }).click();
      await page.waitForFunction(() => window.__ipverseGameState?.()?.phase === 'ready', { timeout: 120000 });
      const restarted = await state();
      check('native-restart-resets-city-and-mission', restarted.mission.stageIndex === 0 && restarted.collected === 0
        && restarted.city.enterCount === 0 && restarted.city.vehicles.every((v) => v.distance === 0), restarted);
      await page.getByRole('button', { name: '임무 시작', exact: true }).click();
      await page.waitForFunction(() => window.__ipverseGameState?.()?.phase === 'playing');
      await enter(spec.world.city.vehicles[0].id);
      const current = await state(), car = current.city.vehicles.find((v) => v.id === current.city.activeVehicle);
      const target = cityPlan(spec.world).buildings.filter((b) => Math.abs(b.x - car.position.x) > 20 && b.z < car.position.z - 8)
        .sort((a, b) => Math.hypot(a.x - car.position.x, a.z - car.position.z) - Math.hypot(b.x - car.position.x, b.z - car.position.z))[0];
      if (!target) throw new Error('No nearby collision target');
      let collision;
      const collisionStart = Date.now();
      while (Date.now() - collisionStart < 35000) {
        const s = await state(), v = s.city.vehicles.find((v) => v.id === s.city.activeVehicle);
        if (v.collided) { collision = { vehicle: v, player: s.player, target, mission: s.mission }; break; }
        const delta = wrap(Math.atan2(-(target.x - v.position.x), -(target.z - v.position.z)) - v.yaw);
        const next = [v.speed > 5 ? 'Space' : 'w'];
        if (Math.abs(delta) > .04) next.push(delta > 0 ? 'a' : 'd');
        await keys(next); await wait(70);
      }
      await keys([]);
      check('native-vehicle-contact-stops-at-building', collision && Math.abs(collision.vehicle.speed) < .1
        && (Math.abs(collision.vehicle.position.x - target.x) >= target.width / 2
          || Math.abs(collision.vehicle.position.z - target.z) >= target.depth / 2), collision);
      observed.collisionExercise = collision; await shot('collision');
      await exit();
      console.log(JSON.stringify({ type: item.type, status: observed.status, checks: observed.checks.length, city: final.city, performance: final.performance }));
    } catch (error) {
      observed.status = 'FAIL'; observed.failure = String(error.message); observed.final = await state().catch(() => null);
      await shot('failure').catch(() => {}); console.log(JSON.stringify({ type: item.type, status: 'FAIL', error: observed.failure, state: observed.final }));
    } finally {
      await keys([]).catch(() => {}); const video = page.video(); await context.close();
      if (video) { observed.video = resolve(dir, `${item.type}.webm`); await video.saveAs(observed.video); }
      await save();
    }
  }
} finally { await browser.close(); }
report.status = report.cases.every((c) => c.status === 'PASS') ? 'PASS' : 'FAIL';
report.completedAt = new Date().toISOString(); await save();
if (report.status !== 'PASS') process.exitCode = 1;
