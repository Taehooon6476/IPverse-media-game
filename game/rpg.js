// RPG scene (rpg-explore, rpg-quest): seeded tile map, one-tile-per-keypress movement, an NPC to talk to,
// props to pick up, and roaming monsters from spec.enemies (touching one costs a life).
const T = 32;
const W = 960;
const H = 540;
const START = { x: 2, y: 2 };
const STEPS = {
  ArrowUp: [0, -1], KeyW: [0, -1], ArrowDown: [0, 1], KeyS: [0, 1],
  ArrowLeft: [-1, 0], KeyA: [-1, 0], ArrowRight: [1, 0], KeyD: [1, 0],
};
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const MONSTER_PACE = { easy: 1.4, normal: 1, hard: 0.7 }; // multiplies the step interval
const CHASE_RADIUS = { easy: 2, normal: 3, hard: 4 }; // tiles (Manhattan)
const START_GRACE_MS = 3000; // monsters stand still at the start of every run
const HURT_MS = 2000; // invulnerability after a hit; also how long the hitting monster rests
const KNOCKBACK_NEAR = 4; // if the player is this close to a monster's spawn, it flees elsewhere instead
const toColor = (hex) => parseInt(hex.slice(1), 16);
const center = (t) => [t.x * T + T / 2, t.y * T + T / 2];
const fit = (obj, h) => obj.setScale(h / obj.height);

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Floor tiles reachable from `from`, in BFS order with step distance d. `blocked` counts as a wall.
function reachable(walls, from, blocked) {
  const w = walls[0].length;
  const seen = new Set([from.y * w + from.x]);
  const out = [{ ...from, d: 0 }];
  for (const t of out) {
    for (const [dx, dy] of DIRS) {
      const x = t.x + dx;
      const y = t.y + dy;
      if (walls[y][x] || seen.has(y * w + x) || (blocked && x === blocked.x && y === blocked.y)) continue;
      seen.add(y * w + x);
      out.push({ x, y, d: t.d + 1 });
    }
  }
  return out;
}

// Where a monster that just hit the player goes: its spawn, unless the player is within KNOCKBACK_NEAR tiles of it;
// then the floor tile farthest (by steps) from the player that the player can reach, never a wall or the NPC tile.
export function knockbackTile(walls, npc, spawn, player) {
  if (Math.abs(spawn.x - player.x) + Math.abs(spawn.y - player.y) > KNOCKBACK_NEAR) return { x: spawn.x, y: spawn.y };
  const tiles = reachable(walls, player, npc);
  const { x, y } = tiles.reduce((best, t) => (t.d > best.d ? t : best));
  return { x, y };
}

export class RpgScene extends Phaser.Scene {
  constructor(spec, hud) {
    super('play');
    this.spec = spec;
    this.hud = hud;
  }

  preload() {
    const { player, props } = this.spec;
    if (player.spriteUrl) this.load.image('player', player.spriteUrl);
    props.forEach((p, i) => p.spriteUrl && this.load.image(`prop${i}`, p.spriteUrl));
  }

