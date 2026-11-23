import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { DesignDrawer } from './components/DesignDrawer';
import { THREE_D_TOTAL, type Asset, type GameDesignRequest, type Ip, type Job } from './types';

// In a session with no hero in 3D the design drawer opens on what is missing and leads to the chat, not on a form
// whose submit can never be pressed. A prop in 3D can be the player too (server/tools.py hold_heroes, _needs_3d).
const at = '2026-11-17T03:00:00Z';
const ip = (ipId: string, name: string, kind: Ip['kind'], extra: Partial<Ip> = {}): Ip => ({ ipId, name, kind, description: '', version: 1,
  imageAssetId: `${ipId}_img`, cutoutAssetId: `${ipId}_cut`, createdAt: at, ...extra });
const asset = (assetId: string, kind: Asset['kind']): Asset => ({ assetId, kind, key: assetId, url: `/u/${assetId}`, contentType: '', meta: {}, createdAt: at });
const job = (kind: Job['kind'], ipId: string, status: Job['status']): Job => ({ jobId: `job_${kind}_${ipId}`, kind, provider: 'img3d', status, input: { ipId },
  outputs: [], deps: [], progress: '', createdAt: at, updatedAt: at });
const wizard = ip('ip_wiz', '꼬마 마법사', 'character');
const guide = ip('ip_guide', '숲지기', 'character');
const lantern = ip('ip_lamp', '반딧불 등불', 'prop');
const glade = ip('ip_glade', '달빛 숲 공터', 'prop', { usage: 'background', glbAssetId: 'glb_glade' });

type Send = (text: string, request: GameDesignRequest) => Promise<void>;
let container: HTMLDivElement;
let root: Root;
let onChat: Mock<() => void>;
let onClose: Mock<() => void>;
let onMake3d: Mock<(ip: Ip) => Promise<void>>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  sessionStorage.clear();
  history.replaceState(null, '', '#s=ses_design');
  onChat = vi.fn();
  onClose = vi.fn();
  onMake3d = vi.fn(async () => undefined);
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
const show = (ips: Ip[], assets: Asset[] = [], jobs: Job[] = []) => act(async () => root.render(
  <DesignDrawer ips={ips} assets={assets} jobs={jobs} onMake3d={onMake3d} onChat={onChat} onClose={onClose} onSend={vi.fn<Send>(async () => undefined)} />));
const blocked = () => container.querySelector<HTMLElement>('.design-blocked');
const form = () => container.querySelector('#game-design-form');
const buttons = (within: ParentNode = container) => [...within.querySelectorAll<HTMLButtonElement>('button')].map((b) => b.textContent);
const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text)!;
const steps = () => [...blocked()!.querySelectorAll('.game-needs li')].map((li) => [li.textContent, li.getAttribute('aria-current')]);
const REASON = '게임 설계는 3D가 끝난 주인공 캐릭터가 있어야 쓸 수 있어요.';

describe('게임 설계 without a hero in 3D says what is missing and offers the way there, not a form (R20-14)', () => {
  it('no IP yet: the reason, the three steps with the first one current, and a button to the chat; nothing to fill in', async () => {
    await show([]);
    expect(form()).toBeNull();
    expect(container.querySelectorAll('textarea, select, input')).toHaveLength(0);
    expect(blocked()!.querySelector('strong')!.textContent).toBe(REASON);
    expect(blocked()!.querySelector('.design-blocked-now')!.textContent).toBe('지금은 캐릭터가 없어요. 채팅에 원하는 캐릭터를 한 줄로 적으면 그림부터 만들어요.');
    expect(steps()).toEqual([['① 채팅으로 캐릭터 만들기', 'step'], [`② 캐릭터 카드의 ‘3D로 만들기’ (보통 ${THREE_D_TOTAL})`, null], ['③ 게임 설계', null]]);
    const go = button('채팅으로 캐릭터 만들기');
    expect(go.className).toContain('btn-primary');
    await act(async () => go.click());
    expect(onChat).toHaveBeenCalledOnce();
    // the foot has no submit that cannot be pressed: only the way out
    expect(buttons(container.querySelector('.dialog-footer')!)).toEqual(['닫기']);
    expect(container.querySelector('button[type="submit"]')).toBeNull();
    // the dialog is still named and described
    expect(container.querySelector('[role="dialog"]')!.getAttribute('aria-describedby')).toBe('design-intro');
    expect(container.querySelector('#design-intro')!.textContent).toBe(REASON);
  });

  it('a character with no 3D: step ② is the one to do, and its 3D starts from here, with what it takes', async () => {
    await show([wizard, guide, lantern], [], [job('apose', 'ip_guide', 'running')]);
    expect(form()).toBeNull();
    expect(blocked()!.querySelector('.design-blocked-now')!.textContent).toBe('주인공이 될 캐릭터의 3D가 아직 없어요. 3D가 끝나면 이 창에서 출연 IP와 역할을 고를 수 있어요.');
    expect(steps().map(([, current]) => current)).toEqual([null, 'step', null]);
    const rows = [...blocked()!.querySelectorAll('.design-blocked-list li')];
    expect(rows.map((r) => r.querySelector('.design-blocked-name')!.textContent)).toEqual(['꼬마 마법사', '숲지기']); // the characters: a prop cannot be the form's player
    expect(rows[0].querySelector('small')!.textContent).toBe(`보통 ${THREE_D_TOTAL}`);
    expect(rows[1].textContent).toContain('3D 만드는 중 · 3D용 자세 그림'); // one being made says the step it is at, and has no button
    expect(buttons(rows[1])).toEqual([]);
    await act(async () => rows[0].querySelector<HTMLButtonElement>('button')!.click());
    expect(onMake3d).toHaveBeenCalledExactlyOnceWith(wizard);
  });

  it('the form opens by itself once a hero\'s 3D is in, and on request before that (what is typed is kept for the tab)', async () => {
    await show([wizard], [], [job('mesh3d', 'ip_wiz', 'running')]);
    expect(form()).toBeNull();
    await act(async () => button('3D를 기다리는 동안 설계 미리 적어 두기').click());
    expect(form()).not.toBeNull();
    expect(container.querySelector('#design-submit-hint')!.textContent).toContain('3D가 완성된 주인공'); // why it cannot be sent yet
    await act(async () => root.unmount());
    root = createRoot(container);
    await show([{ ...wizard, glbAssetId: 'glb_wiz' }], [asset('glb_wiz', 'glb')]); // her 3D is in: the form, with the 출연 IP list
    expect(blocked()).toBeNull();
    expect(form()!.querySelector('.cast-grid')).not.toBeNull();
    expect(container.querySelector('button[type="submit"]')!.textContent).toBe('이 설계로 게임 만들기');
  });

  it('a character whose picture is still being drawn cannot start its 3D yet, and says so', async () => {
    await show([{ ...wizard, imageAssetId: undefined }]);
    const start = blocked()!.querySelector<HTMLButtonElement>('.design-blocked-list button')!;
    expect([start.disabled, start.textContent]).toEqual([true, '그림 그리는 중']);
  });
});

