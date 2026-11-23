import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bareHeroes, diffJobs, gameOffer, heldGame, heldOffer, rebuildRequest } from './api';
import { DesignDrawer, designCastProblem } from './components/DesignDrawer';
import { JOB_KIND_LABEL, gameThreeD, type Asset, type Ip, type Job, type Snapshot } from './types';

const fs = (await import('node:fs' as string)) as { existsSync: (p: string) => boolean; readFileSync: (p: string, e: 'utf8') => string };
const css = fs.readFileSync(['src/origin.css', 'web/src/origin.css'].find((p) => fs.existsSync(p))!, 'utf8'); // run from web/ or the repo root

// A game made while the protagonist's 3D still runs would show her as a flat cutout: the drawer shows each IP's 3D
// state and only sends a design whose protagonist is 3D-ready (server/tools.py _needs_3d).
const ip = (ipId: string, name: string, kind: Ip['kind'], extra: Partial<Ip> = {}): Ip => ({
  ipId, name, kind, description: '', imageAssetId: `image_${ipId}`, cutoutAssetId: `cutout_${ipId}`,
  version: 1, createdAt: '2026-11-01T00:00:00Z', ...extra,
});
const asset = (assetId: string, kind: Asset['kind'], ipId: string): Asset => ({
  assetId, kind, ipId, key: `k/${assetId}`, url: `/u/${assetId}`, contentType: 'model/gltf-binary', meta: {}, createdAt: '2026-11-01T00:00:00Z',
});
const job = (kind: Job['kind'], ipId: string, status: Job['status'] = 'running'): Job => ({
  jobId: `job_${kind}_${ipId}`, kind, provider: 'img3d', status, input: { ipId }, outputs: [], deps: [], progress: '',
  createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
});

const luna = ip('ip_luna', '루나', 'character', { glbAssetId: 'glb_luna' });
const fox = ip('ip_fox', '여우', 'character', { glbAssetId: 'glb_fox' });
const kai = ip('ip_kai', '카이', 'character');
const core = ip('ip_core', '코어', 'prop');
const scene = ip('ip_bg', '폐허', 'prop', { usage: 'background', glbAssetId: 'glb_bg' });
const ips = [luna, fox, kai, core, scene];
const assets = [asset('glb_luna', 'glb', 'ip_luna'), asset('glb_fox', 'glb', 'ip_fox'), asset('glb_bg', 'glb', 'ip_bg')];
const jobs = [job('rig', 'ip_fox', 'queued')]; // 여우: the mesh landed, its rig has not

