// The studio in two languages. Korean is the source: every text is written in Korean where it is used and passed
// through t(); its English is looked up by that Korean sentence (web/src/i18n/en-*.ts). A sentence with no English
// shows in Korean. The language is fixed for the page's life: the toggle saves the choice and reloads.
import { EN_LIVE } from './i18n/en-live';
import { EN_PANES } from './i18n/en-panes';
import { EN_SHELL } from './i18n/en-shell';
import { local } from './storage';

export type Lang = 'ko' | 'en';
const KEY = 'ipverse.lang';

/** The page's language (한국어 unless English was chosen in this browser). */
export const lang: Lang = local.get(KEY) === 'en' ? 'en' : 'ko';

export const EN: Record<string, string> = { ...EN_SHELL, ...EN_PANES, ...EN_LIVE };

const fill = (text: string, vars?: Record<string, string | number>) =>
  (vars ? text.replace(/\{(\w+)\}/g, (whole, key: string) => (key in vars ? String(vars[key]) : whole)) : text);

/** A key's sentence in the page's language. A key may end in `#note`: the same Korean with another meaning, which
 * takes another English ('대기 중' a job that waits, '대기 중#방송' a channel that is idle). The note is never shown. */
function say(ko: string): string {
  const note = ko.lastIndexOf('#');
  const korean = note > 0 ? ko.slice(0, note) : ko;
  return lang === 'en' ? EN[ko] ?? korean : korean;
}

/** The text in the page's language. `ko` is the Korean sentence, with {name} places filled from `vars` in either
 * language: t('{n}판마다', { n: 2 }). */
export function t(ko: string, vars?: Record<string, string | number>): string {
  return fill(say(ko), vars);
}

/** A sentence with a count, which fills its {n}: tn('광고 {n}회', 1). Korean has one form; the English keeps two,
 * 'one|other' ("{n} ad|{n} ads"), and the count picks (1 takes the first). */
export function tn(ko: string, n: number, vars?: Record<string, string | number>): string {
  const forms = say(ko).split('|');
  return fill(forms[n === 1 ? 0 : forms.length - 1], { n, ...vars });
}

/** An Error whose message is a sentence this app wrote, so a toast may show it as it is (api.ts errorMessage). In
 * English the browser's and a library's errors are sentences too: only this mark tells ours from theirs. */
export const said = (text: string): Error => Object.assign(new Error(text), { ours: true });
/** Whether an error carries that mark (read off the value: an Error of another window is no `instanceof Error` here). */
export const isSaid = (e: unknown): boolean => (e as { ours?: unknown } | null)?.ours === true;
/** An error's sentence when it is one to show: marked as ours (the server's answers are: api.ts ApiError), or Korean,
 * which only this app and its server write. Else null: the caller says its own line. */
export function sentenceOf(e: unknown): string | null {
  const message = (e as { message?: unknown } | null)?.message;
  return typeof message === 'string' && (isSaid(e) || /[가-힣]/.test(message)) ? message : null;
}

/** Keeps the choice and draws the page again in it. */
export function setLang(next: Lang): void {
  local.set(KEY, next);
  window.location.reload();
}

if (typeof document !== 'undefined') document.documentElement.lang = lang;
