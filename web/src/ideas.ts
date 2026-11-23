/** First lines a newcomer can start from, as a first message would be typed: the start screen's examples
 * (StartScreen) and the chat's in a session with nothing said yet (ChatDock). */
import { t } from './i18n';

export const IDEAS = [
  t('우주 고양이 탐험가와 탐사용 드론을 만들어줘'),
  t('숲을 지키는 꼬마 궁수와 나무 정령을 만들어줘'),
  t('네온 도시의 배달 로봇과 호버 스쿠터를 만들어줘'),
  t('사막 유적을 탐험하는 고고학자와 황금 나침반을 만들어줘'),
];

/** The name of a session opened from an idea: what the idea asks for, without the asking ("우주 고양이 탐험가와 탐사용
 * 드론"), 60 characters at most (the name field's limit). */
export const ideaTitle = (idea: string) => [...subject(idea.trim().replace(/[을를]?\s*(?:만들어|그려)\s*줘[.!]?$/, '').trim())].slice(0, 60).join('');
/** The same of an English idea: "Make a space cat explorer and a survey drone" is "A space cat explorer and a survey drone". */
function subject(idea: string): string {
  const asked = idea.match(/^(?:make|create|draw)\s+(?:me\s+)?(.+?)[.!]?$/i)?.[1];
  return asked ? asked[0].toUpperCase() + asked.slice(1) : idea;
}
