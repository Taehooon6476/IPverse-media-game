import { lang, sentenceOf, t } from './i18n';
import * as auth from './auth';
import { JOB_KIND_LABEL, checkProblem, errorText, failedCheck, failureText, gameThreeD, hasFailed, jobLabel, josa, notAsAsked, refusedSkeleton,
  rigRefusal } from './types';
import type { Game, GameDesignRequest, Genre, Ip, Job, Message, Session, SessionSummary, Snapshot, StreamState, ToastEvent } from './types';

export { demoLogin, login } from './auth';

const MOCK = import.meta.env.VITE_MOCK === '1';
const BASE = import.meta.env.VITE_API_BASE ?? '/api';

/** The token is missing, expired or rejected: show the login screen with this message. */
export class AuthError extends Error {
  ours = true;
  constructor() {
    super(t('로그인 시간이 지났어요. 다시 로그인하면 하던 작업으로 돌아가요.'));
    this.name = 'AuthError';
  }
  toString() { return this.message; }
}

export class ApiError extends Error {
  /** The server's sentence, in the request's language: one to show (i18n.isSaid). */
  ours = true;
  status: number;
  /** The server's own code for the error (its answer's `error`), when it gave one. */
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
  /** The sentence alone, without the class name String(e) would put in front. */
  toString() { return this.message; }
}

/** What the server said when it said a sentence, else this (never its bare error code, e.g. "not_found"). */
function reason(data: unknown, status: number, lead = t('요청을 처리하지 못했어요.')): string {
  const said = (data as { message?: unknown } | null)?.message;
  return typeof said === 'string' && said.trim() ? said : `${lead} ${t('잠시 뒤 다시 시도해 주세요. (오류 {status})', { status })}`;
}

/** An error as a sentence for a toast or a page: ours as written; anything else (a TypeError's English, a rejected
 * value) becomes one line people can act on. */
export function errorMessage(e: unknown): string {
  // Ours: marked (i18n.said), the server's answer (ApiError), or Korean. An unmarked English sentence is the
  // browser's or a library's and is not shown.
  if (e instanceof ApiError || e instanceof AuthError) return e.message;
  return (e instanceof Error ? sentenceOf(e) : null) ?? t('문제가 생겼어요. 잠시 뒤 다시 시도해 주세요.');
}

export interface Reply {
  status: number;
  data: any; // typed by the wrappers below
}

/** Lowercase hex SHA-256 of the UTF-8 bytes of `text`. */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function http(method: string, path: string, token: string, body?: unknown): Promise<Reply> {
  // X-Lang: the language the server answers this page in (its refusals, notices and the agent's replies)
  const headers: Record<string, string> = { 'X-Auth-Token': token, 'X-Lang': lang };
  const payload = body === undefined ? undefined : JSON.stringify(body);
  if (payload !== undefined) {
    headers['Content-Type'] = 'application/json';
    // CloudFront OAC signs the request for the IAM-auth Function URL and needs the hash of the exact body sent.
    headers['x-amz-content-sha256'] = await sha256Hex(payload);
  }
  let res: Response;
  try {
    // keepalive: a DELETE sent while the tab closes (stopping a paid stream) still reaches the server
    res = await fetch(BASE + path, { method, headers, body: payload, keepalive: method === 'DELETE' });
  } catch {
    throw new ApiError(0, auth.OFFLINE);
  }
  return { status: res.status, data: await res.json().catch(() => null) };
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = await auth.validToken();
  if (!token) throw new AuthError();
  const { status, data } = MOCK
    ? await (await import('./mock/mockApi')).handle(method, path, body)
    : await http(method, path, token, body);
  if (status === 401) {
    auth.clear();
    throw new AuthError();
  }
  if (status >= 400) throw new ApiError(status, reason(data, status), typeof data?.error === 'string' ? data.error : undefined);
  return data as T;
}

const enc = encodeURIComponent;

/** A session's title as the page shows it: the server's default title (store.DEFAULT_TITLE, kept in Korean on the
 * server) in the page's language; any other title as it is. */
export const shownTitle = (title: string) => (title === '새 세션' ? t('새 세션') : title);
// (an answer without the part is passed on as it came)
const titled = <T extends { title: string }>(x: T): T => (x && typeof x.title === 'string' ? { ...x, title: shownTitle(x.title) } : x);

export const listSessions = () => request<{ sessions: SessionSummary[] }>('GET', '/sessions')
  .then((r) => (Array.isArray(r?.sessions) ? { ...r, sessions: r.sessions.map(titled) } : r));

export const createSession = (title?: string, genre?: Genre) =>
  request<{ session: Session }>('POST', '/sessions', { title, genre }).then((r) => (r?.session ? { ...r, session: titled(r.session) } : r));

export const getSession = (id: string) => request<Snapshot>('GET', `/sessions/${enc(id)}`)
  .then((snap) => (snap?.session ? { ...snap, session: titled(snap.session) } : snap));
/** The code of its 404 (ApiError.code) when the account has no such session: deleted, or another account's
 * (server/app.py _own_session). A 404 without it did not come from the session's handler. */
export const NO_SESSION = 'not_found';

/** The session with its IPs, files and games. 409 (Korean reason) while it is on air or a job still runs. */
export const deleteSession = (id: string) => request<{ deleted: string }>('DELETE', `/sessions/${enc(id)}`);

export const sendChat = (id: string, text: string, gameDesign?: GameDesignRequest) =>
  request<{ messageId: string }>('POST', `/sessions/${enc(id)}/chat`, { text, ...(gameDesign ? { gameDesign } : {}) });

