// Dev-only browser smoke test (localhost, ?test=sf|rpg). Drives the game through window.__g3d with synthesized
// keys and writes a JSON report into <pre id="testlog"> for the CLI to read. Never uploaded (dev/ is skipped).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = document.createElement('pre');
log.id = 'testlog';
log.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none';
document.body.append(log);
const report = { status: 'running', steps: [] };
const write = () => { log.textContent = JSON.stringify(report); };
const step = (name, data) => { report.steps.push({ name, ...data }); write(); };

async function waitFor(fn, ms = 20000) {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    const v = fn();
    if (v) return v;
    await sleep(100);
  }
  return null;
}

async function moved(g) {
  const before = g.state().player;
  g.hold('KeyW', true);
  await sleep(1200);
  g.hold('KeyW', false);
  await sleep(200);
  const after = g.state().player;
  return { before, after, distance: +Math.hypot(after[0] - before[0], after[2] - before[2]).toFixed(2) };
}

// Weapon in hand: its world-space size next to the body's (a 0.7 m gun on a 1.8 m body).
async function weapon(g) {
  await sleep(1500);
  const s = g.state();
  step('weapon', { weaponSize: s.weaponSize, bodySize: s.bodySize });
}

async function sf(g) {
  step('move', await moved(g));
  const t0 = performance.now();
  let firstKill = null;
  g.hold('KeyF', true);
  while (performance.now() - t0 < 120000) {
    g.faceNearest();
    const s = g.state();
    if (s.kills > 0 && firstKill == null) { firstKill = +((performance.now() - t0) / 1000).toFixed(1); step('first-kill', { at: firstKill, score: s.score }); }
    if (s.ended) break;
    await sleep(60);
  }
  g.hold('KeyF', false);
  const s = g.state();
  step('end', { kills: s.kills, hp: s.hp, endText: s.endText, seconds: +((performance.now() - t0) / 1000).toFixed(1) });
  await restart(g, 'kills');
}

// Idle presenter: no input for 70 s on the spec's difficulty. Logs HP every 10 s and the lowest HP seen.
async function sfIdle(g) {
  const t0 = performance.now();
  let minHp = 100;
  const samples = [];
  while (performance.now() - t0 < 70000 && !g.state().ended) {
    const s = g.state();
    minHp = Math.min(minHp, s.hp);
    const sec = Math.floor((performance.now() - t0) / 1000);
    if (sec % 10 === 0 && !samples.some((x) => x.t === sec)) samples.push({ t: sec, hp: Math.round(s.hp), kills: s.kills });
    await sleep(100);
  }
  const s = g.state();
  step('idle', { survivedSec: +((performance.now() - t0) / 1000).toFixed(1), alive: !s.ended, minHp: Math.round(minHp), kills: s.kills, samples });
}

// After a clear: Enter restarts, and the new run starts from scratch. (The end card takes no key for its first 0.8 s:
// arpg-data.js endKey.)
async function restart(g, key) {
  await sleep(1000);
  g.press('Enter');
  const fresh = await waitFor(() => { const s = g.state(); return s && !s.ended && s[key] === 0 && s; }, 8000);
  step('restart', { ok: !!fresh, [key]: fresh?.[key] });
}

async function rpg(g) {
  step('move', await moved(g));
  let s = g.state();
  if (s.monsters.length) { // stand next to a monster: it telegraphs, strikes, knocks back; one life per 2 s
    const [mx, mz] = s.monsters[0].at;
    g.teleport(mx + 1.2, mz);
    const states = new Set();
    await waitFor(() => { states.add(g.state().monsters[0].state); return g.state().lives < 3; }, 6000);
    s = g.state();
    step('monster-hit', { lives: s.lives, states: [...states], monster: s.monsters[0] });
    await sleep(2200);
  }
  s = g.state();
  const quest = s.items.find((i) => i.quest) ?? s.items[0];
  if (quest) {
    g.teleport(quest.at[0] + 0.3, quest.at[1]);
    await waitFor(() => g.state().hasItem || g.state().collected > 0, 3000);
    s = g.state();
    step('pickup', { hasItem: s.hasItem, collected: s.collected });
  }
  g.teleport(s.npc[0] + 1.6, s.npc[1]);
  await sleep(300);
  for (let i = 0; i < 12 && !g.state().ended; i++) {
    g.press('KeyE');
    await sleep(400);
    if (i === 0) step('dialogue-open', { dialogue: g.state().dialogue });
  }
  s = g.state();
  step('end', { talkDone: s.talkDone, endText: s.endText, lives: s.lives });
  await restart(g, 'collected');
}

