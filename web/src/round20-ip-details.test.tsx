import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { modelPicture, type Asset, type Ip, type Job, type Snapshot } from './types';

// An IP's details: the 3D tab says which picture its model was made from, the viewer and the turntable are captioned,
// 버전 기록 offers only versions that can be used and makes the page behind inert, and a click on the card's picture
// opens it.
vi.hoisted(() => { // IpPane reads prefers-reduced-motion when it loads; jsdom has no matchMedia
  window.matchMedia ??= (() => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
});

const SID = 'ses_x';
const at = (clock: string) => `2026-11-16T${clock}Z`;
// a picture and its cutout as an image job saves them (server/providers/mediagen_image.py image_key, cutout_key)
const picture = (ipId: string, n: number, extra: Record<string, unknown> = {}): Asset[] => [
  { assetId: `${ipId}_v${n}`, kind: 'image', ipId, jobId: `job_${ipId}_img${n}`, key: `sessions/${SID}/job_${ipId}_img${n}.png`, url: `https://cdn/${ipId}_v${n}.png`,
    contentType: 'image/png', meta: { version: n, model: 'krea', ...extra }, createdAt: at(`03:1${n}:00`) },
  { assetId: `${ipId}_c${n}`, kind: 'cutout', ipId, jobId: `job_${ipId}_img${n}`, key: `sessions/${SID}/job_${ipId}_img${n}-cutout.png`, url: `https://cdn/${ipId}_c${n}.png`,
    contentType: 'image/png', meta: { forAssetId: `${ipId}_v${n}` }, createdAt: at(`03:1${n}:01`) }];
const file = (assetId: string, kind: Asset['kind'], ipId: string, jobId: string, createdAt = at('03:22:00')): Asset => ({ assetId, kind, ipId, jobId,
  key: `sessions/${SID}/${assetId}`, url: `https://cdn/${assetId}`, contentType: '', meta: {}, createdAt });
const job = (jobId: string, kind: Job['kind'], input: Record<string, unknown>, extra: Partial<Job> = {}): Job => ({ jobId, kind, provider: 'img3d', status: 'done',
  input, outputs: [], deps: [], progress: '', createdAt: at('03:18:00'), updatedAt: at('03:22:00'), ...extra });
const ip = (ipId: string, kind: Ip['kind'], name: string, version: number, extra: Partial<Ip> = {}): Ip => ({ ipId, kind, name, description: '', version,
  imageAssetId: `${ipId}_v${version}`, cutoutAssetId: `${ipId}_c${version}`, createdAt: at('03:10:00'), ...extra });

// 반딧불 등불: its 3D (a mesh and its film) was made from v1's cutout; the picture is v2 now
const lantern = ip('lantern', 'prop', '반딧불 등불', 2, { glbAssetId: 'lantern_glb' });
const lanternFiles = [...picture('lantern', 1), ...picture('lantern', 2), file('lantern_glb', 'glb', 'lantern', 'job_l_mesh'),
  file('lantern_turn', 'turntable', 'lantern', 'job_l_turn'), file('lantern_poster', 'poster', 'lantern', 'job_l_turn')];
const lanternJobs = [job('job_l_mesh', 'mesh3d', { ipId: 'lantern', cutoutKey: `sessions/${SID}/job_lantern_img1-cutout.png` }),
  job('job_l_turn', 'render3d', { ipId: 'lantern', model: 'hunyuan3d' }, { deps: ['job_l_mesh'] })];
// 리라: a character's mesh is made from the pose drawing, which was drawn from her picture
const lira = ip('lira', 'character', '리라', 1, { glbAssetId: 'lira_glb' });
const liraFiles = [...picture('lira', 1), file('lira_glb', 'glb', 'lira', 'job_r_mesh')];
const liraJobs = [job('job_r_pose', 'apose', { ipId: 'lira', imageKey: `sessions/${SID}/job_lira_img1.png` }),
  job('job_r_mesh', 'mesh3d', { ipId: 'lira', cutoutKey: `sessions/${SID}/job_r_pose-apose.png` }, { deps: ['job_r_pose'] })];
const snapOf = (ips: Ip[], assets: Asset[], jobs: Job[]) => ({ session: { sessionId: SID, title: 't', genre: 'sf-shooter', createdAt: at('03:00:00') },
  messages: [], games: [], ips, assets, jobs }) as Snapshot;

describe('R20-50 which picture a 3D model was made from', () => {
  it('reads it off the jobs that made the model, by the file they were given', () => {
    expect(modelPicture(lanternFiles[4], lanternFiles, lanternJobs)?.assetId).toBe('lantern_v1'); // the mesh's cutout → its picture
    expect(modelPicture(liraFiles[2], liraFiles, liraJobs)?.assetId).toBe('lira_v1'); // through the pose drawing
    const relief = job('job_g', 'render3d', { ipId: 'glade', model: 'relief', cutoutKey: `sessions/${SID}/job_glade_img1-cutout.png` });
    expect(modelPicture(file('glade_glb', 'glb', 'glade', 'job_g'), picture('glade', 1), [relief])?.assetId).toBe('glade_v1'); // a background's panel
  });
  it('claims nothing when the jobs do not say (an older model, a job that is gone)', () => {
    expect(modelPicture(lanternFiles[4], lanternFiles, [])).toBeUndefined();
    expect(modelPicture(lanternFiles[4], lanternFiles, [job('job_l_mesh', 'mesh3d', { ipId: 'lantern' })])).toBeUndefined();
  });
});

type OnAction = (tool: string, args: Record<string, unknown>, background?: boolean) => Promise<void>;
let container: HTMLDivElement;
let root: Root;
let onAction: Mock<OnAction>;
let onModal: Mock<(open: boolean) => void>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
  vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => { f(0); return 0; });
  localStorage.clear();
  onAction = vi.fn<OnAction>(async () => undefined);
  onModal = vi.fn();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
});
const show = async (snap: Snapshot, tab: string) => {
  history.replaceState(null, '', `#ip=${tab}`);
  const { IpPane } = await import('./components/IpPane');
  await act(async () => root.render(<IpPane snap={snap} onAction={onAction} onEdit={vi.fn()} onRetry={vi.fn(async () => undefined)} onModal={onModal} />));
};
const card = (name: string) => [...container.querySelectorAll('article.card')].find((c) => c.querySelector('h3')?.textContent === name)!;
const button = (text: string, within: ParentNode = document) => [...within.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text)!;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');