describe('a session with no character says what chat does there: an IP in 3D is the player (new finding 24)', () => {
  it('with an object in 3D: chat makes the game with it; the form needs a character', async () => {
    await show([{ ...lantern, glbAssetId: 'glb_lamp' }, glade], [asset('glb_lamp', 'glb'), asset('glb_glade', 'glb')]);
    expect(form()).toBeNull();
    expect(blocked()!.querySelector('strong')!.textContent).toBe(REASON);
    expect(blocked()!.querySelector('.design-blocked-now')!.textContent)
      // why only the chat is offered
      .toBe('지금은 캐릭터가 없어요. 캐릭터가 없는 세션에서는 3D가 끝난 ‘반딧불 등불’이 주인공으로 나와요. 소품이나 적이 주인공인 게임은 채팅으로 요청해 주세요.');
    await act(async () => button('채팅으로 게임 요청하기').click());
    expect(onChat).toHaveBeenCalledOnce();
  });

  it('before any of its IPs is in 3D: the steps, and that an IP in 3D will do', async () => {
    await show([lantern, glade], [asset('glb_glade', 'glb')]); // the whole-scene background's panel is scenery, not a player
    expect(steps().map(([, current]) => current)).toEqual(['step', null, null]);
    expect(blocked()!.querySelector('.design-blocked-note')!.textContent)
      .toBe('캐릭터 없이도 돼요. 지금 있는 IP를 3D로 만든 뒤 채팅으로 게임을 요청하면 그 IP가 주인공으로 나와요.');
    expect(button('채팅으로 캐릭터 만들기')).toBeTruthy();
  });
});

// An example must not replace a typed idea, its mission and its rules.
describe('an example in 게임 설계 does not cost what was typed (R20-56)', () => {
  const hero = { ...wizard, glbAssetId: 'glb_wiz' };
  const open = () => show([hero], [asset('glb_wiz', 'glb')]);
  const idea = () => container.querySelector<HTMLTextAreaElement>('#game-design-prompt')!;
  const type = (text: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(idea(), text);
    idea().dispatchEvent(new Event('input', { bubbles: true }));
  });
  const undo = () => container.querySelector<HTMLElement>('.design-undo');

  it('after an example over typed text, one press brings the typed design back', async () => {
    await open();
    await type('꼬마 마법사가 별조각을 모으는 조용한 숲 탐험');
    await act(async () => button('용광로 보스전').click());
    expect(idea().value).not.toContain('꼬마 마법사');
    expect(undo()!.textContent).toBe('예시 ‘용광로 보스전’으로 바꿨어요. 입력하던 설계로 되돌리기');
    await act(async () => undo()!.querySelector('button')!.click());
    expect(idea().value).toBe('꼬마 마법사가 별조각을 모으는 조용한 숲 탐험');
    expect(undo()).toBeNull();
  });

  it('offers nothing to take back when nothing was typed, and the hint says an example can be taken back', async () => {
    await open();
    await act(async () => button('용광로 보스전').click());
    expect(undo()).toBeNull();
    expect(container.querySelector('#game-design-prompt-hint')!.textContent).toBe('원하는 세계, 플레이 방식, 목표를 적어 주세요. 예시를 고르면 입력한 설계가 예시 내용으로 바뀌고, 바로 되돌릴 수 있어요.');
  });

  it('a second example keeps the first typed design as what comes back', async () => {
    await open();
    await type('꼬마 마법사의 숲 탐험');
    await act(async () => button('용광로 보스전').click());
    await act(async () => button('사막 코어 회수').click());
    expect(undo()!.textContent).toContain('사막 코어 회수');
    await act(async () => undo()!.querySelector('button')!.click());
    expect(idea().value).toBe('꼬마 마법사의 숲 탐험');
  });
});

// The idea box stands above the game types, so the first type must not point "below".
describe('the default game type points at the idea box where it is (new finding 32)', () => {
  it('says 위에 적은 아이디어대로 설계', async () => {
    await show([{ ...wizard, glbAssetId: 'glb_wiz' }], [asset('glb_wiz', 'glb')]);
    const first = container.querySelector('.type-grid label')!;
    expect(first.textContent).toBe('요청에 맞게위에 적은 아이디어대로 설계');
    expect(container.textContent).not.toContain('아래 프롬프트');
  });
});
