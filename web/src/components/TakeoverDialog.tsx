import { useEffect, useState, type ReactNode } from 'react';
import { listSessions, liveStatus } from '../api';
import { t } from '../i18n';
import { LIVE_MAX_MINUTES, playableServerLine } from '../liveSettings';
import { ConfirmDialog } from './ConfirmDialog';

/** A start the server refused because the same owner's other session is on air: it goes through with
 * `takeover: true`, sent only after the user said so. Read off the answer's status and code (server/live.py start:
 * 409 live_other_session), also across windows (the play window's error is another realm's object). Another
 * account's broadcast (409 live_busy) has no way around it. */
export function needsTakeover(e: unknown): boolean {
  const { status, code } = (e ?? {}) as { status?: unknown; code?: unknown };
  return status === 409 && code === 'live_other_session';
}

/** What a window says when its broadcast was ended by its owner's start in another session (status.endedBy). */
export const TOOK_OVER = t('내 다른 세션에서 라이브를 켜서 이 방송이 꺼졌어요.');

/** What a start that was called off throws: nothing went wrong, so nothing is said. */
export const CALLED_OFF = new Error('called off');

/** The session on air, as its owner knows it: its title and its game's. */
export interface OnAir { session: string; game: string }
/** The status of this many sessions is asked at once, and the look ends after this long at the latest. */
const LOOK_AT_ONCE = 6;
const LOOK_MS = 3000;

/** Which of the account's other sessions is on air. Neither the server's refusal nor the session list names it, so
 * their statuses are asked, a few at a time, until one is on air or `until` (epoch ms) has passed. None is also
 * when the channel is held by a start still under way. */
export async function onAirElsewhere(mine: string, until = Infinity): Promise<OnAir | null> {
  const others = (await listSessions()).sessions.filter((s) => s.sessionId !== mine);
  for (let i = 0; i < others.length && Date.now() < until; i += LOOK_AT_ONCE) {
    const found = (await Promise.all(others.slice(i, i + LOOK_AT_ONCE).map((s) => liveStatus(s.sessionId).then(
      (live): OnAir | null => (live.active ? { session: s.title, game: live.job?.adTitle ?? '' } : null), () => null)))).find((x) => x);
    if (found) return found;
  }
  return null;
}

/** What the yes of the question starts: a playable broadcast starts the playable server too, a paid GPU host. */
export interface TakeoverPlan { playable?: boolean; hourlyUsd?: number }

/** The question's words: which session and game go off air, that its watchers lose it, and what the yes starts
 * (for a playable broadcast, the paid server). The names carry no particle: they are whatever the user called them. */
export function takeoverText(air: OnAir | null, plan: TakeoverPlan = {}): string {
  const who = !air ? t('내 다른 세션이 방송 중이에요.')
    : air.game ? t('‘{session}’ 세션에서 ‘{game}’ 방송 중이에요.', { session: air.session, game: air.game })
      : t('‘{session}’ 세션에서 방송 중이에요.', { session: air.session });
  return `${who} ${t('그 방송을 끄면 보고 있던 시청 창도 멈춰요.')} ${t('새 방송은 최대 {n}분 뒤 자동으로 꺼져요.', { n: LIVE_MAX_MINUTES })}${plan.playable ? ` ${playableServerLine(plan.hourlyUsd)}.` : ''} ${t('그 방송을 끄고 이 게임을 방송할까요?')}`;
}

/** → [ask, dialog]: ask(plan) looks for the session on air (LOOK_MS at most: the press is still shown as on its way),
 * puts the question up and resolves with the answer; render `dialog` somewhere. */
export function useTakeoverQuestion(sessionId: string): [(plan?: TakeoverPlan) => Promise<boolean>, ReactNode] {
  const [up, setUp] = useState<null | { answer: (yes: boolean) => void; message: string }>(null);
  const ask = async (plan: TakeoverPlan = {}) => {
    const air = await Promise.race([onAirElsewhere(sessionId, Date.now() + LOOK_MS).catch(() => null),
      new Promise<null>((resolve) => window.setTimeout(resolve, LOOK_MS, null))]);
    return new Promise<boolean>((resolve) => setUp({ answer: resolve, message: takeoverText(air, plan) }));
  };
  const done = (yes: boolean) => { up?.answer(yes); setUp(null); };
  return [ask, up && (
    <ConfirmDialog title={t('다른 세션이 방송 중이에요')} message={up.message} confirmLabel={t('끄고 방송하기')}
      onConfirm={() => done(true)} onCancel={() => done(false)} />
  )];
}

/** A start called off at the question is no failed press. The button (ActionButton) reads a settled press as done
 * or as failed and nothing else, so a press that was called off is given a new button, at rest: → [the part of
 * the button's key that changes, what to call when a start is called off]. The new button takes the focus the old
 * one held. */
export function useCalledOff(): [number, () => void] {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (n && (!document.activeElement || document.activeElement === document.body)) document.querySelector<HTMLElement>('.live-toggle')?.focus();
  }, [n]);
  return [n, () => setN((x) => x + 1)];
}
