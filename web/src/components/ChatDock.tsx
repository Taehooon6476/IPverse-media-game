import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { MODEL_LABEL, toolEventText, type Message, type ToolEvent } from '../types';
import { t, tn } from '../i18n';
import { IDEAS } from '../ideas';
import { local } from '../storage';
import { imageModels as imageModelsOf, shotModels, type ShotModel } from '../videoModels';
import { Dropdown } from './Dropdown';
import { TAB_EVENT } from './Tabs';

const AUTO = 'auto';
/** Sent on window by the top bar's skip link to the chat: the chat opens if it is shut, and the caret goes to its box. */
export const CHAT_BOX_EVENT = 'ipverse:chat-box';
/** A model as a dropdown option; one an approved Agent proposal added carries 신규. */
export const modelOption = (m: ShotModel) => ({ value: m.id, label: m.label, ...(m.promoted ? { badge: t('신규') } : {}) });

/** The agent picks a model when the message names it (server/prompts.py), so a pick becomes a short prefix. */
const MODEL_TAGS = /^(?:\[(?:이미지|영상) 모델: [^\]]+\]\s*)+/;

/** The 게임 설계 drawer's "[출연 IP cast_ip_ids=…] 이름(종류), …" (DesignDrawer castLine): the ids are for the agent. */
const CAST_TAG = /\[출연 IP cast_ip_ids=[^\]]*\]\s*/g;
/** What a drawer's request starts with for the agent (EditDrawer messageFor, GameEditDrawer editGameMessage,
 * DesignDrawer briefMessage, api.ts rebuildRequest), and the words the user pressed. */
const ACTION_TAGS: [tag: RegExp, action: string, chip: string][] = [
  [/^\[에셋 수정 ipId=[^\]]*\]\s*/, '이미지 수정', t('이미지 수정')],
  [/^\[영상 수정 jobId=[^\]]*\]\s*/, '영상 수정', t('영상 수정')],
  [/^\[게임 수정 gameId=[^\]]*\]\s*/, '게임 수정', t('게임 수정')],
  [/^\[트레일러 연출\]\s*/, '트레일러 연출', t('트레일러 연출')],
  [/^\[게임 설계\]\s*/, '게임 설계', t('게임 설계')],
];
/** A model pick's tag as its chip: the tag is the agent's and stays Korean, the chip is in the page's language. */
const modelChip = (tag: string) => {
  const [, kind, name] = tag.match(/^(이미지|영상) 모델: (.*)$/s) ?? [];
  return kind === '이미지' ? t('이미지 모델: {name}', { name }) : kind === '영상' ? t('영상 모델: {name}', { name }) : tag;
};
// a record's id as the server names it (ip_dbcdddaef0, gm_0540a4d435): never something the user typed
const RAW_ID = /(?:ip|job|gm|ast|ses|msg|ad)_[0-9a-f]{6,}/;

/** A user's message as the user meant it: the model picks and the drawer it came from as chips, and the text without
 * what only the agent reads (ids, enum codes, a skill's module line, the drawers' fixed instruction). */
export function userText(text: string): { chips: string[]; body: string } {
  const models = text.match(MODEL_TAGS)?.[0] ?? '';
  const chips = [...models.matchAll(/\[([^\]]+)\]/g)].map((tag) => modelChip(tag[1].replace(/ \([^)]*\)$/, '')));
  let body = text.slice(models.length);
  const action = ACTION_TAGS.find(([tag]) => tag.test(body));
  if (action) {
    chips.push(action[2]);
    body = body.replace(action[0], '');
    if (action[1] === '게임 설계') {
      body = body.replace(/^이 설계대로 3D 게임을 만들어줘\.\n?/, '')
        // what an example sends along for the AI (DesignDrawer Brief.spec)
        .replace(/^설계 지침: .*\n?/m, '')
        .replace(/^\[스킬 ([^\]]+)\] 장르 모듈: .*$/m, t('장르 스킬: {name}', { name: '$1' }))
        .replace(/[ \t]*\[[a-z0-9][a-z0-9_-]*\]/g, ''); // the choice's code after its name: "어려움 [hard]"
    } else if (action[1] === '게임 수정') {
      body = body.replace(/^'(.+?)'을\(를\) 이렇게 고친 새 버전을 만들어줘\. 나머지는 그대로 둬\.\n?/, '$1: ');
    } else if (action[1] === '트레일러 연출') {
      body = body.replace(/^전체 길이 약 (\d+)초, 영상 모델 (.+?)\.(?: 기존 트레일러\([^)]*\)를 이 연출로 다시 만든다\.)? 연출: /, `${t('약 {sec}초 · {model}', { sec: '$1', model: '$2' })}\n`);
    }
  }
  body = body.replace(CAST_TAG, t('출연 IP: '))
    .replace(new RegExp(`\\s*\\(${RAW_ID.source}\\)`, 'g'), ''); // "(ast_…)" after a name
  return { chips, body };
}

