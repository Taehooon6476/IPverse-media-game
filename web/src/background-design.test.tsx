import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignDrawer, defaultRole, designCastProblem, gameDesignRequest, type Brief } from './components/DesignDrawer';
import { GameDesignSummary, summarizeGameDesign } from './components/GameDesignSummary';
import type { Asset, Game, GameDesignRequest, Ip, Snapshot } from './types';

const ip = (ipId: string, name: string, kind: Ip['kind'], usage?: Ip['usage']): Ip => ({
  ipId, name, kind, description: '', imageAssetId: `${ipId}-image`, cutoutAssetId: `${ipId}-cutout`,
  version: 1, createdAt: '2026-11-01T00:00:00Z', ...(usage ? { usage } : {}),
});
const HERO_GLB = { assetId: 'ip_hero-glb', kind: 'glb', url: 'https://example.invalid/hero.glb' }; // the player's finished 3D: a game needs it
const ips = [
  { ...ip('ip_hero', '루나', 'character'), glbAssetId: 'ip_hero-glb' }, ip('ip_core', '코어', 'prop'),
  ip('ip_background', '해안 배경', 'prop', 'background'), ip('ip_other', '산업 배경', 'prop', 'background'),
];
const brief: Brief = { prompt: '해안 배경으로 코어를 회수해 탈출', type: '', theme: '', sky: '', layout: '',
  mission: '', clear: '', fail: '', enemies: '', difficulty: '', extra: '' };
const game: Game = {
  gameId: 'gm_background', title: '해안 탈출', genre: 'rpg-explore', specKey: 'games/gm_background/spec.json',
  previewUrl: 'https://example.invalid/games/gm_background/index.html', createdAt: '2026-11-01T00:00:00Z',
};
const saved = {
  version: 2, engine: 'three', player: { ipId: 'ip_hero', modelUrl: 'assets/ip_hero.glb' },
  props: [{ ipId: 'ip_core', spriteUrl: 'assets/ip_core.png' }], enemies: [],
  world: {
    width: 50, depth: 50, spawn: { x: 0, z: 0 }, entities: [], enemySpawns: [],
    propPlacements: [{ id: 'core', propIndex: 0, x: 4, z: 5 }],
    background: { ipId: 'ip_background', mode: 'image', imageUrl: 'assets/ip_background.background.png' },
  },
  mission: { stages: [{ id: 'gather', type: 'collect', target: 1, label: '코어 회수' }] },
  design: {
    sourcePrompt: brief.prompt, castIpIds: ['ip_hero', 'ip_core', 'ip_background'], playerIpId: 'ip_hero',
    propIpIds: ['ip_core'], npcIpIds: [], enemyIpIds: [], weaponIpId: null, backgroundIpId: 'ip_background',
  },
};

describe('explicit background role contract', () => {
  it('keeps existing payloads unchanged when no background is selected', () => {
    const request = gameDesignRequest(brief, ips.slice(0, 2), { ip_hero: 'player', ip_core: 'prop' });
    expect(request).toEqual({
      prompt: request.prompt, castIpIds: ['ip_hero', 'ip_core'], playerIpId: 'ip_hero', weaponIpId: null,
      propIpIds: ['ip_core'], enemyIpIds: [], npcIpIds: [],
    });
    expect(Object.hasOwn(request, 'backgroundIpId')).toBe(false);
  });

  it('sends the background separately from collectible props while retaining the full cast and prompt', () => {
    const request = gameDesignRequest(brief, ips.slice(0, 3), {
      ip_hero: 'player', ip_core: 'prop', ip_background: 'background',
    });
    expect(request).toMatchObject({
      backgroundIpId: 'ip_background', propIpIds: ['ip_core'], castIpIds: ['ip_hero', 'ip_core', 'ip_background'],
    });
    expect(request.prompt).toContain(brief.prompt);
    expect(request.npcIpIds).not.toContain('ip_background');
    expect(request.enemyIpIds).not.toContain('ip_background');
    expect(designCastProblem(ips.slice(0, 3), {
      ip_hero: 'player', ip_core: 'prop', ip_background: 'background',
    })).toBeNull();
  });

  it('defaults only background-usage props to background and prevents multiple or incompatible backgrounds', () => {
    expect(defaultRole(ips[2], {})).toBe('background');
    expect(defaultRole(ips[1], {})).toBe('prop');
    expect(defaultRole(ip('ip_character', '캐릭터', 'character', 'background'), {})).toBe('player');
    expect(designCastProblem(ips, {
      ip_hero: 'player', ip_core: 'prop', ip_background: 'background', ip_other: 'background',
    })).toContain('배경·환경은 1개');
    expect(designCastProblem([ips[0], ip('ip_actor', '다른 캐릭터', 'character')], {
      ip_hero: 'player', ip_actor: 'background',
    })).toContain('게임 역할');
  });
});

