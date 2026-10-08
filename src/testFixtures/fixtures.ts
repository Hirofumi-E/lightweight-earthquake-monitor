import { parseP2pTimestamp } from '../timeUtils';
import type { Earthquake, P2PEEW, P2PQuake, P2PUserquake, P2PUserquakeEvaluation } from '../types';

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

const sameEventOriginTime = p2pTime(Date.now() - 60_000);
let sameEventIssueBase = Date.now();
let sameEventLastIssue = sameEventIssueBase;

function nextSameEventIssueTime(offsetMs: number): string {
  sameEventLastIssue = Math.max(Date.now(), sameEventIssueBase + offsetMs, sameEventLastIssue + 1);
  return p2pTime(sameEventLastIssue);
}

function createTestEventReport(
  id: string,
  type: NonNullable<P2PQuake['issue']>['type'],
  issueTime: string,
  fields: { maxScale: number; name?: string; latitude?: number; longitude?: number; magnitude?: number; depth?: number },
  correct = false,
): P2PQuake {
  return {
    id,
    code: 551,
    time: issueTime,
    issue: { source: 'TEST FIXTURE', time: issueTime, type, correct },
    earthquake: {
      time: sameEventOriginTime,
      maxScale: fields.maxScale,
      ...(fields.name || fields.latitude !== undefined || fields.longitude !== undefined || fields.magnitude !== undefined || fields.depth !== undefined
        ? { hypocenter: {
          ...(fields.name ? { name: fields.name } : {}),
          ...(fields.latitude !== undefined ? { latitude: fields.latitude } : {}),
          ...(fields.longitude !== undefined ? { longitude: fields.longitude } : {}),
          ...(fields.magnitude !== undefined ? { magnitude: fields.magnitude } : {}),
          ...(fields.depth !== undefined ? { depth: fields.depth } : {}),
        } }
        : {}),
    },
  };
}

export function createTestEventScalePrompt(): P2PQuake {
  sameEventIssueBase = Date.now();
  sameEventLastIssue = sameEventIssueBase;
  return createTestEventReport('test-event-551-scale-prompt', 'ScalePrompt', p2pTime(sameEventIssueBase), { maxScale: 30 });
}

export function createTestEventDestination(): P2PQuake {
  return createTestEventReport('test-event-551-destination', 'Destination', nextSameEventIssueTime(2_000), {
    maxScale: -1,
    name: 'テスト茨城県北部',
    latitude: 36.3,
    longitude: 140.6,
    magnitude: 4.0,
    depth: 60,
  });
}

export function createTestEventDetailScale(): P2PQuake {
  return createTestEventReport('test-event-551-detail-scale', 'DetailScale', nextSameEventIssueTime(3_000), {
    maxScale: 30,
    name: 'テスト茨城県北部',
    latitude: 36.3,
    longitude: 140.6,
    magnitude: 4.0,
    depth: 60,
  });
}

export function createTestEventCorrectedScale(): P2PQuake {
  return createTestEventReport('test-event-551-corrected-scale', 'DetailScale', nextSameEventIssueTime(4_000), {
    maxScale: 20,
    name: 'テスト茨城県北部',
    latitude: 36.3,
    longitude: 140.6,
    magnitude: 4.0,
    depth: 60,
  }, true);
}

export function createTestEventOldScalePrompt(): P2PQuake {
  return createTestEventReport('test-event-551-old-scale-prompt', 'ScalePrompt', p2pTime(sameEventIssueBase - 10_000), { maxScale: 10 });
}

export function createTestEventDuplicateScalePrompt(): P2PQuake {
  return createTestEventReport('test-event-551-scale-prompt', 'ScalePrompt', p2pTime(sameEventIssueBase), { maxScale: 30 });
}

