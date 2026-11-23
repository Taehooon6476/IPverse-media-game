import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CornerAd } from './components/AdOverlays';

// A corner whose video fails is dropped: its impression goes out when the video plays, not when the corner mounts.
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

async function corner() {
  const onEvent = vi.fn();
  const onDone = vi.fn();
  await act(async () => root.render(<CornerAd url="https://cdn/ads/x_trailer.mp4" title="네온 러너" onEvent={onEvent} onDone={onDone} />));
  const video = container.querySelector('video')!;
  const fire = (type: string) => act(async () => { video.dispatchEvent(new Event(type)); });
  return { onEvent, onDone, fire };
}

describe('a corner trailer', () => {
  it('logs its impression when its video starts playing, once', async () => {
    const { onEvent, fire } = await corner();
    expect(onEvent).not.toHaveBeenCalled(); // mounted, nothing on screen yet
    await fire('playing');
    expect(onEvent.mock.calls).toEqual([['impression']]);
    await fire('waiting');
    await fire('playing'); // playing again after a stall: the same showing
    expect(onEvent.mock.calls).toEqual([['impression']]);
  });

  it('logs nothing when its creative fails to load, and goes', async () => {
    const { onEvent, onDone, fire } = await corner();
    await fire('error');
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onEvent).not.toHaveBeenCalled(); // no impression for a corner nobody saw
  });
});
