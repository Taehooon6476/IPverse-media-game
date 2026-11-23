import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobsPanel } from './components/JobsPanel';
import { JOB_TYPICAL, THREE_D_TOTAL, jobTimes, jobWait, type Job, type Snapshot } from './types';

// What the 3D job cards say of their wait, their work and their usual time. The server keeps startedAt empty from
// the send until the GPU box takes the mesh (server/jobs.py own_start).
const at = (hms: string) => `2026-11-11T${hms}Z`;
const job = (jobId: string, status: Job['status'], extra: Partial<Job>): Job => ({
  jobId, kind: 'mesh3d', provider: 'img3d', status, input: {}, outputs: [], deps: [], progress: '',
  createdAt: at('01:34:49.139'), updatedAt: at('01:34:49.139'), ...extra,
});
// a prop's mesh: asked for, sent 90 s later behind the hero's, taken by the box five minutes after that
const waiting = job('job_49c31f1b19', 'running', { startedAt: '', progress: 'GPU 모델 로딩 중 · 대기열 1번째 · 시작까지 약 3분' });
const taken = { ...waiting, startedAt: at('01:41:17.000'), progress: 'Hunyuan3D · 3D 형상 생성 중 · 0초' };
const made = { ...taken, status: 'done' as const, progress: '', updatedAt: at('01:42:43.578') };
// the hero's mesh: sent to the stopped box, taken 19 s later (the box's start is not work)
const first = job('job_6db23190a2', 'done', { createdAt: at('01:34:35.313'), startedAt: at('01:36:35.000'), updatedAt: at('01:41:19.566') });

describe('a mesh sent to the GPU queue (#34)', () => {
  it('counts 대기 until the box takes it: the card read "대기 1:30 · 작업 2:13" over "GPU 모델 로딩 중 · 대기열 1번째"', () => {
    expect(jobTimes(waiting, Date.parse(at('01:38:32.300')))).toBe('대기 3:43');
    expect(jobTimes(taken, Date.parse(at('01:41:33.000')))).toBe('대기 6:28 · 작업 0:16');
    expect(jobTimes(made)).toBe('대기 6:28 · 작업 1:27'); // the wait behind the hero's job is wait, not work
    expect(jobTimes(first)).toBe('대기 2:00 · 작업 4:45'); // the box's start is not counted as work
  });

  it('never started when it was stopped in the queue, or retried and sent again', () => {
    expect(jobTimes({ ...waiting, status: 'failed', error: '사용자가 중지함', updatedAt: at('01:40:00.139') })).toBe('대기 5:11');
    const again = { ...waiting, retriedAt: at('01:50:00.000') };
    expect(jobTimes(again, Date.parse(at('01:51:05.000')))).toBe('대기 1:05');
    // a job saved before startedAt existed keeps the one 경과
    expect(jobTimes({ ...waiting, startedAt: undefined }, Date.parse(at('01:38:32.300')))).toBe('경과 3:43');
  });
});

describe('a turntable on the farm (#36)', () => {
  it('has a usual time that holds the two measured from their send: 작업 5:40 and 6:26 beside "보통 3–5분"', () => {
    const [lo, hi] = JOB_TYPICAL.render3d.match(/(\d+)–(\d+)분/)!.slice(1).map(Number);
    for (const sec of [340, 386]) {
      expect(sec).toBeGreaterThanOrEqual(lo * 60);
      expect(sec).toBeLessThanOrEqual(hi * 60);
    }
    // the hero's turntable, twelve minutes in
    const hero = job('job_1797623ff5', 'running', { kind: 'render3d', provider: 'deadline', createdAt: at('01:34:35.335'),
      startedAt: at('01:41:19.586'), progress: 'Blender 턴테이블 렌더 중 · 5분 16초' });
    expect(jobWait(hero)).toEqual({ progress: '3D 회전 영상 만드는 중 · 5분 16초', usual: '보통 4–7분' }); // the cards' words
    expect(THREE_D_TOTAL).toBe('9–21분'); // 1–2 + 2–8 + 2–4 + 4–7, as server/waits.py TOTAL
  });
});

describe('작업 현황 cards', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers({ toFake: ['Date'] });
    localStorage.clear();
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
  const snapshot = (jobs: Job[]): Snapshot => ({
    session: { sessionId: 'ses_f3e77ae920', title: '달빛 정원', genre: 'rpg-explore', createdAt: at('01:27:00.000') },
    messages: [], ips: [], assets: [], jobs, games: [],
  });
  const cards = () => [...container.querySelectorAll('.job')].map((c) => [c.querySelector('.job-kind')!.textContent,
    c.querySelector('.job-elapsed')!.textContent, c.querySelector('.job-progress')!.textContent]);

  it('the panel of 01:38:32Z (tl-103832.png): the mesh in the GPU queue waits, the turntables say 4–7 min', async () => {
    vi.setSystemTime(new Date(at('01:38:32.500')));
    const queued = (jobId: string, kind: Job['kind'], provider: Job['provider'], createdAt: string) =>
      job(jobId, 'queued', { kind, provider, createdAt: at(createdAt), progress: '선행 작업 대기 중' });
    const jobs = [
      { ...first, status: 'running' as const, progress: 'Hunyuan3D · 모델 로딩 중 · 60초' },
      waiting,
      queued('job_1797623ff5', 'render3d', 'deadline', '01:34:35.335'),
      queued('job_f1bcd8f3f1', 'rig', 'rig', '01:34:35.341'),
      queued('job_a152e6718d', 'render3d', 'deadline', '01:34:49.162'),
    ];
    await act(async () => root.render(<JobsPanel snap={snapshot(jobs)} onRetry={() => Promise.resolve()} />));
    expect(cards()).toEqual([
      ['3D 모델', '대기 2:00 · 작업 1:58 · 보통 2–8분', 'AI 모델 불러오는 중 · 60초'],
      ['3D 모델', '대기 3:43 · 시작까지 약 3분', 'AI 모델 불러오는 중 · 대기열 1번째'],
      ['3D 회전 영상', '대기 3:57 · 보통 4–7분', '앞 단계가 끝나길 기다리는 중'],
      ['움직임 뼈대', '대기 3:57 · 보통 2–4분', '앞 단계가 끝나길 기다리는 중'],
      ['3D 회전 영상', '대기 3:43 · 보통 4–7분', '앞 단계가 끝나길 기다리는 중'],
    ]);
  });
});
