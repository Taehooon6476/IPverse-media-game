import { useId, useRef } from 'react';
import { t } from '../i18n';
import { createPortal } from 'react-dom';
import { useDialog } from './useDialog';

interface Props {
  /** The dialog's heading: whose picture and which version ("반딧불 등불 · v2"). */
  title: string;
  src: string;
  alt: string;
  /** The picture with its background removed: shown over the checker the card uses. */
  cutout?: boolean;
  /** The words the picture was drawn from (the image model's prompt, in English): behind a fold. */
  prompt?: string;
  onClose: () => void;
}

/** An IP's picture, big. On <body>, so it covers the whole studio; the pane tells the shell while it is open
 * (IpPane onModal). */
export function PictureModal({ title, src, alt, cutout, prompt, onClose }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  useDialog(panel, onClose);
  return createPortal(
    <div className="modal-root picture-root">
      <div className="modal-backdrop" onClick={onClose} />
      <div ref={panel} className="modal picture-modal" role="dialog" aria-modal="true" aria-labelledby={`${id}-t`}>
        <div className="dialog-head">
          <h2 id={`${id}-t`}>{title}</h2>
          <button type="button" className="icon-btn" aria-label={t('닫기')} onClick={onClose}>×</button>
        </div>
        <div className="dialog-body">
          <figure className="picture-figure">
            <div className={cutout ? 'picture-stage is-cutout' : 'picture-stage'}><img src={src} alt={alt} /></div>
            {prompt && (
              <figcaption>
                <details className="picture-prompt">
                  <summary>{t('이 그림의 프롬프트 보기 (영어)')}</summary>
                  <p>{prompt}</p>
                </details>
              </figcaption>
            )}
          </figure>
        </div>
      </div>
    </div>,
    document.body,
  );
}
