import { describe, expect, it } from 'vitest';

// The layout rules of the live windows and the public ad page, read from the stylesheets (jsdom lays nothing out).
const fs = (await import('node:fs' as string)) as { existsSync: (p: string) => boolean; readFileSync: (p: string, e: 'utf8') => string };
const read = (name: string) => fs.readFileSync([`src/${name}`, `web/src/${name}`].find((p) => fs.existsSync(p))!, 'utf8'); // run from web/ or the repo root
const origin = read('origin.css');
const styles = read('styles.css');
const bare = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '');
/** Every rule of a source inside a media query whose condition has `condition`: selector lists and declarations. */
function within(source: string, condition: string) {
  const out: { selectors: string[]; body: string }[] = [];
  const text = bare(source);
  for (let from = text.indexOf('@media'); from >= 0; from = text.indexOf('@media', from + 1)) {
    const open = text.indexOf('{', from);
    if (!text.slice(from, open).includes(condition)) continue;
    let depth = 0;
    let end = open;
    for (; end < text.length; end++) {
      if (text[end] === '{') depth++;
      else if (text[end] === '}' && --depth === 0) break;
    }
    for (const m of text.slice(open + 1, end).matchAll(/([^{}]+)\{([^{}]*)\}/g)) out.push({ selectors: m[1].split(',').map((s) => s.trim()), body: m[2] });
  }
  return out;
}
const has = (rules: { selectors: string[]; body: string }[], selector: string, declaration: RegExp) =>
  rules.some((r) => r.selectors.includes(selector) && declaration.test(r.body));

// On a laptop-size window nothing of the console is cut by the fold (the footnote goes: it repeats the steps above it),
// and a phone's tile does not end its activity texts in an ellipsis whose tooltip no finger can open.
describe("R20-36's leftovers: nothing of the console is cut on a laptop, and a phone's tile cuts no text", () => {
  it('the console\'s footnote is not laid out on a window under 800 px tall: it stays the dialog\'s description', () => {
    expect(has(within(origin, 'max-height: 800px'), '.game-modal-hint', /display:\s*none/)).toBe(true);
    // (GameModal: aria-describedby="game-modal-hint" names it whether or not it is shown; live-control.test.tsx)
  });

  // without the footnote the 플레이어블 tab still scrolled inside at 1280x720 and 1024x768
  it('on such a window the console also takes more of the height and closes up, so its longest tab ends inside it', () => {
    const laptop = within(origin, 'max-height: 800px').filter((r) => !r.selectors.includes('.game-modal-hint'));
    expect(has(laptop, '.game-modal', /max-height:\s*calc\(100dvh - 16px\)/)).toBe(true);
    for (const selector of ['.game-modal-head', '.live-steps', '.game-modal .ad-type']) expect(has(laptop, selector, /padding-(block|bottom):/), selector).toBe(true);
    // a phone's console is the whole window already and scrolls as a page: not for it
    expect(bare(origin)).toMatch(/@media \(max-height: 800px\) and \(min-width: 768px\) \{\s*\.game-modal \{/);
  });

  it("a narrow watch page shows each activity line whole: it wraps instead of ending in an ellipsis", () => {
    const narrow = within(origin, 'max-width: 900px');
    expect(has(narrow, '.watch .vt-feed li span', /white-space:\s*normal/)).toBe(true);
    expect(has(narrow, '.watch .vt-feed li span', /overflow:\s*visible/)).toBe(true);
    // the wide layout keeps one line a row beside the ad history (its tooltip carries the rest)
    expect(bare(origin)).toMatch(/\.vt-feed li span \{[^}]*white-space:\s*nowrap/);
  });
});

// Under a finger (390 px wide) the controls of the live windows and the ad page are at least 40 px.
describe('R20-53: under a finger the controls of the live windows and the ad page are 40 px or more', () => {
  const phone = within(origin, 'max-width: 767.98px');
  const tall = /min-height:\s*4[0-9]px/;

  it('the console: its bar, its stage, its ad styles and what it draws over the stage', () => {
    for (const selector of ['.game-modal-bar .btn', '.game-modal .live-idle .btn', '.game-modal .ad-type .btn', '.game-modal .stage-notice .btn',
      '.game-modal .console-ad .btn', '.game-modal .gen-switch']) expect(has(phone, selector, tall), selector).toBe(true);
    expect(has(phone, '.game-modal .console-trailer .icon-btn', /width:\s*40px;\s*height:\s*40px/)).toBe(true);
  });

  it('the play window and the watch page: their bars, a failed load, the cards and the corner in a tile, the game over the tiles', () => {
    for (const selector of ['.popup-bar .btn', '.popup-every input', '.popup-window .load-error .btn', '.popup-window .play-card .btn',
      '.popup-window .lp-bar .btn', '.popup-window .lp-card .btn', '.popup-window .corner-ad .btn']) expect(has(phone, selector, tall), selector).toBe(true);
    expect(has(phone, '.popup-window .corner-ad-close', /width:\s*40px;\s*height:\s*40px/)).toBe(true);
    // the corner in a tile is wide enough for its row of 게임 보기 and a 40-px ×
    expect(Number(phone.find((r) => r.selectors.includes('.popup-window .vt-stage .corner-ad:not(.is-big)'))?.body.match(/width:\s*(\d+)px/)?.[1])).toBeGreaterThanOrEqual(140);
  });

  it('the public ad page: its wait, its end and its failure', () => {
    expect(has(within(styles, 'max-width: 767.98px'), '.playable-ad .btn', tall)).toBe(true);
  });

  it("the ad page's card for a game with no trailer sets its small line at 12 px or more", () => {
    expect(bare(styles)).toMatch(/\.playable-ad-pitch small \{[^}]*font-size:\s*1[2-9]px/);
  });
});