// ?test=anim (dev/spec-sf-anim.json): poses for screenshots. Each pose freezes the frame for `holdMs` and writes
// report.pose = name while frozen, so a CLI polling #testlog can capture it. Order: mid-run (side view), attack,
// enemy death. Also checks that rigged actors exist and that the foot-speed match engaged.
async function anim(g) {
  const holdMs = Number(new URLSearchParams(location.search).get('hold') ?? 3500);
  const frame = (yaw, { distance = 5.2, pitch = 0.22, focus = null, shoulder = rig.shoulder } = {}) => { // move the camera of a frozen frame
    Object.assign(rig, { yaw, distance, pitch, dist: distance, shoulder, first: true });
    const at = focus ?? g.state().player;
    rig.update(0, new g.world.THREE.Vector3(at[0], at[1], at[2]), { look: { x: 0, y: 0 }, down: () => false, pad: null });
  };
  const pose = async (name, data = {}, view = null) => {
    g.freeze(true);
    const saved = { yaw: rig.yaw, distance: rig.distance, pitch: rig.pitch, shoulder: rig.shoulder };
    if (view) view();
    report.pose = name;
    step(`pose-${name}`, { ...data, state: g.state().anim });
    await sleep(holdMs);
    report.pose = null;
    write();
    if (view) frame(saved.yaw, saved);
    g.freeze(false);
  };
  const rig = g.world.rig;
  let s = g.state();
  step('rigged', { player: s.rigged, walkers: s.walkers });
  // run sideways across the camera so the legs read in profile
  g.hold('KeyD', true);
  g.hold('ShiftLeft', true);
  await sleep(1400);
  await pose('run', { speed: g.state().anim?.speed });
  g.hold('ShiftLeft', false);
  await sleep(900);
  await pose('jog', { speed: g.state().anim?.speed });
  g.hold('KeyD', false);
  g.teleport(0, 0); // the open centre: nothing between the camera and the fight
  await sleep(600);
  // fire at the nearest enemy until a walker is down
  const t0 = performance.now();
  let attackShot = false, deathShot = false, enemyShot = false;
  g.hold('KeyF', true);
  while (performance.now() - t0 < 60000 && !deathShot) {
    g.faceNearest();
    s = g.state();
    if (!attackShot && s.anim?.oneShots.some((r) => r.startsWith('attack')) && performance.now() - t0 > 600) {
      attackShot = true;
      await pose('attack', { oneShots: s.anim.oneShots }, () => frame(rig.yaw + Math.PI * 0.72, { distance: 3.8, pitch: 0.12, shoulder: 0 }));
    }
    if (!enemyShot && s.walkersNear >= 2) {
      enemyShot = true;
      const near = g.state().walkerAt, me = g.state().player;
      await pose('enemies', { walkers: s.walkers }, () => frame(Math.atan2(-(near[0] - me[0]), -(near[2] - me[2])) + 0.5, { distance: 8, pitch: 0.28, focus: [(near[0] + me[0]) / 2, 0, (near[2] + me[2]) / 2], shoulder: 0 }));
    }
    if (s.dying > 0 && attackShot) {
      g.hold('KeyF', false);
      await sleep(650); // mid-fall of the death clip
      const at = g.state().dyingAt, me = g.state().player;
      const yaw = Math.atan2(-(at[0] - me[0]), -(at[2] - me[2])) + 0.9; // a three-quarter view of the body
      deathShot = true;
      await pose('death', { kills: g.state().kills }, () => frame(yaw, { distance: 4.2, pitch: 0.32, focus: [at[0], 0, at[2]], shoulder: 0 }));
    }
    if (s.ended) break;
    await sleep(50);
  }
  g.hold('KeyF', false);
  rig.yaw += 0; // keep the camera where the test left it
  step('end', { kills: g.state().kills, hp: g.state().hp, fps: g.state().fps });
}

