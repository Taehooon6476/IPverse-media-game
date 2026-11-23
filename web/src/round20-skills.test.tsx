import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSession, runTool, runToolAsync } from './api';
import { SkillsDrawer } from './components/SkillsDrawer';
import { SKILLS } from './skills';
import type { Asset, Ip, Job, Message, Snapshot } from './types';

// 장르 스킬: a click that queues several image and 3D chains says the count and the time and asks first, a disabled
// button says why, the wait line does not claim the launch loop survives a closed window, and one failed poll does
// not re-enable the button while the queue still drains.
vi.mock('./api', () => ({ getSession: vi.fn(), runTool: vi.fn(), runToolAsync: vi.fn() }));

const at = '2026-11-16T03:00:00Z';
const ip = (ipId: string, kind: Ip['kind'], name: string, extra: Partial<Ip> = {}): Ip => ({ ipId, kind, name, description: '', version: 1,
  imageAssetId: `${ipId}_img`, createdAt: at, ...extra });
const glb = (assetId: string, ipId: string): Asset => ({ assetId, kind: 'glb', key: `k/${assetId}`, url: `/u/${assetId}`, contentType: '', ipId, meta: {}, createdAt: at });
const job = (jobId: string, kind: Job['kind'], ipId: string, status: Job['status']): Job => ({ jobId, kind, provider: 'img3d', status, input: { ipId },
  outputs: [], deps: [], progress: '', error: status === 'failed' ? 'GPU busy' : undefined, createdAt: at, updatedAt: at });
let sid = 0;
const session = (ips: Ip[] = [], jobs: Job[] = [], assets: Asset[] = [], messages: Message[] = []) => ({
  session: { sessionId: `ses_skill_${++sid}`, title: 't', genre: 'sf-shooter', createdAt: at }, messages, games: [], assets, ips, jobs }) as Snapshot;
const lira = ip('ip_lira', 'character', '리라');
const liraReady = { ...lira, glbAssetId: 'lira_glb', riggedGlbAssetId: 'lira_rig' };
const liraFiles = [glb('lira_glb', 'ip_lira'), { ...glb('lira_rig', 'ip_lira'), kind: 'rigged_glb' as const }];
const racing = SKILLS.find((s) => s.id === 'racing')!;
const madeAll = (skill = racing) => skill.assets.map((a, i): Ip => ip(`ip_a${i}`, a.kind, a.name, { glbAssetId: `glb_a${i}` }));
const filesOf = (ips: Ip[]) => ips.map((x) => glb(x.glbAssetId!, x.ipId));

let container: HTMLDivElement;
let root: Root;
let onNotice: ReturnType<typeof vi.fn>;
let onError: ReturnType<typeof vi.fn>;
let onSend: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  onNotice = vi.fn();
  onError = vi.fn();
  onSend = vi.fn(async () => undefined);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});
const show = (snap: Snapshot) => act(async () => root.render(<SkillsDrawer snap={snap} onClose={vi.fn()} onSend={onSend as never} onNotice={onNotice as never}
  onError={onError as never} onChat={vi.fn()} />));
const button = (text: string, within: ParentNode = document) => [...within.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes(text))!;
const openSkill = (title: string) => act(async () => button(title, container.querySelector('.skill-cards')!).click());
const step = (n: number) => container.querySelectorAll<HTMLDetailsElement>('.skill-step')[n];
const confirm = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
/** make_skill_asset answers at once with its status line's id; that line settles on the next poll. */
function launching() {
  let started = 0;
  vi.mocked(runToolAsync).mockImplementation(async () => ({ messageId: `msg_${++started}` }));
  vi.mocked(getSession).mockImplementation(async () => ({ messages: Array.from({ length: started }, (_, i) => ({ messageId: `msg_${i + 1}`, status: 'done' })) }) as Snapshot);
  return () => vi.mocked(runToolAsync).mock.calls.map(([, , args]) => String(args.name));
}

