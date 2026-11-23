import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionMenu, type MenuItem } from './components/ActionMenu';
import { Dropdown } from './components/Dropdown';
import { Fold } from './components/Fold';
import { Tabs, openTab, readHash, writeHash } from './components/Tabs';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => { f(0); return 0; });
  localStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const key = (el: Element, k: string) => act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); });

describe('ActionMenu: one trigger instead of a row of buttons', () => {
  it('opens a portalled menu, moves with the keyboard, skips disabled items and returns focus on Esc', async () => {
    const edit = vi.fn();
    await act(async () => root.render(<ActionMenu label="테오 작업 더보기" items={[
      { label: '수정하기', onSelect: edit }, { label: '다시 뽑기', disabled: true, hint: '이미지 생성 중' },
      { label: 'GLB 내려받기', href: 'https://cdn/x.glb', download: true }]} />));
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await act(async () => trigger.click());
    const menu = document.body.querySelector('[role="menu"]')!;
    expect(container.contains(menu)).toBe(false); // portalled: a card's overflow cannot clip it
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(document.activeElement).toBe(items[0]);
    await key(menu, 'ArrowDown');
    expect(document.activeElement).toBe(items[2]); // the disabled one is skipped
    expect(items[2].getAttribute('download')).toBe('');
    expect(items[1].getAttribute('aria-disabled')).toBe('true');
    expect(items[1].textContent).toContain('이미지 생성 중');
    await key(menu, 'Escape');
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(edit).not.toHaveBeenCalled();
  });

  it('runs an item, closes, and shows busy then done next to the trigger', async () => {
    let resolve!: () => void;
    const reroll = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    await act(async () => root.render(<ActionMenu label="더보기" items={[{ label: '다시 뽑기', onSelect: reroll, busyLabel: '요청 중…', doneLabel: '뽑는 중' }]} />));
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
    await act(async () => document.body.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click());
    expect(reroll).toHaveBeenCalledOnce();
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    expect(container.querySelector('[role="status"]')!.textContent).toBe('요청 중…');
    const trigger = container.querySelector<HTMLButtonElement>('button')!;
    expect(trigger.getAttribute('aria-disabled')).toBe('true');
    await act(async () => trigger.click()); // no second request while the first is in flight
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    await act(async () => resolve());
    expect(trigger.hasAttribute('aria-disabled')).toBe(false);
    expect(container.querySelector('[role="status"]')!.textContent).toBe('뽑는 중');
  });

  it('closes on an outside click', async () => {
    await act(async () => root.render(<ActionMenu label="더보기" items={[{ label: 'A', onSelect: vi.fn() }]} />));
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
    await act(async () => { document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); });
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
  });

  // a card still drawing its first picture has every item disabled
  const pending = (enabled = false) => ['수정하기', '다시 뽑기', '액션 샷'].map((label) =>
    (enabled ? { label, onSelect: vi.fn() } : { label, disabled: true, hint: '이미지 생성 중' }));
  const menu = () => document.body.querySelector<HTMLElement>('[role="menu"]');
  const press = (k: string) => key(document.activeElement!, k); // a real key goes to whatever has focus

  it('with nothing enabled the menu itself takes focus: the arrows stay, Esc and Tab close it and return to the trigger', async () => {
    await act(async () => root.render(<ActionMenu label="피오 작업 더보기" items={pending()} />));
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
    trigger.focus();
    await act(async () => trigger.click());
    expect(document.activeElement).toBe(menu());
    for (const k of ['ArrowDown', 'ArrowUp', 'Home', 'End']) await press(k);
    expect(document.activeElement).toBe(menu()); // a disabled item takes no focus
    await press('Escape');
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger);

    await act(async () => trigger.click());
    await press('Tab');
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger); // the browser's Tab goes on from the trigger, not from the end of <body>
  });

  it('the picture lands while the menu is open: the arrows reach the items it enabled', async () => {
    await act(async () => root.render(<ActionMenu label="피오 작업 더보기" items={pending()} />));
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
    await act(async () => root.render(<ActionMenu label="피오 작업 더보기" items={pending(true)} />));
    await press('ArrowDown');
    expect(document.activeElement).toBe(menu()!.querySelector('[role="menuitem"]'));
  });

  it('Esc closes an open menu wherever focus is', async () => {
    let items: MenuItem[] = [{ label: 'GLB 내려받기', href: 'https://cdn/x.glb', download: true }, { label: '수정하기', onSelect: vi.fn() }];
    const view = () => <><ActionMenu label="루미 작업 더보기" items={items} /><input aria-label="채팅" /></>;
    await act(async () => root.render(view()));
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
    await act(async () => trigger.click());
    expect(document.activeElement).toBe(menu()!.querySelector('a'));
    items = [{ label: 'GLB 내려받기', disabled: true, hint: '3D 제작 중' }, items[1]]; // the focused link became a button
    await act(async () => root.render(view()));
    expect(document.activeElement).toBe(document.body);
    await press('Escape');
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger); // focus was lost with the item: it comes back to the trigger

    await act(async () => trigger.click());
    const input = container.querySelector('input')!;
    input.focus();
    await press('Escape');
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(input); // closing does not pull focus away from where the user is typing
  });

  // a reply scrolls the chat log to the bottom: the open card menu must not close by itself
  it('stays open while something else scrolls, and closes once a scroll moves its trigger', async () => {
    await act(async () => root.render(<>
      <div className="tabpanel"><ActionMenu label="루미 작업 더보기" items={[{ label: '수정하기', onSelect: vi.fn() }]} /></div>
      <div className="chat-log" />
    </>));
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
    let top = 480;
    vi.spyOn(trigger, 'getBoundingClientRect').mockImplementation(() =>
      ({ x: 500, y: top, left: 500, top, right: 532, bottom: top + 28, width: 32, height: 28, toJSON: () => ({}) }) as DOMRect);
    await act(async () => trigger.click());
    const scroll = (el: EventTarget) => act(async () => { el.dispatchEvent(new Event('scroll')); });
    await scroll(container.querySelector('.chat-log')!); // the chat log follows a new message
    await scroll(menu()!); // the menu's own list (past 8 rows)
    await scroll(container.querySelector('.tabpanel')!); // its pane, but the trigger stayed put (scroll anchoring, a late event)
    expect(menu()).not.toBeNull();
    top = 440;
    await scroll(container.querySelector('.tabpanel')!);
    expect(menu()).toBeNull(); // the menu's fixed coordinates would no longer meet the trigger
  });
});

