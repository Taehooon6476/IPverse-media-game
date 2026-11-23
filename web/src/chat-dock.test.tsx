// The chat dock: its size per window width, what the user sets and keeps, and the 작업 기록 lines.
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatDock, userText } from './components/ChatDock';
import { briefMessage } from './components/DesignDrawer';
import { openTab } from './components/Tabs';
import { TopBar } from './components/TopBar';
import type { Message } from './types';

// the window: phone (the chat is a drawer), a tablet held upright (the dock under the panes), wide (from 900 px: a column beside them)
let narrow = false;
let wide = false;
const listeners = new Set<() => void>();
const media = (query: string) => ({
  get matches() { return query.includes('max-width: 767') ? narrow : query.includes('min-width: 900') ? wide : false; },
  addEventListener: (_: string, f: () => void) => listeners.add(f),
  removeEventListener: (_: string, f: () => void) => listeners.delete(f),
});
const resize = (toNarrow: boolean) => act(async () => { narrow = toNarrow; listeners.forEach((f) => f()); });
const windowSize = (width: number, height: number) => act(async () => {
  vi.stubGlobal('innerWidth', width);
  vi.stubGlobal('innerHeight', height);
  wide = width >= 900;
  narrow = width <= 767;
  listeners.forEach((f) => f());
  window.dispatchEvent(new Event('resize'));
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', media);
  vi.stubGlobal('innerWidth', 820);
  vi.stubGlobal('innerHeight', 768);
  narrow = false;
  wide = false;
  listeners.clear();
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

const render = (messages: Message[] = []) => act(async () => root.render(
  <ChatDock messages={messages} draft="" onDraft={vi.fn()} onSend={vi.fn()} disabled={false} />));
const dockH = () => document.documentElement.style.getPropertyValue('--dock-h');
const chatW = () => document.documentElement.style.getPropertyValue('--chat-w');
const handle = () => container.querySelector<HTMLElement>('.chat-resize')!;
const key = (el: Element, k: string) => act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); });
const reload = async () => {
  await act(async () => root.unmount());
  root = createRoot(container);
  await render();
};