describe('R20-38 장르 스킬 says what its button starts and asks before it starts', () => {
  it('counts what it will make and how long that takes on the button', async () => {
    await show(session([liraReady], [], liraFiles));
    await openSkill('레이싱');
    expect(button('만들기 ·', step(1)).textContent).toBe('IP 5개 만들기 · 약 60분');
    await openSkill('레이싱');
    await openSkill('핵앤슬래시 던전');
    expect(button('만들기 ·', step(1)).textContent).toBe('IP 6개 만들기 · 약 72분');
  });

  it('asks first with the pictures, the 3D models and the time, and starts nothing on 취소', async () => {
    const launched = launching();
    await show(session([liraReady], [], liraFiles));
    await openSkill('레이싱');
    await act(async () => button('만들기 ·', step(1)).click());
    expect(runToolAsync).not.toHaveBeenCalled();
    expect(confirm()!.querySelector('h2')!.textContent).toBe('레이싱 스킬의 IP 5개를 만들까요?');
    expect(confirm()!.querySelector('.dialog-lead')!.textContent)
      .toBe('그림 5장과 3D 5개를 만들어요. GPU 한 대에서 차례로 처리해 약 60분 걸려요. 시작한 뒤에는 화면 위쪽의 작업 메뉴나 ‘작업 현황’ 탭에서 하나씩 중지할 수 있어요.');
    await act(async () => button('취소', confirm()!).click());
    expect([confirm(), launched()]).toEqual([null, []]);

    await act(async () => button('만들기 ·', step(1)).click());
    await act(async () => { button('만들기 시작', confirm()!).click(); await vi.runAllTimersAsync(); });
    expect(launched().sort()).toEqual(racing.assets.map((a) => a.name).sort());
    expect(onNotice).toHaveBeenLastCalledWith('레이싱 스킬의 IP 5개를 등록했어요. 지금 그림을 그리고 있어요. 그림이 나오면 3D가 이어서 만들어져요 (모두 약 60분).');
  });

  it('counts an IP that only needs its 3D again as that: no picture, ten minutes', async () => {
    vi.mocked(runTool).mockResolvedValue({ result: {} });
    const platformer = SKILLS.find((s) => s.id === 'platformer')!;
    const coin = ip('ip_coin', 'prop', platformer.assets[0].name);
    await show(session([liraReady, coin], [job('j_mesh', 'mesh3d', 'ip_coin', 'failed')], liraFiles));
    await openSkill('점프 플랫포머');
    expect(button('만들기 ·', step(1)).textContent).toBe('IP 4개 만들기 · 약 46분'); // 3 new at 12, the coin's 3D at 10
    await act(async () => button('만들기 ·', step(1)).click());
    expect(confirm()!.querySelector('.dialog-lead')!.textContent).toContain('그림 3장과 3D 4개를 만들어요.');
  });
});

describe('R20-38 the launch loop holds through a failed poll', () => {
  it('keeps the button off until every worker is done, launches each IP once and reports the failure once', async () => {
    let started = 0;
    let polls = 0;
    vi.mocked(runToolAsync).mockImplementation(async () => ({ messageId: `msg_${++started}` }));
    vi.mocked(getSession).mockImplementation(async () => {
      if (++polls === 1) throw new Error('서버에 연결할 수 없습니다.'); // the first poll of the first worker
      return { messages: Array.from({ length: started }, (_, i) => ({ messageId: `msg_${i + 1}`, status: 'done' })) } as Snapshot;
    });
    await show(session([liraReady], [], liraFiles));
    await openSkill('레이싱');
    await act(async () => button('만들기 ·', step(1)).click());
    await act(async () => { button('만들기 시작', confirm()!).click(); await vi.advanceTimersByTimeAsync(3100); });
    // one poll failed and the other worker is still launching: the button stays off (a second click launched twice)
    const launch = step(1).querySelector<HTMLButtonElement>('button.btn-primary')!;
    expect([launch.disabled, launch.textContent]).toEqual([true, '등록하는 중…']);
    await act(async () => { await vi.runAllTimersAsync(); });
    expect(vi.mocked(runToolAsync).mock.calls.map(([, , args]) => String(args.name)).sort()).toEqual(racing.assets.map((a) => a.name).sort());
    expect(onError).not.toHaveBeenCalled(); // a poll that fails is asked again: nothing was lost
  });

  it('goes on with the other IPs when one cannot be started, and says which', async () => {
    let started = 0;
    vi.mocked(runToolAsync).mockImplementation(async (_sid, _tool, args) => {
      if (args.name === '출발 게이트') throw new Error('요청에 실패했습니다 (500).');
      return { messageId: `msg_${++started}` };
    });
    vi.mocked(getSession).mockImplementation(async () => ({ messages: Array.from({ length: started }, (_, i) => ({ messageId: `msg_${i + 1}`, status: 'done' })) }) as Snapshot);
    await show(session([liraReady], [], liraFiles));
    await openSkill('레이싱');
    await act(async () => button('만들기 ·', step(1)).click());
    await act(async () => { button('만들기 시작', confirm()!).click(); await vi.runAllTimersAsync(); });
    expect(started).toBe(4);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onNotice).toHaveBeenLastCalledWith('레이싱 스킬의 IP 4개를 등록했어요. 지금 그림을 그리고 있어요. 그림이 나오면 3D가 이어서 만들어져요 (모두 약 48분). 시작하지 못한 IP: 출발 게이트.');
  });
});

