import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EN_LIVE } from './i18n/en-live';
import { EN_PANES } from './i18n/en-panes';
import { EN_SHELL } from './i18n/en-shell';

// i18n.ts spreads the three packages' dictionaries into one and the last wins: a key lives in one dictionary, and the
// same Korean with a second meaning has a key of its own (`#note`, i18n.ts).
const BOOKS: Record<string, Record<string, string>> = { 'en-shell': EN_SHELL, 'en-panes': EN_PANES, 'en-live': EN_LIVE };

beforeEach(() => { vi.resetModules(); localStorage.setItem('ipverse.lang', 'en'); });
afterEach(() => { localStorage.clear(); vi.resetModules(); });

describe('one English per Korean key', () => {
  it('no key is in two dictionaries', () => {
    const homes = new Map<string, string[]>();
    for (const [book, entries] of Object.entries(BOOKS)) for (const key of Object.keys(entries)) homes.set(key, [...homes.get(key) ?? [], book]);
    expect([...homes].filter(([, books]) => books.length > 1).map(([key, books]) => `${key}: ${books.join(', ')}`)).toEqual([]);
  });

  it('the merged dictionary keeps every entry of the three as it is written', async () => {
    const { EN } = await import('./i18n');
    const all = Object.values(BOOKS).flatMap((entries) => Object.entries(entries));
    expect(Object.keys(EN)).toHaveLength(all.length);
    expect(all.filter(([key, english]) => EN[key] !== english).map(([key]) => key)).toEqual([]);
  });

  it('every entry is English: no Hangul, no "please", no exclamation mark', () => {
    const all = Object.values(BOOKS).flatMap((entries) => Object.entries(entries));
    expect(all.filter(([, english]) => /[가-힣]/.test(english) || /\bplease\b/i.test(english) || english.includes('!')).map(([key]) => key)).toEqual([]);
    // what did not work is said one way, as the server says it: "The X could not be …"
    expect(all.filter(([, english]) => /\bCould not (?!be made$)/.test(english)).map(([key]) => key)).toEqual([]);
  });
});

describe('the words the review chose', () => {
  it('the keys two packages said differently', async () => {
    const { t } = await import('./i18n');
    expect([t('요청 중…'), t('라이브 시청'), t('MCP 서버 추가'), t('{name} 3D로 만들기', { name: 'Luna' })])
      .toEqual(['Sending…', 'Watch window', 'Add MCP server', 'Make 3D of Luna']);
    expect([t('채팅으로 게임 요청하기'), t('채팅으로 캐릭터 만들기'), t('채팅으로 원하는 게임을 요청해도 좋아요.')])
      .toEqual(['Ask for a game in the chat', 'Make a character in the chat', 'You can also ask for a game in the chat.']);
    expect([t('하이라이트 쇼츠'), t('만들지 못했어요'), t('방송 중에만 광고로 보낼 수 있어요'), t('{n}판 하이라이트 삭제', { n: 2 }), t('하이라이트 선택')])
      .toEqual(['Highlight Shorts', 'Could not be made', 'It can be sent as an ad only during a broadcast', 'Delete round 2 highlight', 'Pick a highlight']);
    expect(t('자동 생성을 켜면 판이 끝날 때마다 4–6초 하이라이트 쇼츠가 여기에 쌓여요.')).toBe('With auto-generation on, a 4–6 s highlight Short is added here each time a round ends.');
    expect([t('SF 슈터'), t('SF 서바이벌')]).toEqual(['Sci-fi shooter', 'Sci-fi survival']);
    expect([t('이미지 수정'), t('영상 수정'), t('게임 수정')]).toEqual(['Edit image', 'Edit video', 'Edit game']);
  });

  it('the same Korean with two meanings', async () => {
    const { t } = await import('./i18n');
    expect([t('만들기'), t('만드는 중…'), t('만들기#에이전트'), t('만드는 중…#에이전트')]).toEqual(['Create', 'Creating…', 'Make', 'Making…']); // the session form, the agent dialog
    expect([t('내리는 중…'), t('내리는 중…#게시')]).toEqual(['Shutting down…', 'Unpublishing…']); // the playable server, the publish dialog
    expect([t('대기 중'), t('대기 중#방송')]).toEqual(['Waiting', 'Idle']); // a job or a model test, the channel
    expect([t('주인공'), t('주인공#문장')]).toEqual(['Hero', 'the hero']); // the role, the name in a sentence
    expect([t('캐릭터'), t('캐릭터#하나'), t('소품'), t('소품#하나')]).toEqual(['Characters', 'Character', 'Props', 'Prop']); // the tabs, one IP's kind
  });

  it('the terms that drifted: reply, walking motions, completed, the server\'s schedule form', async () => {
    const { t } = await import('./i18n');
    expect(t('답변을 만드는 중이에요. 끝나면 보낼 수 있어요.')).toBe('A reply is being written. You can send when it is done.');
    expect(t('답변을 만드는 중…')).toBe('Replying…');
    expect(t('요청을 처리하지 못했어요.')).toBe('The request could not be completed.');
    expect(t('걷는 동작 없이 그대로 게임을 만들까요?')).toBe('Make the game as it is, without walking motions?');
    expect(t('걷는 동작을 넣으려면 {needs}으로 다시 뽑은 뒤 3D를 다시 만들어 주세요.', { needs: 'X' })).toBe('For walking motions, redraw it as X, then make the 3D again.');
    expect(t('플레이어블 서버를 켜지 못했어요. 잠시 뒤 다시 눌러 주세요.')).toBe('The playable server could not be started. Press again in a moment.');
    // (server/agents.py schedule_label: "Now: Every day 09:00 KST." stands under these chips)
    expect(['매일 오전 9시', '평일 오전 9시', '매주 월요일 오전 9시', '6시간마다'].map((label) => t(label)))
      .toEqual(['Every day 09:00 KST', 'Weekdays 09:00 KST', 'Every Monday 09:00 KST', 'Every 6 hours']);
  });

  it('counts: one of a thing is not "1 rounds"', async () => {
    const { tn } = await import('./i18n');
    expect([1, 3].map((n) => tn('{n}판이 끝나면 트레일러가 화면 전체에 나와요.', n))).toEqual(['After every round, a trailer fills the screen.', 'After every 3 rounds, a trailer fills the screen.']);
    expect([1, 2].map((n) => tn('광고 {n}회', n))).toEqual(['1 ad', '2 ads']);
    expect([1, 2].map((n) => tn('지난 방송에서 광고가 {n}번 나갔어요.', n))).toEqual(['The last broadcast sent 1 ad.', 'The last broadcast sent 2 ads.']);
    expect([1, 2].map((n) => tn(' · {n}개 메시지', n))).toEqual([' · 1 message', ' · 2 messages']);
    expect([1, 2].map((n) => tn('준비 완료 · 대기 GPU {n}대', n))).toEqual(['Ready · 1 idle GPU', 'Ready · 2 idle GPUs']);
    expect(tn('광고 설정을 바꿨어요. 지금부터 {n}판마다 {style}가 나가요.', 1, { style: 'Playable ad' })).toBe('Ad settings changed. From now on: Playable ad every round.');
  });
});

