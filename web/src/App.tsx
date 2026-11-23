import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as api from './api';
import { ApiError, AuthError, MAKE_HELD, NO_SESSION, REBUILD_GAME, bareHeroes, diffJobs, errorMessage, gameOffer, heldGame, heldOffer, pollInterval,
  rebuildRequest } from './api';
import * as auth from './auth';
import { said, t } from './i18n';
import { ideaTitle } from './ideas';
import { local, session } from './storage';
import { useAgents } from './agents';
import { ActionButton } from './components/ActionButton';
import { AgentDialog } from './components/AgentDialog';
import { AgentInbox } from './components/AgentInbox';
import { AgentList } from './components/AgentList';
import { ChatDock } from './components/ChatDock';
import { ConnectionsDrawer } from './components/ConnectionsDrawer';
import { GameEditDrawer } from './components/GameEditDrawer';
import { DesignDrawer } from './components/DesignDrawer';
import { EditDrawer, type EditTarget } from './components/EditDrawer';
import { GameModal } from './components/GameModal';
import { toChat } from './components/GameNeeds';
import { GamePane } from './components/GamePane';
import { IpPane } from './components/IpPane';
import { imageModels, shotModels } from './videoModels';
import { Login } from './components/Login';
import { PlayWindow } from './components/PlayWindow';
import { PublishModal } from './components/PublishModal';
import { WatchWindow } from './components/WatchWindow';
import { PlayableAdPage } from './components/PlayableAdPage';
import { SessionTitle } from './components/SessionTitle';
import { Sidebar } from './components/Sidebar';
import { SkillsDrawer } from './components/SkillsDrawer';
import { Skeleton } from './components/Skeleton';
import { SplitPanes } from './components/SplitPanes';
import { StartScreen } from './components/StartScreen';
import { clearHash, openTab, readHash, writeHash } from './components/Tabs';
import { Toasts, toolNotice, type Toast } from './components/Toasts';
import { TopBar } from './components/TopBar';
import { isHex, ownGenre, type Game, type GameDesignRequest, type Genre, type Job, type SessionSummary, type Snapshot, type ToastEvent } from './types';

