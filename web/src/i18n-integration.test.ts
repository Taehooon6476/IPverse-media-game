import { describe, expect, it } from 'vitest';
import { toolEventText } from './types';

// The server writes a work-log line in the language of the page that made the turn (server/i18n.py:
// "{label} 실패: {why}" → "{label} failed: {why}"): the web reads both forms.
describe('작업 기록 lines the server wrote for an English page', () => {
  it('reads "<label> failed: <why>" as a failure and shows its sentence', () => {
    expect(toolEventText('Make 3D failed: A prop takes no rig (only characters and humanoid enemies do).')).toEqual({
      label: 'Make 3D', failed: true, text: 'Make 3D 실패: A prop takes no rig (only characters and humanoid enemies do).' });
    expect(toolEventText('Make game failed')).toEqual({ label: 'Make game', failed: true, text: 'Make game 실패' });
  });

  it('still folds a raw error into the details, in either language', () => {
    expect(toolEventText('Make 3D failed: An error occurred (Throttling) when calling the Invoke operation').detail).toContain('Throttling');
    expect(toolEventText('3D로 만들기 실패: An error occurred (Throttling) when calling the Invoke operation').detail).toContain('Throttling');
  });

  it('a Korean line with an English reason keeps the old rule', () => {
    expect(toolEventText('3D로 만들기 실패: boom happened').detail).toBe('boom happened');
  });
});

// The server stores its default title in Korean (store.DEFAULT_TITLE, which the agent's naming rule compares with):
// the page shows it in its own language until a reply names the session.
describe('a session that still has the server\'s default title', () => {
  it('is named in the page\'s language where the page reads it', async () => {
    const { shownTitle } = await import('./api');
    expect(shownTitle('새 세션')).toBe('새 세션'); // the Korean page: as stored
    expect(shownTitle('달빛 숲')).toBe('달빛 숲');
    localStorage.setItem('ipverse.lang', 'en');
    const { vi } = await import('vitest');
    vi.resetModules();
    const en = await import('./api');
    expect(en.shownTitle('새 세션')).toBe('New session');
    expect(en.shownTitle('달빛 숲')).toBe('달빛 숲'); // a title someone gave is theirs
    localStorage.clear();
    vi.resetModules();
  });
});
