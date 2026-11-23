import { act, useRef, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './components/ConfirmDialog';
import { Dropdown } from './components/Dropdown';
import { EditDrawer } from './components/EditDrawer';
import { Toasts } from './components/Toasts';
import { useDialog } from './components/useDialog';

let container: HTMLDivElement;
let opener: HTMLButtonElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  opener = document.createElement('button');
  opener.textContent = '열기';
  container = document.createElement('div');
  document.body.append(opener, container);
  opener.focus();
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  opener.remove();
  vi.unstubAllGlobals();
});

function Panel({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  useDialog(panel, onClose);
  return <div ref={panel} role="dialog" aria-modal="true">{children}</div>;
}

const element = <T extends HTMLElement>(selector: string) => container.querySelector<T>(selector)!;
async function key(target: HTMLElement, value: string, shiftKey = false) {
  await act(async () => target.dispatchEvent(new KeyboardEvent('keydown', {
    key: value, shiftKey, bubbles: true, cancelable: true,
  })));
}

describe('dialog keyboard boundaries', () => {
  it('wraps through visible enabled controls and restores the opener', async () => {
    await act(async () => root.render(
      <Panel onClose={vi.fn()}>
        <button id="first">첫 항목</button>
        <div hidden><button>hidden</button></div>
        <div style={{ display: 'none' }}><button>display none</button></div>
        <div aria-hidden="true"><button>aria hidden</button></div>
        <div inert><button>inert</button></div>
        <fieldset disabled><button>disabled fieldset</button></fieldset>
        <input type="hidden" />
        <button id="last">마지막 항목</button>
        <button disabled>disabled</button>
      </Panel>,
    ));
    expect(document.activeElement).toBe(element('#first'));
    await key(element('#first'), 'Tab', true);
    expect(document.activeElement).toBe(element('#last'));
    await key(element('#last'), 'Tab');
    expect(document.activeElement).toBe(element('#first'));
    opener.focus();
    expect(document.activeElement).toBe(element('#first'));
    await act(async () => root.render(null));
    expect(document.activeElement).toBe(opener);
  });

  it('closes an open dropdown on the first Escape and the dialog on the next', async () => {
    const close = vi.fn();
    await act(async () => root.render(
      <Panel onClose={close}>
        <Dropdown label="모델" value="one" options={[
          { value: 'one', label: '첫 모델' }, { value: 'two', label: '다음 모델' },
        ]} onChange={vi.fn()} />
      </Panel>,
    ));
    await act(async () => element<HTMLButtonElement>('.dropdown-button').click());
    expect(document.activeElement).toBe(element('[role="listbox"]'));
    await key(element('[role="listbox"]'), 'Escape');
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(document.activeElement).toBe(element('.dropdown-button'));
    expect(close).not.toHaveBeenCalled();
    await key(element('.dropdown-button'), 'Escape');
    expect(close).toHaveBeenCalledOnce();
  });

  // Esc or a click on the backdrop must not drop what was typed.
  it('keeps a dialog with typed text open on the first Escape and on a click beside it, and says so', async () => {
    const close = vi.fn();
    function Drawer() {
      const panel = useRef<HTMLDivElement>(null);
      const [text, setText] = useState('');
      useDialog(panel, close, 'textarea');
      return (
        <div className="drawer-root">
          <div className="drawer-backdrop" onClick={close} />
          <div ref={panel} role="dialog" aria-modal="true">
            <textarea value={text} onChange={(e) => setText(e.target.value)} />
            <input readOnly value="https://example.invalid/a-published-address" />
            <button id="cancel" onClick={close}>취소</button>
          </div>
        </div>
      );
    }
    const type = (text: string) => act(async () => {
      const box = element<HTMLTextAreaElement>('textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, text);
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const backdrop = () => act(async () => element('.drawer-backdrop').click());
    const said = () => container.querySelector('.dialog-keep')?.textContent ?? null;
    vi.useFakeTimers();
    try {
      await act(async () => root.render(<Drawer />));
      // nothing typed: both close at once
      await backdrop();
      await key(element('textarea'), 'Escape');
      expect(close).toHaveBeenCalledTimes(2);
      expect(said()).toBeNull();

      await type('목에 빨간 스카프를 둘러줘');
      await backdrop(); // a slip beside the panel
      await backdrop(); // ... never closes a dialog with text in it
      expect(close).toHaveBeenCalledTimes(2);
      expect(said()).toBe('입력한 내용이 있어요. 닫으려면 Esc를 한 번 더 누르거나 취소를 눌러 주세요.');
      expect(element('.dialog-keep').getAttribute('role')).toBe('status');
      await act(async () => { vi.advanceTimersByTime(7000); });
      expect(said()).toBeNull(); // the line leaves after 6 s

      await key(element('textarea'), 'Escape'); // the first Esc says it
      expect(close).toHaveBeenCalledTimes(2);
      expect(said()).not.toBeNull();
      await key(element('textarea'), 'Escape'); // the second closes
      expect(close).toHaveBeenCalledTimes(3);

      await act(async () => { vi.advanceTimersByTime(7000); });
      await key(element('textarea'), 'Escape'); // later, it asks again
      expect(close).toHaveBeenCalledTimes(3);
      await act(async () => element<HTMLButtonElement>('#cancel').click()); // 취소 closes at once, as it says
      expect(close).toHaveBeenCalledTimes(4);

      await type('   '); // blanks are nothing to lose
      await act(async () => { vi.advanceTimersByTime(7000); });
      await key(element('textarea'), 'Escape');
      expect(close).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });

  // Some dialogs have only 닫기, and a phone has no Esc: the line names only a way out that is there.
  it('the line that keeps a dialog open names a button the dialog has, and no Esc where there is no keyboard', async () => {
    function Drawer({ foot }: { foot: ReactNode }) {
      const panel = useRef<HTMLDivElement>(null);
      const [text, setText] = useState('내 노트');
      useDialog(panel, vi.fn());
      return (
        <div className="drawer-root">
          <div className="drawer-backdrop" />
          <div ref={panel} role="dialog" aria-modal="true">
            <input id="name" value={text} onChange={(e) => setText(e.target.value)} />
            {foot}
          </div>
        </div>
      );
    }
    const said = async (foot: ReactNode) => {
      await act(async () => root.render(null));
      await act(async () => root.render(<Drawer foot={foot} />));
      await act(async () => {
        const field = element<HTMLInputElement>('#name');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, '내 노트 MCP');
        field.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => element('.drawer-backdrop').click());
      return container.querySelector('.dialog-keep')!.textContent;
    };
    const close = <button type="button" aria-label="닫기">×</button>;
    expect(await said(<>{close}<button type="button">닫기</button></>)).toBe('입력한 내용이 있어요. 닫으려면 Esc를 한 번 더 누르거나 닫기를 눌러 주세요.');
    expect(await said(<>{close}<button type="button">취소</button><button type="button">저장</button></>))
      .toBe('입력한 내용이 있어요. 닫으려면 Esc를 한 번 더 누르거나 취소를 눌러 주세요.');
    expect(await said(close)).toBe('입력한 내용이 있어요. 닫으려면 Esc를 한 번 더 누르거나 닫기(×)를 눌러 주세요.');
    expect(await said(<button type="button" hidden>취소</button>)).toBe('입력한 내용이 있어요. 닫으려면 Esc를 한 번 더 눌러 주세요.'); // no button in sight
    // a phone or a tablet: touch only
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(hover: none) and (pointer: coarse)' }));
    expect(await said(<>{close}<button type="button">닫기</button></>)).toBe('입력한 내용이 있어요. 닫으려면 닫기를 눌러 주세요.');
  });

  it('a field that came with a value of its own is not typed text; one the user changed is', async () => {
    const close = vi.fn();
    function Steps() {
      const panel = useRef<HTMLDivElement>(null);
      const [made, setMade] = useState(false);
      const [name, setName] = useState('');
      useDialog(panel, close);
      return (
        <div className="modal-root">
          <div className="modal-backdrop" onClick={close} />
          <div ref={panel} role="dialog" aria-modal="true">
            <button id="make" onClick={() => { setName('아침 트렌드 조사'); setMade(true); }}>만들기</button>
            {made && <input id="agent-name" value={name} onChange={(e) => setName(e.target.value)} />}
          </div>
        </div>
      );
    }
    await act(async () => root.render(<Steps />));
    await act(async () => element<HTMLButtonElement>('#make').click()); // the server's draft fills the next step's field
    await act(async () => element('.modal-backdrop').click());
    expect(close).toHaveBeenCalledOnce();
    await act(async () => {
      const field = element<HTMLInputElement>('#agent-name');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, '아침 9시 트렌드 조사');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => element('.modal-backdrop').click());
    expect(close).toHaveBeenCalledOnce();
    expect(container.querySelector('.dialog-keep')).not.toBeNull();
  });

  it('the edit drawer\'s examples go after what is typed, its placeholder reads as an example, and a slip does not close it', async () => {
    const close = vi.fn();
    const ip = { ipId: 'ip_w', kind: 'character' as const, name: '꼬마 마법사', description: '', version: 1, createdAt: '' };
    await act(async () => root.render(<EditDrawer target={{ kind: 'ip', ip }} onClose={close} onSend={vi.fn(() => Promise.resolve())} />));
    const box = element<HTMLTextAreaElement>('textarea');
    expect(box.placeholder).toBe('예: 목에 빨간 스카프를 둘러줘'); // it read as text already typed
    const chips = [...container.querySelectorAll<HTMLButtonElement>('.chip-btn')];
    await act(async () => chips[0].click());
    expect(box.value).toBe('목에 빨간 스카프를 둘러줘');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, '모자에 깃털을 달아줘 ');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => chips[1].click());
    expect(box.value).toBe('모자에 깃털을 달아줘\n머리를 은발로 바꿔줘'); // the chip replaced what was typed
    await act(async () => element('.drawer-backdrop').click());
    expect(close).not.toHaveBeenCalled();
    expect(container.querySelector('.dialog-keep')).not.toBeNull();
  });

  // The trap must list an iframe (the game in 크게 보기), and the focus needs a home when the opener is gone.
  it('counts a frame and a summary as stops, and gives the focus to the page\'s main part when the opener is gone', async () => {
    const main = document.createElement('main');
    main.id = 'main';
    main.tabIndex = -1;
    document.body.append(main);
    await act(async () => root.render(
      <Panel onClose={vi.fn()}>
        <button id="first">닫기</button>
        <iframe id="game" title="게임" />
        <details><summary id="more">자세히</summary><p>x</p></details>
      </Panel>,
    ));
    await key(element('#first'), 'Tab', true); // back from the first stop: the last one is the summary
    expect(document.activeElement).toBe(element('#more'));
    await key(element('#more'), 'Tab');
    expect(document.activeElement).toBe(element('#first'));
    element('#game').focus();
    expect(document.activeElement).toBe(element('#game')); // the trap leaves the focus in the frame
    opener.remove(); // the card that opened the dialog was drawn again
    await act(async () => root.render(null));
    expect(document.activeElement).toBe(main);
    main.remove();
  });

  // A confirm must not open with the focus on the button that pays or deletes: the Enter or Space still down from the
  // press that opened it would confirm.
  it('a confirm opens with the focus on 취소: the key that is still down cancels, it does not pay or delete', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const pressed = () => { // Enter or Space on the focused button, as the browser turns it into a click
      const at = document.activeElement as HTMLElement;
      act(() => at.click());
      return at.textContent;
    };
    for (const danger of [true, false]) { // a delete, and a paid start
      await act(async () => root.render(<ConfirmDialog title="게시를 내릴까요?" message="…" confirmLabel="게시 내리기" danger={danger}
        onConfirm={onConfirm} onCancel={onCancel} />));
      const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
      expect([...dialog.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['취소', '게시 내리기']);
      expect(pressed()).toBe('취소');
      await act(async () => root.render(null));
    }
    expect([onCancel.mock.calls.length, onConfirm.mock.calls.length]).toEqual([2, 0]);
    // the confirm button is one Tab away, and Shift+Tab wraps back to it
    await act(async () => root.render(<ConfirmDialog title="t" message="m" confirmLabel="삭제" danger onConfirm={onConfirm} onCancel={onCancel} />));
    await key(document.activeElement as HTMLElement, 'Tab', true);
    expect(document.activeElement!.textContent).toBe('삭제');
  });

  // A toast is drawn on top of an open dialog: its link, button and × must be reachable from the keyboard.
  it('a toast\'s buttons are stops of the open dialog\'s Tab round, after the dialog\'s own', async () => {
    const onDismiss = vi.fn();
    const onOpen = vi.fn();
    const page = (toasts: Parameters<typeof Toasts>[0]['toasts']) => act(async () => root.render(
      <>
        <Panel onClose={vi.fn()}>
          <button id="first">첫 항목</button>
          <button id="last">마지막 항목</button>
        </Panel>
        <Toasts toasts={toasts} onDismiss={onDismiss} onAction={vi.fn()} onOpen={onOpen} />
      </>));
    await page([{ id: 1, level: 'error', text: '등불 이미지 실패: 시간 초과', open: 'pipeline' }]);
    const link = () => element<HTMLButtonElement>('.toast-open');
    const closeToast = () => element<HTMLButtonElement>('.toast-close');
    expect(document.activeElement).toBe(element('#first'));
    element('#last').focus();
    await key(element('#last'), 'Tab');
    expect(document.activeElement).toBe(link()); // from the dialog's last stop to the toast's first
    closeToast().focus(); // the browser's own Tab inside the stack: the trap leaves the focus there
    expect(document.activeElement).toBe(closeToast());
    await key(closeToast(), 'Tab');
    expect(document.activeElement).toBe(element('#first')); // and round again
    await key(element('#first'), 'Tab', true);
    expect(document.activeElement).toBe(closeToast()); // backwards: the round's last stop
    link().focus();
    await key(link(), 'Tab', true);
    expect(document.activeElement).toBe(element('#last'));
    // the link works from there, and the round is the dialog's alone once the toast is gone
    link().focus();
    await act(async () => link().click());
    expect([onOpen.mock.calls, onDismiss.mock.calls]).toEqual([[['pipeline']], [[1]]]);
    await page([]);
    element('#last').focus();
    await key(element('#last'), 'Tab');
    expect(document.activeElement).toBe(element('#first'));
    // what is behind the dialog stays out of reach
    opener.focus();
    expect(document.activeElement).not.toBe(opener);
  });

  it('lets only the upper dialog handle Escape and returns focus to its parent', async () => {
    const closeOuter = vi.fn();
    const closeInner = vi.fn();
    function Nested() {
      const [inner, setInner] = useState(false);
      return <Panel onClose={closeOuter}>
        <button id="open-inner" onClick={() => setInner(true)}>안쪽 열기</button>
        <button id="outer-last">바깥 마지막</button>
        {inner && <Panel onClose={() => { closeInner(); setInner(false); }}>
          <button id="inner-first">안쪽 항목</button>
        </Panel>}
      </Panel>;
    }
    await act(async () => root.render(<Nested />));
    expect(document.activeElement).toBe(element('#open-inner'));
    await act(async () => element<HTMLButtonElement>('#open-inner').click());
    expect(document.activeElement).toBe(element('#inner-first'));
    await key(element('#inner-first'), 'Escape');
    expect(closeInner).toHaveBeenCalledOnce();
    expect(closeOuter).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(element('#open-inner'));
    await key(element('#open-inner'), 'Tab', true);
    expect(document.activeElement).toBe(element('#outer-last'));
    await key(element('#outer-last'), 'Escape');
    expect(closeOuter).toHaveBeenCalledOnce();
  });
});
