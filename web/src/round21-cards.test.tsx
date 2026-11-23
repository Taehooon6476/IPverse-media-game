import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { drawLine, jobNote, jobWait, plainLine, refusedSkeleton, type Asset, type Ip, type Job, type Snapshot } from './types';

// The IP pane's cards and its 3D tab.
vi.hoisted(() => { // IpPane reads prefers-reduced-motion when it loads; jsdom has no matchMedia
  window.matchMedia ??= (() => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
});

const at = (clock = '03:10:00') => `2026-11-17T${clock}Z`;
const ip = (ipId: string, kind: Ip['kind'], name: string, extra: Partial<Ip> = {}): Ip => ({ ipId, kind, name, description: '', version: 1,
  imageAssetId: `${ipId}_img`, cutoutAssetId: `${ipId}_cut`, createdAt: at(), ...extra });
const asset = (assetId: string, kind: Asset['kind'], ipId: string, extra: Partial<Asset> = {}): Asset => ({ assetId, kind, key: `k/${assetId}`,
  url: `https://cdn/${assetId}`, contentType: '', ipId, meta: {}, createdAt: at(), ...extra });
const job = (jobId: string, kind: Job['kind'], ipId: string, status: Job['status'], extra: Partial<Job> = {}): Job => ({
  jobId, kind, provider: 'img3d', status, outputs: [], deps: [], progress: '', createdAt: at(), updatedAt: at(), ...extra, input: { ipId, ...extra.input } });
const snapOf = (ips: Ip[], jobs: Job[] = [], extra: Asset[] = []) => ({ session: { sessionId: 's', title: 't', genre: 'sf-shooter', createdAt: at() },
  messages: [], games: [], ips, jobs,
  assets: [...ips.flatMap((x) => [asset(`${x.ipId}_img`, 'image', x.ipId, { meta: { version: 1 } }), asset(`${x.ipId}_cut`, 'cutout', x.ipId)]), ...extra] }) as Snapshot;

type OnAction = (tool: string, args: Record<string, unknown>, background?: boolean) => Promise<void>;
let container: HTMLDivElement;
let root: Root;
let onAction: Mock<OnAction>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
  Element.prototype.scrollIntoView = () => undefined;
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
  vi.unstubAllGlobals();
});
const show = async (snap: Snapshot, tab = 'characters') => {
  history.replaceState(null, '', `#ip=${tab}`);
  const { IpPane } = await import('./components/IpPane');
  await act(async () => root.render(<IpPane snap={snap} onAction={onAction} onEdit={vi.fn()} onRetry={vi.fn(async () => undefined)} />));
};
const card = (name: string) => [...container.querySelectorAll('article.card')].find((c) => c.querySelector('h3')?.textContent === name)!;
const noteOf = (name: string) => card(name).querySelector<HTMLElement>('.card-note');
const noteButtons = (name: string) => [...(noteOf(name)?.querySelectorAll<HTMLButtonElement>('button') ?? [])];

