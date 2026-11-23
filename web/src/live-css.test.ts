import { describe, expect, it } from 'vitest';

// The live windows' layout and text rules, read from the stylesheets (jsdom lays nothing out).
const fs = (await import('node:fs' as string)) as { existsSync: (p: string) => boolean; readFileSync: (p: string, e: 'utf8') => string };
const read = (name: string) => fs.readFileSync([`src/${name}`, `web/src/${name}`].find((p) => fs.existsSync(p))!, 'utf8'); // run from web/ or the repo root
const origin = read('origin.css');
const css = `${read('styles.css')}\n${origin}`; // the order the page loads them in

/** Every rule (in order, media queries flattened): its selector list and its declarations. */
const all = (source = css) => [...source.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map((m) => ({ selectors: m[1].split(',').map((s) => s.trim()), body: m[2] }));
const rules = (selector: string, source = css) => all(source).filter((r) => r.selectors.includes(selector)).map((r) => r.body);
/** A media block of origin.css from its opening line (as written) to the brace that closes it. */
function block(opening: string): string {
  const from = origin.indexOf(opening);
  expect(from, opening).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = origin.indexOf('{', from); i < origin.length; i++) {
    if (origin[i] === '{') depth++;
    else if (origin[i] === '}' && --depth === 0) return origin.slice(from, i + 1);
  }
  return origin.slice(from);
}

