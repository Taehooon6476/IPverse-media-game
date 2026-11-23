import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { getRelease } from './api';
import { PublishModal } from './components/PublishModal';
import { fmtTime, type Asset, type Game } from './types';

// The publish dialog: the share address stays in view after 게시하기 and is shown again later with what the game was
// published with, a game can be taken down, the link is said to be public, and games and trailers are told apart.
vi.mock('./api', async (importOriginal) => ({ ...(await importOriginal<typeof import('./api')>()), getRelease: vi.fn() }));

const at = (clock: string) => `2026-11-16T${clock}Z`;
const URL_OF = (id: string) => `https://cdn.example/games/${id}/index.html`;
const game = (gameId: string, title: string, createdAt: string, extra: Partial<Game> = {}): Game => ({ gameId, title, genre: 'rpg-quest',
  specKey: `games/${gameId}/spec.json`, previewUrl: URL_OF(gameId), createdAt, ...extra });
const video = (assetId: string, kind: Asset['kind'], createdAt: string, meta: Record<string, unknown> = {}): Asset => ({ assetId, kind,
  key: `sessions/s/${assetId}.mp4`, url: `https://cdn.example/${assetId}.mp4`, contentType: 'video/mp4', meta, createdAt });
const first = game('gm_1', '달빛 숲의 별조각', at('03:20:00'));
const second = game('gm_2', '달빛 숲의 별조각: 30초 생존', at('04:18:00'));
const trailers = [video('tr_1', 'trailer', at('03:40:00'), { seconds: 18.4 }), video('sh_1', 'shorts', at('03:40:00')),
  video('tr_2', 'trailer', at('03:55:00'), { seconds: 21 })];

type Publish = (body: { gameId: string; adAssetId?: string; skipAfterSec: number; adEveryRounds: number }) => Promise<string>;
let container: HTMLDivElement;
let root: Root;
let onPublish: Mock<Publish>;
let onUnpublish: Mock<(gameId: string) => Promise<void>>;
let copied: string[];
let scrolled: Element[];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  copied = [];
  scrolled = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied.push(text); } } });
  Element.prototype.scrollIntoView = function scrollIntoView(this: Element) { scrolled.push(this); };
  vi.mocked(getRelease).mockResolvedValue({ ad: null });
  onPublish = vi.fn<Publish>(async (body) => URL_OF(body.gameId));
  onUnpublish = vi.fn(async () => undefined);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});
const show = (games: Game[], assets: Asset[] = trailers, unpublish = true) => act(async () => root.render(
  <PublishModal games={games} assets={assets} onClose={vi.fn()} onPublish={onPublish} {...(unpublish ? { onUnpublish } : {})} />));
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const button = (text: string, within: ParentNode = document) => [...within.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text)!;
const submit = () => dialog().querySelector<HTMLButtonElement>('button[type="submit"]')!;
const address = () => dialog().querySelector<HTMLInputElement>('.publish-result input');
const hint = () => dialog().querySelector('#publish-submit-hint')!.textContent;
const ads = () => [...dialog().querySelectorAll<HTMLLabelElement>('fieldset label.radio')].map((l) => [l.textContent, l.querySelector('input')!.checked]);
const number = (label: string) => [...dialog().querySelectorAll('label.field')].find((l) => l.querySelector('span')!.textContent!.startsWith(label))!.querySelector('input')!;
const send = () => act(async () => { dialog().querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });

describe('R20-23 the publish dialog says what publishing is and tells its rows apart', () => {
  it('says that the link is public before the press', async () => {
    await show([first, second]);
    expect(dialog().querySelector('#publish-intro')!.textContent).toContain('주소를 아는 누구나 로그인 없이');
    expect(hint()).toBe('선택한 게임과 광고 설정으로 공유 주소를 만들어요.');
    expect(submit().textContent).toBe('게시하기');
  });

  it("lists the games by the pane's version numbers and the ads by their number in the 영상 tab and their length", async () => {
    await show([first, { ...second, publishedUrl: URL_OF('gm_2') }]);
    expect([...dialog().querySelectorAll('select option')].map((o) => o.textContent)).toEqual([
      `v2 · 달빛 숲의 별조각: 30초 생존 · ${fmtTime(second.createdAt)} · 게시됨`, `v1 · 달빛 숲의 별조각 · ${fmtTime(first.createdAt)}`]);
    expect(dialog().querySelector('fieldset legend')!.textContent).toBe('게임 시작 전 광고 영상');
    expect(ads().map(([text]) => text)).toEqual([`트레일러 2 · 16:9 · 21초${fmtTime(at('03:55:00'))}`, `트레일러 1 · 16:9 · 18초${fmtTime(at('03:40:00'))}`,
      `쇼츠 1 · 9:16${fmtTime(at('03:40:00'))}`, '광고 없음']);
    expect(dialog().textContent).not.toMatch(/IVS|MediaTailor|프리롤|숏츠|N판/);
  });
});

