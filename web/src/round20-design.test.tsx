import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignDrawer } from './components/DesignDrawer';
import type { Asset, Game, GameDesignRequest, Ip } from './types';

// The design drawer: examples in plain words (no spec field names), ✎ 게임 설계 opens the short edit form when a game
// is on screen, Esc keeps the brief with the ticked 출연 IP and their roles, and an untouched form shows no count.
const at = '2026-11-16T03:00:00Z';
const ip = (ipId: string, name: string, kind: Ip['kind'], extra: Partial<Ip> = {}): Ip => ({ ipId, name, kind, description: '', version: 1,
  imageAssetId: `${ipId}_img`, cutoutAssetId: `${ipId}_cut`, createdAt: at, ...extra });
const lira = ip('ip_lira', '리라', 'character', { glbAssetId: 'glb_lira' });
const guide = ip('ip_guide', '숲지기', 'character');
const lantern = ip('ip_lantern', '반딧불 등불', 'prop');
const ips = [lira, guide, lantern];
const assets = [{ assetId: 'glb_lira', kind: 'glb' } as Asset];
const game = (gameId: string, title: string, createdAt: string): Game => ({ gameId, title, genre: 'rpg-quest', specKey: `games/${gameId}/spec.json`,
  previewUrl: `/games/${gameId}/index.html`, createdAt });
const SPEC_WORDS = /version 2|engine three|world\.city|districts|streets|pedestrians|entityIds|distanceMeters/;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  sessionStorage.clear();
  history.replaceState(null, '', '#s=ses_design');
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
type Send = (text: string, request: GameDesignRequest) => Promise<void>;
const show = (props: Partial<Parameters<typeof DesignDrawer>[0]> = {}) => act(async () => root.render(
  <DesignDrawer ips={ips} assets={assets} onClose={vi.fn()} onSend={vi.fn<Send>(async () => undefined)} {...props} />));
const reopen = async (props: Partial<Parameters<typeof DesignDrawer>[0]> = {}) => {
  await act(async () => root.unmount()); // Esc, a click outside or 취소: the drawer is gone
  root = createRoot(container);
  await show(props);
};
const idea = () => container.querySelector<HTMLTextAreaElement>('#game-design-prompt')!;
const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text)!;
const pick = (name: string) => act(async () => container.querySelector<HTMLInputElement>(`input[aria-label="${name} 출연 IP 선택"]`)!.click());
const picked = () => [...container.querySelectorAll('.cast-card.is-on')].map((c) => [c.querySelector('.cast-name')!.firstChild!.textContent,
  c.querySelector('select')!.value]);
const type = (text: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(idea(), text);
  idea().dispatchEvent(new Event('input', { bubbles: true }));
});
const submit = () => act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
const count = () => container.querySelector('.design-count')!.textContent;

describe('R20-39 the first example reads as an idea, not as a spec', () => {
  it('fills the idea box with plain words; what the AI needs beyond them rides along, to be seen or dropped', async () => {
    const send = vi.fn<Send>(async () => undefined);
    await show({ onSend: send });
    await act(async () => button('도시 코어 운송').click());
    expect(idea().value).not.toMatch(SPEC_WORDS);
    expect([...idea().value].length).toBeLessThan(160);
    expect(idea().value).toContain('도시');
    const guide = container.querySelector<HTMLDetailsElement>('details.design-spec')!;
    expect(guide.querySelector('summary')!.textContent).toBe('이 예시와 함께 보내는 설계 지침 보기');
    expect(guide.open).toBe(false);
    expect(guide.querySelector('p')!.textContent).toMatch(SPEC_WORDS);
    await pick('리라'); await pick('숲지기'); await pick('반딧불 등불');
    await submit();
    const [text] = send.mock.calls[0];
    for (const needed of ['world.city', '300–1200m', 'type drive', 'distanceMeters 150', 'E로 승하차']) expect(text).toContain(needed);
    expect(text).toContain(`게임 요청: ${idea().value}`);
  });

  it('drops the guide on 지침 빼기, and when another game type is picked', async () => {
    const send = vi.fn<Send>(async () => undefined);
    await show({ onSend: send });
    await act(async () => button('도시 코어 운송').click());
    await act(async () => button('지침 빼기').click());
    expect(container.querySelector('details.design-spec')).toBeNull();
    await pick('리라'); await pick('숲지기'); await pick('반딧불 등불');
    await submit();
    expect(send.mock.calls[0][0]).not.toMatch(/world\.city|distanceMeters/);

    await reopen();
    await act(async () => button('도시 코어 운송').click());
    expect(container.querySelector('details.design-spec')).not.toBeNull();
    const boss = [...container.querySelectorAll<HTMLInputElement>('input[name="type"]')].find((r) => r.closest('label')!.textContent!.startsWith('보스전'))!;
    await act(async () => boss.click());
    expect(container.querySelector('details.design-spec')).toBeNull(); // a city's guide is no guide for a boss fight
  });
});

