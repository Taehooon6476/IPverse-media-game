// Shared engine for the three.js runtime: renderer + post (ACES, bloom, vignette), input, third-person camera,
// asset loading (GLB normalized to a height, or a trimmed billboard of the cutout PNG), the player controller with
// procedural motion, a pooled additive particle system, and seeded noise. Game modes live in sf.js and rpg.js.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Animator, bindLibrary, libraryFrom, isUalRig, prepareWeapon, attachWeapon } from './anim.js';
import { legImbalance, LEG_IMBALANCE_MAX, rawModelUrl } from './ualclips.js';
import { LoadMeter } from './arpg-data.js';

export { THREE };

export const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;
const MAX_PIXEL_RATIO = 1.75;
const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();

export const damp = (from, to, rate, dt) => from + (to - from) * (1 - Math.exp(-rate * dt));
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const color = (hex) => new THREE.Color(hex);
export function angleDamp(from, to, rate, dt) {
  const diff = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  return from + diff * (1 - Math.exp(-rate * dt));
}

// ── seeded randomness ─────────────────────────────────────────────────────────

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Value noise with smooth interpolation; fbm sums octaves. Deterministic per seed.
export function makeNoise(seed) {
  const rnd = mulberry32(seed);
  const perm = new Uint8Array(512);
  const vals = new Float32Array(256);
  for (let i = 0; i < 256; i++) { perm[i] = i; vals[i] = rnd() * 2 - 1; }
  for (let i = 255; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
  for (let i = 0; i < 256; i++) perm[i + 256] = perm[i];
  const v = (x, y) => vals[perm[(x & 255) + perm[y & 255]]];
  const s = (t) => t * t * (3 - 2 * t);
  const noise = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const tx = s(x - xi), ty = s(y - yi);
    const a = v(xi, yi), b = v(xi + 1, yi), c = v(xi, yi + 1), d = v(xi + 1, yi + 1);
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  };
  const fbm = (x, y, octaves = 4) => {
    let sum = 0, amp = 0.5, f = 1;
    for (let o = 0; o < octaves; o++) { sum += amp * noise(x * f, y * f); f *= 2.03; amp *= 0.5; }
    return sum;
  };
  return { noise, fbm };
}

// ── input ─────────────────────────────────────────────────────────────────────

const GAME_KEYS = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD',
  'KeyE', 'KeyF', 'KeyQ', 'ShiftLeft', 'ShiftRight']);

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pressed = new Set(); // edges since the last frame
    this.look = { x: 0, y: 0 }; // accumulated mouse delta (px)
    this.fireHeld = false;
    this.dragging = false;
    this.pointerLockWanted = false;
    // ?autoplay=1 (runtime3d.js sets it): the keys are the built-in player's alone. Its keys are events a script sends
    // (not trusted); a keyboard's are trusted and are not the hero's, so a key held in the play window cannot stall a
    // broadcast's round and the ads that wait for its end
    this.botOnly = false;
    this.pad = null;
    const onKey = (down) => (e) => {
      if (e.target instanceof HTMLButtonElement || e.target instanceof HTMLInputElement) return;
      if (GAME_KEYS.has(e.code)) e.preventDefault();
      if (this.botOnly && e.isTrusted) return;
      if (down) { if (!this.keys.has(e.code)) this.pressed.add(e.code); this.keys.add(e.code); }
      else this.keys.delete(e.code);
    };
    this.handlers = [
      [window, 'keydown', onKey(true)],
      [window, 'keyup', onKey(false)],
      [window, 'blur', () => { this.keys.clear(); this.fireHeld = false; this.dragging = false; }],
      [canvas, 'contextmenu', (e) => e.preventDefault()],
      [canvas, 'pointerdown', (e) => {
        this.dragging = true;
        if (e.button === 0) { this.fireHeld = true; this.downAt = { t: performance.now(), x: e.clientX, y: e.clientY }; }
        if (this.pointerLockWanted && document.pointerLockElement !== canvas) canvas.requestPointerLock?.()?.catch?.(() => {});
      }],
      [window, 'pointerup', (e) => {
        this.dragging = false;
        if (e.button !== 0) return;
        this.fireHeld = false;
        // a click, not the end of a camera drag (RPG attacks on click; drag still orbits)
        const d = this.downAt;
        if (d && performance.now() - d.t < 300 && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 8) this.clicked = true;
        this.downAt = null;
      }],
      [window, 'pointermove', (e) => {
        if (document.pointerLockElement === canvas || this.dragging) { this.look.x += e.movementX; this.look.y += e.movementY; }
      }],
    ];
    for (const [target, type, fn] of this.handlers) target.addEventListener(type, fn, { passive: type !== 'keydown' && type !== 'keyup' && type !== 'contextmenu' });
  }
  down(...codes) { return codes.some((c) => this.keys.has(c)); }
  hit(...codes) { return codes.some((c) => this.pressed.has(c)); }
  pollPad() {
    const pad = [...(navigator.getGamepads?.() ?? [])].find(Boolean);
    const dz = (v) => (Math.abs(v) < 0.15 ? 0 : v);
    this.pad = pad ? {
      lx: dz(pad.axes[0]), ly: dz(pad.axes[1]), rx: dz(pad.axes[2] ?? 0), ry: dz(pad.axes[3] ?? 0),
      a: pad.buttons[0]?.pressed, b: pad.buttons[1]?.pressed, x: pad.buttons[2]?.pressed,
      fire: pad.buttons[7]?.pressed || pad.buttons[5]?.pressed, sprint: pad.buttons[10]?.pressed || pad.buttons[4]?.pressed,
    } : null;
    if (this.pad) {
      const prev = this.prevPad ?? {};
      if (this.pad.a && !prev.a) this.pressed.add('Space');
      if (this.pad.b && !prev.b) this.pressed.add('KeyQ');
      if (this.pad.x && !prev.x) this.pressed.add('KeyE');
      this.prevPad = this.pad;
    }
  }
  // Move axes in camera space: x = right, y = forward. Length <= 1.
  moveAxes() {
    let x = (this.down('KeyD') ? 1 : 0) - (this.down('KeyA') ? 1 : 0);
    let y = (this.down('KeyW') ? 1 : 0) - (this.down('KeyS') ? 1 : 0);
    if (this.pad) { x += this.pad.lx; y -= this.pad.ly; }
    const len = Math.hypot(x, y);
    return len > 1 ? { x: x / len, y: y / len } : { x, y };
  }
  endFrame() { this.pressed.clear(); this.look.x = 0; this.look.y = 0; this.clicked = false; }
  dispose() {
    for (const [target, type, fn] of this.handlers) target.removeEventListener(type, fn);
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }
}

// ── particles ─────────────────────────────────────────────────────────────────

