// three.js game runtime boot: spec.json + release.json -> optional pre-roll ad -> 3D mode picked by genre.
// Owns the DOM HUD (objective, health/lives, notices, dialogue, floating labels) and the win/lose overlay.
// three.js itself is imported lazily so a CDN failure shows a readable error instead of a blank page.
import { validateSpec } from './gamespec3d.js';
import { KEYLESS_NOTE, LoadMeter, controlsFor, controlsLine, endCard, endKey, keylessDevice, loadLine, pauseRules, restartLine, roundWatch,
  steadyEstimate, wallSeconds } from './arpg-data.js';

const $ = (id) => document.getElementById(id);
const el = (tag, text, cls) => Object.assign(document.createElement(tag), { textContent: text, className: cls ?? '' });

// ponytail: ?spec= / ?release= / ?fps= work on localhost only (dev); a published game always reads its own folder.
const query = new URLSearchParams(location.search);
const dev = ['localhost', '127.0.0.1'].includes(location.hostname);
const specUrl = (dev && query.get('spec')) || './spec.json';
const releaseUrl = (dev && query.get('release')) || './release.json';
const showFps = query.get('fps') === '1';
// ?autoplay=1: a built-in player (aim at the nearest enemy, fire, strafe, restart) for the live-stream broadcaster.
const autoplay = query.get('autoplay') === '1';
// ?noads=1: the live stream's ads come from MediaTailor, so the page shows none (rounds are still counted).
const noAds = query.get('noads') === '1';
const AUTOPLAY_ROUND_SEC = 180; // the built-in player's round cap; its watchdog (arpg-data.js WATCHDOG) ends a stuck one sooner
// ?playable=<seconds>: a playable ad (server/playable.py): no briefing to click through, the round starts at once
const playableSec = Number(query.get('playable')) || 0;
// &standby=1: a live viewer's hidden, pre-connected ad session: the round (and its timer) wait for the viewer's first
// real input, which only arrives once the card is clicked and the stream is revealed
const standby = query.get('standby') === '1';
// ?nopause=1: a broadcast's play window with a person at the keys: no pause (a paused round sends a standing picture
// and holds back the round ends the ads wait for). The cloud stream also loads ?noads=1 and keeps its pause.
const noPause = query.get('nopause') === '1';
// what a pause may do on this page (arpg-data.js pauseRules): nothing under the built-in player (a broadcast must go
// on), under ?nopause=1 or in a playable ad (the trial's clock is the ad page's)
const rules = pauseRules({ autoplay, playable: !!playableSec, noAds, noPause });

async function getJson(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

function isSameOrigin(url) {
  try {
    return typeof url === 'string' && url !== '' && new URL(url, location.href).origin === location.origin;
  } catch {
    return false;
  }
}

/** A key tap as the modes' Input takes it (world.js): the keydown and, `ms` later, its keyup, on the window. */
function tap(code, ms = 100) {
  dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
  setTimeout(() => dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true })), ms);
}

/** The element with this id, made in `parent` (before `before`) when the page has none: a game folder keeps its
 * own index.html, and a runtime patch brings only the scripts and ui.css. */
function ensure(id, tag, parent, before = null) {
  return $(id) ?? parent.insertBefore(Object.assign(document.createElement(tag), { id }), before);
}

/** The keys a game takes as a list, a row a key: what it does and its key caps (arpg-data.js controlsFor). */
function keyList(controls) {
  const list = el('ul', '', 'keys');
  for (const c of controls) {
    const row = el('li'), caps = el('span', '', 'caps');
    c.keys.forEach((k, i) => { if (i && c.any) caps.append(el('i', '또는')); caps.append(el('kbd', k)); });
    row.append(el('span', c.label), caps);
    list.append(row);
  }
  return list;
}

/** The loading screen: how much of the files asked for so far is in (arpg-data.js LoadMeter), as a figure and a bar,
 * and what boot() is at. The figure never goes back. → { label: the figure in a line, for the briefing's busy start
 * button; to(phase): engine | hero | world | frame }. The figures are aria-hidden: a screen reader hears the phases. */
function loadingScreen(meter) {
  const box = $('loading');
  for (const node of [...box.childNodes]) if (node.nodeType === 3) node.remove(); // an older index.html's own "불러오는 중…"
  const text = ensure('loading-text', 'p', box), bar = ensure('loading-bar', 'progress', box), detail = ensure('loading-detail', 'p', box);
  const percent = el('span'), what = el('span'), bytes = el('span');
  percent.setAttribute('aria-hidden', 'true'); bytes.setAttribute('aria-hidden', 'true');
  text.replaceChildren('게임 불러오는 중…', percent);
  detail.replaceChildren(what, bytes);
  bar.max = 100; bar.setAttribute('aria-label', '불러온 정도');
  const screen = { phase: 'engine', sized: false, percent: 0, label: '게임 불러오는 중…', onlabel: null };
  const set = (node, value) => { if (node.textContent !== value) node.textContent = value; };
  screen.refresh = () => {
    // (the figure, or the step's name where the figure would stand at 99: arpg-data.js loadLine)
    const line = loadLine(meter.state, screen.phase, screen.sized, screen.percent), label = line.text;
    screen.percent = line.percent ?? screen.percent;
    set(percent, label.slice('게임 불러오는 중…'.length));
    set(what, line.what); set(bytes, line.bytes ? ` · ${line.bytes}` : '');
    bar.hidden = line.percent == null;
    bar.value = screen.percent;
    if (label !== screen.label) { screen.label = label; screen.onlabel?.(label); }
  };
  screen.to = (phase) => { screen.phase = phase; screen.refresh(); };
  screen.ready = () => { screen.sized = true; screen.refresh(); }; // the sizes asked ahead are in: the figure can be told
  meter.onchange = screen.refresh;
  screen.refresh();
  return screen;
}

/** Asks the sizes of the files a game will load ahead of them (HEAD), so the loading screen's total stands from the
 * start. A file whose size cannot be asked is counted when it loads. → a promise for "the sizes are in" (or 3 s
 * have passed). */