  create() {
    const { spec } = this;
    const { props, objective, quest } = spec;
    const { width: mw, height: mh } = spec.map;
    const rnd = mulberry32(spec.map.seed);
    const accent = toColor(spec.palette.accent);
    const ink = toColor(spec.palette.text);
    Object.assign(this, { pos: { ...START }, lives: 3, hurtUntil: 0, moving: false, lines: null, lineIndex: 0,
      heard: false, talkDone: false, hasItem: false, collected: 0, grace: true });

    // Border walls plus ~12% random walls, never inside the open 3x3 around the start.
    this.walls = Array.from({ length: mh }, (_, y) => Array.from({ length: mw }, (_, x) =>
      x === 0 || y === 0 || x === mw - 1 || y === mh - 1
      || ((Math.abs(x - START.x) > 1 || Math.abs(y - START.y) > 1) && rnd() < 0.12)));
    const g = this.add.graphics();
    this.walls.forEach((row, y) => row.forEach((wall, x) => {
      if (wall) g.fillStyle(accent, 0.35).fillRect(x * T, y * T, T, T);
      else g.fillStyle(ink, 0.05).fillRect(x * T + 1, y * T + 1, T - 2, T - 2);
    }));

    // NPC at least 6 steps away; items and monsters only where the player can walk around the NPC.
    const reach = reachable(this.walls, START);
    const far = reach.filter((t) => t.d >= 6);
    this.npc = far.length ? far[Math.floor(rnd() * far.length)] : reach[reach.length - 1];
    const free = reachable(this.walls, START, this.npc).slice(1);
    for (let i = free.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [free[i], free[j]] = [free[j], free[i]];
    }

    // Items: `collect` cycles through the props up to objective.target; `talk` places each prop once.
    // NPC sprite: the first loaded prop sprite that is neither the quest item nor the player's sprite; that prop
    // is then not placed. `collect` needs every prop as an item, so there (or with no match) it is an accent circle.
    const collect = objective.type === 'collect';
    this.needsItem = spec.genre === 'rpg-quest' && !collect && quest !== null;
    const questIndex = this.needsItem ? quest.itemPropIndex : -1;
    const npcProp = collect ? -1 : props.findIndex((p, i) =>
      i !== questIndex && p.spriteUrl !== spec.player.spriteUrl && this.textures.exists(`prop${i}`));
    const kinds = collect
      ? Array.from({ length: objective.target }, (_, i) => ({ prop: props.length ? i % props.length : -1 }))
      : props.map((_, i) => ({ prop: i, quest: i === questIndex })).filter((k) => k.prop !== npcProp);
    if (this.needsItem && !kinds.some((k) => k.quest)) kinds.push({ prop: -1, quest: true });
    this.itemName = quest?.itemName || props[questIndex]?.name || '퀘스트 아이템';
    this.items = new Map();
    for (const kind of kinds) {
      const tile = free.pop();
      if (!tile) break;
      const [x, y] = center(tile);
      const obj = this.textures.exists(`prop${kind.prop}`)
        ? fit(this.add.image(x, y, `prop${kind.prop}`), 24)
        : this.add.rectangle(x, y, 14, 14, accent).setAngle(45);
      this.tweens.add({ targets: obj, y: y - 3, yoyo: true, repeat: -1, duration: 700, ease: 'Sine.inOut' });
      this.items.set(tile.y * mw + tile.x, { ...kind, obj });
    }
    this.goal = collect ? this.items.size : 1;

    const [nx, ny] = center(this.npc);
    this.npcName = quest?.giverName || 'NPC';
    if (npcProp >= 0) fit(this.add.image(nx, ny, `prop${npcProp}`), 28);
    else this.add.circle(nx, ny, 13, accent);
    this.add.text(nx, ny - 24, this.npcName, { fontFamily: 'system-ui, sans-serif', fontSize: '12px', color: spec.palette.text })
      .setOrigin(0.5).setResolution(2);

    this.monsters = [];
    for (const enemy of spec.enemies) {
      const i = free.findIndex((t) => t.d >= 5);
      if (i < 0) break;
      const [tile] = free.splice(i, 1);
      const [x, y] = center(tile);
      const color = toColor(enemy.color);
      const obj = enemy.shape === 'circle' ? this.add.circle(x, y, 11, color)
        : enemy.shape === 'square' ? this.add.rectangle(x, y, 22, 22, color)
          : this.add.triangle(x, y, 0, 22, 22, 22, 11, 0, color);
      const monster = { x: tile.x, y: tile.y, spawn: { x: tile.x, y: tile.y }, restUntil: 0, obj };
      this.monsters.push(monster);
      this.time.addEvent({ delay: (900 / enemy.speed) * MONSTER_PACE[spec.difficulty], loop: true, callback: () => this.stepMonster(monster) });
    }

    const [px, py] = center(START);
    this.player = this.textures.exists('player') ? fit(this.add.image(px, py, 'player'), 28) : this.add.circle(px, py, 13, ink);
    const [vw, vh] = [mw * T, mh * T];
    this.cameras.main.setBounds(Math.min(0, (vw - W) / 2), Math.min(0, (vh - H) / 2), Math.max(vw, W), Math.max(vh, H));
    this.cameras.main.startFollow(this.player, true);

    this.input.keyboard.addCapture('UP,DOWN,LEFT,RIGHT,SPACE,W,A,S,D,E');
    this.input.keyboard.on('keydown', this.onKey, this);
    this.time.delayedCall(START_GRACE_MS, () => { this.grace = false; this.refreshHud(); });
    this.hud.say(null);
    this.refreshHud();
  }

  onKey(event) {
    if (event.code === 'KeyE' || event.code === 'Space') return this.act();
    const step = STEPS[event.code];
    if (step) this.move(...step);
  }

  isOpen(x, y) {
    return !this.walls[y][x] && !(x === this.npc.x && y === this.npc.y);
  }