// ?test=rpg-anim (dev/spec-rpg-anim.json): the rigged monster's swing frozen near its impact, then the player running
// with the sword. Same pose protocol as ?test=anim.
async function rpgAnim(g) {
  const holdMs = Number(new URLSearchParams(location.search).get('hold') ?? 3500);
  const rig = g.world.rig;
  const pose = async (name, focus, yaw, distance = 5) => {
    g.freeze(true);
    const saved = { yaw: rig.yaw, distance: rig.distance, pitch: rig.pitch };
    Object.assign(rig, { yaw, distance, dist: distance, pitch: 0.25, first: true });
    rig.update(0, new g.world.THREE.Vector3(...focus), { look: { x: 0, y: 0 }, down: () => false, pad: null });
    report.pose = name;
    step(`pose-${name}`, {});
    await sleep(holdMs);
    report.pose = null;
    write();
    Object.assign(rig, saved, { first: true });
    g.freeze(false);
  };
  let s = g.state();
  const [mx, mz] = s.monsters[0].at;
  g.teleport(mx + 1.2, mz);
  const t0 = performance.now();
  while (performance.now() - t0 < 6000 && g.state().monsters[0].state !== 'windup') await sleep(16);
  await sleep(450); // most of the telegraph: the swing is near its impact
  s = g.state();
  const [px, py, pz] = s.player;
  await pose('monster-attack', [(px + mx) / 2, py, (pz + mz) / 2], Math.atan2(-(mx - px), -(mz - pz)) + Math.PI / 2, 4.5);
  await sleep(2500);
  g.hold('KeyD', true);
  g.hold('ShiftLeft', true);
  await sleep(1300);
  s = g.state();
  await pose('rpg-run', s.player, rig.yaw + 0.3, 4.5);
  g.hold('KeyD', false);
  g.hold('ShiftLeft', false);
  // player combat: the rigged monster staged next to the player in the open; attack (F held) until it dies
  await sleep(2200); // past the hit i-frames
  s = g.state();
  const kills0 = s.kills;
  const staged = g.stage();
  if (!staged) return step('player-attack', { error: 'no monster' });
  const [, , mx0, mz0] = staged;
  const view = () => { const me = g.state().player; return [[(me[0] + mx0) / 2, me[1], (me[2] + mz0) / 2], Math.atan2(-(mx0 - me[0]), -(mz0 - me[2])) + Math.PI / 2]; };
  await sleep(100);
  g.hold('KeyF', true);
  let posed = false;
  const t1 = performance.now();
  while (performance.now() - t1 < 15000 && g.state().kills === kills0) {
    s = g.state();
    if (!posed && s.oneShots.some((r) => r.startsWith('attack') || r === 'punch')) {
      posed = true;
      g.hold('KeyF', false);
      await sleep(170); // the swing near its impact
      const [focus, yaw] = view();
      await pose('player-attack', focus, yaw, 4.2);
      g.hold('KeyF', true);
    }
    await sleep(16);
  }
  g.hold('KeyF', false);
  await sleep(1100); // the death clip mid-fall
  s = g.state();
  step('player-kill', { kills: s.kills, score: s.score, dying: s.dying, weapon: s.weapon, posed });
  if (s.kills > kills0) {
    const [focus, yaw] = view();
    await pose('monster-death', focus, yaw - 0.5, 4.6);
  }
}

