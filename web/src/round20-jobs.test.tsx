import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { errorText, rigRefusal, type Asset, type Ip, type Job, type Snapshot } from './types';

// 작업 현황 (IpPane → JobsPanel). A job that ended in a failed check has its own state, colour and next step; a
// refused rig says its reason in Korean and offers no 다시 시도 that would fail again; a running job can be stopped here.
vi.hoisted(() => { // IpPane reads prefers-reduced-motion when it loads; jsdom has no matchMedia
  window.matchMedia ??= (() => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
});

const at = (clock: string) => `2026-11-16T${clock}Z`;
const image = (assetId: string, ipId: string, jobId: string, version: number): Asset => ({ assetId, kind: 'image', key: `sessions/s/${assetId}.png`,
  url: `https://cdn/${assetId}.png`, contentType: 'image/png', ipId, jobId, meta: { version }, createdAt: at('03:13:00') });
const job = (jobId: string, kind: Job['kind'], provider: Job['provider'], status: Job['status'], extra: Partial<Job> = {}): Job => ({
  jobId, kind, provider, status, input: {}, outputs: [], deps: [], progress: '', createdAt: at('03:12:00'), updatedAt: at('03:23:00'), ...extra });
const lira: Ip = { ipId: 'ip_lira', kind: 'character', name: '리라', description: '', version: 1, imageAssetId: 'ast_v1', cutoutAssetId: 'ast_c1',
  imageJobId: 'job_edit', createdAt: at('03:12:00') };
const bron: Ip = { ipId: 'ip_bron', kind: 'character', name: '대장장이 브론', description: '', version: 1, imageAssetId: 'ast_b1',
  glbAssetId: 'ast_bglb', createdAt: at('03:00:00') };
const lantern: Ip = { ipId: 'ip_lantern', kind: 'prop', name: '반딧불 등불', description: '', version: 1, imageAssetId: 'ast_l1', createdAt: at('03:12:00') };

const FIRST = job('job_first', 'image', 'mediagen_image', 'done', { input: { ipId: 'ip_lira', version: 1 }, outputs: ['ast_v1', 'ast_c1'], updatedAt: at('03:13:00') });
// as server/providers/mediagen_image.py check_note writes it
const REJECTED = '수정 검사 실패: 요청하지 않은 배경 변경, 요청 밖 변경: 배경이 숲에서 단색 스튜디오로 바뀜(2번 그려도 같음). 새 그림(v2)은 버전 기록에만 두고 지금 그림(v1)을 그대로 씁니다.';
const EDIT = job('job_edit', 'image', 'mediagen_image', 'done', { input: { ipId: 'ip_lira', version: 2, edit: 'a red cloak' }, outputs: ['ast_v2', 'ast_c2'],
  error: REJECTED });
// a first picture the composition check failed: kept as the IP's picture, flagged
const CUT = '구도 검사 실패: 위쪽·아래쪽이 프레임에 잘림(2번 그려도 같음). 첫 그림이라 그대로 두었으니 다시 뽑아 주세요.';
const LANTERN = job('job_lantern', 'image', 'mediagen_image', 'done', { input: { ipId: 'ip_lantern', version: 1 }, outputs: ['ast_l1'], error: CUT });
const RIG = job('job_rig', 'rig', 'rig', 'failed', { input: { ipId: 'ip_bron' },
  error: '리깅 불가: not a full body: legs are missing or cut off (hips at 25% of the height)' });

const snapOf = (jobs: Job[], ips: Ip[] = [lira, bron, lantern]) => ({ session: { sessionId: 's', title: 't', genre: 'sf-shooter', createdAt: at('03:00:00') },
  messages: [], games: [], ips, jobs,
  assets: [image('ast_v1', 'ip_lira', 'job_first', 1), image('ast_v2', 'ip_lira', 'job_edit', 2), image('ast_l1', 'ip_lantern', 'job_lantern', 1),
    image('ast_b1', 'ip_bron', 'job_b', 1)] }) as Snapshot;

type OnAction = (tool: string, args: Record<string, unknown>, background?: boolean) => Promise<void>;
let container: HTMLDivElement;
let root: Root;
let onAction: Mock<OnAction>;
let onRetry: Mock<(jobId: string) => Promise<void>>;
let onCancelJob: Mock<(jobId: string) => Promise<void>>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
  localStorage.clear();
  onAction = vi.fn<OnAction>(async () => undefined);
  onRetry = vi.fn(async () => undefined);
  onCancelJob = vi.fn(async () => undefined);
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
const show = async (snap: Snapshot, cancel = true) => {
  history.replaceState(null, '', '#ip=pipeline');
  const { IpPane } = await import('./components/IpPane');
  await act(async () => root.render(<IpPane snap={snap} onAction={onAction} onEdit={vi.fn()} onRetry={onRetry} {...(cancel ? { onCancelJob } : {})} />));
};
const groups = () => [...container.querySelectorAll<HTMLButtonElement>('.job-group > .fold-head')].map((b) => [
  b.querySelector('.fold-title')!.textContent, b.querySelector('.fold-meta')!.textContent, b.getAttribute('aria-expanded')]);
const card = (jobId: string) => container.querySelector<HTMLElement>(`.job[data-job="${jobId}"]`)!;
const buttons = (jobId: string) => [...card(jobId).querySelectorAll<HTMLButtonElement>('button')].map((b) => b.textContent);
const press = (jobId: string, text: string) => act(async () => [...card(jobId).querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text)!.click());

describe('R20-09 a job that ended in a failed check is its own state', () => {
  it('lists a rejected edit under 검사 실패, open, apart from 완료, with an amber 적용 안 됨', async () => {
    await show(snapOf([FIRST, EDIT]));
    expect(groups()).toEqual([['검사 실패', '1건', 'true'], ['완료', '1건', 'false']]);
    expect(container.querySelector('#jobs-rejected-head .badge')!.className).toBe('badge badge--rejected');
    const edit = card('job_edit');
    expect(edit.closest('[role="region"]')!.id).toBe('jobs-rejected-region');
    expect([edit.className, edit.querySelector('.job-head .badge')!.className, edit.querySelector('.job-head .badge')!.textContent])
      .toEqual(['job job--rejected', 'badge badge--rejected', '적용 안 됨']);
    // the reason, as it holds now, in the warning colour and not a failure's
    const line = edit.querySelector('.job-error')!;
    // (its ending in today's words, whichever way the record was written)
    expect([line.className, line.textContent]).toEqual(['job-error job-error--check', REJECTED.replace('그대로 씁니다.', '그대로 써요.')]);
    expect(card('job_first').querySelector('.job-head .badge')!.textContent).toBe('완료'); // a picture that passed
    expect(card('job_first').closest('[role="region"]')!.id).toBe('jobs-done-region');
  });

  it('offers the next step: 버전 기록 for a picture the IP did not take', async () => {
    await show(snapOf([FIRST, EDIT]));
    expect(buttons('job_edit')).toEqual(['버전 기록 보기']);
    await press('job_edit', '버전 기록 보기');
    expect(document.querySelector('[role="dialog"] h2')!.textContent).toBe('리라 버전 기록');
  });

  it('… and 다시 뽑기 for a flagged picture that is the one in use (a first picture kept, or a rejected one chosen)', async () => {
    await show(snapOf([LANTERN, FIRST, EDIT], [{ ...lira, version: 2, imageAssetId: 'ast_v2', cutoutAssetId: 'ast_c2' }, bron, lantern]));
    expect(card('job_lantern').querySelector('.job-head .badge')!.textContent).toBe('검사 실패');
    expect(buttons('job_lantern')).toEqual(['다시 뽑기']);
    await press('job_lantern', '다시 뽑기');
    expect(onAction).toHaveBeenLastCalledWith('reroll_ip_image', { ipId: 'ip_lantern' }, true);
    // 리라 uses the rejected v2 now: the line says so (types.ts jobNote), and the picture in use can be drawn again
    expect([card('job_edit').querySelector('.job-head .badge')!.textContent, buttons('job_edit')]).toEqual(['검사 실패', ['다시 뽑기']]);
    expect(card('job_edit').querySelector('.job-error')!.textContent).toContain('이 그림(v2)을 ‘이 버전 쓰기’로 지금 그림으로 쓰고 있어요.');
  });

  it('keeps the order 진행 중 · 실패 · 검사 실패 · 완료', async () => {
    await show(snapOf([FIRST, EDIT, RIG, job('job_run', 'shot', 'mediagen_video', 'running')]));
    expect(groups().map(([title]) => title)).toEqual(['진행 중', '실패', '검사 실패', '완료']);
  });
});

// A done job that was no success is known by its check line or by the server's own mark (server/jobs.py `outcome`:
// "rejected" = kept out, "check_failed" = in use although its check failed).
describe('the server\'s mark on a done job counts like its check line (round20 review, web)', () => {
  const marked = (outcome: 'rejected' | 'check_failed', extra: Partial<Job> = {}) => ({ ...EDIT, error: undefined, ...extra, outcome }) as Job;

  it('a picture marked rejected is under 검사 실패 with 적용 안 됨, a line that says so and the way to its versions', async () => {
    await show(snapOf([FIRST, marked('rejected')]));
    expect(groups()).toEqual([['검사 실패', '1건', 'true'], ['완료', '1건', 'false']]);
    const edit = card('job_edit');
    expect([edit.className, edit.querySelector('.job-head .badge')!.className, edit.querySelector('.job-head .badge')!.textContent])
      .toEqual(['job job--rejected', 'badge badge--rejected', '적용 안 됨']);
    expect(edit.querySelector('.job-error')!.textContent).toBe('검사를 통과하지 못해 적용하지 않았어요. 지금 그림을 그대로 써요.');
    expect(buttons('job_edit')).toEqual(['버전 기록 보기']);
  });

  it('a picture marked check_failed that its IP uses reads 검사 실패, with 다시 뽑기', async () => {
    await show(snapOf([marked('check_failed', { jobId: 'job_lantern', input: { ipId: 'ip_lantern', version: 1 }, outputs: ['ast_l1'] })]));
    expect(groups()).toEqual([['검사 실패', '1건', 'true']]);
    expect(card('job_lantern').querySelector('.job-head .badge')!.textContent).toBe('검사 실패');
    expect(card('job_lantern').querySelector('.job-error')!.textContent).toBe('검사를 통과하지 못한 그림이에요. 다시 뽑는 편이 좋아요.');
    expect(buttons('job_lantern')).toEqual(['다시 뽑기']);
  });

  it('the IP as it is now still decides between the two badges: a rejected version chosen later is the one in use', async () => {
    await show(snapOf([FIRST, marked('rejected', { error: REJECTED })], [{ ...lira, version: 2, imageAssetId: 'ast_v2', cutoutAssetId: 'ast_c2' }, bron, lantern]));
    expect([card('job_edit').querySelector('.job-head .badge')!.textContent, buttons('job_edit')]).toEqual(['검사 실패', ['다시 뽑기']]);
  });

  it('a shot delivered as a stand-in for the GPU\'s result is under 검사 실패 with its line, and no button for a picture', async () => {
    // as server/providers/mediagen_video.py wrote it: the upscale the GPU drew again, delivered as the source enlarged
    const note = '원본 보존 검사 실패: GPU가 만든 결과가 원본 그림과 달라(얼굴이 바뀜) 원본을 그대로 2배로 키운 영상으로 대신했습니다.';
    await show(snapOf([job('job_up', 'shot', 'mediagen_video', 'done', { input: { sourceIpId: 'ip_lira', edit: 'v2v', task: 'upscale', model: 'ltx' },
      outputs: ['ast_up'], error: note, outcome: 'check_failed' } as Partial<Job>)]));
    expect(groups()).toEqual([['검사 실패', '1건', 'true']]);
    expect([card('job_up').className, card('job_up').querySelector('.job-head .badge')!.textContent]).toEqual(['job job--rejected', '검사 실패']);
    expect(card('job_up').querySelector('.job-error')!.textContent).toBe(note);
    expect(buttons('job_up')).toEqual([]);
  });

  it('a done job with neither stays 완료', async () => {
    await show(snapOf([FIRST]));
    expect(groups()).toEqual([['완료', '1건', 'false']]);
    expect(card('job_first').querySelector('.job-error')).toBeNull();
  });
});

describe('R20-41 a failed or blocked job says what to do', () => {
  const rig = (error?: string, extra: Partial<Job> = {}): Job => ({ ...RIG, error, ...extra });
  const LEGS_CUT = '다리가 보이지 않거나 너무 짧아요';
  // what the picture needs, after the reason
  const NEEDS = '머리부터 발끝까지 보이고 두 다리가 드러나게 서 있는 그림으로 다시 뽑은 뒤 3D를 다시 만들어 주세요.';

  it('reads a refused rig in Korean, with what helps: another picture, not another try', () => {
    expect(rigRefusal(RIG)).toEqual({ why: LEGS_CUT });
    expect(rigRefusal(rig('리깅 불가: legs of uneven length (28%) after implausible pose'))).toEqual({
      why: '두 다리의 길이가 다르게 보여요(꼬리나 긴 옷자락이 다리처럼 보일 수 있어요)' });
    expect([rigRefusal(rig('Blender 작업 실패')), rigRefusal(rig(undefined))]).toEqual([null, null]);
    expect(errorText(RIG.error)).toBe(LEGS_CUT); // a line alone says it too (the worker's reason is on it)
  });

  // The page must not match the server's lead words: a reworded lead would read every refusal as a failure to try again.
  it('knows a refusal by the worker\'s own reason, whatever the server writes before it', () => {
    const now = '움직임 뼈대를 넣을 수 없는 모양입니다: not a full body: legs are missing or cut off (hips at 30% of the height)';
    expect(rigRefusal(rig(now))).toEqual({ why: LEGS_CUT });
    expect(rigRefusal(rig('뼈대를 넣기 어려운 모습이에요: legs of uneven length (31%) after pose estimator failed'))?.why).toContain('두 다리의 길이');
    // a failure that is no refusal: the same farm's own lines, and the worker's reason of a rig that was made
    expect(rigRefusal(rig('렌더 서버에서 작업이 실패했습니다: FAILED'))).toBeNull();
    expect(rigRefusal(rig('움직임 뼈대를 넣을 수 없는 모양입니다: pose estimator failed'))).toBeNull();
    // only a rig is refused this way, and only once it has ended so
    expect(rigRefusal({ ...rig(now), kind: 'mesh3d' })).toBeNull();
    expect(rigRefusal(rig(now, { status: 'running' }))).toBeNull();
  });

  it('the reasons the worker writes today are refusals, in the line the server builds around them today (the sides cannot drift)', async () => {
    const fs = (await import('node:fs' as string)) as { existsSync: (p: string) => boolean; readFileSync: (p: string, e: 'utf8') => string };
    const read = (path: string) => fs.readFileSync([`../${path}`, path].find((p) => fs.existsSync(p))!, 'utf8'); // run from web/ or the repo root
    // the two reasons the worker refuses with (workers/rig/blender_rig.py: method "refused")
    const worker = read('workers/rig/blender_rig.py');
    const reasons = ['PARTIAL', 'UNEVEN'].map((name) => worker.match(new RegExp(`^${name} = "([^"]+)"`, 'm'))?.[1]);
    expect(reasons.every(Boolean)).toBe(true);
    // server/providers/rig.py status() passes the reason on after its own lead (f"<lead>: {reason}"); when it stops
    // building the line that way, the reason alone is what is left to know it by
    const line = read('server/providers/rig.py').match(/f"([^"\n]*\{reason\}[^"\n]*)"/)?.[1] ?? '{reason}';
    for (const reason of reasons) expect(rigRefusal(rig(line.replace('{reason}', `${reason} (30%)`)))).not.toBeNull();
  });

  it('takes the server\'s own mark and reason first (outcome "refused"), however the line is worded', () => {
    expect(rigRefusal(rig('움직임 뼈대를 넣지 못했습니다', { outcome: 'refused', reason: '다리가 옷에 가려 보이지 않아요.' }))).toEqual({ why: '다리가 옷에 가려 보이지 않아요' });
    // marked with no reason of its own: the worker's on the line, else a plain sentence
    expect(rigRefusal(rig(RIG.error, { outcome: 'refused' }))).toEqual({ why: LEGS_CUT });
    expect(rigRefusal(rig(undefined, { outcome: 'refused' }))).toEqual({ why: '뼈대를 맞출 수 없는 모양이에요' });
  });

  it('gives a rig refused for its picture 그림 다시 뽑기 in place of 다시 시도', async () => {
    await show(snapOf([RIG]));
    const line = card('job_rig').querySelector<HTMLElement>('.job-error')!;
    expect(line.textContent).toBe(`${LEGS_CUT}. ${NEEDS}`);
    expect(line.title).toBe(RIG.error); // the worker's own words stay a tooltip
    expect(buttons('job_rig')).toEqual(['그림 다시 뽑기']);
    await press('job_rig', '그림 다시 뽑기');
    expect(onAction).toHaveBeenLastCalledWith('reroll_ip_image', { ipId: 'ip_bron' }, true);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('… a refusal written after the round-20 deploy too, and one the server marks', async () => {
    await show(snapOf([rig('움직임 뼈대를 넣을 수 없는 모양입니다: not a full body: legs are missing or cut off (hips at 30% of the height)')]));
    expect(card('job_rig').querySelector('.job-error')!.textContent).toBe(`${LEGS_CUT}. ${NEEDS}`);
    expect(buttons('job_rig')).toEqual(['그림 다시 뽑기']);
    await show(snapOf([rig('움직임 뼈대를 넣지 못했습니다', { outcome: 'refused', reason: '다리가 옷에 가려 보이지 않아요.' })]));
    expect(card('job_rig').querySelector('.job-error')!.textContent).toBe(`다리가 옷에 가려 보이지 않아요. ${NEEDS}`);
    expect(card('job_rig').closest('[role="region"]')!.id).toBe('jobs-failed-region');
    expect(buttons('job_rig')).toEqual(['그림 다시 뽑기']);
  });

  it('keeps 다시 시도 for a rig that failed for another reason', async () => {
    await show(snapOf([rig('렌더 서버에서 작업이 실패했습니다: FAILED')]));
    expect(card('job_rig').querySelector('.job-error')!.textContent).toBe('렌더 서버에서 작업이 실패했습니다');
    expect(buttons('job_rig')).toEqual(['다시 시도']);
    // an older stored line, in the words the cards have now (리깅 is a tooltip at most)
    await show(snapOf([rig('리깅 불가: pose estimator failed')]));
    expect(card('job_rig').querySelector('.job-error')!.textContent).toBe('움직임 뼈대를 넣지 못했어요');
    expect(buttons('job_rig')).toEqual(['다시 시도']);
    await press('job_rig', '다시 시도');
    expect(onRetry).toHaveBeenCalledWith('job_rig');
  });

  // A refusal is the provider's answer to this very input, for any kind: the same try is refused again, so no row of a
  // refused job offers 다시 시도.
  it('a job of another kind the server marks refused says the server\'s reason, and offers no 다시 시도 either', async () => {
    await show(snapOf([job('job_mesh', 'mesh3d', 'img3d', 'failed', { input: { ipId: 'ip_lantern' }, error: 'refused: too thin', outcome: 'refused',
      reason: '모양이 너무 얇아 3D 모델로 만들 수 없어요.' })]));
    expect(card('job_mesh').querySelector('.job-error')!.textContent).toBe('모양이 너무 얇아 3D 모델로 만들 수 없어요.');
    expect(buttons('job_mesh')).toEqual([]);
    // marked refused with no sentence of its own: still no retry, and the line it left is what the row says
    await show(snapOf([job('job_mesh', 'mesh3d', 'img3d', 'failed', { input: { ipId: 'ip_lantern' }, error: '3D 모델을 만들 수 없는 그림이에요', outcome: 'refused' })]));
    expect(card('job_mesh').querySelector('.job-error')!.textContent).toBe('3D 모델을 만들 수 없는 그림이에요');
    expect(buttons('job_mesh')).toEqual([]);
  });

  it('tells a job that never started which step failed before it and where to press', async () => {
    const mesh = job('job_mesh', 'mesh3d', 'img3d', 'failed', { input: { ipId: 'ip_lantern' }, error: 'GPU 작업이 응답하지 않습니다 (하트비트 끊김)' });
    const turn = job('job_turn', 'render3d', 'deadline', 'failed', { input: { ipId: 'ip_lantern' }, deps: ['job_mesh'], error: '선행 작업 실패' });
    const trailer = job('job_trailer', 'trailer', 'ffmpeg', 'failed', { input: { title: '별빛 숲' }, deps: ['job_turn'], error: '선행 작업 실패' });
    await show(snapOf([mesh, turn, trailer]));
    expect(card('job_turn').querySelector('.job-error')!.textContent)
      .toBe('앞 단계(3D 모델 · 반딧불 등불)가 실패해 시작하지 못했어요. 그 단계에서 ‘다시 시도’를 누르면 함께 다시 시작돼요.');
    // a job two steps behind names the step that failed by itself, not the blocked one between
    expect(card('job_trailer').querySelector('.job-error')!.textContent).toContain('앞 단계(3D 모델 · 반딧불 등불)가 실패해');
    expect([buttons('job_turn'), buttons('job_trailer'), buttons('job_mesh')]).toEqual([[], [], ['다시 시도']]);
    // the step it waited for is not in the list any more: the line still says what to do
    await show(snapOf([turn]));
    expect(card('job_turn').querySelector('.job-error')!.textContent)
      .toBe('앞 단계가 실패해 시작하지 못했어요. 실패한 앞 단계에서 ‘다시 시도’를 누르면 함께 다시 시작돼요.');
  });

  it('says a stopped job was stopped and can be started again', async () => {
    await show(snapOf([job('job_stop', 'shot', 'mediagen_video', 'failed', { input: { ipId: 'ip_lira' }, error: '사용자가 중지함' })]));
    expect(card('job_stop').querySelector('.job-error')!.textContent).toBe('중지한 작업이에요. ‘다시 시도’를 누르면 다시 시작돼요.');
    expect(buttons('job_stop')).toEqual(['다시 시도']);
  });

  it('has 중지 on queued and running jobs, as the top bar menu does', async () => {
    const running = job('job_run', 'mesh3d', 'img3d', 'running', { input: { ipId: 'ip_lantern' } });
    const queued = job('job_wait', 'render3d', 'deadline', 'queued', { input: { ipId: 'ip_lantern' }, deps: ['job_run'], createdAt: at('03:12:01') });
    await show(snapOf([running, queued, FIRST, RIG]));
    expect([buttons('job_run'), buttons('job_wait'), buttons('job_first')]).toEqual([['중지'], ['중지'], []]);
    const stop = [...card('job_wait').querySelectorAll('button')].find((b) => b.textContent === '중지')!;
    expect(stop.getAttribute('aria-label')).toBe('3D 회전 영상 반딧불 등불 중지');
    await act(async () => stop.click());
    expect(onCancelJob).toHaveBeenCalledWith('job_wait');
    // without a way to stop (no handler), no button that does nothing
    await act(async () => root.unmount());
    root = createRoot(container);
    await show(snapOf([running]), false);
    expect(buttons('job_run')).toEqual([]);
  });
});
