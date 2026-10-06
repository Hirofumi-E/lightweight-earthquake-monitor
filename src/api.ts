import type { Earthquake, P2PQuake, P2PUserquake, P2PUserquakeEvaluation, ShakeDetection } from './types';

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

/** Parse the pre-evaluation user sensing message without treating it as a quake. */
export function parseUserquake(value: unknown): P2PUserquake | null {
  if (!isRecord(value) || value.code !== 561 || typeof value.id !== 'string' || value.id.length === 0) return null;
  const item = value as unknown as P2PUserquake;
  return {
    code: 561,
    id: item.id,
    time: typeof item.time === 'string' ? item.time : undefined,
    area: typeof item.area === 'number' && Number.isInteger(item.area) ? item.area : undefined,
  };
}

/** Parse the 9611 evaluation used by the shake detection UI. */
export function parseShakeDetection(value: unknown): ShakeDetection | null {
  if (!isRecord(value) || value.code !== 9611 || typeof value.id !== 'string' || value.id.length === 0) return null;
  const item = value as unknown as P2PUserquakeEvaluation;
  if (
    typeof item.time !== 'string' ||
    !Number.isInteger(item.count) ||
    typeof item.confidence !== 'number' ||
    !Number.isFinite(item.confidence) ||
    typeof item.started_at !== 'string' ||
    item.started_at.length === 0
  ) return null;

  const id = item.id as string;
  const time = item.time as string;
  const count = item.count as number;
  const confidence = item.confidence as number;
  const startedAt = item.started_at;
  const updatedAt = typeof item.updated_at === 'string' && item.updated_at.length > 0 ? item.updated_at : time;
  const areaConfidences = new Map<string, number>();
  if (isRecord(item.area_confidences)) {
    for (const [code, rawArea] of Object.entries(item.area_confidences)) {
      if (!isRecord(rawArea) || typeof rawArea.confidence !== 'number' || !Number.isFinite(rawArea.confidence)) continue;
      areaConfidences.set(code, rawArea.confidence);
    }
  }

  return {
    id,
    time,
    count,
    confidence,
    startedAt,
    updatedAt,
    areaConfidences,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteValue(value: unknown, unavailableValue: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value !== unavailableValue ? value : null;
}