describe('R20-23 the address after publishing', () => {
  it('comes up in view above the settings, with 주소 복사 focused and the footer saying it is done', async () => {
    await show([first, second]);
    expect(address()).toBeNull();
    await send();
    expect(onPublish).toHaveBeenCalledWith({ gameId: 'gm_2', adAssetId: 'tr_2', skipAfterSec: 5, adEveryRounds: 3 });
    const box = dialog().querySelector('.publish-result')!;
    expect([address()!.value, address()!.readOnly]).toEqual([URL_OF('gm_2'), true]);
    expect(box.textContent).toContain('게시됐어요');
    expect(box.textContent).toContain('주소를 아는 누구나 로그인 없이');
    // before the ad list and the rules in the dialog: not under its fold
    expect(box.compareDocumentPosition(dialog().querySelector('fieldset')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(scrolled).toEqual([box]);
    expect(document.activeElement).toBe(button('주소 복사', box));
    expect(hint()).toBe('게시됐어요. 주소를 복사해 공유하세요.');
    expect([button('닫기', dialog().querySelector('.dialog-footer')!)].every(Boolean)).toBe(true);
    await act(async () => button('주소 복사', box).click());
    expect(copied).toEqual([URL_OF('gm_2')]);
    expect(box.querySelector('button')!.textContent).toBe('복사했어요');
    expect(box.querySelector<HTMLAnchorElement>('a')!.href).toBe(URL_OF('gm_2'));
  });
});

describe('C-09 a published game opens with its address and its own settings', () => {
  const published = { ...second, publishedUrl: URL_OF('gm_2'), publishedAt: at('04:30:00'), adAssetId: 'tr_1' };

  it('shows the address at once, without publishing again', async () => {
    vi.mocked(getRelease).mockResolvedValue({ ad: { videoUrl: 'https://cdn.example/tr_1.mp4', skipAfterSec: 8, everyRounds: 2 } });
    await show([first, published]);
    expect(address()!.value).toBe(URL_OF('gm_2'));
    expect(dialog().querySelector('.publish-result')!.textContent).toContain('게시 중인 게임이에요');
    expect(onPublish).not.toHaveBeenCalled();
    expect(scrolled).toEqual([]); // nothing was published here: nothing moves
    // the ad it was published with and that ad's rules, not the newest trailer, 5 s and every 3 rounds
    expect(getRelease).toHaveBeenCalledWith(published);
    expect(ads().filter(([, on]) => on).map(([text]) => text)).toEqual([`트레일러 1 · 16:9 · 18초${fmtTime(at('03:40:00'))}`]);
    expect([number('건너뛰기').value, number('광고 다시 틀기').value]).toEqual(['8', '2']);
    expect(submit().textContent).toBe('설정 바꿔 다시 게시');
    expect(hint()).toBe('게시 중인 게임이에요. 광고 설정을 바꾸려면 고친 뒤 ‘설정 바꿔 다시 게시’를 누르세요.');
    await send();
    expect(onPublish).toHaveBeenCalledWith({ gameId: 'gm_2', adAssetId: 'tr_1', skipAfterSec: 8, adEveryRounds: 2 });
  });

  it('keeps 광고 없음 for a game published without an ad, and a pre-roll only one as 0', async () => {
    await show([first, { ...published, adAssetId: undefined }]);
    expect(ads().filter(([, on]) => on).map(([text]) => text)).toEqual(['광고 없음']);
    await send();
    expect(onPublish).toHaveBeenLastCalledWith({ gameId: 'gm_2', adAssetId: undefined, skipAfterSec: 5, adEveryRounds: 3 });
    await act(async () => root.unmount());
    root = createRoot(container);
    vi.mocked(getRelease).mockResolvedValue({ ad: { videoUrl: 'https://cdn.example/tr_1.mp4', skipAfterSec: 5 } }); // no everyRounds: at the start only
    await show([first, published]);
    expect(number('광고 다시 틀기').value).toBe('0');
  });

  it("follows the picked game: another game's address and settings, or the new-game form for one not published", async () => {
    await show([{ ...first, publishedUrl: URL_OF('gm_1'), adAssetId: 'sh_1' }, second]);
    expect([address(), submit().textContent]).toEqual([null, '게시하기']); // v2, the newest, is not published
    const select = dialog().querySelector('select')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, 'gm_1');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect([address()!.value, submit().textContent]).toEqual([URL_OF('gm_1'), '설정 바꿔 다시 게시']);
    expect(ads().filter(([, on]) => on).map(([text]) => text)).toEqual([`쇼츠 1 · 9:16${fmtTime(at('03:40:00'))}`]);
  });
});

// After a publish made in the dialog the form is filled from the game's release.json; when that read fails or the CDN
// still serves the older file, the settings of the publish must stay, not the defaults.
describe('a publish made in the dialog keeps the settings it was made with (round20 review, web)', () => {
  const set = (label: string, value: string) => act(async () => {
    const field = number(label);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const pickAd = (starts: string) => act(async () => [...dialog().querySelectorAll<HTMLLabelElement>('fieldset label.radio')]
    .find((l) => l.textContent!.startsWith(starts))!.querySelector('input')!.click());
  const form = () => [ads().filter(([, on]) => on).map(([text]) => String(text).split(' · ')[0]), number('건너뛰기').value, number('광고 다시 틀기').value];
  const publishedAs = (adAssetId?: string) => ({ ...second, publishedUrl: URL_OF('gm_2'), publishedAt: at('04:30:00'), adAssetId });
  /** 트레일러 1, skip after 8 s, again every 2 rounds: published from the dialog, then the snapshot that shows it. */
  const publishHere = async () => {
    await show([first, second]);
    await pickAd('트레일러 1');
    await set('건너뛰기', '8');
    await set('광고 다시 틀기', '2');
    await send();
    expect(onPublish).toHaveBeenLastCalledWith({ gameId: 'gm_2', adAssetId: 'tr_1', skipAfterSec: 8, adEveryRounds: 2 });
    await show([first, publishedAs('tr_1')]);
  };

  it.each([
    ['fails', () => vi.mocked(getRelease).mockRejectedValue(new TypeError('Failed to fetch'))],
    ['is still the file of before the publish', () => vi.mocked(getRelease).mockResolvedValue({ ad: null })],
  ])('when the read of release.json %s, the form shows what was sent, and 설정 바꿔 다시 게시 sends that', async (_how, release) => {
    release();
    await publishHere();
    expect(form()).toEqual([['트레일러 1'], '8', '2']);
    expect(submit().textContent).toBe('설정 바꿔 다시 게시');
    await send();
    expect(onPublish).toHaveBeenCalledTimes(2);
    expect(onPublish).toHaveBeenLastCalledWith({ gameId: 'gm_2', adAssetId: 'tr_1', skipAfterSec: 8, adEveryRounds: 2 });
  });

  it('keeps them through a look at another game and back', async () => {
    await publishHere();
    const select = dialog().querySelector('select')!;
    const pick = (gameId: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, gameId);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await pick('gm_1');
    expect(form()).toEqual([['트레일러 2'], '5', '3']); // a game not published: the new-game form
    await pick('gm_2');
    expect(form()).toEqual([['트레일러 1'], '8', '2']);
  });

  it('a game taken down here starts from the new-game form again', async () => {
    await publishHere();
    await act(async () => button('게시 내리기', dialog()).click());
    await act(async () => button('게시 내리기', document.querySelector<HTMLElement>('[role="alertdialog"]')!).click());
    await show([first, second]); // the snapshot after it
    expect(form()).toEqual([['트레일러 2'], '5', '3']);
  });
});

describe('R20-23 게시 내리기', () => {
  const published = { ...second, publishedUrl: URL_OF('gm_2'), adAssetId: 'tr_2' };

  it('asks first, saying what goes and what stays, then takes the game down', async () => {
    await show([first, published]);
    await act(async () => button('게시 내리기', dialog()).click());
    const confirm = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
    expect(confirm.querySelector('h2')!.textContent).toBe('게시를 내릴까요?');
    const said = confirm.querySelector('.dialog-lead')!.textContent!;
    expect(said).toContain('‘달빛 숲의 별조각: 30초 생존’');
    expect(said).toContain('광고 설정이 지워');
    expect(said).toContain('이미 주소를 받은 사람은'); // the address is the game's own preview address: it keeps opening
    expect(onUnpublish).not.toHaveBeenCalled();
    await act(async () => button('게시 내리기', confirm).click());
    expect(onUnpublish).toHaveBeenCalledWith('gm_2');
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(address()).toBeNull();
    expect(dialog().querySelector('.publish-note[role="status"]')!.textContent).toBe('게시를 내렸어요. 이 게임은 이제 ‘게시됨’으로 표시되지 않고 광고도 나오지 않아요.');
    expect([submit().textContent, dialog().querySelector('select option')!.textContent]).toEqual(['게시하기',
      `v2 · 달빛 숲의 별조각: 30초 생존 · ${fmtTime(second.createdAt)}`]);
  });

  it('leaves the game up when the confirm is cancelled or the server refuses', async () => {
    await show([first, published]);
    await act(async () => button('게시 내리기', dialog()).click());
    await act(async () => button('취소', document.querySelector<HTMLElement>('[role="alertdialog"]')!).click());
    expect([onUnpublish.mock.calls.length, address()!.value]).toEqual([0, URL_OF('gm_2')]);
    onUnpublish.mockRejectedValueOnce(new Error('서버에 연결할 수 없습니다.'));
    await act(async () => button('게시 내리기', dialog()).click());
    await act(async () => button('게시 내리기', document.querySelector<HTMLElement>('[role="alertdialog"]')!).click());
    expect(address()!.value).toBe(URL_OF('gm_2')); // the caller toasts why
  });

  it('is not offered where nothing can take a game down', async () => {
    await show([first, published], trailers, false);
    expect(address()!.value).toBe(URL_OF('gm_2'));
    expect(button('게시 내리기', dialog())).toBeUndefined();
  });
});