// Under the panes the chat leaves too little height for the cards and the log on a laptop window.
describe('R20-12: from 900 px the chat is a column beside the panes; the sizes the user sets are kept', () => {
  it('stands beside the panes at 1366x768: its width follows the window and no row is taken under them', async () => {
    await windowSize(1366, 768);
    await render();
    expect(container.querySelector('.chat')!.classList.contains('chat--side')).toBe(true);
    expect([chatW(), dockH()]).toEqual(['369px', '0px']); // 34% of the window less 95 px, between 340 and 420
    expect([handle().getAttribute('aria-orientation'), handle().getAttribute('aria-label'), handle().title])
      .toEqual(['vertical', '채팅창 너비', '드래그해서 채팅창 너비 조절']);
    await windowSize(1280, 720);
    expect(chatW()).toBe('340px'); // two 190 px cards a row still fit each pane
    await windowSize(1920, 1080);
    expect(chatW()).toBe('420px');
  });

  it('stands beside the panes from 900 px too: 320 px wide there, and no dock under them', async () => {
    await windowSize(1024, 768);
    await render();
    expect(container.querySelector('.chat')!.classList.contains('chat--side')).toBe(true);
    expect([chatW(), dockH()]).toEqual(['320px', '0px']);
    await windowSize(900, 768);
    expect([chatW(), dockH()]).toEqual(['320px', '0px']);
    await windowSize(1199, 768);
    expect(chatW()).toBe('320px');
    await windowSize(899, 768); // a tablet held upright: the dock under the panes
    expect(container.querySelector('.chat')!.classList.contains('chat--side')).toBe(false);
    expect([chatW(), dockH()]).toEqual(['', '276px']);
  });

  it('keeps the width the user set over a reload and a change of window, and leaves the height under the panes alone', async () => {
    localStorage.setItem('ipverse.dock', JSON.stringify({ h: 300, hidden: false }));
    await windowSize(1440, 900);
    await render();
    expect(chatW()).toBe('395px');
    await key(handle(), 'ArrowLeft'); // the left edge moves away from the chat: 24 px wider
    await key(handle(), 'ArrowLeft');
    expect(chatW()).toBe('443px');
    expect(JSON.parse(localStorage.getItem('ipverse.dock')!)).toEqual({ h: 300, w: 443, hidden: false });
    await reload();
    expect(chatW()).toBe('443px');
    await windowSize(1366, 768);
    expect(chatW()).toBe('443px');
    await windowSize(820, 1180); // under the panes again (a tablet held upright): the height dragged there earlier
    expect([chatW(), dockH()]).toEqual(['', '300px']);
    // a double click gives the width back to the window
    await windowSize(1440, 900);
    await act(async () => { handle().dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    expect(chatW()).toBe('395px');
    expect(JSON.parse(localStorage.getItem('ipverse.dock')!)).toEqual({ h: 300, hidden: false });
  });

  it('folds to a 44 px strip beside the panes and comes back at its width', async () => {
    await windowSize(1366, 768);
    await render();
    const toggle = container.querySelector<HTMLButtonElement>('.chat-toggle')!;
    expect([toggle.getAttribute('aria-label'), toggle.getAttribute('aria-expanded')]).toEqual(['채팅 접기', 'true']);
    await act(async () => toggle.click());
    expect(chatW()).toBe('44px');
    expect([toggle.getAttribute('aria-label'), toggle.getAttribute('aria-expanded')]).toEqual(['채팅 열기', 'false']);
    expect(container.querySelector<HTMLElement>('#chat-body')!.hidden).toBe(true);
    await reload();
    expect(chatW()).toBe('44px');
    await act(async () => container.querySelector<HTMLButtonElement>('.chat-toggle')!.click());
    expect(chatW()).toBe('369px');
  });

  it('under the panes (below 900 px) the dock is about a third of the window until the user drags it', async () => {
    await windowSize(820, 768);
    await render();
    expect(dockH()).toBe('276px'); // 36% of 768: the log shows 6 lines where 230 px showed 3
    expect([handle().getAttribute('aria-orientation'), handle().title]).toEqual(['horizontal', '드래그해서 채팅창 높이 조절']);
    await windowSize(820, 1000);
    expect(dockH()).toBe('340px'); // at most
    await key(handle(), 'ArrowDown');
    expect(dockH()).toBe('316px');
    await windowSize(820, 768);
    expect(dockH()).toBe('316px'); // set by the user: no longer the window's
    // a stored height equal to the old default (230) counts as not set: it follows the window too
    localStorage.setItem('ipverse.dock', JSON.stringify({ h: 230, hidden: false }));
    await reload();
    expect(dockH()).toBe('276px');
  });

  it('the message box comes before the model pickers and 보내기, as on screen', async () => {
    await render();
    const order = [...container.querySelectorAll('.composer textarea, .composer .dropdown-button, .composer button[type="submit"]')]
      .map((el) => el.id === 'composer' ? 'box' : el.getAttribute('type') === 'submit' ? '보내기' : 'model');
    expect(order).toEqual(['box', 'model', 'model', '보내기']);
  });

  it('gives the page its rows back when the chat goes away (the start screen has no dock)', async () => {
    await render();
    expect(dockH()).toBe('276px');
    await act(async () => root.unmount());
    expect([dockH(), chatW()]).toEqual(['', '']);
    root = createRoot(container);
  });
});

describe('M18: the dock comes back at its height when the window widens from phone width', () => {
  it('restores --dock-h from the saved height, and the toggle matches what shows', async () => {
    localStorage.setItem('ipverse.dock', JSON.stringify({ h: 300, hidden: false }));
    narrow = true;
    await render();
    expect(dockH()).toBe('40px'); // phones: only the bar, the chat is a drawer

    await resize(false);
    expect(dockH()).toBe('300px');
    const toggle = container.querySelector<HTMLButtonElement>('.chat-toggle')!;
    expect(toggle.textContent).toBe('▾ 채팅 숨기기');
    expect(container.querySelector<HTMLElement>('#chat-body')!.hidden).toBe(false);

    await resize(true);
    expect(dockH()).toBe('40px');
  });

  it('a hidden dock stays hidden after widening', async () => {
    localStorage.setItem('ipverse.dock', JSON.stringify({ h: 300, hidden: true }));
    narrow = true;
    await render();
    await resize(false);
    expect(dockH()).toBe('40px');
    expect(container.querySelector('.chat-toggle')!.textContent).toBe('▴ 채팅 열기');
  });
});

describe('M19: 작업 기록 shows short Korean, the raw detail only behind 자세히', () => {
  const message: Message = { messageId: 'm1', role: 'assistant', status: 'done', text: '만들었어요.', ts: '2026-11-07T10:00:00Z',
    toolEvents: [
      { tool: 'create_ip_asset', summary: '캐릭터 생성 실패: humanoid는 kind가 enemy일 때만 씁니다', ts: '' },
      { tool: 'create_ip_asset', summary: '캐릭터 생성: 노바', ts: '' },
      { tool: 'render_3d', summary: '3D 렌더 등록: job_d98959fdec', ts: '' },
      { tool: 'make_game', summary: '게임 생성 실패: GameSpec 검증 실패: world.entities[0].width must be a number 0.3-20', ts: '' },
    ] };

  it('lists the label lines; ids and validator English stay out of the visible text', async () => {
    await render([message]);
    const log = container.querySelector('.tool-log')!;
    expect(log.querySelector('summary')!.textContent).toBe('작업 기록 4건');
    const lines = [...log.querySelectorAll(':scope > ul > li')].map((li) => li.querySelector('.tool-event-text')!.textContent);
    expect(lines).toEqual(['캐릭터 생성 실패 · 다시 시도해 성공', '캐릭터 생성: 노바', '3D 렌더 등록', '게임 생성 실패']);
    const details = [...log.querySelectorAll<HTMLDetailsElement>('.tool-event-detail')];
    expect(details.map((d) => [d.querySelector('summary')!.textContent, d.open])).toEqual([['자세히', false], ['자세히', false]]);
    expect(details[1].textContent).toContain('world.entities[0].width');
    expect(log.textContent).not.toContain('job_d98959fdec');
  });
});

describe('Round 10: a 게임 설계 request shows its cast by name, the ids stay in the stored text', () => {
  const text = '[게임 설계] 이 설계대로 3D 게임을 만들어줘.\n게임 요청: 던전\n'
    + '[출연 IP cast_ip_ids=ip_5f117da92d,ip_102423a49b] 주인공 기사(캐릭터), 포션(소품)\n게임에는 위 출연 IP만 나와야 해';
  const message: Message = { messageId: 'u1', role: 'user', status: 'done', text, ts: '2026-11-08T12:00:00Z' };

  it('the bubble reads "출연 IP: names" with no raw tag or ids', async () => {
    await render([message]);
    const bubble = container.querySelector('.msg--user .bubble')!.textContent!;
    expect(bubble).toContain('출연 IP: 주인공 기사(캐릭터), 포션(소품)');
    expect(bubble).not.toContain('cast_ip_ids');
    expect(bubble).not.toMatch(/ip_[0-9a-f]+/);
    expect(message.text).toContain('cast_ip_ids=ip_5f117da92d,ip_102423a49b'); // what the model gets is unchanged
  });

  it('a model-tag request with a cast shows both as chips and names', async () => {
    await render([{ ...message, text: `[영상 모델: LTX-2.5 (ltx)] ${text}` }]);
    const bubble = container.querySelector('.msg--user .bubble')!.textContent!;
    expect(bubble).toContain('출연 IP: 주인공 기사(캐릭터)');
    expect(bubble).not.toContain('cast_ip_ids');
  });
});

// The user's own bubbles must not show the tags the agent reads ("[에셋 수정 ipId=…]", "[게임 설계] … [survive]").
describe('R20-47: the user\'s own bubble shows what was meant, not the tags the agent reads', () => {
  it('an image edit, a shot edit, a game edit and a trailer direction name what was pressed and keep the words typed', () => {
    expect(userText('[에셋 수정 ipId=ip_dbcdddaef0] 꼬마 마법사: 목에 빨간 스카프를 둘러줘'))
      .toEqual({ chips: ['이미지 수정'], body: '꼬마 마법사: 목에 빨간 스카프를 둘러줘' });
    expect(userText('[영상 수정 jobId=job_1c15634d19] 카메라를 더 낮게, 천천히 따라가게'))
      .toEqual({ chips: ['영상 수정'], body: '카메라를 더 낮게, 천천히 따라가게' });
    // GameEditDrawer editGameMessage
    expect(userText("[게임 수정 gameId=gm_0540a4d435] '달빛 온실 30초 방어전'을(를) 이렇게 고친 새 버전을 만들어줘. 나머지는 그대로 둬.\n적을 2배로 늘려줘"))
      .toEqual({ chips: ['게임 수정'], body: '달빛 온실 30초 방어전: 적을 2배로 늘려줘' });
    // api.ts rebuildRequest (the 게임에 반영 button)
    expect(userText("[게임 수정 gameId=gm_0540a4d435] 새 3D가 준비됐으니 '달빛 온실 30초 방어전'을(를) 같은 설계와 출연 IP 그대로 다시 만들어 3D 모델로 바꿔줘. 나머지는 그대로 둬."))
      .toEqual({ chips: ['게임 수정'], body: "새 3D가 준비됐으니 '달빛 온실 30초 방어전'을(를) 같은 설계와 출연 IP 그대로 다시 만들어 3D 모델로 바꿔줘. 나머지는 그대로 둬." });
    // EditDrawer messageFor, a trailer directed again: the asset id is the agent's
    expect(userText('[트레일러 연출] 전체 길이 약 20초, 영상 모델 LTX-2.5. 기존 트레일러(ast_9f8e7d6c5b)를 이 연출로 다시 만든다. 연출: 새벽에서 시작해 점점 빠르게'))
      .toEqual({ chips: ['트레일러 연출'], body: '약 20초 · LTX-2.5\n새벽에서 시작해 점점 빠르게' });
    expect(userText('[트레일러 연출] 전체 길이 약 15초, 영상 모델 Kandinsky 6.0. 연출: 도시 항공 샷으로 시작'))
      .toEqual({ chips: ['트레일러 연출'], body: '약 15초 · Kandinsky 6.0\n도시 항공 샷으로 시작' });
  });

  it('a 게임 설계 loses its fixed first line, the codes after its choices and a skill\'s module line', () => {
    // DesignDrawer briefMessage
    const design = '[게임 설계] 이 설계대로 3D 게임을 만들어줘.\n게임 요청: 등불을 지키는 30초\n유형: 생존전 (제한 시간 동안 버티기) [survive]\n'
      + '환경: 네온 도시 [neon-city], 하늘 밤 [night], 배치 미로 [maze]\n난이도: 어려움 [hard]\n'
      + '[출연 IP cast_ip_ids=ip_5f117da92d] 꼬마 마법사(캐릭터)\n게임에는 위 출연 IP만 나와야 해 (다른 IP나 이름 없는 적·소품 없이).';
    expect(userText(design)).toEqual({ chips: ['게임 설계'], body: '게임 요청: 등불을 지키는 30초\n유형: 생존전 (제한 시간 동안 버티기)\n'
      + '환경: 네온 도시, 하늘 밤, 배치 미로\n난이도: 어려움\n출연 IP: 꼬마 마법사(캐릭터)\n게임에는 위 출연 IP만 나와야 해 (다른 IP나 이름 없는 적·소품 없이).' });
    // SkillsDrawer
    expect(userText('[게임 설계] 이 설계대로 3D 게임을 만들어줘.\n[스킬 레이싱] 장르 모듈: world.track + stage race, checkpoints 8\n게임 요청: 협곡 서킷 3바퀴'))
      .toEqual({ chips: ['게임 설계'], body: '장르 스킬: 레이싱\n게임 요청: 협곡 서킷 3바퀴' });
  });

  // The drawer's first example sends a 설계 지침 line for the AI (DesignDrawer Brief.spec); the bubble leaves it out.
  it('a 게임 설계 sent from an example shows the idea and the choices, not the design guide that rode along for the AI', () => {
    const text = briefMessage({ prompt: '주인공이 소품을 되찾아 차를 몰고 배송 지점까지 운반하는 도시 게임을 만들어줘.',
      spec: '선택한 출연 IP와 지정한 역할을 그대로 사용해. version 2, engine three, world.city로 설계하고, 월드는 600 × 600m로 해줘. '
        + '주행 단계는 type drive, target 1, entityIds에 실제 차량 ID 하나, distanceMeters 150으로 해.',
      type: 'city-open-world', theme: '', sky: 'day', layout: '', mission: '코어를 회수해 차량으로 다른 구역에 운송', clear: '', fail: '', enemies: '',
      difficulty: 'easy', extra: '' });
    expect(text).toContain('\n설계 지침: 선택한 출연 IP와'); // the agent still reads it
    expect(userText(text)).toEqual({ chips: ['게임 설계'], body: '게임 요청: 주인공이 소품을 되찾아 차를 몰고 배송 지점까지 운반하는 도시 게임을 만들어줘.\n'
      + '유형: 도시 오픈월드 (구역·도로·차량·보행자와 단계별 임무)\n환경: 요청에 맞게, 하늘 낮\n미션: 코어를 회수해 차량으로 다른 구역에 운송\n난이도: 쉬움' });
    // a line the user typed that happens to start alike, outside a 게임 설계, is theirs
    expect(userText('설계 지침: 이건 내가 쓴 말')).toEqual({ chips: [], body: '설계 지침: 이건 내가 쓴 말' });
  });

  it('a model pick stays a chip before the action, and a plain line is left as typed', () => {
    expect(userText('[이미지 모델: Krea 2 Turbo (krea)] [에셋 수정 ipId=ip_1a2b3c4d5e] 루나: 머리를 은발로'))
      .toEqual({ chips: ['이미지 모델: Krea 2 Turbo', '이미지 수정'], body: '루나: 머리를 은발로' });
    expect(userText('우주 고양이 [루나]와 드론을 만들어줘 (ip_luna 말고)')).toEqual({ chips: [], body: '우주 고양이 [루나]와 드론을 만들어줘 (ip_luna 말고)' });
  });

  it('the bubble shows the chip and the words; the stored text, and an answer of the agent, are left alone', async () => {
    const own: Message = { messageId: 'u1', role: 'user', status: 'done', ts: '2026-11-16T03:40:00Z',
      text: '[에셋 수정 ipId=ip_dbcdddaef0] 꼬마 마법사: 목에 빨간 스카프를 둘러줘' };
    const answer: Message = { messageId: 'a1', role: 'assistant', status: 'done', ts: '2026-11-16T03:40:05Z', text: '[게임 설계] 탭에서 확인할 수 있어요.' };
    await render([own, answer]);
    const bubble = container.querySelector('.msg--user .bubble')!;
    expect([...bubble.querySelectorAll('.badge')].map((b) => b.textContent)).toEqual(['이미지 수정']);
    expect(bubble.textContent).toBe('이미지 수정꼬마 마법사: 목에 빨간 스카프를 둘러줘');
    expect(bubble.textContent).not.toMatch(/ipId|ip_[0-9a-f]/);
    expect(own.text).toContain('ipId=ip_dbcdddaef0');
    expect(container.querySelector('.msg--assistant .bubble')!.textContent).toBe('[게임 설계] 탭에서 확인할 수 있어요.');
  });
});

describe('R20-14: a new session opens ready to type, with examples that fill the box and a 보내기 that says why it waits', () => {
  const Stateful = ({ start = '', onSend = vi.fn(), ...rest }: { start?: string; onSend?: (t: string) => void } & Partial<Parameters<typeof ChatDock>[0]>) => {
    const [draft, setDraft] = useState(start);
    return <ChatDock sessionId="ses_1" messages={[]} draft={draft} onDraft={setDraft} onSend={onSend} disabled={false} {...rest} />;
  };
  const box = () => container.querySelector<HTMLTextAreaElement>('#composer')!;
  const send = () => container.querySelector<HTMLButtonElement>('.composer-send')!;
  const help = () => container.querySelector('#composer-help')!.textContent;

  it('puts the caret in the box of a session with nothing said yet, once it has loaded', async () => {
    await act(async () => root.render(<Stateful loading disabled />));
    expect(document.activeElement).not.toBe(box());
    expect([box().placeholder, help()]).toEqual(['세션을 불러오고 있어요…', '세션을 불러오고 있어요.']);
    expect(container.querySelector('.chat-intro')).toBeNull(); // no "어떤 세계를 만들고 싶나요?" over a session that may have a history
    await act(async () => root.render(<Stateful />));
    expect(document.activeElement).toBe(box());
  });

  it('leaves the focus alone in a session that has messages (on a phone its chat stays shut), and while the user is in another field', async () => {
    const said: Message = { messageId: 'u1', role: 'user', status: 'done', text: '안녕', ts: '' };
    await act(async () => root.render(<Stateful messages={[said]} />));
    expect(document.activeElement).not.toBe(box());
    await act(async () => root.unmount());
    root = createRoot(container);
    narrow = true;
    await act(async () => root.render(<Stateful messages={[said]} />));
    expect(container.querySelector('.chat')!.classList.contains('is-open')).toBe(false);
    expect(document.activeElement).not.toBe(box());
    await act(async () => root.unmount());
    root = createRoot(container);
    narrow = false;
    const other = document.createElement('input');
    document.body.append(other);
    other.focus();
    await act(async () => root.render(<Stateful />));
    expect(document.activeElement).toBe(other);
    other.remove();
  });

  // On a phone a new session's chat is a shut drawer: it opens by itself, the caret after the idea, the box tall enough for it.
  it('on a phone a session with nothing said yet opens its chat by itself, the caret after what waits in the box', async () => {
    vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => { f(0); return 0; });
    narrow = true;
    const idea = '숲을 지키는 꼬마 궁수와 나무 정령을 만들어줘';
    await act(async () => root.render(<Stateful start={idea} />));
    expect(container.querySelector('.chat')!.classList.contains('is-open')).toBe(true);
    expect(document.activeElement).toBe(box());
    expect(box().value).toBe(idea); // ready to send, not sent
    expect([box().selectionStart, box().selectionEnd]).toEqual([idea.length, idea.length]); // typing goes on after the idea
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<Stateful />)); // a plain new session: its first step is in front too
    expect(container.querySelector('.chat')!.classList.contains('is-open')).toBe(true);
    expect(document.activeElement).toBe(box());
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<Stateful loading disabled />)); // not before the session has loaded
    expect(container.querySelector('.chat')!.classList.contains('is-open')).toBe(false);
  });

  it('the message box grows with what is in it, up to five lines, and goes back when that fits again', async () => {
    // jsdom lays nothing out: the box is given a phone's sizes in Chrome (44 px high, 42 inside)
    let content = 61;
    const sizes = { scrollHeight: () => content, clientHeight: () => 42, offsetHeight: () => 44 };
    for (const [name, get] of Object.entries(sizes)) Object.defineProperty(HTMLTextAreaElement.prototype, name, { configurable: true, get });
    try {
      await act(async () => root.render(<Stateful start="숲을 지키는 꼬마 궁수와 나무 정령을 만들어줘" />));
      expect(box().style.height).toBe('63px'); // its text and its border: nothing is cut
      content = 400; // twenty lines: the box stops at five and scrolls inside
      await act(async () => container.querySelector<HTMLButtonElement>('.chat-example')!.click());
      expect(box().style.height).toBe('102px');
      content = 21; // one line again
      await act(async () => root.render(<Stateful key="again" />));
      expect(box().style.height).toBe('');
    } finally {
      for (const name of Object.keys(sizes)) delete (HTMLTextAreaElement.prototype as unknown as Record<string, unknown>)[name];
    }
  });

  it('the examples are buttons: one fills an empty box, and goes after what is typed instead of over it (R20-56)', async () => {
    await act(async () => root.render(<Stateful />));
    const chips = [...container.querySelectorAll<HTMLButtonElement>('.chat-example')];
    expect(chips.map((c) => c.textContent)).toEqual(['우주 고양이 탐험가와 탐사용 드론을 만들어줘', '숲을 지키는 꼬마 궁수와 나무 정령을 만들어줘', '네온 도시의 배달 로봇과 호버 스쿠터를 만들어줘']);
    await act(async () => chips[0].click());
    expect(box().value).toBe('우주 고양이 탐험가와 탐사용 드론을 만들어줘');
    expect(document.activeElement).toBe(box());
    await act(async () => chips[1].click());
    expect(box().value).toBe('우주 고양이 탐험가와 탐사용 드론을 만들어줘\n숲을 지키는 꼬마 궁수와 나무 정령을 만들어줘');
  });

  it('on a phone the line under the box says only why 보내기 waits: its keyboard has no Enter to name', async () => {
    narrow = true;
    await act(async () => root.render(<Stateful />));
    expect(help()).toBe('내용을 입력하면 보낼 수 있어요.');
    await act(async () => container.querySelector<HTMLButtonElement>('.chat-example')!.click());
    expect(help()).toBe(''); // nothing to say: the stylesheet takes the empty line away
  });

  it('보내기 says why it would do nothing, stays reachable, and a press takes the user to the box', async () => {
    const onSend = vi.fn();
    await act(async () => root.render(<Stateful onSend={onSend} />));
    expect([send().getAttribute('aria-disabled'), send().disabled, send().getAttribute('aria-describedby')]).toEqual(['true', false, 'composer-help']);
    expect(help()).toBe('내용을 입력하면 보낼 수 있어요.');
    expect(send().title).toBe('내용을 입력하면 보낼 수 있어요.');
    box().blur();
    await act(async () => send().click());
    expect(onSend).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(box());
    await act(async () => container.querySelector<HTMLButtonElement>('.chat-example')!.click());
    expect([send().getAttribute('aria-disabled'), help()]).toEqual([null, 'Enter 보내기 · Shift + Enter 줄바꿈']);
    await act(async () => send().click());
    expect(onSend).toHaveBeenCalledExactlyOnceWith('우주 고양이 탐험가와 탐사용 드론을 만들어줘');
    // while an answer is being made
    await act(async () => root.render(<Stateful start="다음 요청" onSend={onSend} disabled />));
    expect([send().getAttribute('aria-disabled'), help()]).toEqual(['true', '답변을 만드는 중이에요. 끝나면 보낼 수 있어요.']);
  });
});