const PARTICLE_VS = `
attribute float size; attribute float alpha; attribute vec3 tint;
varying float vAlpha; varying vec3 vTint;
uniform float scale;
void main() {
  vAlpha = alpha; vTint = tint;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = size * scale / max(0.1, -mv.z);
  gl_Position = projectionMatrix * mv;
}`;
const PARTICLE_FS = `
varying float vAlpha; varying vec3 vTint;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = dot(d, d) * 4.0;
  if (r > 1.0) discard;
  float soft = pow(1.0 - r, 1.6);
  gl_FragColor = vec4(vTint * soft * vAlpha, 1.0);
}`;

export class Particles {
  constructor(scene, max = 2400) {
    this.max = max;
    this.count = 0;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.tint = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.size0 = new Float32Array(max);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('tint', new THREE.BufferAttribute(this.tint, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.material = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VS, fragmentShader: PARTICLE_FS, uniforms: { scale: { value: 400 } },
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
    scene.add(this.points);
  }
  // opts: {count, color, speed, size, life, spread(0..1 cone), dir:Vector3, drag, gravity, intensity}
  emit(at, opts = {}) {
    const n = opts.count ?? 12;
    const c = opts.color instanceof THREE.Color ? opts.color : new THREE.Color(opts.color ?? 0xffffff);
    const k = opts.intensity ?? 3;
    for (let i = 0; i < n; i++) {
      if (this.count >= this.max) return;
      const j = this.count++;
      let dx = Math.random() * 2 - 1, dy = Math.random() * 2 - 1, dz = Math.random() * 2 - 1;
      const l = Math.hypot(dx, dy, dz) || 1;
      dx /= l; dy /= l; dz /= l;
      if (opts.dir) {
        const s = opts.spread ?? 0.4;
        dx = opts.dir.x + dx * s; dy = opts.dir.y + dy * s; dz = opts.dir.z + dz * s;
      }
      const sp = (opts.speed ?? 4) * (0.35 + Math.random() * 0.65);
      this.pos.set([at.x, at.y, at.z], j * 3);
      this.vel.set([dx * sp, dy * sp, dz * sp], j * 3);
      this.tint.set([c.r * k, c.g * k, c.b * k], j * 3);
      this.size0[j] = (opts.size ?? 0.25) * (0.6 + Math.random() * 0.8);
      this.maxLife[j] = this.life[j] = (opts.life ?? 0.6) * (0.6 + Math.random() * 0.6);
      this.drag[j] = opts.drag ?? 2;
      this.grav[j] = opts.gravity ?? 0;
    }
  }
  update(dt, pixelHeight) {
    this.material.uniforms.scale.value = pixelHeight * 0.9;
    let i = 0;
    while (i < this.count) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.kill(i); continue; }
      const f = Math.exp(-this.drag[i] * dt);
      const o = i * 3;
      this.vel[o] *= f; this.vel[o + 1] = this.vel[o + 1] * f - this.grav[i] * dt; this.vel[o + 2] *= f;
      this.pos[o] += this.vel[o] * dt; this.pos[o + 1] += this.vel[o + 1] * dt; this.pos[o + 2] += this.vel[o + 2] * dt;
      const t = this.life[i] / this.maxLife[i];
      this.alpha[i] = t * t;
      this.size[i] = this.size0[i] * (0.4 + 0.6 * t);
      i++;
    }
    const g = this.points.geometry;
    g.setDrawRange(0, this.count);
    for (const name of ['position', 'tint', 'size', 'alpha']) g.attributes[name].needsUpdate = true;
  }
  kill(i) {
    const last = --this.count;
    if (i === last) return;
    for (const arr of [this.pos, this.vel, this.tint]) arr.copyWithin(i * 3, last * 3, last * 3 + 3);
    for (const arr of [this.size, this.alpha, this.life, this.maxLife, this.drag, this.grav, this.size0]) arr[i] = arr[last];
  }
  clear() { this.count = 0; }
}

// ── post-processing ───────────────────────────────────────────────────────────

