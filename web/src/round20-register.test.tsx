import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditDrawer, TEXT_HINT, type EditTarget } from './components/EditDrawer';
import { GameDesignSummary, summarizeGameDesign } from './components/GameDesignSummary';
import { GameEditDrawer } from './components/GameEditDrawer';
import { JobsMenu } from './components/JobsMenu';
import type { Asset, Game, Ip, Snapshot } from './types';

// One voice, one name: in this package's panes and drawers every sentence is 해요체, the saved design is 게임 설계
// and an IP is an IP (never 에셋).
vi.hoisted(() => { // IpPane reads prefers-reduced-motion when it loads; jsdom has no matchMedia
  window.matchMedia ??= (() => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
});

const FORMAL = /니다|시오/; // 합니다체: 습니다, 됩니다, 입니다, 하십시오
const at = '2026-11-16T03:10:00Z';
const lira: Ip = { ipId: 'ip_lira', kind: 'character', name: '리라', description: '', version: 1, imageAssetId: 'ast_lira', createdAt: at };
const glade: Ip = { ipId: 'ip_glade', kind: 'prop', usage: 'background', name: '별빛 숲 공터', description: '', version: 1, imageAssetId: 'ast_glade', createdAt: at };
const file = (assetId: string, kind: Asset['kind']): Asset => ({ assetId, kind, key: assetId, url: `https://cdn/${assetId}`, contentType: '', meta: {}, createdAt: at, jobId: `job_${assetId}` });
const game: Game = { gameId: 'gm_1', title: '달빛 숲의 별조각', genre: 'rpg-quest', specKey: 'games/gm_1/spec.json', previewUrl: '/games/gm_1/index.html', createdAt: at };

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
  localStorage.clear();
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
const show = (node: React.ReactNode) => act(async () => root.render(node));
const text = (selector: string) => document.querySelector(selector)!.textContent;

describe('R20-51 the edit drawers speak 해요체', () => {
  const drawer = (target: EditTarget) => show(<EditDrawer target={target} onClose={vi.fn()} onSend={vi.fn(async () => undefined)} />);

  it('says what an edit of a picture, a whole scene, a shot and a trailer does, in one voice', async () => {
    await drawer({ kind: 'ip', ip: lira });
    expect([text('#edit-intro'), text('#edit-text-hint')]).toEqual(['지금 그림을 보면서 바꿀 부분을 적어 주세요. 수정한 그림은 새 버전으로 저장돼요.',
      '지금 결과에서 바꾸고 싶은 내용만 적어 주세요. 원래 버전은 그대로 남아요.']);
    await drawer({ kind: 'ip', ip: glade });
    expect(text('#edit-intro')).toBe('지금 전체 장면을 보면서 바꿀 부분을 적어 주세요. 배경은 그대로 둔 새 버전으로 저장돼요.');
    await drawer({ kind: 'shot', asset: file('shot_1', 'shot') });
    expect(text('#edit-intro')).toBe('같은 캐릭터·모델·길이로, 적은 내용을 반영한 새 샷을 만들어요. 원래 샷은 그대로 남아요.');
    await drawer({ kind: 'trailer' });
    expect(text('#edit-intro')).toBe('원하는 장면 흐름을 문장으로 적어 주세요. 장면별 샷을 만들고 색을 맞춘 트레일러와 쇼츠로 묶어요. LTX는 장면 하나를 최대 20초까지 한 번에 만들어요.');
    expect(Object.values(TEXT_HINT).filter((hint) => FORMAL.test(hint))).toEqual([]);
    expect([TEXT_HINT.trailer, TEXT_HINT.new]).toEqual(['새 연출로 트레일러를 다시 만들어요. 장면 순서, 분위기, 색감, 마지막 장면을 적어 주세요. 지금 트레일러는 그대로 남아요.',
      '어떤 장면으로 시작해 어떻게 끝날지, 분위기와 색감을 적어 주세요. 필요한 샷을 만든 뒤 하나로 이어 붙여요.']);
  });

  it('이 게임 수정 says what the request does before and while it is sent', async () => {
    await show(<GameEditDrawer game={game} version={2} onClose={vi.fn()} onSend={vi.fn(async () => undefined)} />);
    expect(text('#game-edit-intro')).toBe('“달빛 숲의 별조각”(v2)에서 바꿀 점을 적어 주세요. 지금 게임 설계를 바탕으로 새 버전을 만들고, 지금 버전은 그대로 남아요.');
    expect(text('#game-edit-submit-hint')).toBe('바꾸고 싶은 내용을 입력해 주세요.');
    const box = document.querySelector<HTMLTextAreaElement>('#game-edit-text')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, '적을 더 빠르게');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(text('#game-edit-submit-hint')).toBe('요청을 보내면 채팅에 추가되고 새 게임 버전을 만들기 시작해요.');
    expect(document.querySelector('[role="dialog"]')!.textContent).not.toMatch(FORMAL);
  });
});