describe('R20-50 the 3D tab marks a model made from an earlier picture', () => {
  it('says which picture it was made from, that the picture has moved on, and remakes it from there', async () => {
    await show(snapOf([lantern], lanternFiles, lanternJobs), '3d');
    const stale = card('반딧불 등불').querySelector('.model-stale')!;
    expect(stale.querySelector('.badge')!.textContent).toBe('이전 그림으로 만든 3D');
    expect(stale.querySelector('.model-stale-text')!.textContent).toBe('그림 v1로 만든 3D예요. 지금 그림은 v2예요.');
    const again = button('지금 그림으로 3D 다시 만들기', stale);
    expect(stale.querySelector('small')!.textContent).toBe('2단계 · 보통 6–15분');
    await act(async () => again.click());
    expect(onAction).toHaveBeenCalledWith('render_3d', { ipId: 'lantern' });
  });

  it('says so plainly for a model of the picture in use, also when that picture was chosen again in 버전 기록', async () => {
    const fresh = [...lanternJobs.slice(1), job('job_l_mesh', 'mesh3d', { ipId: 'lantern', cutoutKey: `sessions/${SID}/job_lantern_img2-cutout.png` })];
    await show(snapOf([lantern], lanternFiles, fresh), '3d');
    expect([card('반딧불 등불').querySelector('.model-stale'), card('반딧불 등불').querySelector('.model-source')!.textContent]).toEqual([null, '그림 v2로 만든 3D예요.']);
    // the IP back on v1, the picture its model was made from: nothing to remake
    await show(snapOf([{ ...lantern, version: 1, imageAssetId: 'lantern_v1', cutoutAssetId: 'lantern_c1' }], lanternFiles, lanternJobs), '3d');
    expect([card('반딧불 등불').querySelector('.model-stale'), card('반딧불 등불').querySelector('.model-source')!.textContent]).toEqual([null, '그림 v1로 만든 3D예요.']);
  });

  it('says nothing about a model whose jobs no longer tell, and holds the remake while a 3D chain runs', async () => {
    await show(snapOf([lantern], lanternFiles, []), '3d');
    expect(card('반딧불 등불').querySelector('.model-stale, .model-source')).toBeNull();
    await show(snapOf([lantern], lanternFiles, [...lanternJobs, job('job_new', 'mesh3d', { ipId: 'lantern' }, { status: 'running' })]), '3d');
    const again = card('반딧불 등불').querySelector<HTMLButtonElement>('.model-stale button')!;
    expect([again.textContent, again.disabled || again.getAttribute('aria-disabled') === 'true']).toEqual(['3D 만드는 중', true]);
  });
});