// The server counts the whole line it gets, the model picks' tags too (server/app.py MAX_CHAT_CHARS).
describe('R20-42: the message box counts toward the 4,000 it can send, and does not send more', () => {
  const Stateful = ({ start = '', onSend = vi.fn() }: { start?: string; onSend?: (t: string) => void }) => {
    const [draft, setDraft] = useState(start);
    return <ChatDock sessionId="ses_1" messages={[{ messageId: 'u1', role: 'user', status: 'done', text: '안녕', ts: '' }]} draft={draft} onDraft={setDraft}
      onSend={onSend} disabled={false} />;
  };
  const box = () => container.querySelector<HTMLTextAreaElement>('#composer')!;
  const send = () => container.querySelector<HTMLButtonElement>('.composer-send')!;
  const count = () => container.querySelector<HTMLElement>('.composer-count');
  const help = () => container.querySelector('#composer-help')!.textContent;
  const type = (text: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box(), text);
    box().dispatchEvent(new Event('input', { bubbles: true }));
  });

  it('shows no count far from the limit, and the count from 3,600 characters on', async () => {
    await act(async () => root.render(<Stateful start={'가'.repeat(3599)} />));
    expect(count()).toBeNull();
    await type('가'.repeat(3600));
    expect([count()!.textContent, count()!.classList.contains('is-over')]).toEqual(['3,600 / 4,000자', false]);
    expect(box().getAttribute('aria-describedby')).toBe('composer-help composer-count');
    await type('가'.repeat(4000));
    expect([count()!.textContent, count()!.classList.contains('is-over'), send().getAttribute('aria-disabled')]).toEqual(['4,000 / 4,000자', false, null]);
  });

  it('past the limit 보내기 waits and says by how much; nothing is sent, and nothing typed is cut', async () => {
    const onSend = vi.fn();
    await act(async () => root.render(<Stateful start={'가'.repeat(4100)} onSend={onSend} />));
    expect([count()!.textContent, count()!.classList.contains('is-over')]).toEqual(['4,100 / 4,000자', true]);
    expect(help()).toBe('4,000자까지 보낼 수 있어요. 100자 줄여 주세요.');
    expect(send().getAttribute('aria-disabled')).toBe('true');
    await act(async () => send().click());
    await act(async () => { box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    expect(onSend).not.toHaveBeenCalled();
    expect(box().value).toHaveLength(4100);
    await type('가'.repeat(4000));
    await act(async () => send().click());
    expect(onSend).toHaveBeenCalledExactlyOnceWith('가'.repeat(4000));
  });

  it('counts what is sent as the server counts it: by character, with a model pick\'s tag', async () => {
    const onSend = vi.fn();
    await act(async () => root.render(<Stateful start={'😀'.repeat(3600)} onSend={onSend} />));
    expect(count()!.textContent).toBe('3,600 / 4,000자'); // not 7,200 UTF-16 units
    await type('가'.repeat(3990));
    expect(send().getAttribute('aria-disabled')).toBeNull();
    // a picked image model rides along as "[이미지 모델: Krea 2 Turbo (krea)] ": 30 characters more with its space
    await act(async () => container.querySelectorAll<HTMLButtonElement>('.composer-models .dropdown-button')[0].click());
    await act(async () => [...container.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent === 'Krea 2 Turbo')!.click());
    expect([count()!.textContent, send().getAttribute('aria-disabled')]).toEqual(['4,020 / 4,000자', 'true']);
  });
});