/** A tool run directly by a card button (fast tools: they only register jobs or move pointers). */
export const runTool = (id: string, tool: string, args: Record<string, unknown>) =>
  request<{ result: Record<string, unknown> }>('POST', `/sessions/${enc(id)}/tools/${enc(tool)}`, args);

/** A tool that waits for a GPU image: runs in the background, its outcome lands as a chat status line. */
export const runToolAsync = (id: string, tool: string, args: Record<string, unknown>) =>
  request<{ messageId: string }>('POST', `/sessions/${enc(id)}/tools/${enc(tool)}/async`, args);

/** Re-queue a failed job and the jobs that failed because of it. */
export const retryJob = (id: string, jobId: string) =>
  request<{ retried: string[] }>('POST', `/sessions/${enc(id)}/jobs/${enc(jobId)}/retry`, {});
export const cancelJob = (id: string, jobId: string) =>
  request<{ canceled: string }>('POST', `/sessions/${enc(id)}/jobs/${enc(jobId)}/cancel`, {});

/** Instant demo account (no confirmation step); log in with it right after. */
export async function signup(username: string, password: string): Promise<void> {
  if (MOCK) return;
  const { status, data } = await http('POST', '/signup', '', { username, password });
  if (status >= 400) throw new ApiError(status, reason(data, status, t('가입하지 못했어요.')), typeof data?.error === 'string' ? data.error : undefined);
}

export interface Connection {
  id: string; name: string; status: 'connected' | 'error' | 'off' | 'unknown';
  kind?: 'mcp' | 'aws'; endpoint?: string; url?: string; detail?: string; error?: string | null;
  toolCount?: number; tools?: string[]; enabled?: boolean; hasAuth?: boolean; checkedAt?: string;
  /** videogen: the models the video MCP lists now (list_video_models); imagegen: the image MCP's (list_models). Both
   * cached 5 min on the server. */
  models?: VideoModel[] | ImageModel[];
}
/** An image model on the attached image MCP (list_models). Stable Image Ultra runs on Bedrock and is not one. */
export interface ImageModel { id: string; label: string; promoted?: boolean; hfRepo?: string }
/** A video model on the attached MCP. kinds: i2v, t2v, v2v / restyle (edit_video_shot), animate. status: ready |
 * stopped (boots on first use, ~10 min) | loading | disabled | not_provisioned | load_failed (the last three cannot
 * run). promoted: added through the MCP's Video Model Scout. */
export interface VideoModel { id: string; label: string; kinds: string[]; status: string; promoted: boolean; hfRepo?: string }
export interface Connections { platform: Connection[]; servers: Connection[] }
export const listConnections = () => request<Connections>('GET', '/connections');
export const addConnection = (body: { name: string; url: string; authHeader?: string; authValue?: string }) =>
  request<Connection>('POST', '/connections', body);
export const updateConnection = (cid: string, body: { enabled?: boolean; refresh?: boolean }) =>
  request<Connection>('PATCH', `/connections/${enc(cid)}`, body);
export const removeConnection = (cid: string) => request<{ deleted: string }>('DELETE', `/connections/${enc(cid)}`);

// --- Agents (server: /api/agents, user-scoped) ---

/** A scheduled agent. builtin: the platform's own (the daily open-weight model scout), it cannot be deleted. */
export interface Agent {
  agentId: string; name: string; instructions: string; scheduleLabel: string; cron: string; enabled: boolean; builtin: boolean;
  lastRun: { at: string; status: string; summary: string } | null;
}
export type ProposalStatus = 'proposed' | 'testing' | 'passed' | 'failed' | 'promoted' | 'dismissed';
export interface TrialResult {
  prompt: string; mode: 't2i' | 'i2i' | 't2v' | 'i2v'; referenceUrl?: string;
  baseline: { model: string; url: string }; candidate: { url: string; seconds?: number };
}
/** A GPU trial of a proposed model: the box boots, installs it and runs the baseline's prompts on both. */
export interface Trial {
  trialId: string; phase: string; startedAt: string; finishedAt: string | null; error: string | null; results: TrialResult[];
}
/** A Hugging Face open-weight model an agent found better than the one in use. */
export interface Proposal {
  proposalId: string; kind: 'image' | 'video'; hfRepo: string; label: string; license: string; commercialOk: boolean;
  vramGb: number; instance: string; why: string; risks: string; status: ProposalStatus; trial: Trial | null;
}
export interface AgentNote {
  noteId: string; agentId: string; agentName: string; createdAt: string; title: string; body: string; proposal: Proposal | null;
}
/** The bare object, or the same under one key ({"agent": …}): the contract's `{agent}` reads either way. */
const one = <T>(key: string) => (data: unknown): T => ((data as Record<string, unknown> | null)?.[key] ?? data) as T;
export const listAgents = () => request<{ agents: Agent[] }>('GET', '/agents');
/** The server turns one natural-language description into an agent (name, instructions, schedule). */
export const createAgent = (description: string) => request<Agent>('POST', '/agents', { description }).then(one<Agent>('agent'));
export const patchAgent = (agentId: string, patch: Partial<Pick<Agent, 'name' | 'instructions' | 'cron' | 'enabled'>>) =>
  request<Agent>('PATCH', `/agents/${enc(agentId)}`, patch).then(one<Agent>('agent'));
