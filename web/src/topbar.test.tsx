import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TopBar } from './components/TopBar';
import type { Job, Session } from './types';

const session: Session = { sessionId: 'ses_0', title: '우주 고양이 탐험가 루나', genre: 'sf-shooter', createdAt: '2026-11-04T10:00:00Z' };

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => { f(0); return 0; });
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
const render = (handlers: { onPublish?: () => void; onLogout?: () => void; onConnections?: () => void }) => act(async () => root.render(
  <TopBar session={session} activeJobs={[]} onCancelJob={vi.fn()} navOpen={false} onMenu={vi.fn()} onPublish={handlers.onPublish ?? vi.fn()}
    onLogout={handlers.onLogout ?? vi.fn()} onConnections={handlers.onConnections ?? vi.fn()} />));

describe('top bar: 게시하기 stays visible, the account actions sit in one menu', () => {
  it('shows 게시하기 and a 계정 trigger instead of a bare 로그아웃 button', async () => {
    const onPublish = vi.fn();
    await render({ onPublish });
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('.topbar-actions button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['게시하기', '계정']);
    const trigger = buttons[1];
    expect([trigger.getAttribute('aria-haspopup'), trigger.getAttribute('aria-expanded')]).toEqual(['menu', 'false']);
    expect(trigger.querySelector('svg')).not.toBeNull(); // the chevron
    await act(async () => buttons[0].click());
    expect(onPublish).toHaveBeenCalledOnce();
  });

  it('opens 연결 설정 and 로그아웃 from the menu with the same handlers', async () => {
    const onLogout = vi.fn();
    const onConnections = vi.fn();
    await render({ onLogout, onConnections });
    const trigger = container.querySelector<HTMLButtonElement>('.topbar-actions [aria-haspopup="menu"]')!;
    await act(async () => trigger.click());
    const items = () => [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items().map((i) => i.textContent)).toEqual(['연결 설정', '로그아웃']);
    await act(async () => items()[0].click());
    expect(onConnections).toHaveBeenCalledOnce();
    expect(onLogout).not.toHaveBeenCalled();
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger); // the drawer that opens next returns focus here

    await act(async () => trigger.click());
    await act(async () => items()[1].click());
    expect(onLogout).toHaveBeenCalledOnce();
  });

  it('lists a chained restyle with its own wait in the 작업 popover, not the usual 보통 5–10분 (round 5 N4)', async () => {
    const at = '2026-11-06T12:12:39Z';
    const job = (jobId: string, progress: string): Job => ({ jobId, kind: 'shot', provider: 'mediagen_video', status: 'running',
      input: {}, outputs: [], deps: [], progress, createdAt: at, updatedAt: at });
    await act(async () => root.render(
      <TopBar session={session} activeJobs={[{ job: job('job_ab2bafce38', 'denoising (조각 0/2 완료) · 조각마다 ~6분, 전체 보통 ~14분') },
        { job: job('job_2', 'denoising 40%'), name: '아리' }]} onCancelJob={vi.fn()} navOpen={false} onMenu={vi.fn()}
        onPublish={vi.fn()} onLogout={vi.fn()} onConnections={vi.fn()} />));
    await act(async () => container.querySelector<HTMLButtonElement>('.jobs-menu-btn')!.click());
    // the whole line wraps in the popover (origin.css), so the total is never cut off at the panel's edge
    expect([...container.querySelectorAll('#jobs-menu-panel .jobs-menu-state')].map((s) => s.textContent)).toEqual([
      '진행 중 · 영상 생성 중 (조각 0/2 완료) · 조각마다 ~6분, 전체 보통 ~14분', '진행 중 · 영상 생성 중 40% · 보통 5–7분']); // the box's English in Korean
  });

  // the shared demo account must not look like one's own
  it('names who is signed in on the trigger and as the menu\'s first line, which does nothing when pressed', async () => {
    const onLogout = vi.fn();
    await act(async () => root.render(
      <TopBar session={session} activeJobs={[]} onCancelJob={vi.fn()} navOpen={false} onMenu={vi.fn()} onPublish={vi.fn()} onLogout={onLogout}
        onConnections={vi.fn()} account={{ user: 'luna_studio', demo: false }} />));
    const trigger = container.querySelector<HTMLButtonElement>('.topbar-account')!;
    expect([trigger.textContent, trigger.getAttribute('aria-label')]).toEqual(['luna_studio', '계정: luna_studio']);
    await act(async () => trigger.click());
    const items = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.map((i) => i.textContent)).toEqual(['luna_studio 님으로 로그인 중', '연결 설정', '로그아웃']);
    expect(items[0].getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(items[1]); // the first thing that can be done
    await act(async () => items[0].click());
    expect(onLogout).not.toHaveBeenCalled();
  });

  // 자동 저장됨 must not stay through an outage
  it('says 연결 끊김 in place of 자동 저장됨 while the session does not answer, and keeps the running jobs beside it', async () => {
    const at = '2026-11-06T12:12:39Z';
    const job: Job = { jobId: 'job_1', kind: 'image', provider: 'mediagen_image', status: 'running', input: {}, outputs: [], deps: [], progress: '', createdAt: at, updatedAt: at };
    const show = (offline: boolean, jobs: Job[]) => act(async () => root.render(
      <TopBar session={session} activeJobs={jobs.map((j) => ({ job: j }))} onCancelJob={vi.fn()} navOpen={false} onMenu={vi.fn()} onPublish={vi.fn()}
        onLogout={vi.fn()} onConnections={vi.fn()} offline={offline} />));
    const pills = () => [...container.querySelectorAll('.topbar-jobs .status-pill')].map((p) => p.textContent);
    await show(false, []);
    expect(pills()).toEqual(['자동 저장됨']);
    await show(true, []);
    expect(pills()).toEqual(['연결 끊김 · 다시 연결 중']);
    expect(container.querySelector('.status-pill.is-offline')!.getAttribute('role')).toBe('status');
    await show(true, [job]);
    expect(pills()).toEqual(['연결 끊김 · 다시 연결 중', '작업 1건']);
  });

  it('the first crumb goes back to the start screen, and a second skip link reaches the chat box (R20-52)', async () => {
    const onHome = vi.fn();
    await act(async () => root.render(
      <TopBar session={session} activeJobs={[]} onCancelJob={vi.fn()} navOpen={false} onMenu={vi.fn()} onPublish={vi.fn()} onLogout={vi.fn()}
        onConnections={vi.fn()} onHome={onHome} chat />));
    const home = container.querySelector<HTMLAnchorElement>('.breadcrumb-home')!;
    expect(home.textContent).toBe('작업 공간'); // one word for the studio
    await act(async () => home.click());
    expect(onHome).toHaveBeenCalledOnce();
    expect([...container.querySelectorAll('.skip-link')].map((a) => a.textContent)).toEqual(['작업 공간으로 바로 가기', '채팅 입력으로 바로 가기']);
    const box = document.createElement('textarea');
    box.id = 'composer';
    document.body.append(box);
    await act(async () => container.querySelectorAll<HTMLAnchorElement>('.skip-link')[1].click());
    expect(document.activeElement).toBe(box);
    box.remove();
    // with no session open: no way back to offer, and no chat to skip to
    await act(async () => root.render(
      <TopBar session={null} activeJobs={[]} onCancelJob={vi.fn()} navOpen={false} onMenu={vi.fn()} onPublish={vi.fn()} onLogout={vi.fn()}
        onConnections={vi.fn()} onHome={onHome} />));
    expect([container.querySelector('.breadcrumb-home'), container.querySelector('.topbar-title')!.textContent, container.querySelectorAll('.skip-link').length])
      .toEqual([null, '시작', 1]);
  });

  it('opens from the keyboard and Esc closes it with focus back on the trigger', async () => {
    await render({});
    const trigger = container.querySelector<HTMLButtonElement>('.topbar-actions [aria-haspopup="menu"]')!;
    trigger.focus();
    await key(trigger, 'ArrowDown');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const menu = document.body.querySelector('[role="menu"]')!;
    const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(document.activeElement).toBe(items[0]);
    await key(menu, 'ArrowDown');
    expect(document.activeElement).toBe(items[1]);
    await key(menu, 'Escape');
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
