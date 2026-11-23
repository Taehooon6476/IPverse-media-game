// Pure combat rules (no three.js) so Node tests can import them: ARPG rarities, XP curve and item rolls (arpg.js),
// and the enemy balance of authored worlds (authored.js): blows by tier and stage, attack slots, i-frames, toughness.
export const RARITIES = [
  { id: 'common', name: '일반', color: '#d8d8d8', weight: 60, mult: 1 },
  { id: 'magic', name: '마법', color: '#5d8dff', weight: 28, mult: 1.6 },
  { id: 'rare', name: '희귀', color: '#ffd23f', weight: 10, mult: 2.4 },
  { id: 'legendary', name: '전설', color: '#ff8a1f', weight: 2, mult: 3.6 },
];
export const SLOTS = {
  weapon: { label: '무기', names: ['검', '전투 도끼', '대검', '룬블레이드'] },
  armor: { label: '갑옷', names: ['가죽 갑옷', '사슬 갑옷', '판금 갑옷', '용비늘 갑옷'] },
  ring: { label: '반지', names: ['구리 반지', '은 반지', '룬 반지', '혼돈의 반지'] },
};
export const SWING_SEC = .36;
export const COMBO_RESET_SEC = .9;

/** XP needed to go from `level` to `level + 1`. */
export const xpFor = (level) => Math.round(60 * level ** 1.5);

export function rollRarity(rnd, boss = false) {
  const pool = boss ? RARITIES.slice(2) : RARITIES;
  let t = rnd() * pool.reduce((n, r) => n + r.weight, 0);
  for (const r of pool) { t -= r.weight; if (t <= 0) return r; }
  return pool[pool.length - 1];
}

/** A random item for a monster of the player's level: weapon → +damage, armor → damage taken fraction, ring → crit. */
export function rollItem(rnd, level, boss = false) {
  const slot = Object.keys(SLOTS)[Math.floor(rnd() * 3)];
  const rarity = rollRarity(rnd, boss);
  const tier = RARITIES.indexOf(rarity);
  const value = slot === 'weapon' ? Math.max(1, Math.round((1 + level * .6) * rarity.mult))
    : slot === 'armor' ? Math.min(.6, +(.035 * (1 + level * .25) * rarity.mult).toFixed(3))
      : Math.min(.35, +(.025 * rarity.mult).toFixed(3));
  return { slot, rarity: rarity.id, value, name: `${rarity.name} ${SLOTS[slot].names[tier]}` };
}

export const better = (item, worn) => !worn || item.value > worn.value;

export function itemLine(item) {
  if (item.slot === 'weapon') return `피해 +${item.value}`;
  if (item.slot === 'armor') return `받는 피해 −${Math.round(item.value * 100)}%`;
  return `치명타 +${Math.round(item.value * 100)}%`;
}

// ── enemy balance in authored worlds ──────────────────────────────────────────
// Per spec.difficulty: the blow multiplier, how many enemies may wind up an attack at the same time (the rest keep
// closing in; a boss never waits) and the hero's invulnerability after a hit.
export const BALANCE = {
  easy: { damage: .7, slots: 1, iframes: 1.25 },
  normal: { damage: .85, slots: 2, iframes: 1 },
  hard: { damage: 1.1, slots: 3, iframes: .75 },
};
const BLOW = { regular: 7, champion: 14, boss: 20 }; // one melee blow in the first stage, before difficulty
const CAP = { regular: .08, champion: .12, boss: .16 }; // and never more than this share of the hero's max HP

/** One enemy blow: by tier, +10% per stage, ×0.75 for a ranged bolt, ×1.2 enraged, capped against the hero's HP. */
export function enemyHit({ tier = 'regular', ranged = false, stage = 0, maxHp = 100, difficulty = 'normal', enraged = false } = {}) {
  const tune = BALANCE[difficulty] ?? BALANCE.normal;
  const raw = (BLOW[tier] ?? BLOW.regular) * (ranged ? .75 : 1) * (1 + .1 * stage) * tune.damage * (enraged ? 1.2 : 1);
  return Math.max(1, Math.round(Math.min(raw, maxHp * (CAP[tier] ?? CAP.regular))));
}