describe('saved background evidence', () => {
  it('shows a saved original image as a separate background binding without a pickup placement', () => {
    const summary = summarizeGameDesign(saved, game, ips)!;
    expect(summary.bindings.find((binding) => binding.role === 'background')).toEqual({
      ipId: 'ip_background', name: '해안 배경', role: 'background',
      display: '원본 이미지 연결', placement: '화면 배경',
    });
    expect(summary.bindings.filter((binding) => binding.role === 'prop').map((binding) => binding.ipId)).toEqual(['ip_core']);
    expect(summary.warnings).toEqual([]);
    const markup = renderToStaticMarkup(<GameDesignSummary game={game} spec={saved} ips={ips} />);
    expect(markup).toContain('배경·환경');
    expect(markup).toContain('원본 이미지 연결 · 화면 배경');
  });

  it('shows a saved GLB only as a 3D environment placement', () => {
    const spec = structuredClone(saved) as Record<string, any>;
    spec.world.background = { ipId: 'ip_background', mode: 'model', rotation: 1.2, modelUrl: 'assets/saved-environment.glb' };
    expect(summarizeGameDesign(spec, game, ips)?.bindings.find((binding) => binding.role === 'background')).toMatchObject({
      display: '3D 연결', placement: '3D 환경 배치',
    });
    expect(summarizeGameDesign(spec, game, ips)?.warnings).toEqual([]);
  });

  it('does not substitute a newest library model, cutout or opposite-mode URL for a missing saved image', () => {
    const spec = structuredClone(saved) as Record<string, any>;
    spec.world.background = { ipId: 'ip_background', mode: 'image', spriteUrl: 'assets/cutout.png', modelUrl: 'assets/wrong.glb' };
    const library = ips.map((item) => ({ ...item, glbAssetId: 'newest-glb', imageAssetId: 'newest-image' }));
    const summary = summarizeGameDesign(spec, game, library)!;
    expect(summary.bindings.find((binding) => binding.role === 'background')?.display).toBe('IP 연결 없음');
    expect(summary.bindings.find((binding) => binding.role === 'background')?.placement).toBeUndefined();
    expect(summary.warnings).toContain('해안 배경: 배경·환경 IP가 연결되지 않았어요.');
    spec.world.background = { ipId: 'ip_background', mode: 'model', imageUrl: 'assets/image.png' };
    const unresolvedModel = summarizeGameDesign(spec, game, library)?.bindings.find((binding) => binding.role === 'background');
    expect(unresolvedModel?.display).toBe('IP 연결 없음');
    expect(unresolvedModel?.placement).toBeUndefined();
  });

  it('reports missing, changed or collectible background roles against the saved user selection', () => {
    const missing = structuredClone(saved) as Record<string, any>;
    delete missing.world.background;
    expect(summarizeGameDesign(missing, game, ips)?.warnings).toContain('선택했지만 설계에 연결되지 않은 IP: 해안 배경');
    const swapped = structuredClone(saved);
    swapped.world.background.ipId = 'ip_other';
    const summary = summarizeGameDesign(swapped, game, ips)!;
    expect(summary.warnings).toContain('선택했지만 설계에 연결되지 않은 IP: 해안 배경');
    expect(summary.warnings).toContain('선택 목록 밖의 IP: 산업 배경');
    const item = structuredClone(saved) as Record<string, any>;
    delete item.world.background;
    item.props.push({ ipId: 'ip_background', spriteUrl: 'assets/background-cutout.png' });
    item.world.propPlacements.push({ id: 'bad-background-item', propIndex: 1, x: 5, z: 7 });
    expect(summarizeGameDesign(item, game, ips)?.warnings).toContain('해안 배경: 요청한 배경·환경 역할과 달라요.');
    item.world.background = saved.world.background;
    expect(summarizeGameDesign(item, game, ips)?.warnings).toContain('해안 배경: 배경·환경을 다른 게임 역할로도 쓰고 있어요.');
  });
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  sessionStorage.clear(); // a new tab: the drawer keeps its brief and its picks for the tab
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const query = <T extends Element>(selector: string) => container.querySelector<T>(selector)!;
const choose = (name: string) => act(async () => query<HTMLInputElement>(`input[aria-label="${name} 출연 IP 선택"]`).click());
async function fillPrompt() {
  await act(async () => {
    const textarea = query<HTMLTextAreaElement>('#game-design-prompt');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, brief.prompt);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function role(name: string, value: string) {
  await act(async () => {
    const select = query<HTMLSelectElement>(`select[aria-label="${name} 게임 역할"]`);
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('native drawer background selection', () => {
  it('selects a prepared background with its original thumbnail and submits the separate role', async () => {
    const send = vi.fn(async (_text: string, _request: GameDesignRequest) => undefined);
    const assets = ['image', 'cutout'].map((kind) => ({
      assetId: `ip_background-${kind}`, kind, url: `https://example.invalid/${kind}.png`,
    })).concat(HERO_GLB) as Asset[];
    await act(async () => root.render(<DesignDrawer ips={ips} assets={assets} onClose={vi.fn()} onSend={send} />));
    await fillPrompt();
    await choose('루나'); await choose('코어'); await choose('해안 배경');
    expect(query<HTMLSelectElement>('select[aria-label="해안 배경 게임 역할"]').value).toBe('background');
    const card = query<HTMLInputElement>('input[aria-label="해안 배경 출연 IP 선택"]').closest('.cast-card')!;
    expect(card.querySelector('img')?.getAttribute('src')).toBe('https://example.invalid/image.png');
    expect(container.textContent).toContain('걸어 다니는 3D 지형이 되지는 않아요'); // behind 자세히
    expect(query<HTMLSelectElement>('select[aria-label="루나 게임 역할"]').querySelector('option[value="background"]')).toBeNull();
    await act(async () => query<HTMLFormElement>('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][1]).toMatchObject({ backgroundIpId: 'ip_background', propIpIds: ['ip_core'] });
  });

  it('lets an ordinary prop become a background and blocks a second background until reassigned', async () => {
    const send = vi.fn(async (_text: string, _request: GameDesignRequest) => undefined);
    await act(async () => root.render(<DesignDrawer ips={ips} assets={[HERO_GLB as Asset]} onClose={vi.fn()} onSend={send} />));
    await fillPrompt(); await choose('루나'); await choose('코어');
    await role('코어', 'background');
    expect(query<HTMLButtonElement>('button[type="submit"]').disabled).toBe(false);
    await choose('해안 배경');
    expect(query<HTMLButtonElement>('button[type="submit"]').disabled).toBe(true);
    expect(query('[role="alert"]').textContent).toContain('배경·환경은 1개');
    await act(async () => query<HTMLFormElement>('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(send).not.toHaveBeenCalled();
    await role('코어', 'prop');
    expect(query<HTMLButtonElement>('button[type="submit"]').disabled).toBe(false);
    await act(async () => query<HTMLFormElement>('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(send.mock.calls[0][1]).toMatchObject({ backgroundIpId: 'ip_background', propIpIds: ['ip_core'] });
  });
});

describe('background IP card preserves the full scene', () => {
  it('ignores a prior cutout toggle when the same prop becomes a background without changing other props', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
    const { IpPane } = await import('./components/IpPane');
    const assets = [ips[2], ips[1]].flatMap((item) => ['image', 'cutout'].map((kind) => ({
      assetId: `${item.ipId}-${kind}`, ipId: item.ipId, kind,
      url: `https://example.invalid/${item.ipId}-${kind}.png`, key: '', contentType: 'image/png',
      meta: {}, createdAt: item.createdAt,
    }))) as Asset[];
    const snap: Snapshot = {
      session: { sessionId: 'ses_cards', title: '배경 카드', genre: 'rpg-explore', createdAt: ips[2].createdAt },
      ips: [{ ...ips[2], usage: 'object' }, ips[1]], assets, jobs: [], games: [], messages: [],
    };
    const render = (current: Snapshot) => root.render(<IpPane snap={current} onAction={vi.fn()} onEdit={vi.fn()} onRetry={vi.fn()} />);
    await act(async () => render(snap));
    await act(async () => query<HTMLButtonElement>('#ip-tab-props').click());
    await act(async () => query<HTMLButtonElement>('button[aria-label="해안 배경 배경 제거한 그림 보기"]').click());
    expect(query('img[alt="해안 배경 배경 제거"]').getAttribute('src')).toBe('https://example.invalid/ip_background-cutout.png');
    await act(async () => render({ ...snap, ips: [ips[2], ips[1]] }));
    expect(query('img[alt="해안 배경 전체 장면 배경"]').getAttribute('src')).toBe('https://example.invalid/ip_background-image.png');
    expect(container.querySelector('button[aria-label="해안 배경 배경 제거한 그림 보기"]')).toBeNull();
    expect(container.textContent).toContain('배경 · 전체 장면');
    expect(query<HTMLButtonElement>('button[aria-label="코어 배경 제거한 그림 보기"]').getAttribute('aria-pressed')).toBe('false');
    await act(async () => query<HTMLButtonElement>('button[aria-label="코어 배경 제거한 그림 보기"]').click());
    expect(query('img[alt="코어 배경 제거"]').getAttribute('src')).toBe('https://example.invalid/ip_core-cutout.png');
  });
});
