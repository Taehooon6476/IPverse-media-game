import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveState, StandbyState } from './api';
import { GameModal } from './components/GameModal';
import type { Asset, Game } from './types';

const api = vi.hoisted(() => ({
  liveStatus: vi.fn(), liveStandby: vi.fn(), setLiveStandby: vi.fn(), liveAdSettings: vi.fn(),
  highlightSettings: vi.fn(), liveStop: vi.fn(), liveViewer: vi.fn(),
}));
vi.mock('./api', () => api);
vi.mock('./components/IvsPlayer', () => ({ IvsPlayer: () => null })); // the IVS player (wasm) is not under test

const game = { gameId: 'gm_1', title: '루나의 궤도 탈출', genre: 'sf-shooter', specKey: 'games/gm_1/spec.json', previewUrl: 'blob:game',
  createdAt: '2026-11-05T00:00:00Z' } as Game;
const trailer = { assetId: 'ast_t', kind: 'trailer', key: 'k', url: 'https://cdn/t.mp4', contentType: 'video/mp4', meta: {},
  createdAt: '2026-11-05T00:00:00Z' } as Asset;
const idle: LiveState = { active: false, channelState: 'IDLE', playbackUrl: '', job: null, stream: null };
const onAir = (job: Partial<NonNullable<LiveState['job']>> = {}): LiveState => ({
  active: true, mode: 'player', channelState: 'STARTING', playbackUrl: '',
  job: { gameId: 'gm_1', everyRounds: 3, adSeconds: 10, startedAt: '2026-11-05T00:00:00Z', adType: 'trailer', highlightGen: true, highlightAuto: 'overlay', ...job },
  stream: { state: 'live', rounds: 2, breaks: [], updatedAt: '2026-11-05T00:00:00Z' } });
const off: StandbyState = { on: false, state: 'off', idle: 0, allocated: 0, max: 2, mode: 'auto', hourlyUsd: 0.52 };

let container: HTMLDivElement;
let root: Root;
const onNotice = vi.fn();
const onError = vi.fn();
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  localStorage.clear();
  history.replaceState(null, '', '/');
  HTMLMediaElement.prototype.play = () => Promise.resolve(); // the mirror of the play window's canvas (jsdom plays nothing)
  api.liveStatus.mockResolvedValue(idle);
  api.liveStandby.mockResolvedValue(off);
  api.setLiveStandby.mockResolvedValue(off); // the 플레이어블 tab's 미리 켜기 and the switch in 고급 설정 ask
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function render(assets: Asset[] = [trailer]) {
  await act(async () => root.render(<GameModal sessionId="ses_1" game={game} url="blob:game" assets={assets}
    onClose={vi.fn()} onError={onError} onNotice={onNotice} />));
  await act(async () => undefined); // the first GET /live and GET /live/standby
}
const head = () => container.querySelector<HTMLButtonElement>('#live-adv-head')!;
const region = () => container.querySelector<HTMLElement>('#live-adv-region')!;
const find = (selector: string, text: string) => [...container.querySelectorAll<HTMLElement>(selector)].find((el) => el.textContent?.includes(text));