/** Enemies that may wind up at once: an ARPG horde gets two more slots (its blows are small). */
export const attackSlots = (difficulty, arpg = false) => (BALANCE[difficulty] ?? BALANCE.normal).slots + (arpg ? 2 : 0);

/** HP of a boss or an elite against the hero's damage per second: it lasts about `seconds` of steady hits. */
export const toughness = (base, dps, seconds) => Math.max(base, Math.round(dps * seconds));

/**
 * Motion of a flat cutout enemy (an IP without a rig), all within its own plane so it reads from any camera angle:
 * a hop and sway at its walking pace, a crouch and lean back while it winds up, a lunge at the hero as it strikes,
 * a flash when hit. windup and strike run 0→1, hit 1→0. → { lift, tilt, squash, lunge, flash }: lift and lunge in
 * actor heights, tilt in radians towards the hero's side of the screen.
 */
export function billboardPose({ time = 0, speed = 0, windup = 0, strike = 0, hit = 0 } = {}) {
  const walking = Math.min(1, speed / 1.5), step = time * (4 + speed * 1.6), arc = Math.sin(strike * Math.PI);
  return {
    lift: Math.abs(Math.sin(step)) * .05 * walking,
    tilt: Math.sin(step) * .08 * walking + Math.sin(time * 1.7) * .02 * (1 - walking) - windup * .16 + arc * .26 - hit * .14,
    squash: (1 - Math.abs(Math.sin(step))) * .05 * walking + windup * .14 - arc * .1,
    lunge: arc * .35,
    flash: hit,
  };
}

// ── fair play around the hero (authored worlds) ───────────────────────────────
/** 다시 시작 at a checkpoint: the hero blinks invulnerable this long, and for RESUME_SAFE_SEC the stage's enemies appear
 * no closer than RESUME_CLEARANCE (a restart never opens next to a blow already winding up). Any other time an enemy
 * appears no closer than SPAWN_CLEARANCE. */
export const RESUME_GRACE_SEC = 3;
export const RESUME_SAFE_SEC = 6;
export const RESUME_CLEARANCE = 12;
export const SPAWN_CLEARANCE = 6;

/** Where an enemy placement appears: where it is when at least `radius` from the hero, else `radius` away along the
 * hero→placement bearing (or the nearest bearing, in 30° steps, that stays inside `bounds`). → {x, z} */
export function clearSpawn(point, hero, radius, bounds = null) {
  const dx = point.x - hero.x, dz = point.z - hero.z;
  if (Math.hypot(dx, dz) >= radius) return { x: point.x, z: point.z };
  const bearing = Math.hypot(dx, dz) > 1e-6 ? Math.atan2(dz, dx) : 0;
  const inside = (p) => !bounds || (p.x >= bounds.minX && p.x <= bounds.maxX && p.z >= bounds.minZ && p.z <= bounds.maxZ);
  let first = null;
  for (let k = 0; k <= 12; k++) { // 0, +30°, -30°, +60°, … 180°
    const a = bearing + Math.ceil(k / 2) * (k % 2 ? 1 : -1) * Math.PI / 6;
    const at = { x: hero.x + Math.cos(a) * radius, z: hero.z + Math.sin(a) * radius };
    if (inside(at)) return at;
    first ??= at;
  }
  return { x: Math.min(bounds.maxX, Math.max(bounds.minX, first.x)), z: Math.min(bounds.maxZ, Math.max(bounds.minZ, first.z)) };
}

/** Aim assist for a shot the player aims down `yaw` (looking along (-sin yaw, -cos yaw)) from `from`: the enemy
 * nearest the crosshair line within `cone` radians (a boss 1.5×) and `range` metres, in front. → its index, or -1. */
