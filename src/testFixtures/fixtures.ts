import type { P2PEEW, P2PQuake, P2PUserquakeEvaluation } from '../types';

/**
 * Development-only payloads. These are deliberately synthetic and never represent
 * information received from P2P地震情報.
 */

function p2pTime(timestamp = Date.now()): string {
  // P2P's slash-separated timestamps are JST. Build the string from UTC after
  // applying the fixed +09:00 offset so fixtures remain correct on any host.
  const date = new Date(timestamp + 9 * 60 * 60 * 1_000);
  const pad = (value: number, digits = 2): string => String(value).padStart(digits, '0');
  return `${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${pad(date.getUTCMilliseconds(), 3)}`;
}

const fixtureSources = [
  { name: 'テスト千葉県東方沖', latitude: 35.5, longitude: 141.1, depth: 30, magnitude: 4.5, maxScale: 30 },
  { name: 'テスト福島県沖', latitude: 37.2, longitude: 141.4, depth: 40, magnitude: 4.8, maxScale: 20 },
  { name: 'テスト熊本県熊本地方', latitude: 32.8, longitude: 130.7, depth: 10, magnitude: 3.9, maxScale: 40 },
] as const;

export function createTestEarthquake(sequence: number): P2PQuake {
  const safeSequence = Math.max(1, Math.trunc(sequence));
  const source = fixtureSources[(safeSequence - 1) % fixtureSources.length];
  const time = p2pTime(Date.now() + safeSequence);
  return {
    id: `test-551-${safeSequence}`,
    code: 551,
    time,
    issue: { source: 'TEST FIXTURE', time },
    earthquake: {
      time,
      hypocenter: {
        name: source.name,
        latitude: source.latitude,
        longitude: source.longitude,
        depth: source.depth,
        magnitude: source.magnitude,
      },
      maxScale: source.maxScale,
    },
  };
}

let shakeStartedAt: string | null = null;

function ensureShakeStartedAt(): string {
  shakeStartedAt ??= p2pTime();
  return shakeStartedAt;
}

export function createTestShakeStart(): P2PUserquakeEvaluation {
  shakeStartedAt = p2pTime();
  const time = p2pTime();
  return {
    id: `test-9611-start-${Date.now()}`,
    code: 9611,
    time,
    count: 3,
    confidence: 0.86,
    started_at: shakeStartedAt,
    updated_at: time,
    area_confidences: {
      '010': { confidence: 0.86, count: 2 },
      '250': { confidence: 0.82, count: 1 },
    },
  };
}

export function createTestShakeUpdate(): P2PUserquakeEvaluation {
  const time = p2pTime();
  return {
    id: `test-9611-update-${Date.now()}`,
    code: 9611,
    time,
    count: 6,
    confidence: 0.94,
    started_at: ensureShakeStartedAt(),
    updated_at: time,
    area_confidences: {
      '010': { confidence: 0.94, count: 4 },
      '250': { confidence: 0.9, count: 2 },
      '350': { confidence: 0.81, count: 1 },
    },
  };
}

export function createTestShakeEnd(): P2PUserquakeEvaluation {
  const time = p2pTime();
  return {
    id: `test-9611-end-${Date.now()}`,
    code: 9611,
    time,
    count: 0,
    confidence: 0,
    started_at: ensureShakeStartedAt(),
    updated_at: time,
    area_confidences: {},
  };
}

const testEewEventId = 'TEST-EVENT-001';

function createTestEew(serial: string, id: string, scaleTo: number, latitude: number, longitude: number): P2PEEW {
  const time = p2pTime();
  const originTime = p2pTime(Date.now() - 15_000);
  const arrivalTime = p2pTime(Date.now() - 5_000);
  const forecastArrivalTime = p2pTime(Date.now() + 15_000);
  return {
    id,
    code: 556,
    time,
    test: true,
    cancelled: false,
    issue: { time, eventId: testEewEventId, serial },
    earthquake: {
      originTime,
      arrivalTime,
      condition: '',
      hypocenter: {
        name: 'テスト房総半島南方沖',
        reduceName: 'テスト房総沖',
        latitude,
        longitude,
        depth: 40,
        magnitude: 5.8,
      },
    },
    areas: [
      { pref: '千葉県', name: 'テスト房総', scaleFrom: scaleTo - 5, scaleTo, kindCode: '10', arrivalTime: forecastArrivalTime },
      { pref: '東京都', name: 'テスト東京', scaleFrom: 20, scaleTo: Math.max(20, scaleTo - 10), kindCode: '19', arrivalTime: null },
    ],
  };
}

export function createTestEewReport1(): P2PEEW {
  return createTestEew('1', `test-556-001-1-${Date.now()}`, 40, 34.8, 140.8);
}

export function createTestEewReport2(): P2PEEW {
  return createTestEew('2', `test-556-001-2-${Date.now()}`, 50, 34.9, 140.9);
}

export function createTestEewReport3(): P2PEEW {
  return createTestEew('3', `test-556-001-3-${Date.now()}`, 55, 35.0, 141.0);
}

/** Same event and old serial, used to verify that display state never rolls back. */
export function createTestEewOldReport1(): P2PEEW {
  return createTestEew('1', `test-556-001-old-1-${Date.now()}`, 40, 34.8, 140.8);
}

/** A non-cancelled continuation with no earthquake object. */
export function createTestEewMissingEarthquake(): P2PEEW {
  const time = p2pTime();
  return {
    id: `test-556-001-missing-earthquake-${Date.now()}`,
    code: 556,
    time,
    test: true,
    cancelled: false,
    issue: { time, eventId: testEewEventId, serial: '4' },
    areas: [
      { pref: '千葉県', name: 'テスト房総', scaleFrom: 45, scaleTo: 50, kindCode: '11', arrivalTime: null },
    ],
  };
}

export function createTestEewCancelled(): P2PEEW {
  const time = p2pTime();
  return {
    id: `test-556-001-cancelled-${Date.now()}`,
    code: 556,
    time,
    test: true,
    cancelled: true,
    issue: { time, eventId: testEewEventId, serial: '5' },
    areas: [],
  };
}
