import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditDrawer, TEXT_HINT } from './components/EditDrawer';
import { IpPane } from './components/IpPane';
import { jobTimes, jobWait, providerDetail, providerLabel, type Asset, type Job, type Snapshot } from './types';

// Copy on the studio's job cards and dialogs.
vi.hoisted(() => {
  window.matchMedia ??= (() => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
});
vi.mock('./api', async (importOriginal) => ({ ...(await importOriginal<typeof import('./api')>()), getGameSpec: () => new Promise(() => {}) }));

const job = (jobId: string, status: Job['status'], extra: Partial<Job> = {}): Job => ({
  jobId, kind: 'image', provider: 'mediagen_image', status, input: {}, outputs: [], deps: [], progress: '',
  createdAt: '2026-11-11T00:00:00Z', updatedAt: '2026-11-11T00:01:00Z', ...extra,
});
const snapshot = (over: Partial<Snapshot> = {}): Snapshot => ({
  session: { sessionId: 'ses_1', title: '카이로', genre: 'rpg-explore', createdAt: '2026-11-11T00:00:00Z' },
  messages: [], ips: [], assets: [], jobs: [], games: [], ...over,
} as Snapshot);

describe('job cards', () => {
  // the card says where the job runs in plain words; the model it names is the card's tooltip
  it('name the model that draws, not "Krea / klein" on every image', () => {
    const qwen = job('j_q', 'running', { input: { model: 'qwen-image-2-1-7b', modelLabel: 'Qwen-Image 2.1' } });
    expect([providerLabel(qwen), providerDetail(qwen)]).toEqual(['이미지 GPU', 'Qwen-Image 2.1']);
    expect(providerDetail(job('j_k', 'done', { input: { model: 'krea' } }))).toBe('Krea 2 Turbo');
    expect(providerDetail(job('j_old', 'done', { input: { model: 'qwen-image-2-1-7b' } }))).toBe('qwen-image-2-1-7b');
    // a klein edit redrawn on the head-keeping model names that model once the redraw went to it
    const redrawn = job('j_r', 'running', { redraws: 1, redrawFor: ['head'],
      input: { model: 'klein9', modelLabel: 'FLUX.2 klein 9B', headModel: 'qwen-image-2-1-7b', headLabel: 'Qwen-Image 2.1' } });
    expect(providerDetail(redrawn)).toBe('Qwen-Image 2.1');
    const shot = job('j_v', 'running', { kind: 'shot', provider: 'mediagen_video', input: { model: 'ltx' } });
    expect([providerLabel(shot), providerDetail(shot)]).toEqual(['영상 GPU', 'LTX-2.5']);
  });

  it('show the wait and the work apart, so the work sits next to its usual time', () => {
    const now = Date.parse('2026-11-11T00:21:21Z');
    const mesh = job('j_m', 'running', { kind: 'mesh3d', provider: 'img3d', startedAt: '2026-11-11T00:15:00Z' });
    expect(jobTimes(mesh, now)).toBe('대기 15:00 · 작업 6:21');
    expect(jobTimes({ ...mesh, status: 'queued', startedAt: undefined }, now)).toBe('대기 21:21');
    expect(jobTimes({ ...mesh, startedAt: undefined }, now)).toBe('경과 21:21'); // saved before startedAt existed
    expect(jobTimes({ ...mesh, startedAt: '2026-11-11T00:00:00Z' }, now)).toBe('작업 21:21'); // it never waited
    expect(jobTimes({ ...mesh, status: 'done', updatedAt: '2026-11-11T00:20:00Z' }, now)).toBe('대기 15:00 · 작업 5:00');
  });

  it("read the video box's English phases in Korean, a line saved before the server mapped them too", () => {
    const shot = (progress: string) => job('j_s', 'running', { kind: 'shot', provider: 'mediagen_video', progress });
    expect(jobWait(shot('queued')).progress).toBe('GPU 대기열에서 순서 기다리는 중');
    expect(jobWait(shot('denoising 40%')).progress).toBe('영상 생성 중 40%');
    expect(jobWait(shot('Blender 턴테이블 렌더 중 · 1분 5초')).progress).toBe('3D 회전 영상 만드는 중 · 1분 5초'); // a Korean line: its own words
  });
});

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

describe('영상 tab', () => {
  it('says 작업 진행 중 only in the section whose kind the job makes', async () => {
    const shot = job('j_shot', 'running', { kind: 'shot', provider: 'mediagen_video', input: { model: 'ltx' } });
    const h = { onAction: vi.fn(() => Promise.resolve()), onEdit: vi.fn(), onRetry: vi.fn(() => Promise.resolve()) };
    await act(async () => root.render(<IpPane snap={snapshot({ jobs: [shot] })} {...h} />));
    const empties = () => [...container.querySelectorAll('#ip-panel-video .empty')].map((p) => p.textContent);
    expect(empties()[0]).toBe('작업 1건 진행 중…');
    expect(empties().slice(1).some((t) => t?.includes('진행 중'))).toBe(false);

    const trailer = job('j_tr', 'queued', { kind: 'trailer', provider: 'ffmpeg', input: { make_shorts: true } });
    await act(async () => root.render(<IpPane snap={snapshot({ jobs: [shot, trailer] })} {...h} />));
    expect(empties()).toEqual(['작업 1건 진행 중…', '작업 1건 진행 중…', '작업 1건 진행 중…']);
  });
});

describe('the trailer dialog', () => {
  it("has its own hint, not the edit dialog's", async () => {
    await act(async () => root.render(<EditDrawer target={{ kind: 'trailer' }} onClose={vi.fn()} onSend={vi.fn(() => Promise.resolve())} />));
    const hint = container.querySelector('#edit-text-hint')!.textContent;
    expect(hint).toBe(TEXT_HINT.new);
    expect(hint).not.toContain('바꾸고 싶은 내용만');
    const asset = { assetId: 'ast_t', kind: 'trailer', key: 'k', url: 'u', meta: {}, createdAt: '' } as unknown as Asset;
    await act(async () => root.render(<EditDrawer target={{ kind: 'trailer', asset }} onClose={vi.fn()} onSend={vi.fn(() => Promise.resolve())} />));
    expect(container.querySelector('#edit-text-hint')!.textContent).toBe(TEXT_HINT.trailer);
    expect(TEXT_HINT.trailer).not.toBe(TEXT_HINT.ip);
  });
});