export const ASSIST = { cone: .2, range: 40 };
export function assistTarget(from, yaw, enemies, { cone = ASSIST.cone, range = ASSIST.range } = {}) {
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  let best = -1, bestAngle = Infinity;
  enemies.forEach((e, i) => {
    const dx = e.x - from.x, dz = e.z - from.z, along = dx * fx + dz * fz;
    if (along <= .3 || Math.hypot(dx, dz) > range) return;
    const angle = Math.atan2(Math.abs(dx * fz - dz * fx), along);
    if (angle <= cone * (e.boss ? 1.5 : 1) && angle < bestAngle) { best = i; bestAngle = angle; }
  });
  return best;
}

/** Auto-fire aims on the hero's behalf but shoots at 1/AUTO_FIRE_SLOW of the aimed rate, while a boss still lasts its
 * seconds of the hero's aimed rate (toughness): a hero who only stands while the crossbow works is outlasted, one who
 * steps out of the telegraphed blows and bolts wins. */
export const AUTO_FIRE_SLOW = 1.6;
export const fireInterval = (mechanics, automatic = false) => mechanics.fireIntervalSec * (automatic ? AUTO_FIRE_SLOW : 1);

/** The low edge a wall keeps under the ARPG's camera (authored.js edge). That camera is fixed, high on one side, and
 * whatever stands between it and the hero is faded to under half (world.js fadeOccluders): the edge keeps a faded
 * wall readable as a wall. `box`: a wall's collider ({min, max}), which is what stops the hero. → the box to draw
 * {x, y, z: its middle, width, height, depth}: the collider's footprint, EDGE.proud wider all round (so it is no face
 * of the wall itself), EDGE.height high; or null for what is no wall standing on the floor (a beam overhead, a slab
 * no higher than the edge). */
export const EDGE = { height: .45, proud: .03 };
export function wallEdge(box) {
  if (box.min.y > .05 || box.max.y - box.min.y <= EDGE.height) return null;
  return { x: (box.min.x + box.max.x) / 2, y: box.min.y + EDGE.height / 2, z: (box.min.z + box.max.z) / 2,
    width: box.max.x - box.min.x + 2 * EDGE.proud, height: EDGE.height, depth: box.max.z - box.min.z + 2 * EDGE.proud };
}

// ---- the page's own words and where they sit (authored.js, runtime3d.js) ----

/** Where a HUD label centred at (x, y) goes so that it covers none of `boxes` ({left, top, right, bottom}, the same
 * pixels): out of a box it would sit on, straight up or down, to the side of the height `mid` (the screen's middle).
 * `half`: half the label's own size. → {x, y} */
export function clearOf(x, y, boxes, mid, half = { w: 48, h: 12 }) {
  for (const b of boxes) {
    if (x < b.left - half.w || x > b.right + half.w || y < b.top - half.h || y > b.bottom + half.h) continue;
    y = (b.top + b.bottom) / 2 < mid ? b.bottom + half.h : b.top - half.h;
  }
  return { x, y };
}

/** A round's time as the HUD and the end screen write it: m:ss, with tenths for a race ("0:30.2"). */
export function clock(seconds, tenths = false) {
  const t = tenths ? Math.round(Math.max(0, seconds) * 10) / 10 : Math.floor(Math.max(0, seconds)), min = Math.floor(t / 60);
  return `${min}:${tenths ? (t - min * 60).toFixed(1).padStart(4, '0') : String(t - min * 60).padStart(2, '0')}`;
}

/** The end screen's words (runtime3d.js hud.end): why the round ended, its result, and what 다시 시작 does.
 * `summary`: the mode's endSummary(won) ({ reason, result: [...], resumeStage }) or null; `failure`: a reason that
 * comes first on a loss (a race lost on place, the built-in player's cap and watchdog, a load failure); `keys`: the
 * device has a keyboard. → { title, reason, result, next }, '' where the card has nothing to say. A playable ad's
 * round only tells its numbers: the ad's page says what comes next. */
