import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SplitPanes } from './components/SplitPanes';

// The share between the two panes is the user's, and it is kept.
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
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

const render = () => act(async () => root.render(<SplitPanes left={<section id="ip">IP</section>} right={<section id="game">게임</section>} />));
const main = () => container.querySelector<HTMLElement>('main#main')!;
const handle = () => container.querySelector<HTMLElement>('.split-handle')!;
const columns = () => [main().style.getPropertyValue('--split-a'), main().style.getPropertyValue('--split-b')];
const key = (k: string, shiftKey = false) => act(async () => { handle().dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey, bubbles: true, cancelable: true })); });

describe('the split between the IP pane and the game pane is the user\'s to set, and is kept (R20-12)', () => {
  it('is half and half with a handle between the panes until it is moved', async () => {
    await render();
    expect([...main().children].map((c) => c.id || c.className)).toEqual(['ip', 'split-handle', 'game']);
    expect(columns()).toEqual(['', '']); // the stylesheet's 1fr 1fr
    expect([handle().getAttribute('role'), handle().getAttribute('aria-orientation'), handle().getAttribute('aria-valuenow'), handle().tabIndex, handle().title])
      .toEqual(['separator', 'vertical', '50', 0, '드래그해서 두 창의 너비 조절']);
    expect(localStorage.getItem('ipverse.split')).toBeNull();
  });

  it('moves with the arrow keys between 30% and 70%, and a reload keeps the share', async () => {
    await render();
    await key('ArrowRight');
    expect(columns()).toEqual(['52fr', '48fr']);
    await key('ArrowRight', true);
    await key('ArrowRight', true);
    await key('ArrowRight', true);
    expect(columns()).toEqual(['70fr', '30fr']); // never squeezed shut
    expect(handle().getAttribute('aria-valuenow')).toBe('70');
    await key('Home');
    expect(columns()).toEqual(['30fr', '70fr']);
    await key('ArrowRight', true);
    expect(localStorage.getItem('ipverse.split')).toBe('0.4');
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(columns()).toEqual(['40fr', '60fr']);
  });

  it('follows the pointer while the handle is dragged, and a double click gives half and half back', async () => {
    await render();
    main().getBoundingClientRect = () => ({ left: 0, width: 1000, top: 0, height: 600, right: 1000, bottom: 600, x: 0, y: 0, toJSON: () => ({}) });
    handle().setPointerCapture = vi.fn();
    const pointer = (type: string, clientX: number) => act(async () => {
      handle().dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0 }));
    });
    await pointer('pointerdown', 500);
    expect(document.documentElement.classList.contains('is-resizing-split')).toBe(true);
    await pointer('pointermove', 620);
    expect(columns()).toEqual(['62fr', '38fr']);
    await pointer('pointermove', 950); // past the limit
    expect(columns()).toEqual(['70fr', '30fr']);
    await pointer('pointerup', 950);
    expect(document.documentElement.classList.contains('is-resizing-split')).toBe(false);
    await pointer('pointermove', 400); // no longer dragging
    expect(columns()).toEqual(['70fr', '30fr']);
    await act(async () => { handle().dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    expect(columns()).toEqual(['', '']);
    expect(localStorage.getItem('ipverse.split')).toBeNull();
  });

  it('ignores a stored value that is no share', async () => {
    localStorage.setItem('ipverse.split', '"wide"');
    await render();
    expect(columns()).toEqual(['', '']);
    localStorage.setItem('ipverse.split', '0.95');
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(columns()).toEqual(['', '']);
  });
});