/** A message's text; a user's own keeps its model choice and ids for the agent, the bubble shows chips and names. */
function MessageText({ text, own }: { text: string; own: boolean }) {
  if (!own) return <p>{text}</p>;
  const { chips, body } = userText(text);
  return (
    <>
      {chips.length > 0 && <p className="chat-model-chips">{chips.map((c) => <span key={c} className="badge">{c}</span>)}</p>}
      {body && <p>{body}</p>}
    </>
  );
}

/** Both tags carry the model id too: the MCPs may list models this app has no name for (server/prompts.py). */
export function withModels(text: string, image: string, video: string, videoLabel?: string, imageLabel?: string): string {
  const tags = [image !== AUTO && `[이미지 모델: ${imageLabel ?? MODEL_LABEL[image] ?? image} (${image})]`,
    video !== AUTO && `[영상 모델: ${videoLabel ?? MODEL_LABEL[video] ?? video} (${video})]`].filter(Boolean);
  return tags.length ? `${tags.join(' ')} ${text}` : text;
}

/** 작업 기록 lines in short Korean (toolEventText): no raw ids, a failure's English or field-name reason only behind
 * 자세히, and a failure the agent then got right in the same turn says so. */
function ToolEventItems({ events }: { events: ToolEvent[] }) {
  const lines = events.map((e) => toolEventText(e.summary));
  return (
    <>
      {lines.map((l, i) => (
        <li key={i} className={l.failed ? 'tool-event tool-event--failed' : 'tool-event'}>
          <span className="tick" aria-hidden="true">•</span>
          <span className="tool-event-text">
            {l.text}{l.failed && lines.slice(i + 1).some((n) => !n.failed && n.label === l.label) ? t(' · 다시 시도해 성공') : ''}
          </span>
          {l.detail && (
            <details className="tool-event-detail">
              <summary>{t('자세히')}</summary>
              <p>{l.detail}</p>
            </details>
          )}
        </li>
      ))}
    </>
  );
}

const DOCK_KEY = 'ipverse.dock';
const HEAD_H = 40; // the bar that stays when the bottom dock is hidden
const RAIL_W = 44; // the strip that stays when the chat column is folded
const MIN_H = 150;
const MIN_W = 300;
/** What every browser has stored so far, dragged or not (the dock wrote its default on every load): read as "not set". */
const LEGACY_H = 230;
const maxH = () => Math.round(window.innerHeight * 0.75);
const maxW = () => Math.max(MIN_W, Math.round(window.innerWidth * 0.5));
const clampH = (h: number) => Math.min(Math.max(Math.round(h), MIN_H), maxH());
const clampW = (w: number) => Math.min(Math.max(Math.round(w), MIN_W), maxW());
/** The bottom dock until the user drags it: about a third of the window, 230–340 px. */
const defaultH = () => clampH(Math.min(340, Math.max(LEGACY_H, window.innerHeight * 0.36)));
/** The chat column until the user drags it: 340 px in a 1280 px window (each pane then still holds two cards a row),
 * growing with the window to 420 px at 1515 px; 320 px below 1220 px, where the panes are one column beside it. */
const defaultW = () => clampW(Math.min(420, Math.max(320, window.innerWidth * 0.34 - 95)));

