// The console's handle on its play window lives in the studio page: after a reload it has none, and must not call a
// play window that is still open and broadcasting closed. Each test loads the console's module anew (and React with
// it), so its handle is empty.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveState, StandbyState } from './api';
import type { ConsoleHandle } from './liveSettings';
import type { Asset, Game } from './types';

const api = vi.hoisted(() => ({
  liveStatus: vi.fn(), liveStandby: vi.fn(), setLiveStandby: vi.fn(), liveAdSettings: vi.fn(),
  highlightSettings: vi.fn(), liveStop: vi.fn(), liveViewer: vi.fn(),
}));
vi.mock('./api', () => api);
vi.mock('./components/IvsPlayer', async () => {
  const { createElement } = await import('react');
  return { IvsPlayer: () => createElement('video', { 'data-ivs': '' }) };
});

const game = { gameId: 'gm_1', title: '루나의 궤도 탈출', genre: 'sf-shooter', specKey: 'games/gm_1/spec.json', previewUrl: 'blob:game',
  createdAt: '2026-11-05T00:00:00Z' } as Game;
const trailer = { assetId: 'ast_t', kind: 'trailer', key: 'k', url: 'https://cdn/t.mp4', contentType: 'video/mp4', meta: {},
  createdAt: '2026-11-05T00:00:00Z' } as Asset;
const idle: LiveState = { active: false, channelState: 'IDLE', playbackUrl: '', job: null, stream: null };
const onAir: LiveState = { active: true, mode: 'player', channelState: 'RUNNING', playbackUrl: 'https://ivs/x.m3u8?token=t',
  job: { jobId: 'job_1', gameId: 'gm_1', adTitle: '루나의 궤도 탈출', everyRounds: 2, adSeconds: 10, startedAt: '2026-11-05T00:00:00Z', adType: 'trailer', roundBase: 0 },
  stream: { state: 'live', rounds: 1, breaks: [], updatedAt: '2026-11-05T00:00:00Z' } };
const off: StandbyState = { on: false, state: 'off', idle: 0, allocated: 0, max: 2, mode: 'auto', hourlyUsd: 1.512 };

/** The play window as it is after the studio's reload: still open on its game, on air, not known to the new page. */
function openPlayWindow(gameId = 'gm_1') {
  const play = { closed: false, onAir: true, rounds: 1 };
  const canvas = Object.assign(document.createElement('canvas'), { captureStream: () => ({}) }); // jsdom has no captureStream
  const w = { get closed() { return play.closed; }, focus: vi.fn(), location: { hash: `#play=ses_1&g=${gameId}` },
    __ipverse: { canvas: () => canvas, captured: () => true, start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined),
      state: () => ({ onAir: play.onAir, rounds: play.rounds, waiting: false, hidden: false }) } };
  return Object.assign(play, { window: w as unknown as Window });
}