describe('a genre skill\'s IPs, by name in either language', () => {
  it('every IP has an English name, and the skill\'s English request holds no Hangul', async () => {
    const { EN } = await import('./i18n');
    const { SKILLS, assetName } = await import('./skills');
    const assets = SKILLS.flatMap((skill) => skill.assets);
    expect(assets.filter((a) => !EN[a.name] || /[가-힣]/.test(assetName(a))).map((a) => a.name)).toEqual([]);
    expect(assetName(assets[0])).toBe('Circuit marshal');
  });

  it('an IP made on either page is the same asset on the other', async () => {
    const { SKILLS, namedAfter } = await import('./skills');
    const marshal = SKILLS[0].assets[0];
    expect([namedAfter('서킷 마샬', marshal, true), namedAfter('Circuit marshal', marshal, true), namedAfter('서킷 마샬 라이카', marshal), namedAfter('Circuit marshal Laika', marshal)])
      .toEqual([true, true, true, true]);
    expect([namedAfter('Circuit marshal Laika', marshal, true), namedAfter('Luna', marshal)]).toEqual([false, false]);
    vi.resetModules();
    localStorage.clear(); // the Korean page finds the IP an English page made
    const ko = await import('./skills');
    expect(ko.assetName(ko.SKILLS[0].assets[0])).toBe('서킷 마샬');
    expect(ko.namedAfter('Circuit marshal', ko.SKILLS[0].assets[0], true)).toBe(true);
  });
});

// A plain Error with a capital and a space is not a sentence of ours: the browser's and the GameLift Streams SDK's errors look so too.
describe('an error in a toast is a sentence of ours, or the stand-in', () => {
  const STAND_IN = 'Something went wrong. Try again in a moment.';
  it('a library\'s or the browser\'s English sentence is not shown', async () => {
    const { errorMessage } = await import('./api');
    expect(errorMessage(new Error("Cannot read properties of null (reading 'canvas')"))).toBe(STAND_IN);
    expect(errorMessage(new Error('Browser failed to initiate local WebRTC connection'))).toBe(STAND_IN);
    expect(errorMessage(new Error('This instance is not currently streaming'))).toBe(STAND_IN);
    expect(errorMessage(new TypeError('Failed to fetch'))).toBe(STAND_IN);
  });

  it('a sentence the app wrote is shown, also once it crossed from the play window', async () => {
    const { said, isSaid } = await import('./i18n');
    const { errorMessage, ApiError } = await import('./api');
    const { OFFLINE } = await import('./auth');
    expect(errorMessage(said(OFFLINE))).toBe('The server could not be reached. Check your internet connection and try again.');
    expect(errorMessage(new ApiError(409, 'This ID is taken'))).toBe('This ID is taken'); // the server's, in the request's language
    const crossed = Object.assign(new Error(OFFLINE), { ours: isSaid(said(OFFLINE)) }); // (GameModal ownError)
    expect(errorMessage(crossed)).toBe(OFFLINE);
  });

  it('on the Korean page a Korean sentence is still ours', async () => {
    vi.resetModules();
    localStorage.clear();
    const { errorMessage } = await import('./api');
    expect(errorMessage(new Error('데모 계정으로 들어가지 못했어요.'))).toBe('데모 계정으로 들어가지 못했어요.');
    expect(errorMessage(new Error('This instance is not currently streaming'))).toBe('문제가 생겼어요. 잠시 뒤 다시 시도해 주세요.');
  });
});