function useMedia(query: string) {
  const [on, setOn] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const m = matchMedia(query);
    const change = () => setOn(m.matches);
    m.addEventListener('change', change);
    return () => m.removeEventListener('change', change);
  }, [query]);
  return on;
}

interface Dock { h?: number; w?: number; hidden: boolean }
function savedDock(): Dock {
  try {
    const { h, w, hidden } = JSON.parse(local.get(DOCK_KEY) ?? '{}');
    return { ...(typeof h === 'number' && h !== LEGACY_H ? { h } : {}), ...(typeof w === 'number' ? { w } : {}), hidden: hidden === true };
  } catch {
    return { hidden: false };
  }
}

/** Where the chat stands and how big it is, kept per browser. From 900 px it is a column right of the panes (`side`);
 * narrower, it is the dock under the panes; on phones (`narrow`) only its bar stays and the chat is a drawer. The
 * size the user dragged (h under the panes, w beside them) and the folded state are kept; without one the size
 * follows the window. It drives --dock-h and --chat-w on <html>, which the app grid follows. */
function useDock(narrow: boolean, side: boolean) {
  const [dock, setDock] = useState<Dock>(savedDock);
  const [, resized] = useReducer((n: number) => n + 1, 0); // the defaults and the limits follow the window
  useEffect(() => {
    addEventListener('resize', resized);
    return () => removeEventListener('resize', resized);
  }, []);
  const h = clampH(dock.h ?? defaultH());
  const w = clampW(dock.w ?? defaultW());
  useLayoutEffect(() => {
    const root = document.documentElement.style;
    root.setProperty('--dock-h', `${narrow ? HEAD_H : side ? 0 : dock.hidden ? HEAD_H : h}px`);
    if (side && !narrow) root.setProperty('--chat-w', `${dock.hidden ? RAIL_W : w}px`);
    else root.removeProperty('--chat-w');
  }, [dock.hidden, h, w, narrow, side]);
  useEffect(() => {
    local.set(DOCK_KEY, JSON.stringify(dock)); // blocked storage: the size lasts for this page
  }, [dock]);
  useEffect(() => () => {
    document.documentElement.style.removeProperty('--dock-h');
    document.documentElement.style.removeProperty('--chat-w');
  }, []);
  return { dock, setDock, h, w };
}

interface Props {
  /** The open session: its log starts at its end, and a new one (no message yet) gets the focus in its message box. */
  sessionId?: string;
  messages: Message[];
  draft: string;
  onDraft: (text: string) => void;
  onSend: (text: string) => void;
  /** True while a turn is pending (or the snapshot is still loading). The textarea goes read-only, not
   * disabled, so it keeps focus and the user can type the next message the moment the turn ends. */
  disabled: boolean;
  /** The session's first snapshot has not come: the box says it is loading, not that a request is being made. */
  loading?: boolean;
  /** ... and it did not load (the pane beside the chat says why, with 다시 시도): the chat says so too, not that it
   * is loading. */
  failed?: boolean;
  /** The video models the attached MCP lists (shotModels), the built-in three until they load. */
  videoModels?: ShotModel[];
  /** The image models the image MCP lists plus Stable Image Ultra (imageModels), Krea and klein until they load. */
  imageModels?: ShotModel[];
}

/** How near its end (px) the log must be to follow new lines down. */
const FOLLOW_PX = 48;
/** How far the message box grows with its text, in lines; longer text scrolls inside it. */
const MAX_LINES = 5;
/** The most the server takes as one message, counted as it counts: by character, over the whole line it gets, the
 * model picks' tags among them (server/app.py MAX_CHAT_CHARS, len(text)). */
export const MAX_CHARS = 4000;
/** From this many characters the box shows the count. */
const COUNT_FROM = 3600;
const number = (n: number) => n.toLocaleString('ko-KR');
/** What the chat says of a session whose first snapshot did not come (the pane beside it says why, with a retry). */
const NOT_LOADED = t('세션을 불러오지 못했어요.');