/** Message ids of the held game requests this browser has offered (newest last): each is offered once, also across page loads. */
const OFFERED_KEY = 'ipverse.gameOffered';
function offeredGames(): string[] {
  try {
    const ids: unknown = JSON.parse(local.get(OFFERED_KEY) ?? '[]');
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/** The chat lines typed and not sent, by session, for this tab (a reload keeps them). */
const DRAFTS_KEY = 'ipverse.drafts';
function savedDrafts(): Record<string, string> {
  try {
    const drafts: unknown = JSON.parse(session.get(DRAFTS_KEY) ?? '{}');
    return drafts && typeof drafts === 'object' && !Array.isArray(drafts) ? drafts as Record<string, string> : {};
  } catch {
    return {};
  }
}

/** How often a load that got no answer is tried again while the connection is cut. */
const RETRY_MS = 5000;
/** No answer came at all (offline, a dropped connection): api.ts http() says so with status 0. */
const noAnswer = (e: unknown) => e instanceof ApiError && e.status === 0;

/** The browser tab's title: each window names what it is, the studio its open session. */
export const pageTitle = (sessionTitle?: string) => (readHash('play') ? `${t('플레이 창')} · IPverse Studio` : readHash('watch') ? `${t('라이브 시청')} · IPverse Studio`
  : sessionTitle ? `${sessionTitle} · IPverse Studio` : 'IPverse Studio');

export default function App() {
  const [authed, setAuthed] = useState(() => auth.token() !== null);
  const [notice, setNotice] = useState<string | null>(null);
  // null: the list is loading, or (with sessionsError) did not load
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  // The open session is the one the address names, and only that: after a login the studio waits on the start screen.
  const [sessionId, setSessionId] = useState<string | null>(() => readHash('s'));
  /** The address named a session this account cannot open (deleted, or another account's): the start screen says so. */
  const [missing, setMissing] = useState(false);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  /** Why the open session's first snapshot has not come (its panes say so, with a retry). */
  const [loadError, setLoadError] = useState<string | null>(null);
  /** A session that was showing stopped answering: the top bar says so until a poll gets through. */
  const [offline, setOffline] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [drafts, setDrafts] = useState(savedDrafts);
  useEffect(() => {
    session.set(DRAFTS_KEY, JSON.stringify(drafts)); // blocked storage: the drafts last for this page
  }, [drafts]);
  const setDraft = useCallback((id: string, text: string) => setDrafts((all) => {
    if ((all[id] ?? '') === text) return all;
    const { [id]: _, ...rest } = all;
    return text ? { ...rest, [id]: text } : rest;
  }), []);
  const [sending, setSending] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [designing, setDesigning] = useState(false);
  const [expanded, setExpanded] = useState<{ game: Game; url: string } | null>(null);
  const [gameEdit, setGameEdit] = useState<{ game: Game; version: number } | null>(null);
  // the IP pane's own dialogs are open: they sit on <body>, so the page behind them is made inert
  const [paneModal, setPaneModal] = useState(false);
  const [connections, setConnections] = useState<api.Connections | null>(null);
  /** Why the connections did not load (the sidebar's block says so, with a retry). */
  const [connectionsError, setConnectionsError] = useState<string | null>(null);
  const videoModels = useMemo(() => shotModels(connections), [connections]); // the model dropdowns' options
  const pictureModels = useMemo(() => imageModels(connections), [connections]);
  const [connOpen, setConnOpen] = useState<null | { adding: boolean }>(null);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [agentDialog, setAgentDialog] = useState<null | { agent?: api.Agent }>(null);
  const [inboxOpen, setInboxOpen] = useState(false);

  const openId = useRef(sessionId);
  useEffect(() => {
    openId.current = sessionId;
  }, [sessionId]);
  /** A snapshot of the open session is on screen (a failed poll then is an outage, not a failed load). */
  const shown = useRef(false);

  const toastSeq = useRef(0);
  const lastJobs = useRef<{ id: string; jobs: Job[]; games: number } | null>(null);
  const pushToast = useCallback((t: ToastEvent) => {
    // the same message again replaces the older one instead of stacking
    setToasts((list) => {
      const kept = list.filter((x) => x.text !== t.text);
      // three at most; a plain toast gives way before one with a button, whose offer would otherwise be lost
      while (kept.length > 2) kept.splice(Math.max(0, kept.findIndex((x) => !x.action)), 1);
      return [...kept, { ...t, id: ++toastSeq.current }];
    });
  }, []);
  // toast actions owned by a component (e.g. 되돌리기): id -> callback
  const toastActions = useRef(new Map<string, () => void>());
  const notify = useCallback((text: string, action?: { label: string; run: () => void }) => {
    if (!action) { pushToast({ level: 'ok', text }); return; }
    const id = `local-${toastSeq.current + 1}`;
    toastActions.current.set(id, action.run);
    pushToast({ level: 'ok', text, action: { id, label: action.label } });
  }, [pushToast]);
  const dismissToast = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), []);
  /** Takes a standing 게임에 반영 away: what it offered is answered, or it belongs to another session. */
  const dropRebuild = useCallback(() => setToasts((list) => (
    list.some((t) => t.action?.id === REBUILD_GAME) ? list.filter((t) => t.action?.id !== REBUILD_GAME) : list)), []);

  // `waiting`: a background load (the list, the connections) or the open session's poll got no answer. While it
  // holds, the failed loads are tried again every RETRY_MS (and when the browser says it is online); the first call
  // that gets through ends the wait and loads the rest (`recover`).
  const listFailed = useRef(false);
  const connFailed = useRef(false);
  /** ... and whether that failure was no answer at all (the wait tries those again) or the server's own error. */
  const listLost = useRef(false);
  const connLost = useRef(false);
  const waitingNow = useRef(false);
  const [waiting, setWaiting] = useState(false);
  const recover = useRef<() => void>(() => {});
  const lost = useCallback(() => { waitingNow.current = true; setWaiting(true); }, []);
  const reached = useCallback(() => {
    if (!waitingNow.current) return;
    waitingNow.current = false;
    setWaiting(false);
    recover.current();
  }, []);

  /** Closes what belongs to the open session (the live console, 장르 스킬, the edit drawers, 새 게임 설계, 게시하기, the
   * IP pane's dialogs): they render only with a session, and a flag left set would keep the next screen inert. */
  const closeSessionDialogs = useCallback(() => {
    setPublishOpen(false);
    setEditing(null);
    setDesigning(false);
    setExpanded(null);
    setGameEdit(null);
    setSkillsOpen(false);
    setPaneModal(false);
  }, []);

  /** Back to a blank studio, on 401 and on logout. signedOut: the place and the drafts go too; when the login only
   * ran out they stay, so the session opens again after the login with its draft. */
  const resetUiState = useCallback((signedOut: boolean) => {
    setSnap(null);
    shown.current = false;
    setSessions(null);
    setSessionsError(null);
    setLoadError(null);
    setOffline(false);
    setMissing(false);
    if (signedOut) {
      setSessionId(null);
      clearHash(); // the login page's address names no session and none of its tabs
      setDrafts({});
    }
    closeSessionDialogs(); // 장르 스킬 among them
    setConnOpen(null);
    setConnections(null);
    setConnectionsError(null);
    listFailed.current = false;
    connFailed.current = false;
    waitingNow.current = false;
    setWaiting(false);
    setAgentDialog(null);
    setInboxOpen(false);
    setNavOpen(false);
    setToasts([]);
    lastJobs.current = null;
  }, [closeSessionDialogs]);

  /** AuthError → login screen with the expiry message; anything else → error toast (a sentence: api.ts errorMessage). */
  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof AuthError) {
        resetUiState(false);
        setNotice(e.message);
        setAuthed(false);
      } else {
        pushToast({ level: 'error', text: errorMessage(e) });
      }
    },
    [pushToast, resetUiState],
  );

  /** Shows a session, or the start screen (null), as the address says; the dialogs of the session that is left close. */
  const show = useCallback((id: string | null) => {
    setNavOpen(false);
    if (id) setMissing(false);
    if (id === openId.current) return;
    openId.current = id;
    shown.current = false;
    setSessionId(id);
    setSnap(null);
    setLoadError(null);
    setOffline(false);
    closeSessionDialogs();
  }, [closeSessionDialogs]);
  /** Opens a session (null: the start screen) as its own history step, so Back returns to where the user was.
   * replace: the address was wrong (a deleted session), nothing to go back to. */
  const selectSession = useCallback((id: string | null, replace = false) => {
    // the start screen's address carries nothing of the session that was open (its tabs went with it)
    if (id === null) clearHash(!replace && openId.current !== null);
    else if (id !== openId.current) writeHash('s', id, !replace);
    show(id);
  }, [show]);
  // Back, Forward and a pasted #s= / #ad= / #play= link: follow the address (the hash is otherwise read only on render)
  const [hashTick, setHashTick] = useState(0);
  useEffect(() => {
    const on = () => { show(readHash('s')); setHashTick((t) => t + 1); };
    addEventListener('hashchange', on);
    addEventListener('popstate', on);
    return () => { removeEventListener('hashchange', on); removeEventListener('popstate', on); };
  }, [show]);

  // Every snapshot goes through here: job transitions become toasts, stale replies are dropped.
  const apply = useCallback(
    (s: Snapshot) => {
      const { sessionId: id, title, genre } = s.session;
      if (id !== openId.current) return;
      const last = lastJobs.current?.id === id ? lastJobs.current : null;
      // a game made since the last snapshot answers a standing 게임에 반영
      if (last && s.games.length > last.games) dropRebuild();
      const toasts = last ? diffJobs(last.jobs, s.jobs, gameOffer(s), s.ips, bareHeroes(s)) : [];
      // only where toasts show: a #play=, #watch= or #ad= window whose address also names a session shows another page
      const studio = !readHash('play') && !readHash('watch') && !readHash('ad');
      const offer = studio ? heldOffer(s, toasts, new Set(offeredGames())) : null;
      if (offer) {
        // a full or blocked storage: the offer may show once more, the snapshot still applies
        local.set(OFFERED_KEY, JSON.stringify([...offeredGames(), offer.messageId].slice(-50)));
        if (offer.toast) toasts.push(offer.toast);
      }
      toasts.forEach(pushToast);
      lastJobs.current = { id, jobs: s.jobs, games: s.games.length };
      shown.current = true;
      setSnap(s);
      setSessions((list) =>
        list?.some((x) => x.sessionId === id && (x.title !== title || x.genre !== genre))
          ? list.map((x) => (x.sessionId === id ? { ...x, title, genre } : x))
          : list,
      );
    },
    [pushToast, dropRebuild],
  );
  // a standing 게임에 반영 is the offer of the session it came up in: clicked on another, it would send that one a request
  useEffect(dropRebuild, [sessionId, dropRebuild]);

  // The session list: loading (null), loaded, or failed (null with sessionsError). It opens no session by itself.
  const listSeq = useRef(0);
  /** again: a retry after a failed load; what the list says stays until an answer is in. */
  const loadSessions = useCallback(async (again = false) => {
    const mine = ++listSeq.current;
    if (!again) setSessionsError(null);
    try {
      const { sessions } = await api.listSessions();
      if (mine !== listSeq.current) return;
      listFailed.current = false;
      setSessions(sessions);
      setSessionsError(null);
      reached();
    } catch (e) {
      if (mine !== listSeq.current) return; // a cancelled load (logout, StrictMode re-run) says nothing
      if (e instanceof AuthError) return fail(e);
      listFailed.current = true;
      listLost.current = noAnswer(e);
      setSessionsError(errorMessage(e));
      if (noAnswer(e)) lost(); // an answer that is an error waits for 다시 시도; no answer at all is tried again
    }
  }, [fail, lost, reached]);
  useEffect(() => {
    if (authed) void loadSessions();
    return () => { listSeq.current++; };
  }, [authed, loadSessions]);

  // Polling: 3 s while a turn is pending or a job is queued/running, else 10 s. pollNow() polls immediately.
  const pollNow = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    if (!authed || !sessionId) return;
    let alive = true;
    let timer = 0;
    let seq = 0;
    const poll = async () => {
      window.clearTimeout(timer);
      const mine = ++seq;
      let delay = 10000;
      try {
        const s = await api.getSession(sessionId);
        if (!alive || mine !== seq) return;
        apply(s);
        setLoadError(null);
        setOffline(false);
        reached();
        delay = pollInterval(s);
      } catch (e) {
        if (!alive || mine !== seq) return;
        if (e instanceof AuthError) return fail(e);
        if (e instanceof ApiError && e.status === 404 && e.code === NO_SESSION) {
          // the address names a session this account cannot open (deleted, or another account's): the start screen
          // says so. Only the server's own answer says that; any other 404 (the CDN's, a gateway's) is an outage.
          setMissing(true);
          return selectSession(null, true);
        }
        // No toast: the page itself says it and keeps trying
        if (shown.current) setOffline(true);
        else setLoadError(errorMessage(e));
        lost();
      }
      timer = window.setTimeout(poll, delay);
    };
    pollNow.current = poll;
    void poll();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [authed, sessionId, apply, fail, selectSession, lost, reached]);

  useEffect(() => {
    document.title = pageTitle(snap?.session.title);
  }, [snap, hashTick]);

  /** Rejects with the reason (the confirm dialog shows it); a deleted open session leaves the start screen. */
  const onDelete = useCallback(
    async (id: string) => {
      try {
        await api.deleteSession(id);
      } catch (e) {
        if (e instanceof AuthError) fail(e);
        throw e;
      }
      setSessions((list) => list?.filter((s) => s.sessionId !== id) ?? list);
      setDraft(id, '');
      if (openId.current === id) selectSession(null, true); // the address is gone with it: Back must not land there
      pushToast({ level: 'ok', text: t('세션을 지웠어요.') });
    },
    [fail, pushToast, selectSession, setDraft],
  );

  /** Makes a session and opens it. idea: a first line that waits in its chat box, not sent, and that names the
   * session when no title was typed. Resolves false on failure, so the sidebar keeps the form. No genre is sent. */
  const onCreate = useCallback(
    async (title: string, idea?: string): Promise<boolean> => {
      try {
        const { session } = await api.createSession(title || (idea ? ideaTitle(idea) : '') || undefined);
        const { sessionId: id, genre, createdAt } = session;
        setSessions((list) => [{ sessionId: id, title: session.title, genre, createdAt }, ...(list ?? [])]);
        if (idea) setDraft(id, idea);
        selectSession(id);
        return true;
      } catch (e) {
        fail(e);
        return false;
      }
    },
    [fail, selectSession, setDraft],
  );

  /** Whose chat send is on its way, if any: a line ('line') or a game the page offered ('game'). A ref beside
   * `sending`, which only draws it: a second press can come before the page is drawn again. */
  const onItsWay = useRef<'line' | 'game' | null>(null);
  /** Sends one line to the open session's chat, then loads the snapshot that shows it. Rejects when it was not sent, after saying why. */
  const post = useCallback(
    async (way: 'line' | 'game', text: string, gameDesign?: GameDesignRequest) => {
      if (!sessionId) return;
      onItsWay.current = way;
      setSending(true);
      try {
        await api.sendChat(sessionId, text, gameDesign);
        await pollNow.current();
      } catch (e) {
        fail(e);
        throw e;
      } finally {
        onItsWay.current = null;
        setSending(false);
      }
    },
    [sessionId, fail],
  );
  /** The message box's own line: the box is emptied once it is sent, and keeps it when it was not. */
  const onSend = useCallback(
    async (text: string) => {
      if (!sessionId) return;
      try {
        await post('line', text);
        setDraft(sessionId, '');
      } catch { /* post said why */ }
    },
    [sessionId, post, setDraft],
  );

  /** The session's name, changed in place (PATCH title). Rejects with the reason so the field can show it. */
  const onRename = useCallback(
    async (title: string) => {
      if (!sessionId) return;
      try {
        apply(await api.patchSession(sessionId, { title }));
        void pollNow.current(); // bumps the poll sequence, so an older poll still in flight cannot revert this
      } catch (e) {
        if (e instanceof AuthError) fail(e);
        throw e;
      }
    },
    [sessionId, apply, fail],
  );

  /** Renames a session from its row in the list: the open one as above, any other on the server and in the list.
   * Rejects with the reason so the row's field can show it. */
  const onRenameSession = useCallback(
    async (id: string, title: string) => {
      if (id === openId.current) return onRename(title);
      try {
        const { session } = await api.patchSession(id, { title });
        setSessions((list) => list?.map((x) => (x.sessionId === id ? { ...x, title: session.title } : x)) ?? list);
      } catch (e) {
        if (e instanceof AuthError) fail(e);
        throw e;
      }
    },
    [onRename, fail],
  );

  /** Edit drawer: the request goes through the chat like any other turn, so it shows in the log too. Rejects on
   * failure so the drawer keeps the typed text. */
  const onEditSend = useCallback(
    async (text: string, gameDesign?: GameDesignRequest) => {
      try {
        // with no session open nothing is sent, and the drawer must not close as if it had been
        if (!sessionId) throw said(t('열려 있는 세션이 없어 보내지 못했어요. 세션을 연 뒤 다시 보내 주세요.'));
        await api.sendChat(sessionId, text, gameDesign);
        // says only what is true now: the line is sent and its answer comes in the chat; a job it makes has its own toasts
        pushToast({ level: 'ok', text: gameDesign ? t('게임 설계와 IP 역할을 보냈어요. 진행 상황은 채팅에 보여요.') : t('요청을 보냈어요. 답변은 채팅에 보여요.') });
        void pollNow.current();
      } catch (e) {
        fail(e);
        throw e;
      }
    },
    [sessionId, pushToast, fail],
  );

  const onGenre = useCallback(
    async (genre: Genre) => {
      if (!sessionId) return;
      try {
        apply(await api.patchSession(sessionId, { genre }));
        void pollNow.current(); // bumps the poll sequence, so an older poll still in flight cannot revert this
      } catch (e) {
        fail(e);
      }
    },
    [sessionId, apply, fail],
  );

  const onPublish = useCallback(
    async (body: { gameId: string; adAssetId?: string; skipAfterSec: number; adEveryRounds: number }) => {
      try {
        const { publishedUrl } = await api.publishGame(sessionId!, body);
        pushToast({ level: 'ok', text: t('게임을 게시했어요.') });
        void pollNow.current();
        return publishedUrl;
      } catch (e) {
        fail(e);
        throw e;
      }
    },
    [sessionId, pushToast, fail],
  );

  /** 게시 내리기. Resolves once the session's games say so; rejects so the dialog keeps the game. */
  const onUnpublish = useCallback(
    async (gameId: string) => {
      try {
        await api.unpublishGame(sessionId!, gameId);
        await pollNow.current();
        pushToast({ level: 'ok', text: t('게시를 내렸어요.') });
      } catch (e) {
        fail(e);
        throw e;
      }
    },
    [sessionId, pushToast, fail],
  );

  /** Card buttons: run the tool directly (no composer). Rejects so the button can show the failure. */
  const onAction = useCallback(
    async (tool: string, args: Record<string, unknown>, background = false) => {
      if (!sessionId) return;
      try {
        if (background) await api.runToolAsync(sessionId, tool, args);
        else {
          // what the tool says beyond "registered", in a few words: its message is written for the agent
          const { result } = await api.runTool(sessionId, tool, args);
          const note = toolNotice(result);
          // a tool's warning is no success mark
          if (note) pushToast({ level: typeof result?.warning === 'string' && result.warning.trim() ? 'warn' : 'ok', text: note });
        }
        void pollNow.current();
      } catch (e) {
        // a refusal is written for the agent too ("사용자에게 알리고 … 안내하세요"): the toast keeps the user's sentence
        fail(e instanceof ApiError ? new ApiError(e.status, toolNotice({ message: e.message }) ?? e.message) : e);
        throw e;
      }
    },
    [sessionId, fail, pushToast],
  );

  const onRetry = useCallback(
    async (jobId: string) => {
      if (!sessionId) return;
      try {
        await api.retryJob(sessionId, jobId);
        void pollNow.current();
      } catch (e) {
        fail(e);
        throw e;
      }
    },
    [sessionId, fail],
  );

  const onCancelJob = useCallback(
    async (jobId: string) => {
      if (!sessionId) return;
      try {
        await api.cancelJob(sessionId, jobId);
        pushToast({ level: 'ok', text: t('작업을 중지했어요. 작업 현황 탭에서 다시 시도할 수 있어요.') });
        void pollNow.current();
      } catch (e) {
        fail(e);
        throw e;
      }
    },
    [sessionId, fail, pushToast],
  );

  /** Loads the connections (the sidebar's block, the model pickers). A background load says its failure where the
   * list would be, with a retry; asked (상태 새로고침): its failure is a toast like any failed press. */
  const loadConnections = useCallback(async (asked = false) => {
    try {
      const next = await api.listConnections();
      connFailed.current = false;
      setConnections(next);
      setConnectionsError(null);
      reached();
    } catch (e) {
      if (e instanceof AuthError || asked) fail(e);
      if (e instanceof AuthError) return;
      connFailed.current = true;
      connLost.current = noAnswer(e);
      setConnectionsError(errorMessage(e));
      if (noAnswer(e)) lost();
    }
  }, [fail, lost, reached]);
  useEffect(() => { if (authed) void loadConnections(); }, [authed, loadConnections]);
  // a promoted model joins the image/video catalog: read it again so the dropdowns list it (신규)
  const agentsState = useAgents(authed, () => void loadConnections());
  const { markSeen } = agentsState;
  useEffect(() => { if (inboxOpen) markSeen(); }, [inboxOpen, markSeen]);
  // The connection is back: what did not load while it was cut loads again, and the toast that said the server
  // could not be reached closes.
  recover.current = () => {
    setToasts((list) => (list.some((t) => t.level === 'error' && t.text === auth.OFFLINE && !t.passed)
      ? list.map((t) => (t.level === 'error' && t.text === auth.OFFLINE ? { ...t, passed: true } : t)) : list));
    if (listFailed.current) void loadSessions(true);
    if (connFailed.current) void loadConnections();
    if (agentsState.agents === null) { void agentsState.loadAgents(); void agentsState.loadInbox(); }
  };
  useEffect(() => {
    if (!authed || !waiting) return;
    // each load that got NO answer is tried again (an answer that is an error is not); the first answer ends the wait
    const again = () => {
      if (listFailed.current && listLost.current) void loadSessions(true);
      if (connFailed.current && connLost.current) void loadConnections();
    };
    const timer = window.setInterval(again, RETRY_MS);
    window.addEventListener('online', again);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('online', again);
    };
  }, [authed, waiting, loadSessions, loadConnections]);

  /** Sends the offered game (the toast's 게임 만들기 / 게임에 반영, the game pane's card). Resolves once the snapshot
   * shows the answer being made or there was nothing to send; rejects when the request was not sent. */
  const makeOffered = useCallback(
    async () => {
      if (!snap) return;
      // this very request is on its way: a second press inside its round trip would make two games
      if (onItsWay.current === 'game') return;
      const again = rebuildRequest(snap); // a request that waited for 3D again, or the newest game re-made with the new 3D
      if (!again) { // the request the toast offered gave way to a newer one whose hero has no 3D yet
        pushToast({ level: 'ok', text: t('주인공의 3D가 아직 끝나지 않아 지금은 게임을 만들 수 없어요.') });
      } else if (heldGame(snap) && (onItsWay.current === 'line' || snap.messages.some((m) => m.status === 'pending'))) {
        // the answer being made may be making this very game: a second copy would make it twice. The offer stays up
        // for when that answer is in; a game it made takes the offer away (apply).
        pushToast({ level: 'ok', text: t('지금 만드는 답변이 끝난 뒤에 눌러 주세요.'), action: { id: REBUILD_GAME, label: MAKE_HELD } });
      } else await post('game', again.text, again.gameDesign); // not the message box's line: what is typed there stays
    },
    [post, pushToast, snap],
  );
  const onToastAction = useCallback(
    (id: string) => {
      const local = toastActions.current.get(id);
      if (local) { toastActions.current.delete(id); local(); return; }
      if (id === REBUILD_GAME) void makeOffered().catch(() => undefined); // post said why
    },
    [makeOffered],
  );

  const onLogout = useCallback(() => {
    auth.clear();
    resetUiState(true);
    setNotice(null);
    setAuthed(false);
  }, [resetUiState]);

  const adId = readHash('ad');
  if (adId) return <PlayableAdPage key={adId} adId={adId} />; // public: no login
  if (!authed) {
    return (
      <Login
        // a browser that blocks the site's data cannot keep a login: said before anything is typed
        notice={notice ?? (auth.canKeep() ? null : auth.NO_STORAGE)}
        onLogin={async (username, password) => {
          await api.login(username, password);
          setNotice(null);
          setAuthed(true);
        }}
        onDemo={async () => {
          await api.demoLogin();
          setNotice(null);
          setAuthed(true);
        }}
      />
    );
  }

  // separate windows opened from the expanded game: #play=<session>&g=<game> and #watch=<session>
  const playId = readHash('play');
  const watchId = readHash('watch');
  if (playId) return <PlayWindow sessionId={playId} gameId={readHash('g') ?? ''} />;
  if (watchId) return <WatchWindow sessionId={watchId} />;

  const pending = snap?.messages.some((m) => m.status === 'pending') ?? false;
  const activeJobs = (snap?.jobs ?? []).filter((j) => j.status === 'queued' || j.status === 'running').map((job) => ({
    job, name: typeof job.input?.ipId === 'string' ? snap?.ips.find((ip) => ip.ipId === job.input.ipId)?.name
      : typeof job.input?.title === 'string' ? job.input.title : undefined }));
  const dialogOpen = publishOpen || editing !== null || designing || expanded !== null || gameEdit !== null || connOpen !== null || skillsOpen
    || agentDialog !== null || inboxOpen || paneModal;
  const concept = snap?.session.concept;
  const account = auth.account(); // the id typed at the login, and whether it is the shared demo account
  return (
    <>
      <div className="app" inert={dialogOpen}>
        <TopBar
          activeJobs={activeJobs}
          onCancelJob={onCancelJob}
          session={snap?.session ?? null}
          navOpen={navOpen}
          onMenu={() => setNavOpen((o) => !o)}
          onPublish={() => setPublishOpen(true)}
          onLogout={onLogout}
          onConnections={() => setConnOpen({ adding: false })}
          account={account}
          offline={offline}
          onHome={() => selectSession(null)}
          chat={!!sessionId}
        />
        <Sidebar
          sessions={sessions}
          sessionsError={sessionsError}
          onRetrySessions={() => void loadSessions()}
          connectionsError={connectionsError}
          onRetryConnections={() => loadConnections()}
          account={account}
          currentId={sessionId}
          open={navOpen}
          onClose={() => setNavOpen(false)}
          onSelect={selectSession}
          onHome={() => selectSession(null)}
          onCreate={onCreate}
          onPublish={() => setPublishOpen(true)}
          onLogout={onLogout}
          connections={connections}
          onConnections={(adding) => { setNavOpen(false); setConnOpen({ adding }); }}
          onSkills={snap ? () => { setNavOpen(false); setSkillsOpen(true); } : undefined}
          onDelete={onDelete}
          onRename={onRenameSession}
          agentCount={agentsState.agents?.length ?? 0}
          agents={<AgentList agents={agentsState.agents} unreachable={waiting} unread={agentsState.unread} putAgent={agentsState.putAgent}
            onRegister={() => { setNavOpen(false); setAgentDialog({}); }} onEdit={(agent) => { setNavOpen(false); setAgentDialog({ agent }); }}
            onInbox={() => { setNavOpen(false); setInboxOpen(true); }}
            onRan={() => { void agentsState.loadAgents(); void agentsState.loadInbox(); }} onNotice={(text) => pushToast({ level: 'ok', text })} onError={fail} />}
        />
        {sessionId ? (
          <>
            {snap && (
              // one row, to leave the height to the panes
              <section className="page-hero" aria-label={t('세션 소개')}>
                <SessionTitle key={snap.session.sessionId} title={snap.session.title} onRename={onRename} />
                <div className="hero-meta">
                  {/* a session has no genre of its own until it has a game or one was chosen */}
                  {ownGenre(snap.session, snap.games.length) && <span className="hero-chip hero-chip--genre">{ownGenre(snap.session, snap.games.length)}</span>}
                  {concept && (
                    <span className="hero-chip" title={concept.style}>
                      <span className="swatches" aria-hidden="true">
                        {(concept.palette ?? []).filter(isHex).slice(0, 3).map((c, i) => <i key={i} style={{ background: c }} />)}
                      </span>
                      {t('공통 IP · {n}개', { n: snap.ips.length })}
                    </span>
                  )}
                </div>
                <p className="hero-logline" title={concept?.logline}>
                  {concept?.logline ?? t('채팅에 아이디어를 한 줄 적으면 캐릭터·소품 그림부터 3D, 영상, 게임까지 이어서 만들어요.')}
                </p>
              </section>
            )}
            {!snap && loadError ? (
              // failed is not loading; the poll keeps trying
              <main id="main" tabIndex={-1} className="split split--empty">
                <div className="load-error" role="alert">
                  <p><strong>{t('세션을 불러오지 못했어요.')}</strong> {loadError}</p>
                  <ActionButton className="btn btn-sm" label={t('다시 시도')} busyLabel={t('불러오는 중…')} doneLabel={t('다시 시도')} run={() => pollNow.current()} />
                </div>
              </main>
            ) : (
              <SplitPanes
                left={snap ? <IpPane snap={snap} onAction={onAction} onEdit={setEditing} onRetry={onRetry} onCancelJob={onCancelJob} onModal={setPaneModal} /> : <Skeleton label={t('IP와 영상')} />}
                right={snap ? <GamePane snap={snap} onGenre={onGenre} onError={fail} onDesign={() => setDesigning(true)} onExpand={(game, url) => setExpanded({ game, url })} onEditGame={(game, version) => setGameEdit({ game, version })}
                  onMakeHeld={makeOffered} onReroll={(ipId) => onAction('reroll_ip_image', { ipId }, true)}
                  onMake3d={(ipId) => onAction('render_3d', { ipId })} sending={sending} /> : <Skeleton label={t('게임')} />}
              />
            )}
            {/* last in the page: under the panes, and from 900 px the column right of them (origin.css) */}
            <ChatDock sessionId={sessionId} messages={snap?.messages ?? []} draft={drafts[sessionId] ?? ''} onDraft={(text) => setDraft(sessionId, text)}
              onSend={onSend} loading={!snap} failed={!snap && !!loadError} disabled={!snap || pending || sending} videoModels={videoModels}
              imageModels={pictureModels} />
          </>
        ) : (
          <StartScreen sessions={sessions} error={sessionsError} onRetry={() => void loadSessions()} onCreate={onCreate} onSelect={selectSession}
            demo={account?.demo === true} missing={missing} />
        )}
      </div>
      {publishOpen && (
        <PublishModal games={snap?.games ?? []} assets={snap?.assets ?? []} onClose={() => setPublishOpen(false)} onPublish={onPublish}
          onUnpublish={onUnpublish} />
      )}
      {editing && <EditDrawer target={editing} onClose={() => setEditing(null)} onSend={onEditSend} videoModels={videoModels} />}
      {designing && <DesignDrawer ips={snap?.ips ?? []} assets={snap?.assets ?? []} jobs={snap?.jobs ?? []}
        onMake3d={(ip) => onAction('render_3d', { ipId: ip.ipId })} onClose={() => setDesigning(false)} onSend={onEditSend}
        // to the chat once the drawer has handed the focus back to the button that opened it
        onChat={() => { setDesigning(false); window.setTimeout(toChat, 0); }}
        games={snap?.games ?? []} onEditGame={(game, version) => { setDesigning(false); setGameEdit({ game, version }); }} />}
      {gameEdit && <GameEditDrawer game={gameEdit.game} version={gameEdit.version} onClose={() => setGameEdit(null)} onSend={onEditSend} />}
      {skillsOpen && snap && (
        // onChat (its request for a hero) is a line of its own, not the message box's: what is typed there stays
        <SkillsDrawer snap={snap} onClose={() => setSkillsOpen(false)} onSend={onEditSend} onError={fail} onChat={(t) => void post('line', t).catch(() => undefined)}
          onNotice={(text) => pushToast({ level: 'ok', text })} />
      )}
      {agentDialog && (
        <AgentDialog agent={agentDialog.agent} onSaved={(a) => agentsState.putAgent(a.agentId, a)} onClose={() => setAgentDialog(null)} />
      )}
      {inboxOpen && <AgentInbox notes={agentsState.notes} putProposal={agentsState.putProposal} onClose={() => setInboxOpen(false)} />}
      {connOpen && (
        <ConnectionsDrawer connections={connections} adding={connOpen.adding} onChange={setConnections} onRefresh={() => loadConnections(true)} onNotify={notify}
          onClose={() => setConnOpen(null)} onError={fail} />
      )}
      {expanded && sessionId && (
        <GameModal sessionId={sessionId} game={expanded.game} url={expanded.url} assets={snap?.assets ?? []}
          onClose={() => setExpanded(null)} onError={fail} onNotice={notify} />
      )}
      <Toasts toasts={toasts} onDismiss={dismissToast} onAction={onToastAction} onOpen={(tab) => openTab('ip', tab)} keepErrors />
    </>
  );
}
