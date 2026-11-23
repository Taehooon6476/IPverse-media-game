// Game runtime boot: spec.json + release.json -> optional pre-roll ad -> Phaser scene picked by genre.
// Also owns the DOM HUD (objective, status, dialogue box) and the win/lose overlay.
import { validateSpec } from './gamespec.js';

const $ = (id) => document.getElementById(id);
const el = (tag, text) => Object.assign(document.createElement(tag), { textContent: text });

// ponytail: ?spec= / ?release= overrides work on localhost only (dev); a published game always reads its own folder.
const query = new URLSearchParams(location.search);
const dev = ['localhost', '127.0.0.1'].includes(location.hostname);
const specUrl = (dev && query.get('spec')) || './spec.json';
const releaseUrl = (dev && query.get('release')) || './release.json';
// The live broadcast's play window (web PlayWindow.tsx) loads ?noads=1 (its ads come from the stream) and, as a demo,
// &autoplay=1. This runtime has no built-in player: an autoplay round ends after AUTOPLAY_ROUND_SEC as a loss, and the
// next one starts by itself, so the broadcast's "ad every N rounds" still comes around.
const noAds = query.get('noads') === '1';
const autoplay = query.get('autoplay') === '1';
const AUTOPLAY_ROUND_SEC = 90;

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

function showErrors(errors) {
  $('errors').replaceChildren(el('h1', '게임을 시작할 수 없습니다'), ...errors.map((e) => el('p', e)));
  $('errors').hidden = false;
}

// Resolves when the ad is skipped (after skipAfterSec), ends, or fails to load.
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

function startGame(spec, Scene) {
  const end = $('end');
  const sayBox = $('say');
  let scene;

  // Rounds finished on this page; window.ipverseRounds + the ipverse:round event let the broadcaster count them
  let rounds = 0, timeout = false, cap = 0;
  const startCap = () => {
    clearTimeout(cap);
    if (autoplay) cap = setTimeout(() => { timeout = true; hud.end(false); }, AUTOPLAY_ROUND_SEC * 1000);
  };
  const restart = () => {
    if (end.hidden) return;
    end.hidden = true;
    removeEventListener('keydown', onKey);
    scene.scene.restart();
    startCap();
    dispatchEvent(new CustomEvent('ipverse:roundstart', { detail: { rounds } }));
  };
  const onKey = (e) => {
    if (['Enter', 'Space', 'KeyR'].includes(e.code)) {
      e.preventDefault();
      restart();
    }
  };
  $('restart').onclick = restart;

  const setText = (id, text) => {
    if ($(id).textContent !== text) $(id).textContent = text;
  };
  // The scenes talk to the page only through this object.
  const hud = {
    objective: (text) => setText('objective', text),
    status: (text) => setText('status', text),
    say(line) {
      sayBox.hidden = !line;
      if (!line) return;
      sayBox.querySelector('b').textContent = line.speaker ?? '';
      sayBox.querySelector('span').textContent = line.text;
    },
    end(won) {
      if (!end.hidden) return;
      scene.scene.pause();
      $('end-title').textContent = won ? '클리어!' : '게임 오버';
      end.hidden = false;
      $('restart').focus();
      addEventListener('keydown', onKey);
      clearTimeout(cap);
      rounds += 1; // a clear, a death and a timeout each count once
      window.ipverseRounds = rounds;
      dispatchEvent(new CustomEvent('ipverse:round', { detail: { rounds, won, reason: won ? 'clear' : timeout ? 'timeout' : 'death' } }));
      timeout = false;
      if (autoplay) setTimeout(restart, 4000);
    },
  };

  scene = new Scene(spec, hud);
  new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game',
    width: 960,
    height: 540,
    backgroundColor: spec.palette.bg,
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
    physics: { default: 'arcade' },
    render: { mipmapFilter: 'LINEAR_MIPMAP_LINEAR' }, // 1024px cutouts are drawn at 28-72px
    banner: false,
    scene,
  });
  window.ipverseRoundStart = true;
  startCap();
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
  if (!window.Phaser) return showErrors(['Phaser 엔진을 불러오지 못했습니다 (cdn.jsdelivr.net).']);

  // Sprites must be same-origin (cross-origin images break WebGL textures); anything else becomes a drawn shape.
  for (const item of [spec.player, ...spec.props]) if (!isSameOrigin(item.spriteUrl)) delete item.spriteUrl;

  document.title = String(spec.title || 'IPverse 게임');
  for (const key of ['bg', 'accent', 'text']) document.documentElement.style.setProperty(`--${key}`, spec.palette[key]);
  const sf = spec.genre.startsWith('sf-');
  $('hint').textContent = sf ? '이동 WASD·방향키 · 발사 자동 (스페이스: 연사)' : '이동 WASD·방향키 · 대화 E·스페이스';
  const Scene = sf ? (await import('./shooter.js')).ShooterScene : (await import('./rpg.js')).RpgScene;

  const release = noAds ? null : await getJson(releaseUrl).catch(() => null); // 404, or a non-JSON fallback page: no release
  await playAd(release?.ad);
  startGame(spec, Scene);
}

boot();
