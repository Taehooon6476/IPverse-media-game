import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import type { Highlight } from '../api';

interface Props {
  items: Highlight[]; // newest first
  onSend: (h: Highlight) => void;
  onDelete: (h: Highlight) => void;
  /** The broadcast ended: the highlights stay to watch, sending and deleting need a live job. */
  readOnly?: boolean;
}

// what is happening, without the model's and the tool's names (those stay in 고급 설정 and tooltips)
const STATE: Record<string, string> = {
  uploading: t('녹화 영상을 올리는 중…'),
  analyzing: t('AI가 명장면을 골라 자르는 중…'),
};

/** One highlight short at a time, newest first; ‹ › and the dots move between them, ← → too. A new highlight
 * comes to the front only while you are looking at the newest one. */
export function HighlightCarousel({ items, onSend, onDelete, readOnly }: Props) {
  const [id, setId] = useState<string | null>(null);
  const newest = useRef<string | null>(null);
  useEffect(() => {
    const first = items[0]?.id ?? null;
    if (first !== newest.current) {
      setId((cur) => (cur === null || cur === newest.current ? first : cur));
      newest.current = first;
    }
  }, [items]);

  if (!items.length) {
    return <p className="muted hl-empty">{t('자동 생성을 켜면 판이 끝날 때마다 4–6초 하이라이트 쇼츠가 여기에 쌓여요.')}</p>;
  }
  const index = Math.max(0, items.findIndex((h) => h.id === id));
  const h = items[index];
  const go = (i: number) => setId(items[(i + items.length) % items.length].id);

  return (
    <section className="hl-carousel" aria-roledescription="carousel" aria-label={t('하이라이트 쇼츠')}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') { e.preventDefault(); go(index - 1); }
        if (e.key === 'ArrowRight') { e.preventDefault(); go(index + 1); }
      }}>
      <div className="hl-slide" role="group" aria-roledescription="slide" aria-label={`${index + 1} / ${items.length}`} key={h.id}>
        <div className="hl-media">
          {h.state === 'ready' && h.shortUrl ? (
            <video src={h.shortUrl} muted autoPlay loop playsInline aria-label={t('{n}판 하이라이트: {title}', { n: h.round, title: h.title ?? '' })} />
          ) : h.state === 'failed' ? (
            <p className="hl-status hl-status--failed">{t('만들지 못했어요')}{h.error ? `: ${h.error.slice(-120)}` : ''}</p>
          ) : (
            <p className="hl-status skel">{STATE[h.state]}</p>
          )}
        </div>
        <div className="hl-meta">
          <strong>{h.title ?? t('{n}판 하이라이트', { n: h.round })}</strong>
          <span>{t('{n}판', { n: h.round })}{h.clipSeconds ? ` · ${t('{n}초', { n: h.clipSeconds.toFixed(1) })}` : ''}{h.start != null ? ` · ${t('{from}–{to}초 구간', { from: h.start.toFixed(1), to: h.end?.toFixed(1) ?? '' })}` : ''}{h.excitement ? ` · ${h.excitement}` : ''}</span>
        </div>
        <div className="hl-actions">
          <button type="button" className="btn btn-sm btn-primary hl-send" disabled={h.state !== 'ready' || readOnly} title={readOnly ? t('방송 중에만 광고로 보낼 수 있어요') : undefined} onClick={() => onSend(h)}>
            {t('광고로 보내기')}
          </button>
          <button type="button" className="btn btn-sm btn-ghost hl-delete" aria-label={t('{n}판 하이라이트 삭제', { n: h.round })} disabled={readOnly} onClick={() => onDelete(h)}>
            {t('삭제')}
          </button>
        </div>
      </div>
      {items.length > 1 && (
        <div className="hl-nav">
          <button type="button" className="icon-btn" aria-label={t('이전 하이라이트')} onClick={() => go(index - 1)}>‹</button>
          <div className="hl-dots" role="tablist" aria-label={t('하이라이트 선택')}>
            {items.map((x, i) => (
              <button key={x.id} type="button" role="tab" aria-selected={i === index} aria-label={t('{n}판', { n: x.round })}
                className={i === index ? 'hl-dot is-on' : 'hl-dot'} onClick={() => setId(x.id)} />
            ))}
          </div>
          <button type="button" className="icon-btn" aria-label={t('다음 하이라이트')} onClick={() => go(index + 1)}>›</button>
        </div>
      )}
    </section>
  );
}