// The log must not scroll to the bottom on every tool event, and Tab from the log must not stop at every 작업 기록 line.
describe('R20-56 / R20-52: the log does not pull a reader down, and one Tab goes from it to the message box', () => {
  const said = (id: string, role: Message['role'], text: string, extra: Partial<Message> = {}): Message =>
    ({ messageId: id, role, status: 'done', text, ts: '', ...extra });
  const event = (summary: string) => ({ tool: 'create_ip_asset', summary, ts: '' });
  const show = (messages: Message[]) => act(async () => root.render(
    <ChatDock sessionId="ses_1" messages={messages} draft="" onDraft={vi.fn()} onSend={vi.fn()} disabled={false} />));
  /** A log 300 px tall whose content is `height` px (jsdom lays nothing out). */
  const sized = (height: () => number) => {
    const log = container.querySelector<HTMLElement>('.chat-log')!;
    Object.defineProperty(log, 'scrollHeight', { configurable: true, get: height });
    Object.defineProperty(log, 'clientHeight', { configurable: true, get: () => 300 });
    return log;
  };
  const scrollTo = (log: HTMLElement, top: number) => act(async () => { log.scrollTop = top; log.dispatchEvent(new Event('scroll')); });

  it('follows new lines while the reader is at the end, and leaves a reader further up where they are', async () => {
    const turn = said('a1', 'assistant', '', { status: 'pending', toolEvents: [event('캐릭터 생성: 노바')] });
    await show([said('u1', 'user', '만들어줘'), turn]);
    let height = 1000;
    const log = sized(() => height);
    await scrollTo(log, 700); // at the end
    height = 1100;
    await show([said('u1', 'user', '만들어줘'), { ...turn, toolEvents: [...turn.toolEvents!, event('소품 생성: 등불')] }]);
    expect(log.scrollTop).toBe(1100);
    expect(container.querySelector('.chat-jump')).toBeNull();

    await scrollTo(log, 200); // reading the first answer again
    height = 1200;
    await show([said('u1', 'user', '만들어줘'), { ...turn, toolEvents: [...turn.toolEvents!, event('소품 생성: 등불'), event('3D 렌더 등록: 노바')] }]);
    expect(log.scrollTop).toBe(200);
    const jump = container.querySelector<HTMLButtonElement>('.chat-jump')!;
    expect(jump.textContent).toBe('↓ 새 내용 보기');
    await act(async () => jump.click());
    expect(log.scrollTop).toBe(1200);
    expect(container.querySelector('.chat-jump')).toBeNull();
  });

  it('goes to the end for the user\'s own new line, and within 48 px of the end still counts as there', async () => {
    const first = [said('u1', 'user', '만들어줘'), said('a1', 'assistant', '만들었어요.')];
    await show(first);
    let height = 1000;
    const log = sized(() => height);
    await scrollTo(log, 100);
    height = 1080;
    await show([...first, said('u2', 'user', '하나 더')]);
    expect(log.scrollTop).toBe(1080);
    await scrollTo(log, 1080 - 300 - 40); // 40 px short of the end
    height = 1150;
    await show([...first, said('u2', 'user', '하나 더'), said('a2', 'assistant', '네.')]);
    expect(log.scrollTop).toBe(1150);
  });

  it('on a phone the open chat steps aside when a toast\'s link opens a tab of the panes under it (R20-16)', async () => {
    narrow = true;
    await show([said('a1', 'assistant', '만들었어요.')]);
    await act(async () => container.querySelector<HTMLButtonElement>('.chat-toggle')!.click());
    expect(container.querySelector('.chat')!.classList.contains('is-open')).toBe(true);
    await act(async () => openTab('ip', 'video'));
    expect(container.querySelector('.chat')!.classList.contains('is-open')).toBe(false);
  });

  it('Tab on the log goes straight to the message box; Shift+Tab and Tab inside the log are the browser\'s', async () => {
    await show([said('a1', 'assistant', '만들었어요.', { toolEvents: [event('캐릭터 생성: 노바')] })]);
    const log = container.querySelector<HTMLElement>('.chat-log')!;
    const tab = (target: Element, shiftKey = false) => {
      const e = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
      act(() => { target.dispatchEvent(e); });
      return e.defaultPrevented;
    };
    log.focus();
    expect(tab(log)).toBe(true);
    expect(document.activeElement).toBe(container.querySelector('#composer'));
    log.focus();
    expect(tab(log, true)).toBe(false);
    expect(tab(log.querySelector('summary')!)).toBe(false); // a 작업 기록 line keeps its own Tab
  });
});

