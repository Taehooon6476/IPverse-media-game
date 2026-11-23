import { useEffect, useState } from 'react';
import { t } from '../i18n';
import { clockText } from '../liveDelay';

/** The viewer's own clock over the live player: minus the 송출 time burnt into the picture = the broadcast delay. */
export function LiveClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 100);
    return () => window.clearInterval(timer);
  }, []);
  return <span className="live-clock" title={t('화면 왼쪽 아래 ‘송출’ 시각과의 차이가 실제 방송 지연이에요')}>{t('지금 {time}', { time: clockText(now) })}</span>;
}
