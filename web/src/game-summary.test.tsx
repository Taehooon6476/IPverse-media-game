import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GameDesignSummary, gameType, summarizeGameDesign } from './components/GameDesignSummary';
import type { Game, Ip } from './types';

const ips = [
  { ipId: 'ip_player', name: '루나', kind: 'character', glbAssetId: 'newer_model' },
  { ipId: 'ip_prop', name: '코어', kind: 'prop' },
  { ipId: 'ip_npc', name: '안내자', kind: 'character' },
  { ipId: 'ip_enemy', name: '드론', kind: 'enemy' },
] as Ip[];
const game: Game = {
  gameId: 'gm_request', title: '코어 탈출', genre: 'rpg-quest', specKey: 'games/gm_request/spec.json',
  previewUrl: 'https://example.invalid/games/gm_request/index.html', createdAt: '2026-11-01T00:00:00Z',
};
const v2 = {
  version: 2, genre: 'rpg-quest', difficulty: 'easy',
  // The old objective must not override the actual staged mission.
  objective: { type: 'kills', target: 99, label: '사용하지 않는 이전 목표' },
  player: { ipId: 'ip_player', modelUrl: 'assets/ip_player.glb', name: '루나' },
  props: [{ ipId: 'ip_prop', spriteUrl: 'assets/ip_prop.png' }, { ipId: 'ip_npc', modelUrl: 'assets/ip_npc.glb' }],
  enemies: [{ ipId: 'ip_enemy', modelUrl: 'assets/ip_enemy.glb' }],
  world: {
    width: 48, depth: 32, spawn: { x: 0, z: 0 },
    entities: [{ id: 'gate', kind: 'arch', x: 8, z: 10 }],
    propPlacements: [{ id: 'core-1', propIndex: 0, x: 2, z: 5 }, { id: 'core-2', propIndex: 0, x: 3, z: 7 }],
    enemySpawns: [{ id: 'guard', enemyIndex: 0, x: 9, z: 3 }],
    npc: { id: 'guide', propIndex: 1, x: -3, z: 1 },
  },
  mission: { stages: [
    { id: 'ask', type: 'talk', label: '안내자에게 의뢰 받기', target: 1 },
    { id: 'cores', type: 'collect', label: '코어 2개 수집', target: 2, propIndex: 0 },
    { id: 'exit', type: 'reach', label: '탈출 문으로 이동', target: 1, entityIds: ['gate'] },
  ], successText: '정거장 탈출 완료' },
  mechanics: { dash: false, jump: true, sprint: true, autoFire: false, weaponDamage: 2, fireIntervalSec: 0.4, interactRadius: 3 },
  rules: { timeLimitSec: 180, playerHp: 120 },
  design: {
    sourcePrompt: '코어 2개를 모아 문을 열고 탈출해줘', castIpIds: ['ip_player', 'ip_prop', 'ip_npc', 'ip_enemy'],
    playerIpId: 'ip_player', propIpIds: ['ip_prop'], npcIpIds: ['ip_npc'], enemyIpIds: ['ip_enemy'], weaponIpId: null,
  },
};

