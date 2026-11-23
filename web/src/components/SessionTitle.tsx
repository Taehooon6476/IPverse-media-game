import { t } from '../i18n';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { errorMessage } from '../api';

const MAX = 60; // as the new-session form's field

interface Props {
  title: string;
  /** Saves the new name; rejects with the reason, which the field then shows. */
  onRename: (title: string) => Promise<void>;
}

/** The open session's name on its title row, changed in place: ✎ turns it into a field (60 characters, with a
 * count), Enter or 저장 saves, Esc or 취소 leaves it as it was. */
export function SessionTitle({ title, onRename }: Props) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  useEffect(() => { // back on ✎ once the field is gone, so the keyboard stays where it was
    if (wasEditing.current && !editing) opener.current?.focus();
    wasEditing.current = editing;
  }, [editing]);

  if (!editing) {
    return (
      <>
        <h2 className="hero-title" title={title}>{title}</h2>
        <button ref={opener} type="button" className="icon-btn hero-rename" aria-label={t('세션 이름 바꾸기')} title={t('세션 이름 바꾸기')}
          onClick={() => { setValue(title); setError(null); setEditing(true); }}>
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M11.2 2.3 13.7 4.8 5.6 12.9 2.6 13.4 3.1 10.4Z M9.8 3.7l2.5 2.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round" /></svg>
        </button>
      </>
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const next = value.trim();
    if (!next || busy) return;
    if (next === title) { setEditing(false); return; }
    setBusy(true);
    setError(null);
    try {
      await onRename(next);
      setEditing(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="hero-rename-form" onSubmit={submit} aria-busy={busy}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || e.metaKey || e.ctrlKey || e.altKey) return;
        e.stopPropagation();
        setEditing(false);
      }}>
      <label htmlFor="session-title-input" className="sr-only">{t('세션 이름')}</label>
      <input id="session-title-input" autoFocus maxLength={MAX} value={value} readOnly={busy} aria-invalid={error ? true : undefined}
        aria-describedby={error ? 'session-title-count session-title-error' : 'session-title-count'}
        onFocus={(e) => e.currentTarget.select()} onChange={(e) => setValue(e.target.value)} />
      {/* at the limit the count says so */}
      <span id="session-title-count" className={value.length >= MAX ? 'hero-rename-count is-full' : 'hero-rename-count'} role="status"
        aria-label={t('{n}자, 최대 {max}자', { n: value.length, max: MAX })}>{value.length}/{MAX}{value.length >= MAX ? t(' · 최대 {max}자예요', { max: MAX }) : ''}</span>
      <button type="submit" className="btn btn-sm btn-primary" disabled={busy || !value.trim()}>{busy ? t('저장 중…') : t('저장')}</button>
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(false)} disabled={busy}>{t('취소')}</button>
      {error && <p id="session-title-error" className="form-error" role="alert">{error}</p>}
    </form>
  );
}