// The chat is a column at the window's right edge and its lists open rightwards: a long model name must not run
// the list past the window's edge (the focus it takes would scroll the studio sideways).
describe('Dropdown: its list stays inside the window', () => {
  const options = [{ value: 'auto', label: '영상 · 자동' }, { value: 'minimax-h3', label: 'MiniMax H3 (Hailuo 3.0) FL2VA 33B' }];
  /** The list as the browser would lay it out: `left`..`right` in a window 1366 px wide. */
  const laidOut = (left: number, right: number) => vi.spyOn(HTMLUListElement.prototype, 'getBoundingClientRect')
    .mockReturnValue({ left, right, top: 500, bottom: 700, width: right - left, height: 200, x: left, y: 500, toJSON: () => ({}) });
  const open = async () => {
    await act(async () => root.render(<Dropdown label="영상 모델" value="auto" options={options} onChange={vi.fn()} hideLabel />));
    await act(async () => container.querySelector<HTMLButtonElement>('.dropdown-button')!.click());
    return container.querySelector<HTMLElement>('[role="listbox"]')!;
  };
  beforeEach(() => vi.stubGlobal('innerWidth', 1366));
  afterEach(() => vi.restoreAllMocks());

  it('opens from its button\'s other edge when it would run past the window\'s right or left edge', async () => {
    laidOut(1108, 1373);
    expect((await open()).className).toBe('listbox is-end');
    await act(async () => root.render(null));
    laidOut(-40, 225);
    expect((await open()).className).toBe('listbox is-start');
    await act(async () => root.render(null));
    laidOut(900, 1165); // it fits: where its stylesheet puts it
    expect((await open()).className).toBe('listbox');
  });

  it('takes the focus without scrolling the page to itself', async () => {
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    const list = await open();
    expect(document.activeElement).toBe(list);
    expect(focus.mock.calls.at(-1)).toEqual([{ preventScroll: true }]);
  });
});

describe('Fold: an accordion section', () => {
  it('starts folded and inert, opens on click with its summary always visible, and remembers the choice', async () => {
    await act(async () => root.render(<Fold id="game-settings" title="게임 설정" meta="RPG 퀘스트 · v38" storageKey="t.fold"><button>안</button></Fold>));
    const head = container.querySelector<HTMLButtonElement>('#game-settings-head')!;
    const region = container.querySelector<HTMLElement>('#game-settings-region')!;
    expect([head.getAttribute('aria-expanded'), head.getAttribute('aria-controls'), region.getAttribute('aria-labelledby')])
      .toEqual(['false', 'game-settings-region', 'game-settings-head']);
    expect(region.hasAttribute('inert')).toBe(true);
    expect(head.textContent).toContain('RPG 퀘스트 · v38');
    await act(async () => head.click());
    expect(head.getAttribute('aria-expanded')).toBe('true');
    expect(region.hasAttribute('inert')).toBe(false);
    expect(localStorage.getItem('t.fold')).toBe('1');
  });

  it('can start open', async () => {
    await act(async () => root.render(<Fold id="jobs-running" title="진행 중" defaultOpen><p>x</p></Fold>));
    expect(container.querySelector('#jobs-running-head')!.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('Tabs: the address keeps the tab, and a tab can be opened from outside the bar', () => {
  const tabs = [{ id: 'characters', label: '캐릭터' }, { id: 'props', label: '소품' }, { id: 'video', label: '영상' }];
  const show = () => act(async () => root.render(<Tabs hashKey="ip" label="IP" tabs={tabs}>{(active) => <p>{active}</p>}</Tabs>));
  const selected = () => container.querySelector('[role="tab"][aria-selected="true"]')!.id;

  it('openTab shows a tab of a bar on the page and writes it to the address; an unknown one changes nothing on screen', async () => {
    history.replaceState(null, '', '#s=ses_1');
    await show();
    expect(selected()).toBe('ip-tab-characters');
    await act(async () => openTab('ip', 'video')); // a finished job's toast: 영상 탭에서 보기
    expect(selected()).toBe('ip-tab-video');
    expect(container.querySelector('#ip-panel-video p')!.textContent).toBe('video');
    expect(location.hash).toBe('#s=ses_1&ip=video');
    await act(async () => openTab('game', 'video')); // another bar's key
    await act(async () => openTab('ip', 'nowhere'));
    expect(selected()).toBe('ip-tab-video');
  });

  it('a tab change replaces the address, a session change is a step Back undoes (R20-49)', () => {
    history.replaceState(null, '', '#s=ses_1');
    const before = history.length;
    writeHash('ip', 'props');
    expect([location.hash, history.length]).toEqual(['#s=ses_1&ip=props', before]);
    writeHash('s', 'ses_2', true);
    expect([location.hash, history.length]).toEqual(['#s=ses_2&ip=props', before + 1]);
    expect(readHash('s')).toBe('ses_2');
  });
});