describe('R20-38 the steps say what is needed and why a button is off', () => {
  it('step 0 says the hero needs 3D first, with the time, and starts it', async () => {
    vi.mocked(runTool).mockResolvedValue({ result: {} });
    const snap = session([lira]);
    await show(snap);
    await openSkill('레이싱');
    expect(step(0).querySelector('summary small')!.textContent).toBe('리라 · 3D 필요');
    expect(step(0).querySelector('p')!.textContent).toBe('게임의 주인공은 리라예요. 게임을 만들려면 리라의 3D가 먼저 필요해요 (보통 9–21분).');
    expect(step(0).open).toBe(true);
    await act(async () => button('리라 3D로 만들기', step(0)).click());
    expect(runTool).toHaveBeenCalledWith(snap.session.sessionId, 'render_3d', { ipId: 'ip_lira' });
    expect(step(0).querySelector('[role="status"]')!.textContent).toBe('리라의 3D를 만들기 시작했어요. 보통 9–21분 걸려요.');
  });

  it('step 0 follows the hero: being made, then ready, with the particle her name takes', async () => {
    await show(session([lira], [job('j_pose', 'apose', 'ip_lira', 'running')]));
    await openSkill('레이싱');
    expect(step(0).querySelector('p')!.textContent).toBe('게임의 주인공은 리라예요. 3D를 만들고 있어요 (3D용 자세 그림). 끝나면 게임을 만들 수 있어요.');
    expect(button('3D로 만들기', step(0))).toBeUndefined();
    await show(session([{ ...liraReady, name: '세린' }], [], liraFiles));
    expect([step(0).querySelector('p')!.textContent, step(0).open]).toEqual(['게임의 주인공은 세린이에요. 3D 모델이 준비됐어요.', false]);
    expect(container.textContent).not.toContain('리라이에요');
  });

  it('step 2 says why the game button is off: no hero, her 3D, or the IPs still to come', async () => {
    const why = () => step(2).querySelector('.skill-why')?.textContent;
    const made = madeAll();
    await show(session());
    await openSkill('레이싱');
    expect(why()).toBe('0단계의 주인공이 있어야 게임을 만들 수 있어요.');
    await show(session([lira, ...made], [], filesOf(made)));
    expect(why()).toBe('주인공 리라의 3D가 있어야 게임을 만들 수 있어요. 0단계에서 3D를 먼저 만들어 주세요.');
    expect([button('레이싱 게임 만들기', step(2)).disabled, button('지금 있는 IP로', step(2))?.disabled]).toEqual([true, undefined]); // every IP is ready: one button
    await show(session([liraReady, ...made.slice(0, 2)], [], [...liraFiles, ...filesOf(made.slice(0, 2))]));
    expect(why()).toBe('‘레이싱 게임 만들기’는 1단계의 IP 5개가 모두 3D로 준비되면 누를 수 있어요 (지금 2/5개). 기다리지 않으려면 ‘지금 있는 IP로’ 만들 수 있어요.');
    expect([button('레이싱 게임 만들기', step(2)).disabled, button('지금 있는 IP로', step(2)).disabled]).toEqual([true, false]);
    await show(session([liraReady, ...made], [], [...liraFiles, ...filesOf(made)]));
    expect([why(), button('레이싱 게임 만들기', step(2)).disabled]).toEqual([undefined, false]);
  });

  it('does not let a game be asked for with a hero whose 3D is not done (the server would hold it)', async () => {
    const made = madeAll().slice(0, 2);
    await show(session([lira, ...made], [], filesOf(made)));
    await openSkill('레이싱');
    expect(button('지금 있는 IP로', step(2)).disabled).toBe(true);
  });
});

describe('R20-10 / R20-38 what the page is needed for', () => {
  it('says to keep the tab while the IPs are being registered, and that the rest goes on without it', async () => {
    let settle!: () => void; // the server takes its time with the first registrations
    const gate = new Promise<void>((r) => { settle = r; });
    let started = 0;
    vi.mocked(runToolAsync).mockImplementation(async () => { await gate; return { messageId: `msg_${++started}` }; });
    vi.mocked(getSession).mockImplementation(async () => ({ messages: Array.from({ length: started }, (_, i) => ({ messageId: `msg_${i + 1}`, status: 'done' })) }) as Snapshot);
    const snap = session([liraReady], [], liraFiles);
    await show(snap);
    await openSkill('레이싱');
    await act(async () => button('만들기 ·', step(1)).click());
    await act(async () => { button('만들기 시작', confirm()!).click(); });
    expect(step(2).querySelector('.skill-wait')!.textContent).toBe('IP를 차례로 등록하는 중이에요. 등록이 끝날 때까지 이 탭을 닫지 마세요.');
    settle();
    await act(async () => { await vi.runAllTimersAsync(); });
    // registered: the pictures are being drawn (the snapshot shows their jobs)
    const drawing = racing.assets.map((a, i): Ip => ip(`ip_new${i}`, a.kind, a.name, { imageAssetId: undefined, imageJobId: `j_img${i}` }));
    await show({ ...snap, ips: [liraReady, ...drawing], jobs: drawing.map((x, i) => ({ ...job(`j_img${i}`, 'image', x.ipId, 'running'), provider: 'mediagen_image' as const })) });
    expect(step(2).querySelector('.skill-wait')!.textContent)
      .toBe('남은 예상 시간은 약 60분이에요 (GPU 한 대에서 차례로 처리). 등록된 작업은 탭을 닫아도 이어서 만들어져요.');
    expect(container.textContent).not.toContain('창을 닫아도');
  });
});
