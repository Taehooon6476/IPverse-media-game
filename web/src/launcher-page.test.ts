// The launcher page a warm GameLift Streams host opens (server/launcher.html), run against a fake API and fake game
// frames. A game's build holds the launcher's one thread for seconds, and a game without &standby=1 would run its
// round in the hidden frame.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fs = (await import('node:fs' as string)) as { existsSync: (p: string) => boolean; readFileSync: (p: string, e: 'utf8') => string };
const html = fs.readFileSync(['../server/launcher.html', 'server/launcher.html'].find((p) => fs.existsSync(p))!, 'utf8'); // run from web/ or the repo root
const script = /<script>([\s\S]*)<\/script>/.exec(html)![1];

const game = (id: string, holds = true) => `https://cdn.test/games/gm_${id}/index.html?noads=1&playable=90${holds ? '&standby=1' : ''}`;
const [A, B, C] = [game('a'), game('b'), game('c')];
type Answer = Record<string, unknown>;

/** The page on a stream host: its poll gets `answer` (set with say). */
function boot(first: Answer) {
  document.body.innerHTML = '<p id="s"></p>';
  const location = { search: '?t=tok', origin: 'https://cdn.test', replace: vi.fn() };
  let answer = first;
  const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => answer }));
  new Function('location', 'fetch', script)(location, fetch);
  return { location, say: (a: Answer) => { answer = a; } };
}
const held = () => [...document.querySelectorAll<HTMLIFrameElement>('iframe')].map((f) => f.dataset.url);
const frameOf = (url: string) => document.querySelector<HTMLIFrameElement>(`iframe[data-url="${url}"]`)!;
const f = (url: string) => frameOf(url) as HTMLIFrameElement & { thaw?: () => void };
const poll = () => vi.advanceTimersByTimeAsync(250);

/** What a game page does in its frame once it is built: #loading goes and its loop draws one frame per animation
 * frame. tick: the frame's next animation frames. */
function build(url: string) {
  const f = frameOf(url);
  const w = f.contentWindow as unknown as { requestAnimationFrame: (cb: () => void) => number; focus: () => void };
  const queue: Array<() => void> = [];
  w.requestAnimationFrame = (cb) => queue.push(cb);
  w.focus = () => undefined; // jsdom has none
  const state = { drawn: 0 };
  const loop = () => { state.drawn += 1; w.requestAnimationFrame(loop); };
  const doc = f.contentDocument!; // jsdom loads no frame: its blank document stands in for the game's page
  const loading = Object.assign(doc.createElement('div'), { id: 'loading', hidden: true });
  (doc.body ?? doc.documentElement ?? doc).appendChild(loading);
  w.requestAnimationFrame(loop);
  const tick = async (n = 1) => {
    for (let i = 0; i < n; i++) for (const cb of queue.splice(0)) cb();
    await vi.advanceTimersByTimeAsync(0);
  };
  return { state, tick };
}
/** The game is built and has drawn its first frames: the launcher stops its loop. */
async function built(url: string) {
  const g = build(url);
  await vi.advanceTimersByTimeAsync(100); // the launcher looks at the frame
  await g.tick(9);
  expect(f(url).thaw).toBeUndefined(); // still drawing: its first frames compile its shaders
  await g.tick(4);
  const drawn = g.state.drawn;
  await g.tick(3);
  expect(g.state.drawn).toBe(drawn); // frozen: a hidden built game costs the host nothing
  return g;
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ''; });

describe('the launcher page (server/launcher.html): the games of the next card, built ahead', () => {
  it("loads its page's viewer's game at once, then the other tiles' one at a time while no card is due", async () => {
    boot({ state: 'wait', next: 250, preload: A, also: [B, C], calm: 60 });
    await poll();
    expect(held()).toEqual([A]); // one build at a time: a build holds the page's one thread
    await poll();
    expect(held()).toEqual([A]);
    await built(A);
    expect(held()).toEqual([A, B]); // the next starts as soon as the first is built, not at the next poll
    await built(B);
    expect(held()).toEqual([A, B, C]);
  });

  it("another viewer's game does not start while a card is up or due within a build's time, and one still building then makes way", async () => {
    const page = boot({ state: 'wait', next: 250, preload: A, also: [B], calm: 5 });
    await poll();
    await built(A);
    await poll();
    expect(held()).toEqual([A]); // the next card is 5 s away: a build would still run when it is clicked
    page.say({ state: 'wait', next: 250, preload: A, also: [B] }); // no round length known: the same
    await poll();
    expect(held()).toEqual([A]);
    page.say({ state: 'wait', next: 250, preload: A, also: [B], calm: 40 });
    await poll();
    expect(held()).toEqual([A, B]);
    page.say({ state: 'wait', next: 250, preload: A, also: [B], card: true }); // the card came early: B is not built
    await poll();
    expect(held()).toEqual([A]); // the click must find this page idle
    await poll();
    expect(held()).toEqual([A]); // and nothing starts while the card is up
  });

  it('the time a build took counts against the calm the server last told', async () => {
    boot({ state: 'wait', next: 5000, preload: A, also: [B], calm: 16 }); // asked once; the next poll is 5 s away
    await vi.advanceTimersByTimeAsync(2000);
    await built(A); // 2 s later 14 s are left: not enough for another build
    expect(held()).toEqual([A]);
    await vi.advanceTimersByTimeAsync(3000); // the next poll: the server says 16 s again
    expect(held()).toEqual([A, B]);
  });

  it("its page's viewer's game always loads, card or not, and a build of another viewer's makes way for it", async () => {
    const page = boot({ state: 'wait', next: 250, preload: A, also: [B], calm: 60 });
    await poll();
    await built(A);
    expect(held()).toEqual([A, B]); // B is building
    page.say({ state: 'wait', next: 250, preload: C, also: [B], card: true }); // the cue named another game than expected
    await poll();
    expect(held()).toEqual([C]);
    await built(C);
    await poll();
    expect(held()).toEqual([C]); // B waits for the card to go
  });

  it('a game that cannot hold for the first input is never loaded ahead', async () => {
    boot({ state: 'wait', next: 250, preload: game('old', false), also: [game('old2', false), B], calm: 60 });
    await poll();
    expect(held()).toEqual([B]); // its round would run in the hidden frame
  });

  it('a click reveals the held game, which draws again, and the other games leave the host to it', async () => {
    const page = boot({ state: 'wait', next: 250, preload: A, also: [B], calm: 60 });
    await poll();
    await built(A);
    const b = await built(B);
    page.say({ state: 'go', url: B });
    await poll();
    expect(held()).toEqual([B]);
    expect(frameOf(B).classList.contains('on')).toBe(true);
    const drawn = b.state.drawn;
    await b.tick(3);
    expect(b.state.drawn).toBe(drawn + 3);
    expect(page.location.replace).not.toHaveBeenCalled();
    expect(document.getElementById('s')!.textContent).toBe('');
  });

  it('a click for a game it does not hold drops the held games before it opens that page', async () => {
    const page = boot({ state: 'wait', next: 250, preload: A, calm: 60 });
    await poll();
    await built(A);
    page.say({ state: 'go', url: C });
    await poll();
    expect(held()).toEqual([]);
    expect(page.location.replace).toHaveBeenCalledWith(C);
  });

  it('a game that never says it is built stops holding the others back', async () => {
    boot({ state: 'wait', next: 250, preload: A, also: [B], calm: 600 });
    await poll();
    await vi.advanceTimersByTimeAsync(44_000);
    expect(held()).toEqual([A]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(held()).toEqual([A, B]);
  });
});