describe('live control room: the main flow stays in sight, the rest folds under 고급 설정', () => {
  it('keeps the ad tabs, N판마다, 라이브 켜기 and the play/watch windows visible; 고급 설정 starts folded', async () => {
    await render();
    expect(container.querySelector('#adtype-tab-trailer')).not.toBeNull();
    expect(container.querySelector('#adtype-tab-playable')).not.toBeNull();
    expect(region().contains(container.querySelector('input[type="number"]'))).toBe(false);
    for (const label of ['▶ 플레이 창 열기', '◉ 시청 창 열기', '● 라이브 켜기']) expect(region().contains(find('button', label)!)).toBe(false);

    expect(head().textContent).toContain('고급 설정');
    expect([head().getAttribute('aria-expanded'), head().getAttribute('aria-controls')]).toEqual(['false', 'live-adv-region']);
    expect(region().hasAttribute('inert')).toBe(true); // folded controls are not reachable by Tab
    expect(region().textContent).toContain('MediaTailor'); // how the trailer ad works
    expect(container.querySelector('[role="dialog"]')!.getAttribute('aria-describedby')).toBe('game-modal-hint');
    expect(region().contains(container.querySelector('#game-modal-hint'))).toBe(false); // the dialog's description is not inert
    expect(region().querySelector('[role="switch"]')).toBeNull(); // the playable server belongs to the playable tab
  });

  it('without a trailer, the reason 라이브 켜기 is off stays in sight', async () => {
    await render([]);
    expect(find('button', '트레일러가 필요해요')!.hasAttribute('disabled')).toBe(true);
    const hint = container.querySelector('.live-need[role="status"]')!; // above the ad styles, with the way out
    expect(hint.textContent).toContain('‘플레이어블 광고’ 탭에서 시작하세요');
    expect(region().contains(hint)).toBe(false);
  });

  it('playable: 체험 길이 stays out; the server switch, its status and cost fold in, with its state in the header', async () => {
    history.replaceState(null, '', '/#adtype=playable');
    await render();
    expect(region().contains(find('label', '체험 길이')!.querySelector('select'))).toBe(false);
    const sw = region().querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(region().textContent).toContain('방송 전에 켜 두면 첫 카드부터 바로 열려요');
    // the switch starts a paid host: its price is beside it before the press, not only once it is on
    expect(region().querySelector('.standby-cost')!.textContent).toContain('켜 둔 동안 GPU 1대당 시간당 약 $0.52');
    expect(head().textContent).toContain('플레이어블 서버 OFF');

    await act(async () => head().click());
    expect(head().getAttribute('aria-expanded')).toBe('true');
    expect(region().hasAttribute('inert')).toBe(false);
    expect(localStorage.getItem('ipverse.liveAdvOpen')).toBe('1');

    api.setLiveStandby.mockResolvedValueOnce({ ...off, on: true, state: 'warming', allocated: 1 });
    await act(async () => sw.click());
    expect(api.setLiveStandby).toHaveBeenLastCalledWith('ses_1', true);
    expect(onNotice).toHaveBeenLastCalledWith(expect.stringContaining('플레이어블 서버를 준비하고 있어요'));
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(head().textContent).toContain('플레이어블 서버 준비 중');
    expect(region().textContent).toContain('시간당 약 $0.52');

    api.setLiveStandby.mockResolvedValueOnce(off);
    await act(async () => sw.click());
    expect(api.setLiveStandby).toHaveBeenLastCalledWith('ses_1', false);
    // no 되돌리기 on this toast: it would turn the paid server on again with no price on it. The way back is the switch
    const [text, undo] = onNotice.mock.lastCall!;
    expect(text).toContain('플레이어블 서버를 내렸어요');
    expect(undo).toBeUndefined();
    expect(region().querySelector('.standby-cost')!.textContent).toContain('시간당 약 $0.52');
    api.setLiveStandby.mockResolvedValueOnce({ ...off, on: true, state: 'ready', idle: 1, allocated: 1 });
    await act(async () => sw.click());
    expect(api.setLiveStandby).toHaveBeenLastCalledWith('ses_1', true);
    expect(head().textContent).toContain('플레이어블 서버 ON');
  });

  it('on air: 변경 적용 stays out; the highlight shorts fold in and show in the header', async () => {
    api.liveStatus.mockResolvedValue(onAir());
    api.liveAdSettings.mockResolvedValue(onAir({ everyRounds: 4 }));
    await render();
    expect(find('button', '■ 라이브 끄기')).toBeTruthy();
    const n = container.querySelector<HTMLInputElement>('input[type="number"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(n, '4');
      n.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const apply = find('.ad-type-fields button', '변경 적용')!;
    expect(region().contains(apply)).toBe(false);
    await act(async () => apply.click());
    expect(api.liveAdSettings).toHaveBeenCalledWith('ses_1', { adType: 'trailer', everyRounds: 4, playableSeconds: 90, corner: false });

    const shorts = find('label', '하이라이트 쇼츠')!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(region().contains(shorts)).toBe(true);
    expect(shorts.checked).toBe(true);
    expect(head().textContent).toContain('쇼츠 오버레이로 송출');

    api.highlightSettings.mockResolvedValue({ auto: 'overlay', generate: false });
    api.liveStatus.mockResolvedValue(onAir({ everyRounds: 4, highlightGen: false }));
    await act(async () => head().click());
    await act(async () => shorts.click());
    expect(api.highlightSettings).toHaveBeenCalledWith('ses_1', { generate: false });
    expect(head().textContent).toContain('쇼츠 끔');
  });

  it('keeps polling GET /live/standby while folded, and a server that gets ready still says so', async () => {
    vi.useFakeTimers();
    history.replaceState(null, '', '/#adtype=playable');
    await render();
    expect(api.liveStandby).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(api.liveStandby).toHaveBeenCalledTimes(2);

    api.liveStandby.mockResolvedValue({ ...off, on: true, state: 'ready', idle: 1, allocated: 1 });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(head().getAttribute('aria-expanded')).toBe('false');
    expect(head().textContent).toContain('플레이어블 서버 ON');
    expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('플레이어블 서버가 준비됐어요'));
  });

  it('says 방송을 끄면 자동으로 내려요 only under a broadcast; a hold names its minute and reads OFF once it went (round 18)', async () => {
    // a held host with its time up and nothing on air must not promise "방송을 끄면 자동으로 내려요"
    vi.useFakeTimers();
    history.replaceState(null, '', '/#adtype=playable');
    const ready: StandbyState = { ...off, on: true, state: 'ready', idle: 1, allocated: 1 };
    const until = new Date(2026, 10, 11, 11, 58, 42).getTime() / 1000;
    const held: StandbyState = { ...ready, mode: 'on', prewarm: true, until };
    api.liveStandby.mockResolvedValue(held);
    api.setLiveStandby.mockResolvedValue(held);
    await render();
    expect(region().textContent).toContain('11:58에 자동으로 내려요');
    expect(region().textContent).not.toContain('방송을 끄면');

    api.liveStandby.mockResolvedValue(ready); // held with its time up and no broadcast: no word about one
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(region().textContent).toContain('준비 완료 · 대기 GPU 1대');
    expect(region().textContent).not.toContain('자동으로 내려요');

    api.liveStandby.mockResolvedValue({ ...off, allocated: 1 }); // the poll that ended the hold (server/live.py _lapse_hold)
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(head().textContent).toContain('플레이어블 서버 OFF');
    expect(region().textContent).toContain('꺼짐 · 사용 중인 GPU 1대 정리 중');

    api.liveStandby.mockResolvedValue(ready); // a playable broadcast holds it: the stop takes it down
    api.liveStatus.mockResolvedValue(onAir({ adType: 'playable', playableSeconds: 60 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(find('button', '■ 라이브 끄기')).toBeTruthy();
    expect(region().textContent).toContain('방송을 끄면 자동으로 내려요');
  });
});

/** A play window as the console finds it behind window.open: its handle, and what the test moves (on air, rounds).
 * The one before it is closed: the console keeps its play window across its own mounts. */
let lastPlay: { closed: boolean } | null = null;
function fakePlayWindow(over: Record<string, unknown> = {}) {
  if (lastPlay) lastPlay.closed = true;
  const play = { onAir: false, rounds: 0, closed: false, start: vi.fn(async (..._a: unknown[]) => { play.onAir = true; }),
    stop: vi.fn(async () => { play.onAir = false; }) };
  lastPlay = play;
  const canvas = Object.assign(document.createElement('canvas'), { captureStream: () => ({}) }); // jsdom has no captureStream
  const w = { get closed() { return play.closed; }, focus: vi.fn(),
    location: { href: 'about:blank', get hash() { return this.href.includes('#') ? this.href.slice(this.href.indexOf('#')) : ''; } },
    __ipverse: { canvas: () => canvas, captured: () => true, start: (...a: unknown[]) => play.start(...a),
      stop: () => play.stop(), state: () => ({ onAir: play.onAir, rounds: play.rounds }), ...over } };
  vi.stubGlobal('open', vi.fn(() => w));
  return Object.assign(play, { window: w });
}

// The two buttons share one place in the tree: one's busy and done state must not show with the other's labels.
describe('the start/stop button never shows the other button\'s state (R20-07)', () => {
  const toggle = () => container.querySelector<HTMLButtonElement>('.live-toggle')!;

  it('stays 플레이 창 준비 중… until the start is through, then is ■ 라이브 끄기', async () => {
    vi.useFakeTimers();
    const play = fakePlayWindow();
    let started: () => void = () => undefined;
    play.start.mockImplementation(() => new Promise<void>((r) => { started = () => { play.onAir = true; r(); }; }));
    await render();
    await act(async () => { toggle().click(); await vi.advanceTimersByTimeAsync(600); });
    expect(toggle().textContent).toContain('플레이 창 준비 중…');
    // the server holds the job and the play window says on air before start() has resolved (the publish is still on)
    play.onAir = true;
    api.liveStatus.mockResolvedValue(onAir());
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) { await act(async () => { await vi.advanceTimersByTimeAsync(1000); }); seen.push(toggle().textContent ?? ''); }
    expect(seen.filter((t) => /끄는 중|꺼짐/.test(t))).toEqual([]);
    expect(toggle().textContent).toContain('플레이 창 준비 중…');
    await act(async () => { started(); await vi.advanceTimersByTimeAsync(0); });
    for (let i = 0; i < 3; i++) { await act(async () => { await vi.advanceTimersByTimeAsync(1000); }); seen.push(toggle().textContent ?? ''); }
    expect(seen.filter((t) => /끄는 중|꺼짐/.test(t))).toEqual([]);
    expect(toggle().textContent).toBe('■ 라이브 끄기');
    expect(toggle().disabled).toBe(false);
  });

  it('after a stop it is ● 라이브 켜기 again, never ✓ 송출 중', async () => {
    vi.useFakeTimers();
    const play = fakePlayWindow();
    play.onAir = true;
    api.liveStatus.mockResolvedValue(onAir());
    await render();
    await act(async () => find('button', '▶ 플레이 창 열기')!.click()); // the console attaches to its play window
    // the stop lands just before the console's next status poll (every 4 s): that poll then says off air inside the
    // 2 s the button shows what it did
    await act(async () => { await vi.advanceTimersByTimeAsync(3400); });
    expect(toggle().textContent).toBe('■ 라이브 끄기');
    play.stop.mockImplementation(async () => { play.onAir = false; api.liveStatus.mockResolvedValue(idle); });
    const seen: string[] = [];
    await act(async () => { toggle().click(); await vi.advanceTimersByTimeAsync(0); });
    for (let i = 0; i < 6; i++) { seen.push(toggle().textContent ?? ''); await act(async () => { await vi.advanceTimersByTimeAsync(500); }); }
    expect(seen.filter((t) => t.includes('송출 중'))).toEqual([]);
    expect(toggle().textContent).toBe('● 라이브 켜기');
  });
});

describe('what the play window says reaches the console\'s toast as it was said (C-04)', () => {
  it('an error thrown in the play window keeps its sentence, without "Error:" in front', async () => {
    const play = fakePlayWindow();
    const sentence = '이 세션에 트레일러가 아직 없어요. 영상 탭의 ‘연출해서 만들기’로 트레일러를 만든 뒤 다시 눌러 주세요.';
    // an Error of the play window's realm is not `instanceof Error` in the studio's: the app printed String(e)
    play.start.mockRejectedValue({ name: 'Error', message: sentence, toString: () => `Error: ${sentence}` });
    await render();
    await act(async () => find('button', '● 라이브 켜기')!.click());
    await act(async () => undefined);
    const said = onError.mock.lastCall![0];
    expect(said).toBeInstanceOf(Error);
    expect((said as Error).message).toBe(sentence);
  });
});

// The play window's own 라이브 켜기 asks the console, through its opener, for the tab and values a start would send.
describe('the console tells its play window what a start would send (R20-34)', () => {
  type Handle = { settings: (sessionId: string, gameId: string) => object | null };
  const handle = () => (window as unknown as { __ipverseConsole?: Handle }).__ipverseConsole;

  it('its tab and values for this session\'s game, and nothing for another one or once it is closed', async () => {
    await render();
    expect(handle()!.settings('ses_1', 'gm_1')).toEqual({ everyRounds: 2, adType: 'trailer', playableSeconds: 90, corner: true });
    await act(async () => container.querySelector<HTMLButtonElement>('#adtype-tab-corner')!.click());
    const n = container.querySelector<HTMLInputElement>('input[type="number"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(n, '4');
      n.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(handle()!.settings('ses_1', 'gm_1')).toEqual({ everyRounds: 4, adType: 'corner', playableSeconds: 90, corner: false });
    expect(handle()!.settings('ses_2', 'gm_1')).toBeNull();
    expect(handle()!.settings('ses_1', 'gm_other')).toBeNull();
    await act(async () => root.render(null));
    expect(handle()).toBeUndefined();
  });
});

describe('the ad style per broadcast: 전체 화면 트레일러 | 플레이어블 | 코너 트레일러, plus N rounds', () => {
  /** A play window the control room opens (window.open) and starts the broadcast through. */
  const playWindow = () => fakePlayWindow().start;
  const tab = (id: string) => container.querySelector<HTMLButtonElement>(`#adtype-tab-${id}`)!;
  const cornerBox = () => find('label', '다른 판에는 코너 트레일러')?.querySelector<HTMLInputElement>('input');

  it('offers the three styles; a trailer broadcast starts with a corner trailer at every other round by default', async () => {
    const start = playWindow();
    await render();
    expect([...container.querySelectorAll('[role="tablist"][aria-label="광고 스타일"] [role="tab"]')].map((t) => t.textContent))
      .toEqual(['전체 화면 트레일러', '플레이어블 광고', '코너 트레일러']);
    expect(cornerBox()!.checked).toBe(true);
    await act(async () => find('button', '● 라이브 켜기')!.click());
    await act(async () => undefined);
    expect(start).toHaveBeenCalledWith(2, 'trailer', 90, true);
  });

  it('코너 트레일러 starts a corner broadcast; its copy says the player draws it, not MediaTailor', async () => {
    const start = playWindow();
    await render();
    await act(async () => tab('corner').click());
    expect(cornerBox()).toBeUndefined(); // the corner every round is the trailer style's extra
    expect(region().textContent).toContain('광고 구간·MediaTailor 없이 플레이어가 그려요');
    await act(async () => find('button', '● 라이브 켜기')!.click());
    await act(async () => undefined);
    expect(start).toHaveBeenCalledWith(2, 'corner', 90, false);
  });

  it('on air the style and the corner extra change with 변경 적용', async () => {
    api.liveStatus.mockResolvedValue(onAir());
    api.liveAdSettings.mockResolvedValue(onAir({ corner: true }));
    await render();
    expect(cornerBox()!.checked).toBe(false); // the broadcast's own spec
    await act(async () => cornerBox()!.click());
    await act(async () => find('.ad-type-fields button', '변경 적용')!.click());
    expect(api.liveAdSettings).toHaveBeenLastCalledWith('ses_1', { adType: 'trailer', everyRounds: 3, playableSeconds: 90, corner: true });
    expect(onNotice).toHaveBeenLastCalledWith(expect.stringContaining('다른 판에는 코너 트레일러'));
    await act(async () => tab('corner').click());
    await act(async () => find('.ad-type-fields button', '변경 적용')!.click());
    expect(api.liveAdSettings).toHaveBeenLastCalledWith('ses_1', { adType: 'corner', everyRounds: 3, playableSeconds: 90, corner: false });
  });
});
