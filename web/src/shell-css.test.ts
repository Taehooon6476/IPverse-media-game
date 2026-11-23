import { describe, expect, it } from 'vitest';

// The shell's layout rules, read from the stylesheets (jsdom lays nothing out).
const fs = (await import('node:fs' as string)) as { existsSync: (p: string) => boolean; readFileSync: (p: string, e: 'utf8') => string };
const read = (name: string) => fs.readFileSync([`src/${name}`, `web/src/${name}`].find((p) => fs.existsSync(p))!, 'utf8'); // run from web/ or the repo root
const styles = read('styles.css');
const origin = read('origin.css');
const css = `${styles}\n${origin}`; // the order the page loads them in

/** Every rule (in order, media queries flattened) whose selector list names `selector` exactly: its declarations. */
function rules(selector: string, source = css): string[] {
  const out: string[] = [];
  for (const m of source.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1].split(',').some((s) => s.trim() === selector)) out.push(m[2]);
  }
  return out;
}
const declared = (selector: string, property: string, source = css) => rules(selector, source)
  .map((body) => body.match(new RegExp(`(?:^|[;\\s])${property}:\\s*([^;]+)`))?.[1].trim()).filter(Boolean) as string[];

describe('R20-11: the page cannot scroll behind the shell', () => {
  it('the shell and its scrollers are the containing block of what is positioned inside them', () => {
    for (const scroller of ['.app', '.split', '.tabpanel', '.chat-log']) expect(declared(scroller, 'position')).toContain('relative');
    expect(declared('.app', 'overflow')).toContain('hidden');
    expect(declared('.app', 'height')).toContain('100dvh');
  });
});