function sizeAhead(meter, urls) {
  const asked = [...new Set(urls.filter(Boolean))].map((url) => fetch(url, { method: 'HEAD' })
    .then((res) => { if (res.ok) meter.expect(url, Number(res.headers.get('content-length'))); }).catch(() => {}));
  return Promise.race([Promise.all(asked), new Promise((resolve) => setTimeout(resolve, 3000))]);
}

/** The pause card's elements, made on the page: a dialog over the game with 계속하기, 다시 시작, what 다시 시작 does
 * (`next`, written as the card opens) and the keys. */
function pauseCard(controls) {
  const root = ensure('pause', 'div', document.body);
  root.hidden = true;
  for (const [name, value] of [['role', 'dialog'], ['aria-modal', 'true'], ['aria-labelledby', 'pause-title']]) root.setAttribute(name, value);
  const title = el('h2', '일시정지'), note = el('p', '', 'pause-note'), actions = el('div', '', 'pause-actions');
  const resume = el('button', '계속하기'), restart = el('button', '다시 시작', 'quiet');
  const next = el('p', '', 'pause-next');
  title.id = 'pause-title';
  resume.type = restart.type = 'button';
  actions.append(resume, restart);
  const card = el('div', '', 'pause-card');
  card.append(title, note, actions, el('p', 'Esc 키로도 계속해요', 'pause-esc'), next, el('h3', '조작법'), keyList(controls));
  root.replaceChildren(card);
  return { root, note, next, resume, restart };
}

/** The pause of a person's round: Esc or P open and close its card, leaving the window or the tab opens it, and the
 * round's clocks stand while it is up (the loop asks `on`). `rules`: arpg-data.js pauseRules; `playing()`: a round
 * is being played; `input`, `canvas`: the world's (a key held as the card opens must be released: its keyup goes to
 * the card's button); `card`: pauseCard's elements; `onRestart`: 다시 시작; `next()`: what 다시 시작 does, in the
 * card's words. → { on, set(on, why) } */
function makePause({ rules, playing, input, canvas, card, onRestart, next }) {
  const pause = { on: false };
  let released = -Infinity; // when a captured mouse was let go (ms)
  pause.set = (on, why = 'key') => {
    if (on === pause.on || (on && !playing())) return;
    pause.on = on;
    card.root.hidden = !on;
    input.keys.clear(); input.pressed.clear(); input.fireHeld = false;
    if (!on) { canvas.focus(); return; }
    if (document.pointerLockElement) document.exitPointerLock();
    card.note.textContent = why === 'away' ? '다른 곳을 보는 동안 게임을 멈춰 뒀어요.' : '';
    card.note.hidden = !card.note.textContent;
    card.next.textContent = next();
    card.resume.focus();
  };
  if (!rules.manual) return pause;
  // Heard first (capture) and kept from the page around the game's frame while a round is played or paused: the
  // studio's big view hooks Esc on this window too, and one press must not both pause and close the view. A held key
  // is no second press. With no round on (the briefing, the end card) Esc is the page's.
  addEventListener('keydown', (e) => {
    if (!['Escape', 'KeyP'].includes(e.code) || !(pause.on || playing())) return;
    e.stopPropagation();
    if (e.repeat) return;
    if (e.code === 'Escape' && performance.now() - released < 400) return; // the Esc that let the mouse go has paused it
    pause.set(!pause.on);
  }, true);
  // Esc out of a captured mouse (an arena): the browser keeps that key press to itself, so the capture's end says it
  // (not one the window's loss of focus took: that is the window's own rule, below)
  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement || !document.hasFocus() || pause.on) return;
    released = performance.now();
    pause.set(true);
  });
  card.resume.onclick = () => pause.set(false);
  card.restart.onclick = () => { pause.set(false); onRestart(); };
  if (rules.auto) {
    addEventListener('blur', () => pause.set(true, 'away'));
    document.addEventListener('visibilitychange', () => { if (document.hidden) pause.set(true, 'away'); });
  }
  return pause;
}

function showErrors(errors) {
  $('loading').hidden = true;
  $('errors').replaceChildren(el('h1', '게임을 시작할 수 없습니다'), ...errors.map((e) => el('p', e)));
  $('errors').hidden = false;
}

// Resolves when the ad is skipped (after skipAfterSec), ends, or fails to load. Same behavior as game/runtime.js.
function playAd(ad) {
  if (!ad || typeof ad.videoUrl !== 'string') return Promise.resolve();
  const box = $('ad');
  const video = box.querySelector('video');
  const skip = $('skip');
  let left = Number.isInteger(ad.skipAfterSec) && ad.skipAfterSec >= 0 ? ad.skipAfterSec : 5;
  return new Promise((resolve) => {
    const tick = () => {
      skip.disabled = left > 0;
      skip.textContent = left > 0 ? `광고 건너뛰기 (${left})` : '광고 건너뛰기';
      if (left > 0) {
        left -= 1;
      } else {
        clearInterval(timer);
        skip.focus();
      }
    };
    const done = () => {
      clearInterval(timer);
      video.pause();
      box.hidden = true;
      resolve();
    };
    const timer = setInterval(tick, 1000);
    tick();
    skip.onclick = done;
    video.onended = done;
    video.onerror = done;
    box.hidden = false;
    video.src = ad.videoUrl;
  });
}

