import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignDrawer } from './components/DesignDrawer';
import { GameDesignSummary, summarizeGameDesign } from './components/GameDesignSummary';
import type { Asset, Game, GameDesignRequest, Ip } from './types';

const ips = [
  { ipId: 'ip_pilot', name: '선택한 주인공', kind: 'character', imageAssetId: 'pilot-image', cutoutAssetId: 'pilot-cutout', glbAssetId: 'pilot-glb' },
  { ipId: 'ip_guide', name: '선택한 안내자', kind: 'character', imageAssetId: 'guide-image', cutoutAssetId: 'guide-cutout' },
  { ipId: 'ip_cargo', name: '선택한 화물', kind: 'prop', imageAssetId: 'cargo-image', cutoutAssetId: 'cargo-cutout' },
  { ipId: 'ip_excluded', name: '선택하지 않은 적', kind: 'enemy', imageAssetId: 'enemy-image', cutoutAssetId: 'enemy-cutout' },
] as Ip[];
const game: Game = {
  gameId: 'gm_city_saved', title: '도시 운송', genre: 'rpg-quest', specKey: 'games/gm_city_saved/spec.json',
  previewUrl: 'https://example.invalid/games/gm_city_saved/index.html', createdAt: '2026-11-01T00:00:00Z',
};
const saved = {
  version: 2, engine: 'three', player: { ipId: 'ip_pilot', modelUrl: 'assets/saved-pilot.glb' },
  props: [{ ipId: 'ip_cargo', modelUrl: 'assets/saved-cargo.glb' }, { ipId: 'ip_guide', spriteUrl: 'assets/saved-guide.png' }],
  enemies: [],
  world: {
    width: 720, depth: 480, spawn: { x: -175, z: -111 },
    entities: [{ id: 'delivery', kind: 'beacon', x: 180, z: 111 }],
    propPlacements: [{ id: 'cargo-1', propIndex: 0, x: -172, z: -110 }], enemySpawns: [],
    npc: { id: 'dispatcher', propIndex: 1, x: -180, z: -111 },
    city: {
      districts: [
        { id: 'business', name: '업무 구역', style: 'downtown', x: -180, z: -100, width: 180, depth: 120 },
        { id: 'homes', name: '주택 구역', style: 'residential', x: 180, z: -100, width: 180, depth: 120 },
        { id: 'factory', name: '공장 구역', style: 'industrial', x: 0, z: 100, width: 240, depth: 120 },
      ],
      streets: [
        { id: 'east', axis: 'x', coordinate: -120, width: 16 },
        { id: 'west', axis: 'x', coordinate: 100, width: 16 },
        { id: 'middle', axis: 'x', coordinate: 0, width: 16 },
        { id: 'north', axis: 'z', coordinate: -180, width: 16 },
        { id: 'south', axis: 'z', coordinate: 180, width: 16 },
      ],
      vehicles: [{ id: 'courier', kind: 'sedan', x: -180, z: -120, yaw: 0 }, { id: 'taxi', kind: 'taxi', x: 180, z: 100, yaw: 0 }],
      pedestrians: [
        { id: 'walker-1', propIndex: 1, x: -170, z: -110, route: [{ x: -170, z: -110 }, { x: -150, z: -110 }] },
        { id: 'walker-2', propIndex: 1, x: 150, z: 110, route: [{ x: 150, z: 110 }, { x: 170, z: 110 }] },
        { id: 'walker-3', propIndex: 1, x: -30, z: 10, route: [{ x: -30, z: 10 }, { x: -10, z: 10 }] },
      ],
      trafficCount: 6, seed: 321,
    },
  },
  mission: { stages: [
    { id: 'brief', type: 'talk', target: 1, label: '안내자의 운송 의뢰' },
    { id: 'drive', type: 'drive', target: 1, entityIds: ['courier'], distanceMeters: 175, label: '공장 구역까지 운전' },
    { id: 'deliver', type: 'reach', target: 1, entityIds: ['delivery'], label: '배송 지점 도달' },
  ] },
  design: {
    sourcePrompt: '1200m 해변 도시를 원했지만 이 저장 버전과 비교한다',
    castIpIds: ['ip_pilot', 'ip_cargo', 'ip_guide'], playerIpId: 'ip_pilot',
    propIpIds: ['ip_cargo'], npcIpIds: ['ip_guide'], enemyIpIds: [], weaponIpId: null,
  },
};

