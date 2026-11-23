// Diablo-like play for authored worlds (spec.mechanics.style === 'arpg'), layered on AuthoredMode:
//   camera   fixed top-down three-quarter view (no mouse look)
//   combat   melee combo (click/F: 3 swings, the third a heavy sweep), auto-facing the nearest enemy, crits,
//            knockback and hit-stop; R = 회오리 베기 from level 3; 1/H = potion
//   growth   XP per kill, levels (+max HP, +damage, full heal), loot drops with Diablo rarity colours
//            (일반 · 마법 · 희귀 · 전설) as light beams; walking over gold, potions and gear picks them up,
//            better gear is equipped at once, the rest is sold for gold
//   hordes   each non-boss enemy placement brings two pack mates (they never count for entity-id goals)
import { THREE, damp } from './world.js';
import { COMBO_RESET_SEC, RARITIES, SLOTS, SWING_SEC, better, itemLine, rollItem, xpFor } from './arpg-data.js';

const PACK = 2;
const PITCH = .95, BOSS_PITCH = .7; // the camera's angle over the floor (rad): the usual view, and a boss fight's

export class Arpg {
  constructor(mode) {
    this.mode = mode;
    this.level = 1; this.xp = 0; this.gold = 0; this.potions = 2;
    this.gear = { weapon: null, armor: null, ring: null };
    this.combo = 0; this.comboFor = 0; this.swingIn = 0; this.hitstop = 0;
    this.whirlFor = 0; this.whirlCd = 0; this.whirlTick = 0;
    this.loot = []; this.dom = null;
    // ?autoplay=1 (broadcaster, demos): walk to the nearest enemy and swing, else to the stage's goal
    this.bot = typeof location !== 'undefined' && new URLSearchParams(location.search).get('autoplay') === '1';
    mode.selfDriven = this.bot;
    this.held = new Set();
  }

  get damage() {
    return Math.round(this.mode.mechanics.weaponDamage * 2 + (this.level - 1) * 1.2 + (this.gear.weapon?.value ?? 0));
  }
  get armor() { return this.gear.armor?.value ?? 0; }
  get crit() { return .08 + (this.gear.ring?.value ?? 0) + (this.level >= 2 ? .05 : 0); }
  /** Steady damage per second: the 3-swing combo (1 + 1 + 2) at one swing per SWING_SEC. Bosses are tuned against it. */
  get dps() { return this.damage * (4 / 3) / SWING_SEC; }

  /** The run's growth at a checkpoint (authored.js): a restart there keeps the level, gear and gold it had. */
  snapshot() {
    return { level: this.level, xp: this.xp, gold: this.gold, potions: this.potions, gear: { ...this.gear }, maxHp: this.mode.maxHp };
  }
  restore(s) {
    if (!s) return;
    Object.assign(this, { level: s.level, xp: s.xp, gold: s.gold, potions: Math.max(2, s.potions), gear: { ...s.gear } });
    this.mode.maxHp = this.mode.hp = s.maxHp;
  }

  setup() {
    const rig = this.mode.world.rig;
    this.yaw = Math.PI / 4; // Diablo's diagonal view
    // fixed: walls and pillars never pull it in (that put a pillar across half the screen); they fade (rig.occluders)
    Object.assign(rig, { yaw: this.yaw, pitch: PITCH, distance: 11, height: .9, shoulder: 0, blockers: [] });
    this.mode.maxHp = Math.round(this.mode.maxHp * 1.2); this.mode.hp = this.mode.maxHp;
    const dom = document.createElement('div');
    dom.id = 'arpg';
    dom.innerHTML = `<div class="arpg-level"><b>Lv <span data-k="level">1</span></b><div class="arpg-xp"><i data-k="xp"></i></div></div>
      <div class="arpg-stats"><span data-k="gold"></span><span data-k="potions"></span><span data-k="power"></span></div>
      <ul class="arpg-gear" data-k="gear"></ul>
      <p class="arpg-keys">클릭·F 연속 베기 · R 회오리 베기(Lv3) · 1 물약</p>`;
    document.body.appendChild(dom);
    this.dom = dom;
  }

  /** Called before the mode moves anything: the camera stays put and a hit-stop freezes time for a moment. */
  frame(dt) {
    const { world } = this.mode;
    if (this.bot && this.mode.phase === 'ready') { // the built-in player starts the mission itself
      dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', bubbles: true }));
      setTimeout(() => dispatchEvent(new KeyboardEvent('keyup', { code: 'Enter', bubbles: true })), 60);
    }
    world.input.look.x = world.input.look.y = 0;
    // a boss fight drops the camera to a lower angle: from the usual top-down view a cloaked boss reads as a heap on the
    // floor, from here it stands up as a figure
    const boss = this.mode.enemies.some((e) => e.boss && e.pos.distanceTo(this.mode.player.pos) < 22);
    this.pitch = damp(this.pitch ?? PITCH, boss ? BOSS_PITCH : PITCH, 2.5, dt);
    world.rig.yaw = this.yaw; world.rig.pitch = this.pitch;
    if (this.hitstop > 0) { this.hitstop -= dt; return dt * .08; }
    return dt;
  }

