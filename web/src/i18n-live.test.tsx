// The live package in English: the game pane, the broadcast console, the play window and the watch window are drawn
// with 'ipverse.lang' = 'en' and show no Hangul. The language is read once as i18n.ts loads, so each case sets the
// choice, resets the modules and imports its screen anew. Parts other packages translate are taken out first: FOREIGN.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdBreak, LiveState, StandbyState, Viewer } from './api';
import type { Game, Snapshot } from './types';

const api = vi.hoisted(() => ({
  getGameSpec: vi.fn(), heldGame: vi.fn(() => null), readyIp: vi.fn(() => null), noSkeleton: vi.fn((n: string) => n),
  liveStatus: vi.fn(), liveStandby: vi.fn(), setLiveStandby: vi.fn(), liveAdSettings: vi.fn(), highlightSettings: vi.fn(), liveStop: vi.fn(),
  liveViewer: vi.fn(), liveViewers: vi.fn(), liveToken: vi.fn(), liveAdEvent: vi.fn(), listSessions: vi.fn(),
  getSession: vi.fn(), liveStart: vi.fn(), liveBeat: vi.fn(), liveRound: vi.fn(), highlightCreate: vi.fn(), liveRoundEta: vi.fn(),
  getRelease: vi.fn(), pollStream: vi.fn(), startStream: vi.fn(), stopStream: vi.fn(),
}));
vi.mock('./api', () => api);
vi.mock('./components/IvsPlayer', async () => {
  const { createElement } = await import('react');
  return { IvsPlayer: (p: { ariaLabel?: string }) => createElement('video', { 'data-ivs': '', 'aria-label': p.ariaLabel }) };
});
vi.mock('./components/LivePlayable', () => ({ LivePlayable: () => null }));
vi.mock('amazon-ivs-web-broadcast', () => {
  const ok = async () => undefined;
  return { default: { create: () => ({ on: () => undefined, addVideoInputDevice: ok, addImageSource: ok, addAudioInputDevice: ok, startBroadcast: ok,
    stopBroadcast: () => undefined, removeVideoInputDevice: () => undefined, getVideoInputDevice: () => undefined, delete: () => undefined }) } };
});