describe('saved city design evidence', () => {
  it('summarizes only the saved dimensions, districts, vehicles, traffic and actual drive distance', () => {
    const summary = summarizeGameDesign(saved, game, ips)!;
    expect(summary.world).toContain('도시 월드 · 720 × 480m');
    expect(summary.world).toContain('구역 3개: 업무 구역 (도심) · 주택 구역 (주거) · 공장 구역 (산업)');
    expect(summary.world).toContain('도로 5개 · 운전 차량 2대 · 보행자 3명 · 교통 차량 6대');
    expect(summary.world).toContain('엔진: Three.js 브라우저');
    expect(summary.world.join(' ')).not.toContain('1200');
    expect(summary.missions[1]).toEqual({ label: '공장 구역까지 운전', detail: '175m 주행' });
    expect(summary.missions[1].detail).not.toContain('목표 1');
    expect(summary.bindings.find((binding) => binding.ipId === 'ip_guide')).toMatchObject({
      role: 'npc', display: '이미지 연결', placement: '배치 4곳',
    });
    expect(summary.bindings.find((binding) => binding.ipId === 'ip_cargo')).toMatchObject({ role: 'prop', placement: '배치 1곳' });
    expect(summary.warnings).toEqual([]);
  });

  it('does not invent absent traffic or driving distance from the prompt, and detects broken selected-IP binding', () => {
    const broken: Record<string, any> = structuredClone(saved);
    delete broken.world.city.trafficCount;
    delete broken.mission.stages[1].distanceMeters;
    broken.props[1].ipId = 'ip_excluded';
    const summary = summarizeGameDesign(broken, game, ips)!;
    expect(summary.world.join(' ')).not.toContain('교통 차량');
    expect(summary.missions[1].detail).toBe('주행 · 거리 미지정');
    expect(summary.warnings).toContain('선택했지만 설계에 연결되지 않은 IP: 선택한 안내자');
    expect(summary.warnings).toContain('선택 목록 밖의 IP: 선택하지 않은 적');
  });

  it('renders city names as text while keeping the saved source request separate', () => {
    const spec = structuredClone(saved);
    spec.world.city.districts[0].name = '<script>wrong()</script>';
    const markup = renderToStaticMarkup(<GameDesignSummary game={game} spec={spec} ips={ips} showRequest />);
    expect(markup).toContain('&lt;script&gt;wrong()&lt;/script&gt;');
    expect(markup).not.toContain('<script>');
    expect(markup).toContain('175m 주행');
    expect(markup).toContain('보낸 게임 요청');
  });
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  sessionStorage.clear(); // a new tab: the drawer keeps its brief and its picks per tab
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it('queues the city preset through the existing chat with the user-selected roles unchanged', async () => {
  const send = vi.fn(async (_text: string, _request: GameDesignRequest) => undefined);
  await act(async () => root.render(<DesignDrawer ips={ips} assets={[{ assetId: 'pilot-glb', kind: 'glb' } as Asset]} onClose={vi.fn()} onSend={send} />));
  for (const name of ['선택한 주인공', '선택한 안내자', '선택한 화물']) {
    await act(async () => container.querySelector<HTMLInputElement>(`input[aria-label="${name} 출연 IP 선택"]`)!.click());
  }
  const preset = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '도시 코어 운송')!;
  await act(async () => preset.click());
  expect(container.textContent).toContain('도시 오픈월드');
  expect(container.textContent).toContain('NPC 캐릭터는 1명까지 고를 수 있어요'); // behind 자세히
  await act(async () => container.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(send).toHaveBeenCalledOnce();
  const [text, request] = send.mock.calls[0];
  expect(request.prompt).toBe(text);
  expect(request).toMatchObject({
    playerIpId: 'ip_pilot', propIpIds: ['ip_cargo'], npcIpIds: ['ip_guide'], enemyIpIds: [], weaponIpId: null,
    castIpIds: ['ip_pilot', 'ip_guide', 'ip_cargo'],
  });
  for (const requirement of ['world.city', '300–1200m', '구역 3개', 'streets', 'pedestrians', 'type drive', 'distanceMeters 150', 'E로 승하차', 'Space로 제동']) expect(text).toContain(requirement);
  expect(text).not.toContain('ip_excluded');
  expect(text).not.toContain('선택하지 않은 적(enemy)');
  expect(text).not.toContain('[open]');
  expect(text).not.toContain('[neon-arena]');
  expect(text).toContain('선택한 주인공(캐릭터)');
  expect(text).toContain('선택한 화물(소품)');
});