export function endCard({ won, playable = false, timeout = false, failure = null, summary = null, keys = true }) {
  const title = playable ? '체험 종료 · 전체 게임에서 이어서 즐기세요' : won ? '클리어!' : '게임 오버';
  const result = (summary?.result ?? []).join(' · ');
  if (playable) return { title, reason: '', result, next: '' };
  const reason = won ? summary?.reason ?? '' : failure ?? summary?.reason ?? (timeout ? '제한 시간이 끝났어요.' : '체력이 다했어요.');
  return { title, reason, result, next: `${restartLine(summary?.resumeStage)}${keys ? ' Enter 키를 눌러도 돼요.' : ''}` };
}
/** What 다시 시작 does, as the end card and the pause card say it: the round goes on from the checkpoint's stage
 * (`resumeStage`, counted from 0), or starts over when there is none. */
export const restartLine = (resumeStage) => (resumeStage > 0 ? `${resumeStage + 1}단계부터 이어서 해요.` : '처음부터 다시 해요.');

/** Whether a key pressed on the end card counts as its 다시 시작 (runtime3d.js onKey): not in the card's first
 * END_KEYS_MS, and never a key still held down from the round (`repeat`). Space jumps and Enter passes the story box,
 * so a person is still pressing them as the round ends. `sinceMs`: how long the card has been up. */
export const END_KEYS_MS = 800;
export const endKey = (sinceMs, repeat = false) => !repeat && sinceMs >= END_KEYS_MS;

/** What a first visit downloads, counted for the loading screen (world.js loads through it, runtime3d.js shows it).
 * A file is counted from when it is asked for: its bytes as they arrive and its size once the server says it, or
 * ahead of the download (expect). `onchange` is called whenever a number moves. */
export class LoadMeter {
  constructor() { this.files = new Map(); this.onchange = null; }
  file(url) {
    if (!this.files.has(url)) this.files.set(url, { loaded: 0, total: 0, done: false });
    return this.files.get(url);
  }
  /** The size (bytes) of a file that will be loaded, learnt ahead of it. */
  expect(url, total) {
    const file = this.file(url);
    if (file.done || !(total > 0)) return;
    file.total = total;
    this.onchange?.();
  }
  /** A file being loaded: `load(onProgress)` is a three.js loader's loadAsync for it (its progress events carry the
   * bytes). → load's own promise */
  watch(url, load) {
    const file = this.file(url);
    const progress = (event) => {
      if (event?.loaded >= 0) file.loaded = event.loaded;
      if (event?.total > 0) file.total = event.total;
      this.onchange?.();
    };
    const done = () => { file.done = true; file.loaded = file.total || file.loaded; this.onchange?.(); };
    return load(progress).finally(done);
  }
  /** → { loaded, total: bytes (a file whose size is not known counts what has arrived of it), files, done: counts } */
  get state() {
    let loaded = 0, total = 0, done = 0;
    for (const file of this.files.values()) {
      const size = file.total || file.loaded;
      loaded += Math.min(file.loaded, size); total += size; done += file.done ? 1 : 0;
    }
    return { loaded, total, files: this.files.size, done };
  }
}

/** The loading screen's words for the meter's state and what boot() is at (`phase`: engine | hero | world | frame).
 * `sized`: the sizes asked ahead are in. Until then the total is only what has been asked for so far: the megabytes
 * received are told alone. The figure says 100 only at boot()'s last step. `shown`: the highest figure the screen has
 * shown: the figure never goes back. A figure of 99 while the world is built is not told: the step is named in its
 * place (that step waits for files not sized ahead: the setting's kit, textures, the backdrop, the cutouts).
 * → { percent (null: no figure), text, what: the phase in words, bytes: "18.2 / 30.3MB" } */
