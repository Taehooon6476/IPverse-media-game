// The scenes of dev/qa-round20.mjs: one per thing a first-time player meets. A scene opens its own page, plays it
// with real key events and says what the page showed; its screenshots go to --out.
export default async function scenes({ scene, game, fixture, serve, sleep, SEEN }) {
  const seen = (page) => page.read(SEEN);
  /** The page is ready to start (a version-2 game: its briefing's button is lit; a version-1 game: it runs). */
  const ready = async (page) => {
    await page.until(`(() => { const b = document.querySelector('.briefing-start'); return document.getElementById('loading').hidden && document.getElementById('ad').hidden && (!b || !b.disabled); })()`, 240, 'the game is loaded');
  };
  /** 임무 시작 by its button, then the round runs. */
  const start = async (page) => {
    await ready(page);
    if (await page.read(`!!document.querySelector('.briefing:not([hidden])')`)) await page.clickOn('.briefing-start');
    await page.until(`(() => { const b = document.querySelector('.briefing'); return !b || b.hidden; })()`, 30, 'the round started');
  };

  // ---- the briefing in a player's words, its keys as a list ----
  await scene('briefing', async ({ open, check, said }) => {
    const page = await open(fixture('spec-authored-garden'));
    await ready(page);
    const at = await seen(page);
    said.briefing = at.briefing;
    check('the briefing has no file-format or studio words', !/GAME SPEC|CITY \/|IP 모델/.test(at.briefing ?? ''), at.briefing);
    check('it opens with 임무 브리핑 and lists the keys under 조작법', /^임무 브리핑/.test(at.briefing ?? '') && /조작법/.test(at.briefing), at.briefing);
    const rows = await page.read(`[...document.querySelectorAll('.briefing-controls li')].map((li) => li.innerText.replace(/\\s+/g, ' '))`);
    said.keys = rows;
    check('the keys are a list, a row a key (this game: no dash, a talk)', rows.length >= 5 && rows.some((r) => /^이동/.test(r)) && rows.some((r) => /^대화/.test(r)) && !rows.some((r) => /대시/.test(r)), rows);
    const size = await page.read(`(() => { const s = getComputedStyle(document.querySelector('.briefing-controls')); return [parseFloat(s.fontSize), s.opacity]; })()`);
    check('at 13 px and full strength (it was 11 px at 60 %)', size[0] >= 13 && Number(size[1]) === 1, size);
    said.shots.push(await page.shot('briefing-1280x720'));
    // the studio's inline frame (513 × 289): the start button stays in sight
    await page.resize(513, 289); await sleep(600);
    const box = await page.read(`(() => { const r = document.querySelector('.briefing-start').getBoundingClientRect(); return [Math.round(r.top), Math.round(r.bottom), innerHeight]; })()`);
    check('in a 513 × 289 frame the start button is inside the frame', box[0] >= 0 && box[1] <= box[2], box);
    said.shots.push(await page.shot('briefing-513x289'));
    await page.resize(1024, 768); await sleep(400);
    said.shots.push(await page.shot('briefing-1024x768'));
  });

  // ---- the HUD of a round: the keys on a pill, only the gauges the game uses ----
  await scene('hud', async ({ open, check, said }) => {
    const garden = await open(fixture('spec-authored-garden'));
    await start(garden);
    await sleep(3200); // the stage's own notice has gone
    let at = await seen(garden);
    said.garden = at;
    check('garden (nothing hurts, no dash): no health bar, no 대시 gauge', at.vitals === 'none' && at.dash === false, { vitals: at.vitals, dash: at.dash });
    const pill = await garden.read(`(() => { const s = getComputedStyle(document.getElementById('hint')); return [parseFloat(s.fontSize), s.backgroundColor]; })()`);
    check('the keys line is 13 px on a dark pill', pill[0] >= 13 && /rgba\(0, 0, 0, 0\.[4-9]/.test(pill[1]), pill);
    said.shots.push(await garden.shot('hud-garden'));
    await garden.close();
    const arena = await open(fixture('spec-sf'));
    await ready(arena);
    await sleep(1500);
    at = await seen(arena);
    said.arena = at;
    check('a version-1 arena keeps its health, its 대시 gauge (named with its key) and its crosshair', at.vitals === 'hp' && at.dash && at.crosshair
      && /대시 Q/.test(await arena.read(`document.getElementById('dash').textContent`)), at);
    said.shots.push(await arena.shot('hud-arena'));
  });

  // ---- a race: no health, no dash, no crosshair; short numbers; a large 3-2-1 ----
  await scene('race', async ({ open, check, said }) => {
    const page = await open(game('gm_2ceb5d2311'), { width: 1366, height: 768 });
    await ready(page);
    said.briefing = (await seen(page)).briefing;
    check('its briefing lists the car\'s keys only', /가속 W/.test(said.briefing) && /브레이크 Space/.test(said.briefing) && !/시점|달리기|점프|대시/.test(said.briefing), said.briefing);
    said.shots.push(await page.shot('race-briefing-1366x768'));
    await page.clickOn('.briefing-start');
    await page.until(`/^[123]$/.test(document.getElementById('notice').textContent) && !document.getElementById('notice').hidden`, 30, 'the countdown');
    const count = await page.read(`(() => { const n = document.getElementById('notice'); return [n.textContent, parseFloat(getComputedStyle(n).fontSize)]; })()`);
    check('the 3-2-1 is written large (it was a 15-px pill)', count[1] >= 40, count);
    said.shots.push(await page.shot('race-countdown'));
    await page.down('KeyW');
    await page.until(`/^랩 /.test(document.getElementById('objective').textContent)`, 30, 'the race is on');
    await sleep(4000);
    const at = await seen(page);
    await page.up('KeyW');
    said.racing = at;
    check('no health bar, no 대시 gauge, no crosshair in a race', at.vitals === 'none' && !at.dash && !at.crosshair, { vitals: at.vitals, dash: at.dash, crosshair: at.crosshair });
    check('the left line is the lap, the gate and what it takes', /^랩 1\/2 · 체크포인트 \d+\/10 · 3위 안에 들어야 해요 · 남은 \d+초$/.test(at.objective), at.objective);
    check('the right line is the place, the time and the speed', /^\d\/5위 · \d:\d\d\.\d · \d+ km\/h$/.test(at.status), at.status);
    said.shots.push(await page.shot('race-hud'));
  });

  // ---- the end card says why, the result and what the button does; 다시 시작 starts the round ----
  await scene('end', async ({ open, check, said }) => {
    // a version-2 game (the garden: three stages): its first stage done with real keys, then the round is lost
    const page = await open(fixture('spec-authored-garden'));
    await start(page);
    await page.down('KeyW');
    await page.until(`window.__ipverseGameState().mission.stageIndex === 1`, 30, 'the crystal is picked up (W held)');
    await page.up('KeyW');
    await page.read(`void (window.__g3d.mode().hp = 0)`); // (the only thing not played: the garden has nothing that kills)
    await page.until(`!document.getElementById('end').hidden`, 20, 'the end card');
    let at = await seen(page);
    said.lost = at.end;
    check('a loss says why, how far it got with the score and the time, and where 다시 시작 goes on',
      /^게임 오버 체력이 다했어요\. 3단계 중 2단계 · 점수 \d+ · \d:\d\d 다시 시작 2단계부터 이어서 해요\. Enter 키를 눌러도 돼요\.$/.test(at.end), at.end);
    check('no crosshair and no notice pill over the card', !at.crosshair && at.notice === null, { crosshair: at.crosshair, notice: at.notice });
    said.shots.push(await page.shot('end-lost-1280x720'));
    await page.resize(513, 289); await sleep(500);
    const fits = await page.read(`(() => { const r = document.getElementById('end-next').getBoundingClientRect(), t = document.getElementById('end-title').getBoundingClientRect(); return [Math.round(t.top), Math.round(r.bottom), innerHeight]; })()`);
    check('the whole card fits a 513 × 289 frame', fits[0] >= 0 && fits[1] <= fits[2], fits);
    said.shots.push(await page.shot('end-lost-513x289'));
    await page.resize(1280, 720);
    // what a broadcast sends of it (the capture canvas, shown over the page for the picture)
    await page.read(`void document.body.append(Object.assign(window.ipverseCapture(), { id: 'qa-capture', style: 'position:fixed;inset:0;z-index:99;width:100%;height:100%' }))`);
    await sleep(700);
    said.shots.push(await page.shot('end-lost-capture'));
    await page.read(`void document.getElementById('qa-capture').remove()`);
    // 다시 시작 (Enter, 1.5 s after the end): the round runs again without a second press, from the checkpoint
    await sleep(1600);
    await page.tap('Enter');
    await page.until(`window.__ipverseGameState()?.phase === 'playing' && document.getElementById('end').hidden`, 60, 'the next round runs by itself');
    at = await seen(page);
    const resumed = await page.read(`window.__ipverseGameState().resumedAt`);
    check('다시 시작 starts the round: no briefing to click through', at.briefing === null && at.phase === 'playing', { briefing: at.briefing, phase: at.phase });
    check('it goes on from the second stage, as the card said', resumed === 1 && at.stage === 1, { resumed, stage: at.stage });
    await page.close();
    // a version-1 arena cleared (its count brought to the target): 클리어! with the goal and the numbers
    const arena = await open(fixture('spec-sf'));
    await ready(arena);
    await sleep(1200);
    await arena.read(`void (window.__g3d.mode().kills = window.__g3d.mode().target)`);
    await arena.until(`!document.getElementById('end').hidden`, 20, 'the end card');
    at = await seen(arena);
    said.won = at.end;
    check('a clear says the goal was met, the count, the score and the time', /^클리어! 목표를 달성했어요\. 적 15\/15명 격파 · 점수 \d+ · \d:\d\d 다시 시작 처음부터 다시 해요\. Enter 키를 눌러도 돼요\.$/.test(at.end), at.end);
    said.shots.push(await arena.shot('end-won-arena'));
  });

  // ---- Esc and P pause a person's round; leaving the window pauses it; never under the built-in player ----
  /** The round's own clock, as the page tells it: the seconds its time limit has left (the garden: 120 s). */
  const left = (page) => page.read(`Number(/· (\\d+)초$/.exec(document.getElementById('objective').textContent)?.[1] ?? NaN)`);
  await scene('pause', async ({ open, check, said }) => {
    const page = await open(fixture('spec-authored-garden'));
    await start(page);
    await sleep(1500);
    check('the hint names the pause key', /일시정지 Esc$/.test((await seen(page)).hint), (await seen(page)).hint);
    await page.down('KeyW'); await sleep(300); // W is down when the pause comes
    await page.tap('Escape');
    await page.up('KeyW');
    let before = { left: await left(page), at: await seen(page) };
    said.card = before.at.pause;
    check('Esc opens the pause card: 계속하기, 다시 시작, what 다시 시작 does (the first stage: over from the start) and the keys',
      /^일시정지 계속하기 다시 시작 Esc 키로도 계속해요 다시 시작을 누르면 처음부터 다시 해요\. 조작법 이동/.test(before.at.pause ?? ''), before.at.pause);
    check('the round\'s end is not told ahead while it stands', before.at.endsIn === null, before.at.endsIn);
    await sleep(3500);
    let after = { left: await left(page), at: await seen(page) };
    check('the round\'s clock stands while it is paused', after.left === before.left && Number.isFinite(after.left), [before.left, after.left]);
    check('the hero stands (W was held when it paused)', JSON.stringify(after.at.player) === JSON.stringify(before.at.player), [before.at.player, after.at.player]);
    said.shots.push(await page.shot('pause-1280x720'));
    await page.resize(513, 289); await sleep(500);
    said.shots.push(await page.shot('pause-513x289'));
    await page.resize(1280, 720);
    await page.tap('Escape');
    await sleep(2500);
    after = { left: await left(page), at: await seen(page) };
    await sleep(1000);
    const later = (await seen(page)).player; // (it slid to a stop from the pace it had when the pause came)
    check('Esc again goes on: the clock runs and the hero does not walk on by itself (the W held then is not down)', after.at.pause === null
      && after.left < before.left && JSON.stringify(later) === JSON.stringify(after.at.player), [before.left, after.left, after.at.player, later]);
    await page.tap('KeyP');
    check('P pauses too', (await seen(page)).pause !== null, (await seen(page)).pause);
    await page.clickOn('#pause button'); // 계속하기
    check('계속하기 goes on', (await seen(page)).pause === null, (await seen(page)).pause);
    // leaving the window (headless Chrome has no second window: the window's own blur event)
    await page.read(`void window.dispatchEvent(new Event('blur'))`);
    before = { left: await left(page), at: await seen(page) };
    check('a window that loses the focus pauses the round and says why', /^일시정지 다른 곳을 보는 동안 게임을 멈춰 뒀어요\./.test(before.at.pause ?? ''), before.at.pause);
    await sleep(2500);
    check('and the clock stands', await left(page) === before.left, [before.left, await left(page)]);
    said.shots.push(await page.shot('pause-away'));
    // 다시 시작 on the card: a new round, by itself, and not a finished one
    await page.clickOn('#pause button.quiet');
    await page.until(`window.__ipverseGameState()?.phase === 'playing' && document.getElementById('pause').hidden && /· 1(19|20)초$/.test(document.getElementById('objective').textContent)`, 60, 'the round starts over');
    after = await seen(page);
    check('다시 시작 on the card starts the round over: no briefing, no finished round counted', after.briefing === null && after.rounds === 0, { briefing: after.briefing, rounds: after.rounds });
    // on the second stage (the crystal picked up, W held) the card says where its 다시 시작 goes on from, and it does
    await page.down('KeyW');
    await page.until(`window.__ipverseGameState().mission.stageIndex === 1`, 30, 'the crystal is picked up (W held)');
    await page.up('KeyW');
    await page.tap('Escape');
    const next = await page.read(`document.querySelector('.pause-next')?.textContent ?? null`);
    said.next = next;
    check('on the second stage the card says 다시 시작 goes on from it, as the end card does', next === '다시 시작을 누르면 2단계부터 이어서 해요.', next);
    // the card with that line, whole, in the windows a game is played in (and the smallest frame it has been seen in)
    said.card = {};
    for (const [w, h] of [[1440, 900], [1366, 768], [1024, 768], [390, 844], [513, 289]]) {
      await page.resize(w, h); await sleep(500);
      const box = await page.read(`(() => { const r = document.querySelector('.pause-card').getBoundingClientRect(), p = document.getElementById('pause');
        return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), scrolls: p.scrollHeight > p.clientHeight }; })()`);
      said.card[`${w}x${h}`] = box;
      check(`the pause card is whole in a ${w} × ${h} window`, box.top >= 0 && box.bottom <= h && box.left >= 0 && box.right <= w && !box.scrolls, box);
      said.shots.push(await page.shot(`pause-stage2-${w}x${h}`));
    }
    await page.resize(1280, 720);
    await page.clickOn('#pause button.quiet');
    await page.until(`window.__ipverseGameState()?.phase === 'playing' && document.getElementById('pause').hidden && window.__ipverseGameState().resumedAt === 1`, 60, 'the round goes on from the second stage');
    check('and 다시 시작 goes on from the second stage', (await seen(page)).stage === 1, (await seen(page)).stage);
    await page.close();

    // a cloud stream (?noads=1): their own pause only
    const cloud = await open(fixture('spec-authored-garden', '&noads=1'));
    await start(cloud);
    await sleep(1200);
    await cloud.read(`void window.dispatchEvent(new Event('blur'))`);
    check('?noads=1: losing the focus does not pause (the page around the stream takes it)', (await seen(cloud)).pause === null, (await seen(cloud)).pause);
    await cloud.tap('Escape');
    check('?noads=1: Esc does', /^일시정지/.test((await seen(cloud)).pause ?? ''), (await seen(cloud)).pause);
    // what a capture sends of a paused round (a play window that does not mark its game ?nopause=1)
    await cloud.read(`void document.body.append(Object.assign(window.ipverseCapture(), { id: 'qa-capture', style: 'position:fixed;inset:0;z-index:99;width:100%;height:100%' }))`);
    await sleep(700);
    said.shots.push(await cloud.shot('pause-capture'));
    await cloud.close();

    // a person on air in a broadcast's play window (?noads=1&nopause=1): no pause, and the keys offer none
    const onAir = await open(fixture('spec-authored-garden', '&noads=1&nopause=1'));
    await ready(onAir);
    const offered = await onAir.read(`[...document.querySelectorAll('.briefing-controls li')].map((li) => li.innerText.replace(/\\s+/g, ' '))`);
    check('?nopause=1: the briefing lists no pause key', offered.length >= 4 && !offered.some((row) => /일시정지|Esc/.test(row)), offered);
    said.shots.push(await onAir.shot('nopause-briefing'));
    await start(onAir);
    await sleep(1500);
    before = { left: await left(onAir), at: await seen(onAir) };
    check('?nopause=1: the line under the game offers no pause', !/일시정지|Esc/.test(before.at.hint), before.at.hint);
    const cards = []; // the pause card after each of Esc, P and a lost focus (a second key would close what the first opened)
    await onAir.tap('Escape'); cards.push((await seen(onAir)).pause);
    await onAir.tap('KeyP'); cards.push((await seen(onAir)).pause);
    await onAir.read(`void window.dispatchEvent(new Event('blur'))`); cards.push((await seen(onAir)).pause);
    await sleep(2500);
    after = { left: await left(onAir), at: await seen(onAir) };
    check('?nopause=1: Esc, P and a lost focus stop nothing: no card, the clock runs, the round\'s end is still told ahead',
      cards.every((card) => card === null) && after.at.pause === null && after.left < before.left && after.at.endsIn !== null,
      { cards, clock: [before.left, after.left], endsIn: after.at.endsIn });
    await onAir.down('KeyW'); await sleep(900); await onAir.up('KeyW');
    const moved = (await seen(onAir)).player;
    check('?nopause=1: the keys still play after Esc (W walks)', JSON.stringify(moved) !== JSON.stringify(after.at.player), [after.at.player, moved]);
    await onAir.read(`void document.body.append(Object.assign(window.ipverseCapture(), { id: 'qa-capture', style: 'position:fixed;inset:0;z-index:99;width:100%;height:100%' }))`);
    await sleep(700);
    said.shots.push(await onAir.shot('nopause-capture'));
    await onAir.close();

    // the built-in player (?autoplay=1): nothing pauses
    const bot = await open(fixture('spec-authored-garden', '&autoplay=1&noads=1'));
    await bot.until(`window.__ipverseGameState?.()?.phase === 'playing'`, 120, 'the built-in player started the round');
    before = await left(bot);
    await bot.tap('Escape'); await bot.tap('KeyP');
    await bot.read(`void window.dispatchEvent(new Event('blur'))`);
    await sleep(2500);
    after = { left: await left(bot), at: await seen(bot) };
    check('?autoplay=1: Esc, P and a lost focus pause nothing, and the hint offers no pause', after.at.pause === null && after.left < before && !/일시정지/.test(after.at.hint),
      { pause: after.at.pause, clock: [before, after.left], hint: after.at.hint });
    await bot.close();

    // a playable ad (?playable=): nothing pauses, no card takes the keyboard, the keys go on playing
    const ad = await open(fixture('spec-authored-garden', '&noads=1&playable=60'));
    await ad.until(`window.__ipverseGameState?.()?.phase === 'playing'`, 120, 'the playable round started by itself');
    await sleep(800);
    before = { left: await left(ad), at: await seen(ad) };
    const look = async () => ({ pause: (await seen(ad)).pause, focus: await ad.read(`document.activeElement?.tagName ?? null`) });
    await ad.tap('Escape');
    const afterEsc = await look(); // (looked at after each key: a second key would close what the first opened)
    await ad.down('KeyW'); await sleep(900); await ad.up('KeyW');
    after = { left: await left(ad), at: await seen(ad) };
    await ad.tap('KeyP');
    said.playable = { afterEsc, afterP: await look(), hint: after.at.hint };
    check('?playable=: Esc and P open no card and the keyboard stays with the game', afterEsc.pause === null && afterEsc.focus === 'CANVAS'
      && said.playable.afterP.pause === null && said.playable.afterP.focus === 'CANVAS', said.playable);
    check('?playable=: W still walks after Esc (the card took the keys before)', JSON.stringify(after.at.player) !== JSON.stringify(before.at.player), [before.at.player, after.at.player]);
    check('?playable=: the round runs on, and its keys are in the line under the game with no pause key', after.left < before.left
      && /^이동 W A S D/.test(after.at.hint) && !/일시정지|Esc/.test(after.at.hint), { clock: [before.left, after.left], hint: after.at.hint });
    said.shots.push(await ad.shot('playable-after-esc'));
    await ad.close();

    // an arena takes the mouse on a click; Esc lets it go (the browser keeps that key press): the round pauses
    const arena = await open(fixture('spec-sf'));
    await ready(arena);
    await sleep(800);
    await arena.click(640, 300);
    await sleep(600);
    const locked = await arena.read(`!!document.pointerLockElement`);
    said.pointerLock = locked;
    if (locked) {
      await arena.tap('Escape');
      await sleep(400);
      const shown = await seen(arena);
      check('an arena: Esc lets the mouse go and pauses', /^일시정지/.test(shown.pause ?? '') && !(await arena.read(`!!document.pointerLockElement`)), shown.pause);
    } else {
      await arena.tap('Escape');
      check('an arena (this browser gave no mouse capture): Esc pauses', /^일시정지/.test((await seen(arena)).pause ?? ''), (await seen(arena)).pause);
    }
    said.shots.push(await arena.shot('pause-arena'));
  });

  // ---- in the studio's big view Esc pauses the round and does not close the view ----
  // (dev/big-view.html: the game in a frame with the view's own Esc hook on the frame's window, as web BigGameModal.tsx
  // sets it; window.closes counts the presses the view would have closed on)
  await scene('bigview', async ({ open, check, said }) => {
    const src = new URL(fixture('spec-authored-garden'));
    const page = await open(`${src.origin}/dev/big-view.html?src=${encodeURIComponent(src.pathname + src.search)}`);
    /** The value of an expression in the game's own page, inside the frame. */
    const inFrame = (expression) => page.read(`document.getElementById('frame').contentWindow.eval(${JSON.stringify(expression)})`);
    const closes = () => page.read('window.closes');
    await page.until(`document.getElementById('frame').contentWindow.eval(${JSON.stringify(`(() => { const b = document.querySelector('.briefing-start'); return document.getElementById('loading').hidden && !!b && !b.disabled; })()`)})`, 240, 'the game in the frame is loaded');
    check('the keyboard is in the frame, as the view puts it there', await page.read(`document.activeElement?.id`) === 'frame', await page.read(`document.activeElement?.id`));
    await page.tap('Escape');
    check('at the briefing Esc is the view\'s: it closes on it', await closes() === 1 && (await inFrame(SEEN)).pause === null, await closes());
    const box = await inFrame(`(() => { const r = document.querySelector('.briefing-start').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    await page.click(box[0], box[1] + 44); // (the frame starts under the stand-in's 44-px head)
    await page.until(`document.getElementById('frame').contentWindow.eval("window.__ipverseGameState?.()?.phase === 'playing' && document.querySelector('.briefing').hidden")`, 30, 'the round started');
    await sleep(1200);
    await page.tap('Escape');
    let at = await inFrame(SEEN);
    said.paused = at.pause;
    check('in a round Esc pauses the game and the view stays open', /^일시정지 계속하기 다시 시작/.test(at.pause ?? '') && await closes() === 1, { pause: at.pause, closes: await closes() });
    said.shots.push(await page.shot('bigview-paused'));
    await page.tap('Escape');
    at = await inFrame(SEEN);
    check('Esc again goes on with the round, as the card says, and the view stays open', at.pause === null && at.phase === 'playing' && await closes() === 1, { pause: at.pause, closes: await closes() });
    await page.tap('KeyP');
    const byP = (await inFrame(SEEN)).pause;
    await page.tap('KeyP');
    check('P pauses and goes on there too', /^일시정지/.test(byP ?? '') && (await inFrame(SEEN)).pause === null && await closes() === 1, { pause: byP, closes: await closes() });
    await inFrame(`void (window.__g3d.mode().hp = 0)`); // (the garden has nothing that kills)
    await page.until(`document.getElementById('frame').contentWindow.eval("!document.getElementById('end').hidden")`, 20, 'the end card');
    await sleep(400);
    await page.tap('Escape');
    check('at the end card Esc is the view\'s again', await closes() === 2, await closes());
    said.shots.push(await page.shot('bigview-end'));
  });

  // ---- a city delivery: the talk, the arrow to the car, the car's keys ----
  const notice = (page) => page.read(`(() => { const n = document.getElementById('notice'); return n.hidden ? null : n.textContent; })()`);
  await scene('city', async ({ open, check, said }) => {
    const page = await open(game('gm_7a41fcae9e'));
    await start(page);
    await page.read(`void window.__g3d.teleport(-72.5, 10)`); // beside the NPC (the walk there is not what is looked at)
    await sleep(800);
    const lines = [];
    for (let press = 0; press < 6; press++) {
      await page.tap('KeyE');
      await sleep(350);
      const at = await seen(page);
      lines.push(at.say);
      if (press === 0) {
        said.footer = await page.read(`getComputedStyle(document.getElementById('say'), '::after').content`);
        said.shots.push(await page.shot('talk-first-line'));
      }
      if (at.stage === 1) break;
    }
    said.talk = lines;
    check('the talk shows every line of the dialogue, a line a press, and then the stage is done', lines.filter(Boolean).length >= 4 && (await seen(page)).stage === 1, lines);
    check('the box names the keys that pass it', said.footer === '"E 또는 Enter로 넘기기 ▶"', said.footer);
    await sleep(600);
    let at = await seen(page);
    said.arrowOnFoot = at.arrow;
    check('on foot in a stage done by car the arrow names the car', /^➤ 차 \d+m$/.test(at.arrow ?? ''), at.arrow);
    said.shots.push(await page.shot('arrow-to-the-car'));
    await page.read(`void window.__g3d.teleport(-55.5, -3)`); // beside the delivery car
    await sleep(700);
    check('at the car the prompt says E', await notice(page) === 'E · 차량 탑승', await notice(page));
    await page.tap('KeyE');
    await sleep(500);
    const tip = await notice(page);
    said.tip = tip;
    check('in the car the driving keys are on screen', /^운전 · W 가속 · S 후진 · A D 방향 · Space 브레이크/.test(tip ?? ''), tip);
    said.shots.push(await page.shot('tip-driving-keys'));
    await sleep(2500);
    check('and stay for the seconds it takes to read', await notice(page) === tip, await notice(page));
    at = await seen(page);
    check('at the wheel the arrow names the address', /^➤ \d+m$/.test(at.arrow ?? ''), at.arrow);
  });

  // ---- a sky climb: the first fall says how to jump ----
  await scene('sky', async ({ open, check, said }) => {
    const page = await open(game('gm_8f1fc9a181'));
    await start(page);
    await sleep(3000); // the stage's own notice has gone
    await page.down('KeyS'); // off the back of the start island
    const tip = await page.until(`(() => { const n = document.getElementById('notice'); return !n.hidden && /점프/.test(n.textContent) ? n.textContent : null; })()`, 40, 'the jump tip after a fall').catch(() => null);
    await page.up('KeyS');
    said.tip = tip;
    check('the first fall brings the jump tip on screen', /^가장자리에서 Space로 점프해요/.test(tip ?? ''), tip ?? await notice(page));
    said.shots.push(await page.shot('tip-jump'));
    await sleep(2200);
    check('and it stays up', await notice(page) === tip, await notice(page));
    const at = await seen(page);
    check('the sky climb has no health bar (a fall cannot end the round) and no 대시 gauge', at.vitals === 'none' && !at.dash, { vitals: at.vitals, dash: at.dash });
  });

  // ---- an ARPG (the local one): the arrow to the enemies left; the story box ----
  await scene('arpg', async ({ open, check, said }) => {
    const page = await open(fixture('spec-authored-arpg'));
    await start(page);
    await sleep(600);
    let at = await seen(page);
    check('the stage\'s story box is up', /검문병이 길을 막고 있어/.test(at.say ?? ''), at.say);
    await page.tap('Space');
    check('Space leaves it up (it jumps), and the box no longer says Space', (await seen(page)).say !== null
      && await page.read(`getComputedStyle(document.getElementById('say'), '::after').content`) === '"E 또는 Enter로 넘기기 ▶"', (await seen(page)).say);
    said.shots.push(await page.shot('story-box'));
    await page.clickOn('#say');
    await sleep(400);
    check('a click on the box closes it', (await seen(page)).say === null, (await seen(page)).say);
    // the two guards by the start come and are cut down (F held); the other two stand past the 32 m they come from
    await page.down('KeyF');
    await page.until(`window.__ipverseGameState().mission.progress >= 2`, 90, 'the two near guards are down');
    await page.up('KeyF');
    await sleep(1200);
    at = await seen(page);
    said.after = { objective: at.objective, arrow: at.arrow };
    check('with the near enemies down the count reads 2/4 and the arrow leads to the next one', /\(2\/4\)$/.test(at.objective) && /^➤ 적 \d+m$/.test(at.arrow ?? ''), said.after);
    said.shots.push(await page.shot('arrow-to-the-enemies'));
  });

  // ---- a blow reddens the picture's rim on the attacker's side ----
  await scene('hurtside', async ({ open, check, said }) => {
    // a blow from each side of the picture, the frame held at the blow (the garden has nothing that strikes: the
    // mode's own hurt() is called with a place 5 m to that side of the hero, by where the camera looks)
    const page = await open(fixture('spec-authored-garden'));
    await start(page);
    await sleep(3000);
    said.sides = {};
    for (const [name, right, ahead] of [['right', 1, 0], ['left', -1, 0], ['ahead', 0, 1], ['behind', 0, -1], ['no-side', 0, 0]]) {
      const told = await page.read(`(() => { const m = __g3d.mode(), w = __g3d.world, yaw = w.rig.yaw, p = m.player.pos;
        __g3d.freeze(false); m.hurtFor = 0;
        m.hurt(1, ${right || ahead} ? { x: p.x + 5 * (Math.cos(yaw) * ${right} - Math.sin(yaw) * ${ahead}), z: p.z - 5 * (Math.sin(yaw) * ${right} + Math.cos(yaw) * ${ahead}) } : null);
        __g3d.freeze(true);
        return { side: w.hurtFrom && [Math.round(w.hurtFrom.x * 100) / 100, Math.round(w.hurtFrom.y * 100) / 100], hurt: w.hurt }; })()`);
      await sleep(500); // (a frame with the blow is drawn, and held)
      const sent = await page.read(`[...__g3d.world.vignette.uniforms.hurtFrom.value].map((n) => Math.round(n * 100) / 100)`);
      said.sides[name] = { ...told, sent };
      check(`a blow from ${name}: the rim's shader is given that side`, JSON.stringify(sent) === JSON.stringify([right, ahead]) && told.hurt > .5, said.sides[name]);
      said.shots.push(await page.shot(`hurt-from-${name}`));
    }
    await page.close();
    // a guard's own blow (the local ARPG: its guards come and strike a hero who stands): the side is the guard's
    const arpg = await open(fixture('spec-authored-arpg'));
    await start(arpg);
    await arpg.clickOn('#say');
    await arpg.read(`void (() => { const m = __g3d.mode(), hurt = m.hurt.bind(m);
      m.hurt = (damage, from) => { const hp = m.hp; hurt(damage, from);
        if (m.hp < hp && !window.__blow) { window.__blow = { from: from && [from.x, from.z], hero: [m.player.pos.x, m.player.pos.z], yaw: __g3d.world.rig.yaw,
          side: __g3d.world.hurtFrom, enemies: m.enemies.map((e) => [e.pos.x, e.pos.z]) }; __g3d.freeze(true); } }; })()`);
    const blow = await arpg.until(`window.__blow`, 120, 'a guard strikes the hero');
    await sleep(500);
    said.blow = blow;
    const byGuard = blow.from && blow.enemies.some(([x, z]) => Math.hypot(x - blow.from[0], z - blow.from[1]) < .01);
    const bearing = blow.from ? Math.atan2(blow.from[0] - blow.hero[0], -(blow.from[1] - blow.hero[1])) + blow.yaw : 0;
    check('a guard\'s blow tells the guard\'s place, and its side of the picture is the rim\'s', byGuard && blow.side
      && Math.abs(blow.side.x - Math.sin(bearing)) < .01 && Math.abs(blow.side.y - Math.cos(bearing)) < .01, blow);
    said.shots.push(await arpg.shot('hurt-from-a-guard'));
  });

  // ---- a version-1 arena: the words count what the round counts ----
  await scene('arena', async ({ open, check, said }) => {
    const page = await open(game('gm_c153ff5ceb'));
    await ready(page);
    await sleep(1500);
    const at = await seen(page);
    said.objective = at.objective;
    check('the objective says 20 where it counts to 20 (it said 30기 … (0/20))', /^목표: 적 20명 격파 \(0\/20\) · 남은 시간 \d+초$/.test(at.objective), at.objective);
    said.shots.push(await page.shot('arena-objective'));
  });

  // ---- the same rounds as a playable ad (?playable=) and under the built-in player (?autoplay=1) ----
  await scene('playable', async ({ open, check, said }) => {
    const page = await open(fixture('spec-authored-garden', '&noads=1&playable=12'));
    await page.until(`window.__ipverseGameState?.()?.phase === 'playing'`, 120, 'the round starts by itself');
    let at = await seen(page);
    check('a playable round starts with no briefing to click and counts its seconds down', at.briefing === null && /· 1[012]초$/.test(at.objective), at.objective);
    await page.until(`!document.getElementById('end').hidden`, 40, 'the trial ends by its clock');
    at = await seen(page);
    said.end = at.end;
    check('its end says 체험 종료 and the round\'s numbers (no score: nothing was scored): no reason, no 다시 시작', /^체험 종료 · 전체 게임에서 이어서 즐기세요 3단계 중 1단계 · 0:12$/.test(at.end ?? ''), at.end);
    said.shots.push(await page.shot('end-playable'));
    await page.close();
    // &standby=1: the round holds for the viewer's first input
    const held = await open(fixture('spec-authored-garden', '&noads=1&playable=12&standby=1'));
    await ready(held);
    await sleep(2500);
    check('with &standby=1 the round waits for the first input', (await seen(held)).phase === 'ready', (await seen(held)).phase);
    await held.tap('KeyW');
    await held.until(`window.__ipverseGameState?.()?.phase === 'playing'`, 20, 'the first input starts it');
    check('and starts on it', true);
    await held.close();
    // a version-1 arena as a playable ad: its enemies are there at once, and it ends by the trial's clock
    const arena = await open(fixture('spec-sf', '&noads=1&playable=8'));
    await ready(arena);
    await arena.until(`!document.getElementById('end').hidden`, 40, 'the arena\'s trial ends');
    at = await seen(arena);
    check('a version-1 arena\'s trial ends the same way', /^체험 종료 · 전체 게임에서 이어서 즐기세요 적 \d+\/15명 격파 · 점수 \d+ · 0:0[78]$/.test(at.end ?? ''), at.end);
  });

  await scene('autoplay', async ({ open, check, said }) => {
    const page = await open(fixture('spec-authored-garden', '&autoplay=1&noads=1'));
    await page.read(`void (window.__rounds = [], addEventListener('ipverse:round', (e) => window.__rounds.push({ ...e.detail, at: performance.now() })), addEventListener('ipverse:roundstart', () => window.__rounds.push({ start: performance.now() })))`);
    await page.until(`window.__rounds.filter((r) => r.rounds).length >= 2`, 240, 'two rounds under the built-in player');
    const rounds = await page.read(`window.__rounds`);
    said.rounds = rounds;
    const ends = rounds.filter((r) => r.rounds), starts = rounds.filter((r) => r.start);
    check('the built-in player plays round after round and each is reported', ends.length >= 2 && ends.every((r) => typeof r.won === 'boolean' && r.reason), ends);
    check('the next round starts by itself about 4 s after the end screen', starts.length >= 1 && starts[0].start - ends[0].at > 3500 && starts[0].start - ends[0].at < 15000, [ends[0].at, starts[0]?.start]);
    check('no pause card and no keyless note under the built-in player', (await seen(page)).pause === null, (await seen(page)).pause);
    // the end card as a broadcast sends it: wait for the next end and look at the capture
    await page.until(`!document.getElementById('end').hidden`, 120, 'the next round\'s end');
    await page.read(`void document.body.append(Object.assign(window.ipverseCapture(), { id: 'qa-capture', style: 'position:fixed;inset:0;z-index:99;width:100%;height:100%' }))`);
    await sleep(500);
    said.shots.push(await page.shot('autoplay-end-capture'));
  });

  // ---- an older game folder keeps its index.html (a runtime patch brings the scripts and ui.css only) ----
  await scene('oldpage', async ({ open, check, said }) => {
    const page = await open(fixture('spec-authored-garden').replace('/index.html', '/index-old.html'));
    await ready(page);
    check('the loading screen\'s lines were made on the old page', await page.read(`!!document.getElementById('loading-text') && !!document.getElementById('loading-bar') && ![...document.getElementById('loading').childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())`));
    await start(page);
    await sleep(800);
    await page.tap('Escape');
    let at = await seen(page);
    check('the pause card is there, with what its 다시 시작 does', /^일시정지 계속하기 다시 시작 Esc 키로도 계속해요 다시 시작을 누르면 처음부터 다시 해요\./.test(at.pause ?? ''), at.pause);
    await page.tap('Escape');
    await page.read(`void (window.__g3d.mode().hp = 0)`);
    await page.until(`!document.getElementById('end').hidden`, 20, 'the end card');
    at = await seen(page);
    said.end = at.end;
    check('the end card has its reason, result and next lines', /^게임 오버 체력이 다했어요\. 3단계 중 1단계 · \d:\d\d 다시 시작 처음부터 다시 해요\. Enter 키를 눌러도 돼요\.$/.test(at.end ?? ''), at.end);
    said.shots.push(await page.shot('oldpage-end'));
  });

  // ---- a measurement: what a first visit downloads, by file, for one stored game of each kind ----
  // (the game's own assets and the shared kits, as the site serves them; three.js comes from its CDN and is not
  // counted). The round is played 25 s by the built-in player. Only with --only=weight.
  if (process.argv.some((a) => /^--only=.*\bweight\b/.test(a))) await scene('weight', async ({ open, check, said }) => {
    said.games = {};
    for (const [kind, id] of [['survival', 'gm_9539d06a71'], ['sky climb', 'gm_8f1fc9a181'], ['ARPG dungeon', 'gm_b870737b47'], ['city delivery', 'gm_7a41fcae9e'],
      ['track race', 'gm_2ceb5d2311'], ['version-1 arena', 'gm_c153ff5ceb'], ['version-1 quest', 'gm_87e5e315b0']]) {
      serve.sizes.clear();
      const page = await open(game(id, '?autoplay=1&noads=1'));
      await page.until(`document.getElementById('loading').hidden`, 300, `${id} is loaded`);
      const atReady = new Map(serve.sizes);
      await sleep(25000);
      const files = [...serve.sizes].sort((a, b) => b[1] - a[1]), mb = (n) => +(n / 1048576).toFixed(2);
      said.games[id] = { kind, totalMB: mb(files.reduce((n, f) => n + f[1], 0)), atReadyMB: mb([...atReady.values()].reduce((n, b) => n + b, 0)), files: files.length,
        largest: files.slice(0, 6).map(([path, bytes]) => ({ path, MB: mb(bytes), afterReady: !atReady.has(path) })) };
      console.log(`${kind.padEnd(16)} ${id}  ${said.games[id].totalMB} MB in ${files.length} files (${said.games[id].atReadyMB} MB before the start button): `
        + said.games[id].largest.slice(0, 3).map((f) => `${f.path.split('/').slice(-2).join('/')} ${f.MB}`).join(', '));
      await page.close();
    }
    check('every kind was measured', Object.keys(said.games).length === 7, Object.keys(said.games));
  });

  // ---- a round leaves nothing on the graphics card ----
  // Each kind is played five rounds by the built-in player, each round ended from here once it runs. The textures the
  // page holds are counted in every round, and the ones a past round made and nobody deleted are listed by the place
  // they were made in. Only with --only=textures (eight games, about ten minutes).
  if (process.argv.some((a) => /^--only=.*\btextures\b/.test(a))) await scene('textures', async ({ open, check, said }) => {
    said.games = {};
    const running = `(() => { const s = window.__g3d?.state?.(); return !!s && !s.ended && s.phase !== 'ready' && document.getElementById('end').hidden && document.getElementById('loading').hidden; })()`;
    const bot = '?autoplay=1&noads=1';
    for (const [kind, url] of [['survival', game('gm_9539d06a71', bot)], ['sky climb', game('gm_8f1fc9a181', bot)], ['ARPG dungeon', game('gm_b870737b47', bot)],
      ['city delivery', game('gm_7a41fcae9e', bot)], ['track race', game('gm_2ceb5d2311', bot)], ['version-1 arena', game('gm_c153ff5ceb', bot)],
      ['version-1 quest', game('gm_87e5e315b0', bot)], ['garden (no kit)', fixture('spec-authored-garden', '&autoplay=1&noads=1')]]) {
      const page = await open(url);
      await page.until(running, 300, `${kind}: a round runs`);
      await sleep(3000);
      // every texture made from here on is kept with its round and the place it was made in, until it is deleted
      await page.read(`(() => { const gl = __g3d.world.renderer.getContext(), live = new Map(), make = gl.createTexture.bind(gl), drop = gl.deleteTexture.bind(gl);
        window.__made = { live, round: 1 };
        gl.createTexture = () => { const t = make(); live.set(t, { round: window.__made.round, at: new Error().stack }); return t; };
        gl.deleteTexture = (t) => { live.delete(t); drop(t); }; })()`);
      const held = `(() => { const m = __g3d.world.renderer.info.memory; return [m.textures, m.geometries]; })()`;
      const counts = [], geometries = [];
      const count = async () => { const [t, g] = await page.read(held); counts.push(t); geometries.push(g); };
      await count();
      // a picture of round 1 and of round 5: the light, its shadows and reflections are the same after four rounds
      const name = `rounds-${kind.replace(/[^a-z0-9]+/gi, '-').replace(/-$/, '')}`;
      said.shots.push(await page.shot(`${name}-1`));
      for (let round = 2; round <= 5; round++) {
        await page.read(`void (window.__made.round = ${round}, __g3d.mode().end(false))`);
        await page.until(`(window.ipverseRounds ?? 0) >= ${round - 1} && ${running}`, 180, `${kind}: round ${round} runs`);
        await sleep(3000);
        await count();
      }
      said.shots.push(await page.shot(`${name}-5`));
      const left = await page.read(`(() => { const by = {}; for (const t of window.__made.live.values()) { if (t.round > 1 && t.round < 5) {
        const at = t.at.split('\\n').slice(2).map((l) => l.trim().replace(/^at /, '').replace(/\\(?https?:\\/\\/[^/]+\\/(?:npm\\/)?/, '(')).slice(0, 9).join(' < ');
        (by[at] ??= []).push(t.round); } } return by; })()`);
      said.games[kind] = { counts, geometries, left };
      console.log(`${kind.padEnd(16)} textures in rounds 1-5: ${counts.join(', ')} (geometries: ${geometries.join(', ')})`);
      for (const [at, rounds] of Object.entries(left)) console.log(`   made in round ${rounds.join(', ')} and still held: ${at}`);
      check(`${kind}: no more textures in round 5 than in round 2`, counts[4] <= counts[1], counts);
      await page.close();
    }
  });

  // ---- a first visit on a slow link: how much is in, what is being fetched ----
  await scene('loading', async ({ open, check, said }) => {
    serve.bytesPerSec = Number(process.env.QA_BYTES_PER_SEC) || 2.5 * 1048576; // the assets at about 20 Mbit/s
    const page = await open(game('gm_9539d06a71'));
    const LOOK = `(() => { const t = (id) => document.getElementById(id)?.innerText ?? null, b = document.querySelector('.briefing-start');
      return { up: !document.getElementById('loading').hidden, text: t('loading-text'), detail: t('loading-detail'), bar: document.getElementById('loading-bar')?.value ?? null,
        start: b ? { text: b.textContent, disabled: b.disabled } : null }; })()`;
    const samples = [];
    let shotScreen = false, shotButton = false;
    for (const t0 = Date.now(); Date.now() - t0 < 240000; await sleep(400)) {
      const at = await page.read(LOOK).catch(() => null);
      if (!at) continue;
      samples.push({ t: +((Date.now() - t0) / 1000).toFixed(1), ...at });
      const percent = Number(/(\d+)%/.exec(at.text ?? '')?.[1] ?? NaN);
      if (!shotScreen && at.up && !at.start && percent >= 8) { said.shots.push(await page.shot('loading-screen')); shotScreen = true; }
      if (!shotButton && at.start?.disabled && /\d+%/.test(at.start.text)) { said.shots.push(await page.shot('loading-briefing')); shotButton = true; }
      if (at.start && !at.start.disabled) break;
    }
    serve.bytesPerSec = 0;
    said.samples = samples;
    const figures = [...new Set(samples.map((s) => Number(/(\d+)%/.exec(s.text ?? '')?.[1] ?? NaN)).filter(Number.isFinite))];
    check('the loading screen shows a figure that moves', figures.length >= 4, figures);
    check('the figure never goes back', figures.every((n, i) => i === 0 || n >= figures[i - 1]), figures);
    check('it says what is being fetched and how many megabytes of how many', samples.some((s) => /^(캐릭터를 받고 있어요|세계를 만들고 있어요) · \d+\.\d \/ \d+\.\d\s*MB$/.test(s.detail ?? '')), samples.find((s) => s.detail)?.detail);
    check('the briefing\'s busy start button shows the figure too', samples.some((s) => s.start?.disabled && /^게임 불러오는 중… \d+%$/.test(s.start.text)), samples.findLast((s) => s.start?.disabled)?.start);
    check('and ends as 임무 시작', samples.at(-1)?.start?.text === '임무 시작' && samples.at(-1).start.disabled === false, samples.at(-1)?.start);
  });

  // ---- a phone (390 × 844, a finger, no keyboard): the page says what the game needs ----
  await scene('phone', async ({ open, check, said }) => {
    const page = await open(fixture('spec-authored-garden'), { width: 390, height: 844, touch: true });
    await ready(page);
    said.media = await page.read(`({ coarse: matchMedia('(pointer: coarse)').matches, noHover: matchMedia('(hover: none)').matches, anyFine: matchMedia('(any-pointer: fine)').matches })`);
    check('the browser is a phone here: its primary pointer is coarse and cannot hover', said.media.coarse && said.media.noHover, said.media);
    let at = await seen(page);
    said.briefing = at.briefing;
    check('the briefing says the game needs a keyboard and a mouse, and to open it on a PC', (at.briefing ?? '').includes('이 게임은 키보드와 마우스로 플레이해요. PC에서 열어 주세요.'), at.briefing);
    check('the start button says what pressing it means there', at.start?.text === '그래도 시작하기' && at.start.disabled === false, at.start);
    check('no keys list, no Enter hint and no Enter pill', !/조작법|Enter/.test(at.briefing ?? '') && !at.notice
      && await page.read(`getComputedStyle(document.getElementById('notice')).visibility`) === 'hidden', [at.briefing, at.notice]);
    const box = await page.read(`(() => { const r = document.querySelector('.briefing-start').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)]; })()`);
    check('the card and its button fit 390 × 844', box[0] >= 0 && box[1] >= 0 && box[2] <= 390 && box[3] <= 844, box);
    said.shots.push(await page.shot('phone-briefing-390x844'));
    await page.tapOn('.briefing-start');
    await page.until(`window.__ipverseGameState?.()?.phase === 'playing'`, 30, 'a tap starts the round');
    await sleep(3200);
    at = await seen(page);
    check('under the game the line says it too, in place of the keys', at.hint === '이 게임은 키보드와 마우스로 플레이해요. PC에서 열어 주세요.', at.hint);
    said.shots.push(await page.shot('phone-play-390x844'));
    await page.close();

    // the ARPG's panel at that width (a local ARPG: dev/spec-authored-arpg.json)
    const arpg = await open(fixture('spec-authored-arpg'), { width: 390, height: 844, touch: true });
    await ready(arpg);
    await arpg.tapOn('.briefing-start');
    await arpg.until(`window.__ipverseGameState?.()?.phase === 'playing'`, 30, 'the round runs');
    await sleep(2500);
    const panel = await arpg.read(`(() => { const r = document.getElementById('arpg').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)]; })()`);
    said.panel = panel;
    check('the ARPG\'s panel is a compact box in its corner (it ran from y 56 to y 774, over the hero in the middle)', panel[3] - panel[1] < 110 && panel[3] < 300 && panel[2] <= 390, panel);
    said.shots.push(await arpg.shot('phone-arpg-390x844'));
    await arpg.close();

    // a PC: nothing of this
    const pc = await open(fixture('spec-authored-garden'));
    await ready(pc);
    at = await seen(pc);
    check('on a PC the briefing has no such note and the button reads 임무 시작', !(at.briefing ?? '').includes('PC에서') && at.start?.text === '임무 시작', at.start);
  });
}