export function createTestSeparateEarthquake(): P2PQuake {
  const time = p2pTime(Date.now());
  return {
    id: `test-event-551-separate-${Date.now()}`,
    code: 551,
    time,
    issue: { source: 'TEST FIXTURE', time, type: 'ScaleAndDestination' },
    earthquake: {
      time,
      maxScale: 20,
      hypocenter: { name: 'テスト熊本県熊本地方', latitude: 32.8, longitude: 130.7, magnitude: 3.9, depth: 10 },
    },
  };
}

/** Same origin timestamp as the Ibaraki event but a clearly distant epicenter. */
export function createTestSameTimeDifferentSource(): P2PQuake {
  const issueTime = nextSameEventIssueTime(5_000);
  return {
    id: `test-event-551-same-time-distant-${Date.now()}`,
    code: 551,
    time: sameEventOriginTime,
    issue: { source: 'TEST FIXTURE', time: issueTime, type: 'ScaleAndDestination' },
    earthquake: {
      time: sameEventOriginTime,
      maxScale: 20,
      hypocenter: { name: 'テスト熊本県熊本地方', latitude: 32.8, longitude: 130.7, magnitude: 3.9, depth: 10 },
    },
  };
}

/** A distinct synthetic 551 payload for exercising the HTTP merge path. */
export function createTestHistoryBackfill(sequence: number): P2PQuake {
  const earthquake = createTestEarthquake(1_000 + Math.max(1, Math.trunc(sequence)));
  return { ...earthquake, id: `test-551-history-${sequence}` };
}

/** Fake P2P history for replay-only scenarios; never used by production mode. */
export function createTestReplayEew(target: Earthquake): P2PEEW {
  const origin = parseP2pTimestamp(target.time) ?? Date.now();
  const time = p2pTime(origin);
  const issued = p2pTime(origin - 45_000);
  return {
    id: `test-replay-556-${target.id}`,
    code: 556,
    time,
    test: false,
    cancelled: false,
    issue: { time: issued, eventId: `REPLAY-${target.id}`, serial: '1' },
    earthquake: {
      originTime: target.time,
      arrivalTime: undefined,
      condition: undefined,
      hypocenter: {
        name: target.hypocenter ?? 'テスト震源',
        reduceName: target.hypocenter ?? undefined,
        latitude: target.latitude ?? undefined,
        longitude: target.longitude ?? undefined,
        depth: target.depth ?? undefined,
        magnitude: target.magnitude ?? undefined,
      },
    },
    areas: [{ pref: '千葉県', name: 'TEST 地域', scaleFrom: 30, scaleTo: 40, kindCode: '10', arrivalTime: time }],
  };
}

export function createTestReplayShake(target: Earthquake, areaCode = '241'): P2PUserquakeEvaluation {
  const origin = parseP2pTimestamp(target.time) ?? Date.now();
  const startedAt = target.time;
  const updatedAt = p2pTime(origin + 35_000);
  return {
    id: `test-replay-9611-${target.id}`,
    code: 9611,
    time: updatedAt,
    count: 5,
    confidence: 0.91,
    started_at: startedAt,
    updated_at: updatedAt,
    area_confidences: { [areaCode]: { confidence: 0.91, count: 4 } },
  };
}

export function createTestReplayQuake(target: Earthquake): P2PQuake {
  const origin = parseP2pTimestamp(target.time) ?? Date.now();
  const issued = p2pTime(origin + 70_000);
  return {
    id: `test-replay-551-${target.id}`, code: 551, time: issued,
    issue: { source: 'TEST FIXTURE', time: issued, type: 'DetailScale' },
    earthquake: {
      time: target.time, maxScale: target.maxScale ?? -1,
      hypocenter: { name: target.hypocenter ?? 'テスト震源', latitude: target.latitude ?? undefined,
        longitude: target.longitude ?? undefined, depth: target.depth ?? undefined,
        magnitude: target.magnitude ?? undefined },
    },
  };
}