export function ChatDock({ sessionId, messages, draft, onDraft, onSend, disabled, loading = false, failed = false, videoModels = shotModels(null),
  imageModels = imageModelsOf(null) }: Props) {
  const log = useRef<HTMLDivElement>(null);
  const section = useRef<HTMLElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  // phones: the chat is a Drawer over the page (full screen), opened from the bar at the bottom
  const narrow = useMedia('(max-width: 767px)');
  const side = useMedia('(min-width: 900px)') && !narrow;
  const { dock, setDock, h, w } = useDock(narrow, side);
  const [drawer, setDrawer] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!narrow || !drawer) return;
    const el = section.current;
    // the caret after what waits in the box, so typing goes behind an example idea
    focusBox();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') { setDrawer(false); opener.current?.focus(); return; }
      if (e.key !== 'Tab' || !el) return;
      const f = [...el.querySelectorAll<HTMLElement>('button:not(:disabled), textarea, [tabindex="0"]')].filter((x) => x.offsetParent);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1)!.focus(); }
      else if (!e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- focusBox reads refs only
  }, [narrow, drawer]);
  // a toast's link opened a tab of the panes (Tabs.tsx openTab): on a phone the open chat covers them
  useEffect(() => {
    const away = () => setDrawer(false);
    window.addEventListener(TAB_EVENT, away);
    return () => window.removeEventListener(TAB_EVENT, away);
  }, []);
  const shut = narrow ? !drawer : dock.hidden;

  function drag(e: ReactPointerEvent<HTMLDivElement>) {
    if (dock.hidden || e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    document.documentElement.classList.add('is-resizing-dock');
    const start = { x: e.clientX, y: e.clientY };
    // beside the panes the handle is the column's left edge; under them, the dock's top edge
    const move = (ev: PointerEvent) => setDock((d) => (side
      ? { ...d, w: clampW(w + start.x - ev.clientX), hidden: false }
      : { ...d, h: clampH(h + start.y - ev.clientY), hidden: false }));
    const up = () => {
      document.documentElement.classList.remove('is-resizing-dock');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  }
  function onHandleKey(e: KeyboardEvent<HTMLDivElement>) {
    const step = e.shiftKey ? 80 : 24;
    const grow = side ? 'ArrowLeft' : 'ArrowUp'; // the edge moves away from the chat
    const shrink = side ? 'ArrowRight' : 'ArrowDown';
    const now = side ? w : h;
    const next = e.key === grow ? now + step : e.key === shrink ? now - step
      : e.key === 'Home' ? (side ? maxW() : maxH()) : e.key === 'End' ? (side ? MIN_W : MIN_H) : null;
    if (next === null) return;
    e.preventDefault();
    setDock((d) => (side ? { ...d, w: clampW(next), hidden: false } : { ...d, h: clampH(next), hidden: false }));
  }
  /** Double click: back to the size that follows the window. */
  const resetSize = () => setDock((d) => (side ? { hidden: false, ...(d.h ? { h: d.h } : {}) } : { hidden: false, ...(d.w ? { w: d.w } : {}) }));
  const [imageModel, setImageModel] = useState(AUTO);
  const [videoModel, setVideoModel] = useState(AUTO);
  const videoOptions = useMemo(() => [{ value: AUTO, label: t('영상 · 자동') }, ...videoModels.map(modelOption)], [videoModels]);
  const imageOptions = useMemo(() => [{ value: AUTO, label: t('이미지 · 자동') }, ...imageModels.map(modelOption)], [imageModels]);
  // a pick the MCP no longer lists falls back to 자동 (the dropdown could not show it, the tag must not send it)
  useEffect(() => { if (videoModel !== AUTO && !videoModels.some((m) => m.id === videoModel)) setVideoModel(AUTO); }, [videoModels, videoModel]);
  useEffect(() => { if (imageModel !== AUTO && !imageModels.some((m) => m.id === imageModel)) setImageModel(AUTO); }, [imageModels, imageModel]);
  const toolEventCount = messages.reduce((n, m) => n + (m.toolEvents?.length ?? 0), 0);
  // The log follows its end only while the reader is at it (within 48 px), when the session changes, and for the
  // user's own new line: a tool event must not pull away whoever reads further up. `behind`: something new is below.
  const atEnd = useRef(true);
  const seen = useRef<{ session?: string; count: number }>({ count: 0 });
  const [behind, setBehind] = useState(false);
  const toEnd = () => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
    atEnd.current = true;
    setBehind(false);
  };
  useLayoutEffect(() => {
    if (shut) return;
    const was = seen.current;
    const opened = was.session !== sessionId || was.count === 0;
    const own = messages.slice(was.count).some((m) => m.role === 'user');
    seen.current = { session: sessionId, count: messages.length };
    if (opened || own || atEnd.current) toEnd();
    else setBehind(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the log's content, not the array's identity
  }, [sessionId, shut, messages.length, toolEventCount, messages.at(-1)?.status]);
  const onLogScroll = () => {
    const el = log.current;
    if (!el) return;
    atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_PX;
    if (atEnd.current) setBehind(false);
  };

  /** The caret in the message box, at the end of what is there. */
  const focusBox = () => {
    const el = composer.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    requestAnimationFrame(() => el.setSelectionRange(el.value.length, el.value.length));
  };
  // The top bar's skip link to the chat (TopBar). Folded, or as the phone's shut drawer, the box is display:none and
  // takes no focus: the chat opens first, then the caret goes there.
  const boxAsked = useRef(false);
  useEffect(() => {
    const toBox = () => {
      if (!shut) { focusBox(); return; }
      boxAsked.current = true;
      if (narrow) setDrawer(true); // (the drawer's own effect puts the caret in the box too)
      else setDock((d) => ({ ...d, hidden: false }));
    };
    window.addEventListener(CHAT_BOX_EVENT, toBox);
    return () => window.removeEventListener(CHAT_BOX_EVENT, toBox);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- focusBox reads refs only
  }, [shut, narrow]);
  useEffect(() => {
    if (shut || !boxAsked.current) return;
    boxAsked.current = false;
    focusBox();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the chat the link asked for has opened
  }, [shut]);
  // A session with nothing said yet opens with the caret in the box. Once per session; not over a dialog and not out
  // of a field the user is in. On a phone the chat is a closed drawer: it opens for such a session.
  const greeted = useRef<string | undefined | null>(null);
  useEffect(() => {
    if (loading || messages.length > 0 || greeted.current === sessionId) return;
    if (narrow) {
      greeted.current = sessionId;
      setDrawer(true); // the drawer's own effect puts the caret in the box
      return;
    }
    if (shut) return;
    greeted.current = sessionId;
    const at = document.activeElement;
    if (at instanceof HTMLElement && at !== document.body && at !== composer.current
      && (at.closest('[role="dialog"], [role="alertdialog"], [role="menu"]') || /^(INPUT|TEXTAREA|SELECT)$/.test(at.tagName))) return;
    focusBox();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per session, with the draft it opened with
  }, [loading, narrow, shut, messages.length, sessionId]);

  // The message box grows with what is in it, up to MAX_LINES, and goes back to its stylesheet height once that fits
  // again.
  useLayoutEffect(() => {
    const el = composer.current;
    if (!el || shut) return;
    el.style.height = ''; // the stylesheet's own (44 px on a phone, 76 px in the column)
    if (el.scrollHeight <= el.clientHeight) return;
    const style = getComputedStyle(el);
    const frame = el.offsetHeight - el.clientHeight; // its border
    const most = MAX_LINES * (parseFloat(style.lineHeight) || 20) + (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
    el.style.height = `${Math.ceil(Math.min(el.scrollHeight, most) + frame)}px`;
  }, [draft, shut, narrow, side]);

  /** An example goes into the box, never over what is typed there: after it, on its own line. */
  const useExample = (example: string) => {
    onDraft(draft.trim() ? `${draft.replace(/\s+$/, '')}\n${example}` : example);
    focusBox();
  };

  // The line as it goes out, and how long the server will find it. The count shows near the limit; past it 보내기
  // waits and says by how much (nothing typed is cut: what to drop is the writer's choice).
  const line = draft.trim() ? withModels(draft.trim(), imageModel, videoModel, videoModels.find((m) => m.id === videoModel)?.label,
    imageModels.find((m) => m.id === imageModel)?.label) : '';
  const chars = [...line].length;
  const over = chars > MAX_CHARS;
  const blocked = disabled || !line || over;
  function send() {
    if (blocked) { focusBox(); return; } // 보내기 stays focusable: pressed too early, it shows where to type
    onSend(line);
  }
  // why 보내기 would do nothing, where the user looks
  const help = failed ? NOT_LOADED : loading ? t('세션을 불러오고 있어요.')
    : disabled ? t('답변을 만드는 중이에요. 끝나면 보낼 수 있어요.')
      : !line ? t('내용을 입력하면 보낼 수 있어요.')
        : over ? t('{max}자까지 보낼 수 있어요. {over}자 줄여 주세요.', { max: number(MAX_CHARS), over: number(chars - MAX_CHARS) })
          : narrow ? '' : t('Enter 보내기 · Shift + Enter 줄바꿈'); // a phone's keyboard has no such keys

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // keyCode 229: Safari reports the Enter that commits a Korean IME composition this way.
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    send();
  }

  return (
    <section ref={section} className={`chat${shut ? ' is-hidden' : ''}${narrow ? ' chat--drawer' : ''}${narrow && drawer ? ' is-open' : ''}${side ? ' chat--side' : ''}`}
      aria-label={t('채팅')} role={narrow && drawer ? 'dialog' : undefined} aria-modal={narrow && drawer ? true : undefined}>
      <div className="chat-head">
        {/* drag (or the arrow keys) to resize, double click for the size that follows the window; the panes take the
            rest */}
        <div className="chat-resize" role="separator" aria-orientation={side ? 'vertical' : 'horizontal'}
          aria-label={side ? t('채팅창 너비') : t('채팅창 높이')} title={side ? t('드래그해서 채팅창 너비 조절') : t('드래그해서 채팅창 높이 조절')}
          aria-valuemin={side ? MIN_W : MIN_H} aria-valuemax={side ? maxW() : maxH()}
          aria-valuenow={side ? (dock.hidden ? RAIL_W : w) : dock.hidden ? HEAD_H : h} tabIndex={dock.hidden ? -1 : 0}
          onPointerDown={drag} onKeyDown={onHandleKey} onDoubleClick={resetSize} />
        <span className="chat-head-title">{t('AI와 만들기')}{shut && messages.length ? tn(' · {n}개 메시지', messages.length) : ''}</span>
        <button ref={opener} type="button" className="btn btn-sm btn-ghost chat-toggle" aria-expanded={!shut} aria-controls="chat-body"
          aria-label={side ? (dock.hidden ? t('채팅 열기') : t('채팅 접기')) : undefined} title={side ? (dock.hidden ? t('채팅 열기') : t('채팅 접기')) : undefined}
          onClick={() => (narrow ? setDrawer((o) => !o) : setDock((d) => ({ ...d, hidden: !d.hidden })))}>
          {narrow ? (drawer ? `× ${t('닫기')}` : `▴ ${t('채팅 열기')}`) : side ? (dock.hidden ? '◂' : `${t('접기')} ▸`) : dock.hidden ? `▴ ${t('채팅 열기')}` : `▾ ${t('채팅 숨기기')}`}
        </button>
      </div>
      <div id="chat-body" className="chat-body" hidden={shut}>
      <div className="chat-log-wrap">
      <div ref={log} className="chat-log" role="log" aria-label={t('대화 기록')} aria-relevant="additions text" tabIndex={0} onScroll={onLogScroll}
        onKeyDown={(e) => {
          // One Tab from the log to the message box, past the 작업 기록 lines. They stay reachable: Shift+Tab from the box
          // walks back through them.
          if (e.key !== 'Tab' || e.shiftKey || e.target !== e.currentTarget || e.metaKey || e.ctrlKey || e.altKey) return;
          e.preventDefault();
          composer.current?.focus();
        }}>
        {failed ? <p className="chat-hint" role="status">{NOT_LOADED}</p>
          : loading && <p className="chat-hint loading-state" role="status"><span className="spinner" aria-hidden="true" />{t('세션을 불러오고 있어요…')}</p>}
        {!loading && messages.length === 0 && (
          <div className="chat-hint chat-intro">
            <strong>{t('어떤 세계를 만들고 싶나요?')}</strong>
            <p>{t('캐릭터나 소품을 한 줄로 적어 보세요. 그림이 나오면 3D, 영상, 게임으로 이어서 만들 수 있어요.')}</p>
            {/* examples as buttons: a press puts one in the box */}
            <div className="chat-examples" role="group" aria-label={t('예시: 누르면 입력창에 들어가요')}>
              {IDEAS.slice(0, 3).map((idea) => (
                <button key={idea} type="button" className="chip-btn chat-example" onClick={() => useExample(idea)}>{idea}</button>
              ))}
            </div>
            <small>{t('예시를 누르면 입력창에 들어가요. 고친 뒤 보내면 돼요.')}</small>
          </div>
        )}
        {messages.map((m) => {
          const events = m.toolEvents ?? [];
          return (
            <div key={m.messageId} className={`msg msg--${m.role} msg--${m.status}`}>
              <div className="bubble">
                {m.status === 'failed' && <span className="msg-flag">{t('요청을 완료하지 못했어요')}</span>}
                {m.text && <MessageText text={m.text} own={m.role === 'user'} />}
                {m.status === 'pending' && m.role === 'assistant' && (
                  <ul className="progress" aria-label={t('진행 상황')}>
                    <ToolEventItems events={events} />
                    <li className="thinking"><span className="spinner" aria-hidden="true" />{t('요청을 처리하고 있어요…')}</li>
                  </ul>
                )}
                {m.status !== 'pending' && events.length > 0 && (
                  <details className="tool-log">
                    <summary>{t('작업 기록 {n}건', { n: events.length })}</summary>
                    <ul className="progress">
                      <ToolEventItems events={events} />
                    </ul>
                  </details>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {behind && <button type="button" className="btn btn-sm chat-jump" onClick={toEnd}>↓ {t('새 내용 보기')}</button>}
      </div>
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        {/* the message box first, then the model pickers and 보내기: the order on screen in both layouts, and one Tab
            from the log to the box */}
        <div className="composer-input">
          <label htmlFor="composer" className="sr-only">{t('만들거나 수정할 내용')}</label>
          <textarea
            ref={composer}
            id="composer"
            rows={2}
            value={draft}
            readOnly={disabled}
            aria-disabled={disabled}
            aria-describedby={chars >= COUNT_FROM ? 'composer-help composer-count' : 'composer-help'}
            placeholder={failed ? NOT_LOADED : loading ? t('세션을 불러오고 있어요…') : disabled ? t('답변을 만드는 중이에요. 끝나면 이어서 입력할 수 있어요.')
              : narrow ? t('무엇을 만들까요?') : t('만들고 싶은 것이나 바꾸고 싶은 내용을 적어 주세요')}
            onChange={(e) => onDraft(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <small id="composer-help" className="composer-help">{help}</small>
          {chars >= COUNT_FROM && <small id="composer-count" className={over ? 'composer-count is-over' : 'composer-count'}>{t('{n} / {max}자', { n: number(chars), max: number(MAX_CHARS) })}</small>}
        </div>
        <div className="composer-models" role="group" aria-label={t('생성 모델 선택')}>
          <Dropdown label={t('이미지 모델')} value={imageModel} options={imageOptions} onChange={setImageModel} hideLabel />
          <Dropdown label={t('영상 모델')} value={videoModel} options={videoOptions} onChange={setVideoModel} hideLabel />
        </div>
        {/* aria-disabled, not disabled: it stays in the Tab order and says why it waits (composer-help) */}
        <button type="submit" className="btn btn-primary composer-send" aria-disabled={blocked || undefined} aria-describedby="composer-help"
          title={blocked ? help : t('요청 보내기')}>{t('보내기')}</button>
      </form>
      </div>
    </section>
  );
}