// The modes talk to the page only through this object.
function makeHud(world, THREE) {
  const setText = (id, text) => { if ($(id).textContent !== text) $(id).textContent = text; };
  const floats = new Map();
  const v = new THREE.Vector3();
  const project = (pos, node) => {
    v.copy(pos).project(world.camera);
    const visible = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
    node.hidden = !visible;
    if (visible) node.style.transform = `translate(${((v.x + 1) / 2) * innerWidth}px, ${((1 - v.y) / 2) * innerHeight}px) translate(-50%, -100%)`;
  };
  const hud = {
    objective: (text) => setText('objective', text),
    status: (text) => setText('status', text),
    // `big`: a countdown, written large. Not over the end card, which says itself why the round ended (hud.end): the
    // text is kept and the pill stays down until 다시 시작
    notice: (text, big = false) => {
      setText('notice', text);
      $('notice').hidden = !text || !$('end').hidden;
      $('notice').classList.toggle('big', big && !!text);
    },
    // a gauge shows only in a game that uses it: frac null hides it (authored.js refreshHud)
    health(frac, shield = 0) {
      $('vitals').dataset.kind = frac == null ? 'none' : 'hp';
      $('shield').hidden = frac == null || shield <= 0;
      if (frac == null) return;
      $('hpfill').style.transform = `scaleX(${Math.max(0, frac)})`;
      $('hpfill').classList.toggle('low', frac < 0.3);
      setText('hptext', `${Math.ceil(frac * 100)}`);
      if (shield > 0) setText('shield', `방어막 ${Math.ceil(shield)}초`);
    },
    lives(n) {
      $('vitals').dataset.kind = n == null ? 'none' : 'lives';
      if (n != null) setText('hearts', '♥'.repeat(Math.max(0, n)) + '♡'.repeat(Math.max(0, 3 - n)));
      $('hearts').setAttribute('aria-label', `목숨 ${n ?? 0}`);
    },
    dash(frac) {
      $('dash').hidden = frac == null;
      if (frac != null) $('dashfill').style.transform = `scaleX(${Math.min(1, Math.max(0, frac))})`;
    },
    crosshair(on) { $('crosshair').hidden = !on || !$('end').hidden; }, // (never across the end card)
    say(line) {
      const box = $('say');
      box.hidden = !line;
      if (!line) return;
      box.querySelector('b').textContent = line.speaker ?? '';
      box.querySelector('span').textContent = line.text;
    },
    // A label pinned to a world position (re-projected each call); text null removes it.
    float(key, text, pos, cls = 'tag') {
      let node = floats.get(key);
      if (!text) { if (node) { node.remove(); floats.delete(key); } return; }
      if (!node) { node = el('div', '', `float ${cls}`); $('floats').append(node); floats.set(key, node); }
      if (node.textContent !== text) node.textContent = text;
      project(pos, node);
    },
    popup(text, pos, cls = 'pickup', ms = 900) {
      const node = el('div', text, `float popup ${cls}`);
      node.style.animationDuration = `${ms}ms`;
      $('floats').append(node);
      project(pos, node);
      setTimeout(() => node.remove(), ms);
    },
    end: () => {},
  };
  return hud;
}