export const deleteAgent = (agentId: string) => request<null>('DELETE', `/agents/${enc(agentId)}`);
export const runAgent = (agentId: string) => request<{ runId: string }>('POST', `/agents/${enc(agentId)}/run`, {});
export const agentInbox = () => request<{ notes: AgentNote[] }>('GET', '/agents/inbox');
/** 409: another trial is running. */
export const testProposal = (proposalId: string) => request<Proposal>('POST', `/agents/proposals/${enc(proposalId)}/test`, {}).then(one<Proposal>('proposal'));
/** 409 unless the trial passed. */
export const approveProposal = (proposalId: string) => request<Proposal>('POST', `/agents/proposals/${enc(proposalId)}/approve`, {}).then(one<Proposal>('proposal'));
export const dismissProposal = (proposalId: string) => request<Proposal>('POST', `/agents/proposals/${enc(proposalId)}/dismiss`, {}).then(one<Proposal>('proposal'));

export interface LiveState {
  active: boolean;
  /** Off air because this account started a broadcast in another session (the server's word to the windows it cut off). */
  endedBy?: 'takeover';
  mode?: 'player' | null;
  ingest?: { endpoint: string; streamKey: string } | null;
  /** RUNNING: the IVS stream is live; STARTING: on air, the play window has not published yet; IDLE */
  channelState: string;
  /** The IVS channel's playback URL (IVS stitches the MediaTailor ads into it). The channel is private: it carries a
   * token for the default persona (기본); the watch window asks liveToken for another persona's. */
  playbackUrl: string;
  adInsertion?: 'ivs' | null;
  job: { jobId?: string; gameId: string; adTitle?: string; everyRounds: number; adSeconds: number; startedAt: string; highlightAuto?: HighlightAuto; highlightGen?: boolean;
    adType?: LiveAdType; playableSeconds?: number; playUrl?: string; playableAdId?: string; standby?: boolean; standbyCapable?: boolean; standbyToken?: string; standbyOff?: boolean;
    roundBase?: number;
    /** A corner trailer at every round that is not the every-N-th (trailer and playable broadcasts). */
    corner?: boolean;
    /** The pre-cue: InsertAdBreak this long before a round's known end (0 = off). */
    preCueLeadSec?: number;
    /** When the play window reports a round's known end: the lead and the time the server's picks take. */
    preCueSendSec?: number } | null;
  /** IVS stream health while live: HEALTHY | STARVING | UNKNOWN */
  health?: string | null;
  /** The server's clock (epoch seconds) as this answer left: the play window names a round's end on it. */
  now?: number;
  stream: { state: string; rounds: number; breaks: AdBreak[]; updatedAt: string; error?: string } | null;
  highlights?: Highlight[];
}
export type HighlightKind = 'overlay' | 'linear';
export type HighlightAuto = 'off' | HighlightKind;
/** kind "skip": a full-screen trailer that did not go (reason overlap: the last ad was still on air; no_room: too
 * little time before the next round's ad); the schedule stays. of "playable", reason launcher_warming: the playable card
 * waits for a warm launcher (it comes at the first round end after one connected). */
export interface AdBreak { round: number; eventId: string; at: string; seconds: number; kind?: 'trailer' | 'playable' | 'corner' | 'skip' | HighlightKind; title?: string; playable?: boolean; playUrl?: string; adId?: string;
  of?: 'trailer' | 'playable'; reason?: 'overlap' | 'no_room' | 'launcher_warming';
  /** What each viewer got ("" = no viewer, the default): a trailer break's VAST, a playable card's game, a corner
   * trailer. breakId: a trailer break's impression beacons' id. */
  picks?: Record<string, AdPick>; breakId?: string;
  /** A trailer break against its round's end: preCue (sent before a known end), endToAdSec = where the ad starts in
   * the stream after the round's end (what each viewer sees on its own picture, whatever its delay). */
  preCue?: boolean; cuedAt?: string; roundEndAt?: string; endToAdSec?: number; leadSec?: number;
  /** A trailer break as the watch page's tiles saw it: measured = how many tiles' own numbers endToAdSec is the
   * median of (else it is the usual place); lost = no tile showed it (IVS took the call and never put it in a
   * playlist); makeup = it makes up for the lost break before it; estimated = sent by a race's estimated end. */
  measured?: number; lost?: boolean;
  /** No tile was playing through the break (no watch page, or all its players stalled): nothing says whether it aired. */
  unseen?: boolean; makeup?: boolean; estimated?: boolean;
  /** A corner break: how long (s) a tile may hold the corner behind its full-screen ad (the cue carries it too).
   * instead + note: it went out in a full-screen trailer's place, and the server's sentence on why (no trailer was
   * ready to air yet). */
  wait?: number; instead?: 'trailer'; note?: string }
/** What one viewer got in a break, and why (server/adserver.py): reason = the reasons joined with " · ";
 * fallback: its best creative was still being transcoded, so the best transcoded one went out. A playable pick names
 * its ad (adId: the game's playable ad), a corner pick its video (url) and the published game (gameUrl). */
export interface AdPick { title: string; creative: string; seconds: number; reason?: string; reasons?: string[]; genre?: string;
  score?: number; fallback?: boolean; provider?: 'gam'; url?: string; gameUrl?: string; adId?: string; gameId?: string;
  ctaUrl?: string; trailerUrl?: string }
/** One finished round's short: Pegasus 1.5 picked the moment (start/end in the round's clip, cut from the IVS recording), ffmpeg cut it. */
export interface Highlight {
  id: string; round: number; state: 'uploading' | 'analyzing' | 'ready' | 'failed'; createdAt: string;
  title?: string; excitement?: string | null; start?: number; end?: number; clipSeconds?: number;
  shortUrl?: string; wideUrl?: string; error?: string;
}