export function loadLine({ loaded, total }, phase, sized = true, shown = 0) {
  const mb = (bytes) => (bytes / 1048576).toFixed(1);
  const percent = !sized || !(total > 0) ? null : phase === 'frame' ? 100 : Math.max(shown, Math.min(99, Math.floor(100 * loaded / total)));
  const what = { engine: '게임 엔진을 받고 있어요', hero: '캐릭터를 받고 있어요', world: '세계를 만들고 있어요', frame: '첫 화면을 준비하고 있어요' }[phase] ?? '';
  const figure = percent == null ? '' : phase === 'world' && percent >= 99 ? ' 장면 준비 중' : ` ${percent}%`;
  return { percent, text: `게임 불러오는 중…${figure}`, what,
    bytes: !(total > 0) ? '' : sized ? `${mb(loaded)} / ${mb(total)}MB` : `${mb(loaded)}MB` };
}

/** A device with no keyboard to play on, told by its primary input: a finger (pointer: coarse) that cannot hover
 * (hover: none): a phone, a tablet. A laptop with a touch screen is played on: its primary pointer is fine. `match`:
 * the page's matchMedia. The games take the keyboard and the mouse only (no touch controls): the page tells such a
 * device (KEYLESS_NOTE). Not "no fine pointer anywhere": a phone's pen digitizer is one. A tablet with a keyboard on
 * it is told too, until its first key press (runtime3d.js takes the notice back). */
export const keylessDevice = (match) => match('(pointer: coarse)').matches && match('(hover: none)').matches;
export const KEYLESS_NOTE = '이 게임은 키보드와 마우스로 플레이해요. PC에서 열어 주세요.';

/** What a pause may do on this page (runtime3d.js makePause) → { manual: Esc and P open the pause card, auto: leaving
 * the window or the tab opens it }. The round's clocks stand while the card is up.
 * - ?autoplay=1, the built-in player of a broadcast: nothing. A broadcast must go on.
 * - ?playable=, a playable ad: nothing. The trial's clock is the ad page's and its cloud seat is held by the second.
 *   The keys are in the line under the game.
 * - ?nopause=1, a person at the keys of a broadcast's play window: nothing. A paused round sends the viewers a
 *   standing picture and holds back the round ends the ads wait for. Not told by ?noads=1: the cloud stream loads
 *   that too.
 * - ?noads=1 alone, the cloud stream: their own pause only. The stream's page loses the focus as its viewer uses the
 *   page around it.
 * - a game opened by its link or in the studio's preview: all of it. */
export function pauseRules({ autoplay = false, playable = false, noAds = false, noPause = false } = {}) {
  if (autoplay || playable || noPause) return { manual: false, auto: false };
  return { manual: true, auto: !noAds };
}

/** The keys a game really takes, for the briefing, the hint line under the game and the pause card (runtime3d.js).
 * `spec`: a validated spec; `pause`: the page can be paused. → [{ label, keys: the key caps, any: the keys are
 * alternatives (else all of them belong to the label) }]. No camera keys for an ARPG (arpg.js holds its camera) or
 * a race (W/S sit on the arrow keys there, and the camera follows the car). */
export function controlsFor(spec, { pause = false } = {}) {
  const sf = spec.genre.startsWith('sf-'), authored = spec.version === 2, m = (authored && spec.mechanics) || {};
  const city = authored && !!spec.world?.city, track = authored && !!spec.world?.track, arpg = m.style === 'arpg';
  const key = (label, keys, any = false) => ({ label, keys, any });
  const list = [];
  if (track) list.push(key('가속', ['W']), key('후진', ['S']), key('좌우 방향', ['A', 'D']), key('브레이크', ['Space']));
  else {
    list.push(key('이동', ['W', 'A', 'S', 'D']));
    // (an sf game takes the mouse on its first click, world.js pointerLockWanted: it turns the view without a drag)
    if (!arpg) list.push(key('시점', [sf ? '마우스' : '마우스 드래그', '방향키'], true));
    if (m.sprint !== false) list.push(key('달리기', ['Shift']));
    if (m.jump !== false) list.push(key('점프', ['Space']));
    if (m.dash !== false) list.push(key('대시', ['Q']));
    if (arpg) list.push(key('연속 베기', ['마우스 클릭', 'F'], true), key('회오리 베기 (Lv 3)', ['R']), key('물약', ['1']));
    else if (!authored) list.push(key(sf ? '사격' : '공격', ['마우스 클릭', 'F'], true)); // (a label is a word or two: its row is narrow)
    else if (spec.enemies.length || spec.player.weaponUrl || m.autoFire === true) list.push(key('공격', ['마우스 클릭', 'F'], true));
    const stages = authored ? spec.mission.stages : [];
    const talk = stages.some((s) => s.type === 'talk') || (!authored && !sf), use = stages.some((s) => s.type === 'interact');
    if (talk || use) list.push(key([talk && '대화', use && '상호작용'].filter(Boolean).join(' · '), ['E']));
    if (city) list.push(key('차 타고 내리기', ['E']), key('운전', ['W', 'A', 'S', 'D']), key('브레이크', ['Space']));
  }
  if (pause) list.push(key('일시정지', ['Esc']));
  return list;
}
/** The same keys as one line (the hint under the game): "이동 W A S D · 시점 마우스 드래그/방향키 · …". */
export const controlsLine = (list) => list.map((c) => `${c.label} ${c.keys.join(c.any ? '/' : ' ')}`).join(' · ');

