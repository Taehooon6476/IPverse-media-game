// 크게 보기 fills most of the viewport on desktop; in cloud run mode it enlarges the GameLift stream itself (same <video>, same session).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Game } from './types';

// vitest stubs CSS imports (even ?raw), so the stylesheet is read from disk; the specifier is a string so no node types are needed
const fs = (await import('node:fs' as string)) as { existsSync: (p: string) => boolean; readFileSync: (p: string, e: 'utf8') => string };
const css = fs.readFileSync(['src/styles.css', 'web/src/styles.css'].find((p) => fs.existsSync(p))!, 'utf8'); // run from web/ or the repo root

const api = vi.hoisted(() => ({ getRelease: vi.fn(), startStream: vi.fn(), pollStream: vi.fn(), stopStream: vi.fn() }));
vi.mock('./api', () => api);
const sdk = vi.hoisted(() => ({ last: null as null | { clientConnection: { connectionState: (s: string) => void } }, closed: 0 }));
vi.mock('./vendor/gameliftstreams/gameliftstreams-1.3.0.mjs', () => ({
  GameLiftStreams: class {
    constructor(opts: never) { sdk.last = opts; }
    generateSignalRequest() { return Promise.resolve('offer'); }
    processSignalResponse() { return Promise.resolve(); }
    attachInput() {}
    close() { sdk.closed += 1; }
  },
}));
const { UnrealStream } = await import('./components/UnrealStream');

const game = { gameId: 'gm_b870737b47', title: '별빛 정찰병', genre: 'sf-shooter', specKey: 'k', previewUrl: 'https://cdn.invalid/games/gm_b870737b47/index.html',
  createdAt: '2026-11-05T00:00:00Z' } as Game;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  sdk.closed = 0;
  api.getRelease.mockResolvedValue({ ad: null });
  api.stopStream.mockResolvedValue({});
  api.startStream.mockResolvedValue({ streamId: 's1', status: 'ACTIVE', signalResponse: 'answer', gameId: game.gameId });
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

describe('M24: 크게 보기 in cloud run mode enlarges the stream itself', () => {
  const mount = (big: boolean, onBigClose = vi.fn()) =>
    act(async () => root.render(<UnrealStream sessionId="ses_1" game={game} kind="web" big={big} onBigClose={onBigClose} />));

  it('keeps the same video and session, in a dialog that closes back to the inline preview', async () => {
    const onBigClose = vi.fn();
    await mount(false, onBigClose);
    await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === '클라우드로 플레이')!.click());
    await flush();
    expect(container.querySelector('.badge--done')!.textContent).toBe('스트리밍 중');
    const video = container.querySelector('video.unreal-video');

    await mount(true, onBigClose);
    const dialog = container.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="stream-big-title"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.contains(video)).toBe(true); // the very element the stream plays in: no reconnect
    expect(container.querySelectorAll('video.unreal-video')).toHaveLength(1);
    expect(container.querySelector('iframe')).toBeNull(); // never a local browser copy
    expect(api.startStream).toHaveBeenCalledTimes(1);
    expect([sdk.closed, api.stopStream.mock.calls.length]).toEqual([0, 0]);

    await act(async () => dialog.querySelector<HTMLButtonElement>('button[aria-label="닫기"]')!.click());
    expect(onBigClose).toHaveBeenCalledOnce();
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(onBigClose).toHaveBeenCalledTimes(2);

    await mount(false, onBigClose);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('video.unreal-video')).toBe(video);
    expect([sdk.closed, api.stopStream.mock.calls.length]).toEqual([0, 0]);
  });
});

describe('M21: the 크게 보기 modal fills most of the viewport on desktop', () => {
  it('sizes .modal.big-game from the viewport, not a 560 px cap', () => {
    const rule = css.match(/\n\.modal\.big-game[^{]*\{([^}]*)\}/)![1]; // the desktop rule, not the one under 640 px
    expect(rule).not.toMatch(/560px/);
    expect(rule).toMatch(/9[0-9]vw/);
    expect(css).toMatch(/\.big-game-frame[^{]*\{[^}]*(?:vh|dvh)/); // the frame's height follows the viewport too
  });
});