  /** The built-in player: holds W/A/S/D toward a goal (camera-relative), F next to an enemy, E on a target. */
  drive() {
    const m = this.mode;
    const enemy = m.nearestEnemy();
    const stage = m.director.stage;
    const pickup = m.pickups?.find((p) => !p.taken && p.stage === stage?.id);
    const target = m.targets?.find((t) => stage?.entityIds?.includes(t.id) || t.id === m.npc?.id);
    const goal = enemy?.pos ?? pickup?.group.position ?? (target ? new THREE.Vector3(target.x, 0, target.z) : null)
      ?? this.loot[0]?.group.position;
    const want = new Set();
    if (goal) {
      const dist = goal.clone().sub(m.player.pos).setY(0).length();
      // around walls on a grid path (authored.js navToward): straight at the goal stuck it on a wall corner
      const next = m.navToward(goal);
      const d = new THREE.Vector3(next.x - m.player.pos.x, 0, next.z - m.player.pos.z);
      if (dist > (enemy ? 1.8 : .6) && d.lengthSq() > 1e-4) {
        d.normalize();
        const f = m.world.rig.forward().clone(), r = m.world.rig.right().clone();
        const fw = d.dot(f), rt = d.dot(r);
        if (fw > .35) want.add('KeyW'); if (fw < -.35) want.add('KeyS');
        if (rt > .35) want.add('KeyD'); if (rt < -.35) want.add('KeyA');
      }
      if (enemy && dist < 2.8) want.add('KeyF');
      if (!enemy && target && dist < 2) want.add('KeyE');
    }
    if (this.level >= 3 && m.enemies.filter((e) => e.pos.distanceTo(m.player.pos) < 3.5).length >= 3) want.add('KeyR');
    if (m.hp < m.maxHp * .35) want.add('Digit1');
    for (const code of new Set([...want, ...this.held])) {
      const on = want.has(code);
      if (on !== this.held.has(code)) dispatchEvent(new KeyboardEvent(on ? 'keydown' : 'keyup', { code, bubbles: true }));
    }
    this.held = want;
  }

  /** Input and timers for one frame (in place of the shooter's attack). */
  update(dt) {
    const m = this.mode, input = m.world.input;
    if (this.bot) this.drive();
    this.swingIn -= dt; this.comboFor -= dt; this.whirlCd -= dt;
    if (this.comboFor <= 0) this.combo = 0;
    if (this.whirlFor > 0) {
      this.whirlFor -= dt; this.whirlTick -= dt;
      m.actor.root.rotation.y += dt * 22;
      if (this.whirlTick <= 0) { this.whirlTick = .2; this.strike({ radius: 3.6, arc: -1, mult: .7, push: .6 }); }
    } else if ((input.fireHeld || input.clicked || input.down('KeyF') || input.pad?.fire) && this.swingIn <= 0) {
      this.swing();
    }
    if (input.hit('KeyR') && this.level >= 3 && this.whirlCd <= 0 && this.whirlFor <= 0) {
      this.whirlFor = 1.2; this.whirlCd = 6; this.whirlTick = 0;
      m.actor.animator?.play('attack_melee', { parts: 'full', fadeIn: .05 });
      m.hud.popup('회오리 베기!', m.player.pos.clone().setY(2.6), 'kill');
    }
    if ((input.hit('Digit1') || input.hit('KeyH')) && this.potions > 0 && m.hp < m.maxHp) {
      this.potions -= 1; m.hp = Math.min(m.maxHp, m.hp + m.maxHp * .45);
      m.world.particles.emit(m.player.pos.clone().setY(1), { count: 26, color: '#ff4a5a', speed: 3, size: .22, life: .7 });
      m.hud.popup('+체력', m.player.pos.clone().setY(2.4), 'pickup');
    }
    this.updateLoot(dt);
  }