// On air the console's stage must not keep its room at laptop heights: the ad styles, their values and 고급 설정 stay in sight.
describe("R20-36: the console's stage gives way to its controls, on air too", () => {
  it('the console is a column whose stage alone shrinks, down to a floor', () => {
    expect(rules('.game-modal > *').join(';')).toMatch(/flex-shrink:\s*0/);
    const stage = rules('.game-modal > .game-modal-stage')[0];
    expect(stage).toMatch(/flex-shrink:\s*1/);
    expect(Number(stage.match(/min-height:\s*(\d+)px/)?.[1])).toBeGreaterThanOrEqual(200); // a picture on air, not a strip
    const setup = rules('.game-modal > .game-modal-stage--setup')[0];
    expect(Number(setup.match(/min-height:\s*(\d+)px/)?.[1])).toBeGreaterThanOrEqual(160); // its sentence, button and note
    // it still has its caps: the window's height on air, a fixed size before a broadcast
    expect(rules('.game-modal-stage').join(';')).toMatch(/max-height:\s*calc\(100dvh - \d+px\)/);
    expect(rules('.game-modal-stage--setup').join(';')).toMatch(/max-height:\s*min\(\d+vh,\s*\d+px\)/);
    expect(rules('.modal.game-modal').join(';')).toMatch(/overflow-y:\s*auto/); // what does not fit scrolls inside the console
  });

  it('a phone keeps the stage 16:9 and scrolls: its console is taller than the window whatever the stage does', () => {
    expect(block('@media (max-width: 767.98px) {\n  .game-modal {')).toMatch(/\.game-modal > \.game-modal-stage \{ flex-shrink: 0; min-height: 0; \}/);
  });

  it('a corner trailer drawn on a short stage is never taller than it: its width follows the stage height', () => {
    expect(rules('.game-modal > .game-modal-stage')[0]).toMatch(/container-type:\s*size/);
    expect(rules('.game-modal-stage .corner-ad').join(';')).toMatch(/max-width:\s*calc\(\(100cqh - \d+px\) \* 16 \/ 9\)/);
    expect(rules('.game-modal-stage .corner-ad.is-big').join(';')).toMatch(/max-width:\s*calc\(\(100cqh/); // tapped big too
  });
});

// A narrow watch page must not be two scrollers stacked in a window that does not scroll.
describe('R20-36: a narrow watch page scrolls as one page', () => {
  const narrow = () => block('@media (max-width: 900px) {\n  .popup-window.watch');

  it('under 900 px the window itself scrolls, and neither the tiles nor the panel scroll inside it', () => {
    expect(narrow()).toMatch(/\.popup-window\.watch \{ display: block; overflow-y: auto; \}/);
    expect(narrow()).toMatch(/\.watch \.watch-split \{ height: auto; \}/);
    expect(narrow()).toMatch(/\.watch \.watch-grid, \.watch \.watch-side \{ overflow: visible; \}/);
    expect(rules('.popup-bar').join(';')).toMatch(/position:\s*sticky;\s*top:\s*0/); // the bar stays on top of the page
    // a tile's picture is its full 16:9 there: the cap that fits four tiles into one window is for the wide layout
    expect(narrow()).toMatch(/\.watch \.vt-stage \{ max-height: none; \}/);
    expect(rules('.vt-stage').join(';')).toMatch(/max-height:\s*calc\(50dvh - \d+px\)/);
  });

  it("the tiles' column is one screen tall while a card's game plays over it, and off air it has room for its sentence", () => {
    expect(narrow()).toMatch(/\.watch \.watch-split--grid \.watch-main\.is-playing \{ height: calc\(100dvh - \d+px\); overflow: hidden; \}/);
    expect(narrow()).toMatch(/\.watch \.watch-grid \{ min-height: \d+px; \}/);
  });

  it("the page's one line on what it shows stays in the bar there (the play window's 플레이 창 still goes)", () => {
    expect(narrow()).toMatch(/\.watch \.popup-title small \{ display: block;/);
    expect(origin).toMatch(/@media \(max-width: 900px\) \{ \.popup-title small \{ display: none; \}/);
  });

  it('one tile a row under 1100 px, as before', () => {
    expect(origin).toMatch(/@media \(max-width: 1100px\) \{ \.vt-grid, \.vt-body \{ grid-template-columns: minmax\(0, 1fr\); \} \}/);
  });
});

// The two notes are in the page for every device and shown where the pointer is a finger.
describe('R20-30: what needs a PC is said on a touch device, and only there', () => {
  it('the poster\'s note and the console\'s are off until the primary pointer is coarse', () => {
    for (const note of ['.keys-note', '.live-pc-note']) {
      expect(rules(note).join(';'), note).toMatch(/display:\s*none/);
      expect(origin).toMatch(new RegExp(`@media \\(pointer: coarse\\) \\{ \\${note} \\{ display: block; \\} \\}`));
    }
  });
});

// No text of the live windows or the game pane is under 12 px (.live-chips dt, the badges, the tiles' chips, the corner ad's 광고).
describe('R20-53: no text of the live windows or the game pane is set under 12 px', () => {
  // the classes of the console, the play window, the watch page and its tiles, the in-band ads, cloud play, the public
  // ad page and the game pane
  const LIVE = /\.(live-|vt-|corner-ad|play-card|popup-|watch-|hl-overlay|mirror-badge|lp-|standby-|ver-|console-|stage-notice|game-modal|view-switch|ad-type|preview-|game-start|game-needs|game-setting|game-poster|playable-ad|unreal-)/;

  it('every size these rules set is 12 px or more', () => {
    const small: string[] = [];
    for (const r of all()) {
      if (!r.selectors.some((s) => LIVE.test(s))) continue;
      for (const m of r.body.matchAll(/font(?:-size)?:[^;]*?\b(\d+(?:\.\d+)?)px/g)) if (Number(m[1]) < 12) small.push(`${r.selectors.join(', ')} { ${m[0]} }`);
    }
    expect(small).toEqual([]);
  });

  it('a <small> inside them is given its size: the browser would set it at five sixths of its line', () => {
    for (const selector of ['.vt-h small', '.watch-h small', '.watch-persona small', '.corner-ad figcaption small', '.popup-title small', '.play-card-wait small']) {
      expect(rules(selector).join(';'), selector).toMatch(/font-size:\s*1[2-9]px/);
    }
    expect(rules('.standby-row .gen-switch').join(';')).toMatch(/font-size:\s*12px/); // the console's switch (the shared rule is 11 px)
  });

  it('the corner trailer in a tile stays inside the tile with its text at 12 px: 광고 sits beside the title', () => {
    expect(rules('.vt-stage .corner-ad:not(.is-big) figcaption').join(';')).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\) auto/);
    expect(rules('.vt-stage .corner-ad:not(.is-big) .corner-ad-row').join(';')).toMatch(/grid-column:\s*1 \/ -1/);
  });
});