describe('saved GameSpec summary', () => {
  it('reads the actual v2 mission order, world placements, explicit roles and controls', () => {
    const summary = summarizeGameDesign(v2, game, ips)!;
    expect(summary.missions.map((stage) => stage.label)).toEqual(['안내자에게 의뢰 받기', '코어 2개 수집', '탈출 문으로 이동']);
    expect(summary.successText).toBe('정거장 탈출 완료');
    expect(summary.world).toContain('맞춤 월드 · 48 × 32');
    expect(summary.world[1]).toContain('소품 배치 2곳');
    expect(summary.rules).toContain('이동 기능: 점프 · 달리기');
    expect(summary.rules).toContain('수동 공격');
    expect(summary.bindings.find((binding) => binding.ipId === 'ip_prop')).toMatchObject({ role: 'prop', display: '이미지 연결', placement: '배치 2곳' });
    expect(summary.bindings.find((binding) => binding.ipId === 'ip_npc')).toMatchObject({ role: 'npc', display: '3D 연결', placement: '배치 1곳' });
    expect(summary.warnings).toEqual([]);
  });

  it('uses the saved asset URLs, never the IP library newest model as proof', () => {
    const spec = structuredClone(v2);
    spec.player.modelUrl = '';
    const summary = summarizeGameDesign(spec, game, ips)!;
    expect(summary.bindings.find((binding) => binding.role === 'player')?.display).toBe('IP 연결 없음');
    expect(summary.sourcePrompt).toBe(v2.design.sourcePrompt);
  });

  it('reports missing placements, mismatched player roles and unselected IPs without claiming the prompt was applied', () => {
    const spec = structuredClone(v2);
    spec.world.propPlacements = [];
    spec.player.ipId = 'ip_other';
    const summary = summarizeGameDesign(spec, game, ips)!;
    expect(summary.warnings).toContain('선택했지만 설계에 연결되지 않은 IP: 루나');
    expect(summary.warnings).toContain('월드 배치가 없는 선택 IP: 코어');
    expect(summary.warnings).toContain('선택 목록 밖의 IP: ip_other');
    const swapped = structuredClone(v2);
    swapped.player.ipId = 'ip_npc'; swapped.props[1].ipId = 'ip_player';
    expect(summarizeGameDesign(swapped, game, ips)?.warnings).toContain('루나: 요청한 주인공 역할과 달라요.');
  });

  it('keeps legacy v1 games readable and shows that no original request was saved', () => {
    const spec = { version: 1, mission: '경비 드론을 처치', objective: { type: 'kills', target: 12 },
      player: { ipId: 'ip_player', spriteUrl: 'assets/player.png' }, props: [], enemies: [],
      environment: { theme: 'ice-station', sky: 'night', layout: 'maze' }, difficulty: 'normal' };
    const summary = summarizeGameDesign(spec, game, ips)!;
    expect(summary.missions[0]).toEqual({ label: '경비 드론을 처치', detail: '처치 · 목표 12' });
    expect(summary.world).toContain('얼음 기지 · 밤 · 미로');
    const html = renderToStaticMarkup(<GameDesignSummary game={game} spec={spec} ips={ips} showRequest />);
    expect(html).toContain('원본 게임 요청이 저장되지 않았어요');
  });

  it('escapes generated text and keeps requested text separate from the generated mission', () => {
    const spec = structuredClone(v2);
    spec.design.sourcePrompt = '<img src=x onerror=alert(1)> 아주 다른 요청';
    const html = renderToStaticMarkup(<GameDesignSummary game={game} spec={spec} ips={ips} showRequest />);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img');
    expect(html).toContain('보낸 게임 요청');
    expect(html).toContain('코어 2개 수집');
    expect(summarizeGameDesign(null, game, ips)).toBeNull();
  });
});

// The `genre` field is one of four fixed values: a game that collects lanterns in a forest must not be headed "SF 슈터".
describe('the summary is headed by what kind of game it is (R20-49)', () => {
  const sf: Game = { ...game, genre: 'sf-shooter' };
  const head = (spec: unknown, g = sf) => renderToStaticMarkup(<GameDesignSummary game={g} spec={spec} ips={ips} />)
    .match(/class="muted game-summary-meta"[^>]*>([^<]*)</)![1];
  const staged = (...types: string[]) => ({ ...structuredClone(v2), genre: 'sf-shooter',
    mission: { stages: types.map((type, i) => ({ id: `s${i}`, type, label: `${i + 1}단계`, target: 1 })) } });

  it('reads the kind off the design, as the game itself does', () => {
    expect(head({ ...staged('talk', 'collect', 'drive', 'reach'), world: { ...v2.world, city: { districts: [], streets: [] } } })).toBe('도시 오픈월드');
    expect(head({ ...staged('race'), world: { ...v2.world, city: { districts: [] } } })).toBe('도시 레이싱');
    expect(head({ ...staged('race'), world: { ...v2.world, track: { roadWidth: 14 } } })).toBe('레이싱');
    expect(head({ ...staged('kills', 'kills', 'boss'), mechanics: { style: 'arpg' } })).toBe('핵앤슬래시');
    expect(head({ ...staged('collect', 'reach'), artDirection: { setting: 'sky' } })).toBe('점프 플랫포머');
    expect(head({ ...staged('collect'), mechanics: { fallRespawn: true, jump: true } })).toBe('점프 플랫포머');
  });

  it('names a mission of one kind of stage by it, and one of several by its number of stages', () => {
    expect([head(staged('survive')), head(staged('kills', 'kills')), head(staged('boss')), head(staged('collect')), head(staged('reach'))])
      .toEqual(['생존전', '섬멸전', '보스전', '수집전', '거점 확보']);
    expect(head(staged('talk', 'collect', 'reach'))).toBe('3단계 임무'); // the lantern game: no "SF 슈터" on it
    expect(head(v2, game)).toBe('3단계 임무');
  });

  it('an older game is its objective, or the RPG it was made as', () => {
    const v1 = (genre: string, type: string) => ({ version: 1, genre, objective: { type, target: 12 }, player: {}, props: [], enemies: [] });
    expect([head(v1('sf-shooter', 'kills')), head(v1('sf-survival', 'survive')), head(v1('sf-shooter', 'boss'))]).toEqual(['섬멸전', '생존전', '보스전']);
    expect(head(v1('rpg-quest', 'collect'), { ...game, genre: 'rpg-quest' })).toBe('RPG 퀘스트');
    expect(head(v1('rpg-explore', 'collect'), { ...game, genre: 'rpg-explore' })).toBe('RPG 탐험');
    expect(gameType({ version: 1 }, sf)).toBe('SF 슈터'); // nothing to read it off: the genre the game was saved with
  });
});