describe('R20-50 a 3D run is not a "v": that is the picture\'s', () => {
  it('names the model in use and counts the earlier runs in words; captions the viewer and the film', async () => {
    const made = (n: number) => file(`lantern_glb${n}`, 'glb', 'lantern', `job_m${n}`, at(`03:2${n}:00`));
    const runs = [made(1), made(2), made(3)];
    await show(snapOf([{ ...lantern, glbAssetId: 'lantern_glb3' }, lira], [...lanternFiles.slice(0, 4), ...runs,
      file('lantern_turn', 'turntable', 'lantern', 'job_m3'), ...liraFiles], liraJobs), '3d');
    expect(card('반딧불 등불').querySelector('.card-foot .model-run')!.textContent).toBe('3번째 3D · 지금 쓰는 모델');
    expect(card('리라').querySelector('.card-foot .model-run')!.textContent).toBe('지금 쓰는 모델'); // made once: nothing to count
    expect(card('반딧불 등불').querySelector('.card-foot')!.textContent).not.toMatch(/v\d/);
    const fold = card('반딧불 등불').querySelector<HTMLButtonElement>('.model-versions .fold-head')!;
    expect(fold.textContent).toBe('이전 3D2개');
    await act(async () => fold.click());
    expect([...card('반딧불 등불').querySelectorAll('.model-versions li strong')].map((s) => s.textContent)).toEqual(['2번째 3D', '1번째 3D']);
    expect(card('반딧불 등불').querySelector('button[aria-label="반딧불 등불 2번째 3D 내려받기"]')).not.toBeNull();
    expect([...card('반딧불 등불').querySelectorAll('.media-pair figcaption')].map((c) => c.textContent)).toEqual(['3D 모델 · 끌어서 돌려 보기', '3D 회전 영상']);
    expect([...card('리라').querySelectorAll('.media-pair figcaption')].map((c) => c.textContent)).toEqual(['3D 모델 · 끌어서 돌려 보기']);
  });
});

describe('R20-50 버전 기록', () => {
  const open = async (snap: Snapshot) => {
    await show(snap, 'props');
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label^="반딧불 등불 버전 기록"]')!.click());
  };
  const older = { ...lantern, version: 1, imageAssetId: 'lantern_v1', cutoutAssetId: 'lantern_c1' }; // v2 is newer and never was the picture in use

  it('offers 이 버전 쓰기, not 되돌리기: a newer version is not gone back to', async () => {
    await open(snapOf([older], lanternFiles, lanternJobs));
    expect(dialog()!.querySelector('#versions-intro')!.textContent).toBe('버전을 골라 지금 그림과 비교해 보세요. 쓰고 싶은 버전은 ‘이 버전 쓰기’로 지금 그림이 돼요.');
    const use = dialog()!.querySelector<HTMLButtonElement>('.version-item button.action-btn')!;
    expect([use.textContent, use.getAttribute('aria-label')]).toEqual(['이 버전 쓰기', 'v2 버전 쓰기']);
    await act(async () => use.click());
    expect(onAction).toHaveBeenCalledWith('restore_ip_version', { ipId: 'lantern', imageAssetId: 'lantern_v2' });
    expect(dialog()!.textContent).not.toContain('되돌리');
  });

  it('says in its footnote where the 3D button is: on the card, or under ⋯ once the IP has a model', async () => {
    const note = () => dialog()!.querySelector('.versions-note')!.textContent;
    await open(snapOf([lantern], lanternFiles, lanternJobs));
    expect(note()).toBe('버전을 바꿔도 다른 버전은 지워지지 않아요. 3D와 게임은 이미 만든 결과를 그대로 쓰니, 바뀐 그림으로 다시 만들려면 카드의 ⋯ 메뉴에서 ‘3D로 만들기’를 누르세요.');
    await act(async () => button('닫기', dialog()!.querySelector('.dialog-footer')!).click());
    await act(async () => root.unmount());
    root = createRoot(container);
    await open(snapOf([{ ...lantern, glbAssetId: undefined }], lanternFiles.slice(0, 4), []));
    expect(note()).toContain('카드의 ‘3D로 만들기’를 누르세요.');
  });

  it('opens over the whole studio (on <body>) and tells the shell, so the page behind is inert like behind its other dialogs', async () => {
    await open(snapOf([lantern], lanternFiles, lanternJobs));
    expect(container.contains(dialog())).toBe(false);
    expect(onModal).toHaveBeenLastCalledWith(true);
    await act(async () => button('닫기', dialog()!.querySelector('.dialog-footer')!).click());
    expect([dialog(), onModal.mock.calls.at(-1)]).toEqual([null, [false]]);
  });
});

