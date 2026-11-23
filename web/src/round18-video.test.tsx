import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IpPane } from './components/IpPane';
import { editLabel, jobTitle, shotModelLabel, type Asset, type Ip, type Job, type Snapshot } from './types';

// An upscale and a restyle of a shot are told apart from the original on their job cards and in the 영상 tab, and the
// 샷 section says so while the edits run.
vi.hoisted(() => {
  window.matchMedia ??= (() => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
});
vi.mock('./api', async (importOriginal) => ({ ...(await importOriginal<typeof import('./api')>()), getGameSpec: () => new Promise(() => {}) }));

const shotJob = (jobId: string, status: Job['status'], input: Job['input'], extra: Partial<Job> = {}): Job => ({
  jobId, kind: 'shot', provider: 'mediagen_video', status, input: { model: 'ltx', ...input }, outputs: [], deps: [], progress: '',
  createdAt: '2026-11-11T01:38:20Z', updatedAt: '2026-11-11T01:45:11Z', ...extra,
});
const shot = (assetId: string, jobId: string, meta: Asset['meta']): Asset => ({
  assetId, kind: 'shot', key: `sessions/ses_1/${assetId}.mp4`, url: `https://cdn.example.com/${assetId}.mp4`, contentType: 'video/mp4',
  ipId: 'ip_1', jobId, meta: { model: 'ltx', ...meta }, createdAt: '2026-11-11T01:45:11Z',
});
const baron = { ipId: 'ip_1', kind: 'character', name: '바론', description: 'a wandering knight', version: 2, createdAt: '2026-11-11T01:23:17Z' } as Ip;
const edit = { sourceIpId: 'ip_1', sourceShotJobId: 'j_src' };
// the session's jobs as the server has them: an edit carries sourceIpId, never ipId
const source = shotJob('j_src', 'done', { ipId: 'ip_1', prompt: '바론 running at full speed' });
const upscale = shotJob('j_up', 'done', { ...edit, edit: 'v2v', task: 'upscale' }, { updatedAt: '2026-11-11T01:58:57Z' });
const restyle = shotJob('j_re', 'running', { ...edit, edit: 'restyle', style: 'watercolor painting' }, { createdAt: '2026-11-11T02:00:00Z' });
const snapshot = (over: Partial<Snapshot> = {}): Snapshot => ({
  session: { sessionId: 'ses_1', title: '바론', genre: 'rpg-explore', createdAt: '2026-11-11T00:00:00Z' },
  messages: [], ips: [baron], games: [],
  assets: [shot('ast_src', 'j_src', {}), shot('ast_up', 'j_up', { edit: 'v2v', task: 'upscale', pieces: 2 })],
  jobs: [source, upscale, restyle], ...over,
} as Snapshot);

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
  history.replaceState(null, '', '/#ip=video');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const render = (snap: Snapshot) => act(async () => root.render(
  <IpPane snap={snap} onAction={vi.fn(() => Promise.resolve())} onEdit={vi.fn()} onRetry={vi.fn(() => Promise.resolve())} />));
const section = (title: string) => container.querySelector<HTMLElement>(`#ip-panel-video .video-section[aria-label="${title}"]`)!;
const captions = () => [...section('샷').querySelectorAll('figcaption > span:first-child')].map((s) => s.textContent);

describe('an edit of a shot', () => {
  it('is named by what it does', () => {
    expect(editLabel({ edit: 'v2v', task: 'upscale' })).toBe('업스케일');
    expect(editLabel({ edit: 'v2v', task: 'water+day_to_night' })).toBe('비·물 효과 + 낮→밤');
    expect(editLabel({ edit: 'v2v', task: 'hdr' })).toBe('hdr'); // a task the MCP added later: its own name
    expect(editLabel({ edit: 'restyle', style: 'watercolor painting' })).toBe('화풍 변경');
    expect(editLabel({ edit: 'inpaint', task: 'water' })).toBe('부분 수정');
    expect(editLabel({ model: 'ltx' })).toBeUndefined(); // a shot that is no edit
    expect(editLabel({ edit: 'a navy blue cloak instead of brown' })).toBeUndefined(); // an image edit's words
  });

  it('names its source IP and the edit on its job card', async () => {
    expect(jobTitle(upscale, [baron])).toBe('바론 · 업스케일');
    expect(jobTitle(source, [baron])).toBe('바론');
    await render(snapshot());
    await act(async () => container.querySelector<HTMLButtonElement>('#ip-tab-pipeline')!.click());
    const kinds = [...container.querySelectorAll('#ip-panel-pipeline .job-kind')].map((k) => k.textContent);
    expect(kinds).toEqual(['영상 샷 · 바론 · 화풍 변경', '영상 샷 · 바론 · 업스케일', '영상 샷 · 바론']); // told apart
  });

  it('is told apart from its source in the 영상 tab', async () => {
    await render(snapshot());
    expect(captions()).toEqual(['샷 1 · 바론 · LTX-2.5', '샷 2 · 바론 · 업스케일 · LTX-2.5']);
    // the upscale the box drew again, delivered as the source enlarged by ffmpeg (server/providers/mediagen_video.py)
    const plain = shot('ast_up', 'j_up', { edit: 'v2v', task: 'upscale', plain: true, model: 'ffmpeg' });
    await render(snapshot({ assets: [shot('ast_src', 'j_src', {}), plain] }));
    // no model drew it: it is the original, enlarged, so the caption names no tool
    expect(captions()[1]).toBe('샷 2 · 바론 · 업스케일 · 원본 확대');
    expect(shotModelLabel(plain)).toBe('원본 확대');
    expect(shotModelLabel(shot('ast_src', 'j_src', {}))).toBe('LTX-2.5');
  });
});

describe('영상 tab', () => {
  it('says a job is in flight in a section that already has shots', async () => {
    await render(snapshot());
    const line = section('샷').querySelector('[role="status"].empty');
    expect(line?.textContent).toBe('작업 1건 진행 중…');
    expect(section('샷').querySelectorAll('figure')).toHaveLength(2); // above the shots it has, not instead of them
    expect(section('트레일러').textContent).not.toContain('진행 중');

    await render(snapshot({ jobs: [source, upscale] })); // nothing in flight: no line, no hint over the shots
    expect(section('샷').querySelector('.empty')).toBeNull();
  });
});
