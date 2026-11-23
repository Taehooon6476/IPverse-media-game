import { t } from '../i18n';
import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';

// Hash state: `#s=<sessionId>&ip=<tab>&game=<tab>`; replaceState keeps tab switches out of history.
export function readHash(key: string): string | null {
  return new URLSearchParams(location.hash.slice(1)).get(key);
}

/** push: a history entry of its own, for a step Back should undo (opening another session). */
export function writeHash(key: string, value: string | null, push = false): void {
  const params = new URLSearchParams(location.hash.slice(1));
  if (value === null) params.delete(key);
  else params.set(key, value);
  history[push ? 'pushState' : 'replaceState'](null, '', `${location.pathname}${location.search}#${params}`);
}

/** The address with no hash at all: the start screen's and the login page's. The tab keys are a session's state. */
export function clearHash(push = false): void {
  history[push ? 'pushState' : 'replaceState'](null, '', `${location.pathname}${location.search}`);
}

/** Sent on window by openTab: {hashKey, id}. The phone's chat drawer closes on it, so the tab is in sight. */
export const TAB_EVENT = 'ipverse:tab';
/** A tab's name with how many it holds, for a screen reader (said here: in the list below a tab is named t). */
const counted = (label: string, count: number) => t('{label} · {count}개', { label, count });
/** Shows a tab of a tab bar that is on the page (a finished job's toast opens its result); with no such bar the
 * hash still says it for the next one. */
export function openTab(hashKey: string, id: string): void {
  writeHash(hashKey, id);
  window.dispatchEvent(new CustomEvent(TAB_EVENT, { detail: { hashKey, id } }));
}

export interface TabDef {
  id: string;
  label: string;
  count?: number;
}

interface Props {
  /** Hash key that stores the selected tab, also the id prefix. */
  hashKey: string;
  label: string;
  tabs: TabDef[];
  children: (active: string) => ReactNode;
}

export function Tabs({ hashKey, label, tabs, children }: Props) {
  const [active, setActive] = useState(() => {
    const fromHash = readHash(hashKey);
    return tabs.find((t) => t.id === fromHash)?.id ?? tabs[0].id;
  });
  const ids = tabs.map((t) => t.id).join(' ');
  useEffect(() => { // openTab() from outside the bar
    const on = (e: Event) => {
      const { hashKey: key, id } = (e as CustomEvent<{ hashKey: string; id: string }>).detail;
      if (key === hashKey && ids.split(' ').includes(id)) setActive(id);
    };
    window.addEventListener(TAB_EVENT, on);
    return () => window.removeEventListener(TAB_EVENT, on);
  }, [hashKey, ids]);
  const tabId = (id: string) => `${hashKey}-tab-${id}`;
  const panelId = (id: string) => `${hashKey}-panel-${id}`;

  function select(id: string) {
    setActive(id);
    writeHash(hashKey, id);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.metaKey || e.ctrlKey || e.altKey) return; // Alt+Arrow (history) and other browser shortcuts
    const i = tabs.findIndex((t) => t.id === active);
    const n = tabs.length;
    const next = ({ ArrowRight: (i + 1) % n, ArrowLeft: (i - 1 + n) % n, Home: 0, End: n - 1 } as Record<string, number>)[e.key];
    if (next === undefined) return;
    e.preventDefault();
    select(tabs[next].id);
    document.getElementById(tabId(tabs[next].id))?.focus();
  }

  return (
    <div className="tabs">
      <div role="tablist" aria-label={label} className="tablist" onKeyDown={onKeyDown}>
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={tabId(t.id)}
            className="tab"
            aria-label={t.count === undefined ? t.label : counted(t.label, t.count)}
            aria-selected={t.id === active}
            aria-controls={panelId(t.id)}
            tabIndex={t.id === active ? 0 : -1}
            onClick={() => select(t.id)}
          >
            <span className="tab-label">{t.label}</span>
            {t.count !== undefined && <span className="tab-count" aria-hidden="true">{t.count}</span>}
          </button>
        ))}
      </div>
      {tabs.map((t) => (
        <div
          key={t.id}
          role="tabpanel"
          id={panelId(t.id)}
          aria-labelledby={tabId(t.id)}
          className="tabpanel"
          tabIndex={0}
          hidden={t.id !== active}
        >
          {t.id === active && children(t.id)}
        </div>
      ))}
    </div>
  );
}