describe('R20-50 a picture can be enlarged', () => {
  it('opens the card\'s picture big, the cutout when 배경 제거 is on, with the words it was drawn from behind a fold', async () => {
    const drawn = lanternFiles.map((a) => (a.assetId === 'lantern_v2' ? { ...a, meta: { ...a.meta, description: 'a brass lantern full of fireflies' } } : a));
    await show(snapOf([lantern], drawn, lanternJobs), 'props');
    const open = card('반딧불 등불').querySelector<HTMLButtonElement>('.card-media-open')!;
    expect(open.getAttribute('aria-label')).toBe('반딧불 등불 그림 크게 보기');
    await act(async () => open.click());
    expect([dialog()!.querySelector('h2')!.textContent, dialog()!.querySelector('img')!.getAttribute('src')]).toEqual(['반딧불 등불 · v2', 'https://cdn/lantern_v2.png']);
    const words = dialog()!.querySelector<HTMLDetailsElement>('details.picture-prompt')!;
    expect([words.open, words.querySelector('summary')!.textContent, words.querySelector('p')!.textContent])
      .toEqual([false, '이 그림의 프롬프트 보기 (영어)', 'a brass lantern full of fireflies']);
    expect(onModal).toHaveBeenLastCalledWith(true);
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect([dialog(), onModal.mock.calls.at(-1)]).toEqual([null, [false]]);

    await act(async () => card('반딧불 등불').querySelector<HTMLButtonElement>('.cutout-toggle')!.click());
    await act(async () => card('반딧불 등불').querySelector<HTMLButtonElement>('.card-media-open')!.click());
    expect([dialog()!.querySelector('img')!.getAttribute('src'), dialog()!.querySelector('.picture-stage')!.className])
      .toEqual(['https://cdn/lantern_c2.png', 'picture-stage is-cutout']);
  });
});

// The pane tells the shell "covered" only when the dialog is drawn: without the picture's file the studio would be
// inert behind nothing.
describe('the shell is covered only by a dialog that is drawn (round20 review, web)', () => {
  it('a picture whose file left the snapshot takes its dialog and the cover away together', async () => {
    await show(snapOf([lantern], lanternFiles, lanternJobs), 'props');
    await act(async () => card('반딧불 등불').querySelector<HTMLButtonElement>('.card-media-open')!.click());
    expect([!!dialog(), onModal.mock.calls.at(-1)]).toEqual([true, [true]]);
    await show(snapOf([lantern], lanternFiles.filter((a) => a.assetId !== 'lantern_v2'), lanternJobs), 'props'); // the next snapshot
    expect([dialog(), onModal.mock.calls.at(-1)]).toEqual([null, [false]]);
  });
});

// Many IPs in one tab: the cards get a find box, as the session list has.
describe('a long tab of cards is found by name (R20-49)', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => ip(`c${i}`, 'character', ['리라', '숲의 파수꾼', '그림자 늑대', '대장장이 브론', '달빛 기사',
    '숲의 궁수', '네온 배달부', '별빛 정령', '사막 고고학자', '바다 등대지기'][i], 1));
  const names = () => [...container.querySelectorAll('article.card h3')].map((h) => h.textContent);
  const type = (el: HTMLInputElement, text: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const files = (ips: Ip[]) => ips.flatMap((x) => picture(x.ipId, 1));

  it('shows a find box from 9 cards, filters as it is typed and says when nothing matches', async () => {
    await show(snapOf(many(8), files(many(8)), []), 'characters');
    expect(container.querySelector('.ip-find')).toBeNull();
    await show(snapOf([...many(10), lantern], [...files(many(10)), ...lanternFiles], lanternJobs), 'characters');
    const find = container.querySelector<HTMLInputElement>('.ip-find input')!;
    expect([find.type, find.placeholder, container.querySelector(`label[for="${find.id}"]`)!.textContent]).toEqual(['search', '캐릭터 이름으로 찾기', '캐릭터 이름으로 찾기']);
    expect(names()).toHaveLength(10);
    await type(find, ' 숲');
    expect(names()).toEqual(['숲의 파수꾼', '숲의 궁수']);
    expect(container.querySelector('.ip-find [role="status"]')!.textContent).toBe('2/10');
    await type(find, '용');
    expect(names()).toEqual([]);
    expect(container.querySelector('.ip-find-none')!.textContent).toBe('‘용’이(가) 들어간 캐릭터가 없어요.');
    await type(find, '');
    expect(names()).toHaveLength(10);
    // the other tab has its own cards and, with one, no box
    await act(async () => container.querySelector<HTMLButtonElement>('#ip-tab-props')!.click());
    expect([names(), container.querySelector('.ip-find')]).toEqual([['반딧불 등불'], null]);
  });
});

describe('R20-50 the 영상 tab says where a shot is made on either kind of card', () => {
  it('names 액션 샷 on a character card and 영상 샷 on a prop card, with what a shot takes', async () => {
    await show(snapOf([lantern], lanternFiles, lanternJobs), 'video');
    expect(container.querySelector('[aria-label="샷"] .empty')!.textContent)
      .toBe('아직 영상이 없어요. 캐릭터 카드의 ⋯ 메뉴에서 ‘액션 샷’, 소품 카드의 ⋯ 메뉴에서 ‘영상 샷’을 고르거나 채팅으로 요청하세요 (샷 하나에 보통 5–7분).');
  });
});