  move(dx, dy) {
    if (this.lines || this.moving) return;
    const x = this.pos.x + dx;
    const y = this.pos.y + dy;
    if (!this.isOpen(x, y)) return;
    this.pos = { x, y };
    this.moving = true;
    const [tx, ty] = center(this.pos);
    this.tweens.add({
      targets: this.player, x: tx, y: ty, duration: 200 - 40 * this.spec.player.speed,
      onComplete: () => { this.moving = false; this.pickUp(x, y); },
    });
    const monster = this.monsters.find((m) => m.x === x && m.y === y);
    if (monster) this.hurt(monster);
  }

  pickUp(x, y) {
    const key = y * this.spec.map.width + x;
    const item = this.items.get(key);
    if (!item) return;
    this.items.delete(key);
    this.tweens.killTweensOf(item.obj);
    item.obj.destroy();
    this.collected += 1;
    if (item.quest) this.hasItem = true;
    this.refreshHud();
    if (this.spec.objective.type === 'collect' && this.collected >= this.goal) this.hud.end(true);
  }

  // E/space: open the dialogue next to the NPC, or advance it. The last line of a finished talk wins.
  act() {
    if (this.lines) {
      this.lineIndex += 1;
      if (this.lineIndex < this.lines.length) return this.hud.say(this.lines[this.lineIndex]);
      this.lines = null;
      this.hud.say(null);
      if (this.talkDone) this.hud.end(true);
      return;
    }
    if (Math.abs(this.pos.x - this.npc.x) > 1 || Math.abs(this.pos.y - this.npc.y) > 1) return;
    this.lines = this.talkLines();
    this.lineIndex = 0;
    this.hud.say(this.lines[0]);
  }

  talkLines() {
    const { dialogue, quest, objective } = this.spec;
    const story = this.heard ? [] : dialogue;
    this.heard = true;
    if (objective.type === 'collect') return story.length ? story : [{ speaker: this.npcName, text: `아이템 ${this.goal}개를 모아 줘!` }];
    if (this.needsItem && !this.hasItem) return [...story, { speaker: this.npcName, text: `${this.itemName}, 찾아다 줄래?` }];
    this.talkDone = true;
    return [...story, { speaker: this.npcName, text: quest?.completeText || '고마워!' }];
  }

  // Monsters chase within CHASE_RADIUS tiles, wander otherwise, and wait during the start grace, while resting
  // after a hit, and while a dialogue is open.
  stepMonster(m) {
    if (this.lines || this.grace || this.time.now < m.restUntil) return;
    const dx = this.pos.x - m.x;
    const dy = this.pos.y - m.y;
    const dirs = Phaser.Utils.Array.Shuffle([...DIRS]);
    if (Math.abs(dx) + Math.abs(dy) <= CHASE_RADIUS[this.spec.difficulty]) dirs.sort(([ax, ay], [bx, by]) => (bx * dx + by * dy) - (ax * dx + ay * dy));
    const step = dirs.find(([sx, sy]) => this.isOpen(m.x + sx, m.y + sy));
    if (!step) return;
    m.x += step[0];
    m.y += step[1];
    const [x, y] = center(m);
    this.tweens.add({ targets: m.obj, x, y, duration: 150 });
    if (m.x === this.pos.x && m.y === this.pos.y) this.hurt(m);
  }

  // One life per HURT_MS at most. The monster that hit is knocked back and rests for HURT_MS.
  hurt(m) {
    if (this.time.now < this.hurtUntil) return;
    this.lives -= 1;
    this.hurtUntil = this.time.now + HURT_MS;
    const to = knockbackTile(this.walls, this.npc, m.spawn, this.pos);
    Object.assign(m, to, { restUntil: this.time.now + HURT_MS });
    this.tweens.killTweensOf(m.obj);
    m.obj.setPosition(...center(to)).setAlpha(1);
    this.tweens.add({ targets: m.obj, alpha: 0.3, yoyo: true, repeat: 3, duration: 120 });
    this.tweens.add({ targets: this.player, alpha: 0.25, yoyo: true, repeat: 5, duration: 100 });
    this.refreshHud();
    if (this.lives <= 0) this.hud.end(false);
  }

  refreshHud() {
    const objective = this.spec.objective.type === 'collect'
      ? `목표: 아이템 ${this.goal}개 수집 (${this.collected}/${this.goal})`
      : this.needsItem && !this.hasItem ? `목표: ${this.itemName} 찾기` : '목표: NPC와 대화';
    this.hud.objective(objective);
    const wait = this.grace ? ' · 몬스터가 곧 움직입니다' : '';
    this.hud.status(this.monsters.length ? `목숨 ${this.lives}${wait}` : '');
  }
}
