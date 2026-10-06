import type {
  Earthquake,
  EewArea,
  EewDetection,
  EewMessage,
  P2PEEW,
  P2PEEWDetection,
  P2PQuake,
  P2PUserquake,
  P2PUserquakeEvaluation,
  ShakeDetection,
} from './types';

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
    basicTime: typeof item.time === 'string' ? item.time : null,
    issueTime: typeof item.issue?.time === 'string' ? item.issue.time : null,
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

/** Parse an EEW (code 556) without assuming that cancelled messages contain an earthquake. */
export function parseEew(value: unknown): EewMessage | null {
  if (!isRecord(value) || value.code !== 556 || typeof value.id !== 'string' || value.id.length === 0) return null;
  const item = value as unknown as P2PEEW;
  if (typeof item.time !== 'string' || item.time.length === 0 || typeof item.cancelled !== 'boolean') return null;

  const issue = item.issue;
  if (
    !isRecord(issue) ||
    typeof issue.time !== 'string' ||
    issue.time.length === 0 ||
    typeof issue.eventId !== 'string' ||
    issue.eventId.length === 0
  ) return null;
  const serial = normalizeSerial(issue.serial);
  if (serial === null) return null;

  const earthquake = parseEewEarthquake(item.earthquake);
  const areas = parseEewAreas(item.areas);
  const id = item.id as string;
  const time = item.time as string;
  const cancelled = item.cancelled as boolean;
  return {
    id,
    code: 556,
    time,
    test: item.test === true,
    cancelled,
    issue: { time: issue.time, eventId: issue.eventId, serial },
    earthquake,
    areas,
  };
}

/** Parse EEW publication detection (code 554) without starting EEW display. */
export function parseEewDetection(value: unknown): EewDetection | null {
  if (!isRecord(value) || value.code !== 554 || typeof value.id !== 'string' || value.id.length === 0) return null;
  const item = value as unknown as P2PEEWDetection;
  if (typeof item.time !== 'string' || item.time.length === 0) return null;
  const id = item.id as string;
  const time = item.time as string;
  return { id, code: 554, time, type: typeof item.type === 'string' ? item.type : null };
}

function parseEewEarthquake(value: unknown): EewMessage['earthquake'] {
  if (!isRecord(value)) return undefined;
  const hypocenter = isRecord(value.hypocenter) ? value.hypocenter : {};
  return {
    originTime: stringOrNull(value.originTime),
    arrivalTime: stringOrNull(value.arrivalTime),
    condition: stringOrNull(value.condition),
    hypocenter: {
      name: stringOrNull(hypocenter.name),
      reduceName: stringOrNull(hypocenter.reduceName),
      latitude: eewCoordinate(hypocenter.latitude),
      longitude: eewCoordinate(hypocenter.longitude),
      depth: eewValue(hypocenter.depth, -1),
      magnitude: eewValue(hypocenter.magnitude, -1),
    },
  };
}

function parseEewAreas(value: unknown): EewArea[] {
  if (!Array.isArray(value)) return [];
  const areas: EewArea[] = [];
  for (const rawArea of value) {
    if (!isRecord(rawArea) || typeof rawArea.pref !== 'string' || rawArea.pref.length === 0 || typeof rawArea.name !== 'string' || rawArea.name.length === 0) continue;
    areas.push({
      pref: rawArea.pref,
      name: rawArea.name,
      scaleFrom: eewScaleValue(rawArea.scaleFrom),
      scaleTo: eewScaleValue(rawArea.scaleTo),
      kindCode: normalizeKindCode(rawArea.kindCode),
      arrivalTime: stringOrNull(rawArea.arrivalTime),
    });
  }
  return areas;
}

function normalizeSerial(value: unknown): string | null {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return null;
}

function normalizeKindCode(value: unknown): string | null {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function eewValue(value: unknown, sentinel?: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return sentinel !== undefined && value === sentinel ? null : value;
}

function eewCoordinate(value: unknown): number | null {
  return eewValue(value, -200);
}

function eewScaleValue(value: unknown): number | null {
  const normalized = eewValue(value);
  if (normalized === null) return null;
  const integer = Math.trunc(normalized);
  return integer === -1 || [0, 10, 20, 30, 40, 45, 50, 55, 60, 70, 99].includes(integer) ? integer : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteValue(value: unknown, unavailableValue: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value !== unavailableValue ? value : null;
}