// ---- the built-in player (?autoplay=1, the live broadcast): a way around walls, and a round watchdog ----

/** A walk grid over the world: cells (`cell` metres) whose centre lies within `radius` of a blocking footprint
 * ({minX, maxX, minZ, maxZ}) are walls. Big worlds get coarser cells (at most 160 a side). */
export function navGrid(rects, { width, depth }, { radius = .5, cell = 1 } = {}) {
  cell = Math.max(cell, Math.max(width, depth) / 160);
  const minX = -width / 2, minZ = -depth / 2;
  const w = Math.ceil(width / cell), h = Math.ceil(depth / cell);
  const blocked = new Uint8Array(w * h);
  for (const r of rects) {
    const i0 = Math.max(0, Math.floor((r.minX - radius - minX) / cell)), i1 = Math.min(w - 1, Math.floor((r.maxX + radius - minX) / cell));
    const j0 = Math.max(0, Math.floor((r.minZ - radius - minZ) / cell)), j1 = Math.min(h - 1, Math.floor((r.maxZ + radius - minZ) / cell));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = minX + (i + .5) * cell, z = minZ + (j + .5) * cell;
      const dx = x - Math.max(r.minX, Math.min(r.maxX, x)), dz = z - Math.max(r.minZ, Math.min(r.maxZ, z));
      if (dx * dx + dz * dz < radius * radius) blocked[j * w + i] = 1;
    }
  }
  return { cell, minX, minZ, w, h, blocked };
}

const cellOf = (g, p) => [Math.max(0, Math.min(g.w - 1, Math.floor((p.x - g.minX) / g.cell))),
  Math.max(0, Math.min(g.h - 1, Math.floor((p.z - g.minZ) / g.cell)))];
const free = (g, i, j) => i >= 0 && j >= 0 && i < g.w && j < g.h && !g.blocked[j * g.w + i];

/** The nearest walkable cell to (i, j) (a hero or a goal inside a wall's margin), or null. */
function nearestFree(g, i, j) {
  for (let r = 0; r <= 6; r++) for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
    if (Math.max(Math.abs(di), Math.abs(dj)) === r && free(g, i + di, j + dj)) return [i + di, j + dj];
  }
  return null;
}

/** A* over the grid from `from` to `to` ({x, z}), 8-way without cutting wall corners. → [{x, z}, …] ending at `to`,
 * or null when no way leads there. */
