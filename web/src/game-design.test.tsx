import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignDrawer, briefMessage, designCastProblem, gameDesignLengthProblem, gameDesignRequest, type Brief } from './components/DesignDrawer';
import type { Asset, GameIpRole, Ip } from './types';

const ip = (ipId: string, name: string, kind: Ip['kind']): Ip => ({
  ipId, name, kind, description: '', imageAssetId: `image_${ipId}`, cutoutAssetId: `cutout_${ipId}`,
  version: 1, createdAt: '2026-11-01T00:00:00Z',
});
const ips = [
  { ...ip('ip_luna', '루나', 'character'), glbAssetId: 'glb_luna' }, ip('ip_guide', '안내자', 'character'), ip('ip_core', '코어', 'prop'),
  ip('ip_drone', '드론', 'enemy'), ip('ip_blaster', '블래스터', 'weapon'),
];
// the player's finished 3D: the drawer only sends a design whose protagonist is 3D-ready
const LUNA_3D = [{ assetId: 'glb_luna', kind: 'glb' } as Asset];
const brief: Brief = { prompt: '코어를 모아 출구를 열고 탈출', type: '', theme: '', sky: '', layout: '',
  mission: '통신탑 복구', clear: '코어 3개', fail: '시간 초과', enemies: '', difficulty: '', extra: '전투 없이 탐험' };