/** What other packages draw inside these screens (their English is theirs). */
const FOREIGN = '.dropdown, .game-needs, .empty-state--needs h3, .fold-meta, .game-design-summary, .toast button';
const HANGUL = /[가-힣]+[^<>"]*/g;
/** Every Hangul run a user can meet in the page: its text and its title / aria-label / placeholder / alt. */
function hangul(root: HTMLElement): string[] {
  const page = root.cloneNode(true) as HTMLElement;
  page.querySelectorAll(FOREIGN).forEach((el) => el.remove());
  page.querySelectorAll('.toasts').forEach((el) => el.removeAttribute('aria-label')); // the region's own name is the shell's
  const said = [page.textContent ?? '', ...[...page.querySelectorAll('*')].flatMap((el) =>
    ['title', 'aria-label', 'placeholder', 'alt'].map((a) => el.getAttribute(a) ?? ''))];
  return said.flatMap((text) => text.match(HANGUL) ?? []);
}

const GAME = { gameId: 'gm_1', title: 'Orbit Escape', genre: 'sf-shooter', specKey: 'games/gm_1/spec.json', previewUrl: 'https://cdn.invalid/g/index.html',
  createdAt: '2026-11-05T00:00:00Z' } as Game;
const TRAILER = { assetId: 'ast_t', kind: 'trailer', key: 'k', url: 'https://cdn/t.mp4', contentType: 'video/mp4', meta: {}, createdAt: '2026-11-05T00:00:00Z' };
const IDLE: LiveState = { active: false, channelState: 'IDLE', playbackUrl: '', adInsertion: 'ivs', job: null, stream: null, highlights: [] };
const viewer = (viewerId: string, name: string, genre: string): Viewer => ({
  viewerId, name, initials: name.slice(0, 2), color: '#333', bio: `${name} likes ${genre}`, profile: { ageBand: '25-34', region: 'Seoul', device: 'mobile', genres: [genre] },
  recent: [{ at: '2026-11-16T03:00:00Z', type: 'play', text: 'played a racing game' }], events: 30,
  features: { g1: genre, g2: 'none', skill: 'hi', dev: 'pc', age: '25-34' }, provider: 'ipverse' }) as Viewer;
const VIEWERS = [viewer('v-minji', 'Minji', 'arpg'), viewer('v-junho', 'Junho', 'racing'), viewer('v-seoyeon', 'Seoyeon', 'explore'), viewer('v-hyunwoo', 'Hyunwoo', 'shooter')];
const picks = (titles: string[]): AdBreak['picks'] => Object.fromEntries(['', ...VIEWERS.map((v) => v.viewerId)].map((v, i) =>
  [v, { title: titles[i % titles.length], creative: `cr_${i}`, seconds: 16, reason: 'likes this genre', url: 'https://cdn/t.mp4' }]));
const adBreak = (round: number, over: Partial<AdBreak> = {}): AdBreak => ({ round, eventId: `e_${round}`, breakId: `b_${round}`, at: new Date().toISOString(),
  kind: 'trailer', seconds: 16, picks: picks(['Dune Ruins', 'Boss Raid']), endToAdSec: 1.4, measured: 4, preCue: true, leadSec: 2, ...over }) as AdBreak;
const onAir = (job: Partial<NonNullable<LiveState['job']>> = {}, breaks: AdBreak[] = []): LiveState => ({
  active: true, mode: 'player', channelState: 'RUNNING', playbackUrl: 'https://ivs/x.m3u8?token=t', adInsertion: 'ivs', health: 'HEALTHY', highlights: [],
  ingest: { endpoint: 'rtmps://x/app/', streamKey: 'sk_test' },
  job: { jobId: 'job_1', gameId: 'gm_1', adTitle: 'Orbit Escape', everyRounds: 2, adSeconds: 16, startedAt: '2026-11-05T00:00:00Z', adType: 'trailer', corner: true,
    roundBase: 0, secondsLeft: 2000, maxMinutes: 45, ...job } as NonNullable<LiveState['job']>,
  stream: { state: 'live', rounds: 3, breaks, updatedAt: '2026-11-05T00:00:00Z' } });
const STANDBY: StandbyState = { on: false, state: 'off', idle: 0, allocated: 0, max: 2, mode: 'auto', hourlyUsd: 1.512 };

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  localStorage.clear();
  localStorage.setItem('ipverse.lang', 'en');
  history.replaceState(null, '', '/');
  api.getGameSpec.mockReturnValue(new Promise(() => {}));
  api.liveStatus.mockResolvedValue(IDLE);
  api.liveStandby.mockResolvedValue(STANDBY);
  api.liveViewer.mockResolvedValue({ warmed: false });
  api.liveViewers.mockResolvedValue({ viewers: VIEWERS });
  api.liveToken.mockImplementation(async (id: string) => ({ playbackUrl: `https://ivs/x.m3u8?token=${id}`, expiresAt: Math.floor(Date.now() / 1000) + 1200 }));
  api.liveAdEvent.mockResolvedValue({ recorded: true });
  api.listSessions.mockResolvedValue({ sessions: [] });
  api.liveBeat.mockResolvedValue({ ok: true });
  api.liveStop.mockResolvedValue(IDLE);
  api.getSession.mockResolvedValue({ games: [GAME], assets: [TRAILER] });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.title = '';
  localStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const tick = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const click = (el: Element | null | undefined) => act(async () => { (el as HTMLElement).click(); await vi.advanceTimersByTimeAsync(0); });
const button = (text: string) => [...document.body.querySelectorAll('button')].find((b) => b.textContent?.includes(text));

describe('the live package in English', () => {
  it('the language of a page opened with window.open is the one saved in this browser', async () => {
    const { lang, t, tn } = await import('./i18n');
    expect(lang).toBe('en');
    expect([tn('{n}판#판수', 3), tn('{n}판#판수', 1)]).toEqual(['3 rounds', '1 round']); // a number of rounds
    expect(t('{n}판', { n: 3 })).toBe('Round 3'); // the n-th round
    expect(t('플레이어블 서버가 켜져요 (켜져 있는 동안 시간당 약 ${usd})', { usd: '1.51' })).toBe('Starts the playable server (about $1.51/hour while it is on)');
  });

  it('the game pane: the preview bar, 게임 설정 with versions and run mode, the design tab', async () => {
    const { GamePane } = await import('./components/GamePane');
    const games = [GAME, { ...GAME, gameId: 'gm_2', createdAt: '2026-11-05T01:00:00Z', baseGameId: 'gm_1', publishedUrl: 'https://cdn.invalid/p/index.html' }];
    const snap = { session: { sessionId: 'ses_1', title: 'Luna', genre: 'sf-shooter', createdAt: '2026-11-05T00:00:00Z' },
      messages: [], ips: [], assets: [], jobs: [], games } as unknown as Snapshot;
    const h = { onGenre: vi.fn(), onError: vi.fn(), onDesign: vi.fn(), onExpand: vi.fn(), onEditGame: vi.fn(), onMakeHeld: vi.fn() };
    await act(async () => root.render(<GamePane snap={snap} {...h} />));
    await click(container.querySelector('#game-settings-head'));
    expect(container.querySelector('.game-start-btn')?.textContent).toBe('▶ Play');
    expect(container.querySelector('.preview-action-primary')?.textContent).toBe('⤢ Expand');
    expect(container.querySelector('.preview-action-live')?.textContent).toBe('● Live broadcast');
    expect(container.querySelector('.game-start .muted')?.textContent).toBe('Version 2 · edited from v1');
    expect([...container.querySelectorAll('[aria-labelledby="engine-label"] [role="radio"]')].map((b) => b.textContent)).toEqual(['Browser preview', 'Cloud play']);
    expect(hangul(container)).toEqual([]);
    // the design tab while it loads, and the empty pane of a session with no game
    await click([...container.querySelectorAll('[role="tab"]')].find((b) => b.textContent === 'Design summary'));
    expect(hangul(container)).toEqual([]);
    history.replaceState(null, '', '/');
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<GamePane snap={{ ...snap, games: [] }} {...h} />));
    expect(container.querySelector('.empty-state .btn-primary')?.textContent).toBe('Make a character in the chat');
    expect(container.querySelector('.pane-action')?.textContent).toBe('✎ Game design');
    expect(hangul(container)).toEqual([]);
  });

  it('the broadcast console off air: the three steps, each ad style with its line, the playable server with its price', async () => {
    const { GameModal } = await import('./components/GameModal');
    await act(async () => root.render(<GameModal sessionId="ses_1" game={GAME} url={GAME.previewUrl!} assets={[TRAILER as never]} onClose={vi.fn()} onError={vi.fn()} onNotice={vi.fn()} />));
    await tick();
    expect([...container.querySelectorAll('.live-steps li')].map((li) => li.textContent)).toEqual([
      '① Go live (opens the play window)', '② Press the game’s start button (Enter) in the play window and play',
      '③ See the ads the 4 simulated viewers get in the watch window']);
    expect([...container.querySelectorAll('.ad-type [role="tab"]')].map((b) => b.textContent)).toEqual(['Full-screen trailer', 'Playable ad', 'Corner trailer']);
    expect(container.querySelector('.live-every')?.textContent).toBe('Ad everyrounds');
    expect(container.querySelector('.live-go-does')?.textContent).toBe('Broadcasts the play window’s game · Ends by itself after at most 45 min');
    expect(hangul(container)).toEqual([]);
    for (const style of ['Playable ad', 'Corner trailer']) {
      await click([...container.querySelectorAll('.ad-type [role="tab"]')].find((b) => b.textContent === style));
      await click(container.querySelector('#live-adv-head'));
      expect(hangul(container)).toEqual([]);
      if (style === 'Playable ad') {
        expect(container.querySelector('.standby-line')?.textContent).toContain('about $1.51/hour while it is on');
        expect(button('Pre-warm')?.textContent).toBe('Pre-warm · about $1.51/hour');
        expect(container.querySelector('.live-go-does')?.textContent).toContain('Starts the playable server (about $1.51/hour while it is on)');
      }
      await click(container.querySelector('#live-adv-head'));
    }
  });

  it('the broadcast console on air: the chips, the banner of an ad that went out, the limit', async () => {
    const { GameModal } = await import('./components/GameModal');
    const notices: string[] = [];
    api.liveStatus.mockResolvedValue(onAir({ adType: 'playable', playableSeconds: 90, corner: false }, [adBreak(2, { playable: true, kind: 'playable' as never })]));
    api.liveStandby.mockResolvedValue({ ...STANDBY, on: true, state: 'ready', idle: 1, allocated: 2 });
    history.replaceState(null, '', '/#adtype=playable');
    await act(async () => root.render(<GameModal sessionId="ses_1" game={GAME} url={GAME.previewUrl!} assets={[TRAILER as never]} onClose={vi.fn()} onError={vi.fn()}
      onNotice={(text) => notices.push(text)} />));
    await tick();
    await click(container.querySelector('#live-adv-head'));
    const chips = Object.fromEntries([...container.querySelectorAll('.game-modal-bar .live-chips > div')].map((d) => [d.querySelector('dt')!.textContent, d.querySelector('dd')!.textContent]));
    expect(chips).toMatchObject({ Broadcast: 'On air', Finished: '3 rounds', 'Next ad in': '1 round', 'Ends in': '33:20' });
    expect(chips['Ads sent']).toMatch(/^1 · /);
    expect(container.querySelector('.game-modal-bar .badge')?.textContent).toBe('Playable ad · 90 s');
    expect(container.querySelector('.console-ad')?.textContent).toContain('Ad sent · Playable ad · each viewer gets a different ad · e.g. Dune Ruins');
    expect(button('End live')).toBeTruthy();
    expect(hangul(container)).toEqual([]);
    // the broadcast ends under the console: what it says is English too
    api.liveStatus.mockResolvedValue(IDLE);
    await tick(4000);
    expect(notices).toEqual(['The broadcast ended. Press ‘Go live’ to start again.']);
    expect(hangul(container)).toEqual([]);
  });

  it('the takeover question names the session on air, the limit and the price', async () => {
    const { takeoverText } = await import('./components/TakeoverDialog');
    expect(takeoverText({ session: 'Luna', game: 'Orbit Escape' }, { playable: true, hourlyUsd: 1.512 })).toBe(
      'Session ‘Luna’ is broadcasting ‘Orbit Escape’. Ending that broadcast also stops the watch windows on it. The new broadcast ends by itself after at most 45 min. '
      + 'Starts the playable server (about $1.51/hour while it is on). End that broadcast and broadcast this game?');
    expect(takeoverText(null)).toBe('Another of your sessions is on air. Ending that broadcast also stops the watch windows on it. '
      + 'The new broadcast ends by itself after at most 45 min. End that broadcast and broadcast this game?');
  });

  it('the play window: its bar off air, and the toast and the bar after 라이브 켜기', async () => {
    const { PlayWindow } = await import('./components/PlayWindow');
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ fillRect() {}, fillText() {} } as never);
    vi.stubGlobal('AudioContext', class {
      createMediaStreamDestination() { return { stream: {} }; }
      createGain() { return { gain: { value: 1 }, connect: (n: unknown) => n }; }
      createOscillator() { return { connect: (n: unknown) => n }; }
      close() { return Promise.resolve(); }
    });
    api.liveStart.mockResolvedValue({ ...onAir(), channelState: 'STARTING' });
    history.replaceState(null, '', '/#play=ses_1&g=gm_1');
    await act(async () => root.render(<PlayWindow sessionId="ses_1" gameId="gm_1" />));
    await tick();
    expect(document.title).toBe('Play window · Orbit Escape');
    const bar = () => container.querySelector('.popup-bar')!.textContent;
    expect(bar()).toContain('Orbit Escape Play window');
    expect(bar()).toContain('Off air');
    expect(bar()).toContain('Rounds finished: 0 · 0 ads');
    expect(bar()).toContain('Ad everyrounds');
    expect(bar()).toContain('Ends by itself after at most 45 min');
    expect(bar()).toContain('● Go live');
    expect(bar()).toContain('Open watch window ↗');
    expect(hangul(container)).toEqual([]);
    // on air: the game's frame has a canvas to send
    const frame = container.querySelector('iframe')!;
    const canvas = Object.assign(document.createElement('canvas'), { captureStream: () => ({ getTracks: () => [] }) });
    Object.defineProperty(frame, 'contentWindow', { value: Object.assign(new EventTarget(), { ipverseCapture: () => canvas, document: { querySelector: () => null } }) });
    api.liveStatus.mockResolvedValue(onAir());
    await click(container.querySelector('.popup-bar .live-toggle'));
    await tick(5000);
    expect([...container.querySelectorAll('.toast-text')].map((x) => x.textContent)).toContain('You are live. It shows in the watch window in 10–20 s.');
    expect(bar()).toContain('■ End live');
    expect(bar()).toMatch(/Ends in \d+:\d\d/);
    expect(hangul(container)).toEqual([]);
  });

  it('the play window says in English what a round did, and what went wrong with the picture', async () => {
    const { SEND_ISSUE_TEXT, dropText } = await import('./liveQuality');
    expect(Object.values(SEND_ISSUE_TEXT).join(' ')).not.toMatch(/[가-힣]/);
    expect(dropText({ width: 480, height: 270, bitrate: 3e4, fps: 30 }, true)).toBe('low quality 480×270');
    expect(dropText({ width: 1280, height: 720, bitrate: 2e6, fps: 30 }, false)).toBe('quality recovering');
  });

  it('the watch window on air: the four viewers with their ads and reasons, the chips, the record of ads', async () => {
    const { WatchWindow } = await import('./components/WatchWindow');
    api.liveStatus.mockResolvedValue(onAir({}, [adBreak(2), adBreak(3, { kind: 'corner' as never, endToAdSec: undefined }), adBreak(4, { kind: 'skip' as never, reason: 'no_room' as never })]));
    history.replaceState(null, '', '/#watch=ses_1');
    await act(async () => root.render(<WatchWindow sessionId="ses_1" />));
    await tick();
    await tick(100);
    expect(document.title).toBe('Watch window · IPverse Studio');
    expect(container.querySelector('.popup-title')?.textContent).toBe('Watch window 4 simulated viewers get different ads in the same broadcast');
    expect([...container.querySelectorAll('.view-switch [role="tab"]')].map((b) => b.textContent)).toEqual(['4 simulated viewers', 'One viewer']);
    const rows = [...container.querySelectorAll('.watch-breaks li strong')].map((s) => s.textContent);
    expect(rows).toEqual(['Round 4 · Trailer skipped · too close to the next ad', 'Round 3 · Corner trailer', 'Round 2 · Full-screen trailer']);
    expect(container.querySelector('.watch-breaks li:last-child span')?.textContent).toContain('2 different ads, one per viewer · 16 s · 1.4 s after the round ended');
    const chips = Object.fromEntries([...container.querySelectorAll('.watch-side .live-chips > div')].map((d) => [d.querySelector('dt')!.textContent, d.querySelector('dd')!.textContent]));
    expect(chips).toMatchObject({ Video: 'the play window’s game', Broadcast: 'LIVE', Finished: '3 rounds', 'Next ad in': '1 round', 'Ad style': 'Full-screen trailer + Corner trailer' });
    expect(container.querySelectorAll('.vt')).toHaveLength(4);
    expect(container.querySelector('.vt')?.getAttribute('aria-label')).toBe('Simulated viewer Minji');
    expect(container.querySelector('.vt .vt-ads li')?.textContent).toContain('likes this genre'); // the server's reason, as given
    expect([...container.querySelectorAll('.vt .vt-chips li')].slice(0, 4).map((li) => li.textContent)).toEqual(['25-34', 'Seoul', 'Mobile', 'Action RPG']);
    expect(hangul(container)).toEqual([]);
    await click(container.querySelector('#watch-view-one'));
    expect(hangul(container)).toEqual([]);
  });

  it('the watch window off air: what to press, and that nothing went out yet', async () => {
    const { WatchWindow } = await import('./components/WatchWindow');
    history.replaceState(null, '', '/#watch=ses_1');
    await act(async () => root.render(<WatchWindow sessionId="ses_1" />));
    await tick();
    expect(container.querySelector('.live-idle')?.textContent).toBe('The broadcast is off. Press ‘Go live’ in the studio’s live broadcast window or in the play window.');
    expect(container.querySelector('.watch-side')?.textContent).toContain('No ad has gone out yet. Once live, each viewer gets a different ad every set number of rounds.');
    expect(hangul(container)).toEqual([]);
  });

  it('the ad overlays: the playable card in its states, the corner ad, the limit and the clock', async () => {
    const { PlayableCard, CornerAd, prepText } = await import('./components/AdOverlays');
    const { LiveLimit } = await import('./components/LiveLimit');
    const { LiveClock } = await import('./components/LiveClock');
    const warned: string[] = [];
    await act(async () => root.render(<>
      <PlayableCard title="Boss Raid" seconds={90} reason="likes action" state={{ kind: 'idle' }} onPlay={vi.fn()} />
      <PlayableCard title="Boss Raid" seconds={90} state={{ kind: 'queued', position: 2 }} onPlay={vi.fn()} onTrailer={vi.fn()} onCancel={vi.fn()} />
      <CornerAd url="https://cdn/t.mp4" title="Dune Ruins" onDone={vi.fn()} />
      <LiveLimit job={{ secondsLeft: 290, maxMinutes: 45 }} onWarn={(text) => warned.push(text)} />
      <LiveClock />
    </>));
    const text = container.textContent ?? '';
    for (const said of ['Boss Raid · play now', 'Why: likes action', '▶ Play now (90 s)', 'No. 2 in line', 'It starts as soon as a seat is free', 'Watch trailer', 'Cancel',
      'Game coming soon', '4:50', 'Now ']) expect(text).toContain(said);
    expect(warned).toEqual(['The broadcast ends by itself in 5 min (at most 45 min at a time). To go on, go live again after it ends.']);
    expect(prepText(Date.now() + 8000)).toBe('Preparing · about 8 s');
    expect(prepText(Date.now() - 60_000)).toBe('Starting the server · a first start takes 4–6 min');
    expect(hangul(container)).toEqual([]);
  });
});
