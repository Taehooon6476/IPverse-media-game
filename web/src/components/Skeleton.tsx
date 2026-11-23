import { t } from '../i18n';
/** Pane placeholder while the first snapshot loads. Jobs never use this; they show progress text. */
export function Skeleton({ label }: { label: string }) {
  return (
    <section className="pane" aria-label={label} aria-busy="true">
      <span className="sr-only" role="status">{t('{label}을 불러오고 있어요.', { label })}</span>
      <div className="pane-head" aria-hidden="true">
        <div className="skel skel-title" />
      </div>
      <div className="skel-tabs" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => <div key={i} className="skel skel-tab" />)}
      </div>
      <div className="skel-grid" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => <div key={i} className="skel skel-card" />)}
      </div>
    </section>
  );
}
