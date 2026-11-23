import { t } from '../i18n';
import { useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useDialog } from './useDialog';

interface Props {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** A short yes/no before a paid or lasting action, portalled to <body>. It opens with the focus on 취소, so the
 * Enter or Space of the press that opened it cannot confirm. */
export function ConfirmDialog({ title, message, confirmLabel, danger, onConfirm, onCancel }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  useDialog(panel, onCancel, '.confirm-cancel');
  return createPortal(
    <div className="modal-root confirm-root">
      <div className="modal-backdrop" onClick={onCancel} />
      <div ref={panel} className="modal modal--sm" role="alertdialog" aria-modal="true" aria-labelledby={`${id}-t`} aria-describedby={`${id}-m`}>
        <div className="dialog-head"><h2 id={`${id}-t`}>{title}</h2></div>
        <div className="dialog-body"><p id={`${id}-m`} className="dialog-lead">{message}</p></div>
        <div className="dialog-footer">
          <div className="dialog-actions">
            <button type="button" className="btn confirm-cancel" onClick={onCancel}>{t('취소')}</button>
            <button type="button" className={`btn ${danger ? 'btn-danger' : 'btn-primary'} confirm-ok`} onClick={onConfirm}>{confirmLabel}</button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
