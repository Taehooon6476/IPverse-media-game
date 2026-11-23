import type { AdBreak, LiveAdType, LiveState } from './api';
import { t } from './i18n';

/** The three ad styles by the names the screens use for them (the console's tabs, the play window, the watch page). */
export const STYLE_NAME: Record<LiveAdType, string> = { trailer: t('전체 화면 트레일러'), playable: t('플레이어블 광고'), corner: t('코너 트레일러') };

/** How many different ads the viewers of a break got: the titles of their picks ("" is no viewer, the default, which no tile plays). */
export const differentAds = (b: Pick<AdBreak, 'picks'> | null | undefined) =>
  new Set(Object.entries(b?.picks ?? {}).filter(([viewer]) => viewer).map(([, p]) => p.title)).size;

/** What the status says of this session's broadcast that ended, while it is still the channel's last one: its rounds
 * and the ads it sent, skipped rounds left out (server/live.py _status lastBroadcast). null: on air, or a status that names none. */
export function lastBroadcast(live: LiveState | null | undefined): { rounds: number; ads: number } | null {
  const last = (live as { lastBroadcast?: { rounds?: unknown; ads?: unknown } } | null | undefined)?.lastBroadcast;
  return live && !live.active && typeof last?.ads === 'number' ? { rounds: typeof last.rounds === 'number' ? last.rounds : 0, ads: last.ads } : null;
}

/** How many ads the broadcast has to give its viewers at one break: the server's count for the broadcast's style
 * (job.adChoices, server/live.py _ad_choices) and, with a status that carries none, the different ads the viewers
 * got in the newest break of the broadcast's own style. null: not known (off air, or nothing went out yet). */
export function adsOnHand(live: LiveState | null | undefined): number | null {
  if (!live?.active || !live.job) return null;
  const told = (live.job as { adChoices?: Partial<Record<'trailer' | 'playable', unknown>> }).adChoices?.[live.job.adType === 'playable' ? 'playable' : 'trailer'];
  if (typeof told === 'number') return told;
  const own = (b: AdBreak) => (live.job!.adType === 'playable' ? !!b.playable : b.kind === 'trailer' || b.kind === 'corner');
  const last = [...(live.stream?.breaks ?? [])].reverse().find((b) => own(b) && !b.lost && differentAds(b) > 0);
  return last ? differentAds(last) : null;
}

/** Why the four viewers all get the same ad, and how to change that: said when the broadcast has one ad to give, else
 * null. The broadcast draws on every session of the account (server/adserver.py inventories). */
export function sameAdNote(live: LiveState | null | undefined): string | null {
  if (adsOnHand(live) !== 1) return null;
  return live!.job!.adType === 'playable'
    ? t('지금은 광고로 나갈 게임이 1개뿐이라 가상 시청자 4명이 모두 같은 게임 카드를 받아요. 게임을 더 게시하면(다른 세션에서 게시한 것도 함께 써요) 시청자마다 프로필에 맞는 게임이 나가요.')
    : t('지금은 광고로 나갈 트레일러가 1개뿐이라 가상 시청자 4명이 모두 같은 광고를 받아요. 트레일러를 더 만들면(다른 세션에서 만든 것도 함께 써요) 시청자마다 프로필에 맞는 광고가 나가요.');
}

/** What a start sends: the ad style and its values (corner: a corner trailer at every round that is not an N-th). */
export interface LiveSettings { everyRounds: number; adType: LiveAdType; playableSeconds: number; corner: boolean }

/** The console's values as it opens: a full-screen trailer every 2 rounds, a corner trailer at the other rounds. */
export const DEFAULT_SETTINGS: LiveSettings = { everyRounds: 2, adType: 'trailer', playableSeconds: 90, corner: true };

/** How long a cloud stream (GameLift Streams) takes to start. cold: no GPU host is up, so one is allocated first;
 * warm: a host is up. */
export const CLOUD_WAIT = { cold: t('4–6분'), warm: t('10–20초') };
/** The same as one clause, for every place that starts a cloud stream or waits for one. */
export const CLOUD_WAIT_LINE = t('처음 켤 때는 {cold}, 서버가 켜져 있으면 {warm} 걸려요', CLOUD_WAIT);
/** What one GPU host costs an hour while it is held (server/live.py GLS_HOURLY_USD), for the places that start a
 * cloud stream without the server's own figure at hand. */
export const GPU_HOURLY_USD = 1.51;
/** How long a server started ahead of a broadcast (미리 켜기) is held before it goes by itself (server/live.py PREWARM_SEC). */
export const PREWARM_MINUTES = 10;

/** What a button that starts a broadcast says beside it: the server ends a broadcast by itself (server/live.py
 * MAX_MINUTES), and a playable broadcast starts the playable server, a paid GPU host. */
export const LIVE_MAX_MINUTES = 45;
export const LIVE_LIMIT_LINE = t('최대 {n}분 뒤 자동으로 꺼져요', { n: LIVE_MAX_MINUTES });
export const playableServerLine = (hourlyUsd = GPU_HOURLY_USD) => t('플레이어블 서버가 켜져요 (켜져 있는 동안 시간당 약 ${usd})', { usd: hourlyUsd.toFixed(2) });

/** What went wrong, as the sentence itself (String(e) puts the error's class in front). Read off the error's own
 * fields, not its class: an error of another window is no instance of this one's classes. */
export const errorText = (e: unknown) => (typeof (e as { message?: unknown } | null)?.message === 'string' ? (e as { message: string }).message : String(e));
/** The login ran out (api.ts AuthError: the token is gone by then, so a reload shows the login screen and the same
 * address comes back after it). */
export const loginExpired = (e: unknown) => (e as { name?: unknown } | null)?.name === 'AuthError';

/** The live console open in the studio window, as its play window finds it on window.opener (`__ipverseConsole`): the
 * tab and values a start from here would send for that session's game, or null when it is open on another one, so
 * both windows start the same broadcast. attach: the play window hands itself to the console (every second),
 * since a reload of the studio drops the console's handle on it. */
export interface ConsoleHandle {
  settings: (sessionId: string, gameId: string) => LiveSettings | null;
  attach?: (play: Window, sessionId: string, gameId: string) => void;
}