// ?test=platform (a fallRespawn platformer): the hero's model and body scale, the jump apex on the floor, a front
// pose for a screenshot (report.pose = 'hero' while frozen), then the climb: from the spawn onto the first platform,
// and every hop between consecutive static platforms, walking (no sprint) and jumping at the edge. Movers are skipped.
async function platform(g) {
  const holdMs = Number(new URLSearchParams(location.search).get('hold') ?? 3500);
  const rig = g.world.rig;
  const face = (dx, dz) => { rig.yaw = Math.atan2(-dx, -dz); };
  let s = g.state();
  step('hero', { actorKind: s.actorKind, rigDropped: s.rigDropped, bodyScale: s.bodyScale, mechanics: s.mechanics });
  // apex: standing jump on the floor
  const [sx, , sz] = s.player;
  let top = 0;
  g.press('Space', 80);
  for (let t = 0; t < 70; t++) { top = Math.max(top, g.state().player[1]); await sleep(16); }
  step('apex', { metres: +top.toFixed(3) });
  await sleep(500);
  // front pose of the hero
  g.freeze(true);
  const saved = { yaw: rig.yaw, distance: rig.distance, pitch: rig.pitch };
  Object.assign(rig, { yaw: rig.yaw + Math.PI, distance: 3.6, dist: 3.6, pitch: .12, first: true });
  rig.update(0, new g.world.THREE.Vector3(...g.state().player), { look: { x: 0, y: 0 }, down: () => false, pad: null });
  report.pose = 'hero';
  step('pose-hero', { bodyScale: g.state().bodyScale });
  await sleep(holdMs);
  report.pose = null; write();
  Object.assign(rig, saved, { first: true });
  g.freeze(false);
  // the climb
  const spec = await (await fetch(new URLSearchParams(location.search).get('spec') || './spec.json')).json();
  const plats = spec.world.entities.filter((e) => e.kind === 'platform');
  const topOf = (p) => (p.y ?? 0) + (p.height ?? 2);
  const hop = async (from, to, label) => {
    if (from) g.teleport(from.x, from.z, topOf(from) + .05); else g.teleport(sx, sz);
    await sleep(400);
    const at = g.state().player;
    face(to.x - at[0], to.z - at[2]);
    g.hold('KeyW', true);
    let jumped = false, landed = false, peak = at[1];
    const t0 = performance.now();
    while (performance.now() - t0 < 4000) {
      const p = g.state().player;
      peak = Math.max(peak, p[1]);
      const dx = to.x - p[0], dz = to.z - p[2];
      face(dx, dz);
      const edge = Math.max(Math.abs(dx) - (to.width ?? 2) / 2, Math.abs(dz) - (to.depth ?? 2) / 2);
      // jump at the edge of the top stood on (from the floor: a metre short of the target)
      const inside = from ? Math.min((from.width ?? 2) / 2 - Math.abs(p[0] - from.x), (from.depth ?? 2) / 2 - Math.abs(p[2] - from.z)) : edge;
      if (!jumped && g.state().grounded && (from ? inside < .45 : edge < 1.1)) { g.press('Space', 80); jumped = true; }
      if (jumped && g.state().grounded && Math.abs(p[1] - topOf(to)) < .08) { landed = true; break; }
      if (jumped && p[1] < (from ? topOf(from) : 0) - .5) break; // fell
      await sleep(16);
    }
    g.hold('KeyW', false);
    const row = { label, to: to.id, rise: +(topOf(to) - (from ? topOf(from) : 0)).toFixed(2), landed, peak: +peak.toFixed(2) };
    step('hop', row);
    return row;
  };
  const statics = plats.filter((p) => !p.motion);
  const order = [...statics].sort((a, b) => topOf(a) - topOf(b));
  const rows = [await hop(null, order[0], 'spawn')];
  for (let i = 0; i + 1 < order.length; i++) {
    const a = order[i];
    const b = order.slice(i + 1).sort((p, q) => Math.hypot(p.x - a.x, p.z - a.z) - Math.hypot(q.x - a.x, q.z - a.z))[0];
    if (Math.hypot(b.x - a.x, b.z - a.z) > 12) continue; // reached over a mover: not a static hop
    rows.push(await hop(a, b, `${a.id}->${b.id}`));
  }
  step('climb', { hops: rows.length, landed: rows.filter((r) => r.landed).length, failed: rows.filter((r) => !r.landed).map((r) => r.label) });
}

