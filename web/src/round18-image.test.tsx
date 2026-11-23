import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { IpPane } from './components/IpPane';
import { assetModelLabel, currentDescription, imageState, jobNote, jobWait, mergeEdit, pictureCheck, type Asset, type Ip, type Job,
  type Snapshot } from './types';

// A first picture (v1, Krea) and an edit on Qwen-Image 2.1 that the edit check rejected on both draws (v2), as the
// server stores them.
vi.hoisted(() => { // IpPane reads prefers-reduced-motion when it loads; jsdom has no matchMedia
  window.matchMedia ??= (() => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
});
vi.mock('./api', async (importOriginal) => ({ ...(await importOriginal<typeof import('./api')>()), getGameSpec: () => new Promise(() => {}) }));

const QWEN = 'qwen-image-2-1-7b';
const LABEL = 'Qwen-Image-2.1 (7B)';
const BROWN = "A humanoid wandering knight wearing a full-coverage steel great helm, worn steel plate armor over chainmail, a long brown traveler's cloak draped over the shoulders, leather belt and boots";
const NAVY = BROWN.replace('brown', 'navy blue');
const WHY = '요청 밖 변경: 망토 색상 외에 장갑 및 부츠 모양이 약간 달라짐';
const KEPT = '새 그림(v2)은 버전 기록에만 두고 지금 그림(v1)을 그대로 씁니다.';
const NOTE = `수정 검사 실패: ${WHY}(2번 그려도 같음). ${KEPT}`;
const LEAD = NOTE.slice(0, -KEPT.length);

const image = (assetId: string, jobId: string, version: number, model: string, createdAt: string, meta: Record<string, unknown>): Asset => ({
  assetId, kind: 'image', key: `sessions/s/${assetId}.png`, url: `https://cdn/${assetId}.png`, contentType: 'image/png', ipId: 'ip_b',
  jobId, meta: { model, version, ...meta }, createdAt });
const cutout = (assetId: string, forAssetId: string): Asset => ({ assetId, kind: 'cutout', key: `sessions/s/${assetId}.png`,
  url: `https://cdn/${assetId}.png`, contentType: 'image/png', ipId: 'ip_b', meta: { forAssetId }, createdAt: '2026-11-11T01:33:24Z' });
const v1 = image('ast_v1', 'job_1', 1, 'krea', '2026-11-11T01:24:59.541Z', { check: { cut: [], ok: true, problem: '', subjects: 1 } });
// as mediagen_image._check_edit stores it: 1 subject, nothing cut, the edit's verdict under `edit`
const v2 = image('ast_v2', 'job_2', 2, QWEN, '2026-11-11T01:33:23.518Z', { edit: 'a navy blue cloak instead of brown', covered: true,
  description: NAVY, check: { cut: [], subjects: 1, redraws: 1, ok: false, problem: WHY, edit: { ok: false, headCovered: true,
    faceAppeared: false, backgroundChanged: false, styleChanged: false, other: '망토 색상 외에 장갑 및 부츠 모양이 약간 달라짐', problem: WHY } } });
const assets = [v1, cutout('ast_c1', 'ast_v1'), v2, cutout('ast_c2', 'ast_v2')];
const drew = (jobId: string, outputs: string[], input: Record<string, unknown>, extra: Partial<Job> = {}): Job => ({ jobId, kind: 'image',
  provider: 'mediagen_image', status: 'done', input: { ipId: 'ip_b', ...input }, outputs, deps: [], progress: '',
  createdAt: '2026-11-11T01:23:17Z', updatedAt: '2026-11-11T01:33:23Z', ...extra });
const first = drew('job_1', ['ast_v1', 'ast_c1'], { model: 'krea', modelLabel: 'Krea 2 Turbo', version: 1 });
const edit = drew('job_2', ['ast_v2', 'ast_c2'], { model: QWEN, modelLabel: LABEL, headModel: QWEN, headLabel: LABEL, version: 2 },
  { error: NOTE, redraws: 1, redrawFor: ['edit', 'head'] });
const baron: Ip = { ipId: 'ip_b', kind: 'character', name: '바론', description: BROWN, role: '주인공', version: 1, imageAssetId: 'ast_v1',
  cutoutAssetId: 'ast_c1', imageJobId: 'job_2', createdAt: '2026-11-11T01:23:17Z' };
const restored: Ip = { ...baron, version: 2, imageAssetId: 'ast_v2', cutoutAssetId: 'ast_c2' }; // 버전 기록 → v2로 되돌리기
const snapOf = (ip: Ip, over: Partial<Snapshot> = {}) => ({ session: { sessionId: 's', title: 't', genre: 'sf-shooter', createdAt: '' },
  messages: [], games: [], ips: [ip], assets, jobs: [first, edit], ...over }) as Snapshot;

type OnAction = (tool: string, args: Record<string, unknown>, background?: boolean) => Promise<void>;
let container: HTMLDivElement;
let root: Root;
let onAction: Mock<OnAction>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
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
  history.replaceState(null, '', `/#ip=${tab}`);
  await act(async () => root.render(<IpPane snap={snap} onAction={onAction} onEdit={vi.fn()} onRetry={vi.fn(() => Promise.resolve())} />));
};
const drawer = () => document.querySelector<HTMLElement>('[role="dialog"]')!; // on <body>: it covers the whole studio
const open = async (snap: Snapshot) => {
  await show(snap);
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label^="바론 버전 기록"]')!.click());
  return drawer();
};
const rows = () => [...drawer().querySelectorAll('.version-item')].map((li) => [li.querySelector('strong')!.textContent,
  li.querySelector('.version-check')?.textContent ?? null]);

