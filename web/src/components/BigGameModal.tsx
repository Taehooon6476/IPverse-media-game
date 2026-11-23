import { useEffect, useRef } from 'react';
import { t } from '../i18n';
import { useDialog } from './useDialog';

/** 크게 보기: the game alone in a centred Modal (full screen under 640 px). */
export function BigGameModal({ title, url, onClose }: { title: string; url: string; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  // The game's frame takes the focus as the view opens, so its keys work at once (the dialog's Tab order lists no frame).
  useDialog(panel, onClose, 'iframe');
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);
  return (
    <div className="modal-root big-game-root">
      <div className="modal-backdrop" onClick={onClose} />
      <div ref={panel} className="modal big-game" role="dialog" aria-modal="true" aria-labelledby="big-game-title">
        <div className="dialog-head">
          <h2 id="big-game-title">{title}</h2>
          <button type="button" className="icon-btn" aria-label={t('닫기')} onClick={onClose}>×</button>
        </div>
        <div className="big-game-frame">
          <iframe src={url} title={t('{title} 게임', { title })} allow="autoplay; fullscreen; gamepad"
            onLoad={(e) => { // the game takes focus inside the frame: Esc there closes the Modal too
              try { e.currentTarget.contentWindow?.addEventListener('keydown', (k) => { if (k.key === 'Escape') onClose(); }); } catch { /* other origin */ }
              // the page that just loaded gets the keys, unless the user has gone to 닫기 meanwhile
              if (document.activeElement === e.currentTarget || document.activeElement === document.body) e.currentTarget.focus();
            }} />
        </div>
      </div>
    </div>
  );
}
