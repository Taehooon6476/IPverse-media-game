// SF shooter scene (sf-shooter, sf-survival). Player and drops use the IP cutout sprites;
// enemies and bullets are textures generated from the spec (shape, color).
const W = 960;
const H = 540;
const SPAWN_MS = { easy: 1400, normal: 1000, hard: 700 };
const FIRE_MS = 320; // auto-fire; holding space fires at RAPID_MS
const RAPID_MS = 140;
const DROP_CHANCE = 0.2;
const START_GRACE_MS = 2000; // no enemies spawn at the start of a run
const toColor = (hex) => parseInt(hex.slice(1), 16);

// Each prop effect returns the label floated over the pickup.
const EFFECTS = {
  score: (s) => { s.score += 100; return '+100'; },
  heal: (s) => { s.lives += 1; return '+1 ♥'; },
  shield: (s) => { s.shieldUntil = s.time.now + 5000; return '방어막 5초'; },
  key: (s) => { s.score += 250; return '+250'; },
};

export class ShooterScene extends Phaser.Scene {
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
    const accent = toColor(this.spec.palette.accent);
    this.makeTextures(accent);
    this.lives = 3;
    this.score = 0;
    this.kills = 0;
    this.elapsed = 0;
    this.lastShot = 0;
    this.hurtUntil = 0;
    this.shieldUntil = 0;

    this.player = this.physics.add.image(W / 2, H - 70, 'player').setCollideWorldBounds(true);
    this.player.setScale(72 / this.player.height);
    this.player.body.setSize(this.player.width * 0.6, this.player.height * 0.7); // cutouts have transparent margins
    this.shield = this.add.circle(0, 0, 48).setStrokeStyle(3, accent).setVisible(false);

    this.bullets = this.physics.add.group();
    this.enemies = this.physics.add.group();
    this.drops = this.physics.add.group();
    this.physics.add.overlap(this.bullets, this.enemies, this.hitEnemy, null, this);
    this.physics.add.overlap(this.player, this.enemies, this.hitPlayer, null, this);
    this.physics.add.overlap(this.player, this.drops, this.pickUp, null, this);

    this.keys = this.input.keyboard.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT,SPACE');
    this.time.delayedCall(START_GRACE_MS, () => this.time.addEvent({
      delay: SPAWN_MS[this.spec.difficulty], loop: true, callback: this.spawnEnemy, callbackScope: this,
    }));
    this.refreshHud();
  }

  // Generated once per page; restarts reuse them. 'player'/'propN' are fallbacks for missing sprites.
  makeTextures(accent) {
    const make = (key, w, h, draw) => {
      if (this.textures.exists(key)) return;
      const g = this.make.graphics();
      draw(g);
      g.generateTexture(key, w, h);
      g.destroy();
    };
    make('bullet', 6, 18, (g) => g.fillStyle(accent).fillRoundedRect(0, 0, 6, 18, 3));
    make('player', 64, 64, (g) => g.fillStyle(accent).fillCircle(32, 32, 32));
    this.spec.props.forEach((_, i) => make(`prop${i}`, 40, 40, (g) => g.fillStyle(accent).fillRoundedRect(4, 4, 32, 32, 8)));
    this.spec.enemies.forEach((enemy, i) => make(`enemy${i}`, 36, 36, (g) => {
      g.fillStyle(toColor(enemy.color));
      if (enemy.shape === 'circle') g.fillCircle(18, 18, 18);
      else if (enemy.shape === 'square') g.fillRect(2, 2, 32, 32);
      else g.fillTriangle(0, 0, 36, 0, 18, 36); // points down at the player
    }));
  }

  spawnEnemy() {
    const i = Phaser.Math.Between(0, this.spec.enemies.length - 1);
    const { speed, hp } = this.spec.enemies[i];
    this.enemies.create(Phaser.Math.Between(30, W - 30), -24, `enemy${i}`).setVelocityY(60 + 50 * speed).setData('hp', hp);
  }

  hitEnemy(bullet, enemy) {
    if (!bullet.active || !enemy.active) return;
    bullet.destroy();
    const hp = enemy.getData('hp') - 1;
    if (hp > 0) {
      enemy.setData('hp', hp).setTintFill(0xffffff);
      this.time.delayedCall(60, () => enemy.active && enemy.clearTint());
      return;
    }
    this.kills += 1;
    this.score += 10;
    if (this.spec.props.length && Math.random() < DROP_CHANCE) this.dropProp(enemy.x, enemy.y);
    enemy.destroy();
  }

  hitPlayer(player, enemy) {
    if (!enemy.active) return;
    enemy.destroy();
    const now = this.time.now;
    if (now < this.shieldUntil || now < this.hurtUntil) return;
    this.lives -= 1;
    this.hurtUntil = now + 1000;
    this.tweens.add({ targets: player, alpha: 0.25, yoyo: true, repeat: 4, duration: 100 });
  }

  dropProp(x, y) {
    const i = Phaser.Math.Between(0, this.spec.props.length - 1);
    const drop = this.drops.create(x, y, `prop${i}`);
    drop.setScale(40 / drop.height).setVelocityY(110).setData('effect', this.spec.props[i].effect);
  }

  pickUp(player, drop) {
    if (!drop.active) return;
    const label = EFFECTS[drop.getData('effect')](this);
    const text = this.add.text(drop.x, drop.y, label, {
      fontFamily: 'system-ui, sans-serif', fontSize: '20px', fontStyle: 'bold', color: this.spec.palette.text,
    }).setOrigin(0.5);
    this.tweens.add({ targets: text, y: drop.y - 48, alpha: 0, duration: 800, onComplete: () => text.destroy() });
    drop.destroy();
  }

  update(time, delta) {
    const k = this.keys;
    const dx = (k.RIGHT.isDown || k.D.isDown) - (k.LEFT.isDown || k.A.isDown);
    const dy = (k.DOWN.isDown || k.S.isDown) - (k.UP.isDown || k.W.isDown);
    const speed = (160 + 80 * this.spec.player.speed) / (Math.hypot(dx, dy) || 1);
    this.player.setVelocity(dx * speed, dy * speed);

    if (time - this.lastShot >= (k.SPACE.isDown ? RAPID_MS : FIRE_MS)) {
      this.lastShot = time;
      this.bullets.create(this.player.x, this.player.y - this.player.displayHeight / 2, 'bullet').setVelocityY(-620);
    }
    for (const group of [this.bullets, this.enemies, this.drops]) {
      for (const obj of group.getChildren().slice()) if (obj.y < -40 || obj.y > H + 40) obj.destroy();
    }
    this.shield.setPosition(this.player.x, this.player.y).setVisible(time < this.shieldUntil);
    this.elapsed += delta;

    const { target } = this.spec.objective;
    const progress = this.refreshHud();
    if (this.lives <= 0) this.hud.end(false);
    else if (progress >= target) this.hud.end(true);
  }

  // Returns objective progress: kills, or whole seconds survived.
  refreshHud() {
    const { type, target } = this.spec.objective;
    const progress = type === 'kills' ? this.kills : Math.floor(this.elapsed / 1000);
    const shown = `${Math.min(progress, target)}/${target}`;
    this.hud.objective(type === 'kills' ? `목표: 적 ${target}명 격파 (${shown})` : `목표: ${target}초 생존 (${shown})`);
    const shieldLeft = Math.ceil((this.shieldUntil - this.time.now) / 1000);
    this.hud.status(`목숨 ${this.lives} · 점수 ${this.score}${shieldLeft > 0 ? ` · 방어막 ${shieldLeft}초` : ''}`);
    return progress;
  }
}
