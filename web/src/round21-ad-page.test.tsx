// The public playable-ad page (#ad=): in a laptop-size window the start button and the sentence that explains it
// stay above the fold. jsdom lays nothing out: the rules are pinned here.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ getPlayableAd: vi.fn(), startAdStream: vi.fn(), pollAdStream: vi.fn(), stopAdStream: vi.fn() }));
vi.mock('./api', () => api);
vi.mock('./vendor/gameliftstreams/gameliftstreams-1.3.0.mjs', () => ({
  GameLiftStreams: class {
    generateSignalRequest() { return Promise.resolve('offer'); }
    processSignalResponse() { return Promise.resolve(); }
    attachInput() {}
    close() {}
  },
}));
const { PlayableAdPage } = await import('./components/PlayableAdPage');

const fs = (await import('node:fs' as string)) as { existsSync: (p: string) => boolean; readFileSync: (p: string, e: 'utf8') => string };
const read = (name: string) => fs.readFileSync([`src/${name}`, `web/src/${name}`].find((p) => fs.existsSync(p))!, 'utf8'); // run from web/ or the repo root
const css = `${read('styles.css')}\n${read('origin.css')}`.replace(/\/\*[\s\S]*?\*\//g, '');
/** The declarations of every rule whose selector list has `selector`, media queries flattened. */
const rules = (selector: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter((m) => m[1].split(',').map((s) => s.trim()).includes(selector)).map((m) => m[2]).join(';');

const ad = { adId: 'ad_197e', title: '사구의 유적: 30초 생존', seconds: 90, trailerUrl: 'https://cdn/t.mp4', ctaUrl: 'https://cdn/games/gm_1/index.html' };
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  api.getPlayableAd.mockResolvedValue(ad);
  api.stopAdStream.mockResolvedValue({});
  HTMLMediaElement.prototype.play = () => Promise.resolve(); // jsdom has no media playback
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
const page = () => container.querySelector<HTMLElement>('.playable-ad')!;

describe('the ad page keeps its start button and the sentence under it in the window (new finding 6)', () => {
  // what stands around the stage, measured at 1280x720: 24 px of page padding above and below, the head 63 px (the
  // badge, the title) and the gap under it 12 px; under the stage a gap, the button 44 px and its note, three lines
  // of 21 px at the narrowest
  const AROUND = 24 + 63 + 12 + 24;
  const START = AROUND + 12 + 44 + 8 + 63;
  /** The px a column rule leaves beside the stage's height: its width is the window's height less that, at 16:9, plus
   * its own 32 px of padding, and never more than the room it has. */
  const left = (body: string) => Number(body.match(/width:\s*min\(100%,\s*max\(\d+px,\s*calc\(\(100dvh - (\d+)px\) \* 16 \/ 9 \+ 32px\)\)\)/)?.[1]);

  it("the page's column is as wide as a 16:9 stage fits the window under the head", () => {
    expect(left(rules('.playable-ad'))).toBeGreaterThanOrEqual(AROUND);
    expect(rules('.playable-ad')).toMatch(/max-width:\s*1100px/); // and no wider on a large window
    expect(rules('.playable-ad')).toMatch(/padding:\s*24px 16px/);
    expect(rules('.media-16x9')).toMatch(/aspect-ratio:\s*16 \/ 9/); // the stage's height follows the column's width
    // the stage has no size of its own: the head above it keeps its left edge
    expect(rules('.playable-ad-stage')).not.toMatch(/(^|;)\s*(max-)?(width|height):/);
  });

  it('before the press the column also leaves room for the button and its note; the wait and the game take it back', async () => {
    expect(left(rules('.playable-ad.is-start'))).toBeGreaterThanOrEqual(START);
    await act(async () => root.render(<PlayableAdPage adId="ad_197e" />));
    await flush();
    expect(container.querySelector('.playable-ad-go button')!.textContent).toBe('▶ 90초 무료 체험 시작');
    expect(page().classList.contains('is-start')).toBe(true);
    api.startAdStream.mockReturnValue(new Promise(() => undefined)); // the wait stays up
    await act(async () => container.querySelector<HTMLButtonElement>('.playable-ad-go button')!.click());
    await flush();
    expect(container.querySelector('.playable-ad-go')).toBeNull();
    expect(page().classList.contains('is-start')).toBe(false);
  });

  it('a page that could not load has no button to leave room for', async () => {
    api.getPlayableAd.mockRejectedValue(new Error('이 체험판을 찾을 수 없어요.'));
    await act(async () => root.render(<PlayableAdPage adId="ad_gone" />));
    await flush();
    expect(page().classList.contains('is-start')).toBe(false);
  });

  // (an ad whose game was deleted answers 404 ad_gone with this sentence; the API layer hands a refusal's `message` on
  // as the error's own)
  it("an ad whose game was deleted says so in the server's own sentence, with no button", async () => {
    api.getPlayableAd.mockRejectedValue(Object.assign(new Error('이 광고의 게임이 삭제됐어요'), { name: 'ApiError', status: 404, code: 'ad_gone' }));
    await act(async () => root.render(<PlayableAdPage adId="ad_gone" />));
    await flush();
    expect(container.querySelector('.unreal-headline')!.textContent).toBe('이 광고의 게임이 삭제됐어요');
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('a window too short for any of it keeps a stage one can see: the floor, and the page scrolls', () => {
    for (const selector of ['.playable-ad', '.playable-ad.is-start']) {
      expect(Number(rules(selector).match(/width:\s*min\(100%,\s*max\((\d+)px/)?.[1]), selector).toBeGreaterThanOrEqual(320);
    }
  });
});