export function navPath(g, from, to) {
  const s = nearestFree(g, ...cellOf(g, from)), t = nearestFree(g, ...cellOf(g, to));
  if (!s || !t) return null;
  const start = s[1] * g.w + s[0], goal = t[1] * g.w + t[0];
  // Costs in doubles, as they are queued and compared: a cost read back from 32 bits is not the one queued, the
  // entry then looks stale and the search stops there (ways not found, or longer than the shortest)
  const cost = new Float64Array(g.w * g.h).fill(Infinity), prev = new Int32Array(g.w * g.h).fill(-1);
  const open = [[0, start]];
  cost[start] = 0;
  while (open.length) {
    let best = 0;
    for (let n = 1; n < open.length; n++) if (open[n][0] < open[best][0]) best = n;
    const [f, k] = open[best];
    open[best] = open[open.length - 1]; open.pop();
    if (k === goal) break;
    const i = k % g.w, j = Math.floor(k / g.w);
    if (f - Math.hypot(i - t[0], j - t[1]) > cost[k] + 1e-6) continue; // a stale entry
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if ((!di && !dj) || !free(g, i + di, j + dj) || (di && dj && (!free(g, i + di, j) || !free(g, i, j + dj)))) continue;
      const n = k + dj * g.w + di, c = cost[k] + (di && dj ? Math.SQRT2 : 1);
      if (c >= cost[n]) continue;
      cost[n] = c; prev[n] = k; open.push([c + Math.hypot(i + di - t[0], j + dj - t[1]), n]);
    }
  }
  if (cost[goal] === Infinity) return null;
  const path = [];
  for (let k = goal; k !== start; k = prev[k]) path.push({ x: g.minX + (k % g.w + .5) * g.cell, z: g.minZ + (Math.floor(k / g.w) + .5) * g.cell });
  path.reverse();
  path[Math.max(0, path.length - 1)] = { x: to.x, z: to.z };
  return path;
}

/** The nearest of `goals` ({x, z}) by the way on foot from `from`, and that way: one search outward from `from` over
 * the grid's walkable cells (Dijkstra; 8-way without cutting wall corners, as navPath), stopped at the first goal it
 * reaches. For the goal arrow of a person's round (authored.js arrowWay), which asks every half second: navPath's
 * own search is too slow for that. → { index, path: [{x, z}, …] ending at goals[index] }, or null when no way leads
 * to any of them. */
export function navNearest(g, from, goals) {
  const s = nearestFree(g, ...cellOf(g, from));
  const want = new Map(); // a cell → the first goal that stands in it
  goals.forEach((goal, index) => {
    const t = nearestFree(g, ...cellOf(g, goal));
    if (t && !want.has(t[1] * g.w + t[0])) want.set(t[1] * g.w + t[0], index);
  });
  if (!s || !want.size) return null;
  const start = s[1] * g.w + s[0];
  // (costs in doubles: a cost read back from 32 bits is not the one that was queued, and the entry looks stale)
  const cost = new Float64Array(g.w * g.h).fill(Infinity), prev = new Int32Array(g.w * g.h).fill(-1);
  const heap = [[0, start]]; // a binary heap of [cost, cell], the least on top
  const push = (item) => {
    let n = heap.push(item) - 1;
    for (let up = (n - 1) >> 1; n > 0 && heap[up][0] > item[0]; n = up, up = (n - 1) >> 1) heap[n] = heap[up];
    heap[n] = item;
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    for (let n = 0, k = 1; heap.length; n = k, k = 2 * n + 1) {
      if (k + 1 < heap.length && heap[k + 1][0] < heap[k][0]) k += 1;
      if (k >= heap.length || heap[k][0] >= last[0]) { heap[n] = last; break; }
      heap[n] = heap[k];
    }
    return top;
  };
  cost[start] = 0;
  let found = -1;
  while (heap.length && found < 0) {
    const [c, k] = pop();
    if (c > cost[k]) continue; // a stale entry
    if (want.has(k)) { found = k; break; }
    const i = k % g.w, j = Math.floor(k / g.w);
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if ((!di && !dj) || !free(g, i + di, j + dj) || (di && dj && (!free(g, i + di, j) || !free(g, i, j + dj)))) continue;
      const n = k + dj * g.w + di, next = c + (di && dj ? Math.SQRT2 : 1);
      if (next >= cost[n]) continue;
      cost[n] = next; prev[n] = k; push([next, n]);
    }
  }
  if (found < 0) return null;
  const index = want.get(found), path = [];
  for (let k = found; k !== start; k = prev[k]) path.push({ x: g.minX + (k % g.w + .5) * g.cell, z: g.minZ + (Math.floor(k / g.w) + .5) * g.cell });
  path.reverse();
  path[Math.max(0, path.length - 1)] = { x: goals[index].x, z: goals[index].z };
  return { index, path };
}