/** A round ended (epoch ms on this browser's clock; sentAt lets the server move them onto its own): the server cuts the
 * round out of the channel's IVS recording and makes its highlight. */
export const highlightCreate = (id: string, body: { round: number; startedAt: number; endedAt: number; sentAt: number }) =>
  request<Highlight>('POST', `/sessions/${enc(id)}/live/highlights`, body);
export const highlightSend = (id: string, hid: string, kind: HighlightKind) =>
  request<{ eventId: number; kind: HighlightKind }>('POST', `/sessions/${enc(id)}/live/highlights/${enc(hid)}/send`, { kind });
export const highlightDelete = (id: string, hid: string) =>
  request<{ id: string; deleted: boolean }>('DELETE', `/sessions/${enc(id)}/live/highlights/${enc(hid)}`);
export const highlightRestore = (id: string, hid: string) =>
  request<{ id: string; deleted: boolean }>('POST', `/sessions/${enc(id)}/live/highlights/${enc(hid)}/restore`, {});
export const highlightSettings = (id: string, body: { auto?: HighlightAuto; generate?: boolean }) =>
  request<{ auto: HighlightAuto; generate: boolean }>('POST', `/sessions/${enc(id)}/live/highlights/settings`, body);

/** The broadcast's ad style: 전체 화면 트레일러 (MediaTailor), 플레이어블 (GameLift Streams), 코너 트레일러 (the player). */
export type LiveAdType = 'trailer' | 'playable' | 'corner';
/** The ad spec of a running broadcast (the count restarts from the rounds finished so far). */
export const liveAdSettings = (id: string, body: { adType: LiveAdType; everyRounds: number; playableSeconds?: number; corner?: boolean }) =>
  request<LiveState>('POST', `/sessions/${enc(id)}/live/ad`, body);
/** takeover: the user said yes to ending the broadcast of their other session (the server answers 409 without it). */
export const liveStart = (id: string, body: { gameId: string; adAssetId?: string; everyRounds: number; mode?: 'player' | 'bot';
  adType?: LiveAdType; playableSeconds?: number; corner?: boolean; preCueLeadSec?: number; takeover?: boolean }) =>
  request<LiveState>('POST', `/sessions/${enc(id)}/live`, body);
/** What a round report did: cued (its ad went out now: a trailer break, a playable card, a corner-only broadcast's
 * corner), preCued (its trailer break went out before the round ended), corner (a corner trailer on a round without the
 * broadcast's own ad), deferred (the playable card waits for a launcher); breaks: the break log, with this round's skip. */
export type RoundAnswer = { cued: boolean; deferred?: boolean; preCued?: boolean; corner?: boolean; rounds: number; breaks?: AdBreak[];
  /** The round's full-screen ad was sent only now (its end was not known ahead): the built-in player keeps the end
   * screen up this long, so the ad starts over it and not over the next round. */
  holdSec?: number };
/** endedAtMs: the round's end as an instant of the server's clock (LiveState.now), when the window knows it. */
export const liveRound = (id: string, rounds: number, endedAtMs?: number) =>
  request<RoundAnswer>('POST', `/sessions/${enc(id)}/live/round`, { rounds, ...(endedAtMs ? { endedAtMs } : {}) });
/** The round being played ends in endsInMs (a survive stage, a time limit): a full-screen trailer round gets its break
 * now when that is the lead or less ("early": send again in sendInMs). */
export const liveRoundEta = (id: string, round: number, endsInMs: number, extra?: { estimated?: boolean; cancel?: boolean; endsAtMs?: number }) =>
  request<{ preCued: boolean; reason?: string; sendInMs?: number; deferred?: boolean }>('POST', `/sessions/${enc(id)}/live/round-eta`,
    { round, endsInMs: Math.round(endsInMs), sentAt: Date.now(), ...extra });
/** The watch page's one hidden, game-agnostic GameLift Streams session (the launcher) for this playable broadcast.
 * viewerId: whose card the page will most likely play (its game loads ahead of the cue). more.grid: the page shows
 * every viewer's tile. more.launchId: the page's id for its launcher (12 hex), to end a start still in flight. */
export const startLauncher = (id: string, signalRequest: string, standbyToken?: string, viewerId?: string,
  more: { launchId?: string; grid?: boolean } = {}) =>
  request<StreamState & { launchId: string }>('POST', `/sessions/${enc(id)}/live/launcher`,
    { signalRequest, standbyToken, ...(viewerId !== undefined ? { viewerId } : {}), ...more });
/** What this page shows, for its launcher. With eventId: a playable card is up (the launcher holds this viewer's game,
 * so the click only reveals it). Without: the page's viewers changed after the launcher started. grid: as above. */
export const hintLauncher = (id: string, launchId: string, body: { viewerId: string; eventId?: string; grid?: boolean }) =>
  request<{ launchId: string; preload: string | null }>('POST', `/sessions/${enc(id)}/live/launcher/${enc(launchId)}/hint`, body);
export const pollLauncher = (id: string, launchId: string) =>
  request<StreamState & { launchId: string }>('GET', `/sessions/${enc(id)}/live/launcher/${enc(launchId)}`);
export const stopLauncher = (id: string, launchId: string) =>
  request<{ status: string }>('DELETE', `/sessions/${enc(id)}/live/launcher/${enc(launchId)}`);
/** A tile's playable card was clicked: launch (this page's warm launcher opens the viewer's game), start (a seat is
 * free: start the ad's session with the ticket) or queued ("대기 n번째": ask again with the ticket). */
