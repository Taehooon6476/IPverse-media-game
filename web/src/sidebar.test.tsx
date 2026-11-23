import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connections } from './api';
import { Sidebar } from './components/Sidebar';
import type { SessionSummary } from './types';

const sessions: SessionSummary[] = Array.from({ length: 12 }, (_, i) => ({
  sessionId: `ses_${i}`, title: `세션 ${i}`, genre: 'sf-shooter', createdAt: '2026-11-04T10:00:00Z' }));
const connections = (status: 'connected' | 'error' = 'connected'): Connections => ({ servers: [], platform: [
  { id: 'imagegen', name: '이미지 생성 MCP', status: 'connected', toolCount: 4 },
  { id: 'videogen', name: '영상 생성 MCP', status, toolCount: 17 },
  { id: 'bedrock', name: 'Amazon Bedrock', status: 'connected', kind: 'aws' }] });

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
  vi.restoreAllMocks();
});

const render = (conns: Connections | null, onSkills?: () => void, agentCount?: number) => act(async () => root.render(
  <Sidebar sessions={sessions} currentId="ses_0" open={false} onClose={vi.fn()} onSelect={vi.fn()} onCreate={vi.fn()} onPublish={vi.fn()}
    onLogout={vi.fn()} connections={conns} onConnections={vi.fn()} onSkills={onSkills}
    agents={agentCount ? <p className="agent-slot">Agent 목록</p> : undefined} agentCount={agentCount} />));

describe('sidebar: 스킬 and Agent 등록 fold into one accordion so the sessions keep the room', () => {
  it('starts closed with the skills count, keeps 새 세션 and the sessions out of it, opens and remembers it', async () => {
    const onSkills = vi.fn();
    await render(connections(), onSkills);
    const head = container.querySelector<HTMLButtonElement>('#work-acc-head')!;
    const region = container.querySelector<HTMLElement>('#work-acc-region')!;
    expect([head.getAttribute('aria-expanded'), head.getAttribute('aria-controls'), region.getAttribute('aria-labelledby')])
      .toEqual(['false', 'work-acc-region', 'work-acc-head']);
    expect(head.classList.contains('side-fold-head')).toBe(true);
    expect(head.textContent).toBe('스킬 · 에이전트04'); // 에이전트: one word for a scheduled job
    expect(region.hasAttribute('inert')).toBe(true);
    expect(region.textContent).not.toContain('IP 워크스페이스'); // the workspace marker gave its place to the agents
    // no section labels; 새 세션 and the session list stay outside every fold
    expect([...container.querySelectorAll('.side-label')].map((p) => p.textContent)).toEqual(['최근 세션12']);
    expect(container.querySelector('.new-session')!.closest('.fold')).toBeNull();
    expect(container.querySelector('.session-list')!.closest('.fold')).toBeNull();
    expect(container.querySelectorAll('.session-list li')).toHaveLength(12);

    await act(async () => head.click());
    expect(head.getAttribute('aria-expanded')).toBe('true');
    expect(region.hasAttribute('inert')).toBe(false);
    expect(localStorage.getItem('ipverse.workOpen')).toBe('1');
    const skills = region.querySelector<HTMLButtonElement>('.side-nav--skills')!;
    expect(skills.textContent).toBe('장르 스킬');
    await act(async () => skills.click());
    expect(onSkills).toHaveBeenCalledOnce();

    await act(async () => root.unmount());
    root = createRoot(container);
    await render(connections(), onSkills);
    expect(container.querySelector('#work-acc-head')!.getAttribute('aria-expanded')).toBe('true');
  });

  it('counts the skills and the agents, and puts the Agent part under 장르 스킬', async () => {
    await render(connections(), vi.fn(), 2);
    expect(container.querySelector('#work-acc-head')!.textContent).toBe('스킬 · 에이전트06');
    const region = container.querySelector('#work-acc-region .work-fold')!;
    expect([...region.children].map((c) => c.textContent)).toEqual(['장르 스킬', 'Agent 목록']);
  });

  it('keeps 장르 스킬 disabled until a session is open', async () => {
    await render(connections());
    const skills = container.querySelector<HTMLButtonElement>('#work-acc-region .side-nav--skills')!;
    expect(skills.disabled).toBe(true);
    expect(skills.title).toBe('세션을 먼저 고르세요');
  });

  it('the tablet drawer focus trap wraps at the last reachable control, not at a folded row', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }));
    // jsdom has no layout: everything gets a box except the phone-only foot, as in the 768-1024px drawer
    vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) {
      return { length: this.closest('.mobile-only') ? 0 : 1 } as DOMRectList;
    });
    await act(async () => root.render(
      <Sidebar sessions={[]} currentId={null} open onClose={vi.fn()} onSelect={vi.fn()} onCreate={vi.fn()} onPublish={vi.fn()}
        onLogout={vi.fn()} connections={connections()} onConnections={vi.fn()} />));
    const first = container.querySelector<HTMLButtonElement>('.new-session')!;
    expect(document.activeElement).toBe(first);
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })); });
    expect(document.activeElement).toBe(container.querySelector('#conn-acc-head')); // both folds are closed
  });
});

