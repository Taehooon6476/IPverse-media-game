import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Toasts, lifeMs, toolNotice, type Toast } from './components/Toasts';

// server/tools.py BACKGROUND_3D: what render_3d says for a background IP (216 characters, 8 lines).
const BACKGROUND_3D = '배경(장면 전체)은 Hunyuan3D로 만들지 않았습니다: 물체 하나를 3D로 만드는 모델이라 장면은 조각으로만 나옵니다. '
  + '대신 장면 그림 전체에 두께만 준 2.5D 판(릴리프 GLB)과 턴테이블 영상을 만듭니다(10–20분). 걸어 다닐 수 있는 3D '
  + '환경·지형은 아니니 사용자에게 그렇게 알리고, 게임 배경에는 world.background mode image(원본 그림)를 쓰세요.';

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
  vi.unstubAllGlobals();
});

const show = (toasts: Toast[], onDismiss = vi.fn(), onOpen?: (tab: string) => void) =>
  act(async () => root.render(<Toasts toasts={toasts} onDismiss={onDismiss} onAction={vi.fn()} onOpen={onOpen} />));
const bars = () => [...container.querySelectorAll<HTMLElement>('.toast-life')];

describe('a plain toast stays as long as its text needs (E2E M6)', () => {
  it('lives 4 s plus 60 ms a character, at most 12 s; twice that when something went wrong or there is a result to open', async () => {
    expect(BACKGROUND_3D).toHaveLength(216);
    await show([
      { id: 1, level: 'ok', text: '게임을 게시했습니다.' }, // 11 characters
      { id: 2, level: 'error', text: '가'.repeat(50) },
      { id: 3, level: 'ok', text: BACKGROUND_3D },
    ]);
    // the life bar's CSS animation is the timer, so the pointer or the focus on the toast still pauses it
    expect(bars().map((b) => b.style.animationDuration)).toEqual(['4660ms', '14000ms', '12000ms']);
    // a long job's toast stays longer than a plain one
    expect([lifeMs({ level: 'ok', text: '등불의 숲 트레일러 완료', open: 'video' }), lifeMs({ level: 'warn', text: '가'.repeat(200) }),
      lifeMs({ level: 'ok', text: '가'.repeat(10) })]).toEqual([9560, 20000, 4600]);
  });

  // In the studio an error is the one place a failed send or a refused action is said: there it has no clock and goes
  // when closed, when its link is followed, or when a fourth toast needs its place. The play and watch windows do
  // not ask for that.
  it('where the page asks for it an error stays until it is closed; a warning and a plain toast still close by themselves', async () => {
    const onDismiss = vi.fn();
    const list: Toast[] = [
      { id: 1, level: 'error', text: '서버에 연결하지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.' },
      { id: 2, level: 'error', text: '등불의 숲 트레일러 실패: 시간 초과', open: 'pipeline' },
      { id: 3, level: 'warn', text: '등불 수정본(v2)이 검사를 통과하지 못해 적용하지 않았어요.' },
      { id: 4, level: 'ok', text: '세션을 지웠어요.' },
    ];
    const clocks = () => [...container.querySelectorAll<HTMLElement>('.toast')].map((t) => !!t.querySelector('.toast-life'));
    await act(async () => root.render(<Toasts toasts={list} onDismiss={onDismiss} onAction={vi.fn()} keepErrors />));
    expect(clocks()).toEqual([false, false, true, true]);
    await act(async () => container.querySelector<HTMLButtonElement>('.toast-close')!.click());
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith(1);
    await show(list); // a page that does not ask
    expect(clocks()).toEqual([true, true, true, true]);
  });

  it('closes when its bar runs out; a toast with a button has no bar and stays', async () => {
    const onDismiss = vi.fn();
    await show([
      { id: 7, level: 'ok', text: '렌더 완료' },
      { id: 8, level: 'ok', text: '새 3D가 준비됐어요. 게임에 반영할까요?', action: { id: 'rebuild-game', label: '게임에 반영' } },
    ], onDismiss);
    expect(bars()).toHaveLength(1);
    // jsdom has no AnimationEvent, so React listens for the prefixed name there: send both, one is heard
    await act(async () => { for (const type of ['animationend', 'webkitAnimationEnd']) bars()[0].dispatchEvent(new Event(type, { bubbles: true })); });
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith(7);
  });
});

