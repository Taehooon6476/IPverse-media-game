import { useRef, useState, type FormEvent } from 'react';
import { t } from '../i18n';
import type { Game } from '../types';
import { useDialog } from './useDialog';

interface Props {
  game: Game;
  version: number;
  onClose: () => void;
  /** Sends the request through the chat; resolves when queued. */
  onSend: (text: string) => Promise<void>;
}

// (sent to the agent as the user's request: English requests on the English page)
const IDEAS = [t('적을 2배로 늘려줘'), t('제한 시간을 3분으로'), t('밤하늘 용광로로 바꿔줘'), t('보스를 더 크고 튼튼하게'), t('난이도를 쉽게'), t('경기장을 미로로')];

export const editGameMessage = (game: Game, request: string) =>
  // The first line is for the agent and the chat bubble (ChatDock userText; server/gamespec.py reads the tag): the
  // same in either language. The request under it is the user's.
  `[게임 수정 gameId=${game.gameId}] '${game.title}'을(를) 이렇게 고친 새 버전을 만들어줘. 나머지는 그대로 둬.\n${request.trim()}`;

/** Right-side drawer: ask the agent for a revised version of the selected game; the old version stays. */
export function GameEditDrawer({ game, version, onClose, onSend }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  useDialog(panel, onClose, '#game-edit-text');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    try {
      await onSend(editGameMessage(game, text));
      onClose();
    } catch {
      setBusy(false); // the toast says why; the text stays
    }
  }

  return (
    <div className="drawer-root">
      <div className="drawer-backdrop" onClick={onClose} />
      <div ref={panel} className="drawer" role="dialog" aria-modal="true" aria-labelledby="game-edit-title" aria-describedby="game-edit-intro">
        <div className="dialog-head">
          <div>
            <p className="eyebrow">GAME · v{version}</p>
            <h2 id="game-edit-title">{t('이 게임 수정')}</h2>
          </div>
          <button type="button" className="icon-btn" aria-label={t('닫기')} onClick={onClose}>×</button>
        </div>
        <form id="game-edit-form" className="dialog-body" onSubmit={submit} aria-busy={busy}>
          <p id="game-edit-intro" className="dialog-lead muted">{t('“{title}”(v{version})에서 바꿀 점을 적어 주세요. 지금 게임 설계를 바탕으로 새 버전을 만들고, 지금 버전은 그대로 남아요.', { title: game.title, version })}</p>
          <label className="field">
            <span>{t('수정 요청')}</span>
            <textarea id="game-edit-text" rows={5} value={text} onChange={(e) => setText(e.target.value)}
              placeholder={t('예: 적을 더 빠르게 하고, 제한 시간을 2분으로 줄여줘')} required />
          </label>
          <div className="chip-row" role="group" aria-label={t('예시')}>
            {IDEAS.map((idea) => (
              <button key={idea} type="button" className="chip-btn" onClick={() => setText((was) => (was.trim() ? `${was.trim()}\n${idea}` : idea))}>{idea}</button>
            ))}
          </div>
        </form>
        <div className="dialog-footer">
          <p id="game-edit-submit-hint" className="field-hint dialog-submit-hint" role="status">{busy ? t('수정 요청을 채팅으로 보내고 있어요.') : text.trim() ? t('요청을 보내면 채팅에 추가되고 새 게임 버전을 만들기 시작해요.') : t('바꾸고 싶은 내용을 입력해 주세요.')}</p>
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={onClose}>{t('취소')}</button>
            <button form="game-edit-form" type="submit" className="btn btn-primary" aria-describedby="game-edit-submit-hint" disabled={busy || !text.trim()}>{busy ? t('보내는 중…') : t('수정 버전 만들기')}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
