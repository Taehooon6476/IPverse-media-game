import { useRef, useState } from 'react';
import { t } from '../i18n';
import { createPortal } from 'react-dom';
import type { SessionSummary } from '../types';
import { useDialog } from './useDialog';

interface Props {
  session: SessionSummary;
  onClose: () => void;
  /** Rejects with the server's reason (409: a broadcast, a running job); the dialog then stays open and shows it. */
  onDelete: (id: string) => Promise<void>;
}

/** 최근 세션 → 삭제: the confirm step. 취소 has the focus, so Enter right after opening never deletes. */
export function DeleteSessionDialog({ session, onClose, onDelete }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => { if (!busy) onClose(); };
  useDialog(panel, close, '.session-delete-cancel');

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await onDelete(session.sessionId);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  // the question around the session's name, which is set in bold where the sentence has it in either language
  const [before, after] = t('{title} 세션을 지울까요? 이 세션의 IP, 영상, 게임이 모두 삭제되며 되돌릴 수 없어요. 게시해서 공유한 게임 주소도 더 이상 열리지 않아요.', { title: '\n' }).split('\n');
  // on body: the sidebar is a transformed drawer on phones, which would trap a fixed overlay inside it
  return createPortal(
    <div className="modal-root">
      <div className="modal-backdrop" onClick={close} />
      <div ref={panel} className="modal modal--sm" role="alertdialog" aria-modal="true" aria-labelledby="session-delete-title"
        aria-describedby="session-delete-desc">
        <div className="dialog-head">
          <h2 id="session-delete-title">{t('세션 삭제')}</h2>
        </div>
        <div className="dialog-body">
          {/* The last sentence: a delete removes every game folder of the session (server/store.py delete_session), so a
              published address stops opening. Said for every session: the list does not know which have a published game. */}
          <p id="session-delete-desc" className="dialog-lead">
            {before}<strong>{session.title}</strong>{after}
          </p>
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
        <div className="dialog-footer">
          <div className="dialog-actions">
            <button type="button" className="btn session-delete-cancel" onClick={close} disabled={busy}>{t('취소')}</button>
            <button type="button" className="btn btn-danger" onClick={confirm} disabled={busy}>{busy ? t('지우는 중…') : t('삭제')}</button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