/** Several genuinely different recorded states; no interpolated wave or observations. */
export function createTestReplayEewReports(target: Earthquake): P2PEEW[] {
  const origin = parseP2pTimestamp(target.time) ?? Date.now();
  const initial = createTestReplayEew(target);
  const [firstPref, secondPref, thirdPref] = (target.latitude ?? 35.5) < 34
    ? ['熊本県', '大分県', '宮崎県']
    : (target.latitude ?? 35.5) > 36.5
      ? ['福島県', '宮城県', '茨城県']
      : ['千葉県', '茨城県', '東京都'];
  const areas = [
    [{ pref: firstPref, name: 'TEST 地域1', scaleFrom: 30, scaleTo: 40, kindCode: '10', arrivalTime: p2pTime(origin) }],
    [{ pref: firstPref, name: 'TEST 地域1', scaleFrom: 40, scaleTo: 45, kindCode: '10', arrivalTime: p2pTime(origin) },
      { pref: secondPref, name: 'TEST 地域2', scaleFrom: 30, scaleTo: 30, kindCode: '10', arrivalTime: p2pTime(origin) }],
    [{ pref: firstPref, name: 'TEST 地域1', scaleFrom: 40, scaleTo: 50, kindCode: '11', arrivalTime: p2pTime(origin) },
      { pref: secondPref, name: 'TEST 地域2', scaleFrom: 30, scaleTo: 40, kindCode: '10', arrivalTime: p2pTime(origin) },
      { pref: thirdPref, name: 'TEST 地域3', scaleFrom: 20, scaleTo: 30, kindCode: '10', arrivalTime: p2pTime(origin) }],
  ];
  return areas.map((forecast, index) => ({ ...initial,
    id: `test-replay-556-${target.id}-${index + 1}`,
    time: p2pTime(origin - 45_000 + index * 18_000),
    issue: { ...initial.issue!, time: p2pTime(origin - 45_000 + index * 18_000), serial: String(index + 1) },
    areas: forecast,
    earthquake: initial.earthquake ? { ...initial.earthquake,
      hypocenter: { ...initial.earthquake.hypocenter, longitude: (target.longitude ?? 141.1) + index * 0.06 } } : undefined,
  }));
}

export function createTestReplayShakeReports(target: Earthquake, areaCodes: readonly string[] = ['240', '241', '205']): P2PUserquakeEvaluation[] {
  const origin = parseP2pTimestamp(target.time) ?? Date.now();
  const [first = '240', second = '241', third = '205'] = areaCodes;
  const initial = createTestReplayShake(target, first);
  const areaSets = [
    { [first]: { confidence: 0.84, count: 3 }, [second]: { confidence: 0.55, count: 1 } },
    { [first]: { confidence: 0.95, count: 7 }, [second]: { confidence: 0.83, count: 4 }, [third]: { confidence: 0.67, count: 2 } },
    { [first]: { confidence: 0.92, count: 9 }, [second]: { confidence: 0.9, count: 6 }, [third]: { confidence: 0.82, count: 4 } },
  ];
  return areaSets.map((areaConfidences, index) => ({ ...initial,
    id: `test-replay-9611-${target.id}-${index + 1}`,
    time: p2pTime(origin + 20_000 + index * 18_000),
    updated_at: p2pTime(origin + 20_000 + index * 18_000),
    count: 5 + index * 7,
    confidence: 0.84 + index * 0.05,
    area_confidences: areaConfidences,
  }));
}

export function createTestNoReplayEarthquake(): P2PQuake {
  const time = p2pTime();
  return {
    id: `test-no-replay-551-${Date.now()}`,
    code: 551,
    time,
    issue: { source: 'TEST FIXTURE', time, type: 'ScaleAndDestination' },
    earthquake: {
      time,
      maxScale: 20,
      hypocenter: { name: 'テスト再生データなし震源', latitude: 37.5, longitude: 138.0, depth: 20, magnitude: 3.5 },
    },
  };
}

/** Synthetic individual 561 reports, using catalog area codes. */
export function createTestUserquake(area: number): P2PUserquake {
  return { id: `test-561-${area}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, code: 561, time: p2pTime(), area };
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
      '241': { confidence: 0.72, count: 1 },
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
      '241': { confidence: 0.7, count: 2 },
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
