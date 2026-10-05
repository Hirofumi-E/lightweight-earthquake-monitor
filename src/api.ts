import type { Earthquake, P2PQuake } from './types';

const API_URL = 'https://api.p2pquake.net/v2/history?codes=551&limit=10';

export async function fetchRecentEarthquakes(signal?: AbortSignal): Promise<Earthquake[]> {
  const response = await fetch(API_URL, { signal, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`地震情報を取得できませんでした (HTTP ${response.status})`);

  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) throw new Error('APIの応答形式が正しくありません');

  return payload.map(parseEarthquake).filter((item): item is Earthquake => item !== null);
}

export function parseEarthquake(value: unknown): Earthquake | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const item = value as P2PQuake;
  if (item.code !== 551 || typeof item.id !== 'string' || item.id.length === 0 || !item.earthquake) return null;

  const eventTime = item.earthquake.time;
  if (typeof eventTime !== 'string' || eventTime.length === 0) return null;
  const hypocenter = item.earthquake.hypocenter;

  return {
    id: item.id,
    time: eventTime,
    hypocenter: typeof hypocenter?.name === 'string' ? hypocenter.name : '震源地不明',
    maxScale: finiteValue(item.earthquake.maxScale, -1),
    magnitude: finiteValue(hypocenter?.magnitude, -1),
    depth: finiteValue(hypocenter?.depth, -1),
    latitude: finiteValue(hypocenter?.latitude, -200),
    longitude: finiteValue(hypocenter?.longitude, -200),
  };
}

function finiteValue(value: unknown, unavailableValue: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value !== unavailableValue ? value : null;
}