describe('R20-39 the drawer is the new-game form, and says where a game on screen is edited', () => {
  it('is titled 새 게임 설계', async () => {
    await show();
    expect(container.querySelector('#design-title')!.textContent).toBe('새 게임 설계');
    expect(container.querySelector('.design-edit-offer')).toBeNull(); // no game yet: nothing to edit
  });

  it('offers 이 게임 수정 for the newest game, by its title and version', async () => {
    const onEditGame = vi.fn();
    const first = game('gm_1', '달빛 숲의 별조각', '2026-11-16T04:00:00Z');
    const second = game('gm_2', '달빛 숲의 별조각: 30초 생존', '2026-11-16T04:18:00Z');
    await show({ games: [second, first], onEditGame });
    const offer = container.querySelector('.design-edit-offer')!;
    expect(offer.textContent).toBe('여기서는 새 게임을 처음부터 설계해요. 지금 게임 ‘달빛 숲의 별조각: 30초 생존’(v2)을 조금 고치려면 이 게임 수정을 누르세요.');
    await act(async () => button('이 게임 수정').click());
    expect(onEditGame).toHaveBeenCalledWith(second, 2);
  });
});

describe('R20-39 what was picked survives a closed drawer', () => {
  it('keeps the ticked IPs and their roles with the brief, for this tab, until the design is sent', async () => {
    const send = vi.fn<Send>(async () => undefined);
    await show({ onSend: send });
    await type('리라가 숲지기의 부탁으로 등불을 찾는 탐험 게임');
    await pick('리라'); await pick('숲지기'); await pick('반딧불 등불');
    const role = container.querySelector<HTMLSelectElement>('select[aria-label="숲지기 게임 역할"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(role, 'enemy');
      role.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(picked()).toEqual([['리라', 'player'], ['숲지기', 'enemy'], ['반딧불 등불', 'prop']]);

    await reopen({ onSend: send });
    expect(idea().value).toBe('리라가 숲지기의 부탁으로 등불을 찾는 탐험 게임');
    expect(picked()).toEqual([['리라', 'player'], ['숲지기', 'enemy'], ['반딧불 등불', 'prop']]);
    // an IP that is gone since (its session's IPs changed) is not a pick any more
    await reopen({ onSend: send, ips: [lira, lantern] });
    expect(picked()).toEqual([['리라', 'player'], ['반딧불 등불', 'prop']]);

    await submit();
    expect(send).toHaveBeenCalledOnce();
    await reopen();
    expect([idea().value, picked()]).toEqual(['', []]); // sent: the next design starts fresh
  });
});

describe('R20-39 the small print', () => {
  it('counts nothing on an untouched form, and the whole request once there is one', async () => {
    await show();
    expect(count()).toBe('전체 설계 0 / 4,000자');
    await type('등불을 찾는 탐험');
    expect(count()).toBe(`전체 설계 ${[...'[게임 설계] 이 설계대로 3D 게임을 만들어줘.\n게임 요청: 등불을 찾는 탐험'].length} / 4,000자`);
  });

  it('shows one hint under the cast in plain words and keeps the rest behind 자세히', async () => {
    await show();
    const cast = container.querySelector('fieldset.cast')!;
    const hints = [...cast.querySelectorAll(':scope > .field-hint')];
    expect(hints.map((h) => h.textContent)).toEqual(['주인공은 3D가 끝난 캐릭터여야 해요. 3D가 없는 적과 소품은 납작한 그림판으로 나와요.']);
    const more = cast.querySelector<HTMLDetailsElement>('details.design-more')!;
    expect([more.querySelector('summary')!.textContent, more.open]).toEqual(['자세히', false]);
    expect(more.textContent).toContain('도시 보행자는 그 NPC와 같은 모습으로 나와요');
    expect(container.textContent).not.toMatch(/리깅|컷아웃|동일 IP|Poly Haven|Three\.js|에이전트가 정함/);
  });
});