// ?test=clear (a fallRespawn platformer): plays the whole climb with keys only, no teleport. Platforms in order of
// their tops (movers too); a fall puts the hero back on the last top (fallCheck) and the hop is tried again, up to
// 5 times. At the end it stands on every reach target of the current stage until the round ends.
async function clear(g) {
  const spec = await (await fetch(new URLSearchParams(location.search).get('spec') || './spec.json')).json();
  const rig = g.world.rig;
  const t0 = performance.now();
  const face = (x, z) => { const p = g.state().player; rig.yaw = Math.atan2(-(x - p[0]), -(z - p[2])); };
  const topOf = (p) => (p.y ?? 0) + (p.height ?? 2);
  const walkTo = async (x, z, ms = 4000) => {
    const t = performance.now();
    g.hold('KeyW', true);
    while (performance.now() - t < ms) {
      const p = g.state().player;
      if (Math.hypot(x - p[0], z - p[2]) < .35 || g.state().ended) break;
      face(x, z);
      await sleep(16);
    }
    g.hold('KeyW', false);
    await sleep(120);
  };
  const order = spec.world.entities.filter((e) => e.kind === 'platform').sort((a, b) => topOf(a) - topOf(b));
  if (g.state().phase === 'ready') { g.press('Enter'); await sleep(1500); } // past the mission card
  let from = null, falls = 0;
  const log = [];
  for (const to of order) {
    let landed = false, tries = 0;
    while (!landed && tries < 5 && !g.state().ended) {
      tries++;
      if (from) await walkTo(from.x, from.z); // the middle of this top (moving tops drift: close enough)
      g.hold('KeyW', true);
      let jumped = false, air = false;
      const t = performance.now();
      while (performance.now() - t < 4500) {
        const s = g.state(), p = s.player;
        face(to.x, to.z);
        const edge = Math.max(Math.abs(to.x - p[0]) - (to.width ?? 2) / 2, Math.abs(to.z - p[2]) - (to.depth ?? 2) / 2);
        const stand = from ?? null;
        const inside = stand ? Math.min((stand.width ?? 2) / 2 - Math.abs(p[0] - stand.x), (stand.depth ?? 2) / 2 - Math.abs(p[2] - stand.z)) : edge;
        if (!jumped && s.grounded && (stand ? inside < .45 || edge < .6 : edge < 1.1)) { g.press('Space', 80); jumped = true; }
        if (jumped && !s.grounded) air = true;
        if (air && s.grounded && Math.abs(p[1] - topOf(to)) < .15 && edge < .3) { landed = true; break; }
        if (air && s.grounded && p[1] < topOf(to) - .5) break; // back down: on the floor or respawned on the last top
        await sleep(16);
      }
      g.hold('KeyW', false);
      if (!landed) { falls++; await sleep(1200); } // fallCheck's respawn and its grace
    }
    log.push({ to: to.id, tries, landed });
    if (!landed) break;
    from = to;
  }
  if (from) await walkTo(from.x, from.z);
  step('climbed', { hops: log.length, landed: log.filter((r) => r.landed).length, falls, failed: log.filter((r) => !r.landed).map((r) => r.to),
    collected: g.state().collected, stage: g.state().mission?.stageId ?? null });
  // the last stage: stand on each reach target in turn
  const stop = performance.now() + 30000;
  while (!g.state().ended && performance.now() < stop) {
    const stage = spec.mission.stages.find((st) => st.id === g.state().mission?.stageId) ?? spec.mission.stages.at(-1);
    for (const id of stage.entityIds ?? []) {
      const e = spec.world.entities.find((x) => x.id === id);
      if (e) { await walkTo(e.x, e.z, 6000); await sleep(1600); }
      if (g.state().ended) break;
    }
  }
  const s = g.state();
  step('end', { ended: s.ended, endText: s.endText, seconds: +((performance.now() - t0) / 1000).toFixed(1), hp: s.hp, mission: s.mission });
}