const onNotice = vi.fn();
let unmount: () => Promise<void> = async () => undefined;
/** The studio after a reload, with the console opened on the game. */
async function reloadStudio() {
  vi.resetModules();
  const [{ act, createElement }, { createRoot }, { GameModal }] = await Promise.all([import('react'), import('react-dom/client'), import('./components/GameModal')]);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const tick = (ms = 1000) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  await act(async () => root.render(createElement(GameModal, { sessionId: 'ses_1', game, url: 'blob:game', assets: [trailer],
    onClose: vi.fn(), onError: vi.fn(), onNotice })));
  await tick(0); // the first GET /live and GET /live/standby
  unmount = async () => { await act(async () => root.unmount()); container.remove(); };
  const chip = (name: string) => [...container.querySelectorAll('.live-chips > div')].find((d) => d.querySelector('dt')?.textContent === name)
    ?.querySelector('dd')?.textContent;
  return { container, tick, chip, stage: () => container.querySelector('#game-modal-stage')!,
    console: () => (window as unknown as { __ipverseConsole: ConsoleHandle }).__ipverseConsole };
}
const notices = () => onNotice.mock.calls.map((c) => c[0] as string);

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  localStorage.clear();
  history.replaceState(null, '', '/');
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  api.liveStatus.mockResolvedValue(onAir);
  api.liveStandby.mockResolvedValue(off);
  api.liveViewer.mockResolvedValue({ warmed: false });
  api.liveStop.mockResolvedValue(idle);
});
afterEach(async () => {
  await unmount();
  unmount = async () => undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('after a studio reload the console says what is true of a play window it has no handle on', () => {
  it('on air it does not call the play window closed: 연결 안 됨, and the stage says how to connect again', async () => {
    const page = await reloadStudio();
    await page.tick(4000);
    expect(page.chip('방송 상태')).toBe('방송 중');
    expect(page.chip('플레이 창')).toBe('연결 안 됨');
    expect(page.stage().textContent).toContain('방송 중이에요. 이 창이 플레이 창과 연결되어 있지 않아서 게임 화면을 보여 드리지 못해요. ‘플레이 창 열기’를 누르면 다시 연결해요.');
    expect([...page.stage().querySelectorAll('button')].map((b) => b.textContent)).toEqual(['▶ 플레이 창 열기']);
  });

  it('off air a play window it does not know of is 닫힘, as before', async () => {
    api.liveStatus.mockResolvedValue(idle);
    const page = await reloadStudio();
    await page.tick(4000);
    expect(page.chip('플레이 창')).toBe('닫힘');
    expect(page.stage().textContent).toContain('플레이 창에서 게임을 해요.');
    expect([...page.stage().querySelectorAll('button')].map((b) => b.textContent)).toContain('▶ 플레이 창 열기');
  });

  it('a broadcast that ends then is not blamed on a closed play window', async () => {
    const page = await reloadStudio();
    await page.tick(4000);
    api.liveStatus.mockResolvedValue(idle); // the 45-minute cap, or 라이브 끄기 in the play window, which stays open
    await page.tick(4000);
    expect(notices()).toEqual(['방송이 꺼졌어요. 다시 하려면 ‘라이브 켜기’를 눌러 주세요.']);
  });
});

describe('the console gets its play window back after a studio reload', () => {
  it('the play window says it is there: mirrored again within a second, and its close after that is said as one', async () => {
    const play = openPlayWindow();
    const page = await reloadStudio();
    page.console().attach!(play.window, 'ses_1', 'gm_1'); // what the play window does every second (PlayWindow.tsx)
    await page.tick();
    expect(page.chip('플레이 창')).toBe('열림');
    expect(page.stage().querySelector<HTMLVideoElement>('video[aria-label="플레이 창 게임 화면"]')!.hidden).toBe(false);
    expect(page.stage().textContent).not.toContain('연결되어 있지 않아서');
    play.closed = true; // Cmd+W: its pagehide ends the job on the server
    api.liveStatus.mockResolvedValue(idle);
    await page.tick(2000);
    expect(notices()).toEqual(['플레이 창이 닫혀서 방송이 꺼졌어요. 다시 하려면 ‘라이브 켜기’를 눌러 주세요.']);
  });

  it("a play window on another game or session is not this console's", async () => {
    const other = openPlayWindow('gm_other');
    const page = await reloadStudio();
    page.console().attach!(other.window, 'ses_1', 'gm_other');
    page.console().attach!(openPlayWindow().window, 'ses_other', 'gm_1');
    await page.tick();
    expect(page.chip('플레이 창')).toBe('연결 안 됨');
  });

  it('a console that has its play window keeps it: the window that says hello again changes nothing', async () => {
    const play = openPlayWindow();
    const page = await reloadStudio();
    page.console().attach!(play.window, 'ses_1', 'gm_1');
    await page.tick();
    const twin = openPlayWindow();
    twin.onAir = false;
    page.console().attach!(twin.window, 'ses_1', 'gm_1');
    play.closed = true;
    api.liveStatus.mockResolvedValue(idle);
    await page.tick(2000);
    expect(notices()).toEqual(['플레이 창이 닫혀서 방송이 꺼졌어요. 다시 하려면 ‘라이브 켜기’를 눌러 주세요.']); // the first one's close
  });
});