export interface PlayAnswer { mode: 'launch' | 'start' | 'queued'; adId: string; position?: number; ticket?: string;
  waitsForInput?: boolean; seconds?: number; streamId?: string }
export const livePlay = (id: string, body: { viewerId: string; eventId: string; launchId?: string; ticket?: string }) =>
  request<PlayAnswer>('POST', `/sessions/${enc(id)}/live/play`, body);
/** The beacon of the ads the watch page renders itself (a corner trailer, a playable card): the viewer's activity log. */
export type AdEventAction = 'impression' | 'click' | 'expand' | 'unmute' | 'play' | 'end';
export const liveAdEvent = (id: string, body: { viewerId: string; eventId: string; seconds?: number }
  & ({ kind: 'corner' | 'playable'; action: AdEventAction }
    /** A tile's player began a stitched full-screen ad; leadMs: how long after the break's mark (eventId) it came. */
    | { kind: 'trailer'; action: 'start'; leadMs?: number })) =>
  request<{ recorded: boolean }>('POST', `/sessions/${enc(id)}/live/ad-event`, body);
export const liveStatus = (id: string) => request<LiveState>('GET', `/sessions/${enc(id)}/live`);
export const liveBeat = (id: string) => request<{ ok: boolean }>('POST', `/sessions/${enc(id)}/live/beat`, {});
/** A viewer is playing the stream: the server may send a 1 s warm-up break for a new ad creative. */
export const liveViewer = (id: string, viewers: string[] = [], reports = false) =>
  request<{ warmed: boolean }>('POST', `/sessions/${enc(id)}/live/viewer`, { ...(viewers.length ? { viewers } : {}), ...(reports ? { reports } : {}) });
/** A dummy viewer (server/viewers.py): its id is its token's persona, so MediaTailor asks for its own VAST. */
export interface Viewer {
  viewerId: string; name: string; initials: string; color: string; bio?: string;
  profile: { ageBand: string; region: string; device: string; genres: string[] };
  /** The latest activity, newest first (text is Korean, ready to show). */
  recent: { type: string; at: string; text: string; simulated?: boolean }[];
  events: number;
  features: { g1: string; g2: string; skill: string; dev: string; age: string };
  provider: 'ipverse' | 'gam';
}
export const liveViewers = () => request<{ viewers: Viewer[] }>('GET', '/live/viewers');
/** A viewer persona (server/ads.py): its token makes MediaTailor ask for its own VAST at every break. */
export interface Persona { personaId: string; name: string; genre: string; profile: string }
export const livePersonas = () => request<{ personas: Persona[] }>('GET', '/live/personas');
/** The private channel's playback URL with a signed token for this persona ('' = 기본, the default ad). expiresAt:
 * epoch seconds (IVS checks it when the player loads, so renew it before a reload can need it). */
export const liveToken = (persona: string) =>
  request<{ playbackUrl: string; expiresAt: number; persona: string; personaName: string }>('POST', '/live/token', { persona });
/** The playable-ad server (the web stream group's idle GameLift Streams host). */
export interface StandbyState { on: boolean; state: 'off' | 'warming' | 'ready'; idle: number; allocated: number; max: number;
  mode: 'auto' | 'on' | 'off'; until?: number | null; hourlyUsd: number;
  /** Held by the playable tab's pre-warm (before a broadcast), not by hand. */
  prewarm?: boolean }
export const liveStandby = (id: string) => request<StandbyState>('GET', `/sessions/${enc(id)}/live/standby`);
/** on: hold a host now (before a broadcast, 60 minutes at most); off: take it down now. prewarm: the playable tab was
 * opened before a broadcast (10 minutes; never over the switch set by hand). */
export const setLiveStandby = (id: string, on: boolean, prewarm = false) =>
  request<StandbyState>('POST', `/sessions/${enc(id)}/live/standby`, { on, ...(prewarm ? { prewarm: true } : {}) });
export const liveStop = (id: string) => request<LiveState>('DELETE', `/sessions/${enc(id)}/live`);

/** genre: the session's default game genre; title: its name (the server refuses an empty one). */
export const patchSession = (id: string, patch: { genre?: Genre; title?: string }) =>
  request<Snapshot>('PATCH', `/sessions/${enc(id)}`, patch);

export const publishGame = (id: string, body: { gameId: string; adAssetId?: string; skipAfterSec: number; adEveryRounds: number }) =>
  request<{ publishedUrl: string }>('POST', `/sessions/${enc(id)}/publish`, body);
/** 게시 내리기: the game leaves the published state and loses its ad settings (server/app.py unpublish). Its address is
 * its preview folder's, which stays. */
export const unpublishGame = (id: string, gameId: string) =>
  request<{ unpublished: string }>('DELETE', `/sessions/${enc(id)}/publish/${enc(gameId)}`);

// --- Unreal over GameLift Streams (server/streams.py) ---

export const startStream = (id: string, signalRequest: string, gameId?: string, kind?: 'web' | 'unreal') =>
  request<StreamState & { gameId: string }>('POST', `/sessions/${enc(id)}/stream`, { signalRequest, gameId, ...(kind ? { kind } : {}) });

/** A playable ad (server/playable.py): the game streamed for `seconds` from a public #ad=<id> page. */
export interface PlayableAd { adId: string; title: string; seconds: number; trailerUrl: string | null; ctaUrl: string; adPath?: string; plays?: number }
export const createPlayableAd = (id: string, gameId: string, seconds: number) =>
  request<PlayableAd>('POST', `/sessions/${enc(id)}/playable-ads`, { gameId, seconds });