describe('R20-51 작업 현황 and the top bar speak 해요체', () => {
  it('says there is no job, and that the session saves itself', async () => {
    history.replaceState(null, '', '#ip=pipeline');
    const { IpPane } = await import('./components/IpPane');
    const snap = { session: { sessionId: 'ses_x', title: 't', genre: 'rpg-quest', createdAt: at }, messages: [], games: [], ips: [], assets: [], jobs: [] } as Snapshot;
    await show(<IpPane snap={snap} onAction={vi.fn(async () => undefined)} onEdit={vi.fn()} onRetry={vi.fn(async () => undefined)} />);
    expect([text('.empty-state h3'), text('.empty-state p')]).toEqual(['진행 중인 작업이 없어요', '3D나 영상을 만들기 시작하면 진행 상황과 결과가 여기에 보여요.']);
    expect(container.querySelector('[role="tablist"]')!.getAttribute('aria-label')).toBe('IP 보기'); // an IP is an IP, not 에셋
    await show(<JobsMenu jobs={[]} onCancel={vi.fn(async () => undefined)} />);
    expect([text('.status-pill'), document.querySelector('.status-pill')!.getAttribute('title')]).toEqual(['자동 저장됨', '세션에서 바꾼 내용은 자동으로 저장돼요.']);
  });
});

describe('R20-51 설계 요약 calls the saved design 게임 설계 and an IP an IP', () => {
  const spec = { version: 2, mission: { stages: [] }, design: { castIpIds: ['ip_lira', 'ip_glade'], playerIpId: 'ip_glade', backgroundIpId: 'ip_glade' },
    player: { ipId: 'ip_lira', modelUrl: '' }, props: [], enemies: [], world: { background: { ipId: 'ip_glade', mode: 'model', modelUrl: '' } } };

  it('warns in 해요체, without 에셋 or 설정', () => {
    const summary = summarizeGameDesign(spec, game, [lira, glade])!;
    expect(summary.bindings.find((b) => b.role === 'player')?.display).toBe('IP 연결 없음');
    expect(summary.warnings.filter((w) => FORMAL.test(w) || /에셋|설정/.test(w))).toEqual([]);
    expect(summary.warnings).toContain('별빛 숲 공터: 배경·환경 IP가 연결되지 않았어요.');
    expect(summary.warnings).toContain('별빛 숲 공터: 요청한 주인공 역할과 달라요.');
  });

  it('says so in 해요체 when there is nothing saved to show', () => {
    expect(renderToStaticMarkup(<GameDesignSummary game={game} spec={null} ips={[]} />)).toContain('저장된 게임 설계를 확인할 수 없어요.');
    const html = renderToStaticMarkup(<GameDesignSummary game={game} spec={spec} ips={[lira, glade]} showRequest />);
    expect(html).toContain('이전 버전에는 원본 게임 요청이 저장되지 않았어요.');
    expect(html.replace(/<[^>]+>/g, ' ')).not.toMatch(FORMAL);
    expect(html.replace(/<[^>]+>/g, ' ')).not.toContain('GameSpec'); // the format's name is a tooltip at most
  });
});
