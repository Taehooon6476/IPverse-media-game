import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobsPanel } from './components/JobsPanel';
import { jobTimes, jobTitle, type Ip, type Job, type Snapshot } from './types';

// Two edits of one IP on Qwen-Image 2.1 (v2, v3), as the server stores them.
const QWEN = { model: 'qwen-image-2-1-7b', modelLabel: 'Qwen-Image-2.1 (7B)' };
const image = (jobId: string, input: Job['input'], extra: Partial<Job> = {}): Job => ({
  jobId, kind: 'image', provider: 'mediagen_image', status: 'done', input: { ipId: 'ip_b', ...input }, outputs: [], deps: [], progress: '',
  createdAt: '2026-11-12T02:09:49.416Z', startedAt: '2026-11-12T02:09:50.299Z', updatedAt: '2026-11-12T02:16:06.834Z', ...extra,
});
const first = image('job_1', { model: 'krea', modelLabel: 'Krea 2 Turbo', version: 1 });
const navy = image('job_2', { ...QWEN, version: 2, edit: 'the cloak is navy blue' });
const plume = image('job_3', { ...QWEN, version: 3, edit: 'a single red feather plume attached to the top of the helmet' });
const baron = { ipId: 'ip_b', kind: 'character', name: '바론', description: 'a knight', version: 3, createdAt: '2026-11-12T02:06:00Z' } as Ip;
const snapOf = (jobs: Job[]) => ({ session: { sessionId: 's', title: 't', genre: 'sf-shooter', createdAt: '' }, messages: [], games: [],
  ips: [baron], assets: [], jobs }) as Snapshot;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  localStorage.setItem('ipverse.jobsOpen.done', '1'); // the finished group folds away by default
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const render = (jobs: Job[]) => act(async () => root.render(<JobsPanel snap={snapOf(jobs)} onRetry={() => Promise.resolve()} />));

describe("an image job's card", () => {
  it('names the version it draws, and that it is an edit (m2.json: two identical "이미지 · 바론" cards for v2 and v3)', async () => {
    expect(jobTitle(first, [baron])).toBe('바론'); // an IP's first picture: nothing to tell apart
    expect(jobTitle(navy, [baron])).toBe('바론 · 수정 v2');
    expect(jobTitle(plume, [baron])).toBe('바론 · 수정 v3');
    expect(jobTitle(image('job_4', { model: 'krea', version: 4 }), [baron])).toBe('바론 · v4'); // 다시 뽑기, a fresh redraw
    expect(jobTitle(image('job_5', { model: 'klein9', asset: 'action_image', meta: {} }), [baron])).toBe('바론'); // an action still
    await render([first, navy, plume]);
    const cards = [...container.querySelectorAll('.job-kind')].map((k) => k.textContent);
    expect(cards.sort()).toEqual(['이미지 · 바론', '이미지 · 바론 · 수정 v2', '이미지 · 바론 · 수정 v3']);
    // which edit: its words, on hover
    const target = [...container.querySelectorAll<HTMLElement>('.job-target')].find((t) => t.textContent?.endsWith('수정 v3'))!;
    expect(target.title).toBe('a single red feather plume attached to the top of the helmet');
  });
});

describe("a finished job's time", () => {
  // a turntable the farm finished minutes before a poll settled it: the card counts to finishedAt, not to the poll
  const turntable = (extra: Partial<Job>): Job => ({ jobId: 'job_t', kind: 'render3d', provider: 'deadline', status: 'done',
    input: { ipId: 'ip_b' }, outputs: [], deps: [], progress: '', createdAt: '2026-11-12T01:35:49.000Z',
    startedAt: '2026-11-12T01:35:49.500Z', updatedAt: '2026-11-12T01:48:54.500Z', ...extra });

  it("ends when its provider says the work ended, not when a poll noticed it", () => {
    expect(jobTimes(turntable({ finishedAt: '2026-11-12T01:41:57.000Z' }))).toBe('작업 6:08');
    expect(jobTimes(turntable({}))).toBe('작업 13:05'); // a provider that says no end: to the poll
    expect(jobTimes(turntable({ finishedAt: '' }))).toBe('작업 13:05');
    // a failed one too; and a job still running counts to now whatever an earlier run left
    expect(jobTimes(turntable({ status: 'failed', finishedAt: '2026-11-12T01:41:57.000Z' }))).toBe('작업 6:08');
    expect(jobTimes(turntable({ status: 'running', finishedAt: '2026-11-12T01:41:57.000Z' }), Date.parse('2026-11-12T01:37:49.500Z')))
      .toBe('작업 2:00');
  });
});