describe('structured game design', () => {
  it('preserves the freeform prompt and every explicit rule without imposing an arena preset', () => {
    const message = briefMessage(brief);
    for (const text of ['게임 요청: 코어를 모아 출구를 열고 탈출', '미션: 통신탑 복구', '클리어 조건: 코어 3개', '추가 규칙: 전투 없이 탐험']) expect(message).toContain(text);
    for (const text of ['[boss]', '[lava-forge]', '[normal]', '유형:', '환경:']) expect(message).not.toContain(text);
  });

  it('sends each chosen IP in its explicit role and excludes unselected IPs', () => {
    const roles: Record<string, GameIpRole> = { ip_luna: 'player', ip_guide: 'npc', ip_core: 'prop' };
    const request = gameDesignRequest(brief, ips.filter((i) => i.ipId in roles), roles);
    expect(request).toMatchObject({
      castIpIds: ['ip_luna', 'ip_guide', 'ip_core'], playerIpId: 'ip_luna', weaponIpId: null,
      npcIpIds: ['ip_guide'], propIpIds: ['ip_core'], enemyIpIds: [],
    });
    expect(request.prompt).not.toContain('ip_drone');
    expect(request.prompt).not.toContain('ip_blaster');
    expect(gameDesignRequest(brief, [], {})).toMatchObject({ playerIpId: null, castIpIds: [] });
  });

  it('requires exactly one character player and validates role compatibility and weapon count', () => {
    expect(designCastProblem([ips[0], ips[2]], { ip_luna: 'player', ip_core: 'prop' })).toBeNull();
    expect(designCastProblem([ips[0], ips[1]], { ip_luna: 'player', ip_guide: 'player' })).toContain('정확히 1명');
    expect(designCastProblem([ips[2]], { ip_core: 'prop' })).toContain('정확히 1명');
    expect(designCastProblem([ips[0], ips[2]], { ip_luna: 'player', ip_core: 'enemy' })).toContain('게임 역할');
    const secondWeapon = ip('ip_sword', '검', 'weapon');
    expect(designCastProblem([ips[0], ips[4], secondWeapon], { ip_luna: 'player', ip_blaster: 'weapon', ip_sword: 'weapon' })).toContain('1개');
    expect(designCastProblem([ips[0], ips[1], ips[3]], { ip_luna: 'player', ip_guide: 'npc', ip_drone: 'npc' })).toContain('1명까지');
  });

  it('checks the complete assembled prompt with the backend Unicode limit without truncating text', () => {
    expect(gameDesignLengthProblem('🚀'.repeat(4000))).toBeNull();
    expect(gameDesignLengthProblem('🚀'.repeat(4001))).toContain('4,000자');
    const longBrief = { ...brief, prompt: '요청'.repeat(1950), extra: '규칙'.repeat(100) };
    const request = gameDesignRequest(longBrief, [ips[0]], { ip_luna: 'player' });
    expect(request.prompt).toContain(longBrief.prompt);
    expect(request.prompt).toContain(longBrief.extra);
    expect(gameDesignLengthProblem(request.prompt)).toContain('4,000자');
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
async function fill(selector: string, value: string) {
  await act(async () => {
    const textarea = query<HTMLTextAreaElement>(selector);
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function check(name: string) {
  await act(async () => query<HTMLInputElement>(`input[aria-label="${name} 출연 IP 선택"]`).click());
}

describe('game design drawer interactions', () => {
  it('submits a typed request with player, prop and NPC roles and closes only after queueing', async () => {
    const send = vi.fn(async () => undefined);
    const close = vi.fn();
    await act(async () => root.render(<DesignDrawer ips={ips} assets={LUNA_3D} onClose={close} onSend={send} />));
    expect(document.activeElement?.id).toBe('game-design-prompt');
    expect(query<HTMLButtonElement>('button[type="submit"]').disabled).toBe(true);
    await fill('#game-design-prompt', '루나가 안내자의 의뢰를 받고 코어 3개로 출구를 열어 탈출');
    await check('루나'); await check('안내자'); await check('코어');
    expect(query<HTMLSelectElement>('select[aria-label="루나 게임 역할"]').value).toBe('player');
    expect(query<HTMLSelectElement>('select[aria-label="안내자 게임 역할"]').value).toBe('npc');
    await act(async () => query<HTMLFormElement>('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(send).toHaveBeenCalledTimes(1);
    const [text, request] = send.mock.calls[0] as unknown as [string, ReturnType<typeof gameDesignRequest>];
    expect(request.prompt).toBe(text);
    expect(request).toMatchObject({ playerIpId: 'ip_luna', propIpIds: ['ip_core'], npcIpIds: ['ip_guide'], enemyIpIds: [] });
    expect(text).toContain('코어 3개로 출구');
    expect(close).toHaveBeenCalledOnce();
  });

  it('changing the player updates the prior player to NPC; deselecting the only player blocks submission', async () => {
    await act(async () => root.render(<DesignDrawer ips={ips} assets={LUNA_3D} onClose={vi.fn()} onSend={vi.fn()} />));
    await fill('#game-design-prompt', '탐험');
    await check('루나'); await check('안내자');
    await act(async () => {
      const select = query<HTMLSelectElement>('select[aria-label="안내자 게임 역할"]');
      select.value = 'player';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(query<HTMLSelectElement>('select[aria-label="루나 게임 역할"]').value).toBe('npc');
    await check('안내자');
    expect(query<HTMLButtonElement>('button[type="submit"]').disabled).toBe(true);
    expect(query('[role="alert"]').textContent).toContain('정확히 1명');
  });

  it('keeps the typed prompt and IP selection after a request fails', async () => {
    const close = vi.fn();
    const send = vi.fn(async () => { throw new Error('request rejected'); });
    await act(async () => root.render(<DesignDrawer ips={ips} assets={LUNA_3D} onClose={close} onSend={send} />));
    await fill('#game-design-prompt', '채굴된 코어를 가지고 탈출');
    await check('루나'); await check('코어');
    await act(async () => query<HTMLFormElement>('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(close).not.toHaveBeenCalled();
    expect(query<HTMLTextAreaElement>('#game-design-prompt').value).toBe('채굴된 코어를 가지고 탈출');
    expect(query<HTMLInputElement>('input[aria-label="코어 출연 IP 선택"]').checked).toBe(true);
    expect(query<HTMLButtonElement>('button[type="submit"]').disabled).toBe(false);
  });
});
