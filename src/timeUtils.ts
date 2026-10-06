/** Parse P2P地震情報 timestamps as Japan Standard Time. */
export function parseP2pTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = value.match(/^(\d{4})[/-](\d{2})[/-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
  if (match) {
    const [, year, month, day, hour, minute, second, fraction = '0'] = match;
    if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
    const milliseconds = Number(fraction.padEnd(3, '0'));
    // Validate the calendar fields before applying the JST offset.  Applying
    // -09:00 first can move a valid timestamp to the previous UTC date and
    // would make an otherwise valid late-night/early-morning value fail.
    const local = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), milliseconds);
    const localDate = new Date(local);
    if (
      Number.isFinite(local) &&
      localDate.getUTCFullYear() === Number(year) &&
      localDate.getUTCMonth() === Number(month) - 1 &&
      localDate.getUTCDate() === Number(day) &&
      localDate.getUTCHours() === Number(hour) &&
      localDate.getUTCMinutes() === Number(minute) &&
      localDate.getUTCSeconds() === Number(second)
    ) return local - 9 * 60 * 60 * 1_000;
    return null;
  }

  // Only accept an unambiguous ISO-8601 form as a fallback.  Bare strings are
  // intentionally rejected so a browser's local timezone rules cannot change
  // the meaning of a P2P timestamp.
  if (!value.includes('T') && !/[zZ]$/.test(value) && !/[+-]\d{2}:?\d{2}$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export interface LatencyValue {
  milliseconds: number | null;
  clockSkew: boolean;
}

export function calculateLatency(browserReceivedAt: number, sourceTimestamp: string | null | undefined): LatencyValue {
  const source = parseP2pTimestamp(sourceTimestamp);
  if (source === null) return { milliseconds: null, clockSkew: false };
  const milliseconds = browserReceivedAt - source;
  return milliseconds < 0
    ? { milliseconds: null, clockSkew: true }
    : { milliseconds, clockSkew: false };
}

export function formatLatency(value: LatencyValue): string {
  if (value.clockSkew) return '時計差あり';
  if (value.milliseconds === null) return '—';
  return `${(value.milliseconds / 1000).toFixed(2)}秒`;
}

export function formatAge(receivedAt: number | null, now = Date.now()): string {
  if (receivedAt === null) return '待機中';
  const elapsed = now - receivedAt;
  if (elapsed < 0) return '時計差あり';
  const seconds = Math.floor(elapsed / 1000);
  if (seconds < 1) return 'たった今';
  if (seconds < 60) return `${seconds}秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}時間前`;
  return `${Math.floor(hours / 24)}日前`;
}

export function formatClock(timestamp: number | null): string {
  if (timestamp === null) return '—';
  return new Intl.DateTimeFormat('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(timestamp));
}
