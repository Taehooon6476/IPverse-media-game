/** HH:MM:SS.d, the clock burnt into the broadcast and shown beside the viewer's player (same format). */
export const clockText = (d: Date) =>
  `${d.toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}.${Math.floor(d.getMilliseconds() / 100)}`;
