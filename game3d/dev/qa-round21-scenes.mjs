// More scenes of dev/qa-round20.mjs, played with real key events on this checkout's runtime. Run them by name, into
// their own folder:
//   node game3d/dev/qa-round20.mjs --cdp=<port> --out=evidence/round21/G --only=wall,arrow,endkeys,firststage,botreason,smalltext,cast,climb,arpgbot
export default async function scenes({ scene, game, fixture, serve, sleep, SEEN }) {
  const seen = (page) => page.read(SEEN);
  const ready = async (page) => {
    await page.until(`(() => { const b = document.querySelector('.briefing-start'); return document.getElementById('loading').hidden && document.getElementById('ad').hidden && (!b || !b.disabled); })()`, 300, 'the game is loaded');
  };
  const start = async (page) => {
    await ready(page);
    if (await page.read(`!!document.querySelector('.briefing:not([hidden])')`)) await page.clickOn('.briefing-start');
    await page.until(`(() => { const b = document.querySelector('.briefing'); return !b || b.hidden; })()`, 30, 'the round started');
  };
  /** What the page is asked to remember: when the end card came up, the keys it heard since, every popup, the rounds
   * started. (Read-only: it listens and writes nothing to the game.) */
  const WATCH = `(() => { if (window.__qa21) return; const q = window.__qa21 = { endAt: null, keys: [], popups: [], starts: 0 };
    const end = document.getElementById('end');
    new MutationObserver(() => { q.endAt = end.hidden ? null : q.endAt ?? performance.now(); }).observe(end, { attributes: true, attributeFilter: ['hidden'] });
    addEventListener('keydown', (e) => { if (q.endAt != null) q.keys.push({ code: e.code, ms: Math.round(performance.now() - q.endAt), repeat: e.repeat, on: e.target.id || e.target.tagName }); }, true);
    new MutationObserver((list) => { for (const m of list) for (const n of m.addedNodes) if (n.classList?.contains('popup')) q.popups.push(n.textContent); })
      .observe(document.getElementById('floats'), { childList: true });
    addEventListener('ipverse:roundstart', () => { q.starts += 1; });
  })()`;
  const ended = `!document.getElementById('end').hidden`;
  /** Until the page's `expression` is true, asked every 15 ms (a key must follow the end card at once). */
  const soon = async (page, expression, seconds = 20) => {
    for (const t0 = Date.now(); Date.now() - t0 < seconds * 1000; await sleep(15)) if (await page.read(expression).catch(() => false)) return true;
    throw new Error(`not within ${seconds} s: ${expression}`);
  };

  // ---- the wall the ARPG's camera cuts away keeps a low edge ----
  // (The hero is put by the wall by the page's localhost hook; the walk is real keys.)
  await scene('wall', async ({ open, check, said }) => {
    const page = await open(game('gm_b870737b47'));
    await start(page);
    await sleep(600);
    await page.tap('KeyE'); // the story box
    await page.read(`void window.__g3d.teleport(13.46, -24.18)`);
    await sleep(600);
    said.shots.push(await page.shot('wall-room1-before-the-walk'));
    await page.down('KeyA'); await page.down('KeyS'); // down the screen: toward the second room
    await sleep(3200);
    const at = (await seen(page)).player;
    const wall = await page.read(`(() => { const m = window.__g3d.mode(), w = m.world.rig.occluders.find((o) => o.root === m.entities.get('w1_d').group);
      const edges = m.root.children.filter((c) => c.name === 'wall-edge');
      const own = edges.find((c) => Math.abs(c.position.x - 13) < .1 && Math.abs(c.position.z + 18) < .1);
      return { faded: !!w?.faded, opacity: w?.fade ?? 1, edges: edges.length,
        edge: own ? { height: own.geometry.parameters.height, width: own.geometry.parameters.width, depth: own.geometry.parameters.depth, visible: own.visible,
          opacity: own.material.opacity, transparent: own.material.transparent } : null }; })()`);
    said.wall = { at, ...wall };
    check('the hero is stopped by the wall between the rooms (z about -19.2)', at && Math.abs(at[2] + 19.2) < .2, at);
    check('that wall is cut away for the camera (faded under half)', wall.faded && wall.opacity < .6, wall);
    check('and its low edge stays solid under it: the wall\'s footprint, knee-high', !!wall.edge && wall.edge.visible && wall.edge.opacity === 1 && !wall.edge.transparent
      && wall.edge.height > .3 && wall.edge.height < .6 && wall.edge.width > 14 && wall.edge.depth > 1.5, wall);
    said.shots.push(await page.shot('wall-against-1280x720'));
    await page.up('KeyA'); await page.up('KeyS');
    // the room's own outer wall on the camera's side, and a pillar
    await page.read(`void window.__g3d.teleport(57, -40)`);
    await page.down('KeyD'); await page.down('KeyS'); await sleep(1500); await page.up('KeyD'); await page.up('KeyS');
    said.shots.push(await page.shot('wall-outer-east'));
    await page.read(`void window.__g3d.teleport(16.5, -29.5)`);
    await sleep(900);
    said.shots.push(await page.shot('wall-pillar'));
    await page.resize(1440, 900); await sleep(500);
    await page.read(`void window.__g3d.teleport(13.46, -19.3)`);
    await sleep(900);
    said.shots.push(await page.shot('wall-against-1440x900'));
  });

  // ---- the arrow leads through the door ----
  await scene('arrow', async ({ open, check, said }) => {
    const page = await open(game('gm_b870737b47'));
    await start(page);
    await sleep(600);
    await page.tap('KeyE');
    // the second stage with the hero in the first room (the localhost hook stands in for the fight: the first room's
    // soldiers are felled and the stage counted, then the hero is put back by the wall)
    await page.read(`(() => { const m = window.__g3d.mode(); m.pendingSpawns = []; for (const e of [...m.enemies]) m.hitEnemy(e, 9999); m.director.progress = m.director.stage.target; })()`);
    await page.until(`window.__ipverseGameState().mission.stageIndex === 1 && window.__ipverseGameState().enemies.length >= 7 && window.__ipverseGameState().pendingSpawns === 0`, 120, 'the second stage\'s enemies are up');
    await sleep(500);
    await page.tap('KeyE');
    await page.read(`void window.__g3d.teleport(50, -20)`);
    await sleep(700);
    // (fight: an enemy that counts within 12 m with no wall between, which is where the arrow rightly hides)
    const read = `(() => { const n = document.querySelector('.goal-arrow'), l = n?.firstChild, s = window.__ipverseGameState(), m = window.__g3d.mode(), p = m.player.pos;
      const fight = m.enemies.some((e) => m.director.matches({ type: e.boss ? 'boss' : 'kills', entityId: e.id, enemyIndex: e.enemyIndex }) && e.pos.distanceTo(p) < 12
        && !m.blocked(p.clone().setY(1), e.pos.clone().setY(1)));
      return n && !n.hidden ? { text: l.textContent, left: parseFloat(l.style.left), top: parseFloat(l.style.top), player: s.player, fight } : { text: null, player: s.player, fight }; })()`;
    const first = await page.read(read);
    said.first = first;
    said.shots.push(await page.shot('arrow-room1-east'));
    // where its line meets the wall between the rooms (z -18.75; east of its door the wall is x 6 … 60): null when it
    // points away from the wall
    const meets = (a) => { const world = Math.atan2(a.left, -a.top) - Math.PI / 4, dx = Math.sin(world), dz = -Math.cos(world), t = (-18.75 - a.player[2]) / dz;
      return t > 0 ? +(a.player[0] + dx * t).toFixed(1) : null; };
    check('the arrow shows, for an enemy', /^➤ 적 \d+m$/.test(first.text ?? ''), first);
    const x = first.text ? meets(first) : NaN;
    check('its line keeps to this side of the wall as far as the door (it does not run into the wall east of x 6)', x === null || x < 5.6, { meetsWallAtX: x, ...first });
    check('its metres are the walk round by the door (over 55 m from here), not the 19 m through the wall', Number(/(\d+)m$/.exec(first.text ?? '')?.[1]) > 55, first.text);
    // a person holds the keys toward the arrow: the nearest of the eight ways, looked at five times a second
    const held = new Set(), log = [];
    const hold = async (want) => { for (const k of [...held]) if (!want.has(k)) { await page.up(k); held.delete(k); } for (const k of want) if (!held.has(k)) { await page.down(k); held.add(k); } };
    let reached = null;
    for (const t0 = Date.now(); Date.now() - t0 < 40000;) {
      const a = await page.read(read);
      if (log.length % 5 === 0) log.push({ t: +((Date.now() - t0) / 1000).toFixed(1), text: a.text, at: a.player.map((n) => +n.toFixed(1)) }); else log.push(null);
      if (a.player[2] > -17.25 || a.fight) { reached = { seconds: +((Date.now() - t0) / 1000).toFixed(1), at: a.player, where: a.fight ? 'the fight' : 'the second room', arrow: a.text }; break; }
      // no arrow and no enemy in sight (one stands 10 m off behind the wall): nothing to follow, the person stands
      const way = a.text ? Math.round(Math.atan2(a.left, -a.top) / (Math.PI / 4)) * Math.PI / 4 : null, sx = way == null ? 0 : Math.round(Math.sin(way)), sy = way == null ? 0 : Math.round(Math.cos(way));
      await hold(new Set([sx > 0 && 'KeyD', sx < 0 && 'KeyA', sy > 0 && 'KeyW', sy < 0 && 'KeyS'].filter(Boolean)));
      await sleep(200);
    }
    await hold(new Set());
    said.walk = { reached, log: log.filter(Boolean) };
    check('with the keys held toward the arrow the hero walks through the door into the second room (or meets the enemies on the way)', !!reached, said.walk);
    said.shots.push(await page.shot('arrow-after-the-walk'));
  });

  // ---- the end card takes no key for its first 0.8 s ----
  await scene('endkeys', async ({ open, check, said }) => {
    const page = await open(fixture('spec-authored-garden'));
    await start(page);
    await page.read(WATCH);
    said.presses = [];
    for (const code of ['Enter', 'Space']) {
      // the round ends (the garden has nothing that kills: the page's localhost hook), and the key follows at once
      await page.until(`window.__ipverseGameState()?.phase === 'playing'`, 60, 'a round is on');
      await sleep(700);
      await page.read(`void (window.__g3d.mode().hp = 0)`);
      await soon(page, ended);
      await page.tap(code, 40);
      const key = await page.read(`window.__qa21.keys.filter((k) => k.code === '${code}').at(-1) ?? null`);
      await sleep(900);
      const still = await page.read(ended);
      said.presses.push({ code, key, cardStillUp: still });
      if (key && key.ms < 800) check(`${code} ${key.ms} ms after the end card came up does not press 다시 시작`, still, { key, cardStillUp: still });
      else check(`${code} reached the page within 0.8 s of the end card (a slow machine: run again)`, false, key);
      said.shots.push(await page.shot(`endkeys-${code.toLowerCase()}-card-still-up`));
      // the same key again, the card up for over 0.8 s: 다시 시작
      if (still) await page.tap(code, 40);
      await page.until(`document.getElementById('end').hidden && window.__ipverseGameState()?.phase === 'playing'`, 60, `${code} after 0.8 s starts the next round`);
      check(`${code} pressed again after 0.8 s starts the next round`, true);
    }
    // Space held down since the round (a jump): its repeats are no press; a new press is
    await sleep(700);
    await page.down('Space');
    await page.read(`void (window.__g3d.mode().hp = 0)`);
    await soon(page, ended);
    for (let n = 0; n < 12; n++) { await page.down('Space', { autoRepeat: true }); await sleep(120); }
    await page.up('Space');
    await sleep(300);
    const heldUp = await page.read(ended);
    said.held = { cardStillUp: heldUp, keys: await page.read(`window.__qa21.keys.slice(-14)`) };
    check('a Space held down as the round ended never presses 다시 시작 (1.5 s of repeats, then its release)', heldUp, said.held);
    await page.tap('Space', 40);
    await page.until(`document.getElementById('end').hidden`, 30, 'a new press of Space starts the next round');
    check('a new press of Space does', true);
    // a click on the button works
    await page.until(`window.__ipverseGameState()?.phase === 'playing'`, 60, 'a round is on');
    await sleep(500);
    await page.read(`void (window.__g3d.mode().hp = 0)`);
    await soon(page, ended);
    await sleep(900);
    await page.clickOn('#restart');
    await page.until(`document.getElementById('end').hidden`, 30, 'a click on 다시 시작');
    check('a click on 다시 시작 starts the next round', true);
  });

  // ---- 다시 시작 in the first stage is a fresh start; a later stage is a checkpoint ----
  await scene('firststage', async ({ open, check, said }) => {
    const page = await open(fixture('spec-authored-garden'));
    await start(page);
    await page.read(WATCH);
    await sleep(1200);
    await page.tap('Escape');
    const said1 = await page.read(`document.querySelector('.pause-next')?.textContent ?? null`);
    check('in the first stage the pause card says 다시 시작 starts over', said1 === '다시 시작을 누르면 처음부터 다시 해요.', said1);
    await page.read(`void (window.__qa21.popups.length = 0)`);
    await page.clickOn('#pause button.quiet');
    await page.until(`window.__qa21.starts >= 1 && window.__ipverseGameState()?.phase === 'playing' && document.getElementById('pause').hidden`, 60, 'the round starts over');
    await sleep(1500);
    const fresh = await page.read(`({ popups: window.__qa21.popups.slice(), resumedAt: window.__ipverseGameState().resumedAt, iframes: window.__ipverseGameState().iframes })`);
    said.fresh = fresh;
    check('and the round that opens says nothing of a checkpoint or of invulnerability', !fresh.popups.some((text) => /체크포인트|무적/.test(text)), fresh.popups);
    check('it is a fresh start: no checkpoint, the hero not invulnerable', fresh.resumedAt === null && fresh.iframes === 0, fresh);
    said.shots.push(await page.shot('firststage-after-restart'));
    // the second stage (the crystal picked up, W held): 다시 시작 goes on from it, and says so
    await page.down('KeyW');
    await page.until(`window.__ipverseGameState().mission.stageIndex === 1`, 30, 'the crystal is picked up (W held)');
    await page.up('KeyW');
    await page.tap('Escape');
    const said2 = await page.read(`document.querySelector('.pause-next')?.textContent ?? null`);
    await page.read(`void (window.__qa21.popups.length = 0)`);
    await page.clickOn('#pause button.quiet');
    await page.until(`window.__qa21.starts >= 2 && window.__ipverseGameState()?.phase === 'playing' && document.getElementById('pause').hidden`, 60, 'the round goes on');
    await sleep(400);
    said.shots.push(await page.shot('firststage-checkpoint-stage2'));
    await sleep(800);
    const later = await page.read(`({ popups: window.__qa21.popups.slice(), resumedAt: window.__ipverseGameState().resumedAt })`);
    said.later = { card: said2, ...later };
    check('from the second stage the card says 2단계부터, and the round opens with the checkpoint\'s line',
      said2 === '다시 시작을 누르면 2단계부터 이어서 해요.' && later.resumedAt === 1 && later.popups.includes('체크포인트 · 2단계부터 다시 · 잠시 무적'), said.later);
  });

  // ---- the built-in player's reason on the end card is 해요체 ----
  await scene('botreason', async ({ open, check, said }) => {
    const page = await open(fixture('spec-authored-garden', '&autoplay=1&noads=1'));
    await page.until(`window.__ipverseGameState?.()?.phase === 'playing'`, 120, 'the built-in player started the round');
    // the watchdog's own end (its 40 s are not waited for: through the page's hook the round's progress stands still
    // and its clock is put 41 s on)
    await page.read(`void (window.__g3d.mode().progressKey = () => 'stuck')`);
    await sleep(400);
    await page.read(`void (window.__g3d.mode().elapsed += 41)`);
    await page.until(ended, 30, 'the watchdog ends the round');
    const at = await seen(page);
    said.end = at.end;
    check('the card\'s reason is 해요체, as its other lines', /진행이 멈춰서 이번 판을 마쳐요\./.test(at.end ?? '') && !/니다/.test(at.end ?? ''), at.end);
    said.shots.push(await page.shot('botreason-end-card'));
  });

  // ---- a version-2 game's enemies load with the game, not at their first appearance ----
  await scene('cast', async ({ open, check, said }) => {
    serve.bytesPerSec = Number(process.env.QA_BYTES_PER_SEC) || 1.25 * 1048576; // the assets at 10 Mbit/s
    try {
      const page = await open(game('gm_9539d06a71'));
      const enemy = 'ip_6e05239eda.glb';
      let total = null; // the megabytes the loading screen counts
      for (const t0 = Date.now(); Date.now() - t0 < 300000; await sleep(300)) {
        const at = await page.read(`(() => { const b = document.querySelector('.briefing-start'); return { lit: !!b && !b.disabled && document.getElementById('loading').hidden,
          detail: document.getElementById('loading-detail')?.innerText ?? '' }; })()`).catch(() => null);
        const mb = /\/ (\d+\.\d)\s*MB/.exec(at?.detail ?? '')?.[1];
        if (mb) total = Number(mb);
        if (at?.lit) break;
      }
      const model = await page.read(`(() => { const e = performance.getEntriesByType('resource').filter((r) => r.name.endsWith('${enemy}') && r.initiatorType !== 'other').at(-1);
        return e ? { askedAt: +(e.startTime / 1000).toFixed(1), inAt: +(e.responseEnd / 1000).toFixed(1), bytes: e.decodedBodySize, now: +(performance.now() / 1000).toFixed(1) } : null; })()`);
      said.model = model; said.totalMB = total;
      check('the enemy\'s model is in before the start button lights', !!model && model.inAt > 0 && model.inAt <= model.now, model);
      check('the loading figure\'s megabytes hold it', total != null && model && total * 1048576 > model.bytes, { totalMB: total, enemyMB: model && +(model.bytes / 1048576).toFixed(1) });
      await page.clickOn('.briefing-start');
      const t0 = Date.now();
      await page.until(`(window.__ipverseGameState()?.enemies.length ?? 0) > 0`, 60, 'the first enemy is up');
      said.firstEnemySec = +((Date.now() - t0) / 1000).toFixed(1);
      check('the first enemy is up within 4 s of the start click at 10 Mbit/s (it took 9.5 s)', said.firstEnemySec < 4, said.firstEnemySec);
      said.shots.push(await page.shot('cast-first-enemy'));
    } finally { serve.bytesPerSec = 0; }
  });

  // ---- the built-in player climbs: two sky games and two platformers on a floor ----
  await scene('climb', async ({ open, check, said }) => {
    said.rounds = {};
    const person = await open(game('gm_8e8d7902ed'));
    await ready(person);
    const yaw = await person.read(`window.__g3d.world.rig.yaw`);
    said.startYaw = yaw;
    check('gm_8e8d7902ed: the start camera faces the first island (due east of the spawn: yaw -90°)', Math.abs(yaw + Math.PI / 2) < .01, yaw);
    await person.clickOn('.briefing-start');
    await sleep(1500);
    said.shots.push(await person.shot('climb-gm_8e8d7902ed-start'));
    await person.close();
    for (const id of ['gm_8e8d7902ed', 'gm_1e7d17bbb0', 'gm_5e7199df8f', 'gm_8f1fc9a181']) {
      const page = await open(game(id, '?autoplay=1&noads=1'));
      await page.until(`window.__ipverseGameState?.()?.phase === 'playing'`, 300, 'the built-in player started the round');
      const t0 = Date.now();
      let shot = false;
      for (; Date.now() - t0 < 200000; await sleep(500)) {
        if (!shot && Date.now() - t0 > 6000) { said.shots.push(await page.shot(`climb-${id}-6s`)); shot = true; }
        if (await page.read(ended)) break;
      }
      const at = await seen(page), state = await page.read(`(() => { const s = window.__ipverseGameState(); return { falls: s.sky?.falls ?? null, hp: s.hp, stage: s.mission.stageIndex, completed: s.mission.completed }; })()`);
      said.rounds[id] = { seconds: +((Date.now() - t0) / 1000).toFixed(1), end: at.end, ...state };
      check(`${id}: the built-in player clears the round`, /^클리어!/.test(at.end ?? '') && state.completed, said.rounds[id]);
      said.shots.push(await page.shot(`climb-${id}-end`));
      await page.close();
    }
  });

  // ---- the ARPG the built-in player wins, with the walls' edges and the arrow's search in place ----
  // it clears, and the picture keeps its pace (the frame times are the page's own: world.js performanceSnapshot)
  await scene('arpgbot', async ({ open, check, said }) => {
    const page = await open(game('gm_b870737b47', '?autoplay=1&noads=1'));
    await page.until(`window.__ipverseGameState?.()?.phase === 'playing'`, 300, 'the built-in player started the round');
    const t0 = Date.now(), stages = [];
    for (; Date.now() - t0 < 230000; await sleep(1000)) {
      const at = await page.read(`({ stage: window.__ipverseGameState().mission.stageIndex, ended: ${ended}, perf: window.__ipverseGameState().performance })`).catch(() => null);
      if (!at) continue;
      if (stages.at(-1)?.stage !== at.stage) stages.push({ stage: at.stage, t: +((Date.now() - t0) / 1000).toFixed(0) });
      said.perf = at.perf;
      if (at.ended) break;
    }
    const at = await seen(page);
    said.round = { seconds: +((Date.now() - t0) / 1000).toFixed(1), end: at.end, stages };
    check('the built-in player still clears the crypt', /^클리어!/.test(at.end ?? ''), said.round);
    check('the picture keeps its pace over the round (mean over 40 frames a second on a loaded machine)', said.perf?.meanFps > 40, said.perf);
    said.shots.push(await page.shot('arpgbot-end'));
  });

  // ---- at phone width the key line and the ARPG's panel are readable ----
  await scene('smalltext', async ({ open, check, said }) => {
    const page = await open(game('gm_b870737b47'), { width: 390, height: 844 });
    await start(page);
    await page.tap('KeyE');
    await sleep(2500);
    const sizes = await page.read(`(() => { const px = (n) => parseFloat(getComputedStyle(n).fontSize), box = (n) => { const r = n.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)]; };
      const hint = document.getElementById('hint'), panel = document.getElementById('arpg'), vitals = document.getElementById('vitals'), hero = innerHeight / 2;
      return { hint: px(hint), hintBox: box(hint), panel: px(panel), level: px(panel.querySelector('.arpg-level b')), stats: px(panel.querySelector('.arpg-stats')), panelBox: box(panel),
        vitalsBox: box(vitals), window: [innerWidth, innerHeight], scrolls: document.documentElement.scrollWidth > innerWidth }; })()`);
    said.sizes = sizes;
    check('the line under the game is 12 px or more at 390 px', sizes.hint >= 12, sizes.hint);
    check('the ARPG panel\'s text is 12 px or more', sizes.panel >= 12 && sizes.stats >= 12, [sizes.panel, sizes.stats]);
    check('the panel stays a corner box: inside the window, clear of the hero in the middle', sizes.panelBox[2] <= 390 && sizes.panelBox[0] >= 150 && sizes.panelBox[3] < 844 / 2 - 60 && !sizes.scrolls, sizes.panelBox);
    check('the key line is inside the window and under the gauges', sizes.hintBox[0] >= 0 && sizes.hintBox[2] <= 390 && sizes.hintBox[3] <= 844 && sizes.vitalsBox[3] <= sizes.hintBox[1], [sizes.vitalsBox, sizes.hintBox]);
    said.shots.push(await page.shot('smalltext-arpg-390x844'));
    // the studio's inline frame (513 × 289), which the same rule covers
    await page.resize(513, 289); await sleep(700);
    const frame = await page.read(`(() => { const box = (n) => { const r = n.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)]; };
      return { hint: parseFloat(getComputedStyle(document.getElementById('hint')).fontSize), hintBox: box(document.getElementById('hint')), vitalsBox: box(document.getElementById('vitals')), panelBox: box(document.getElementById('arpg')) }; })()`);
    said.frame = frame;
    check('in a 513 × 289 frame the key line is 12 px or more and inside the frame, the gauges over it', frame.hint >= 12 && frame.hintBox[3] <= 289 && frame.hintBox[0] >= 0 && frame.hintBox[2] <= 513
      && frame.vitalsBox[3] <= frame.hintBox[1], frame);
    said.shots.push(await page.shot('smalltext-arpg-frame-513x289'));
  });
}