// public: no login on the ad page
async function publicCall<T>(method: string, path: string, body?: unknown): Promise<T> {
  const { status, data } = await http(method, path, '', body);
  if (status >= 400) throw new ApiError(status, reason(data, status));
  return data as T;
}
export const getPlayableAd = (adId: string) => publicCall<PlayableAd>('GET', `/ads/${enc(adId)}`);
/** standby: a live viewer's hidden session that waits for the next playable break. waitsForInput: the game holds
 * its round until the viewer's first input. startId: the page's name for this start (st_ + 12 hex), so it can end
 * a start that is still in flight (stopAdStream). */
export const startAdStream = (adId: string, signalRequest: string, standby = false, standbyToken?: string, ticket?: string,
  startId?: string) =>
  publicCall<StreamState & { seconds: number; standby?: boolean; waitsForInput?: boolean }>('POST', `/ads/${enc(adId)}/stream`,
    { signalRequest, ...(standby ? { standby: true, standbyToken } : {}), ...(ticket ? { ticket } : {}), ...(startId ? { startId } : {}) });
export const pollAdStream = (adId: string, streamId: string) => publicCall<StreamState>('GET', `/ads/${enc(adId)}/stream/${enc(streamId)}`);
/** streamId: the session's stream id, or the name the page gave its start (startAdStream's startId). */
export const stopAdStream = (adId: string, streamId: string) => publicCall<StreamState>('DELETE', `/ads/${enc(adId)}/stream/${enc(streamId)}`);
/** A live viewer revealed their standby session: it counts as a play now. */
export const playedAdStream = (adId: string, streamId: string) => publicCall<{ plays: number }>('POST', `/ads/${enc(adId)}/stream/${enc(streamId)}/play`, {});

export const pollStream = (id: string, streamId: string) =>
  request<StreamState>('GET', `/sessions/${enc(id)}/stream/${enc(streamId)}`);

export const reconnectStream = (id: string, streamId: string, signalRequest: string) =>
  request<StreamState>('POST', `/sessions/${enc(id)}/stream/${enc(streamId)}/reconnect`, { signalRequest });

export const stopStream = (id: string, streamId: string) =>
  request<StreamState>('DELETE', `/sessions/${enc(id)}/stream/${enc(streamId)}`);

/** The game's `release.json` (pre-roll ad), next to its spec on the CDN. everyRounds: the ad again after every N-th
 * round; absent = at the start only (server/tools.py publish_game). */
export async function getRelease(game: Game): Promise<{ ad: { videoUrl: string; skipAfterSec: number; everyRounds?: number } | null }> {
  if (MOCK) return { ad: null };
  const res = await fetch(new URL(`/games/${enc(game.gameId)}/release.json`, new URL(game.previewUrl, location.href)));
  if (!res.ok) return { ad: null };
  return res.json().catch(() => ({ ad: null }));
}

/** The game's `spec.json`, read from the CDN next to the game files (`games/{gameId}/spec.json`). */
export async function getGameSpec(game: Game): Promise<unknown> {
  if (MOCK) return (await import('./mock/mockApi')).spec(game);
  const key = game.specKey.replace(/^\/+/, ''); // a leading "//" would turn the key into a host name
  const res = await fetch(new URL(`/${key}`, new URL(game.previewUrl, location.href)));
  if (!res.ok) throw new ApiError(res.status, t('게임 설정을 불러오지 못했어요.'));
  return res.json();
}

export const REBUILD_GAME = 'rebuild-game';

/** A user message as the snapshot carries it once its game request was held for 3D (server/agent.py _note_hold):
 * the IPs whose 3D the game waits for (the player; for a game without one its cast, where one in 3D is enough). */
export type HeldMessage = Message & { gameHeld?: { ipIds: string[] } };

const newestGame = (s: Snapshot) => s.games.reduce<Game | undefined>((a, g) => (!a || g.createdAt > a.createdAt ? g : a), undefined);
/** The IP when the 3D a waiting game needs of it is in: finished for a game (gameThreeD), and not by a rig that
 * failed (the request waits for a retry of the rig). A skeleton the farm refused is the exception: no retry lands,
 * so the IP is ready with the model it has. */
export function readyIp(s: Snapshot, ipId: string): Ip | undefined {
  const ip = s.ips.find((x) => x.ipId === ipId);
  if (!ip || gameThreeD(ip, s.assets, s.jobs).state !== 'ready') return undefined;
  const rig = s.jobs.filter((j) => j.kind === 'rig' && j.input?.ipId === ipId).at(-1); // its newest
  const waits = rig?.status === 'failed' && !rigRefusal(rig) && !s.assets.some((a) => a.assetId === ip.riggedGlbAssetId);
  return waits ? undefined : ip;
}

/** The game request that was asked for and can be made now, else null: the newest user message that carries one (a
 * chat line the agent held for 3D, or a 게임 설계) when no game was made after it and the 3D it waits for is ready (the
 * mark's IPs, else the design's player). A newer request replaces an older one even while its own 3D still runs. */
export function heldGame(s: Snapshot): HeldMessage | null {
  const asked = [...s.messages as HeldMessage[]].reverse().find((m) => m.role === 'user' && (m.gameDesign || m.gameHeld));
  const game = newestGame(s);
  if (!asked || (game && asked.ts <= game.createdAt)) return null;
  const waits = asked.gameHeld?.ipIds ?? (asked.gameDesign?.playerIpId ? [asked.gameDesign.playerIpId] : null);
  return !waits || waits.some((id) => readyIp(s, id)) ? asked : null;
}

