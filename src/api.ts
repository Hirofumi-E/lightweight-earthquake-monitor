import type { Earthquake, P2PQuake } from './types';

const API_URL = 'https://api.p2pquake.net/v2/history?codes=551&limit=10';

export async function fetchRecentEarthquakes(signal?: AbortSignal): Promise<Earthquake[]> {
  const response = await fetch(API_URL, { signal, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`地震情報を取得できませんでした (HTTP ${response.status})`);

  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) throw new Error('APIの応答形式が正しくありません');

  return (payload as P2PQuake[])
    .filter((item) => item?.code === 551 && item.earthquake)
    .map((item) => ({
      id: item.id ?? `${item.earthquake?.time ?? item.time}-${item.earthquake?.hypocenter?.name ?? 'unknown'}`,
      time: item.earthquake?.time ?? item.time,
      hypocenter: item.earthquake?.hypocenter?.name ?? '震源地不明',
      maxScale: typeof item.earthquake?.maxScale === 'number' ? item.earthquake.maxScale : null,
      magnitude: typeof item.earthquake?.hypocenter?.magnitude === 'number' ? item.earthquake.hypocenter.magnitude : null,
      depth: typeof item.earthquake?.hypocenter?.depth === 'number' ? item.earthquake.hypocenter.depth : null,
    }));
}