// A hero's chain ended with a refused 움직임 뼈대: the card says why and what helps.
describe('the card of a hero whose skeleton was refused says why, and what helps', () => {
  const REFUSED = '움직임 뼈대를 넣을 수 없는 모양입니다: not a full body: legs are missing or cut off (hips at 30% of the height)';
  const wizard = ip('wiz', 'character', '꼬마 마법사', { glbAssetId: 'wiz_glb' });
  /** Her chain as it ended (server/tools.py render_3d): the pose drawn from her picture, the model, the film, and the rig the farm refused. */
  const ended = (rig: Partial<Job> = { status: 'failed', error: REFUSED }): Job[] => [
    job('wiz_pose', 'apose', 'wiz', 'done', { input: { imageKey: 'k/wiz_img' } }), job('wiz_mesh', 'mesh3d', 'wiz', 'done', { deps: ['wiz_pose'] }),
    job('wiz_turn', 'render3d', 'wiz', 'done', { deps: ['wiz_mesh'] }), job('wiz_rig', 'rig', 'wiz', 'failed', { deps: ['wiz_mesh'], provider: 'rig', ...rig })];
  const model = asset('wiz_glb', 'glb', 'wiz', { jobId: 'wiz_mesh' });
  const WHY = '다리가 보이지 않거나 너무 짧아요';

  it('reads the refusal off her newest 움직임 뼈대 job, while she has no skeleton', () => {
    const s = snapOf([wizard], ended(), [model]);
    expect(refusedSkeleton(wizard, s.assets, s.jobs)).toMatchObject({ why: WHY });
    // a later run that worked, or a skeleton she already has: nothing is refused
    expect(refusedSkeleton(wizard, s.assets, [...s.jobs, job('wiz_rig2', 'rig', 'wiz', 'done')])).toBeNull();
    const rigged = { ...wizard, riggedGlbAssetId: 'wiz_rigged' };
    expect(refusedSkeleton(rigged, [...s.assets, asset('wiz_rigged', 'rigged_glb', 'wiz')], s.jobs)).toBeNull();
    // a failure that passes is not a refusal
    expect(refusedSkeleton(wizard, s.assets, ended({ status: 'failed', error: '렌더 서버에서 작업이 실패했습니다: FAILED' }))).toBeNull();
  });

  it('says why, what the picture needs, and offers 그림 다시 뽑기', async () => {
    await show(snapOf([wizard], ended(), [model]));
    expect(noteOf('꼬마 마법사')!.querySelector('p')!.textContent)
      .toBe(`움직임 뼈대를 넣지 못했어요: ${WHY}. 머리부터 발끝까지 보이고 두 다리가 드러나게 서 있는 그림으로 다시 뽑아 주세요.`);
    expect(noteButtons('꼬마 마법사').map((b) => b.textContent)).toEqual(['그림 다시 뽑기']);
    await act(async () => noteButtons('꼬마 마법사')[0].click());
    expect(onAction).toHaveBeenLastCalledWith('reroll_ip_image', { ipId: 'wiz' }, true);
  });

  it('takes the server\'s own reason when it marks the job (outcome "refused")', async () => {
    await show(snapOf([wizard], ended({ status: 'failed', error: '움직임 뼈대를 넣지 못했습니다', outcome: 'refused', reason: '다리가 옷에 가려 보이지 않아요.' }), [model]));
    expect(noteOf('꼬마 마법사')!.querySelector('p')!.textContent)
      .toBe('움직임 뼈대를 넣지 못했어요: 다리가 옷에 가려 보이지 않아요. 머리부터 발끝까지 보이고 두 다리가 드러나게 서 있는 그림으로 다시 뽑아 주세요.');
  });

  it('once her picture was drawn again, offers the 3D again from that picture', async () => {
    const redrawn = { ...wizard, version: 2, imageAssetId: 'wiz_img2' };
    await show(snapOf([redrawn], ended(), [model, asset('wiz_img2', 'image', 'wiz', { meta: { version: 2 } })]));
    expect(noteOf('꼬마 마법사')!.querySelector('p')!.textContent).toBe('그림이 바뀌었어요. 지금 그림으로 3D를 다시 만들면 움직임 뼈대도 다시 넣어요.');
    expect(noteButtons('꼬마 마법사').map((b) => b.textContent)).toEqual(['지금 그림으로 3D 다시 만들기']);
    expect(noteOf('꼬마 마법사')!.querySelector('small')!.textContent).toBe('4단계 · 보통 9–21분');
    await act(async () => noteButtons('꼬마 마법사')[0].click());
    expect(onAction).toHaveBeenLastCalledWith('render_3d', { ipId: 'wiz' });
  });

  it('says nothing while the picture or the 3D is being made again, nor for a failure that passes', async () => {
    const redrawing = { ...wizard, imageJobId: 'wiz_draw' };
    await show(snapOf([redrawing], [...ended(), job('wiz_draw', 'image', 'wiz', 'running')], [model]));
    expect(noteOf('꼬마 마법사')).toBeNull();
    await show(snapOf([wizard], [...ended(), job('wiz_pose2', 'apose', 'wiz', 'running')], [model]));
    expect(noteOf('꼬마 마법사')).toBeNull();
    await show(snapOf([wizard], ended({ status: 'failed', error: '렌더 서버에서 작업이 실패했습니다: FAILED' }), [model]));
    expect(noteOf('꼬마 마법사')).toBeNull();
  });
});