describe('sidebar: the connection list is an accordion so the sessions keep the room', () => {
  it('starts closed with the count in the header, opens on click and remembers it', async () => {
    await render(connections());
    const head = container.querySelector<HTMLButtonElement>('#conn-acc-head')!;
    const region = container.querySelector<HTMLElement>('#conn-acc-region')!;
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(head.getAttribute('aria-controls')).toBe('conn-acc-region');
    expect(region.getAttribute('aria-labelledby')).toBe('conn-acc-head');
    expect(region.hasAttribute('inert')).toBe(true); // folded rows are not reachable by Tab
    expect(head.textContent).toContain('3/3');
    expect(container.querySelectorAll('.session-list li')).toHaveLength(12);

    await act(async () => head.click());
    expect(head.getAttribute('aria-expanded')).toBe('true');
    expect(region.hasAttribute('data-open')).toBe(true);
    expect(region.hasAttribute('inert')).toBe(false);
    expect(region.querySelectorAll('.conn-mini-row')).toHaveLength(3);
    expect(localStorage.getItem('ipverse.connOpen')).toBe('1');

    await act(async () => root.unmount());
    root = createRoot(container);
    await render(connections());
    expect(container.querySelector('#conn-acc-head')!.getAttribute('aria-expanded')).toBe('true');
  });

  // The fold shows its rows by what they do, as the 연결 설정 drawer it opens: no provider names, tool counts or "AWS".
  it('names the studio\'s services as the 연결 설정 drawer does, and a server the user added by its own name', async () => {
    localStorage.setItem('ipverse.connOpen', '1');
    await render({ platform: [ // as the server sends them
      { id: 'imagegen', kind: 'mcp', name: '이미지 생성 MCP', status: 'connected', toolCount: 4 },
      { id: 'videogen', kind: 'mcp', name: '영상 생성 MCP', status: 'connected', toolCount: 20 },
      { id: 'bedrock-agent', kind: 'aws', name: 'Amazon Bedrock · 에이전트', status: 'connected' },
      { id: 'bedrock-pegasus', kind: 'aws', name: 'Amazon Bedrock · Pegasus 1.5', status: 'connected' },
      { id: 'deadline', kind: 'aws', name: 'AWS Deadline Cloud', status: 'connected' },
      { id: 'live', kind: 'aws', name: 'Amazon IVS 라이브 · 광고', status: 'error' },
    ], servers: [{ id: 'mcp_notes', name: '내 노트 MCP', status: 'connected', enabled: true, toolCount: 3 }] });
    const rows = [...container.querySelectorAll<HTMLButtonElement>('.conn-mini-row')];
    expect(rows.map((r) => [r.querySelector('.conn-mini-name')!.textContent, r.querySelector('.conn-mini-meta')!.textContent, r.title])).toEqual([
      ['이미지 생성', '', '이미지 생성 · 연결됨'], ['영상 생성', '', '영상 생성 · 연결됨'], ['채팅 AI', '', '채팅 AI · 연결됨'],
      ['라이브 하이라이트', '', '라이브 하이라이트 · 연결됨'], ['3D 렌더', '', '3D 렌더 · 연결됨'], ['라이브 방송 · 광고', '', '라이브 방송 · 광고 · 연결 실패'],
      ['내 노트 MCP', '3', '내 노트 MCP · 연결됨 · 도구 3개']]);
    expect(container.querySelector('.conn-mini')!.outerHTML).not.toMatch(/Amazon|AWS|Bedrock|IVS|Deadline|Pegasus|생성 MCP/); // nor in an attribute
  });

  it('keeps a failing connection visible while closed', async () => {
    await render(connections('error'));
    const head = container.querySelector('#conn-acc-head')!;
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(head.textContent).toContain('오류 1 · 2/3');
    expect(head.querySelector('.conn-dot--error')).not.toBeNull();
  });
});