describe('#24 a check note says which picture the IP uses now', () => {
  // (a note stored with the older endings is read in today's words)
  it('follows 이 버전 쓰기 and a later draw; any other line is as stored (server/tools.py job_note)', () => {
    expect(jobNote(edit, [baron])).toBe(`${LEAD}새 그림(v2)은 버전 기록에만 두고 지금 그림(v1)을 그대로 써요.`); // the IP still uses the picture it kept
    expect(jobNote(edit, [restored])).toBe(`${LEAD}이 그림(v2)을 ‘이 버전 쓰기’로 지금 그림으로 쓰고 있어요.`);
    expect(jobNote(edit, [{ ...baron, version: 3, imageAssetId: 'ast_v3' }])).toBe(`${LEAD}새 그림(v2)은 버전 기록에만 있고 지금 그림은 다른 버전(v3)이에요.`);
    expect(jobNote(edit, [])).toBe(NOTE); // its IP is gone: the line as stored
    const kept = '구도 검사 실패: 위쪽이 프레임에 잘림(2번 그려도 같음). 첫 그림이라 그대로 두었으니 다시 뽑아 주세요.';
    expect(jobNote({ ...first, error: kept }, [baron])).toBe(kept);
    expect(jobNote({ ...edit, kind: 'shot', error: 'GPU 용량 부족' }, [restored])).toBe('GPU 용량 부족');
    expect(jobNote(first, [baron])).toBeUndefined();
  });

  it("is what the edit's done card reads after the rejected v2 was restored", async () => {
    await show(snapOf(restored), 'pipeline');
    const lines = [...container.querySelectorAll('.job-error')].map((p) => p.textContent);
    expect(lines).toEqual([`${LEAD}이 그림(v2)을 ‘이 버전 쓰기’로 지금 그림으로 쓰고 있어요.`]);
    expect(container.textContent).not.toContain('지금 그림(v1)');
  });
});

describe('#26 the card of a promoted model on a cold box states the one ETA the chat gave', () => {
  const booting = (jobId: string, input: Record<string, unknown>, progress: string) => drew(jobId, [], { model: QWEN, modelLabel: LABEL, ...input },
    { status: 'running', progress });

  it('takes the ETA kept on the job, and the same figure off the booting line', () => {
    expect(jobWait(booting('job_e1', { etaMinutes: 11 }, '제출 중'))).toEqual({ progress: '제출 중', usual: '보통 ~11분' });
    // (the model's name is not printed before the line; it is the card's tooltip)
    expect(jobWait(booting('job_e1', { etaMinutes: 11 }, `${LABEL}: 정지된 GPU 서버 켜는 중 · 보통 ~11분`)))
      .toEqual({ progress: '정지된 GPU 서버 켜는 중', usual: '보통 ~11분' });
    // a klein edit's head redraw lands on the cold box with no ETA of its own: the line states it
    expect(jobWait(booting('job_e2', { model: 'klein9' }, `${LABEL}: 정지된 GPU 서버 켜는 중 · 보통 ~11분`)).usual).toBe('보통 ~11분');
    expect(jobWait(booting('job_e2', { model: 'klein9' }, `${LABEL} 그리는 중 (GPU 대기 포함)`)).usual).toBe('보통 ~11분');
  });
});

describe('#27 the model of a saved picture by its label, never its id', () => {
  it('reads the catalog label off the job that drew it (server/tools.py _queue_image)', () => {
    expect(assetModelLabel(v2, [first, edit])).toBe(LABEL);
    expect(assetModelLabel(v1, [first, edit])).toBe('Krea 2 Turbo');
    // a klein edit whose redraw went to the head-keeping model: the picture is that model's
    const klein = drew('job_3', ['ast_v3'], { model: 'klein9', modelLabel: 'FLUX.2 klein 9B', headModel: QWEN, headLabel: LABEL });
    expect(assetModelLabel(image('ast_v3', 'job_3', 3, QWEN, '', {}), [klein])).toBe(LABEL);
    expect(assetModelLabel(image('ast_v3', 'job_3', 3, 'klein9', '', {}), [klein])).toBe('FLUX.2 klein 9B');
    expect(assetModelLabel(image('ast_old', 'job_gone', 1, QWEN, '', {}), [first])).toBe(QWEN); // no label was ever saved
    expect(assetModelLabel(undefined, [first])).toBeUndefined();
  });

  it('is what the version chip and 버전 기록 show', async () => {
    await open(snapOf(restored));
    const chip = container.querySelector('button[aria-label^="바론 버전 기록"]')!;
    expect(chip.textContent).toBe('v22'); // v2, and the trailing 2: how many versions there are (the model is the tooltip)
    expect(chip.getAttribute('title')).toBe(`바론의 이미지 버전 기록 · ${LABEL}`);
    const made = [...drawer().querySelectorAll('.version-item small:not(.version-check)')].map((s) => s.textContent!.split(' · ')[0]);
    expect(made).toEqual([LABEL, 'Krea 2 Turbo']);
    expect(document.body.textContent).not.toContain(QWEN);
  }, 20_000); // generous: the pane and its drawer render slowly on a loaded machine
});