/** What the 게임에 반영 toast sends once new 3D lands. A game request that waited for 3D (heldGame) is sent again as
 * it was. Otherwise the newest game is re-made as a new version ("[게임 수정 gameId=…]"): a refresh only copies
 * files, and a cutout panel needs another spec to become a model (server/game_assets.py needsRemake). null: nothing to make. */
export function rebuildRequest(s: Snapshot): { text: string; gameDesign?: GameDesignRequest } | null {
  const held = heldGame(s);
  if (held) return { text: held.text, ...(held.gameDesign ? { gameDesign: held.gameDesign } : {}) };
  const game = newestGame(s);
  if (!game) return null;
  // a newer request the agent held still waits for its hero: offering the older game re-made would void it
  const asked = [...s.messages as HeldMessage[]].reverse().find((m) => m.role === 'user' && (m.gameDesign || m.gameHeld));
  if (asked?.gameHeld && asked.ts > game.createdAt) return null;
  // the mark in front is read by the server (server/gamespec.py) and stays Korean; the request after it is in the page's language
  return { text: `[게임 수정 gameId=${game.gameId}] ` + (lang === 'en'
    ? t('새 3D가 준비됐으니 \'{title}\'을(를) 같은 설계와 출연 IP 그대로 다시 만들어 3D 모델로 바꿔줘. 나머지는 그대로 둬.', { title: game.title })
    : `새 3D가 준비됐으니 '${game.title}'을(를) 같은 설계와 출연 IP 그대로 다시 만들어 ` + '3D 모델로 바꿔줘. 나머지는 그대로 둬.') };
}

/** What new 3D can be offered for: 'held' = a game that was asked for and waited for its hero's 3D (heldGame) →
 * 게임 만들기; 'remake' = the newest game, made again as a new version → 게임에 반영; null = nothing to make. */
export type GameOffer = 'held' | 'remake' | null;
export const gameOffer = (s: Snapshot): GameOffer => (heldGame(s) ? 'held' : rebuildRequest(s) ? 'remake' : null);
/** The button of a held request's offer; 게임에 반영 is the button of an existing game's re-make. */
export const MAKE_HELD = t('게임 만들기');
const REMAKE = t('게임에 반영');
/** The sentence for a hero whose skeleton was refused; the held game's card and its toast go on from it. */
export const noSkeleton = (names: string) => (lang === 'en' ? t('‘{names}’은(는) 움직임 뼈대를 넣을 수 없는 모습이에요.', { names })
  : `‘${names}’${josa(names, '은', '는')} 움직임 뼈대를 넣을 수 없는 모습이에요.`);
/** names: whose 3D is in ("세린, 카이"), '' when no IP is known. A re-make says that it is a new version. bare: the
 * held game's heroes are ready without a skeleton (it was refused): the offer says what the game will lack, as a warning. */
const offerToast = (offer: 'held' | 'remake', names: string, bare = false): ToastEvent => (offer === 'remake'
  ? { level: 'ok', text: names ? t('새 3D가 준비됐어요 ({names}). 게임에 반영할까요? 새 버전으로 다시 만들어요.', { names })
    : t('새 3D가 준비됐어요. 게임에 반영할까요? 새 버전으로 다시 만들어요.'),
    action: { id: REBUILD_GAME, label: REMAKE } }
  : bare && names ? { level: 'warn', text: `${noSkeleton(names)} ${t('걷는 동작 없이 그대로 게임을 만들까요?')}`, action: { id: REBUILD_GAME, label: MAKE_HELD } }
    : { level: 'ok', text: names ? t('{names} 3D가 준비됐어요. 요청해 둔 게임을 만들까요?', { names }) : t('주인공 3D가 준비됐어요. 요청해 둔 게임을 만들까요?'), action: { id: REBUILD_GAME, label: MAKE_HELD } });

/** The heroes a held game can be made with now (heldGame), and whether all of them stand without a skeleton: the
 * farm refused it, so the game is made with the model as it is (refusedSkeleton). */
function heldHeroes(s: Snapshot): { ready: Ip[]; bare: boolean } {
  const ready = (heldGame(s)?.gameHeld?.ipIds ?? []).map((id) => readyIp(s, id)).filter((ip): ip is Ip => !!ip);
  return { ready, bare: ready.length > 0 && ready.every((ip) => refusedSkeleton(ip, s.assets, s.jobs) !== null) };
}
/** The IPs (ids) whose refused skeleton is what a held game is ready with: the toast of such a refusal is the game's
 * offer (diffJobs), not a failure to try again. [] when nothing is held, or a hero with a skeleton is ready too. */
export function bareHeroes(s: Snapshot): string[] {
  const { ready, bare } = heldHeroes(s);
  return bare ? ready.map((ip) => ip.ipId) : [];
}

/** The 게임 만들기 offer of a held request that can be made now and that this browser has not offered yet (`seen`).
 * → the request to remember and the toast to add; toast null when one of this snapshot's job toasts (`shown`) is
 * the offer already. Covers a page that did not see the 3D land (closed, on another session). Not while an answer
 * is being made (that turn may be making the game), and not for a design that carries no mark. */
export function heldOffer(s: Snapshot, shown: ToastEvent[], seen: ReadonlySet<string>): { messageId: string; toast: ToastEvent | null } | null {
  const held = heldGame(s);
  if (!held?.gameHeld || seen.has(held.messageId)) return null;
  if (shown.some((t) => t.action?.id === REBUILD_GAME)) return { messageId: held.messageId, toast: null };
  if (s.messages.some((m) => m.status === 'pending')) return null;
  const { ready, bare } = heldHeroes(s);
  return { messageId: held.messageId, toast: offerToast('held', ready.map((ip) => ip.name).join(', '), bare) };
}