// A toast that comes up under a still pointer must not pause: only a pointer that moves over it holds it.
describe('a toast\'s clock stops only for a pointer that moves over it, the focus, or a page in the background (R20-18)', () => {
  const toast = () => container.querySelector<HTMLElement>('.toast')!;
  /** A pointer event as the browser reports it: dx/dy are how far the pointer moved since the last one. */
  const pointer = (type: string, dx = 0, dy = 0) => act(async () => {
    const e = new MouseEvent(type, { bubbles: type !== 'pointerleave', cancelable: true });
    Object.defineProperty(e, 'movementX', { value: dx });
    Object.defineProperty(e, 'movementY', { value: dy });
    if (type === 'pointerleave') Object.defineProperty(e, 'relatedTarget', { value: document.body }); // React hears a leave as the pointer going out
    toast().dispatchEvent(type === 'pointerleave' ? new MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body }) : e);
  });

  it('is not held by coming up under a resting pointer: only a real move holds it, and leaving lets it go', async () => {
    await show([{ id: 1, level: 'ok', text: '작업을 중지했어요.' }]);
    await pointer('pointermove'); // what the browser sends when an element appears under a still pointer: 0 px
    expect(toast().classList.contains('is-held')).toBe(false);
    await pointer('pointermove', 3, 0);
    expect(toast().classList.contains('is-held')).toBe(true);
    await pointer('pointerleave');
    expect(toast().classList.contains('is-held')).toBe(false);
  });

  it('stops every clock while the page is in the background, and starts them again when it is back', async () => {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    await show([{ id: 1, level: 'ok', text: '등불의 숲 트레일러 완료' }]);
    expect(container.querySelector('.toasts')!.classList.contains('is-away')).toBe(true);
    hidden.mockReturnValue(false);
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(container.querySelector('.toasts')!.classList.contains('is-away')).toBe(false);
    hidden.mockRestore();
  });
});

describe('a finished job\'s toast opens its result; one that was no success is not green (R20-16, R20-09)', () => {
  it('has a link named after the tab it opens, which closes the toast; a toast with an action button has none', async () => {
    const onDismiss = vi.fn();
    const onOpen = vi.fn();
    await show([
      { id: 1, level: 'ok', text: '꼬마 마법사 이미지 완료', open: 'characters' },
      { id: 2, level: 'error', text: '등불의 숲 트레일러 실패: 시간 초과', open: 'pipeline' },
      { id: 3, level: 'ok', text: '세린 3D가 준비됐어요. 요청해 둔 게임을 만들까요?', action: { id: 'rebuild-game', label: '게임 만들기' }, open: '3d' },
      { id: 4, level: 'ok', text: '세션을 지웠어요.' },
    ], onDismiss, onOpen);
    const links = [...container.querySelectorAll<HTMLButtonElement>('.toast-open')];
    expect(links.map((l) => l.textContent)).toEqual(['그림 보기', '작업 현황에서 보기']);
    await act(async () => links[1].click());
    expect(onOpen).toHaveBeenCalledExactlyOnceWith('pipeline');
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith(2);
    expect(bars()).toHaveLength(3); // it still closes by itself; only the one with the action button stays
  });

  it('marks ok with a check and a warning or an error with !, each in its own colour class', async () => {
    await show([
      { id: 1, level: 'ok', text: '꼬마 마법사 이미지 완료' },
      { id: 2, level: 'warn', text: '꼬마 마법사 수정본(v2)이 검사를 통과하지 못해 적용하지 않았어요.' },
      { id: 3, level: 'error', text: '이미지 실패: 시간 초과' },
    ]);
    expect([...container.querySelectorAll('.toast')].map((t) => [t.className.match(/toast--\w+/)![0], t.querySelector('.toast-icon')!.textContent]))
      .toEqual([['toast--ok', '✓'], ['toast--warn', '!'], ['toast--error', '!']]);
  });

  it('is read out by two regions that are on the page before anything is said, once (R20-52)', async () => {
    await show([]);
    const polite = container.querySelector('[aria-live="polite"]')!;
    const assertive = container.querySelector('[aria-live="assertive"]')!;
    expect([polite.textContent, assertive.textContent]).toEqual(['', '']);
    await show([{ id: 1, level: 'ok', text: '꼬마 마법사 이미지 완료' }, { id: 2, level: 'error', text: '이미지 실패: 시간 초과' }]);
    expect([container.querySelector('[aria-live="polite"]'), container.querySelector('[aria-live="assertive"]')]).toEqual([polite, assertive]); // the same nodes
    expect([polite.textContent, assertive.textContent]).toEqual(['꼬마 마법사 이미지 완료', '이미지 실패: 시간 초과']);
    // on the toast itself the text is its group's name (for whoever reaches its buttons), not a second reading
    const first = container.querySelector('.toast')!;
    expect([first.getAttribute('role'), first.getAttribute('aria-label'), first.querySelector('.toast-text')!.getAttribute('aria-hidden')])
      .toEqual(['group', '꼬마 마법사 이미지 완료', 'true']);
  });
});