// ?test=gait: the hero walks 2 s; the body's hop (y), lean (x), twist (y) and waddle (z) and its scale, per frame.
async function gait(g) {
  g.press('Enter'); await sleep(1500); // past the mission card
  const rows = [];
  g.hold('KeyW', true);
  const t0 = performance.now();
  while (performance.now() - t0 < 2000) { const s = g.state(); rows.push({ pose: s.bodyPose, scale: s.bodyScale }); await sleep(16); }
  g.hold('KeyW', false);
  const col = (i) => rows.map((r) => r.pose[i]);
  const range = (a) => +(Math.max(...a) - Math.min(...a)).toFixed(3);
  const s = g.state();
  step('gait', { actorKind: s.actorKind, rigDropped: s.rigDropped, frames: rows.length, hopM: range(col(0)), leanMax: Math.max(...col(1)),
    twist: range(col(2)), waddle: range(col(3)), scales: [...new Set(rows.map((r) => r.scale.join(',')))] });
}

// ?test=sky: walk off the start island's far edge (away from the climb) into the air, fall, and come back.
async function sky(g) {
  const spec = await (await fetch(new URLSearchParams(location.search).get('spec') || './spec.json')).json();
  g.press('Enter'); await sleep(1500); // past the mission card
  const before = g.state();
  const sp = spec.world.spawn;
  g.world.rig.yaw = Math.atan2(-0, -1); // face +Z: off the start island's side, away from the climb (+X)
  let minY = 0, airborne = false;
  g.hold('KeyW', true);
  const t0 = performance.now();
  while (performance.now() - t0 < 6000) {
    const s = g.state();
    minY = Math.min(minY, s.player[1]);
    if (!s.grounded) airborne = true;
    if (s.sky?.falls > before.sky?.falls) break;
    await sleep(16);
  }
  g.hold('KeyW', false);
  await sleep(600);
  const s = g.state();
  step('sky', { sky: s.sky, spawn: [sp.x, sp.z], left: airborne, lowestY: +minY.toFixed(2), backAt: s.player, grounded: s.grounded, hp: s.hp,
    background: s.background?.render ?? null });
}

// ?test=sky-climb&autoplay=1: the built-in player climbs the islands by itself; this only watches. Each fall is
// logged with the last 1.5 s of the track (position, grounded, the step it aimed at, jump), and each round's end.
async function skyClimb(g) {
  const t0 = performance.now(), track = [], falls = [], rounds = [];
  let last = g.state(), wasEnded = false;
  while (performance.now() - t0 < 100000 && rounds.length < 5) {
    const s = g.state(), at = +((performance.now() - t0) / 1000).toFixed(2);
    track.push({ at, p: s.player, g: s.grounded, next: s.sky?.next, jump: s.sky?.jump, stage: s.mission?.stageIndex });
    while (track.length && at - track[0].at > 1.5) track.shift();
    if ((s.sky?.falls ?? 0) > (last.sky?.falls ?? 0)) falls.push({ at, track: track.slice() });
    if (s.ended && !wasEnded) rounds.push({ at, endText: s.endText, hp: s.hp, falls: s.sky?.falls, collected: s.collected });
    wasEnded = !!s.ended; last = s;
    step('progress', { at, falls: falls.length, rounds: rounds.length }); report.steps.splice(0, report.steps.length - 1);
    await sleep(30);
  }
  report.steps = [];
  step('sky-climb', { rounds, falls });
}

(async () => {
  const g = await waitFor(() => window.__g3d?.state() && window.__g3d);
  if (!g) { report.status = 'no game'; return write(); }
  await sleep(5500); // past the start grace
  try {
    const mode = new URLSearchParams(location.search).get('test');
    await ({ sf, 'sf-idle': sfIdle, rpg, anim, 'rpg-anim': rpgAnim, weapon, platform, clear, gait, sky, 'sky-climb': skyClimb }[mode] ?? rpg)(g);
    report.fps = g.state().fps;
    report.status = 'done';
  } catch (err) {
    report.status = `error: ${err.message}`;
  }
  write();
})();