/** The IP pane's tab where a job's result shows (IpPane's tab ids), for the toast's link. */
function resultTab(j: Job, ip?: Ip): string | undefined {
  if (j.kind === 'shot' || j.kind === 'trailer') return 'video';
  if (j.kind !== 'image') return '3d';
  return ip ? (ip.kind === 'character' || ip.kind === 'enemy' ? 'characters' : 'props') : undefined;
}

/** One toast per job whose status became `done` or `failed` between two snapshots (`ips` from the newer one). It
 * names what the job worked on and carries the tab where the result shows (`open`), 작업 현황 for a failure. When new
 * 3D a game uses just finished and there is a game to make with it (`offer`), that toast offers the game. A done
 * job that was no plain success is a warning, never the green 완료. */
export function diffJobs(prev: Job[], next: Job[], offer: GameOffer | boolean = null, ips: Ip[] = [], bare: string[] = []): ToastEvent[] {
  const before = new Map(prev.map((j) => [j.jobId, j.status]));
  const rigged = new Set(next.filter((j) => j.kind === 'rig').map((j) => j.input?.ipId));
  const feedsGame = (j: Job) => j.kind === 'rig' || (j.kind === 'mesh3d' && !rigged.has(j.input?.ipId));
  const game = offer === true ? 'remake' : offer || null;
  return next
    .filter((j) => (j.status === 'done' || j.status === 'failed') && before.get(j.jobId) !== j.status)
    .filter((j) => j.error !== '사용자가 중지함') // the 중지 button already said so
    .map((j): ToastEvent => {
      const i = j.input ?? {};
      const ip = ips.find((x) => x.ipId === (typeof i.ipId === 'string' ? i.ipId : i.sourceIpId));
      const name = ip?.name ?? (typeof i.title === 'string' && i.title ? i.title : undefined);
      // the job as its card and 작업 현황 say it (jobLabel)
      const label = `${name ? `${name} ` : ''}${jobLabel(j)}`;
      const open = resultTab(j, ip);
      if (hasFailed(j)) {
        // a skeleton the farm refused: no retry helps. When a held game is ready with the model as it is (`bare`),
        // this is that game's offer; else it says what does help.
        const refused = rigRefusal(j);
        if (refused && ip && game === 'held' && bare.includes(ip.ipId)) return offerToast('held', ip.name, true);
        const why = failureText(j); // never the raw exception a provider left on the line
        return { level: 'error', text: `${t('{label} 실패', { label })}${why ? `: ${why}` : ''}${refused ? t('. 그림을 다시 뽑아야 해요.') : ''}`, open: 'pipeline' };
      }
      if (notAsAsked(j)) return { level: 'warn', text: whatHappened(j, label, ip), ...(open ? { open } : {}) };
      if (game && feedsGame(j)) return offerToast(game, ip?.name ?? '');
      return { level: 'ok', text: t('{label} 완료', { label }), ...(open ? { open } : {}) };
    });
}

/** What a done job that was no plain success ended as, in one line. A picture's check (mediagen_image._flag): what
 * the check found and what the IP shows now. A first picture becomes the IP's picture anyway; a new version, or an
 * edit that changed more than asked, stays in the version history only and the IP keeps the picture it had. */
function whatHappened(j: Job, label: string, ip?: Ip): string {
  const check = failedCheck(j.error);
  if (j.kind === 'image' && check) {
    const kept = j.outcome ? j.outcome === 'rejected' : !!ip && !j.outputs.includes(ip.imageAssetId ?? ''); // the IP kept the picture it had
    const found = check.problem ? `: ${check.problem}` : '';
    if (checkProblem(j.error) === null) { // the edit check
      const version = typeof j.input?.version === 'number' ? `(v${j.input.version})` : '';
      if (ip) {
        return kept ? t('{name} 수정본{version}이 검사를 통과하지 못해 적용하지 않았어요{found}. 지금 그림을 그대로 써요.', { name: ip.name, version, found })
          : t('{name} 수정본{version}이 검사를 통과하지 못해 다시 뽑는 편이 좋아요{found}.', { name: ip.name, version, found });
      }
      return kept ? t('수정본{version}이 검사를 통과하지 못해 적용하지 않았어요{found}. 지금 그림을 그대로 써요.', { version, found })
        : t('수정본{version}이 검사를 통과하지 못해 다시 뽑는 편이 좋아요{found}.', { version, found });
    }
    const who = ip ? `${ip.name} ` : '';
    const kind = JOB_KIND_LABEL[j.kind];
    return kept ? t('{who}새 {kind} 구도 검사 실패{found}. 지금 그림을 그대로 써요.', { who, kind, found })
      : t('{who}{kind} 구도 검사 실패{found}. 다시 뽑아 보세요.', { who, kind, found });
  }
  const said = errorText(j.error);
  return said ? `${label}: ${said}` : t('{label}: 결과가 요청한 대로 나오지 않았어요. 작업 현황에서 확인해 주세요.', { label });
}

/** Poll fast while the agent or a job is still working. */
export function pollInterval(s: Snapshot): number {
  const busy = s.messages.some((m) => m.status === 'pending') || s.jobs.some((j) => j.status === 'queued' || j.status === 'running');
  return busy ? 3000 : 10000;
}
