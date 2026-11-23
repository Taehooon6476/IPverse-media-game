// The browser's storage, for a page that must draw without it. A browser that blocks a site's data throws at the
// read of window.localStorage itself, a full one at setItem. What is kept through here is a convenience (a fold's
// state, a draft, a pane's width); auth.ts alone cannot do without and says so (NO_STORAGE).
function safe(area: () => Storage) {
  return {
    /** The kept value; null when there is none or storage is blocked. */
    get(key: string): string | null {
      try { return area().getItem(key); } catch { return null; }
    },
    /** false when it could not be kept (blocked or full). */
    set(key: string, value: string): boolean {
      try { area().setItem(key, value); return true; } catch { return false; }
    },
    remove(key: string): void {
      try { area().removeItem(key); } catch { /* nothing was kept */ }
    },
  };
}

/** Per browser. */
export const local = safe(() => localStorage);
/** Per tab. */
export const session = safe(() => sessionStorage);