// hurt: the rim reddens for a blow; hurtFrom: the side of the picture the blow came from (a unit vector: right, up),
// and the rim reddens on that side only, a wedge toward the attacker. [0, 0], no side (a trap underfoot, a
// version-1 mode): the whole rim.
const VignetteShader = {
  uniforms: { tDiffuse: { value: null }, strength: { value: 0.42 }, hurt: { value: 0 }, hurtColor: { value: new THREE.Color(1, 0.1, 0.12) },
    hurtFrom: { value: [0, 0] } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float strength; uniform float hurt; uniform vec3 hurtColor; uniform vec2 hurtFrom; varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float d = length((vUv - 0.5) * vec2(1.15, 1.0));
      float v = smoothstep(0.82, 0.25, d);
      c.rgb *= mix(1.0 - strength, 1.0, v);
      float rim = hurt * smoothstep(0.25, 0.85, d);
      if (dot(hurtFrom, hurtFrom) > 0.0) rim *= 1.6 * smoothstep(0.5, 0.95, dot(normalize(vUv - 0.5 + 1e-5), hurtFrom) * 0.5 + 0.5);
      c.rgb = mix(c.rgb, hurtColor * 0.8, min(rim, 0.9));
      gl_FragColor = c;
    }`,
};

// ── world ─────────────────────────────────────────────────────────────────────

// World.warm: how long texture uploads run before the page gets a turn, and the longest it waits for programs to link (ms)
const WARM = { slice: 16, link: 10000 };
/** Back to the event loop at once, so input and timers run between two slices of work (a zero timeout waits 4 ms once
 * nested, a second in a hidden tab). */
const breathe = () => new Promise((resolve) => {
  const { port1, port2 } = new MessageChannel();
  port1.onmessage = () => { port1.close(); resolve(); };
  port2.postMessage(0);
});

export class World {
  constructor(parent, { fps = false, lite = false, meter = null } = {}) {
    this.meter = meter ?? new LoadMeter(); // what the loading screen counts (gltf, runtime3d.js)
    const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    // lite: the live broadcaster renders on a CPU (SwiftShader); post passes and shadows cost it ~10x
    const gl = renderer.getContext(), info = gl.getExtension('WEBGL_debug_renderer_info');
    const software = /swiftshader|llvmpipe|software/i.test(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : '');
    this.lite = lite || software;
    lite = this.lite;
    renderer.setPixelRatio(lite ? 1 : Math.min(devicePixelRatio, MAX_PIXEL_RATIO));
    renderer.setSize(parent.clientWidth, parent.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.shadowMap.enabled = !lite;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.info.autoReset = false; // count the whole frame (scene + post passes)
    parent.appendChild(renderer.domElement);
    this.renderer = renderer;
    this.parent = parent;
    this.canvas = renderer.domElement;
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('aria-label', '3D 게임 화면');

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, parent.clientWidth / parent.clientHeight, 0.1, 1500);
    this.camera.position.set(0, 4, 8);
    this.pmrem = new THREE.PMREMGenerator(renderer);

    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.7, 0.55, 0.9);
    this.composer.addPass(this.bloom);
    this.vignette = new ShaderPass(VignetteShader);
    this.composer.addPass(this.vignette);
    this.composer.addPass(new OutputPass());

    this.input = new Input(this.canvas);
    this.particles = new Particles(this.scene);
    this.rig = new CameraRig(this.camera);
    this.loader = new GLTFLoader();
    const draco = new DRACOLoader();
    draco.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/libs/draco/gltf/');
    this.loader.setDRACOLoader(draco);
    this.gltfCache = new Map();
    this.textureCache = new Map();
    this.anims = null; // shared UAL clip library (spec.animUrl), see anim.js
    this.bindCache = new Map();
    this.flashes = [];
    for (let i = 0; i < 3; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 10, 2);
      light.userData.life = 0;
      this.scene.add(light);
      this.flashes.push(light);
    }
    this.hurt = 0;
    this.hurtFrom = null; // the side of the picture the last blow came from ({x: right, y: up}), or null: no side
    this.fps = fps ? { el: null, frames: 0, acc: 0, value: 0 } : null;
    this.frameTimes = [];
    this.frameCount = 0;
    this.lastRenderedAt = null;

    this.onResize = () => {
      const w = parent.clientWidth, h = parent.clientHeight;
      renderer.setSize(w, h);
      this.composer.setSize(w, h);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    };
    addEventListener('resize', this.onResize);
  }

  /** A GLB as the loader gives it, its bytes counted for the loading screen as they arrive (arpg-data.js LoadMeter). */
  gltf(url) {
    return this.meter.watch(url, (onProgress) => this.loader.loadAsync(url, onProgress));
  }

  // A GLB scene clone (skinned meshes keep their own skeleton) plus its clips, or null when it cannot load.
  async loadModel(url) {
    if (!this.gltfCache.has(url)) {
      this.gltfCache.set(url, this.gltf(url).then((gltf) => { padSkinBounds(gltf.scene); return gltf; })
        .catch((err) => { console.warn('GLB', url, err); return null; }));
    }
    const gltf = await this.gltfCache.get(url);
    if (!gltf) return null;
    return { scene: cloneSkinned(gltf.scene), clips: gltf.animations };
  }

  // The shared animation library (assets/ual.glb). Without it, rigged models fall back to their own clips.
  async loadAnims(url) {
    const gltf = await this.gltf(url).catch((err) => { console.warn('anims', url, err); return null; });
    this.anims = gltf?.animations.length ? libraryFrom(gltf) : null;
    return this.anims;
  }

  // A weapon GLB as {holder, muzzle, type}: grip at the origin, blade/barrel along +Z (anim.js prepareWeapon).
  async loadWeapon(url, type = 'melee') {
    const model = url ? await this.loadModel(url) : null;
    return model ? { ...prepareWeapon(model.scene, type), type } : null;
  }

  // A cutout PNG cropped to its opaque bounds: {texture, aspect, cut} or null (cut: the frame cut the subject off).
  async loadCutout(url) {
    if (!this.textureCache.has(url)) {
      this.textureCache.set(url, new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement('canvas');
          c.width = img.naturalWidth; c.height = img.naturalHeight;
          const g = c.getContext('2d', { willReadFrequently: true });
          g.drawImage(img, 0, 0);
          const { data } = g.getImageData(0, 0, c.width, c.height);
          let x0 = c.width, y0 = c.height, x1 = 0, y1 = 0;
          for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
            if (data[(y * c.width + x) * 4 + 3] > 24) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
          }
          if (x1 < x0) return resolve(null);
          const crop = document.createElement('canvas');
          crop.width = x1 - x0 + 1; crop.height = y1 - y0 + 1;
          crop.getContext('2d').drawImage(c, x0, y0, crop.width, crop.height, 0, 0, crop.width, crop.height);
          const cut = cutAtBottom(data, c.width, c.height, x0, x1, y1);
          if (cut) dissolveBottom(crop); // cut off by the frame (at the thighs): no hard edge
          const texture = new THREE.CanvasTexture(crop);
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.anisotropy = 4;
          resolve({ texture, aspect: crop.width / crop.height, cut });
        };
        img.onerror = () => resolve(null);
        img.src = url;
      }));
    }
    return this.textureCache.get(url);
  }

  // Actor = {root (positioned/yawed by gameplay), body (procedural motion), animator? (UAL rig), mixer?, actions,
  // billboard?, weapon?}. GLB first, then a billboard of the cutout, else `fallback()` (a procedural stand-in).
  // A GLB on the UAL skeleton gets an Animator driven by the shared library (or its own clips); `zombie` swaps
  // walk/attack for the zombie clips. entity.weaponUrl goes in the right hand (or at the side when unrigged).
  async makeActor(entity, height, fallback, { zombie = false, maxExtent = Infinity } = {}) {
    const root = new THREE.Group();
    const body = new THREE.Group();
    root.add(body);
    const actor = { root, body, height, mixer: null, animator: null, actions: {}, billboard: null, kind: 'model', current: null, weapon: null };
    let [model, weapon] = await Promise.all([
      entity?.modelUrl ? this.loadModel(entity.modelUrl) : null,
      entity?.weaponUrl ? this.loadWeapon(entity.weaponUrl, entity.weaponType ?? 'melee') : null,
    ]);
    if (model && brokenRig(model.scene)) {
      // a misread rig distorts the body in every clip: the raw mesh with procedural motion (the turntable's model),
      // else the cutout. make_game copies the raw mesh next to the rig (server/tools.py _game_asset_keys).
      console.warn('rig with uneven legs, using the raw mesh', entity.modelUrl);
      model = rawModelUrl(entity.modelUrl) ? await this.loadModel(rawModelUrl(entity.modelUrl)) : null;
      actor.rigDropped = true;
    }
    if (model) {
      const obj = model.scene;
      obj.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(obj);
      const size = box.getSize(new THREE.Vector3());
      const s = fitScale(size, height, maxExtent);
      obj.scale.multiplyScalar(s);
      obj.updateMatrixWorld(true);
      box.setFromObject(obj);
      const c = box.getCenter(new THREE.Vector3());
      obj.position.x -= c.x; obj.position.z -= c.z; obj.position.y -= box.min.y;
      obj.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = true;
        o.receiveShadow = true;
        for (const m of [o.material].flat()) if (m && 'envMapIntensity' in m) m.envMapIntensity = 0.8;
      });
      body.add(obj);
      const lib = isUalRig(obj) ? this.anims ?? (model.clips.length ? libraryFrom({ scene: obj, animations: model.clips }) : null) : null;
      if (lib) {
        obj.updateMatrixWorld(true);
        const key = `${entity.modelUrl}|${zombie}|${height}|${lib === this.anims}`;
        if (!this.bindCache.has(key)) this.bindCache.set(key, bindLibrary(lib, obj, height, { zombie }));
        actor.animator = new Animator(obj, this.bindCache.get(key));
        actor.kind = 'rigged';
        if (weapon && attachWeapon(obj, weapon, weapon.type, height)) actor.weapon = weapon;
      } else if (model.clips.length) {
        actor.mixer = new THREE.AnimationMixer(obj);
        const find = (re) => model.clips.find((clip) => re.test(clip.name));
        for (const [key, re] of [['idle', /idle/i], ['run', /run/i], ['walk', /walk/i], ['jump', /jump/i], ['wave', /wave/i]]) {
          const clip = find(re);
          if (clip) actor.actions[key] = actor.mixer.clipAction(clip);
        }
        actor.actions.run ??= actor.actions.walk;
        playAction(actor, 'idle', 0);
      }
      if (weapon && !actor.weapon) { // unrigged: carried at the right side, pointing forward
        weapon.holder.position.set(-0.28 * height / 1.8, 0.95 * height / 1.8, 0.18 * height / 1.8);
        weapon.holder.scale.setScalar(height / 1.8);
        if (weapon.type === 'melee') weapon.holder.rotation.x = -0.6;
        body.add(weapon.holder);
        actor.weapon = weapon;
      }
      return actor;
    }
    const cut = entity?.spriteUrl ? await this.loadCutout(entity.spriteUrl) : null;
    if (cut) {
      const k = fitScale({ x: height * cut.aspect, y: height, z: 0 }, height, maxExtent); // a wide cutout: capped too
      const w = height * cut.aspect * k;
      height *= k; actor.height = height;
      const geom = new THREE.PlaneGeometry(w, height);
      // a figure the frame cut off (at the thighs) stands CUT_SINK of its height in the floor: its frayed end goes into
      // the ground (and the dark pool authored.js lays under a cut enemy) instead of hovering in the air
      geom.translate(0, height * (.5 - (cut.cut ? CUT_SINK : 0)), 0);
      const mat = new THREE.MeshStandardMaterial({
        map: cut.texture, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.75, metalness: 0,
        emissive: 0xffffff, emissiveMap: cut.texture, emissiveIntensity: 0.22,
      });
      const plane = new THREE.Mesh(geom, mat);
      plane.castShadow = true;
      plane.receiveShadow = false;
      body.add(plane);
      actor.kind = 'billboard';
      actor.billboard = plane;
      actor.cut = !!cut.cut;
      return actor;
    }
    actor.kind = 'procedural';
    body.add(fallback());
    return actor;
  }

  // A brief colored light at `at` (explosions, pickups). Pooled.
  flash(at, hex, intensity = 30, distance = 10) {
    const light = this.flashes.reduce((a, b) => (a.userData.life < b.userData.life ? a : b));
    light.position.copy(at);
    light.color.set(hex);
    light.distance = distance;
    light.userData.peak = intensity;
    light.userData.life = light.userData.max = 0.35;
  }

  update(dt) {
    for (const light of this.flashes) {
      if (light.userData.life <= 0) { light.intensity = 0; continue; }
      light.userData.life -= dt;
      light.intensity = light.userData.peak * Math.max(0, light.userData.life / light.userData.max) ** 2;
    }
    this.hurt = Math.max(0, this.hurt - dt * 1.8);
    this.vignette.uniforms.hurt.value = REDUCED_MOTION ? this.hurt * 0.5 : this.hurt;
    const side = this.vignette.uniforms.hurtFrom.value;
    side[0] = this.hurtFrom?.x ?? 0; side[1] = this.hurtFrom?.y ?? 0;
    this.particles.update(dt, this.renderer.domElement.height);
  }

  /** Before the game is shown (runtime3d.js boot): the work of the first frame, off the page's one thread where it can
   * be. The programs (and the ones the camera's fade will ask for) link off the thread (KHR_parallel_shader_compile)
   * while the textures go up a slice at a time, then one frame is drawn under the loading screen, so the loop's first
   * frame does not hold the thread for seconds. */
  async warm() {
    const { renderer, scene } = this;
    // for the buffer the scene is drawn into: tone mapping and the output colour space are part of a program's key
    renderer.setRenderTarget(this.lite ? null : this.composer.readBuffer);
    let linked;
    try {
      linked = Promise.all([renderer.compileAsync(scene, this.camera),
        renderer.compileAsync(fadedTwins(this.rig.occluders), this.camera, scene)]);
    } finally { renderer.setRenderTarget(null); }
    const textures = new Set();
    const keep = (v) => { if (v?.isTexture) textures.add(v); };
    keep(scene.background);
    scene.traverse((o) => { for (const m of [o.material].flat()) if (m) Object.values(m).forEach(keep); });
    let since = performance.now();
    for (const texture of textures) {
      renderer.initTexture(texture);
      if (performance.now() - since > WARM.slice) { await breathe(); since = performance.now(); }
    }
    // a lost context never says its programs are linked: the loading screen does not wait for it
    let timer;
    const late = new Promise((resolve) => { timer = setTimeout(resolve, WARM.link, 'late'); });
    const first = await Promise.race([linked, late]).finally(() => clearTimeout(timer));
    if (first === 'late') console.warn('warm: programs still linking, drawing the first frame anyway');
    if (this.lite) renderer.render(scene, this.camera);
    else this.composer.render(0);
  }

  render(dt, realDt = dt) {
    this.renderer.info.reset();
    if (this.lite) this.renderer.render(this.scene, this.camera);
    else this.composer.render(dt);
    const now = performance.now();
    if (this.lastRenderedAt != null) {
      this.frameTimes.push(now - this.lastRenderedAt);
      if (this.frameTimes.length > 1200) this.frameTimes.shift();
    }
    this.lastRenderedAt = now;
    this.frameCount++;
    if (this.fps) {
      this.fps.frames++;
      this.fps.acc += realDt;
      if (this.fps.acc >= 0.5) {
        this.fps.value = Math.round(this.fps.frames / this.fps.acc);
        this.fps.frames = 0; this.fps.acc = 0;
        const info = this.renderer.info.render;
        document.getElementById('fps').textContent = `${this.fps.value} fps · ${info.calls} draws · ${(info.triangles / 1000).toFixed(0)}k tris`;
      }
    }
  }

  performanceSnapshot() {
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const percentile = (p) => sorted.length ? +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(2) : null;
    const mean = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;
    return { measurement: 'performance.now wall-clock render intervals; simulation dt cap is not used',
      totalFrames: this.frameCount, samples: sorted.length, p50Ms: percentile(.5), p95Ms: percentile(.95),
      meanFps: mean ? +(1000 / mean).toFixed(1) : null,
      draws: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles };
  }

  dispose() {
    removeEventListener('resize', this.onResize);
    this.input.dispose();
  }
}

/** Skinned meshes are frustum-culled against one bounding sphere in their own space: the rest pose's, padded ×SKIN_PAD
 * so a stride, a swing or a fall stays inside it. Taken once on a loaded GLB; every clone copies it (SkinnedMesh.copy),
 * and the shadow pass still updates the skeleton of one the camera skipped. */
export const SKIN_PAD = 2;
export function padSkinBounds(scene) {
  scene.updateMatrixWorld(true);
  scene.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    try {
      o.computeBoundingSphere();
      o.boundingSphere.radius *= SKIN_PAD;
    } catch (err) { // a skin it cannot pose keeps the old way (never culled) rather than losing the model
      console.warn('skin bounds', o.name, err);
      o.frustumCulled = false;
    }
  });
  return scene;
}

/** True when the image frame cuts the subject off at the bottom (a figure cut at the thighs), not when it stands on the
 * edge: its lowest opaque row y1 is within 2 px of the frame and covers at least 45% of its width x0..x1, the share
 * server/providers/cutout.py (CUT figure) calls cut. Full-body figures with their soles on the edge keep their feet. */
export function cutAtBottom(data, width, height, x0, x1, y1) {
  if (y1 < height - 2) return false;
  let opaque = 0;
  for (let x = x0; x <= x1; x++) if (data[(y1 * width + x) * 4 + 3] > 24) opaque += 1;
  return opaque >= .45 * (x1 - x0 + 1);
}

/** How deep (share of its height) a cut-off figure stands in the floor: its frayed band's sparse tips go under, the
 * ragged part above them meets the ground, and a walking hop (arpg-data.js billboardPose lifts at most 5%) never shows
 * the end. */
export const CUT_SINK = .1;

// The bottom third of a cutout frays out through low-frequency noise, so a figure cut by the frame ends in ragged
// tatters (still crisp under the billboard's alphaTest, with lobes wide enough to survive mipmapping) instead of a
// ruler line, and sinks into shadow on the way down (bandShade), so its end melts into the dark ground pool.
function dissolveBottom(canvas) {
  const g = canvas.getContext('2d');
  const band = Math.max(4, Math.round(canvas.height * 0.3)), top = canvas.height - band;
  const img = g.getImageData(0, top, canvas.width, band);
  const { noise } = makeNoise(7);
  const sx = 6 / canvas.width, sy = 4 / band;
  for (let y = 0; y < band; y++) {
    const shade = bandShade(y / band);
    for (let x = 0; x < canvas.width; x++) {
      const n = noise(x * sx, y * sy) * 0.65 + noise(x * sx * 2.7 + 17, y * sy * 2.7) * 0.35;
      const i = (y * canvas.width + x) * 4;
      img.data[i] *= shade; img.data[i + 1] *= shade; img.data[i + 2] *= shade;
      img.data[i + 3] *= clamp((1 - y / band) * 1.4 - 0.25 + n * 0.8, 0, 1);
    }
  }
  g.putImageData(img, 0, top);
}
/** Brightness left at depth `t` (0 at the top of the frayed band, 1 at the cut): full at the top, a fifth at the cut. */
export const bandShade = (t) => 1 - .8 * clamp(t, 0, 1) ** 1.3;

export function playAction(actor, name, fade = 0.25) {
  const next = actor.actions[name];
  if (!next || actor.current === next) return;
  next.reset().setEffectiveWeight(1).fadeIn(fade).play();
  actor.current?.fadeOut(fade);
  actor.current = next;
}

// ── third-person camera ───────────────────────────────────────────────────────

const fadeBox = new THREE.Box3();
const fadeAt = new THREE.Vector3();
const fadeFwd = new THREE.Vector3();
const corner = new THREE.Vector3();

// An occluder's materials, cloned once so a shared material elsewhere never fades with it, at opacity `a`.
function fadeTo(o, a) {
  if (!o.mats) {
    o.mats = [];
    const own = (m) => {
      const c = m.clone();
      c.userData.base = { transparent: m.transparent, opacity: m.opacity, depthWrite: m.depthWrite };
      o.mats.push(c); return c;
    };
    o.root.traverse((m) => { if (m.isMesh && m.visible) m.material = Array.isArray(m.material) ? m.material.map(own) : own(m.material); });
  }
  const faded = a < .98;
  for (const m of o.mats) {
    const base = m.userData.base;
    if (m.transparent !== (faded || base.transparent)) { m.transparent = faded || base.transparent; m.needsUpdate = true; }
    m.depthWrite = faded ? false : base.depthWrite;
    m.opacity = faded ? base.opacity * a : base.opacity;
  }
}

/** Stand-ins for what fadeTo will make of the occluders: one mesh for each of their materials, gone transparent, never
 * drawn. A transparent material is another variant of its program, and the renderer links ahead only what the scene
 * holds: World.warm links these with the scene so the first fade does not link in play. */
function fadedTwins(occluders) {
  const twins = new THREE.Group(), seen = new Set();
  for (const o of occluders) o.root.traverse((m) => {
    if (!m.isMesh || !m.visible) return;
    for (const material of [m.material].flat()) {
      if (material.transparent || seen.has(material)) continue;
      seen.add(material);
      const twin = m.clone(false);
      twin.material = Object.assign(material.clone(), { transparent: true });
      twins.add(twin);
    }
  });
  return twins;
}

/** Where the camera sits when something solid stands behind the hero. `hitAt(pitch)`: how far the line from the focus
 * runs at that pitch before it meets a blocker (Infinity: clear). The camera rises over it at full distance, up to
 * `maxPitch`; one too tall to look over pulls it in, but no closer than `pullMin` (the blocker fades instead).
 * → {pitch, dist} */
export function cameraBoom({ pitch, distance, hitAt, pullMin = 1.2, maxPitch = 1, step = .05, gap = .35 }) {
  const room = (p) => hitAt(p) - gap;
  if (room(pitch) >= distance) return { pitch, dist: distance };
  for (let p = pitch + step; p <= maxPitch + 1e-9; p += step) if (room(p) >= distance) return { pitch: p, dist: distance };
  return { pitch, dist: Math.min(distance, Math.max(pullMin, room(pitch))) };
}

/** The lowest the camera may sit at `pos`: a metre over the top of a blocker it stands over (or in), if that top is
 * within 3 m of the focus height `headY` (a container, a crate); a taller one fades instead. → y, or -Infinity */
export function cameraFloor(pos, boxes, headY, margin = .3) {
  let floor = -Infinity;
  for (const b of boxes) {
    if (pos.x < b.min.x - margin || pos.x > b.max.x + margin || pos.z < b.min.z - margin || pos.z > b.max.z + margin) continue;
    if (b.max.y - headY < 3 && pos.y < b.max.y + 1) floor = Math.max(floor, b.max.y + 1);
  }
  return floor;
}

export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.yaw = 0;
    this.pitch = 0.32;
    this.distance = 6;
    this.shoulder = 0;
    this.height = 1.55;
    this.target = new THREE.Vector3();
    this.smoothTarget = new THREE.Vector3();
    this.trauma = 0;
    this.blockers = []; // Box3[] the camera must not pass through
    this.pullMin = 1.2; // closest the camera pulls in to the focus when a blocker stands behind the hero,
    this.lift = .6; this.liftMax = Infinity; // and how much it rises per metre pulled in (to look over the hero)
    // null: a blocker only pulls the camera in, at once. A pitch (rad): it first rises over the blocker at full
    // distance up to that pitch, eased in and out (cameraBoom); `boost` is how far it has risen
    this.rise = null; this.boost = 0; this.hover = 0; // hover: how far it stands raised over a low blocker (cameraFloor)
    // [{box: Box3, root: Object3D, thin}]: faded while they stand between the camera and the hero; thin ones (pillars,
    // props) also while they fill a fifth of the view in front of the hero. Shared by the ARPG's fixed camera too.
    this.occluders = [];
    this.minY = () => -Infinity;
    this.ray = new THREE.Ray();
    this.dist = 6;
    this.first = true;
  }
  forward() { return tmpV.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)); }
  right() { return tmpV2.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw)); }
  shake(amount) { if (!REDUCED_MOTION) this.trauma = Math.min(1, this.trauma + amount); }
  update(dt, focus, input) {
    const sens = 0.0042;
    this.yaw -= input.look.x * sens;
    this.pitch = clamp(this.pitch + input.look.y * sens * 0.8, -0.25, 1.15);
    const keyYaw = (input.down('ArrowLeft') ? 1 : 0) - (input.down('ArrowRight') ? 1 : 0);
    const keyPitch = (input.down('ArrowDown') ? 1 : 0) - (input.down('ArrowUp') ? 1 : 0);
    this.yaw += keyYaw * 2.4 * dt;
    this.pitch = clamp(this.pitch + keyPitch * 1.4 * dt, -0.25, 1.15);
    if (input.pad) { this.yaw -= input.pad.rx * 3 * dt; this.pitch = clamp(this.pitch + input.pad.ry * 2 * dt, -0.25, 1.15); }

    this.target.copy(focus).add(new THREE.Vector3(0, this.height, 0));
    const side = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw)).multiplyScalar(this.shoulder);
    this.target.add(side);
    if (this.first) { this.smoothTarget.copy(this.target); this.first = false; }
    const k = 1 - Math.exp(-14 * dt);
    this.smoothTarget.lerp(this.target, k);

    const dir = new THREE.Vector3();
    const aim = (pitch) => dir.set(Math.sin(this.yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(this.yaw) * Math.cos(pitch));
    let want = this.distance;
    if (this.rise != null) {
      // rise over what stands behind the hero, else pull in no closer than pullMin; both eased (cameraBoom)
      const hitAt = (pitch) => {
        this.ray.set(this.smoothTarget, aim(pitch));
        let near = Infinity;
        for (const box of this.blockers) {
          const hit = this.ray.intersectBox(box, tmpV);
          if (hit) near = Math.min(near, hit.distanceTo(this.smoothTarget));
        }
        return near;
      };
      const boom = cameraBoom({ pitch: this.pitch, distance: this.distance, hitAt, pullMin: this.pullMin,
        maxPitch: Math.max(this.pitch, this.rise) });
      const up = boom.pitch - this.pitch;
      this.boost = damp(this.boost, up, up > this.boost ? 8 : 3, dt);
      want = boom.dist;
      this.dist = damp(this.dist, want, want < this.dist ? 10 : 4, dt);
      aim(this.pitch + this.boost);
    } else {
      // Pull in when something blocks the line from the focus to the camera.
      this.ray.set(this.smoothTarget, aim(this.pitch));
      for (const box of this.blockers) {
        const hit = this.ray.intersectBox(box, tmpV);
        if (hit) want = Math.min(want, Math.max(this.pullMin, hit.distanceTo(this.smoothTarget) - 0.35));
      }
      this.dist = want < this.dist ? want : damp(this.dist, want, 4, dt);
    }
    const pos = this.smoothTarget.clone().addScaledVector(dir, this.dist);
    pos.y += Math.min(this.liftMax, Math.max(0, this.distance - this.dist) * this.lift); // blocked: look over the hero's head
    if (this.rise != null) { // pulled in over a low blocker: hover over its top, eased up and back down
      const need = Math.max(0, cameraFloor(pos, this.blockers, this.smoothTarget.y) - pos.y);
      this.hover = damp(this.hover, need, need > this.hover ? 8 : 3, dt);
      pos.y += this.hover;
    }
    pos.y = Math.max(pos.y, this.minY(pos.x, pos.z) + 0.4);
    this.camera.position.copy(pos);
    this.camera.lookAt(this.smoothTarget);
    if (this.occluders.length) this.fadeOccluders(dt);
    if (this.trauma > 0) {
      const s = this.trauma * this.trauma;
      const t = performance.now() / 1000;
      this.camera.rotation.z += Math.sin(t * 61) * 0.03 * s;
      this.camera.position.x += Math.sin(t * 47) * 0.18 * s;
      this.camera.position.y += Math.sin(t * 53 + 1) * 0.14 * s;
      this.trauma = Math.max(0, this.trauma - dt * 1.6);
    }
  }
  /** Fades what hides the hero: anything on the lines from the camera to the hero's head and chest (or around the
   * camera itself), and thin occluders nearer than the hero that fill a fifth of the screen. Clear ones come back. */
  fadeOccluders(dt) {
    const eye = this.camera.position, head = this.smoothTarget;
    const chest = fadeAt.copy(head).setY(head.y - Math.max(0, this.height - .9));
    const reach = eye.distanceTo(head);
    this.camera.updateMatrixWorld();
    this.camera.getWorldDirection(fadeFwd);
    for (const o of this.occluders) {
      fadeBox.copy(o.box).expandByScalar(.2);
      let hide = fadeBox.containsPoint(eye) || this.crosses(fadeBox, eye, head) || this.crosses(fadeBox, eye, chest);
      if (!hide && o.thin && o.box.distanceToPoint(eye) < reach) hide = this.coverage(o.box, eye) > .2;
      if (!hide && !o.faded) continue;
      o.fade = damp(o.fade ?? 1, hide ? (o.thin ? .3 : .45) : 1, 10, dt); // a ghost stays: still an obstacle
      if (!hide && o.fade > .98) { o.fade = 1; o.faded = false; } else o.faded = true;
      fadeTo(o, o.fade);
    }
  }
  crosses(box, from, to) {
    const len = from.distanceTo(to);
    this.ray.set(from, corner.copy(to).sub(from).divideScalar(len || 1));
    const hit = this.ray.intersectBox(box, corner);
    return !!hit && hit.distanceTo(from) < len - .25;
  }
  /** Share of the screen a box covers (1 when it wraps around a camera within 2.5 m). */
  coverage(box, eye) {
    let x0 = 1, x1 = -1, y0 = 1, y1 = -1;
    for (let i = 0; i < 8; i++) {
      corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
      if ((corner.x - eye.x) * fadeFwd.x + (corner.y - eye.y) * fadeFwd.y + (corner.z - eye.z) * fadeFwd.z < .1) {
        return box.distanceToPoint(eye) < 2.5 ? 1 : 0;
      }
      corner.project(this.camera);
      x0 = Math.min(x0, clamp(corner.x, -1, 1)); x1 = Math.max(x1, clamp(corner.x, -1, 1));
      y0 = Math.min(y0, clamp(corner.y, -1, 1)); y1 = Math.max(y1, clamp(corner.y, -1, 1));
    }
    return Math.max(0, x1 - x0) * Math.max(0, y1 - y0) / 4;
  }
}

/** A UAL rig whose legs differ in length (ualclips.js legImbalance): the rig job misread a knee. */
function brokenRig(obj) {
  if (!isUalRig(obj)) return false;
  obj.updateMatrixWorld(true);
  const points = {};
  obj.traverse((o) => { if (o.isBone && /^(thigh|calf|foot)_[lr]$/.test(o.name) && !points[o.name]) points[o.name] = o.getWorldPosition(new THREE.Vector3()).toArray(); });
  return legImbalance(points) > LEG_IMBALANCE_MAX;
}

/** The scale that stands a model `height` tall, unless that makes it wider or deeper than `maxExtent` (a pickup in the
 * hero's hand: a flat disc scaled by its thickness would come out wider than the hero). */
export function fitScale(size, height, maxExtent = Infinity) {
  const s = height / Math.max(size.y, 1e-3);
  return Math.min(s, maxExtent / Math.max(size.x, size.z, size.y, 1e-3));
}
// a handheld pickup's largest side: about .6 of the hero's 1.8 m (runtime3d.js makeActor(spec.player, 1.8))
export const PICKUP_MAX = 1.1;

// ── player ────────────────────────────────────────────────────────────────────

// Jump (m/s, m/s²). A platformer (mechanics.fallRespawn) jumps higher: 1.46 m instead of 1.12 m at 60 fps, so with
// the .3 m a top is landed from (authored.js STEP_UP) it clears the contract's 1.2 m step (server/authored_contract.py
// STEP_RISE) by .56 m.
export const JUMP = { gravity: 22, velocity: 7.2, platformer: 8.2 };
export const jumpVelocity = (mechanics = {}) => (mechanics.fallRespawn ? JUMP.platformer : JUMP.velocity);
/** Apex (m) as PlayerController integrates it at `dt` (gravity first, then position): v²/2g less half a step. */
export const jumpApex = (mechanics, dt = 1 / 60) => jumpVelocity(mechanics) ** 2 / (2 * JUMP.gravity) - jumpVelocity(mechanics) * dt / 2;

// Third-person character: camera-relative WASD, sprint, jump, dash (with i-frames), collisions via callbacks,
// and procedural motion (bob, lean into turns, squash on landing) since generated GLBs are unrigged.
export class PlayerController {
  constructor(world, actor, { speed = 2, groundAt = () => 0, collide = () => {}, bounds = 30, mechanics = {} } = {}) {
    this.world = world;
    this.actor = actor;
    this.groundAt = groundAt;
    this.collide = collide;
    this.bounds = bounds; // {minX,maxX,minZ,maxZ} or half-size
    this.mechanics = mechanics;
    this.walk = 4.2 + 1.1 * speed;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.grounded = true;
    this.squash = 0;
    this.phase = 0;
    this.dashTime = 0;
    this.dashCooldown = 0;
    this.lastYaw = 0;
    this.faceYaw = null; // set by the mode (e.g. aiming) to override facing
    this.frozen = false;
    this.landed = false;
  }
  get invulnerableFromDash() { return this.dashTime > 0; }
  place(x, z) {
    this.pos.set(x, this.groundAt(x, z), z);
    this.vel.set(0, 0, 0);
    this.actor.root.position.copy(this.pos);
  }
  impulse(v) { this.vel.add(v); this.grounded = false; }
  update(dt, input, rig) {
    const { x, y } = this.frozen ? { x: 0, y: 0 } : input.moveAxes();
    const f = rig.forward().clone();
    const r = rig.right().clone();
    const wish = new THREE.Vector3().addScaledVector(r, x).addScaledVector(f, y);
    const sprint = !this.frozen && this.mechanics.sprint !== false && (input.down('ShiftLeft', 'ShiftRight') || input.pad?.sprint);
    const speed = this.walk * (sprint ? 1.65 : 1);
    if (!this.frozen && this.mechanics.dash !== false && input.hit('KeyQ') && this.dashCooldown <= 0) {
      const dir = wish.lengthSq() > 0.01 ? wish.clone().normalize() : new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      this.vel.x = dir.x * 17; this.vel.z = dir.z * 17;
      this.dashTime = 0.22;
      this.dashCooldown = 0.9;
      this.world.particles.emit(tmpV.copy(this.pos).setY(this.pos.y + 0.6), { count: 18, color: this.dashColor ?? 0x9fe8ff, speed: 3, size: 0.35, life: 0.4 });
    }
    this.dashTime = Math.max(0, this.dashTime - dt);
    this.dashCooldown = Math.max(0, this.dashCooldown - dt);
    if (this.dashTime <= 0) {
      const accel = this.grounded ? 14 : 4;
      this.vel.x = damp(this.vel.x, wish.x * speed, accel, dt);
      this.vel.z = damp(this.vel.z, wish.z * speed, accel, dt);
    }
    if (!this.frozen && this.mechanics.jump !== false && input.hit('Space') && this.grounded) {
      this.vel.y = jumpVelocity(this.mechanics);
      this.grounded = false;
      this.squash = -0.18; // stretch
    }
    this.vel.y -= JUMP.gravity * dt;
    const next = this.pos.clone().addScaledVector(this.vel, dt);
    this.collide(next, 0.45, this.pos);
    const b = this.bounds;
    next.x = clamp(next.x, b.minX, b.maxX);
    next.z = clamp(next.z, b.minZ, b.maxZ);
    const ground = this.groundAt(next.x, next.z, next.y);
    this.landed = false;
    if (next.y <= ground) {
      if (!this.grounded && this.vel.y < -4) { this.squash = Math.min(0.28, -this.vel.y * 0.022); this.landed = true; }
      next.y = ground;
      this.vel.y = 0;
      this.grounded = true;
    } else if (next.y > ground + 0.05) {
      this.grounded = this.grounded && next.y - ground < 0.35 && this.vel.y <= 0;
      if (this.grounded) next.y = ground; // stick to slopes when walking down
    }
    this.pos.copy(next);
    const flat = Math.hypot(this.vel.x, this.vel.z);
    const targetYaw = this.faceYaw ?? (flat > 0.4 ? Math.atan2(this.vel.x, this.vel.z) : this.yaw);
    this.yaw = angleDamp(this.yaw, targetYaw, this.faceYaw != null ? 20 : 12, dt);
    this.animate(dt, flat / this.walk, rig, flat);
  }
  animate(dt, speed01, rig, flat = 0) {
    const { actor } = this;
    const turn = Math.atan2(Math.sin(this.yaw - this.lastYaw), Math.cos(this.yaw - this.lastYaw)) / Math.max(dt, 1e-3);
    this.lastYaw = this.yaw;
    actor.root.position.copy(this.pos);
    this.squash = damp(this.squash, 0, 9, dt);
    animateBody(actor, dt, { speed01, turn, grounded: this.grounded, squash: this.squash, phase: (this.phase += dt * (6 + 5 * speed01)), dash: this.dashTime > 0 });
    if (actor.billboard) {
      actor.root.rotation.y = rig.yaw;
      const side = this.vel.x * Math.cos(rig.yaw) - this.vel.z * Math.sin(rig.yaw);
      if (Math.abs(side) > 0.5) actor.billboard.scale.x = damp(actor.billboard.scale.x, side < 0 ? -1 : 1, 18, dt);
    } else {
      actor.root.rotation.y = this.yaw;
    }
    if (actor.animator) actor.animator.update(dt, { speed: flat, grounded: this.grounded, vy: this.vel.y });
    else if (actor.mixer) {
      playAction(actor, !this.grounded && actor.actions.jump ? 'jump' : speed01 > 0.15 ? 'run' : 'idle');
      if (actor.actions.run) actor.actions.run.timeScale = clamp(speed01 * 1.1, 0.6, 1.6);
      actor.mixer.update(dt);
    }
  }
}

// Procedural motion on actor.body. Rigged models still get the lean on top of their clips, but never a squash: their
// body keeps the uniform scale makeActor set from their height (the clips have their own landing).
export function animateBody(actor, dt, { speed01 = 0, turn = 0, grounded = true, squash = 0, phase = 0, dash = false }) {
  const { body } = actor;
  const rigged = !!(actor.mixer || actor.animator);
  if (!rigged && actor.kind === 'model') return staticMeshMotion(actor, dt, { speed01, turn, grounded, squash, phase, dash });
  const bob = grounded && !rigged ? Math.abs(Math.sin(phase)) * 0.07 * Math.min(1, speed01) : 0;
  const breathe = Math.sin(phase * 0.35) * 0.012;
  body.position.y = bob;
  const lean = actor.animator ? 0.04 : 0.12; // skeletal clips already lean into the run
  body.rotation.x = damp(body.rotation.x, clamp(speed01, 0, 1.6) * (dash ? 0.35 : lean), 10, dt);
  body.rotation.z = damp(body.rotation.z, clamp(-turn * 0.035, -0.3, 0.3) * Math.min(1, speed01 + 0.2), 8, dt);
  const sq = rigged ? 0 : squash + breathe;
  body.scale.set(1 + sq * 0.5, 1 - sq, 1 + sq * 0.5);
}

// A 3D mesh without a skeleton (a rig the job refused, or a dropped one) walks like a toy: a hop each step, a
// waddle side to side, a little twist and a forward lean, and breathes when idle. Its scale never changes (a
// squashed mesh reads as broken, unlike a squashed cutout): the landing nods it forward instead.
export const STATIC_GAIT = { hop: .12, waddle: .1, twist: .07, lean: .12, nod: .5, breathe: .012 };
function staticMeshMotion(actor, dt, { speed01, turn, grounded, squash, phase, dash }) {
  const { body } = actor;
  const k = (actor.height ?? 1.8) / 1.8, m = clamp(speed01, 0, 1), step = Math.sin(phase);
  const walking = grounded ? m : 0;
  const idle = (1 - m) * STATIC_GAIT.breathe * (1 + Math.sin(phase * .35)) / 2;
  body.position.y = (Math.abs(step) * STATIC_GAIT.hop * walking + idle) * k;
  const lean = clamp(speed01, 0, 1.6) * (dash ? .35 : STATIC_GAIT.lean) + Math.max(0, squash) * STATIC_GAIT.nod;
  body.rotation.x = damp(body.rotation.x, lean + (grounded ? 0 : -.08), 10, dt);
  const bank = clamp(-turn * 0.035, -0.3, 0.3) * Math.min(1, speed01 + 0.2);
  body.rotation.z = damp(body.rotation.z, bank + step * STATIC_GAIT.waddle * walking, 14, dt);
  body.rotation.y = damp(body.rotation.y, Math.cos(phase) * STATIC_GAIT.twist * walking, 14, dt);
  body.scale.set(1, 1, 1);
}

// ── small helpers for modes ───────────────────────────────────────────────────

// Canvas texture from a draw callback.
export function canvasTexture(size, draw, { srgb = true, repeat = 1 } = {}) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 8;
  return t;
}

// Stand-in hero when an IP has neither GLB nor cutout: a sleek suited figure, not a bare primitive.
export function proceduralHero(accentHex) {
  const g = new THREE.Group();
  const suit = new THREE.MeshStandardMaterial({ color: 0x2a2f3a, roughness: 0.4, metalness: 0.6 });
  const trim = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: accentHex, emissiveIntensity: 2.4 });
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 0.55, 6, 16), suit);
  torso.position.y = 1.05;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 24, 16), suit);
  head.position.y = 1.6;
  const visor = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.18, 4, 12), trim);
  visor.rotation.z = Math.PI / 2;
  visor.position.set(0, 1.62, 0.16);
  const legs = [-0.12, 0.12].map((x) => { const l = new THREE.Mesh(new THREE.CapsuleGeometry(0.1, 0.55, 4, 10), suit); l.position.set(x, 0.38, 0); return l; });
  const belt = new THREE.Mesh(new THREE.TorusGeometry(0.29, 0.025, 8, 32), trim);
  belt.rotation.x = Math.PI / 2;
  belt.position.y = 0.82;
  g.add(torso, head, visor, belt, ...legs);
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return g;
}

/** Frees what three.js makes for an object the first time it draws it and keeps until it is told: a skinned mesh's
 * bone texture, a light's shadow map. An object that is drawn again gets them anew. */
export function releaseDrawn(root) {
  root.traverse((o) => {
    o.skeleton?.dispose();
    if (o.isLight) o.dispose();
  });
}

export function disposeTree(root) {
  releaseDrawn(root);
  root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    for (const m of [o.material].flat()) {
      if (!m) continue;
      for (const v of Object.values(m)) if (v && v.isTexture && !v.userData.shared) v.dispose();
      m.dispose();
    }
  });
}
