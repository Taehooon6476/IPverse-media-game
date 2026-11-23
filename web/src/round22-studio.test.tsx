import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditDrawer } from './components/EditDrawer';
import type { Ip } from './types';

// Small wording and state fixes on the studio's panes.
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ip = (kind: Ip['kind'], name: string, extra: Partial<Ip> = {}): Ip => ({ ipId: `ip_${kind}`, kind, name, description: '', version: 1, createdAt: '', ...extra });

// The examples and the placeholder are not a character's for every kind of IP.
describe('the edit drawer\'s examples follow what the IP is', () => {
  const chipsOf = async (target: Ip) => {
    await act(async () => root.render(<EditDrawer target={{ kind: 'ip', ip: target }} onClose={vi.fn()} onSend={vi.fn(() => Promise.resolve())} />));
    const chips = [...container.querySelectorAll<HTMLButtonElement>('.chip-btn')].map((b) => b.textContent ?? '');
    expect(container.querySelector('textarea')!.placeholder).toBe(`예: ${chips[0]}`);
    return chips;
  };
  const BODY = /스카프|머리|표정|은발/;
  it('a prop is offered nothing a body wears', async () => {
    const chips = await chipsOf(ip('prop', '별조각'));
    expect(chips).toHaveLength(3);
    for (const c of chips) expect(c).not.toMatch(BODY);
  });
  it('a weapon, an enemy and a background each get their own, and a character keeps hers', async () => {
    const sets = [await chipsOf(ip('weapon', '별빛 검')), await chipsOf(ip('enemy', '그림자 늑대')), await chipsOf(ip('prop', '폐허 도시', { usage: 'background' })),
      await chipsOf(ip('prop', '별조각'))];
    for (const chips of sets) for (const c of chips) expect(c).not.toMatch(BODY);
    expect(new Set(sets.map((s) => s.join('|'))).size).toBe(4);
    expect(await chipsOf(ip('character', '꼬마 마법사'))).toContain('목에 빨간 스카프를 둘러줘');
  });
});
