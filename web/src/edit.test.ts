import { describe, expect, it } from 'vitest';
import { withModels } from './components/ChatDock';
import { briefMessage } from './components/DesignDrawer';
import { messageFor } from './components/EditDrawer';
import type { Asset, Ip } from './types';

describe('edit drawer and model picker messages', () => {
  it('tags each target the way server/prompts.py expects', () => {
    const ip = { ipId: 'ip_1', name: '제나', version: 2 } as Ip;
    const shot = { assetId: 'ast_1', jobId: 'job_9', kind: 'shot' } as Asset;
    const opts = { seconds: 20, model: 'ltx' };
    expect(messageFor({ kind: 'ip', ip }, '스카프 추가', opts)).toBe('[에셋 수정 ipId=ip_1] 제나: 스카프 추가');
    expect(messageFor({ kind: 'shot', asset: shot }, '더 낮게', opts)).toBe('[영상 수정 jobId=job_9] 더 낮게');
    expect(messageFor({ kind: 'trailer' }, '항공 샷으로 시작', opts)).toBe('[트레일러 연출] 전체 길이 약 20초, 영상 모델 LTX-2.5. 연출: 항공 샷으로 시작');
  });

  it('prefixes only the models the user picked', () => {
    expect(withModels('캐릭터 만들어줘', 'auto', 'auto')).toBe('캐릭터 만들어줘');
    expect(withModels('샷 만들어줘', 'klein9', 'minimax-h3')).toBe('[이미지 모델: FLUX.2 klein 9B (klein9)] [영상 모델: MiniMax H3 (minimax-h3)] 샷 만들어줘');
  });
});

describe('game design brief', () => {
  it('is a tagged chat message with the runtime ids the agent maps to GameSpec fields', () => {
    const text = briefMessage({ type: 'boss', theme: 'lava-forge', sky: 'night', layout: '', mission: '거대 로봇 처치', clear: '보스 HP 0',
      fail: '4분 제한', enemies: '', difficulty: 'hard', extra: '' });
    expect(text.startsWith('[게임 설계]')).toBe(true);
    for (const id of ['[boss]', '[lava-forge]', '[night]', '[hard]', '미션: 거대 로봇 처치', '실패 조건: 4분 제한']) expect(text).toContain(id);
    expect(text).not.toContain('적 구성');
  });
});

describe('출연 IP', () => {
  const ip = (ipId: string, name: string, kind: Ip['kind']) => ({ ipId, name, kind, description: '', imageAssetId: 'a', cutoutAssetId: 'c' }) as Ip;
  it('lists exactly the picked IPs for make_game cast_ip_ids', () => {
    const brief = { type: 'kills', theme: 'neon-arena', sky: '', layout: '', mission: '', clear: '', fail: '', enemies: '', difficulty: 'normal', extra: '' };
    const msg = briefMessage(brief, [ip('ip_teo', '테오', 'character'), ip('ip_gun', '권총', 'weapon'), ip('ip_drone', '드론', 'enemy')]);
    expect(msg).toContain('[출연 IP cast_ip_ids=ip_teo,ip_gun,ip_drone] 테오(캐릭터), 권총(무기), 드론(적)');
    expect(briefMessage(brief)).not.toContain('출연 IP');
  });
});