describe('R20-12: the chat is a column beside the panes from 900 px (from 1200 px in round 20)', () => {
  const wide = origin.slice(origin.indexOf('@media (min-width: 900px) {\n  .app'), origin.indexOf('/* the session\'s name, changed in place'));
  it('the app grid gives the chat its own column and the panes the full height', () => {
    expect(wide).toMatch(/\.app \{ grid-template-columns: minmax\(0, 1fr\) var\(--chat-w, 380px\); grid-template-rows: var\(--header-h\) auto minmax\(0, 1fr\);\s+grid-template-areas: "header header" "hero chat" "main chat"; \}/);
    expect(wide).toMatch(/\.app:not\(:has\(\.chat\)\) \{ grid-template-columns: minmax\(0, 1fr\);[^}]*grid-template-areas: "header" "main"; \}/); // the start screen
    expect(wide).toMatch(/@media \(min-width: 1680px\) \{\s+\.app \{ grid-template-columns: var\(--sidebar-w\) minmax\(0, 1fr\) var\(--chat-w, 380px\);/);
  });
  it('the navigation is the drawer until 1680 px, and one pane a row below 1200 px', () => {
    expect(origin).toMatch(/@media \(max-width: 1679\.98px\) \{\s+\.app \{[^}]*\}\s+\.sidebar \{\s+position: fixed;/);
    expect(origin).toMatch(/@media \(max-width: 1199\.98px\) \{\s+\.split \{ grid-template-columns: minmax\(0, 1fr\);/);
  });
  it('the two panes share the width by the handle between them, where they stand side by side', () => {
    expect(origin).toMatch(/@media \(min-width: 1200px\) \{\s+\.split:not\(\.split--empty\) \{ grid-template-columns: minmax\(min\(420px, 46%\), var\(--split-a, 1fr\)\) 16px minmax\(min\(420px, 46%\), var\(--split-b, 1fr\)\); column-gap: 0; \}/);
    expect(rules('.split-handle')[0]).toMatch(/display:\s*none/); // one column: nothing to share
  });
  // At this width a chat docked under one column of panes would hide the first card's buttons and the game pane.
  it('between 900 and 1199 px the panes are one column beside the chat, each at most as tall as the workspace less a strip', () => {
    const mid = origin.match(/@media \(min-width: 900px\) and \(max-width: 1199\.98px\) \{([\s\S]*?)\n\}/)![1];
    expect(mid).toMatch(/\.pane \{ max-height: max\(calc\(100dvh - var\(--header-h\) - 132px\), 440px\); \}/);
    expect(mid).toMatch(/\.split \{ grid-auto-rows: max-content; \}/); // a row as tall as its pane, not both squeezed into the window
    expect(mid).toMatch(/\.tabpanel \{ overscroll-behavior: auto; \}/); // at a pane's end the wheel goes on to the next
    // only where the chat is under the panes is a pane as tall as its content (the workspace scrolls as one there)
    expect(origin).toMatch(/@media \(max-width: 899\.98px\) \{\s+\.pane \{ min-height: auto; overflow: visible; \}\s+\.tabpanel \{ overflow: visible;/);
    expect(origin).not.toMatch(/@media \(max-width: 1024px\) \{\s+\.split/);
  });
  it('no dock is reserved until the chat says how tall it is', () => {
    expect(declared(':root', '--dock-h')[0]).toBe('0px');
    expect(origin).toContain('@property --dock-h { syntax: "<length>"; inherits: true; initial-value: 0px; }');
  });
});

describe('R20-37: the sidebar scrolls as one', () => {
  it('the scroller takes the room and scrolls; the session list and the connection list do not scroll inside it', () => {
    const scroller = rules('.side-scroll').join(';');
    expect(scroller).toMatch(/flex:\s*1/);
    expect(scroller).toMatch(/min-height:\s*0/);
    expect(scroller).toMatch(/overflow-y:\s*auto/);
    expect(rules('.side-scroll .session-list').join(';')).toMatch(/flex:\s*none;\s*overflow:\s*visible/);
    expect(rules('.side-scroll .conn-mini').join(';')).toMatch(/max-height:\s*none;\s*overflow:\s*visible/);
  });
});

// With both folds open the session list still has rows in the first view.
describe('new finding 25: open folds leave the session list its first rows', () => {
  it('an open fold\'s content scrolls inside a share of the window; two open folds halve it', () => {
    expect(declared('.side-scroll', '--fold-room').at(-1)).toMatch(/^max\(\d+px, calc\(100dvh - \d+px\)\)$/);
    const one = rules('.side-scroll > .fold > .fold-region[data-open] > .fold-inner').join(';');
    expect(one).toMatch(/max-height:\s*var\(--fold-room\)/);
    expect(one).toMatch(/overflow-y:\s*auto/);
    expect(rules('.side-scroll:has(#work-acc-region[data-open]):has(#conn-acc-region[data-open]) > .fold > .fold-region > .fold-inner').join(';'))
      .toMatch(/max-height:\s*calc\(var\(--fold-room\) \/ 2\)/);
  });
});

// Bordered, rounded boxes in a row above the one real button read as buttons that cannot be pressed.
describe('new finding 29: the start screen\'s steps read as a line of text, not as buttons', () => {
  it('a step has no box of its own', () => {
    const step = rules('.start-step').join(';');
    expect(step).not.toMatch(/border|padding|height|background/);
    expect(rules('.start-step--idea').join(';')).not.toMatch(/border/);
  });
});

describe('R20-18: where a toast stands and what stops its clock', () => {
  it('stands at the foot of the workspace, left of the chat column and above the dock, over everything', () => {
    const toasts = rules('.toasts').join(';');
    expect(toasts).toMatch(/right:\s*calc\(var\(--chat-w, 0px\) \+ 16px\)/);
    expect(toasts).toMatch(/bottom:\s*calc\(var\(--dock-h, 0px\) \+ 12px\)/);
    expect(toasts).not.toMatch(/top:/);
    expect(toasts).toMatch(/z-index:\s*80/); // the phone's open chat is 70
    expect(rules('.app:has(.chat--drawer.is-open) ~ .toasts').join(';')).toMatch(/top:\s*52px;\s*bottom:\s*auto/);
  });
  // 버전 기록 renders on <body>, not as the stack's sibling: a toast must not lie over its rows or its 닫기.
  it('steps left of a drawer on <body> as of a drawer beside it', () => {
    const beside = rules('.drawer-root ~ .toasts', origin).at(-1)!;
    expect(beside).toMatch(/right:\s*max\(calc\(440px \+ 16px\), calc\(var\(--chat-w, 0px\) \+ 16px\)\)/);
    expect(rules('body:has(> .drawer-root) .toasts', origin).at(-1)).toBe(beside);
  });
  it('its clock does not stop on :hover', () => {
    expect(css).not.toMatch(/\.toast:hover\s+\.toast-life/);
    expect(rules('.toast.is-held .toast-life').join(';')).toMatch(/animation-play-state:\s*paused/);
    expect(rules('.toasts.is-away .toast-life').join(';')).toMatch(/animation-play-state:\s*paused/);
  });
});

describe('R20-53 (shell): text of 12 px at least, touch targets of 40 px on a phone, focus that shows', () => {
  it('no text of the shell is set under 12 px', () => {
    const shell = ['.eyebrow', '.brand-name small', '.side-label', '.side-fold-head', '.fold-meta', '.session-meta', '.conn-mini-meta', '.tab-count',
      '.composer-help', '.chat-intro small', '.chat-head-title', '.status-pill', '.breadcrumb', '.menu-item small', '.menu-status', '.jobs-menu-hint',
      '.jobs-menu-provider', '.hint', '.field-hint', '.start-hint', '.start-count', '.start-session-time', '.sidebar-who', '.hero-rename-count',
      '.tool-event-detail[open] > p', '.toast-open',
      '.pane-num']; // the 01 / 02 of the two pane heads
    const last = shell.map((s) => [s, declared(s, 'font-size').at(-1)]);
    expect(last.filter(([, size]) => !size)).toEqual([]); // each is named in the stylesheets
    expect(last.filter(([, size]) => parseFloat(size!) < 12)).toEqual([]);
    expect(css).not.toMatch(/\.new-session kbd\s*\{[^}]*font-size/); // the 8 px NEW keycap is gone
    // the chat's model dropdowns: 신규 on a model an agent's proposal added (its rule lives with the agents')
    expect(parseFloat(declared('.option-badge', 'font-size', read('agents.css')).at(-1)!)).toBeGreaterThanOrEqual(12);
  });
  it('the phone layout gives the shell\'s small controls 40 px', () => {
    const start = origin.indexOf("/* the shell's touch targets: 40 px at least");
    const phone = origin.slice(start, origin.indexOf('}\n@media (min-width: 900px)', start));
    expect(origin.lastIndexOf('@media (max-width: 767.98px) {', start)).toBeGreaterThan(0);
    for (const selector of ['.menu-btn', '.hero-rename', '.session-delete', '.session-rename']) expect(phone).toMatch(new RegExp(`${selector.replace('.', '\\.')}[^{]*\\{[^}]*width: 40px; height: 40px`));
    expect(phone).toMatch(/\.session-list \.session-row--tools \.session \{ padding-right: 90px; \}/); // the name ends before the two of them
    expect(phone).toMatch(/\.tab \{ height: 40px; \}/);
    expect(phone).toMatch(/\.chat-toggle, \.chat-jump, \.chat-example, \.sidebar-foot \.btn, \.jobs-menu-btn, \.conn-mini-row \{ min-height: 40px; \}/);
    expect(styles).toMatch(/@media \(max-width: 767px\) \{ \.toast-close \{ width: 40px; height: 40px; \}/);
  });
  // At 390 px every remaining target is at least 40 px.
  it('… and the rest a thumb must hit there: small buttons, the title\'s ✎, the version chip, chips, summaries, the agents\' row', () => {
    const start = origin.indexOf("/* the shell's touch targets: 40 px at least");
    const phone = origin.slice(start, origin.indexOf('}\n@media (min-width: 900px)', start));
    expect(phone).toMatch(/\.page-hero \.hero-rename \{ width: 40px; height: 40px; \}/); // over .hero-rename's own 28 px, whatever the order
    expect(phone).toMatch(/\.app \.btn-sm, \.drawer \.btn-sm, \.modal:not\(\.game-modal, \.big-game\) \.btn-sm, \.toasts \.btn-sm \{ min-height: 40px; \}/);
    expect(phone).toMatch(/\.page-hero \.hero-rename-form input, \.new-session-form input \{ height: 40px; \}/); // (over the field's own 32 px)
    expect(phone).toMatch(/\.version-btn \{ min-width: 44px; min-height: 40px;/);
    expect(phone).toMatch(/\.preview-bar \.menu-trigger \{ min-width: 44px; \}/);
    expect(phone).toMatch(/\.tool-log > summary,[^{]*\{ padding-block: 11px; \}/);
    // a line's link that is the only way to what it offers
    expect(phone).toMatch(/\.card-note \.link-btn, \.design-drawer \.link-btn,[^{]*\{ display: inline-flex; align-items: center; min-height: 40px; \}/);
    expect(phone).toMatch(/\.conn-form \.btn \{ min-height: 40px; \}/);
    expect(declared('.cutout-toggle', 'min-height').at(-1)).toBe('40px');
    expect(declared('.chip-btn', 'min-height').at(-1)).toBe('40px');
    expect(declared('.card-media .cutout-toggle', 'min-height').at(-1)).toBe('40px'); // under a finger, on any width
    const agents = read('agents.css');
    const agentsPhone = agents.slice(agents.indexOf('@media (max-width: 767.98px)'));
    expect(agentsPhone).toMatch(/\.agent-icon-btn \{ width: 40px; height: 40px; \}/);
    expect(agentsPhone).toMatch(/\.agent-switch \{ min-width: 44px; min-height: 40px;/);
  });
  // Between 768 and 1024 px the sidebar is a drawer with whole rows, so a row's buttons are the wide sidebar's.
  it('in the drawer a row\'s two buttons are the wide sidebar\'s: 28 px, centred, the name ending before them', () => {
    const drawer = origin.slice(origin.indexOf('@media (max-width: 1679.98px) {\n  .app {'), origin.indexOf('@media (max-width: 767.98px) {\n  .page-hero'));
    expect(drawer).toMatch(/\.session-delete \{ top: 50%; right: 6px; translate: 0 -50%; width: 28px; height: 28px; \}/);
    expect(rules('.session-rename', origin)[0]).toMatch(/top: 50%; right: 38px; translate: 0 -50%;[^}]*width: 28px; height: 28px/);
    expect(declared('.session-list .session-row--tools .session', 'padding-right')[0]).toBe('72px');
  });
  it('the keyboard\'s place shows as a ring on a menu item, a list option and the chat\'s resize handle', () => {
    expect(rules('.menu-item:focus-visible').at(-1)).toMatch(/outline:\s*2px solid var\(--lime\)/);
    expect(rules('.listbox:focus .is-active').at(-1)).toMatch(/outline:\s*2px solid var\(--accent\)/);
    expect(rules('.chat-resize:focus-visible::after').at(-1)).toMatch(/outline:\s*2px solid var\(--lime\)/);
  });
  it('a field\'s edge and the selected tab\'s count can be told from their ground', () => {
    expect(origin).toMatch(/:where\(input:not\(\[type="radio"\]\), select, textarea\) \{[^}]*border-color:\s*#667059/);
    expect(rules('.tab[aria-selected="true"] .tab-count').at(-1)).toMatch(/color:\s*#ffb489/);
    expect(css).not.toMatch(/\.composer textarea\[aria-disabled="true"\]\s*\{[^}]*opacity/); // opacity would dim the read-only box's placeholder below contrast
  });
  it('a tab is as wide as its label and count', () => {
    expect(declared('.tab', 'flex').at(-1)).toBe('1 0 auto'); // it grows into spare width and is never cut
    expect(declared('.tablist', 'overflow-x').at(-1)).toBe('auto'); // a row that does not fit scrolls sideways
  });
});