  swing() {
    const m = this.mode;
    this.swingIn = SWING_SEC; this.comboFor = COMBO_RESET_SEC;
    this.combo = this.combo % 3 + 1;
    const heavy = this.combo === 3;
    const target = m.nearestEnemy();
    if (target && target.pos.distanceTo(m.player.pos) < 5.5) { // auto-face, like click-to-attack
      const d = target.pos.clone().sub(m.player.pos);
      m.actor.root.rotation.y = Math.atan2(d.x, d.z);
    }
    m.actor.animator?.play('attack_melee', { parts: heavy ? 'full' : 'upper', fadeIn: .04, timeScale: heavy ? .9 : 1.25 });
    this.strike(heavy ? { radius: 3.8, arc: -.2, mult: 2, push: 1.4 } : { radius: 3.1, arc: .35, mult: 1, push: .5 });
    const facing = new THREE.Vector3(Math.sin(m.actor.root.rotation.y), 0, Math.cos(m.actor.root.rotation.y));
    m.world.particles.emit(m.player.pos.clone().setY(1.1).addScaledVector(facing, 1.2),
      { count: heavy ? 36 : 18, color: m.accent, speed: heavy ? 8 : 5, size: .2, life: .22, dir: facing, spread: heavy ? 1.6 : .7 });
    if (heavy) m.world.rig.shake(.18);
  }

  /** Hits every enemy within `radius` and in front (dot > arc; -1 = all around). */
  strike({ radius, arc, mult, push }) {
    const m = this.mode;
    const facing = new THREE.Vector3(Math.sin(m.actor.root.rotation.y), 0, Math.cos(m.actor.root.rotation.y));
    let hits = 0;
    for (const e of [...m.enemies]) {
      const d = e.pos.clone().sub(m.player.pos).setY(0);
      const dist = d.length();
      if (dist > radius + (e.boss ? .8 : 0)) continue;
      if (arc > -1 && dist > .4 && d.normalize().dot(facing) < arc) continue;
      const crit = m.rnd() < this.crit;
      const dmg = Math.round(this.damage * mult * (crit ? 2 : 1) * (.9 + m.rnd() * .2));
      if (!e.boss) { const next = e.pos.clone().addScaledVector(d.lengthSq() ? d : facing, push); m.collide(next, .5); e.pos.copy(next); }
      m.hitEnemy(e, dmg, crit, mult >= 2); // the heavy third swing staggers an elite out of its wind-up
      hits += 1;
    }
    if (hits) { this.hitstop = Math.max(this.hitstop, mult >= 2 ? .09 : .05); m.world.rig.shake(.06 * Math.min(3, hits)); }
    return hits;
  }