describe('#28 버전 기록 names the check a version failed', () => {
  it('says 수정 검사 for an edit that changed more than asked, on the row, the button and the notice', async () => {
    await open(snapOf(baron));
    expect(rows()).toEqual([['v2', `수정 검사 실패: ${WHY}`], ['v1 · 지금 그림', '구도 검사 통과']]);
    const button = drawer().querySelector<HTMLButtonElement>('.version-item button.action-btn')!;
    expect(button.getAttribute('aria-label')).toBe('v2 버전 쓰기 (수정 검사 실패)'); // 이 버전 쓰기, not 되돌리기
    await act(async () => button.click());
    expect(onAction).toHaveBeenCalledWith('restore_ip_version', { ipId: 'ip_b', imageAssetId: 'ast_v2' });
    const notice = drawer().querySelector('.notice')!.textContent!;
    expect(notice).toBe(`수정 검사에 실패한 v2 버전을 지금 그림으로 쓰고 있어요(${WHY}). 요청하지 않은 곳도 바뀐 그림일 수 있으니 다시 뽑거나 바꿀 점을 좁혀 다시 수정해 보세요.`);
    expect(notice).not.toContain('구도 검사');
  }, 20_000);

  it('names it on the card too once that version is the picture in use (server/tools.py image_state)', async () => {
    expect(imageState(restored, [first, edit])).toBe('check_failed');
    expect(pictureCheck(restored, [first, edit])).toEqual({ name: '수정 검사 실패', problem: WHY });
    expect(pictureCheck(baron, [first, edit])).toBeNull();
    await show(snapOf(restored));
    expect(container.querySelector('.card-media-status.is-failed')!.textContent).toBe(`수정 검사 실패: ${WHY} · 다시 뽑기 권장`);
  });
});

describe('#29 the IP card describes the picture it shows', () => {
  it("reads the edited version's words, and v1's again once v1 is restored", async () => {
    // (the image model's English prompt is no description for the card; a Korean one is)
    const desc = () => container.querySelector('.card-desc');
    const ko = { brown: '갈색 여행 망토를 두른 방랑 기사', navy: '감청색 여행 망토를 두른 방랑 기사' };
    const told = assets.map((a) => (a.assetId === 'ast_v2' ? { ...a, meta: { ...a.meta, description: ko.navy } } : a));
    await show(snapOf({ ...restored, description: ko.brown }, { assets: told }));
    expect([desc()!.textContent, desc()!.getAttribute('title')]).toEqual([ko.navy, ko.navy]);
    await show(snapOf({ ...baron, description: ko.brown }, { assets: told }));
    expect([desc()!.textContent, desc()!.getAttribute('title')]).toEqual([ko.brown, ko.brown]);
    await show(snapOf(restored)); // the words as the server stored them, in English (NAVY): not on the card
    expect(desc()).toBeNull();
    expect(container.querySelector('article.card')!.textContent).not.toContain('cloak');
  });

  it("merges an older edit that saved no description, as the server does (server/tools.py current_description, merge_edit)", () => {
    const V1 = 'young human male explorer wearing a copper-colored full-face mask helmet, brown travel cloak, leather gloves, sturdy boots';
    expect(mergeEdit(V1, 'make the boots red')).toBe('young human male explorer wearing a copper-colored full-face mask helmet, brown travel cloak, leather gloves, make the boots red');
    expect(mergeEdit(V1, 'add a red scarf.')).toBe(`${V1}, add a red scarf`); // nothing named: the change is added
    expect(mergeEdit(V1, ' ')).toBe(V1);
    const hero = { ...baron, description: V1, imageAssetId: 'ast_old' };
    const old = image('ast_old', 'job_9', 2, 'klein9', '', { edit: 'change the cloak to navy blue' });
    expect(currentDescription(hero, old)).toBe('young human male explorer wearing a copper-colored full-face mask helmet, leather gloves, sturdy boots, change the cloak to navy blue');
    expect(currentDescription(hero, v1)).toBe(V1);
    expect(currentDescription(hero, undefined)).toBe(V1); // its first picture is still being drawn
  });
});
