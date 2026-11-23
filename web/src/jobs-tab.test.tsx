import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GamePane } from './components/GamePane';
import { IpPane } from './components/IpPane';
import type { Job, Snapshot } from './types';

// 작업 현황 lives in IP & MEDIA STUDIO (most jobs are characters and videos); GAME STUDIO keeps 미리보기 and 설계 요약.
vi.hoisted(() => { // IpPane reads prefers-reduced-motion when it loads; jsdom has no matchMedia
  window.matchMedia ??= (() => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
});
vi.mock('./api', async (importOriginal) => ({ ...(await importOriginal<typeof import('./api')>()), getGameSpec: () => new Promise(() => {}) }));

const job = (jobId: string, status: Job['status'], extra: Partial<Job> = {}): Job => ({
  jobId, kind: 'render3d', provider: 'deadline', status, input: {}, outputs: [], deps: [], progress: '',
  createdAt: '2026-11-05T00:00:00Z', updatedAt: '2026-11-05T00:01:00Z', ...extra,
});
const snapshot = (over: Partial<Snapshot> = {}): Snapshot => ({
  session: { sessionId: 'ses_1', title: '루나', genre: 'rpg-quest', createdAt: '2026-11-05T00:00:00Z' },
  messages: [], ips: [], assets: [], jobs: [], games: [], ...over,
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
  history.replaceState(null, '', '/');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const handlers = () => ({ onAction: vi.fn(() => Promise.resolve()), onEdit: vi.fn(), onRetry: vi.fn(() => Promise.resolve()) });
const render = async (snap: Snapshot, h = handlers()) => {
  await act(async () => root.render(<IpPane snap={snap} {...h} />));
  return h;
};
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => container.querySelector<T>(selector)!;
const tabs = (label: string) => [...container.querySelectorAll<HTMLButtonElement>(`[role="tablist"][aria-label="${label}"] [role="tab"]`)];

describe('작업 현황 tab: in IP & MEDIA STUDIO, not in GAME STUDIO', () => {
  it('sits after 영상 with the job count badge', async () => {
    await render(snapshot({ jobs: [job('j_1', 'running'), job('j_2', 'done'), job('j_3', 'failed')] }));
    expect(tabs('IP 보기').map((t) => t.querySelector('.tab-label')!.textContent)).toEqual(['캐릭터', '소품', '3D', '영상', '작업 현황']);
    const jobsTab = $<HTMLButtonElement>('#ip-tab-pipeline');
    expect([jobsTab.querySelector('.tab-count')!.textContent, jobsTab.getAttribute('aria-label')]).toEqual(['3', '작업 현황 · 3개']);
    await act(async () => jobsTab.click());
    expect(location.hash).toBe('#ip=pipeline');
    expect($('#ip-panel-pipeline').querySelectorAll('.job')).toHaveLength(3);
  });

  it('opens 작업 현황 from the hash, and an old #game=pipeline link lands there too', async () => {
    history.replaceState(null, '', '/#s=ses_1&ip=pipeline');
    await render(snapshot());
    expect($('#ip-tab-pipeline').getAttribute('aria-selected')).toBe('true');
    await act(async () => root.unmount());
    root = createRoot(container);

    history.replaceState(null, '', '/#s=ses_1&ip=props&game=pipeline');
    await render(snapshot());
    expect($('#ip-tab-pipeline').getAttribute('aria-selected')).toBe('true');
    expect(new URLSearchParams(location.hash.slice(1)).get('game')).toBeNull();
    expect(new URLSearchParams(location.hash.slice(1)).get('s')).toBe('ses_1');
  });

  it('leaves GAME STUDIO with 미리보기 and 설계 요약', async () => {
    await act(async () => root.render(<GamePane snap={snapshot({ jobs: [job('j_1', 'running')] })} onGenre={vi.fn()} onError={vi.fn()}
      onDesign={vi.fn()} onExpand={vi.fn()} onEditGame={vi.fn()} onMakeHeld={vi.fn()} />));
    expect(tabs('게임 보기').map((t) => t.textContent)).toEqual(['미리보기', '설계 요약']);
    expect(container.querySelector('#game-tab-pipeline')).toBeNull();
  });
});

describe('작업 현황: the jobs in a fold per status', () => {
  const jobs = [
    job('j_done_old', 'done', { updatedAt: '2026-11-05T00:02:00Z' }),
    job('j_queued', 'queued', { kind: 'trailer', provider: 'ffmpeg', createdAt: '2026-11-05T00:03:00Z' }),
    job('j_failed', 'failed', { error: 'Blender 작업 실패' }),
    job('j_dep', 'failed', { kind: 'mesh3d', provider: 'img3d', error: '선행 작업 실패' }),
    job('j_running', 'running', { kind: 'shot', provider: 'mediagen_video', progress: 'denoising 40%' }),
    job('j_done_new', 'done', { kind: 'image', provider: 'mediagen_image', updatedAt: '2026-11-05T00:09:00Z' }),
  ];
  const openJobs = () => act(async () => $<HTMLButtonElement>('#ip-tab-pipeline').click());
  const region = (id: string) => $(`#jobs-${id}-region`);

  it('keeps 진행 중 and 실패 open, folds 완료 with its count, and leaves 다시 시도 on the failed jobs', async () => {
    const h = await render(snapshot({ jobs }));
    await openJobs();
    const heads = [...container.querySelectorAll<HTMLButtonElement>('.job-group > .fold-head')];
    expect(heads.map((b) => [b.querySelector('.fold-title')!.textContent, b.querySelector('.fold-meta')!.textContent, b.getAttribute('aria-expanded')]))
      .toEqual([['진행 중', '2건', 'true'], ['실패', '2건', 'true'], ['완료', '2건', 'false']]);
    const ids = (id: string) => [...region(id).querySelectorAll('.job')].map((li) => li.querySelector('.badge')!.textContent);
    expect(ids('running')).toEqual(['진행 중', '대기']); // running before queued
    expect(region('done').hasAttribute('inert')).toBe(true);
    expect([...region('done').querySelectorAll('.job-kind')].map((k) => k.textContent)).toEqual(['이미지', '3D 회전 영상']); // newest first

    // 다시 시도 only on the job that failed by itself: the dependent one is re-queued with it
    const retry = [...region('failed').querySelectorAll<HTMLButtonElement>('button')].filter((b) => b.textContent === '다시 시도');
    expect(retry.map((b) => b.getAttribute('aria-label'))).toEqual(['3D 회전 영상 다시 시도']);
    await act(async () => retry[0].click());
    expect(h.onRetry).toHaveBeenCalledWith('j_failed');

    await act(async () => $<HTMLButtonElement>('#jobs-done-head').click());
    expect(region('done').hasAttribute('inert')).toBe(false);
    expect(localStorage.getItem('ipverse.jobsOpen.done')).toBe('1');
    await act(async () => $<HTMLButtonElement>('#jobs-running-head').click());
    expect(localStorage.getItem('ipverse.jobsOpen.running')).toBe('0');
  });

  it("shows a chained restyle's own wait next to 경과 instead of the usual 보통 5–10분, never both (round 5 R6)", async () => {
    // server/providers/mediagen_video.py: every running line of a chained restyle ends with its wait
    const restyle = job('j_restyle', 'running', { kind: 'shot', provider: 'mediagen_video', input: { edit: 'restyle', model: 'ltx' },
      progress: 'denoising (조각 0/2 완료) · 조각마다 ~6분, 전체 보통 ~14분' });
    const shot = job('j_shot', 'running', { kind: 'shot', provider: 'mediagen_video', progress: 'denoising 40%', createdAt: '2026-11-05T00:01:00Z' });
    await render(snapshot({ jobs: [restyle, shot] }));
    await openJobs();
    const cards = [...region('running').querySelectorAll('.job')];
    expect(cards.map((c) => c.querySelector('.job-elapsed')!.textContent!.replace(/경과 [\d:]+/, '경과 m:ss'))).toEqual([
      '경과 m:ss · 조각마다 ~6분, 전체 보통 ~14분', '경과 m:ss · 보통 5–7분']); // an LTX shot's own
    expect(cards.map((c) => c.querySelector('.job-progress')!.textContent)).toEqual(['영상 생성 중 (조각 0/2 완료)', '영상 생성 중 40%']);
    expect(cards[0].textContent).not.toContain('5–10분');
    expect(cards[0].textContent).not.toContain('6–10분'); // nor an LTX edit's usual figure
  });

  it('shows a failed job\'s reason in Korean, the raw exception only on hover (round 6 N13)', async () => {
    // the background removal's 503 on three saves (server/jobs.py _collect_retry)
    const raw = '결과 저장을 반복 실패했습니다: An error occurred (ServiceUnavailableException) when calling the InvokeModel '
      + 'operation (reached max retries: 2): Bedrock is unable to process your request.';
    const lantern = job('j_lantern', 'failed', { kind: 'image', provider: 'mediagen_image', error: raw });
    await render(snapshot({ jobs: [lantern, job('j_failed', 'failed', { error: 'Blender 작업 실패' })] }));
    await openJobs();
    const lines = [...region('failed').querySelectorAll<HTMLElement>('.job-error')];
    expect(lines.map((p) => [p.textContent, p.title])).toEqual([['결과 저장을 반복 실패했습니다', raw], ['렌더 서버 작업 실패', 'Blender 작업 실패']]);
    expect(region('failed').textContent).not.toContain('Exception');
    expect(lines[0].closest('.job')!.querySelector('button')?.textContent).toBe('다시 시도'); // still retried from here
  });

  it('never shows a failed trailer\'s ffmpeg command line, not even on hover (round 9 M20)', async () => {
    // str(CalledProcessError) with the Korean title card text inside
    const cmd = "Command '['/opt/bin/ffmpeg', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=1280x720:d=2.5', '-vf', "
      + "\"drawtext=text='은하의 새벽을 지켜라'\", '/tmp/tmpf47kjrvt/card_title.mp4']' returned non-zero exit status 8.";
    await render(snapshot({ jobs: [job('j_trailer', 'failed', { kind: 'trailer', provider: 'ffmpeg', input: { title: 'Starfall Vanguard' }, error: cmd })] }));
    await openJobs();
    const line = region('failed').querySelector<HTMLElement>('.job-error')!;
    expect([line.textContent, line.title]).toEqual(['영상 처리 명령이 실패했어요', '']);
    expect(region('failed').innerHTML).not.toMatch(/ffmpeg'|drawtext/);
  });

  it('counts a retried job\'s 경과 from its retry, not from when it was first made (round 6 N14)', async () => {
    // made, failed after two minutes, 다시 시도 ten minutes later, done
    const lantern = job('j_lantern', 'done', { kind: 'image', provider: 'mediagen_image', createdAt: '2026-11-06T18:12:12.607Z',
      retriedAt: '2026-11-06T18:24:40.112Z', updatedAt: '2026-11-06T18:25:06.021Z' });
    const once = job('j_once', 'done', { kind: 'image', provider: 'mediagen_image', createdAt: '2026-11-06T18:12:12.584Z',
      updatedAt: '2026-11-06T18:14:39.618Z' }); // never retried: from createdAt
    await render(snapshot({ jobs: [lantern, once] }));
    await openJobs();
    expect([...region('done').querySelectorAll('.job-elapsed')].map((e) => e.textContent)).toEqual(['경과 0:26', '경과 2:27']);
  });

  it('shows only the groups that have jobs, and the empty state without any', async () => {
    await render(snapshot({ jobs: [job('j_done', 'done')] }));
    await openJobs();
    expect([...container.querySelectorAll('.job-group .fold-title')].map((t) => t.textContent)).toEqual(['완료']);
    await render(snapshot());
    expect(container.querySelector('.job-groups')).toBeNull();
    expect(container.textContent).toContain('진행 중인 작업이 없어요');
  });
});