describe('a card button shows what its tool said in a few words (E2E M6)', () => {
  it('uses the server notice as it is', () => {
    const notice = '배경은 2.5D 판(릴리프)으로 만들어요. 걸어 다닐 수 있는 3D 환경은 아니에요.';
    expect(toolNotice({ jobId: 'job_1', model: 'relief', message: BACKGROUND_3D, notice })).toBe(notice);
  });

  it('else the first sentence of the message, without what is meant for the agent', () => {
    const text = toolNotice({ jobId: 'job_1', model: 'relief', message: BACKGROUND_3D });
    expect(text).toBe('배경(장면 전체)은 Hunyuan3D로 만들지 않았습니다: 물체 하나를 3D로 만드는 모델이라 장면은 조각으로만 나옵니다.');
    expect(text).not.toContain('world.background');
  });

  it('or of the warning', () => {
    // tools.render_3d on a picture that failed its composition check (mediagen_image.check_note + the 3D line)
    const warning = '구도 검사 실패: 왼쪽이 프레임에 잘림(2번 그려도 같음). 첫 그림이라 그대로 두었으니 다시 뽑아 주세요. '
      + '이 그림으로 만든 3D는 잘린 모양 그대로 나옵니다. 사용자에게 알리고 다시 뽑기를 권하세요.';
    expect(toolNotice({ jobId: 'job_2', warning })).toBe('구도 검사 실패: 왼쪽이 프레임에 잘림(2번 그려도 같음).');
  });

  it('drops internal keys and anything in backticks, keeping names such as 2.5D and Hunyuan3D', () => {
    expect(toolNotice({ message: '게임 배경에는 원본 그림(world.background)을 씁니다. 다음 문장.' })).toBe('게임 배경에는 원본 그림을 씁니다.');
    expect(toolNotice({ warning: '`render_3d` 대신 Hunyuan3D 없이 2.5D 판을 만듭니다.' })).toBe('대신 Hunyuan3D 없이 2.5D 판을 만듭니다.');
    expect(toolNotice({ message: '다시 그리려면 다시 뽑기를 누르세요 (reroll_ip_image). 다음 문장.' })).toBe('다시 그리려면 다시 뽑기를 누르세요.');
  });

  it('a refusal keeps the sentence for the user and drops the instructions for the agent', () => {
    // server/tools.py _image_failed, _not_ready (images_pending) and _not_found: HTTP 400 messages a card button can get
    expect(toolNotice({ message: '기업 탑 옥상 정원의 이미지 작업이 실패해 이미지가 없습니다. 사용자에게 알리고, 작업 현황에서 다시 '
      + '시도하거나 create_ip_asset으로 새로 만들도록 안내하세요.' })).toBe('기업 탑 옥상 정원의 이미지 작업이 실패해 이미지가 없습니다.');
    expect(toolNotice({ message: '테오의 이미지를 아직 그리는 중입니다(대기·진행 중인 이미지 2장, 약 3분). 이 도구를 다시 부르지 말고, '
      + '대기 중인 이미지와 예상 시간을 알린 뒤 이미지가 왼쪽에 나타나면 다시 요청해 달라고 안내하세요.' }))
      .toBe('테오의 이미지를 아직 그리는 중입니다(대기·진행 중인 이미지 2장, 약 3분).');
    expect(toolNotice({ message: 'IP을(를) 찾을 수 없습니다: ip_672fc45085. 상태(state)에 있는 id만 쓰세요.' })).toBe('IP을(를) 찾을 수 없습니다.');
  });

  it('says nothing when the tool said nothing beyond registering the job', () => {
    expect(toolNotice({ jobId: 'job_3' })).toBeNull();
    expect(toolNotice({ jobId: 'job_3', notice: 42, message: '  ', warning: '`world.background`' })).toBeNull();
    expect(toolNotice(undefined)).toBeNull();
  });
});
