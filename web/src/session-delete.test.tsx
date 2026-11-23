import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { Sidebar } from './components/Sidebar';
import type { SessionSummary } from './types';

const sessions: SessionSummary[] = [
  { sessionId: 'ses_a', title: '우주 고양이 루나', genre: 'sf-shooter', createdAt: '2026-11-04T10:00:00Z' },
  { sessionId: 'ses_b', title: '숲의 기사', genre: 'rpg-quest', createdAt: '2026-11-03T10:00:00Z' },
];

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
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

const render = (onDelete: (id: string) => Promise<void>, list = sessions) => act(async () => root.render(
  <Sidebar sessions={list} currentId="ses_a" open={false} onClose={vi.fn()} onSelect={vi.fn()} onCreate={vi.fn()} onPublish={vi.fn()}
    onLogout={vi.fn()} connections={null} onConnections={vi.fn()} onDelete={onDelete} />));
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const dialog = () => $('[role="alertdialog"]');
const button = (text: string) => [...dialog()!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text)!;
const delButton = (title: string) => $<HTMLButtonElement>(`.session-list button[aria-label="${title} 세션 삭제"]`)!;

describe('최근 세션: each row has a delete action behind a confirm dialog', () => {
  it('gives every row a labelled, focusable delete button that does not open the session', async () => {
    await render(vi.fn());
    const rows = [...container.querySelectorAll('.session-list li')];
    expect(rows.map((li) => li.querySelector('button')?.getAttribute('aria-label'))).toEqual(['우주 고양이 루나 세션 삭제', '숲의 기사 세션 삭제']);
    expect(delButton('숲의 기사').tabIndex).toBe(0);
    expect(delButton('숲의 기사').closest('a')).toBeNull(); // not nested in the link
    expect(dialog()).toBeNull();
  });

  it('asks in Korean with the title and the warning, focuses 취소, and 취소 or Esc leaves the session alone', async () => {
    const onDelete = vi.fn(() => Promise.resolve());
    await render(onDelete);
    const opener = delButton('숲의 기사');
    opener.focus();
    await act(async () => opener.click());
    const d = dialog()!;
    expect(d.getAttribute('aria-modal')).toBe('true');
    expect(d.querySelector(`#${d.getAttribute('aria-labelledby')}`)!.textContent).toBe('세션 삭제');
    const text = d.querySelector(`#${d.getAttribute('aria-describedby')}`)!.textContent!;
    expect(text).toContain('숲의 기사');
    expect(text).toContain('IP, 영상, 게임이 모두 삭제');
    expect(text).toContain('되돌릴 수 없어요');
    expect([...d.querySelectorAll('.dialog-actions button')].map((b) => b.textContent)).toEqual(['취소', '삭제']);
    expect(document.activeElement).toBe(button('취소'));

    await act(async () => button('취소').click());
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);

    await act(async () => opener.click());
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(dialog()).toBeNull();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('deletes on 삭제 and closes', async () => {
    let finish!: () => void;
    const onDelete = vi.fn(() => new Promise<void>((r) => { finish = r; }));
    await render(onDelete);
    await act(async () => delButton('숲의 기사').click());
    await act(async () => button('삭제').click());
    expect(onDelete).toHaveBeenCalledWith('ses_b');
    expect(button('지우는 중…').disabled).toBe(true);
    await act(async () => finish());
    expect(dialog()).toBeNull();
  });

  it('keeps the dialog open with the reason when the server refuses (409)', async () => {
    const reason = '진행 중인 작업 2건이 있어 지울 수 없어요. 작업 현황에서 중지하거나 끝난 뒤 다시 시도해 주세요.';
    const onDelete = vi.fn(() => Promise.reject(new ApiError(409, reason)));
    await render(onDelete);
    await act(async () => delButton('우주 고양이 루나').click());
    await act(async () => button('삭제').click());
    const alert = dialog()!.querySelector('[role="alert"]')!;
    expect(alert.textContent).toBe(reason);
    expect(button('삭제').disabled).toBe(false); // can try again after stopping the jobs
  });
});

// A delete removes every game folder of the session (server/store.py delete_session), so shared addresses stop working:
// the dialog says it for every session, as the list does not know which sessions have a published game.
describe('R20-32 the delete dialog says what happens to shared game addresses', () => {
  it('says that an address shared by publishing stops opening, in the sentence before the buttons', async () => {
    await render(vi.fn(() => Promise.resolve()));
    await act(async () => delButton('숲의 기사').click());
    const d = dialog()!;
    expect(d.querySelector(`#${d.getAttribute('aria-describedby')}`)!.textContent)
      .toBe('숲의 기사 세션을 지울까요? 이 세션의 IP, 영상, 게임이 모두 삭제되며 되돌릴 수 없어요. 게시해서 공유한 게임 주소도 더 이상 열리지 않아요.');
  });
});