// With both folds open the session list must not be the one part of the column that shrinks: the column scrolls as one.
describe('sidebar: the folds and the session list scroll as one (R20-37)', () => {
  it('puts both folds, the label and the list in one scroller; 새 세션 and the phone foot stay outside it', async () => {
    await render(connections());
    const scroller = container.querySelector('.side-scroll')!;
    expect([...scroller.children].map((c) => c.className.split(' ')[0])).toEqual(['fold', 'fold', 'side-label', 'session-find', 'session-list']);
    expect(scroller.parentElement!.tagName).toBe('NAV');
    expect(container.querySelector('.new-session')!.closest('.side-scroll')).toBeNull();
    expect(container.querySelector('.sidebar-foot')!.closest('.side-scroll')).toBeNull();
  });
});

// Many sessions in one flat list: a find box, no default-genre stamp on a row, and a bin not only under the pointer.
describe('sidebar: a long session list is found by name, and a row carries no genre stamp (R20-49)', () => {
  const named: SessionSummary[] = ['달빛 온실', '네온 골목', '숲속 기사 모모', '우주 고양이 루나', 'R18 검증', 'R17 검증', '사막 유적', '바다 등대', '숲의 궁수']
    .map((title, i) => ({ sessionId: `ses_n${i}`, title, genre: 'sf-shooter', createdAt: '2026-11-04T10:00:00Z' }));
  const show = (list: SessionSummary[] | null, extra: object = {}) => act(async () => root.render(
    <Sidebar sessions={list} currentId={null} open={false} onClose={vi.fn()} onSelect={vi.fn()} onCreate={vi.fn()} onPublish={vi.fn()}
      onLogout={vi.fn()} connections={null} onConnections={vi.fn()} onDelete={vi.fn()} {...extra} />));
  const titles = () => [...container.querySelectorAll('.session-list .session-title')].map((t) => t.textContent);
  const type = (el: HTMLInputElement, text: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });

  it('shows the find box from 9 sessions, filters by name as it is typed, and says when nothing matches', async () => {
    await show(named.slice(0, 8));
    expect(container.querySelector('#session-find')).toBeNull();
    await show(named);
    const find = container.querySelector<HTMLInputElement>('#session-find')!;
    expect([find.type, find.placeholder, container.querySelector('label[for="session-find"]')!.textContent]).toEqual(['search', '세션 이름으로 찾기', '세션 이름으로 찾기']);
    await type(find, ' 숲');
    expect(titles()).toEqual(['숲속 기사 모모', '숲의 궁수']);
    expect(container.querySelector('.side-label')!.textContent).toBe('최근 세션2/9');
    await type(find, 'r1'); // letter case does not matter
    expect(titles()).toEqual(['R18 검증', 'R17 검증']);
    await type(find, '용');
    expect(titles()).toEqual([]);
    expect(container.querySelector('p.sidebar-empty')!.textContent).toBe('‘용’이(가) 들어간 세션이 없어요.');
    await type(find, '');
    expect(titles()).toHaveLength(9);
  });

  // The server takes PATCH {title} for any session of the account, so a row of the list can be renamed too.
  it('a row\'s name is changed in place: ✎, a field of 60 characters with a count, Enter saves, Esc leaves it', async () => {
    const onRename = vi.fn(async () => undefined);
    await show(named.slice(0, 3), { onRename });
    const row = () => container.querySelectorAll<HTMLElement>('.session-row')[1];
    const pencil = () => row().querySelector<HTMLButtonElement>('.session-rename')!;
    const field = () => row().querySelector<HTMLInputElement>('.session-rename-form input');
    const submit = () => act(async () => { row().querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect([pencil().getAttribute('aria-label'), pencil().title]).toEqual(['네온 골목 이름 바꾸기', '이름 바꾸기']);
    await act(async () => pencil().click());
    expect([field()!.value, field()!.maxLength, document.activeElement === field(), row().querySelector('a.session')]).toEqual(['네온 골목', 60, true, null]);
    expect(row().querySelector('label')!.textContent).toBe('세션 이름');
    await type(field()!, '네온 골목 2막');
    expect(row().querySelector('.session-rename-count')!.textContent).toBe('8/60');
    await act(async () => { field()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect([field(), row().querySelector('.session-title')!.textContent, document.activeElement === pencil()]).toEqual([null, '네온 골목', true]);
    expect(onRename).not.toHaveBeenCalled();

    await act(async () => pencil().click());
    await type(field()!, '  네온 골목 2막  ');
    await submit();
    expect(onRename).toHaveBeenCalledExactlyOnceWith('ses_n1', '네온 골목 2막');
    expect([field(), document.activeElement === pencil()]).toEqual([null, true]);
    // the same name again asks nothing of the server
    await act(async () => pencil().click());
    await submit();
    expect([onRename.mock.calls.length, field()]).toEqual([1, null]);
  });

  it('a name the server refuses stays in the field with the reason; without a way to rename there is no ✎', async () => {
    const onRename = vi.fn(async () => { throw new Error('세션 제목을 적어 주세요.'); });
    await show(named.slice(0, 3), { onRename });
    const row = container.querySelectorAll<HTMLElement>('.session-row')[0];
    await act(async () => row.querySelector<HTMLButtonElement>('.session-rename')!.click());
    await type(row.querySelector<HTMLInputElement>('.session-rename-form input')!, '온실');
    await act(async () => { row.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(row.querySelector('.form-error[role="alert"]')!.textContent).toBe('세션 제목을 적어 주세요.');
    expect(row.querySelector<HTMLInputElement>('.session-rename-form input')!.value).toBe('온실');
    await show(named.slice(0, 3));
    expect(container.querySelector('.session-rename')).toBeNull();
  });

  it('a row says when the session was made, and no genre', async () => {
    await show(named.slice(0, 2));
    const meta = [...container.querySelectorAll('.session-meta')].map((m) => m.textContent!);
    expect(meta).toHaveLength(2);
    expect(meta.every((m) => /\d/.test(m) && !/슈터|서바이벌|RPG/.test(m))).toBe(true);
  });

  it('tells loading, empty and failed apart (R20-43)', async () => {
    await show(null);
    expect(container.querySelector('.session-loading [role="status"]')!.textContent).toBe('세션 목록을 불러오고 있어요.');
    expect([container.querySelector('p.sidebar-empty'), container.querySelector('.side-label')!.textContent]).toEqual([null, '최근 세션–']);
    const onRetrySessions = vi.fn();
    await show(null, { sessionsError: '서버에 연결하지 못했어요.', onRetrySessions });
    expect(container.querySelector('.session-loading')).toBeNull();
    expect(container.querySelector('.load-error[role="alert"]')!.textContent).toContain('세션 목록을 불러오지 못했어요. 서버에 연결하지 못했어요.');
    await act(async () => container.querySelector<HTMLButtonElement>('.load-error button')!.click());
    expect(onRetrySessions).toHaveBeenCalledOnce();
    await show([]);
    expect(container.querySelector('p.sidebar-empty')!.textContent).toBe('아직 세션이 없어요. 위의 ‘새 세션’으로 시작해 보세요.');
  });

  it('the phone drawer says who is signed in above 로그아웃 (R20-40: phones have no account menu)', async () => {
    await show(named.slice(0, 1), { account: { user: null, demo: true } });
    expect(container.querySelector('.sidebar-foot .sidebar-who')!.textContent).toBe('공용 데모 계정으로 로그인 중');
    await show(named.slice(0, 1), { account: { user: 'luna', demo: false } });
    expect(container.querySelector('.sidebar-foot .sidebar-who')!.textContent).toBe('luna 님으로 로그인 중');
  });
});
