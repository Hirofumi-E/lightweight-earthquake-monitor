import type { P2PEEW, P2PQuake, P2PUserquakeEvaluation } from '../types';

/**
 * Development-only payloads. These are deliberately synthetic and never represent
 * information received from P2P地震情報.
 */

function fixtureTime(sequence: number): string {
  return new Date(Date.UTC(2025, 0, 1, 0, sequence, 0)).toISOString();
}

const fixtureSources = [
  { name: 'テスト千葉県東方沖', latitude: 35.5, longitude: 141.1, depth: 30, magnitude: 4.5, maxScale: 30 },
  { name: 'テスト福島県沖', latitude: 37.2, longitude: 141.4, depth: 40, magnitude: 4.8, maxScale: 20 },
  { name: 'テスト熊本県熊本地方', latitude: 32.8, longitude: 130.7, depth: 10, magnitude: 3.9, maxScale: 40 },
] as const;

export function createTestEarthquake(sequence: number): P2PQuake {
  const safeSequence = Math.max(1, Math.trunc(sequence));
  const source = fixtureSources[(safeSequence - 1) % fixtureSources.length];
  const time = fixtureTime(safeSequence);
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

const shakeStartedAt = '2025/01/01 00:10:00.000';

export const testShakeStart: P2PUserquakeEvaluation = {
  id: 'test-9611-start',
  code: 9611,
  time: '2025/01/01 00:10:05.000',
  count: 3,
  confidence: 0.86,
  started_at: shakeStartedAt,
  updated_at: '2025/01/01 00:10:05.000',
  area_confidences: {
    '010': { confidence: 0.86, count: 2 },
    '250': { confidence: 0.82, count: 1 },
  },
};

export const testShakeUpdate: P2PUserquakeEvaluation = {
  id: 'test-9611-update',
  code: 9611,
  time: '2025/01/01 00:10:12.000',
  count: 6,
  confidence: 0.94,
  started_at: shakeStartedAt,
  updated_at: '2025/01/01 00:10:12.000',
  area_confidences: {
    '010': { confidence: 0.94, count: 4 },
    '250': { confidence: 0.9, count: 2 },
    '350': { confidence: 0.81, count: 1 },
  },
};

export const testShakeEnd: P2PUserquakeEvaluation = {
  id: 'test-9611-end',
  code: 9611,
  time: '2025/01/01 00:10:20.000',
  count: 0,
  confidence: 0,
  started_at: shakeStartedAt,
  updated_at: '2025/01/01 00:10:20.000',
  area_confidences: {},
};

const testEewEventId = 'TEST-EVENT-001';

function createTestEew(serial: string, id: string, scaleTo: number, latitude: number, longitude: number): P2PEEW {
  return {
    id,
    code: 556,
    time: '2025/01/01 00:11:00.000',
    test: true,
    cancelled: false,
    issue: { time: '2025/01/01 00:11:00.000', eventId: testEewEventId, serial },
    earthquake: {
      originTime: '2025/01/01 00:10:45.000',
      arrivalTime: '2025/01/01 00:10:55.000',
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
      { pref: '千葉県', name: 'テスト房総', scaleFrom: scaleTo - 5, scaleTo, kindCode: '10', arrivalTime: '2025/01/01 00:11:30.000' },
      { pref: '東京都', name: 'テスト東京', scaleFrom: 20, scaleTo: Math.max(20, scaleTo - 10), kindCode: '19', arrivalTime: null },
    ],
  };
}

export const testEewReport1 = createTestEew('1', 'test-556-001-1', 40, 34.8, 140.8);
export const testEewReport2 = createTestEew('2', 'test-556-001-2', 50, 34.9, 140.9);
export const testEewReport3 = createTestEew('3', 'test-556-001-3', 55, 35.0, 141.0);

/** Same event and old serial, used to verify that display state never rolls back. */
export const testEewOldReport1 = createTestEew('1', 'test-556-001-old-1', 40, 34.8, 140.8);

/** A non-cancelled continuation with no earthquake object. */
export const testEewMissingEarthquake: P2PEEW = {
  id: 'test-556-001-missing-earthquake',
  code: 556,
  time: '2025/01/01 00:11:20.000',
  test: true,
  cancelled: false,
  issue: { time: '2025/01/01 00:11:20.000', eventId: testEewEventId, serial: '4' },
  areas: [
    { pref: '千葉県', name: 'テスト房総', scaleFrom: 45, scaleTo: 50, kindCode: '11', arrivalTime: null },
  ],
};

export const testEewCancelled: P2PEEW = {
  id: 'test-556-001-cancelled',
  code: 556,
  time: '2025/01/01 00:11:25.000',
  test: true,
  cancelled: true,
  issue: { time: '2025/01/01 00:11:25.000', eventId: testEewEventId, serial: '5' },
  areas: [],
};
