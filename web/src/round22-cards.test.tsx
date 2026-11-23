import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Asset, Ip, Job, Snapshot } from './types';

// A hero card that carries both amber notes (the kept-out new picture and the refused skeleton) must not grow taller
// than its panel and stretch the card beside it, pushing that card's button under the fold.
vi.hoisted(() => { // IpPane reads prefers-reduced-motion when it loads; jsdom has no matchMedia
  window.matchMedia ??= (() => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
});
const fs = (await import('node:fs' as string)) as { existsSync: (p: string) => boolean; readFileSync: (p: string, e: 'utf8') => string };
const origin = fs.readFileSync(['src/origin.css', 'web/src/origin.css'].find((p) => fs.existsSync(p))!, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const at = (clock = '03:10:00') => `2026-11-18T${clock}Z`;
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
const show = async (snap: Snapshot) => {
  history.replaceState(null, '', '#ip=characters');
  const { IpPane } = await import('./components/IpPane');
  await act(async () => root.render(<IpPane snap={snap} onAction={onAction} onEdit={vi.fn()} onRetry={vi.fn(async () => undefined)} />));
};
const card = (name: string) => [...container.querySelectorAll('article.card')].find((c) => c.querySelector('h3')?.textContent === name)!;

const REFUSED = '움직임 뼈대를 넣을 수 없는 모양입니다: not a full body: legs are missing or cut off (hips at 30% of the height)';
const KEPT_OUT = '구도 검사 실패: 위쪽·아래쪽이 프레임에 잘림(2번 그려도 같음). 새 그림(v2)은 버전 기록에만 두고 지금 그림(v1)을 그대로 씁니다.';
const wizard = ip('wiz', 'character', '꼬마 마법사', { glbAssetId: 'wiz_glb', imageJobId: 'wiz_draw2' });
const wolf = ip('wolf', 'enemy', '그림자 늑대', { humanoid: false });
const chain: Job[] = [job('wiz_pose', 'apose', 'wiz', 'done', { input: { imageKey: 'k/wiz_img' } }), job('wiz_mesh', 'mesh3d', 'wiz', 'done', { deps: ['wiz_pose'] }),
  job('wiz_turn', 'render3d', 'wiz', 'done', { deps: ['wiz_mesh'] }), job('wiz_rig', 'rig', 'wiz', 'failed', { deps: ['wiz_mesh'], provider: 'rig', error: REFUSED })];
const redraw = job('wiz_draw2', 'image', 'wiz', 'done', { provider: 'mediagen_image', outputs: ['wiz_img2'], error: KEPT_OUT, outcome: 'rejected', input: { version: 2 } });
const pictures = [asset('wiz_glb', 'glb', 'wiz', { jobId: 'wiz_mesh' }), asset('wiz_img2', 'image', 'wiz', { meta: { version: 2 }, jobId: 'wiz_draw2' })];

describe('a card with a kept-out picture and a refused skeleton says both in one compact block', () => {
  it('one amber block: both in one line, what helps as its button, the reasons and the ways to look folded', async () => {
    await show(snapOf([wizard, wolf], [...chain, redraw], pictures));
    const notes = card('꼬마 마법사').querySelectorAll('.card-note');
    expect(notes).toHaveLength(1);
    const more = notes[0].querySelector('details')!;
    expect(more.open).toBe(false);
    expect([...notes[0].children].map((c) => c.tagName)).toEqual(['P', 'BUTTON', 'DETAILS']);
    expect(notes[0].querySelector(':scope > p')!.textContent).toBe('새 그림(v2)은 쓰지 않았고, 움직임 뼈대도 넣지 못했어요.');
    const help = notes[0].querySelector<HTMLButtonElement>(':scope > button')!;
    expect(help.textContent).toBe('그림 다시 뽑기');
    await act(async () => help.click());
    expect(onAction).toHaveBeenLastCalledWith('reroll_ip_image', { ipId: 'wiz' }, true);
    expect(more.querySelector('summary')!.textContent).toBe('자세히 보기');
    expect([...more.querySelectorAll('p')].map((p) => p.textContent)).toEqual([
      '새 그림(v2)은 검사를 통과하지 못해 쓰지 않았어요: 위쪽·아래쪽이 프레임에 잘림. 지금 그림(v1)을 그대로 써요.',
      '움직임 뼈대를 넣지 못했어요: 다리가 보이지 않거나 너무 짧아요. 머리부터 발끝까지 보이고 두 다리가 드러나게 서 있는 그림으로 다시 뽑아 주세요.']);
    const links = [...more.querySelectorAll<HTMLButtonElement>('.card-note-actions button')];
    expect(links.map((b) => [b.textContent, b.classList.contains('link-btn')])).toEqual([['버전 기록 보기', true], ['작업 현황 보기', true]]);
    await act(async () => links[0].click());
    expect(document.querySelector('[role="dialog"] h2')!.textContent).toBe('꼬마 마법사 버전 기록');
  });

  it('with her picture drawn again since the model: the 3D from it is what helps', async () => {
    const hero = { ...wizard, version: 2, imageAssetId: 'wiz_img2', imageJobId: 'wiz_draw3' };
    const draw3 = job('wiz_draw3', 'image', 'wiz', 'done', { provider: 'mediagen_image', outputs: ['wiz_img3'], error: KEPT_OUT.replace('v2', 'v3').replace('v1', 'v2'),
      outcome: 'rejected', input: { version: 3 } });
    await show(snapOf([hero, wolf], [...chain, draw3], [...pictures, asset('wiz_img3', 'image', 'wiz', { meta: { version: 3 }, jobId: 'wiz_draw3' })]));
    const note = card('꼬마 마법사').querySelector('.card-note')!;
    expect(note.querySelector(':scope > p')!.textContent).toBe('새 그림(v3)은 쓰지 않았어요. 지금 그림으로 3D를 다시 만들 수 있어요.');
    expect(note.querySelector(':scope > button')!.textContent).toBe('지금 그림으로 3D 다시 만들기');
  });

  it('a card with one of the two keeps its block as it was', async () => {
    await show(snapOf([wizard, wolf], chain, pictures.slice(0, 1)));
    expect([...card('꼬마 마법사').querySelectorAll('.card-note button')].map((b) => b.textContent)).toEqual(['그림 다시 뽑기']);
    expect([card('꼬마 마법사').querySelector('.card-note-actions'), card('꼬마 마법사').querySelector('.card-note details')]).toEqual([null, null]);
    const done = chain.map((j) => (j.kind === 'rig' ? { ...j, status: 'done' as const, error: undefined } : j));
    await show(snapOf([{ ...wizard, riggedGlbAssetId: 'wiz_rigged' }, wolf], [...done, redraw], [...pictures, asset('wiz_rigged', 'rigged_glb', 'wiz')]));
    const buttons = [...card('꼬마 마법사').querySelectorAll<HTMLButtonElement>('.card-note button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['버전 기록 보기', '작업 현황 보기']);
    expect(buttons.map((b) => b.classList.contains('link-btn'))).toEqual([false, true]);
  });
});

describe('cards in a row keep their own height', () => {
  it('the card grid does not stretch a card to its tallest neighbour', () => {
    const grid = [...origin.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1].split(',').some((s) => s.trim() === '.card-grid')).map((m) => m[2]).join(';');
    expect(grid).toMatch(/align-items:\s*start/);
  });
});