// A redraw the composition check kept out of its IP: the card, not only 작업 현황, says the new picture is not used and why.
describe('a new picture the check kept out leaves its trace on the card', () => {
  const KEPT_OUT = '구도 검사 실패: 대상이 2개로 나뉨(2번 그려도 같음). 새 그림(v3)은 버전 기록에만 두고 지금 그림(v2)을 그대로 씁니다.';
  const lamp = ip('lamp', 'prop', '반딧불 등불', { version: 2, imageAssetId: 'lamp_v2', imageJobId: 'lamp_draw3' });
  const pictures = [asset('lamp_v2', 'image', 'lamp', { meta: { version: 2 }, jobId: 'lamp_draw2' }), asset('lamp_v3', 'image', 'lamp', { meta: { version: 3 }, jobId: 'lamp_draw3' })];
  const drew2 = job('lamp_draw2', 'image', 'lamp', 'done', { provider: 'mediagen_image', outputs: ['lamp_v2'], input: { version: 2 } });
  const draw3 = (extra: Partial<Job> = {}) => job('lamp_draw3', 'image', 'lamp', 'done', { provider: 'mediagen_image', outputs: ['lamp_v3'], error: KEPT_OUT, outcome: 'rejected',
    ...extra, input: { version: 3, ...extra.input } });
  const says = () => noteOf('반딧불 등불')?.querySelector('p')?.textContent;

  it('says the new picture was not used and why, and which picture is in use', async () => {
    await show(snapOf([lamp], [drew2, draw3()], pictures), 'props');
    expect(says()).toBe('새 그림(v3)은 검사를 통과하지 못해 쓰지 않았어요: 대상이 2개로 나뉨. 지금 그림(v2)을 그대로 써요.');
    expect(noteButtons('반딧불 등불').map((b) => b.textContent)).toEqual(['버전 기록 보기', '작업 현황 보기']);
  });

  it('leads to 버전 기록, where the picture is, and to 작업 현황, where its job is', async () => {
    await show(snapOf([lamp], [drew2, draw3()], pictures), 'props');
    await act(async () => noteButtons('반딧불 등불')[0].click());
    expect(document.querySelector('[role="dialog"] h2')!.textContent).toBe('반딧불 등불 버전 기록');
    await act(async () => document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="닫기"]')!.click());
    await act(async () => noteButtons('반딧불 등불')[1].click());
    expect(container.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toContain('작업 현황');
  });

  it('an edit that changed more than asked says so as an edit; a record from before the server\'s mark is read by its line', async () => {
    const edited = draw3({ outcome: undefined, input: { edit: 'a red ribbon' },
      error: '수정 검사 실패: 요청 밖 변경: 배경이 숲에서 단색으로 바뀜(2번 그려도 같음). 새 그림(v3)은 버전 기록에만 두고 지금 그림(v2)을 그대로 씁니다.' });
    await show(snapOf([lamp], [drew2, edited], pictures), 'props');
    expect(says()).toBe('수정본(v3)은 검사를 통과하지 못해 쓰지 않았어요: 요청 밖 변경: 배경이 숲에서 단색으로 바뀜. 지금 그림(v2)을 그대로 써요.');
    // marked by the server with no line of its own: what the mark says
    await show(snapOf([lamp], [drew2, draw3({ error: undefined })], pictures), 'props');
    expect(says()).toBe('새 그림(v3)은 검사를 통과하지 못해 쓰지 않았어요. 지금 그림(v2)을 그대로 써요.');
  });

  it('goes when the next picture is on its way, when it has landed, and when the kept-out picture was taken after all', async () => {
    const next = { ...lamp, imageJobId: 'lamp_draw4' };
    await show(snapOf([next], [drew2, draw3(), job('lamp_draw4', 'image', 'lamp', 'running', { provider: 'mediagen_image' })], pictures), 'props');
    expect(noteOf('반딧불 등불')).toBeNull();
    const landed = { ...lamp, version: 4, imageAssetId: 'lamp_v4', imageJobId: 'lamp_draw4' };
    await show(snapOf([landed], [drew2, draw3(), job('lamp_draw4', 'image', 'lamp', 'done', { provider: 'mediagen_image', outputs: ['lamp_v4'] })],
      [...pictures, asset('lamp_v4', 'image', 'lamp', { meta: { version: 4 } })]), 'props');
    expect(noteOf('반딧불 등불')).toBeNull();
    // 이 버전 쓰기 in 버전 기록: the picture is in use now, and the card's own check line says what the check found
    await show(snapOf([{ ...lamp, version: 3, imageAssetId: 'lamp_v3' }], [drew2, draw3()], pictures), 'props');
    expect(noteOf('반딧불 등불')).toBeNull();
    expect(card('반딧불 등불').querySelector('.card-media-status.is-failed')!.textContent).toContain('구도 검사 실패');
    // a picture that passed, and a first picture kept although its check failed (it is the one in use): nothing to say
    await show(snapOf([{ ...lamp, imageJobId: 'lamp_draw2' }], [drew2], pictures), 'props');
    expect(noteOf('반딧불 등불')).toBeNull();
  });
});

// Whatever model name a draw line still carries is not printed; the model is a tooltip.
describe('a picture being drawn names no model on its card or its row (R20-21)', () => {
  const draw = (progress: string, extra: Partial<Job> = {}) => job('wiz_draw', 'image', 'wiz', 'running', { provider: 'mediagen_image', progress,
    ...extra, input: { model: 'krea', modelLabel: 'Krea 2 Turbo', ...extra.input } });
  const status = () => card('꼬마 마법사').querySelector<HTMLElement>('.card-media-status')!;

  it('strips the model from an image job\'s line, as the server wrote it until round 21 and as it writes it now', () => {
    expect(drawLine('Krea 2 Turbo 그리는 중 (GPU 대기 포함)')).toBe('그림 그리는 중 (GPU 대기 포함)');
    expect(drawLine('Qwen-Image-2.1 (7B) 그리는 중 (GPU 대기 포함)')).toBe('그림 그리는 중 (GPU 대기 포함)');
    expect(drawLine('이미지 그리는 중 (GPU 대기 포함)')).toBe('그림 그리는 중 (GPU 대기 포함)'); // a draw with no label on it
    expect(drawLine('FLUX.2 klein 9B: 정지된 GPU 서버 켜는 중 · 보통 ~4분')).toBe('정지된 GPU 서버 켜는 중 · 보통 ~4분');
    expect(drawLine('그림 그리는 중 (GPU 대기 포함)')).toBe('그림 그리는 중 (GPU 대기 포함)');
    expect(drawLine('정지된 GPU 서버 켜는 중 · 보통 ~4분')).toBe('정지된 GPU 서버 켜는 중 · 보통 ~4분');
    // a redraw's own line, and no line at all
    expect(drawLine('구도를 다시 그리는 중: 왼쪽이 프레임에 잘림')).toBe('구도를 다시 그리는 중: 왼쪽이 프레임에 잘림');
    expect([drawLine(undefined), drawLine('')]).toEqual(['', '']);
    expect(jobWait(draw('Krea 2 Turbo 그리는 중 (GPU 대기 포함)')).progress).toBe('그림 그리는 중 (GPU 대기 포함)');
    // only a picture's job is read that way: another kind's line is its own
    expect(jobWait(job('wiz_pose', 'apose', 'wiz', 'running', { progress: 'A-포즈로 다시 그리는 중 (klein)' })).progress).toBe('3D용 자세 그림 그리는 중');
    // a restyle's first frames named their model in brackets
    expect(plainLine('화풍 기준 프레임 그리는 중 (0/1, FLUX.2 klein)')).toBe('화풍 기준 프레임 그리는 중 (0/1)');
  });

  it('a first picture: the card says 그림 그리는 중 once, with the model as its tooltip', async () => {
    const drawing = ip('wiz', 'character', '꼬마 마법사', { imageAssetId: undefined, imageJobId: 'wiz_draw' });
    await show(snapOf([drawing], [draw('Krea 2 Turbo 그리는 중 (GPU 대기 포함)')]));
    expect([status().textContent, status().title]).toEqual(['그림 그리는 중 (GPU 대기 포함)', 'Krea 2 Turbo']);
    await show(snapOf([drawing], [draw('Krea 2 Turbo: 정지된 GPU 서버 켜는 중 · 보통 ~4분')]));
    expect(status().textContent).toBe('그림 그리는 중 · 정지된 GPU 서버 켜는 중 · 보통 ~4분');
    await show(snapOf([drawing], [draw('')]));
    expect(status().textContent).toBe('그림 그리는 중');
  });

  it('a new version: 새 버전 그리는 중, the same way', async () => {
    const redrawing = ip('wiz', 'character', '꼬마 마법사', { imageJobId: 'wiz_draw' });
    await show(snapOf([redrawing], [draw('FLUX.2 klein 9B 그리는 중 (GPU 대기 포함)', { input: { model: 'klein9', modelLabel: 'FLUX.2 klein 9B' } })]));
    expect([status().textContent, status().title]).toEqual(['새 버전 그리는 중 (GPU 대기 포함)', 'FLUX.2 klein 9B']);
    await show(snapOf([redrawing], [draw('구도를 다시 그리는 중: 왼쪽이 프레임에 잘림')]));
    expect(status().textContent).toBe('새 버전 그리는 중 · 구도를 다시 그리는 중: 왼쪽이 프레임에 잘림');
    expect(container.textContent).not.toMatch(/Krea|FLUX|klein/);
  });

  it('작업 현황 says the same, the line as written only as a tooltip', async () => {
    const drawing = ip('wiz', 'character', '꼬마 마법사', { imageAssetId: undefined, imageJobId: 'wiz_draw' });
    await show(snapOf([drawing], [draw('Krea 2 Turbo 그리는 중 (GPU 대기 포함)')]), 'pipeline');
    const line = container.querySelector<HTMLElement>('.job-progress')!;
    expect([line.textContent, line.title]).toEqual(['그림 그리는 중 (GPU 대기 포함)', 'Krea 2 Turbo 그리는 중 (GPU 대기 포함)']);
    expect(container.querySelector('.job-meta span')!.getAttribute('title')).toBe('Krea 2 Turbo'); // where it runs: 이미지 GPU, the model on hover
  });
});

// The check notes end in 해요체 and say 이 버전 쓰기 (server/providers/mediagen_image.py KEPT_END, USED_END, MOVED_END);
// the card says them so for a record written either way.
describe('a check note ends in the screen\'s speech level and by the button\'s name (R20-51)', () => {
  const LEAD = '수정 검사 실패: 배경이 바뀜(2번 그려도 같음). ';
  const edit = (ending: string) => job('lamp_draw2', 'image', 'lamp', 'done', { outputs: ['lamp_v2'], error: `${LEAD}${ending}`, input: { version: 2 } });
  const WRITTEN = ['새 그림(v2)은 버전 기록에만 두고 지금 그림(v1)을 그대로 써요.', '새 그림(v2)은 버전 기록에만 두고 지금 그림(v1)을 그대로 씁니다.'];
  const lamp = (extra: Partial<Ip> = {}) => ip('lamp', 'prop', '반딧불 등불', { imageAssetId: 'lamp_v1', ...extra });

  it.each(WRITTEN)('a note that ends "%s" reads the same three ways', (ending) => {
    expect(jobNote(edit(ending), [lamp()])).toBe(`${LEAD}새 그림(v2)은 버전 기록에만 두고 지금 그림(v1)을 그대로 써요.`);
    expect(jobNote(edit(ending), [lamp({ version: 2, imageAssetId: 'lamp_v2' })])).toBe(`${LEAD}이 그림(v2)을 ‘이 버전 쓰기’로 지금 그림으로 쓰고 있어요.`);
    expect(jobNote(edit(ending), [lamp({ version: 4, imageAssetId: 'lamp_v4' })])).toBe(`${LEAD}새 그림(v2)은 버전 기록에만 있고 지금 그림은 다른 버전(v4)이에요.`);
  });

  it('no ending is 합니다체 or says 되돌리기; any other line is as stored', () => {
    for (const current of [lamp(), lamp({ version: 2, imageAssetId: 'lamp_v2' }), lamp({ version: 4, imageAssetId: 'lamp_v4' })]) {
      expect(jobNote(edit(WRITTEN[1]), [current])!.slice(LEAD.length)).not.toMatch(/니다|되돌리기/);
    }
    expect(jobNote({ ...edit(''), error: 'GPU server busy' }, [lamp()])).toBe('GPU server busy');
    const first = `${LEAD}첫 그림이라 그대로 두었으니 다시 뽑아 주세요.`;
    expect(jobNote({ ...edit(''), error: first }, [lamp()])).toBe(first);
  });
});

// The "이전 그림으로 만든 3D" notice comes first, above the model and its film, so it is in view in a short window.
describe('the 3D tab says first that a model was made from an earlier picture', () => {
  const lantern = ip('lamp', 'prop', '반딧불 등불', { version: 2, imageAssetId: 'lamp_img2', glbAssetId: 'lamp_glb' });
  const lira = ip('lira', 'character', '리라', { glbAssetId: 'lira_glb' });
  // 리라's model first (made earlier), from the picture she still has; 등불's from its v1, the picture is v2 now
  const files = [asset('lira_glb', 'glb', 'lira', { jobId: 'lira_mesh', createdAt: at('03:20:00') }), asset('lamp_glb', 'glb', 'lamp', { jobId: 'lamp_mesh', createdAt: at('03:30:00') }),
    asset('lamp_film', 'turntable', 'lamp', { jobId: 'lamp_turn' }), asset('lamp_img2', 'image', 'lamp', { meta: { version: 2 } })];
  const jobs = [job('lira_pose', 'apose', 'lira', 'done', { input: { imageKey: 'k/lira_img' } }), job('lira_mesh', 'mesh3d', 'lira', 'done', { deps: ['lira_pose'] }),
    job('lamp_mesh', 'mesh3d', 'lamp', 'done', { input: { cutoutKey: 'k/lamp_img' } }), job('lamp_turn', 'render3d', 'lamp', 'done', { deps: ['lamp_mesh'] })];
  const names = () => [...container.querySelectorAll('article.card h3')].map((h) => h.textContent);
  const before = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

  it('the notice, with its button, stands before the model and its film', async () => {
    await show(snapOf([lira, lantern], jobs, files), '3d');
    const stale = card('반딧불 등불').querySelector('.model-stale')!;
    expect(stale.querySelector('.model-stale-text')!.textContent).toBe('그림 v1로 만든 3D예요. 지금 그림은 v2예요.');
    expect(before(stale, card('반딧불 등불').querySelector('.media-pair')!)).toBe(true);
    expect(before(stale.querySelector('button')!, card('반딧불 등불').querySelector('.media-pair')!)).toBe(true);
    // a model of the picture in use says so under its views
    const source = card('리라').querySelector('.model-source')!;
    expect(source.textContent).toBe('그림 v1로 만든 3D예요.');
    expect(before(card('리라').querySelector('.media-pair')!, source)).toBe(true);
  });

  it('such a model comes first in the tab, so the notice is the first thing in it', async () => {
    await show(snapOf([lira, lantern], jobs, files), '3d');
    expect(names()).toEqual(['반딧불 등불', '리라']);
    expect(container.querySelector('.stack')!.firstElementChild!.firstElementChild!.className).toBe('model-stale');
    // with every model made from the picture in use, the order is the one they were made in
    const current = jobs.map((j) => (j.jobId === 'lamp_mesh' ? { ...j, input: { ...j.input, cutoutKey: 'k/lamp_img2' } } : j));
    await show(snapOf([lira, lantern], current, files), '3d');
    expect(names()).toEqual(['리라', '반딧불 등불']);
  });

  it('the block is laid out for the top of its card', async () => {
    const fs = (await import('node:fs' as string)) as { existsSync: (p: string) => boolean; readFileSync: (p: string, e: 'utf8') => string };
    const css = fs.readFileSync(['src/origin.css', 'web/src/origin.css'].find((p) => fs.existsSync(p))!, 'utf8'); // run from web/ or the repo root
    expect(css.match(/\n\.model-stale \{([^}]*)\}/)![1]).toMatch(/margin:\s*12px 12px 0/);
  });
});