describe('an IP 3D state for a game', () => {
  it('is ready with a GLB, running while a rig is still coming, none when no 3D was started', () => {
    expect(gameThreeD(luna, assets, jobs)).toEqual({ state: 'ready' });
    expect(gameThreeD(fox, assets, jobs)).toEqual({ state: 'running', phase: '움직임 뼈대' });
    expect(gameThreeD(kai, assets, [job('render3d', 'ip_kai', 'queued'), job('mesh3d', 'ip_kai')])).toEqual({ state: 'running', phase: '3D 모델' });
    expect(gameThreeD(kai, assets, [job('mesh3d', 'ip_kai', 'failed')])).toEqual({ state: 'none' });
    // a rig redone over an existing rig: the current one plays meanwhile
    const rigged = ip('ip_r', 'R', 'character', { glbAssetId: 'g', riggedGlbAssetId: 'r' });
    expect(gameThreeD(rigged, [asset('g', 'glb', 'ip_r'), asset('r', 'rigged_glb', 'ip_r')], [job('rig', 'ip_r')]).state).toBe('ready');
  });

  it('the player must be 3D-ready; another IP in 3D (or the background) is not enough', () => {
    const t = (x: Ip) => gameThreeD(x, assets, jobs);
    expect(designCastProblem([luna, core], { ip_luna: 'player', ip_core: 'prop' }, t)).toBeNull();
    expect(designCastProblem([kai, luna], { ip_kai: 'player', ip_luna: 'npc' }, t)).toContain('3D가 없어요');
    expect(designCastProblem([fox, scene], { ip_fox: 'player', ip_bg: 'background' }, t)).toContain('만들어지고 있어요(움직임 뼈대)');
  });
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  sessionStorage.clear(); // a new tab: the drawer keeps its brief and its picks for the tab
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const query = <T extends Element>(selector: string) => container.querySelector<T>(selector)!;
const card = (name: string) => query<HTMLInputElement>(`input[aria-label="${name} 출연 IP 선택"]`).closest('.cast-card')!;
const submit = () => query<HTMLButtonElement>('button[type="submit"]');
async function check(name: string) {
  await act(async () => query<HTMLInputElement>(`input[aria-label="${name} 출연 IP 선택"]`).click());
}
async function prompt(value: string) {
  await act(async () => {
    const textarea = query<HTMLTextAreaElement>('#game-design-prompt');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('the design drawer waits for 3D', () => {
  it('badges each cast card with its 3D state', async () => {
    await act(async () => root.render(<DesignDrawer ips={ips} assets={assets} jobs={jobs} onMake3d={vi.fn()} onClose={vi.fn()} onSend={vi.fn()} />));
    expect(card('루나').textContent).toContain('3D 완료');
    expect(card('여우').textContent).toContain('3D 만드는 중 · 움직임 뼈대');
    expect(card('카이').textContent).toContain('3D 없음');
    expect(card('카이').querySelector('button')?.textContent).toBe('3D로 만들기');
    expect(card('루나').querySelector('button')).toBeNull();
    expect(card('코어').querySelector('button[aria-label="코어 3D로 만들기"]')).not.toBeNull();
  });

  it('disables 이 설계로 게임 만들기 until the picked protagonist is 3D-ready, and says why', async () => {
    const send = vi.fn(async () => undefined);
    await act(async () => root.render(<DesignDrawer ips={ips} assets={assets} jobs={jobs} onMake3d={vi.fn()} onClose={vi.fn()} onSend={send} />));
    await prompt('폐허에서 코어 회수');
    expect(submit().disabled).toBe(true); // nothing picked: a 3D-ready protagonist has to be
    expect(query('#design-submit-hint').textContent).toContain('3D가 완성된 주인공');
    await check('카이');
    expect(submit().disabled).toBe(true);
    expect(query('#design-submit-hint').textContent).toContain('‘카이’의 3D가 없어요');
    await check('카이'); await check('여우');
    expect(submit().disabled).toBe(true);
    expect(query('#design-submit-hint').textContent).toContain('움직임 뼈대');
    await check('여우'); await check('루나'); await check('코어'); // a prop without 3D may stand as its cutout
    expect(submit().disabled).toBe(false);
    await act(async () => query<HTMLFormElement>('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(send).toHaveBeenCalledOnce();
  });

  it('starts render_3d from a card without 3D', async () => {
    let finish!: () => void;
    const make3d = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    await act(async () => root.render(<DesignDrawer ips={ips} assets={assets} jobs={jobs} onMake3d={make3d} onClose={vi.fn()} onSend={vi.fn()} />));
    const button = card('카이').querySelector<HTMLButtonElement>('button')!;
    await act(async () => button.click());
    expect(make3d).toHaveBeenCalledWith(kai);
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('시작하는 중…');
    await act(async () => finish());
    // the next snapshot carries its job: the card says 3D 만드는 중
    await act(async () => root.render(<DesignDrawer ips={ips} assets={assets} jobs={[...jobs, job('apose', 'ip_kai', 'queued')]}
      onMake3d={make3d} onClose={vi.fn()} onSend={vi.fn()} />));
    expect(card('카이').textContent).toContain('3D 만드는 중 · 3D용 자세 그림');
    expect(card('카이').querySelector('button')).toBeNull();
  });
});

// The card's grid column must not grow to the badge's one-line width (136 px in a 95 px card).
// jsdom lays nothing out, so the rules are read from the stylesheet (vitest stubs CSS imports).
describe('a 3D badge stays inside its 출연 IP card', () => {
  const rule = (selector: string) => css.match(new RegExp(`\\n${selector.replace(/\./g, '\\.')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';

  it("the card's own column cannot grow wider than the card", () => {
    expect(rule('.cast-card')).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\)/);
  });

  it('the badge wraps onto a second line inside the card', async () => {
    await act(async () => root.render(<DesignDrawer ips={ips} assets={assets} jobs={jobs} onMake3d={vi.fn()} onClose={vi.fn()} onSend={vi.fn()} />));
    expect(card('여우').querySelector('.cast-3d .badge')?.textContent).toBe('3D 만드는 중 · 움직임 뼈대'); // the rule's selector
    const badge = rule('.cast-3d .badge');
    expect(badge).toMatch(/white-space:\s*normal/); // .badge: nowrap
    expect(badge).toMatch(/[^-]height:\s*auto/); // .badge: 22 px, one line
    expect(badge).toMatch(/flex:\s*0 1 auto/); // .badge: none, never narrower than its text
  });

  // a name with no place to break must not push the picture and the name past the card through the label's column
  it('a name without a place to break wraps too, and the picture keeps the width of the card', () => {
    expect(rule('.cast-pick')).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\)/);
    expect(rule('.cast-name')).toMatch(/overflow-wrap:\s*anywhere/);
  });
});

describe('게임에 반영 after new 3D', () => {
  const snap = (extra: Partial<Snapshot>): Snapshot => ({
    session: { sessionId: 's', title: 't', genre: 'sf-shooter' } as Snapshot['session'], messages: [], ips, assets, jobs: [], games: [], ...extra,
  });
  const game = { gameId: 'gm_1', title: '탈출', genre: 'sf-shooter', specKey: 'k', previewUrl: 'u', createdAt: '2026-11-09T01:00:00Z' } as Snapshot['games'][number];
  const design = { messageId: 'm', role: 'user' as const, status: 'done' as const, text: '[게임 설계] …', ts: '2026-11-09T02:00:00Z',
    gameDesign: { prompt: '[게임 설계] …', castIpIds: ['ip_luna'], playerIpId: 'ip_luna', weaponIpId: null, propIpIds: [], enemyIpIds: [], npcIpIds: [] } };

  it('re-makes the newest game as a new version, not a file refresh', () => {
    expect(rebuildRequest(snap({ games: [game] }))?.text).toMatch(/^\[게임 수정 gameId=gm_1\] 새 3D가 준비됐으니 '탈출'/);
    // ... offered as 게임에 반영, and the toast says a new version is made
    const made = snap({ games: [game], jobs: [job('rig', 'ip_fox', 'done')] });
    expect(gameOffer(made)).toBe('remake');
    expect(diffJobs([job('rig', 'ip_fox')], made.jobs, gameOffer(made), made.ips)).toEqual([
      { level: 'ok', text: '새 3D가 준비됐어요 (여우). 게임에 반영할까요? 새 버전으로 다시 만들어요.', action: { id: 'rebuild-game', label: '게임에 반영' } }]);
    expect(gameOffer(snap({}))).toBeNull();
  });

  it('sends a design that was waiting on the 3D again, as it was', () => {
    expect(rebuildRequest(snap({ messages: [design] }))).toEqual({ text: design.text, gameDesign: design.gameDesign });
    expect(rebuildRequest(snap({ messages: [design], games: [{ ...game, createdAt: '2026-11-09T03:00:00Z' }] }))?.text).toContain('[게임 수정');
    expect(rebuildRequest(snap({}))).toBeNull();
  });

  // A game request typed in chat and held for the hero's 3D carries no gameDesign; the server marks it (gameHeld,
  // server/agent.py _note_hold). 여우 stands for the hero: her mesh is in, her rig is not.
  const ask = { messageId: 'u1', role: 'user' as const, status: 'done' as const, text: '이 IP들로 30초 생존 게임 만들어줘',
    ts: '2026-11-11T01:34:32.222Z', gameHeld: { ipIds: ['ip_fox'] } };
  const later = { messageId: 'u2', role: 'user' as const, status: 'done' as const, text: '소품도 3D로 만들어줘', ts: '2026-11-11T01:34:46.978Z' };
  // a held request is a game that does not exist yet, so its button is 게임 만들기; 게임에 반영 re-makes an existing game
  const make = { id: 'rebuild-game', label: '게임 만들기' };
  const meshed = { level: 'ok', text: `코어 ${JOB_KIND_LABEL.mesh3d} 완료`, open: '3d' }; // a finished job names its IP and where it shows

  it('offers 게임 만들기 for a chat game request held for the hero 3D, once her rig lands', () => {
    const rigging = snap({ messages: [ask, later], jobs: [job('rig', 'ip_fox')] });
    const rigged = snap({ messages: [ask, later], jobs: [job('rig', 'ip_fox', 'done')] });
    // the prop's mesh landed while she was still rigging: offered then, the click would be held again
    expect(rebuildRequest(rigging)).toBeNull();
    expect(diffJobs([job('mesh3d', 'ip_core'), ...rigging.jobs], [job('mesh3d', 'ip_core', 'done'), ...rigging.jobs],
      gameOffer(rigging), rigging.ips)).toEqual([meshed]);
    expect(rebuildRequest(rigged)).toEqual({ text: ask.text }); // the request that was held, not the newest message
    expect(gameOffer(rigged)).toBe('held');
    expect(diffJobs(rigging.jobs, rigged.jobs, gameOffer(rigged), rigged.ips)).toEqual([
      { level: 'ok', text: '여우 3D가 준비됐어요. 요청해 둔 게임을 만들까요?', action: make }]);
  });

  it('does not offer the older game re-made while a newer held request still waits for its hero', () => {
    // With a game in the session, a prop's mesh landing during her rig must not offer a re-make: that click would make a
    // newer game and the held request would never get its own.
    const rigging = snap({ messages: [ask, later], games: [game], jobs: [job('rig', 'ip_fox')] });
    expect(rebuildRequest(rigging)).toBeNull();
    expect(diffJobs([job('mesh3d', 'ip_core'), ...rigging.jobs], [job('mesh3d', 'ip_core', 'done'), ...rigging.jobs],
      gameOffer(rigging), rigging.ips)).toEqual([meshed]);
    expect(rebuildRequest({ ...rigging, jobs: [job('rig', 'ip_fox', 'done')] })).toEqual({ text: ask.text });
  });

  it('does not offer a held game whose hero 3D failed, until a retry lands', () => {
    const held = { ...ask, gameHeld: { ipIds: ['ip_kai'] } }; // 카이 has no model
    const failed = snap({ messages: [held], jobs: [job('mesh3d', 'ip_kai', 'failed'), job('rig', 'ip_kai', 'failed')] });
    expect(heldGame(failed)).toBeNull();
    expect(rebuildRequest(failed)).toBeNull();
    expect(diffJobs([job('mesh3d', 'ip_kai')], failed.jobs, gameOffer(failed), failed.ips).map((t) => t.action)).toEqual([undefined, undefined]);
    const retried = snap({ messages: [held], ips: [...ips, { ...kai, glbAssetId: 'glb_kai' }].filter((x) => x !== kai),
      assets: [...assets, asset('glb_kai', 'glb', 'ip_kai')], jobs: [job('mesh3d', 'ip_kai', 'done'), job('rig', 'ip_kai', 'done')] });
    expect(rebuildRequest(retried)).toEqual({ text: ask.text });
  });

  it('does not offer it on a rig that failed over a finished mesh for a passing reason: the request waited for her rig', () => {
    const failed = snap({ messages: [ask], jobs: [{ ...job('rig', 'ip_fox', 'failed'), error: '렌더 서버에서 작업이 실패했습니다: FAILED' }] });
    expect(gameThreeD(fox, assets, failed.jobs)).toEqual({ state: 'ready' }); // the server would make it with the bare mesh
    expect(rebuildRequest(failed)).toBeNull();
    expect(heldOffer(failed, [], new Set())).toBeNull();
    // 다시 시도 landed: her rigged model is in
    const retried = snap({ messages: [ask], ips: ips.map((x) => (x === fox ? { ...fox, riggedGlbAssetId: 'rig_fox' } : x)),
      assets: [...assets, asset('rig_fox', 'rigged_glb', 'ip_fox')], jobs: [job('rig', 'ip_fox', 'done')] });
    expect(rebuildRequest(retried)).toEqual({ text: ask.text });
    // a rig redone over that model that fails leaves her the model she has: nothing is held back
    expect(rebuildRequest({ ...retried, jobs: [job('rig', 'ip_fox', 'failed')] })).toEqual({ text: ask.text });
  });

  // A skeleton the farm refused is the exception to "the request waited for her rig": no retry lands, so the request
  // is ready with the model she has (server/tools.py ready_3d_for_game).
  describe('a held request whose hero was refused a skeleton', () => {
    const refusedRig = (extra: Partial<Job> = {}): Job => ({ ...job('rig', 'ip_fox', 'failed'),
      error: '움직임 뼈대를 넣을 수 없는 모양입니다: not a full body: legs are missing or cut off (hips at 30% of the height)', ...extra });
    const BARE = { level: 'warn', text: '‘여우’는 움직임 뼈대를 넣을 수 없는 모습이에요. 걷는 동작 없이 그대로 게임을 만들까요?', action: make };

    it('is ready: 게임 만들기 sends it as it was', () => {
      const refused = snap({ messages: [ask, later], jobs: [refusedRig()] });
      expect(heldGame(refused)?.messageId).toBe('u1');
      expect(gameOffer(refused)).toBe('held');
      expect(rebuildRequest(refused)).toEqual({ text: ask.text });
      expect(bareHeroes(refused)).toEqual(['ip_fox']);
      // ... by the server's own mark too, however its line is worded
      const marked = snap({ messages: [ask], jobs: [refusedRig({ error: '움직임 뼈대를 넣지 못했습니다', outcome: 'refused', reason: '다리가 옷에 가려 보이지 않아요' })] });
      expect(rebuildRequest(marked)).toEqual({ text: ask.text });
      expect(bareHeroes(marked)).toEqual(['ip_fox']);
    });

    it('the refusal landing in front of the page is the offer itself: one toast, and it says what the game will lack', () => {
      const rigging = snap({ messages: [ask, later], jobs: [job('rig', 'ip_fox')] });
      const refused = snap({ messages: [ask, later], jobs: [refusedRig()] });
      const shown = diffJobs(rigging.jobs, refused.jobs, gameOffer(refused), refused.ips, bareHeroes(refused));
      expect(shown).toEqual([BARE]);
      expect(heldOffer(refused, shown, new Set())).toEqual({ messageId: 'u1', toast: null }); // remembered, no second toast
    });

    it('is offered when the session opens later, in the same words', () => {
      expect(heldOffer(snap({ messages: [ask, later], jobs: [refusedRig()] }), [], new Set())).toEqual({ messageId: 'u1', toast: BARE });
    });

    it('with no held request the refusal is a failure that says why and what to do, not a retry to wait for', () => {
      const refused = snap({ jobs: [refusedRig()] });
      expect(diffJobs([job('rig', 'ip_fox')], refused.jobs, gameOffer(refused), refused.ips, bareHeroes(refused))).toEqual([
        { level: 'error', text: '여우 움직임 뼈대 실패: 다리가 보이지 않거나 너무 짧아요. 그림을 다시 뽑아야 해요.', open: 'pipeline' }]);
      expect(bareHeroes(refused)).toEqual([]);
    });

    it('a hero who already has a skeleton is not bare: a refused re-rig leaves her the one she has', () => {
      const rigged = snap({ messages: [ask], ips: ips.map((x) => (x === fox ? { ...fox, riggedGlbAssetId: 'rig_fox' } : x)),
        assets: [...assets, asset('rig_fox', 'rigged_glb', 'ip_fox')], jobs: [refusedRig()] });
      expect(rebuildRequest(rigged)).toEqual({ text: ask.text });
      expect(bareHeroes(rigged)).toEqual([]);
      expect(heldOffer(rigged, [], new Set())?.toast).toEqual({ level: 'ok', text: '여우 3D가 준비됐어요. 요청해 둔 게임을 만들까요?', action: make });
    });
  });

  it('sends the newest of two held requests, and never the one it replaced', () => {
    const second = { ...ask, messageId: 'u3', text: '아니, 60초 보스전 게임으로 만들어줘', ts: '2026-11-11T01:36:00.000Z' };
    expect(rebuildRequest(snap({ messages: [ask, later, second] }))).toEqual({ text: second.text });
    // the second waits for another hero who has no 3D: the first, though its hero is ready, is not what the user wants now
    const other = { ...second, gameHeld: { ipIds: ['ip_kai'] } };
    expect(rebuildRequest(snap({ messages: [ask, other] }))).toBeNull();
  });

  it('a held request the user typed again is answered by the game that made', () => {
    // the game made by asking again in chat after the 3D finished
    const made = { ...game, gameId: 'gm_0540a4d435', title: '달빛 온실 30초 방어전', createdAt: '2026-11-11T01:47:01.981Z' };
    const s = snap({ messages: [ask, later], games: [made] });
    expect(heldGame(s)).toBeNull();
    expect(rebuildRequest(s)?.text).toMatch(/^\[게임 수정 gameId=gm_0540a4d435\]/); // new 3D after it goes into that game
    // ... and an older game does not answer it
    expect(rebuildRequest(snap({ messages: [ask], games: [game] }))).toEqual({ text: ask.text });
  });

  it('a design the server refused for 3D waits for its player too (the Skills drawer sends one unchecked)', () => {
    const blocked = { ...design, gameDesign: { ...design.gameDesign, castIpIds: ['ip_fox'], playerIpId: 'ip_fox' } };
    const rigging = snap({ messages: [blocked], jobs: [job('rig', 'ip_fox')] });
    expect(rebuildRequest(rigging)).toBeNull();
    expect(rebuildRequest({ ...rigging, jobs: [job('rig', 'ip_fox', 'done')] })).toEqual({ text: blocked.text, gameDesign: blocked.gameDesign });
    // the mark the server left on it names what it waits for, whatever the design says
    const marked = { ...design, gameHeld: { ipIds: ['ip_kai'] } };
    expect(rebuildRequest(snap({ messages: [marked] }))).toBeNull();
  });

  describe('a held request the page did not see become ready', () => {
    const rigged = snap({ messages: [ask, later], jobs: [job('rig', 'ip_fox', 'done')] });
    const none = new Set<string>();

    it('is offered when the session opens, by name', () => {
      // the page was closed when the rig finished: no job goes running → done in front of it
      expect(heldOffer(rigged, [], none)).toEqual({ messageId: 'u1',
        toast: { level: 'ok', text: '여우 3D가 준비됐어요. 요청해 둔 게임을 만들까요?', action: make } });
    });

    it('is offered once: not again in a browser that showed it', () => {
      expect(heldOffer(rigged, [], new Set(['u1']))).toBeNull();
    });

    it('is the job toast itself when the rig lands in front of the page', () => {
      const shown = diffJobs([job('rig', 'ip_fox')], rigged.jobs, gameOffer(rigged), rigged.ips);
      expect(heldOffer(rigged, shown, none)).toEqual({ messageId: 'u1', toast: null }); // remembered, no second toast
    });

    it('waits while an answer is being made: that turn may be making the game', () => {
      const again = { messageId: 'u9', role: 'user' as const, status: 'done' as const, text: ask.text, ts: '2026-11-11T01:46:40.011Z' };
      const making = { messageId: 'a9', role: 'assistant' as const, status: 'pending' as const, text: '', ts: '2026-11-11T01:46:40.017Z' };
      expect(heldOffer({ ...rigged, messages: [ask, later, again, making] }, [], none)).toBeNull();
    });

    it('is not offered while the 3D still runs, after a game answered it, or for a design that carries no mark', () => {
      expect(heldOffer(snap({ messages: [ask], jobs: [job('rig', 'ip_fox')] }), [], none)).toBeNull();
      expect(heldOffer({ ...rigged, games: [{ ...game, createdAt: '2026-11-11T01:47:01.981Z' }] }, [], none)).toBeNull();
      expect(heldOffer(snap({ messages: [design] }), [], none)).toBeNull(); // its game may have failed for another reason
    });
  });
});