/** Whether the straight walk from a to b stays on walkable cells. */
export function navClear(g, a, b) {
  const steps = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / (g.cell / 3));
  for (let n = 1; n <= steps; n++) {
    if (!free(g, ...cellOf(g, { x: a.x + (b.x - a.x) * n / steps, z: a.z + (b.z - a.z) * n / steps }))) return false;
  }
  return true;
}

/** Where to walk now on `path`: the furthest of its next points still in a clear straight line. */
export function navNext(g, from, path) {
  let best = path[0];
  for (let n = 1; n < Math.min(path.length, 12); n++) if (navClear(g, from, path[n])) best = path[n]; else break;
  return best;
}

/** The round watchdog of the built-in player. `key` is the round's progress (stage, counts, damage dealt, the closest
 * it has come to its goal); while it stays the same the round is stalled: after `unstickSec` it asks once for an
 * unstick, after `limitSec` it ends the round as a loss, so a broadcast's "ad every N rounds" keeps coming. */
export const WATCHDOG = { unstickSec: 10, limitSec: 40 };
export function roundWatch(state, key, now, { unstickSec = WATCHDOG.unstickSec, limitSec = WATCHDOG.limitSec } = {}) {
  if (!state || state.key !== key) return { state: { key, since: now, unstuck: false }, action: null };
  const stalled = now - state.since;
  if (stalled >= limitSec) return { state, action: 'end' };
  if (stalled >= unstickSec && !state.unstuck) return { state: { ...state, unstuck: true }, action: 'unstick' };
  return { state, action: null };
}

/** The seconds a round's clock has left, in wall seconds (`now`, s): a game clock steps 1/20 s a frame at most, so on
 * a PC that draws fewer frames it runs behind the wall clock and the round ends later than its clock says (a
 * broadcast's ad break is timed by this). The pace is the clock's over the last `spanSec` or more. Never fewer
 * seconds than the clock says. → { state, seconds } */
export function wallSeconds(state, seconds, now, spanSec = 2) {
  let { a, b } = state ?? {};
  if (!a || seconds > a.s || now < a.t) a = b = { t: now, s: seconds }; // a new round's clock
  else if (now - b.t >= spanSec) { a = b; b = { t: now, s: seconds }; }
  const dt = now - a.t, pace = dt >= 1 ? (a.s - seconds) / dt : 1;
  return { state: { a, b }, seconds: pace > .5 && pace < 1 ? seconds / pace : seconds };
}

/** A round's end the game can only estimate (a race's last stretch at the car's pace): the estimate counts once it
 * has shrunk with the clock for `steadySec` (every sample of that time names the same end within `slackSec`), so a
 * car that slows (a bend it brakes for, a bump) takes it back until its new pace has held as long. A broadcast sends
 * an ad break by it that cannot be recalled, and an ad over the last metres of a race is worse than a late one.
 * `seconds`: the raw estimate or null; `now` in seconds. → { state, seconds: the estimate while it is steady, else null } */
export function steadyEstimate(state, seconds, now, { steadySec = 1.5, slackSec = .4 } = {}) {
  if (seconds == null) return { state: null, seconds: null };
  const end = now + seconds;
  const kept = (state ?? []).filter((p) => Math.abs(p.end - end) <= slackSec);
  const all = kept.length === (state ?? []).length ? [...kept, { t: now, end }] : [{ t: now, end }]; // a jump: over again
  // the samples of the last steadySec, and the newest one older than that
  const samples = all.filter((p, i) => now - p.t <= steadySec || !(now - all[i + 1]?.t >= steadySec));
  return { state: samples, seconds: now - samples[0].t >= steadySec - 1e-6 ? seconds : null };
}