async function boot() {
  let result;
  try {
    result = validateSpec(await getJson(specUrl));
  } catch (err) {
    result = { ok: false, errors: [err.message] };
  }
  if (!result.ok) return showErrors(result.errors);
  const { spec } = result;

  // Assets must be same-origin (cross-origin images and GLBs need CORS); anything else falls back.
  for (const item of [spec.player, ...spec.props, ...spec.enemies]) {
    for (const key of ['spriteUrl', 'modelUrl', 'weaponUrl']) if (!isSameOrigin(item[key])) delete item[key];
  }
  if (!isSameOrigin(spec.animUrl)) delete spec.animUrl;

  document.title = String(spec.title || 'IPverse 게임');
  for (const key of ['bg', 'accent', 'text']) document.documentElement.style.setProperty(`--${key}`, spec.palette[key]);
  const sf = spec.genre.startsWith('sf-');
  const authored = spec.version === 2;
  const city = authored && !!spec.world?.city;
  const track = authored && !!spec.world?.track; // open-track racing on a biome (track.js)
  // the keys this game takes (arpg-data.js controlsFor): the hint under the game, the briefing's list, the pause card's
  const controls = controlsFor(spec, { pause: rules.manual });
  $('hint').textContent = controlsLine(controls);
  // a device with no keyboard to play on (arpg-data.js keylessDevice): the page says so where it names the keys
  // (tellDevice, below)
  let keyless = keylessDevice(matchMedia);
  $('dash').querySelector('span').textContent = '대시 Q'; // the gauge says its key
  // the hint's pill wraps on a narrow window: what sits over it (the gauges, the story box; ui.css) keeps clear of it
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => document.documentElement.style.setProperty('--hint-h', `${$('hint').offsetHeight}px`)).observe($('hint'));
  }
  $('title').textContent = String(spec.title || '');
  // the loading screen counts what is downloaded (loadingScreen): the files the boot itself loads are sized ahead,
  // a version-2 game's enemies among them (authored.js loadCast)
  const meter = new LoadMeter(), loading = loadingScreen(meter);
  sizeAhead(meter, [spec.animUrl, spec.player.modelUrl, spec.player.weaponUrl, ...spec.props.map((p) => p.modelUrl),
    ...spec.enemies.flatMap((e) => [e.modelUrl, e.weaponUrl]),
    ...(spec.world?.entities ?? []).map((e) => e.modelUrl), spec.world?.background?.modelUrl]).then(loading.ready);
  // the pre-roll plays from the start, over the loading
  const release = noAds ? Promise.resolve(null) : getJson(releaseUrl).catch(() => null); // 404 / non-JSON: no release
  const adDone = release.then((r) => playAd(r?.ad));

  let engine;
  try {
    const [worldMod, modeMod] = await Promise.all([import('./world.js'), city ? import('./city.js') : track ? import('./track.js') : authored ? import('./authored.js') : sf ? import('./sf.js') : import('./rpg.js')]);
    engine = { ...worldMod, create: city ? modeMod.createCity : track ? modeMod.createTrack : authored ? modeMod.createAuthored : sf ? modeMod.createSf : modeMod.createRpg };
  } catch (err) {
    console.error(err);
    return showErrors(['3D 엔진을 불러오지 못했습니다 (cdn.jsdelivr.net).']);
  }
  let world;
  try {
    world = new engine.World($('game'), { fps: showFps, meter });
  } catch (err) {
    console.error(err);
    return showErrors(['이 브라우저에서 WebGL을 사용할 수 없습니다.']);
  }
  $('fps').hidden = !showFps;
  world.input.pointerLockWanted = sf;
  world.input.botOnly = autoplay; // under the built-in player a keyboard's keys are not the hero's (world.js Input)
  const { THREE } = engine;
  const hud = makeHud(world, THREE);
  // the story box passes on a click or a tap too, as on the Enter every mode passes it on (authored.js, rpg.js)
  $('say').onclick = () => tap('Enter');
  const accent = new THREE.Color(spec.palette.accent);

  loading.to('hero');
  if (spec.animUrl) await world.loadAnims(spec.animUrl); // before any rigged actor binds its clips
  const playerActor = await world.makeActor(spec.player, 1.8, () => engine.proceduralHero(accent));
  loading.to('world');
  let mode = null;
  if (authored) {
    // Public observer only. No model, actor, input or state mutation handle is exposed.
    window.__ipverseGameState = () => mode ? structuredClone({ ...mode.debugState(), performance: world.performanceSnapshot() }) : null;
  }
  let ended = false;
  let stalled = false; // the built-in player's watchdog ended this round
  let botCap = 0; // the built-in player's cap on the round being played, in seconds of its clock (0: none)
  let building = null;
  let briefing = null;
  let briefingStart = null;
  let briefingNote = null;
  let startReady = false;
  let replay = false; // a round after the first is being built (nextRound): its files are in, it starts by itself
  const setStartReady = (ready) => {
    startReady = ready;
    if (!briefingStart) return;
    briefingStart.disabled = !ready;
    // (busy: the loading screen's own figure, "게임 불러오는 중… 62%"; a later round's files are in already)
    briefingStart.textContent = ready ? (keyless ? '그래도 시작하기' : '임무 시작') : replay ? '다시 시작하는 중…' : loading.label;
    briefingStart.setAttribute('aria-busy', String(!ready));
  };
  loading.onlabel = () => { if (!startReady) setStartReady(false); };
  if (authored) {
    briefing = el('section', '', 'briefing');
    briefing.setAttribute('role', 'dialog');
    briefing.setAttribute('aria-label', '임무 브리핑');
    const card = el('div', '', 'briefing-card');
    if (spec.player.spriteUrl) {
      const portrait = document.createElement('img');
      portrait.src = spec.player.spriteUrl;
      portrait.alt = spec.player.name || '선택한 캐릭터';
      card.append(portrait);
    }
    // in a player's words
    card.append(el('p', '임무 브리핑', 'briefing-kicker'), el('h1', spec.title),
      el('p', [spec.player.name, spec.mission.title].filter(Boolean).join(' · '), 'briefing-summary'));
    const stages = el('ol', '', 'briefing-steps');
    for (const stage of spec.mission.stages) stages.append(el('li', stage.label));
    const start = el('button', loading.label, 'briefing-start');
    briefingStart = start;
    start.type = 'button';
    start.disabled = true;
    start.setAttribute('aria-busy', 'true');
    start.onclick = () => {
      if (!startReady || start.disabled || mode?.phase !== 'ready') return;
      world.canvas.focus();
      dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', bubbles: true }));
      setTimeout(() => dispatchEvent(new KeyboardEvent('keyup', { code: 'Enter', bubbles: true })), 100);
    };
    const keys = keyList(controls);
    keys.classList.add('briefing-controls');
    briefingNote = el('p', KEYLESS_NOTE, 'briefing-device'); // (shown on a device without a keyboard: tellDevice)
    // (the pill behind the card says "Enter · 임무 시작" too: ui.css keeps it out of sight while the card is up)
    card.append(stages, briefingNote, start, el('p', 'Enter 키를 눌러도 시작해요', 'briefing-enter'), el('h2', '조작법', 'briefing-keys'), keys);
    briefing.append(card); $('stage').append(briefing);
  }
  /** What the page says of the device: without a keyboard the briefing says what the game needs (the button reads
   * 그래도 시작하기), the line under the game says it in place of the keys, and what cannot be pressed is left out
   * (ui.css body.keyless). A version-1 game has no briefing: the line under the game says it. No touch controls. */
  const tellDevice = () => {
    document.body.classList.toggle('keyless', keyless);
    $('hint').textContent = keyless ? KEYLESS_NOTE : controlsLine(controls);
    if (briefingNote) briefingNote.hidden = !keyless;
    setStartReady(startReady);
  };
  tellDevice();
  // a key pressed after all (a keyboard on a tablet): the page takes its word back
  addEventListener('keydown', (e) => { if (keyless && e.isTrusted) { keyless = false; tellDevice(); } });
  const build = async () => {
    setStartReady(false);
    mode = null;
    world.input.keys.clear();
    world.input.pressed.clear();
    playerActor.root.visible = true;
    playerActor.animator?.revive(); // the same actor every round: stand it back up after a death
    const next = await engine.create(world, spec, hud, playerActor);
    if (briefing) briefing.hidden = false;
    // the built-in player cannot always finish collect/reach (walls, crowds): when the design sets no time limit its
    // rounds end after AUTOPLAY_ROUND_SEC at most, so "an ad every N rounds" comes around. A mission with survive
    // stages gets twice their seconds; a v1 survive round ends by its own clock.
    const surviveSec = spec.mission?.stages?.reduce((n, s) => n + (s.type === 'survive' ? s.target : 0), 0) ?? 0;
    if (playableSec && 'timeLimit' in next) next.timeLimit = playableSec;
    // a playable ad's enemies are there from the first frame (sf.js)
    if (playableSec) next.openNow?.();
    // the cap is kept here and not in the mode's timeLimit, which every HUD would count down: the built-in player's
    // loop ends the round at it and ipverseRoundEndsIn reports it
    botCap = autoplay && 'timeLimit' in next && !next.timeLimit && (spec.objective.type !== 'survive' || surviveSec > 0)
      ? Math.max(AUTOPLAY_ROUND_SEC, surviveSec * 2) : 0;
    ended = false;
    mode = next;
  };

  const end = $('end');
  // the end card's own lines, under its title: why, the result; and under its button what the button does (hud.end)
  const endReason = ensure('end-reason', 'p', end, $('restart')), endResult = ensure('end-result', 'p', end, $('restart'));
  const endNext = ensure('end-next', 'p', end);
  // Rounds played on this page. release.ad.everyRounds = N: the ad plays again after every N-th finished round
  // (before the next one starts). window.ipverseRounds + the ipverse:round event let a broadcaster follow along.
  let rounds = 0;
  let adEvery = 0;
  window.ipverseRoundStart = true; // this runtime also fires ipverse:roundstart when the next round is playable
  // Seconds until the round being played ends by the clock, when that is known ahead: a survive objective ("N초
  // 버티기"), a last mission stage that is survive, or a time limit; else null (a clear or a death ends it). The play
  // window reads it to send a broadcast's ad break early (the pre-cue: IVS stitches the ad ~11 s after the call).
  window.ipverseRoundEndsIn = () => {
    if (!mode || ended || mode.ended || mode.phase === 'ready' || !(mode.elapsed > 0)) return null;
    const ends = [];
    const limit = mode.timeLimit > 0 ? mode.timeLimit : botCap; // the design's or a playable ad's limit, else the built-in player's cap
    if (limit > 0 && spec.objective?.type !== 'survive') ends.push(limit - mode.elapsed);
    if (spec.objective?.type === 'survive' && !mode.director && mode.target > 0) ends.push(mode.target - mode.elapsed);
    const d = mode.director;
    const stage = d?.stage;
    if (stage?.type === 'survive' && d.index === d.mission.stages.length - 1) ends.push(stage.target - d.elapsed);
    return ends.length ? Math.max(0, Math.min(...ends)) : null;
  };
  // The same with estimates: { seconds, estimated } or null. A clock's end in wall seconds (wallSeconds: a slow PC's
  // game clock runs behind), else the built-in player's race on its last stretch, once that estimate is steady
  // (steadyEstimate; a person's race is never estimated). ipverseRoundEndsIn stays a clock's end only, for play
  // windows that do not know estimates.
  let estimate = null, paced = null;
  window.ipverseRoundEnd = () => {
    const exact = window.ipverseRoundEndsIn(), now = performance.now() / 1000;
    // the estimate first: a round under a time limit (or the built-in player's cap) always has a clock's end, and the
    // race is over long before it. The sooner of the two is the round's end
    const est = steadyEstimate(estimate, autoplay && mode && !ended ? mode.raceEndsIn?.() ?? null : null, now);
    estimate = est.state;
    if (est.seconds != null && (exact == null || est.seconds < exact)) return { seconds: est.seconds, estimated: true };
    if (exact == null) { paced = null; return null; }
    const got = wallSeconds(paced, exact, now);
    paced = got.state;
    return { seconds: got.seconds, estimated: false };
  };
  // A broadcast's ad for a round whose end was not known ahead is sent at the round's report and takes the viewers'
  // picture 3–9 s later: the play window asks for the end screen to stay that long (ms), so the ad starts over the
  // result and not over the next round. Only the built-in player waits; a person's restart is theirs.
  let holdUntil = 0;
  window.ipverseHoldEnd = (ms) => { holdUntil = Math.max(holdUntil, performance.now() + Math.min(Number(ms) || 0, 20000)); };
  release.then((r) => { adEvery = Number.isInteger(r?.ad?.everyRounds) && r.ad.everyRounds > 0 ? r.ad.everyRounds : 0; });
  const restart = async () => {
    if (end.hidden || building) return;
    end.hidden = true;
    hud.notice(''); // why the last round ended: said on its end screen, not over the next round's briefing
    for (const node of $('floats').querySelectorAll('.float')) node.remove(); // last run's loot and damage labels
    setStartReady(false);
    if (briefing) briefing.hidden = false;
    removeEventListener('keydown', onKey);
    await nextRound(adEvery > 0 && rounds % adEvery === 0); // (a mid-roll, then the round)
  };
  /** The round after the first: the last one's world goes, the mid-roll plays when one is due, the world is built
   * again and the round starts by itself (no second briefing). The card shows its title and the busy start button
   * meanwhile (ui.css .again); the keys are on the pause card (Esc) and under the game. */
  const nextRound = async (midroll) => {
    replay = true;
    briefing?.classList.add('again');
    const old = mode;
    mode = null;
    if (old) old.ended = true; // (a round left from the pause card: nothing it still awaits may end the next one)
    old?.dispose();
    if (midroll) await release.then((r) => playAd(r?.ad));
    building = build();
    try {
      await building;
      world.input.keys.clear();
      world.input.pressed.clear();
      setStartReady(true);
      setTimeout(() => briefingStart?.onclick?.(), 300); // as the built-in player and a playable ad always did
    }
    catch (error) { showErrors([error.message]); }
    finally { building = null; }
    world.canvas.focus();
    dispatchEvent(new CustomEvent('ipverse:roundstart', { detail: { rounds } })); // the play window records from here
  };
  // The end card's keys. The listener is on from the moment the card is up and takes Enter and Space for the card,
  // so the focused button is never pressed by them itself; what counts as a press is arpg-data.js endKey (none in the
  // card's first 0.8 s, never a key held since the round). A click on the button waits the same 0.8 s: in an ARPG a
  // click is the attack and the button comes up under it (ui.css #restart shows it as not yet pressable). The
  // built-in player's restart() and a broadcast's hold (ipverseHoldEnd) do not come through here.
  let endAt = 0; // when the end card came up (performance.now())
  const onKey = (e) => {
    if (!['Enter', 'Space'].includes(e.code)) return;
    e.preventDefault();
    // under the built-in player a keyboard's key does not press the card either: its own restart comes after 4 s and
    // a broadcast's hold, which keeps the result up until the ad has taken the picture
    if (autoplay && e.isTrusted) return;
    if (endKey(performance.now() - endAt, e.repeat)) restart();
  };
  $('restart').onclick = () => { if (endKey(performance.now() - endAt)) restart(); };
  hud.end = (won) => {
    if (ended) return;
    ended = true;
    if (document.pointerLockElement) document.exitPointerLock();
    // every finished round counts, whatever its outcome: a clear, a death, or a time limit (the design's, the
    // built-in player's round cap or its watchdog)
    rounds += 1;
    window.ipverseRounds = rounds;
    const reason = won ? 'clear' : stalled || (mode?.timeLimit > 0 && mode.elapsed >= mode.timeLimit) ? 'timeout' : 'death';
    stalled = false;
    // The round's report and the built-in player's next round come first, before a word of the card: a throw in
    // endCard() or the mode's endSummary() must not leave a broadcast with a counted round and no report or next round
    dispatchEvent(new CustomEvent('ipverse:round', { detail: { rounds, won, reason, adDue: adEvery > 0 && rounds % adEvery === 0, everyRounds: adEvery } }));
    if (autoplay) {
      const again = () => (performance.now() < holdUntil ? setTimeout(again, 250) : restart());
      setTimeout(again, 4000);
    }
    // the card: why the round ended, what it came to, and what 다시 시작 does (arpg-data.js endCard, the mode's
    // endSummary). The reason is on the card: no pill over it. Whatever the mode says of its round, the card comes up,
    // with its own words if need be: 다시 시작 starts from it
    const words = { won, playable: !!playableSec, timeout: reason === 'timeout', keys: !keyless };
    let card;
    try { card = endCard({ ...words, failure: won ? null : mode?.failure ?? null, summary: mode?.endSummary?.(won) ?? null }); }
    catch (error) { console.warn('end card', error); card = endCard(words); }
    $('end-title').textContent = card.title;
    for (const [node, text] of [[endReason, card.reason], [endResult, card.result], [endNext, card.next]]) { node.textContent = text; node.hidden = !text; }
    $('restart').hidden = !!playableSec; // a playable ad ends here; the ad page shows the call to action
    $('crosshair').hidden = true;
    $('notice').hidden = true;
    end.dataset.won = won ? 'yes' : 'no';
    end.hidden = false;
    $('restart').focus();
    endAt = performance.now(); // keys mashed as the run ended must not skip the result (onKey)
    // a playable ad's card takes no key: it has no 다시 시작. The trial is the ad page's: its clock, its cloud seat,
    // what comes after it
    if (!playableSec) addEventListener('keydown', onKey);
  };

  let held = false; // &standby=1: the round waits for the viewer's first input
  // Build the world while the ad plays; the first update (and the start grace) begins after it. The first frame is
  // made here, under the loading screen or the ad (World.warm), so it does not hold the thread once the page says
  // it is ready
  const prime = async () => {
    try {
      mode.idle(0); // the camera at the hero, and no round update: under ?autoplay=1 an ARPG's starts the round itself
      world.update(0);
      loading.to('frame');
      await world.warm();
    } catch (err) { console.warn('warm', err); } // the loop's first frame then does that work, as it did
  };
  await Promise.all([build().then(prime), adDone]);
  world.input.keys.clear();
  world.input.pressed.clear();
  setStartReady(true);
  if (autoplay || (playableSec && !standby)) setTimeout(() => briefingStart?.onclick?.(), 300);
  else if (playableSec && standby) {
    held = true; // every mode (v1 ones have no briefing) waits: no enemies, no timer until the viewer is there
    const go = (e) => {
      if (!e.isTrusted) return; // the briefing button's own synthetic Enter
      removeEventListener('keydown', go, true);
      removeEventListener('pointerdown', go, true);
      held = false;
      setTimeout(() => briefingStart?.onclick?.(), 0);
    };
    addEventListener('keydown', go, true);
    addEventListener('pointerdown', go, true);
  }
  $('loading').hidden = true;
  $('hud').hidden = false;
  world.canvas.focus();

  const clock = new THREE.Clock();
  let frozen = false; // dev: hold a frame (screenshots of a pose)
  meter.onchange = null; // the loading screen is down: a file that comes later (a dropped rig's raw mesh) moves nothing on it
  /** 다시 시작 on the pause card: the round being played is left (it is not a finished round: no count, no ad) and the
   * next one is built, from the last checkpoint as after a loss. */
  const startOver = async () => {
    if (building || !mode || ended) return;
    hud.notice('');
    for (const node of $('floats').querySelectorAll('.float')) node.remove();
    setStartReady(false);
    if (briefing) briefing.hidden = false;
    await nextRound(false);
  };
  /** What 다시 시작 on the pause card does from here, as the end card says it: the mode's own word on where a round
   * left now goes on. */
  const restartNote = () => {
    let stage = 0;
    try { stage = mode?.endSummary?.(false)?.resumeStage ?? 0; } catch { /* the card says the start */ }
    return `다시 시작을 누르면 ${restartLine(stage)}`;
  };
  // the pause (makePause; what it may do here: arpg-data.js pauseRules)
  const pause = makePause({ rules, input: world.input, canvas: world.canvas, card: pauseCard(controls), onRestart: startOver, next: restartNote,
    playing: () => !!mode && !ended && !building && !held && mode.phase !== 'ready' && $('ad').hidden });
  // a stopped round's end is not known ahead: the play window sends no ad break for it (ipverseRoundEnd asks this too)
  const endsIn = window.ipverseRoundEndsIn;
  window.ipverseRoundEndsIn = () => (pause.on ? null : endsIn());
  world.renderer.setAnimationLoop(() => {
    const realDt = clock.getDelta();
    // the bot broadcaster may render only a few frames a second: its rounds still follow the wall clock.
    // A paused round's clocks stand (no time passes in it); its picture is still drawn (a broadcast's capture reads it)
    const still = frozen || pause.on;
    const dt = still ? 0 : Math.min(realDt, world.lite ? .25 : 1 / 20);
    world.input.pollPad();
    if (mode && !still && !held && (!authored || startReady)) {
      if (ended) mode.idle(dt);
      else mode.update(dt);
      if (briefing) briefing.hidden = mode.phase !== 'ready';
    }
    world.update(dt);
    world.render(dt, realDt);
    world.input.endFrame();
  });

  // Capture surface for the expanded view and the live broadcast: the 3D frame plus the DOM HUD, redrawn each
  // animation frame at the canvas size. Created on first request only (no cost for normal play).
  let capture = null;
  window.ipverseCapture = () => {
    if (capture) return capture;
    const src = world.renderer.domElement;
    capture = document.createElement('canvas');
    const g = capture.getContext('2d');
    const txt = (id) => (document.getElementById(id)?.hidden ? '' : document.getElementById(id)?.textContent ?? '');
    const draw = () => {
      // the size and aspect the player sees on screen (the WebGL buffer may differ and be stretched by CSS)
      const w = Math.round(src.clientWidth || src.width), h = Math.round(src.clientHeight || src.height), k = h / 720;
      if (capture.width !== w || capture.height !== h) { capture.width = w; capture.height = h; }
      g.drawImage(src, 0, 0, w, h);
      g.textBaseline = 'top';
      g.shadowColor = 'rgba(0,0,0,.7)'; g.shadowBlur = 6 * k;
      g.fillStyle = 'rgba(232,240,240,.75)'; g.font = `${13 * k}px system-ui, sans-serif`;
      g.fillText(txt('title'), 22 * k, 18 * k);
      g.fillStyle = spec.palette.accent; g.font = `700 ${17 * k}px system-ui, sans-serif`;
      g.fillText(txt('objective'), 22 * k, 38 * k);
      g.textAlign = 'right'; g.fillStyle = '#fff'; g.font = `700 ${17 * k}px system-ui, sans-serif`;
      g.fillText(txt('status'), w - 22 * k, 20 * k);
      g.textAlign = 'left';
      const hp = document.getElementById('hpfill');
      if (!document.getElementById('hud').hidden && hp && document.getElementById('vitals').dataset.kind === 'hp') { // HP bar from the fill's scaleX, in a game that has one
        const frac = Number(/scaleX\(([\d.]+)\)/.exec(hp.style.transform)?.[1] ?? 1);
        g.shadowBlur = 0;
        g.fillStyle = 'rgba(255,255,255,.18)'; g.fillRect(22 * k, h - 86 * k, 190 * k, 10 * k);
        g.fillStyle = frac < 0.3 ? '#ff5a5a' : spec.palette.accent; g.fillRect(22 * k, h - 86 * k, 190 * k * frac, 10 * k);
        g.fillStyle = '#fff'; g.font = `700 ${14 * k}px system-ui, sans-serif`; g.fillText(txt('hptext'), 222 * k, h - 90 * k);
      }
      const center = (text, y, size, color) => {
        if (!text) return;
        g.textAlign = 'center'; g.fillStyle = color; g.font = `800 ${size * k}px system-ui, sans-serif`;
        const wide = g.measureText(text).width / (w * .94); // a long line (a success text) is drawn smaller, never cut
        if (wide > 1) g.font = `800 ${size * k / wide}px system-ui, sans-serif`;
        g.shadowBlur = 10 * k; g.fillText(text, w / 2, y); g.textAlign = 'left';
      };
      // labels pinned to the world (objective markers, enemy tags) and the crosshair, where the DOM put them
      const box = src.getBoundingClientRect();
      g.textAlign = 'center';
      for (const node of document.querySelectorAll('#floats .float')) {
        if (node.hidden || !node.textContent) continue;
        const r = node.getBoundingClientRect();
        const x = r.left + r.width / 2 - box.left, y = r.top - box.top;
        g.font = `700 ${12 * k}px system-ui, sans-serif`;
        const tw = g.measureText(node.textContent).width;
        g.shadowBlur = 0;
        g.fillStyle = 'rgba(20,24,28,.72)';
        g.fillRect(x - tw / 2 - 8 * k, y, tw + 16 * k, r.height);
        g.fillStyle = '#fff';
        g.fillText(node.textContent, x, y + (r.height - 12 * k) / 2);
      }
      g.textAlign = 'left';
      if (!document.getElementById('crosshair').hidden) {
        g.strokeStyle = spec.palette.accent; g.lineWidth = 2;
        const cx = w / 2, cy = h / 2, a = 6 * k, b = 12 * k;
        g.beginPath();
        g.moveTo(cx - b, cy); g.lineTo(cx - a, cy); g.moveTo(cx + a, cy); g.lineTo(cx + b, cy);
        g.moveTo(cx, cy - b); g.lineTo(cx, cy - a); g.moveTo(cx, cy + a); g.lineTo(cx, cy + b);
        g.stroke();
      }
      center(txt('notice'), 150 * k, document.getElementById('notice').classList.contains('big') ? 64 : 16, '#fff'); // (big: a countdown)
      const say = document.getElementById('say');
      if (say && !say.hidden) center(`${say.querySelector('b').textContent}: ${say.querySelector('span').textContent}`, h - 140 * k, 16, '#fff');
      if (!end.hidden) { // the end card as the page shows it: its title, why, and the result
        g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(0, 0, w, h);
        center($('end-title').textContent, h / 2 - 70 * k, 56, '#fff');
        center(txt('end-reason'), h / 2 + 8 * k, 22, '#fff');
        center(txt('end-result'), h / 2 + 46 * k, 19, spec.palette.accent);
      }
      if (pause.on) { // a pause on air (a play window that does not mark its game ?nopause=1): the viewers are told why the picture stands
        g.fillStyle = 'rgba(0,0,0,.45)'; g.fillRect(0, 0, w, h);
        center('일시정지', h / 2 - 28 * k, 48, '#fff');
      }
      g.shadowBlur = 0;
      requestAnimationFrame(draw);
    };
    draw();
    return capture;
  };

  if (autoplay) {
    // ponytail: SF and authored modes (they expose autoGoal / debugFacePoint / debugFaceNearest); v1 RPG modes just stand and swing.
    let t = 0;
    let best = Infinity, stuck = 0, detour = 0, side = 'KeyA';
    let watch = null, waited = 0, played = 0, jumped = false;
    const hold = (code, on) => dispatchEvent(new KeyboardEvent(on ? 'keydown' : 'keyup', { code, bubbles: true }));
    // Why the built-in player ended a round: the end card's reason line (해요체, as the card's other lines). The texts
    // are kept in this block: the race tests run the block on its own, with boot()'s names only.
    const BOT_END = { cap: '자동 플레이 시간이 다 돼서 이번 판을 마쳐요.', stuck: '진행이 멈춰서 이번 판을 마쳐요.' };
    const stop = (why) => { stalled = true; mode.failure = why; mode.end ? mode.end(false) : hud.end(false); hud.notice(why); };
    setInterval(() => {
      // the briefing never waits for a click here: started again while it still shows (the first start can be missed)
      waited = mode?.phase === 'ready' && startReady && !ended && !building ? waited + 1 : 0;
      if (waited % 12 === 11) briefingStart?.onclick?.();
      // the watchdog (authored worlds): no progress for 10 s of play → unstick; for 40 s → the round ends as a loss
      if (mode?.progressKey && !ended && mode.phase === 'playing') {
        const w = roundWatch(watch, mode.progressKey(), mode.elapsed);
        watch = w.state;
        if (w.action === 'unstick') { mode.autoUnstick?.(); detour = 15; side = side === 'KeyA' ? 'KeyD' : 'KeyA'; }
        if (w.action === 'end') stop(BOT_END.stuck);
      } else watch = null;
      // a mode with no time limit of its own (v1 RPG): its round still ends after the cap (interval time)
      played = mode && !ended && mode.phase !== 'ready' ? played + .08 : 0;
      if (played > AUTOPLAY_ROUND_SEC && !(mode.timeLimit > 0) && !botCap) { played = 0; stop(BOT_END.cap); }
      // a mode with a round clock: the cap build() keeps for it, by that clock
      if (botCap && mode && !ended && mode.elapsed >= botCap) stop(BOT_END.cap);
      if (!mode || ended || mode.selfDriven) return; // arpg drives its own built-in player (arpg.js)
      t += 1;
      // collect / reach: walk to the goal and fire only at enemies that come close; otherwise fight and strafe
      const goal = mode.autoGoal?.();
      const near = (p) => p.distanceTo(mode.player.pos) < 9;
      const threat = mode.drones?.some((d) => near(d.center)) ?? mode.enemies?.some((e) => near(e.pos));
      if (goal && !(threat && t % 30 < 12)) {
        const dist = mode.debugFacePoint(goal);
        // stuck against a wall (no progress for ~1.6 s): side-step around it for ~1.2 s, alternating sides
        if (dist < best - 0.3) { best = dist; stuck = 0; } else stuck += 1;
        if (stuck > 20) { detour = 15; side = side === 'KeyA' ? 'KeyD' : 'KeyA'; stuck = 0; best = dist; }
        if (mode.autoClimb) detour = 0; // a side-step on a sky climb walks off the island
        if (detour > 0) detour -= 1;
        hold('KeyF', false);
        hold('KeyS', false); // (a step back from a boss's blow, below, ends with the fight)
        hold('KeyA', detour > 0 && side === 'KeyA');
        hold('KeyD', detour > 0 && side === 'KeyD');
        hold('KeyW', dist > 0.6 && !mode.autoStop);
        hold('KeyE', !!mode.autoInteract && dist < 2.5); // talk / interact: held at the target
        // the sky climb (authored.js debugFacePoint): a tap of Space at the edge, released on the next tick
        jumped = !!mode.autoJump && !jumped;
        hold('Space', jumped);
        if (dist <= 0.6) best = Infinity; // reached: the next goal starts fresh
        return;
      }
      best = Infinity;
      mode.debugFaceNearest?.();
      hold('KeyF', true);
      hold('KeyE', false);
      if (jumped) { jumped = false; hold('Space', false); }
      const strafe = ['KeyA', 'KeyD'][Math.floor(t / 25) % 2];
      hold('KeyA', strafe === 'KeyA');
      hold('KeyD', strafe === 'KeyD');
      // a boss's blow is told a second ahead and lands only within its reach: the built-in player backs out of it, as
      // the game asks of a person (authored.js autoDodge). No boss, no change
      const dodge = !!mode.autoDodge?.();
      hold('KeyW', !dodge && t % 60 < 20);
      hold('KeyS', dodge);
    }, 80);
  }

  if (dev) {
    window.__g3d = {
      state: () => (mode ? { ...mode.debugState(), ended, endText: end.hidden ? null : $('end-title').textContent, fps: world.fps?.value ?? null } : null),
      faceNearest: () => mode?.debugFaceNearest?.() ?? false,
      teleport: (x, z, y) => mode?.debugTeleport?.(x, z, y),
      stage: () => mode?.debugStage?.() ?? null,
      press: (code, ms = 120) => { // synthesize a key tap the Input class sees
        dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
        setTimeout(() => dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true })), ms);
      },
      hold: (code, on) => dispatchEvent(new KeyboardEvent(on ? 'keydown' : 'keyup', { code, bubbles: true })),
      freeze: (on) => { frozen = on; clock.getDelta(); },
      mode: () => mode, // (dev/qa-round20.mjs brings a round to its end with it)
      world: Object.assign(world, { THREE }),
    };
    if (query.get('test')) import('./dev/autotest.js');
  }
}

boot().catch((error) => {
  console.error(error);
  document.querySelector('.briefing')?.remove();
  showErrors([`제작된 게임 데이터를 실행할 수 없습니다: ${error.message}`]);
});
