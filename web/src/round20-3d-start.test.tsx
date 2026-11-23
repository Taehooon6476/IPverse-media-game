import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { DesignDrawer } from './components/DesignDrawer';
import { EditDrawer } from './components/EditDrawer';
import { chainTypical, threeDChain, threeDSteps, type Asset, type Ip, type Job, type Snapshot } from './types';

// "3D로 만들기" starts a chain of many minutes: the button and the card say the steps and the time. The times are the
// job cards' own (JOB_TYPICAL, locked to server/waits.py THREE_D_TYPICAL by server/tests/test_round12_media.py),
// added up as the server adds them (waits.chain_total).
vi.hoisted(() => { // IpPane reads prefers-reduced-motion when it loads; jsdom has no matchMedia
  window.matchMedia ??= (() => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
});

const at = '2026-11-16T03:10:00Z';
const ip = (ipId: string, kind: Ip['kind'], name: string, extra: Partial<Ip> = {}): Ip => ({ ipId, kind, name, description: '', version: 1,
  imageAssetId: `${ipId}_img`, cutoutAssetId: `${ipId}_cut`, createdAt: at, ...extra });
const asset = (assetId: string, kind: Asset['kind'], ipId: string): Asset => ({ assetId, kind, key: `k/${assetId}`, url: `https://cdn/${assetId}`,
  contentType: '', ipId, meta: {}, createdAt: at });
const job = (jobId: string, kind: Job['kind'], ipId: string, status: Job['status'], deps: string[] = [], input: Record<string, unknown> = {}): Job => ({
  jobId, kind, provider: 'img3d', status, input: { ipId, ...input }, outputs: [], deps, progress: '', createdAt: at, updatedAt: at });
const lira = ip('lira', 'character', '리라');
const wolf = ip('wolf', 'enemy', '그림자 늑대', { humanoid: false });
const guard = ip('guard', 'enemy', '숲의 파수꾼', { humanoid: true });
const lantern = ip('lantern', 'prop', '반딧불 등불');
const bow = ip('bow', 'weapon', '별빛 활', { weaponType: 'gun' });
const glade = ip('glade', 'prop', '별빛 숲 공터', { usage: 'background' });
const snapOf = (ips: Ip[], jobs: Job[] = [], extra: Asset[] = []) => ({ session: { sessionId: 's', title: 't', genre: 'sf-shooter', createdAt: at },
  messages: [], games: [], ips, jobs,
  assets: [...ips.flatMap((x) => [asset(`${x.ipId}_img`, 'image', x.ipId), asset(`${x.ipId}_cut`, 'cutout', x.ipId)]), ...extra] }) as Snapshot;
/** The chain render_3d registers for a character (server/tools.py): the pose, the mesh after it, the rig and the film after the mesh. */
const chain = (ipId: string, s: [Job['status'], Job['status'], Job['status'], Job['status']]) => [
  job(`${ipId}_pose`, 'apose', ipId, s[0]), job(`${ipId}_mesh`, 'mesh3d', ipId, s[1], [`${ipId}_pose`]),
  job(`${ipId}_rig`, 'rig', ipId, s[2], [`${ipId}_mesh`]), job(`${ipId}_turn`, 'render3d', ipId, s[3], [`${ipId}_mesh`])];

describe('R20-15 what 3D로 만들기 starts for an IP, and how long that usually takes', () => {
  it('is the steps the server registers (server/tools.py render_3d)', () => {
    expect([lira, guard].map(threeDSteps)).toEqual([['apose', 'mesh3d', 'rig', 'render3d'], ['apose', 'mesh3d', 'rig', 'render3d']]);
    expect([wolf, lantern, bow].map(threeDSteps)).toEqual([['mesh3d', 'render3d'], ['mesh3d', 'render3d'], ['mesh3d', 'render3d']]);
    expect(threeDSteps(glade)).toEqual(['render3d']); // a whole scene: one render of a panel, no mesh
  });

  it("adds the steps' cards up, as server/waits.py chain_total does (TOTAL 9–21, TOTAL_UNRIGGED 6–15)", () => {
    expect([lira, lantern, glade].map((x) => chainTypical(threeDSteps(x)))).toEqual(['보통 9–21분', '보통 6–15분', '보통 4–7분']);
    expect(chainTypical(['rig'])).toBe('보통 2–4분');
  });

  it('reads the chain in flight off the jobs: its steps, and how many are done', () => {
    expect(threeDChain('lira', chain('lira', ['running', 'queued', 'queued', 'queued']))).toEqual({ kinds: ['apose', 'mesh3d', 'rig', 'render3d'], done: 0 });
    expect(threeDChain('lira', chain('lira', ['done', 'done', 'running', 'running']))?.done).toBe(2);
    expect(threeDChain('lira', chain('lira', ['done', 'done', 'done', 'done']))).toBeNull(); // nothing in flight
    // an earlier, finished run of the same IP is not part of the one in flight; nor is another IP's chain
    const earlier = [job('old_mesh', 'mesh3d', 'lantern', 'done'), job('old_turn', 'render3d', 'lantern', 'done', ['old_mesh'])];
    const now = [job('new_mesh', 'mesh3d', 'lantern', 'running'), job('new_turn', 'render3d', 'lantern', 'queued', ['new_mesh'])];
    expect(threeDChain('lantern', [...earlier, ...chain('lira', ['done', 'running', 'queued', 'queued']), ...now])).toEqual({ kinds: ['mesh3d', 'render3d'], done: 0 });
    expect(threeDChain('lira', [job('rig_again', 'rig', 'lira', 'running')])).toEqual({ kinds: ['rig'], done: 0 }); // 움직임 뼈대만 다시 넣기
  });
});

type OnAction = (tool: string, args: Record<string, unknown>, background?: boolean) => Promise<void>;
let container: HTMLDivElement;
let root: Root;
let onAction: Mock<OnAction>;
let scrolled: Element[];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
  vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => { f(0); return 0; });
  scrolled = [];
  Element.prototype.scrollIntoView = function scrollIntoView(this: Element) { scrolled.push(this); };
  localStorage.clear();
  sessionStorage.clear();
  onAction = vi.fn<OnAction>(async () => undefined);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  history.replaceState(null, '', '/');
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
/** Another tab of the pane: the tabs read the hash when they mount. */
const reopen = async () => {
  await act(async () => root.unmount());
  root = createRoot(container);
};
const show = async (snap: Snapshot, tab = 'characters') => {
  history.replaceState(null, '', `#ip=${tab}`);
  const { IpPane } = await import('./components/IpPane');
  await act(async () => root.render(<IpPane snap={snap} onAction={onAction} onEdit={vi.fn()} onRetry={vi.fn(async () => undefined)} />));
};
const card = (name: string) => [...container.querySelectorAll('article.card')].find((c) => c.querySelector('h3')?.textContent === name)!;
const primary = (name: string) => card(name).querySelector<HTMLButtonElement>('.card-actions > button')!;
const menu = async (name: string) => {
  const trigger = card(name).querySelector<HTMLButtonElement>('.menu-trigger')!;
  await act(async () => trigger.click());
  return [...document.getElementById(trigger.getAttribute('aria-controls')!)!.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .map((el) => ({ el, label: el.querySelector('span')!.textContent, hint: el.querySelector('small')?.textContent }));
};

describe('R20-15 the card says what its 3D button starts before the click', () => {
  it('counts the steps and their usual time under the button', async () => {
    await show(snapOf([lira, guard, wolf]));
    expect(['리라', '숲의 파수꾼', '그림자 늑대'].map((n) => [primary(n).textContent, card(n).querySelector('.card-hint')?.textContent])).toEqual([
      ['3D로 만들기', '4단계로 만들어요 · 보통 9–21분'], ['3D로 만들기', '4단계로 만들어요 · 보통 9–21분'], ['3D로 만들기', '2단계로 만들어요 · 보통 6–15분']]);
    await reopen();
    await show(snapOf([lantern, bow]), 'props');
    expect(['반딧불 등불', '별빛 활'].map((n) => card(n).querySelector('.card-hint')?.textContent)).toEqual([
      '2단계로 만들어요 · 보통 6–15분', '2단계로 만들어요 · 보통 6–15분']);
  });

  it("names a background's button for the panel it makes, and says that it is no place to walk in", async () => {
    await show(snapOf([glade]), 'props');
    expect([primary('별빛 숲 공터').textContent, primary('별빛 숲 공터').getAttribute('aria-label')]).toEqual(['입체 판으로 만들기', '별빛 숲 공터 입체 판으로 만들기']);
    expect(card('별빛 숲 공터').querySelector('.card-hint')!.textContent)
      .toBe('배경은 걸어 다니는 3D 공간이 아니라 두께만 있는 입체 판으로 만들어져요 · 보통 4–7분');
    await act(async () => primary('별빛 숲 공터').click());
    expect(onAction).toHaveBeenLastCalledWith('render_3d', { ipId: 'glade' });
  });

  it('says it in the ⋯ menu too once the IP has a model (the button is there then)', async () => {
    const rigged = { ...lira, glbAssetId: 'lira_glb', riggedGlbAssetId: 'lira_rig' };
    await show(snapOf([rigged], [], [asset('lira_glb', 'glb', 'lira'), asset('lira_rig', 'rigged_glb', 'lira')]));
    const items = await menu('리라');
    expect(items.map((x) => [x.label, x.hint])).toEqual([['다시 뽑기', undefined], ['3D로 만들기', '다시 만들어요 · 4단계 · 보통 9–21분'],
      ['움직임 뼈대만 다시 넣기', '모양은 그대로예요 · 보통 2–4분'], ['액션 샷', undefined]]);
  });

  it('says that the 3D waits for a picture that is still being drawn', async () => {
    const drawing = { ...lira, imageAssetId: undefined, cutoutAssetId: undefined, imageJobId: 'j_img' };
    await show({ ...snapOf([drawing], [{ ...job('j_img', 'image', 'lira', 'running'), provider: 'mediagen_image' }]), assets: [] } as Snapshot);
    expect(card('리라').querySelector('.card-hint')!.textContent).toBe('그림이 나온 뒤 4단계로 만들어요 · 보통 9–21분');
  });
});

describe('R20-15 the card confirms the start and follows the chain', () => {
  it('says 시작하는 중… while the request runs and 시작했어요 when it was taken', async () => {
    let accept!: () => void;
    onAction.mockImplementationOnce(() => new Promise<void>((r) => { accept = r; }));
    await show(snapOf([lira]));
    await act(async () => primary('리라').click());
    expect(primary('리라').textContent).toBe('시작하는 중…');
    await act(async () => accept());
    const said = primary('리라').querySelector('[role="status"]')!; // for a screen reader; the rest is what is seen
    expect([primary('리라').textContent!.replace(said.textContent!, ''), said.textContent]).toEqual(['✓시작했어요', '3D로 만들기: 시작했어요']);
  });

  it('shows the step it is on, the usual time of the whole chain and where the result lands, in view', async () => {
    vi.useFakeTimers();
    await show(snapOf([lira, guard]));
    await act(async () => primary('리라').click());
    await show(snapOf([lira, guard], chain('lira', ['running', 'queued', 'queued', 'queued'])));
    await act(async () => { vi.advanceTimersByTime(2100); }); // the button's own 시작했어요 has gone
    const status = () => card('리라').querySelector<HTMLElement>('.card-status');
    expect([status()!.getAttribute('role'), status()!.textContent]).toEqual(['status', '3D 만드는 중 · 1/4단계 · 보통 9–21분. 끝나면 3D 탭에 나타나요.']);
    expect(scrolled).toEqual([status()]); // the line the click brought, not cut by the pane's fold
    expect(primary('리라').textContent).toBe('3D 만드는 중');
    expect(card('리라').querySelector('.card-hint')).toBeNull(); // the status line has taken its place
    expect(card('숲의 파수꾼').querySelector('.card-status')).toBeNull();

    await show(snapOf([lira, guard], chain('lira', ['done', 'running', 'queued', 'queued'])));
    expect(status()!.textContent).toContain('2/4단계');
    // the mesh has landed: the card's button turns into 수정하기, the rig and the film still run and the line says so
    const meshed = { ...lira, glbAssetId: 'lira_glb' };
    await show(snapOf([meshed, guard], chain('lira', ['done', 'done', 'running', 'running']), [asset('lira_glb', 'glb', 'lira')]));
    expect(primary('리라').textContent).toBe('수정하기');
    expect(status()!.textContent).toBe('3D 만드는 중 · 3/4단계 · 보통 9–21분. 끝나면 3D 탭에 나타나요.');
    expect(scrolled).toHaveLength(1); // once, for the click

    await show(snapOf([{ ...meshed, riggedGlbAssetId: 'lira_rig' }, guard], chain('lira', ['done', 'done', 'done', 'done']),
      [asset('lira_glb', 'glb', 'lira'), asset('lira_rig', 'rigged_glb', 'lira')]));
    expect(status()).toBeNull();
  });

  it("follows a background's one step without a step count, and a chain that was running when the page opened without scrolling", async () => {
    await show(snapOf([glade, lantern], [job('g_panel', 'render3d', 'glade', 'running', [], { model: 'relief' }),
      job('l_mesh', 'mesh3d', 'lantern', 'done'), job('l_turn', 'render3d', 'lantern', 'running', ['l_mesh'])]), 'props');
    expect(card('별빛 숲 공터').querySelector('.card-status')!.textContent).toBe('입체 판 만드는 중 · 보통 4–7분. 끝나면 3D 탭에 나타나요.');
    expect(card('반딧불 등불').querySelector('.card-status')!.textContent).toBe('3D 만드는 중 · 2/2단계 · 보통 6–15분. 끝나면 3D 탭에 나타나요.');
    expect(scrolled).toEqual([]);
  });
});

describe('R20-15 the drawers say the usual time too', () => {
  it('게임 설계: a cast card without 3D shows what its button takes, and 시작하는 중… while it is sent', async () => {
    let finish!: () => void;
    const make3d = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    await act(async () => root.render(<DesignDrawer ips={[lira, lantern]} assets={snapOf([lira, lantern]).assets} jobs={[]} onMake3d={make3d}
      onClose={vi.fn()} onSend={vi.fn()} />));
    // no hero is in 3D yet, so the drawer opens on what is missing, with the same button and time
    const first = container.querySelector('.design-blocked-list li')!;
    expect([first.querySelector('button')!.textContent, first.querySelector('small')!.textContent]).toEqual(['3D로 만들기', '보통 9–21분']);
    await act(async () => container.querySelector<HTMLButtonElement>('.design-blocked-early')!.click()); // the form, asked for
    const cast = (name: string) => [...container.querySelectorAll('.cast-card')].find((c) => c.querySelector('.cast-name')!.textContent!.startsWith(name))!;
    expect(['리라', '반딧불 등불'].map((n) => cast(n).querySelector('.cast-3d-time')!.textContent)).toEqual(['보통 9–21분', '보통 6–15분']);
    const button = cast('리라').querySelector<HTMLButtonElement>('button')!;
    await act(async () => button.click());
    expect(button.textContent).toBe('시작하는 중…');
    await act(async () => finish());
  });

  it('수정하기: the hint under the request says how long a new version or a new shot takes', async () => {
    const hint = () => container.querySelector('#edit-submit-hint')!.textContent;
    const type = (text: string) => act(async () => {
      const box = container.querySelector('textarea')!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, text);
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => root.render(<EditDrawer target={{ kind: 'ip', ip: lira }} onClose={vi.fn()} onSend={vi.fn()} />));
    await type('목에 빨간 스카프를 둘러줘');
    expect(hint()).toBe('요청을 보내면 새 버전을 그려요 (보통 20초–3분). 진행 상황은 채팅과 작업 현황에 보여요.');
    await act(async () => root.unmount());
    root = createRoot(container);
    const shot = { ...asset('shot1', 'shot', 'lira'), jobId: 'j_shot' };
    await act(async () => root.render(<EditDrawer target={{ kind: 'shot', asset: shot, model: 'minimax-h3' }} onClose={vi.fn()} onSend={vi.fn()} />));
    await type('밤 장면으로');
    expect(hint()).toBe('요청을 보내면 새 샷을 만들어요 (보통 4–5분). 진행 상황은 채팅과 작업 현황에 보여요.');
  });
});