  /** One in three pack leaders from the second stage on is a champion (정예): bigger, tougher, better loot. */
  isChampion(placement) {
    if (placement.packMate || placement.minion || this.mode.director.index === 0) return false;
    let h = 0;
    for (const c of String(placement.id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return h % 3 === 0;
  }

  mitigate(damage) { return Math.max(1, Math.round(damage * (1 - this.armor))); }

  onKill(e) {
    const m = this.mode, data = m.spec.enemies[e.enemyIndex];
    this.addXp(e.boss ? 160 : 18 + Math.round((data.hp ?? 1) * 6));
    const at = e.pos.clone();
    const drops = [{ kind: 'gold', amount: Math.round((e.boss ? 120 : 6 + m.rnd() * 14) * (1 + this.level * .15)) }];
    if (m.rnd() < (e.boss ? 1 : .16)) drops.push({ kind: 'potion' });
    if (e.boss || e.champion || m.rnd() < .32) drops.push({ kind: 'item', item: rollItem(m.rnd, this.level, e.boss || e.champion) });
    if (e.champion) this.addXp(40); // a champion is worth more
    drops.forEach((drop, i) => this.drop(drop, at.clone().add(new THREE.Vector3(Math.cos(i * 2.1) * .9, 0, Math.sin(i * 2.1) * .9))));
  }

  addXp(amount) {
    const m = this.mode;
    this.xp += amount;
    while (this.xp >= xpFor(this.level)) {
      this.xp -= xpFor(this.level); this.level += 1;
      m.maxHp += 15; m.hp = m.maxHp;
      m.world.flash(m.player.pos.clone().setY(1), '#ffd23f', 30, 10);
      m.world.particles.emit(m.player.pos.clone().setY(.2), { count: 60, color: '#ffd23f', speed: 6, size: .25, life: 1 });
      m.hud.popup(`레벨 업! Lv ${this.level}`, m.player.pos.clone().setY(3), 'kill');
      if (this.level === 3) m.tip('R · 회오리 베기를 배웠어요', 5); // (a tip: hud.notice() here would be wiped in the same frame)
    }
  }

  drop(drop, at) {
    const m = this.mode;
    const rarity = drop.kind === 'item' ? RARITIES.find((r) => r.id === drop.item.rarity) : null;
    const tint = new THREE.Color(rarity?.color ?? (drop.kind === 'potion' ? '#ff4a5a' : '#ffcf4a'));
    const group = new THREE.Group();
    group.position.copy(at);
    const glow = (c, i = 3) => new THREE.MeshBasicMaterial({ color: c.clone().multiplyScalar(i), toneMapped: false, transparent: true, opacity: .9 });
    const gem = new THREE.Mesh(drop.kind === 'gold' ? new THREE.CylinderGeometry(.16, .16, .05, 14)
      : drop.kind === 'potion' ? new THREE.SphereGeometry(.16, 14, 10) : new THREE.OctahedronGeometry(.22), glow(tint, 2));
    gem.position.y = .35;
    group.add(gem);
    if (rarity && rarity.id !== 'common') { // Diablo's loot beam: taller for better items
      const h = 2 + RARITIES.indexOf(rarity) * 1.6;
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(.06, .18, h, 10, 1, true), glow(tint, 1.4));
      beam.material.opacity = .35; beam.material.depthWrite = false; beam.position.y = h / 2;
      group.add(beam);
    }
    m.root.add(group);
    const label = drop.kind === 'item' ? drop.item.name : drop.kind === 'potion' ? '체력 물약' : `${drop.amount} 골드`;
    this.loot.push({ ...drop, group, gem, label, color: rarity?.color, age: 0 });
  }

  updateLoot(dt) {
    const m = this.mode;
    for (const l of this.loot) {
      l.age += dt;
      l.gem.rotation.y += dt * 2.4; l.gem.position.y = .35 + Math.sin(l.age * 3) * .06;
      const near = l.group.position.distanceTo(m.player.pos) < 1.7;
      m.hud.float(l, l.age < 9 || near ? l.label : null, l.group.position.clone().setY(1.1), 'tag');
      if (l.age > .5 && near) this.pick(l);
    }
    this.loot = this.loot.filter((l) => !l.taken);
  }

  pick(l) {
    const m = this.mode;
    l.taken = true; m.root.remove(l.group); m.hud.float(l, null);
    const at = m.player.pos.clone().setY(2.4);
    if (l.kind === 'gold') { this.gold += l.amount; m.hud.popup(`+${l.amount} 골드`, at, 'pickup'); return; }
    if (l.kind === 'potion') { this.potions += 1; m.hud.popup('+물약', at, 'pickup'); return; }
    const item = l.item, worn = this.gear[item.slot];
    if (better(item, worn)) {
      this.gear[item.slot] = item;
      m.hud.popup(`장착: ${item.name} (${itemLine(item)})`, at, 'kill');
    } else {
      const price = Math.round(item.value * (item.slot === 'weapon' ? 8 : 300));
      this.gold += price;
      m.hud.popup(`${item.name} 판매 +${price} 골드`, at, 'pickup');
    }
  }

  refreshHud() {
    if (!this.dom) return;
    this.dom.hidden = this.mode.phase === 'ready'; // not over the briefing
    const q = (k) => this.dom.querySelector(`[data-k="${k}"]`);
    q('level').textContent = String(this.level);
    q('xp').style.width = `${Math.min(100, this.xp / xpFor(this.level) * 100)}%`;
    q('gold').textContent = `골드 ${this.gold}`;
    q('potions').textContent = `물약 ${this.potions}`;
    q('power').textContent = `공격력 ${this.damage} · 치명 ${Math.round(this.crit * 100)}%`;
    const html = Object.entries(SLOTS).map(([slot, s]) => {
      const it = this.gear[slot];
      const color = it ? RARITIES.find((r) => r.id === it.rarity).color : '#7c8372';
      return `<li style="--c:${color}"><b>${s.label}</b> ${it ? `${it.name} · ${itemLine(it)}` : '—'}</li>`;
    }).join('');
    const gear = q('gear');
    if (gear.innerHTML !== html) gear.innerHTML = html;
  }

  /** Two pack mates around a regular enemy placement (ids that entity-id goals never list). */
  pack(placement, boss) {
    if (boss) return [];
    if (this.mode.director.index === 0) return [{ ...placement, id: `${placement.id}~1`, packMate: true, // a gentler first fight
      x: placement.x + 1.8, z: placement.z + 1.2 }];
    return Array.from({ length: PACK }, (_, k) => ({ ...placement, id: `${placement.id}~${k + 1}`,
      x: placement.x + Math.cos(k * 2.4 + 1) * 2.2, z: placement.z + Math.sin(k * 2.4 + 1) * 2.2, packMate: true }));
  }

  dispose() {
    this.dom?.remove();
    for (const l of this.loot) this.mode.root.remove(l.group);
    this.loot = [];
  }
}
