// More scenes of dev/qa-round20.mjs, played with real key and mouse events on this checkout's runtime. Run them by
// name, into their own folder:
//   node game3d/dev/qa-round20.mjs --cdp=<port> --out=evidence/round22/G --only=endclick,playablekeys,noscore,loadstep,botkeys,boss,pillar
export default async function scenes({ scene, game, fixture, sleep, SEEN }) {
  const seen = (page) => page.read(SEEN);
  const ready = async (page) => {
    await page.until(`(() => { const b = document.querySelector('.briefing-start'); return document.getElementById('loading').hidden && document.getElementById('ad').hidden && (!b || !b.disabled); })()`, 300, 'the game is loaded');
  };
  const start = async (page) => {
    await ready(page);
    if (await page.read(`!!document.querySelector('.briefing:not([hidden])')`)) await page.clickOn('.briefing-start');
    await page.until(`(() => { const b = document.querySelector('.briefing'); return !b || b.hidden; })()`, 30, 'the round started');
  };
  const ended = `!document.getElementById('end').hidden`;
  const playing = `window.__ipverseGameState?.()?.phase === 'playing'`;
  const soon = async (page, expression, seconds = 20) => {
    for (const t0 = Date.now(); Date.now() - t0 < seconds * 1000; await sleep(15)) if (await page.read(expression).catch(() => false)) return true;
    throw new Error(`not within ${seconds} s: ${expression}`);
  };
  /** The page remembers when the end card came up and the rounds started since (read-only). */
  const WATCH = `(() => { if (window.__qa22) return; const q = window.__qa22 = { endAt: null, starts: 0, clicks: [] };
    const end = document.getElementById('end');
    new MutationObserver(() => { q.endAt = end.hidden ? null : q.endAt ?? performance.now(); }).observe(end, { attributes: true, attributeFilter: ['hidden'] });
    document.getElementById('restart').addEventListener('click', () => { if (q.endAt != null) q.clicks.push(Math.round(performance.now() - q.endAt)); }, true);
    addEventListener('ipverse:roundstart', () => { q.starts += 1; });
  })()`;
  const button = `(() => { const s = getComputedStyle(document.getElementById('restart')); return { opacity: Number(s.opacity), cursor: s.cursor }; })()`;

  // ---- the end card's 다시 시작 takes no click for its first 0.8 s ----
  await scene('endclick', async ({ open, check, said }) => {
    const page = await open(fixture('spec-authored-garden'));
    await start(page);
    await page.read(WATCH);
    await page.until(playing, 60, 'a round is on');
    await sleep(700);
    await page.read(`void (window.__g3d.mode().hp = 0)`); // (the garden has nothing that kills: the page's localhost hook)
    await soon(page, ended);
    const early = await page.read(button);
    await page.clickOn('#restart');
    const click = await page.read(`window.__qa22.clicks.at(-1) ?? null`);
    await sleep(300);
    const still = await page.read(ended);
    said.early = { click, look: early, cardStillUp: still };
    if (click != null && click < 800) check(`a click on 다시 시작 ${click} ms after the card came up starts nothing`, still, said.early);
    else check('the click reached the button within 0.8 s of the card (a slow machine: run again)', false, said.early);
    check('until then the button looks as one that cannot be pressed (55 % opacity, no hand)', Math.abs(early.opacity - .55) < .02 && early.cursor === 'default', early);
    said.shots.push(await page.shot('endclick-button-waits'));
    await sleep(900);
    const later = await page.read(button);
    check('after 0.8 s it looks as a button again', later.opacity === 1 && later.cursor === 'pointer', later);
    said.shots.push(await page.shot('endclick-button-ready'));
    await page.clickOn('#restart');
    await page.until(`document.getElementById('end').hidden && ${playing}`, 60, 'a click after 0.8 s starts the next round');
    check('a click after 0.8 s starts the next round', true);
    // the next card waits again: the look comes back each time the card comes up
    await sleep(700);
    await page.read(`void (window.__g3d.mode().hp = 0)`);
    await soon(page, ended);
    const again = await page.read(button);
    check('the next round\'s card waits the same way', Math.abs(again.opacity - .55) < .02, again);
  });

  // ---- a playable ad's end card takes no key ----
  await scene('playablekeys', async ({ open, check, said }) => {
    const page = await open(fixture('spec-authored-garden', '&playable=8&noads=1'));
    await page.until(playing, 120, 'the trial\'s round started by itself');
    await page.read(WATCH);
    await page.until(ended, 60, 'the trial\'s 8 s are over');
    const card = (await seen(page)).end;
    said.card = card;
    check('the card is the trial\'s end, with no 다시 시작', /체험 종료/.test(card ?? '') && !/다시 시작/.test(card ?? ''), card);
    await sleep(1000);
    for (const code of ['Enter', 'Space']) { await page.tap(code, 60); await sleep(700); }
    await sleep(1500);
    const after = await page.read(`({ cardUp: ${ended}, starts: window.__qa22.starts, phase: window.__ipverseGameState()?.phase })`);
    said.after = after;
    check('Enter and Space on it do not start the trial\'s round again', after.cardUp && after.starts === 0, after);
    said.shots.push(await page.shot('playablekeys-card-stays'));
  });

  // ---- the HUD names no score until the game scores ----
  await scene('noscore', async ({ open, check, said }) => {
    const page = await open(game('gm_9539d06a71'));
    await start(page);
    await sleep(1200);
    const first = await seen(page);
    said.first = { status: first.status, objective: first.objective };
    check('before anything is scored the status line is empty (it read 점수 0)', !first.status, said.first);
    said.shots.push(await page.shot('noscore-start'));
    await page.read(`void (window.__g3d.mode().score = 100)`); // (as a kill scores: the page's localhost hook)
    await sleep(300);
    const scored = (await seen(page)).status;
    check('once the game scores it reads 점수 100', scored === '점수 100', scored);
  });

  // ---- the loading figure does not stand at 99 % while the world is built ----
  // an arena whose enemy is a cutout: the counted files (the clips, the hero's model) are in when the hero stands
  await scene('loadstep', async ({ open, check, said }) => {
    const page = await open(game('gm_3d7dd1ca39'));
    const lines = []; // [seconds, the loading screen's line, the start button's]
    for (const t0 = Date.now(); Date.now() - t0 < 300000; await sleep(40)) {
      const at = await page.read(`(() => { const l = document.getElementById('loading'), b = document.querySelector('.briefing-start');
        return { text: l.hidden ? null : (document.getElementById('loading-text')?.textContent ?? l.textContent), detail: l.hidden ? null : document.getElementById('loading-detail')?.textContent ?? null,
          start: b ? b.textContent : null, lit: !!b && !b.disabled && l.hidden }; })()`).catch(() => null);
      if (!at) continue;
      const line = [at.text, at.detail, at.start].join(' | ');
      if (lines.at(-1)?.[1] !== line) lines.push([+((Date.now() - t0) / 1000).toFixed(2), line]);
      if (at.lit) break;
    }
    said.lines = lines;
    const span = (test) => { const hit = lines.map(([t, line], i) => (test(line) ? (lines[i + 1]?.[0] ?? t) - t : 0)); return +hit.reduce((a, b) => a + b, 0).toFixed(2); };
    said.seconds = { at99: span((line) => /99%/.test(line)), sceneStep: span((line) => /장면 준비 중/.test(line)) };
    check('the screen never stands at 99 % (0.5 s at most, as the hero is made)', said.seconds.at99 <= .5, said.seconds);
    check('the step is named instead, on the screen and on the busy start button', lines.some(([, line]) => /^게임 불러오는 중… 장면 준비 중 \| 세계를 만들고 있어요/.test(line)), lines.slice(-6));
    check('the megabytes go on counting under it', new Set(lines.filter(([, line]) => /장면 준비 중/.test(line)).map(([, line]) => /· ([\d.]+ \/ [\d.]+MB)/.exec(line)?.[1])).size > 1, lines.slice(-8));
    check('and the start lights', (await seen(page)).start?.disabled === false);
  });

  // ---- under ?autoplay=1 a keyboard's keys are not the hero's ----
  await scene('botkeys', async ({ open, check, said }) => {
    const page = await open(game('gm_1e7d17bbb0', '?autoplay=1&noads=1'));
    await page.until(playing, 300, 'the built-in player started the round');
    const t0 = Date.now(), from = await page.read(`window.__ipverseGameState().player`);
    await page.down('KeyS');
    let shot = false;
    for (; Date.now() - t0 < 120000; await sleep(120)) {
      await page.down('KeyS', { autoRepeat: true }); // a held key repeats
      if (!shot && Date.now() - t0 > 5000) { said.shots.push(await page.shot('botkeys-5s-with-S-held')); shot = true; }
      if (await page.read(ended)) break;
    }
    await page.up('KeyS');
    const at = await seen(page);
    said.round = { seconds: +((Date.now() - t0) / 1000).toFixed(1), end: at.end, from, to: at.player };
    check('with S held down all round the built-in player clears it (about 0:19 alone)', /^클리어!/.test(at.end ?? '') && said.round.seconds < 45, said.round);
    // nor does a key press the end card ahead of the built-in player's own restart (4 s)
    await page.read(WATCH);
    await page.tap('Enter', 60);
    await sleep(600);
    const early = await page.read(`({ cardUp: ${ended}, starts: window.__qa22.starts })`);
    check('an Enter on the end card does not start the next round ahead of the built-in player', early.cardUp && early.starts === 0, early);
    await page.until(`window.__qa22.starts > 0`, 60, 'the built-in player\'s own next round');
    check('its own next round comes by itself', true);
    // a person's own round still takes the keyboard
    const own = await open(game('gm_1e7d17bbb0'));
    await start(own);
    await sleep(500);
    const a = await own.read(`window.__ipverseGameState().player`);
    await own.hold('KeyW', 900);
    await sleep(300);
    const b = await own.read(`window.__ipverseGameState().player`);
    said.own = { a, b };
    check('a person\'s round takes the keys as before (W walks the hero)', Math.hypot(b[0] - a[0], b[2] - a[2]) > .5, said.own);
  });

  // ---- the built-in player beats the boss ----
  // three rounds from the first stage (a fresh page each: a loss would go on from the boss's checkpoint)
  await scene('boss', async ({ open, check, said }) => {
    said.rounds = [];
    for (let n = 0; n < (Number(process.env.QA_BOSS_ROUNDS) || 3); n++) {
      const page = await open(game('gm_b1188dcc0c', '?autoplay=1&noads=1'));
      await page.until(playing, 300, 'the built-in player started the round');
      const t0 = Date.now();
      let low = Infinity, shot = false;
      for (; Date.now() - t0 < 260000; await sleep(400)) {
        const at = await page.read(`({ hp: window.__ipverseGameState().hp, stage: window.__ipverseGameState().mission.stageIndex, ended: ${ended} })`).catch(() => null);
        if (!at) continue;
        low = Math.min(low, at.hp);
        if (!shot && at.stage === 1 && Date.now() - t0 > 30000) { said.shots.push(await page.shot(`boss-round${n + 1}-fight`)); shot = true; }
        if (at.ended) break;
      }
      const at = await seen(page);
      said.rounds.push({ seconds: +((Date.now() - t0) / 1000).toFixed(1), end: at.end, lowestHp: Math.round(low) });
      check(`round ${n + 1}: 클리어!, with HP to spare`, /^클리어!/.test(at.end ?? '') && low >= 60, said.rounds.at(-1));
      if (n === 0) said.shots.push(await page.shot('boss-end'));
      await page.close();
    }
  });

  // ---- a round pillar's low edge is round ----
  await scene('pillar', async ({ open, check, said }) => {
    const page = await open(game('gm_b870737b47'));
    await start(page);
    await sleep(600);
    await page.tap('KeyE'); // the story box
    const edges = await page.read(`(() => { const all = []; window.__g3d.world.scene.traverse((o) => { if (o.name === 'wall-edge') all.push(o.geometry.type); });
      return { round: all.filter((t) => t === 'CylinderGeometry').length, square: all.filter((t) => t === 'BoxGeometry').length }; })()`);
    said.edges = edges;
    check('the crypt\'s pillars keep a round edge, its walls a square one', edges.round >= 4 && edges.square >= 4, edges);
    await page.read(`void window.__g3d.teleport(-15.5, -30.5)`); // beside pil_1 (-18, -28), which then stands between the hero and the camera
    await sleep(900);
    said.shots.push(await page.shot('pillar-round-edge'));
  });
}
