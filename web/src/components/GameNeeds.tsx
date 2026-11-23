import { lang, t } from '../i18n';
import { THREE_D_TOTAL, gameThreeD, josa, type Asset, type GameThreeD, type Ip, type Job } from '../types';
import { CHAT_BOX_EVENT } from './ChatDock';

/** What stands between a session and its first game, read off its IPs: the game pane's empty state and the 게임 설계
 * drawer say the same steps and offer the same way on. */
export interface GameNeeds {
  /** The session's characters, each with where its 3D is. */
  heroes: { ip: Ip; threeD: GameThreeD }[];
  /** A character's 3D is finished: 게임 설계 can be filled and sent (its player is a character in 3D). */
  ready: boolean;
  /** The character whose 3D is being made now. */
  making?: { ip: Ip; threeD: GameThreeD };
  /** The first character whose 3D was not started (or failed): the one step ② starts. */
  todo?: Ip;
  /** No character at all, and an IP that can stand in a game whose 3D is finished: what a game asked for in chat is
   * played by (server/tools.py hold_heroes; _needs_3d asks only that the player's IP is 3D-ready). */
  standIn?: Ip;
  /** No character, but IPs that could stand in once they are in 3D. */
  others: boolean;
  /** The step to do now: 1 = a character (in chat), 2 = its 3D, 3 = 게임 설계. */
  step: 1 | 2 | 3;
}

export function gameNeeds(ips: Ip[], assets: Asset[], jobs: Job[]): GameNeeds {
  const heroes = ips.filter((ip) => ip.kind === 'character').map((ip) => ({ ip, threeD: gameThreeD(ip, assets, jobs) }));
  const ready = heroes.some((h) => h.threeD.state === 'ready');
  // as the server's pool of a session without a character: everything but a whole-scene background
  const others = heroes.length ? [] : ips.filter((ip) => ip.usage !== 'background');
  return {
    heroes, ready,
    making: heroes.find((h) => h.threeD.state === 'running'),
    todo: heroes.find((h) => h.threeD.state === 'none')?.ip,
    standIn: others.find((ip) => gameThreeD(ip, assets, jobs).state === 'ready'),
    others: others.length > 0,
    step: ready ? 3 : heroes.length ? 2 : 1,
  };
}

export const NEEDS_TITLE = t('게임은 3D 주인공이 준비되면 만들 수 있어요');
/** What chat does in a session with no character, in one sentence (GameNeeds.standIn). */
export const standInLine = (name: string) => (lang === 'en' ? t('캐릭터가 없는 세션에서는 3D가 끝난 ‘{name}’이(가) 주인공으로 나와요.', { name })
  : `캐릭터가 없는 세션에서는 3D가 끝난 ‘${name}’${josa(name, '이', '가')} 주인공으로 나와요.`);
/** ... and why the chat is the one way offered there: 게임 설계 takes a character as the player. */
export const STAND_IN_WHY = t('소품이나 적이 주인공인 게임은 채팅으로 요청해 주세요.');
/** ... and before any of its IPs is in 3D. */
export const OTHERS_NOTE = t('캐릭터 없이도 돼요. 지금 있는 IP를 3D로 만든 뒤 채팅으로 게임을 요청하면 그 IP가 주인공으로 나와요.');
/** The chat, opened if it is shut, with the caret in its box (the top bar's skip link does the same). */
export const toChat = () => window.dispatchEvent(new Event(CHAT_BOX_EVENT));

/** The order of what a game needs, the step to do now marked. A 3D step's name and the chain's time come from the
 * steps' own table (types.ts), as the cards' do. */
export function NeedsSteps({ needs }: { needs: GameNeeds }) {
  const { making } = needs;
  return (
    <ol className="game-needs">
      <li aria-current={needs.step === 1 ? 'step' : undefined}>{t('① 채팅으로 캐릭터 만들기')}</li>
      <li aria-current={needs.step === 2 ? 'step' : undefined}>{making ? t('② {name} 3D 만드는 중 · {phase}', { name: making.ip.name, phase: making.threeD.phase ?? '' })
        : t('② 캐릭터 카드의 ‘3D로 만들기’ (보통 {total})', { total: THREE_D_TOTAL })}</li>
      <li aria-current={needs.step === 3 ? 'step' : undefined}>{t('③ 게임 설계')}</li>
    </ol>
  );
}