// With the chat folded, or shut as the phone's drawer, the box is display:none and takes no focus: the link opens the chat first.
describe('the skip link to the chat opens the chat when it is shut (round20 review, web)', () => {
  const page = () => act(async () => root.render(
    <>
      <TopBar session={null} activeJobs={[]} onCancelJob={vi.fn()} navOpen={false} onMenu={vi.fn()} onPublish={vi.fn()} onLogout={vi.fn()} onConnections={vi.fn()} chat />
      <ChatDock sessionId="ses_1" messages={[{ messageId: 'u1', role: 'user', status: 'done', text: '안녕', ts: '' }]} draft="" onDraft={vi.fn()} onSend={vi.fn()} disabled={false} />
    </>));
  const skip = () => act(async () => [...container.querySelectorAll<HTMLAnchorElement>('.skip-link')].find((a) => a.textContent === '채팅 입력으로 바로 가기')!.click());
  const toggle = () => container.querySelector<HTMLButtonElement>('.chat-toggle')!;
  const body = () => container.querySelector<HTMLElement>('#chat-body')!;
  const box = () => container.querySelector<HTMLTextAreaElement>('#composer')!;

  it.each([[1366, 768, 'the column beside the panes'], [820, 1180, 'the dock under the panes']])('at %ix%i, folded (%s): it unfolds and the caret is in the box', async (w, h) => {
    await windowSize(w, h);
    await page();
    await act(async () => toggle().click());
    expect([body().hidden, toggle().getAttribute('aria-expanded')]).toEqual([true, 'false']);
    await skip();
    expect([body().hidden, toggle().getAttribute('aria-expanded')]).toEqual([false, 'true']);
    expect(document.activeElement).toBe(box());
    await act(async () => toggle().click()); // folded again by hand, and opened again by hand: the focus is left alone
    toggle().focus();
    await act(async () => toggle().click());
    expect(document.activeElement).toBe(toggle());
  });

  it('on a phone the shut drawer opens with the caret in the box', async () => {
    await windowSize(390, 844);
    await page();
    expect(container.querySelector('.chat')!.classList.contains('is-open')).toBe(false);
    await skip();
    expect(container.querySelector('.chat')!.classList.contains('is-open')).toBe(true);
    expect(body().hidden).toBe(false);
    expect(document.activeElement).toBe(box());
  });

  it('an open chat stays as it is: the caret goes to the box', async () => {
    await windowSize(1366, 768);
    await page();
    await skip();
    expect([body().hidden, document.activeElement === box()]).toEqual([false, true]);
  });
});
