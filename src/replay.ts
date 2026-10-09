import { parseEarthquake, parseEew, parseShakeDetection } from './api';
import { parseP2pTimestamp } from './timeUtils';
import type { Earthquake, EewMessage, EpspArea, ShakeDetection } from './types';

export type ReplayFrame =
  | { at: number; kind: 'quake'; earthquake: Earthquake }
  | { at: number; kind: 'eew'; eew: EewMessage }
  | { at: number; kind: 'eew-cancelled'; eventId: string }
  | { at: number; kind: 'shake'; detection: ShakeDetection; areas: readonly { area: EpspArea; confidence: number }[] }
  | { at: number; kind: 'shake-none'; detection: ShakeDetection };

export interface ReplayCounts { quake: number; eew: number; shake: number; }

export function countReplayRecords(payloads: readonly unknown[]): ReplayCounts {
  const counts = { quake: 0, eew: 0, shake: 0 };
  for (const payload of payloads) {
    if (!isRecord(payload)) continue;
    if (payload.code === 551) counts.quake += 1;
    else if (payload.code === 556) counts.eew += 1;
    else if (payload.code === 9611) counts.shake += 1;
  }
  return counts;
}

/** Visual playback requires recorded state changes; announcement-only data stays static. */
export function hasVisualReplay(frames: readonly ReplayFrame[]): boolean {
  const states = new Set<string>();
  for (const frame of frames) {
    if (frame.kind === 'eew') {
      const center = frame.eew.earthquake?.hypocenter;
      states.add(JSON.stringify(['eew', frame.eew.issue.serial, center?.latitude, center?.longitude,
        frame.eew.areas.map((area) => [area.pref, area.scaleTo]).sort()]));
    } else if (frame.kind === 'eew-cancelled') {
      states.add(JSON.stringify(['eew-cancelled', frame.eventId]));
    } else if (frame.kind === 'shake') {
      states.add(JSON.stringify(['shake', frame.detection.count, frame.detection.confidence,
        frame.areas.map(({ area, confidence }) => [area.code, confidence]).sort()]));
    } else if (frame.kind === 'shake-none') {
      states.add(JSON.stringify(['shake-none', frame.detection.startedAt]));
    }
  }
  return states.size >= 2;
}

export const REPLAY_WINDOW_MS = 3 * 60 * 60 * 1_000;
export const REPLAY_MAX_FRAMES = 200;
const EVENT_MATCH_WINDOW_MS = 2 * 60 * 1_000;
const TIMELINE_WINDOW_MS = 10 * 60 * 1_000;
const MAX_EPICENTER_DISTANCE_KM = 120;
const MAX_SHAKE_REGION_DISTANCE_KM = 200;

export function isReplayEligible(earthquake: Earthquake, now = Date.now()): boolean {
  const origin = parseP2pTimestamp(earthquake.time);
  return origin !== null && origin <= now && now - origin <= REPLAY_WINDOW_MS;
}

/**
 * Select one matching EEW event and one matching started_at group, then retain
 * their updates and terminal records. This avoids joining unrelated event IDs
 * merely because their timestamps are close.
 */
export function buildReplayFrames(
  payloads: readonly unknown[],
  target: Earthquake,
  areas: readonly EpspArea[],
): ReplayFrame[] {
  const targetAt = parseP2pTimestamp(target.time);
  if (targetAt === null) return [];
  const windowStart = targetAt - TIMELINE_WINDOW_MS;
  const windowEnd = targetAt + TIMELINE_WINDOW_MS;
  const seenIds = new Set<string>();
  const quakeFrames: ReplayFrame[] = [];
  const eewMessages: EewMessage[] = [];
  const shakeMessages: ShakeDetection[] = [];

  for (const payload of payloads) {
    if (!isRecord(payload) || typeof payload.id !== 'string' || seenIds.has(payload.id)) continue;
    const id = payload.id;
    if (payload.code === 551) {
      const quake = parseEarthquake(payload);
      if (!quake || quake.time !== target.time || !compatibleQuake(target, quake)) continue;
      const at = parseP2pTimestamp(quake.issueTime);
      if (at !== null && at >= windowStart && at <= windowEnd) {
        seenIds.add(id);
        quakeFrames.push({ at, kind: 'quake', earthquake: quake });
      }
      continue;
    }
    if (payload.code === 556) {
      const eew = parseEew(payload);
      const at = eew ? parseP2pTimestamp(eew.issue.time) : null;
      if (eew && !eew.test && at !== null && at >= windowStart && at <= windowEnd) {
        seenIds.add(id);
        eewMessages.push(eew);
      }
      continue;
    }
    if (payload.code === 9611) {
      const detection = parseShakeDetection(payload);
      // Replay time is the evaluation update timestamp. Do not substitute the
      // BasicData time when updated_at is missing because that changes the timeline.
      const at = detection && typeof payload.updated_at === 'string' ? parseP2pTimestamp(payload.updated_at) : null;
      if (detection && at !== null && at >= windowStart && at <= windowEnd) {
        seenIds.add(id);
        shakeMessages.push(detection);
      }
    }
  }

  const selectedEewEventId = selectEewEventId(target, targetAt, eewMessages);
  const monitorFrames: ReplayFrame[] = [];
  if (selectedEewEventId) {
    for (const eew of eewMessages) {
      if (eew.issue.eventId !== selectedEewEventId) continue;
      const at = parseP2pTimestamp(eew.issue.time);
      if (at === null) continue;
      if (eew.cancelled) monitorFrames.push({ at, kind: 'eew-cancelled', eventId: selectedEewEventId });
      else if (eew.earthquake) monitorFrames.push({ at, kind: 'eew', eew });
    }
  }

  const selectedStartedAt = selectShakeStartedAt(target, targetAt, shakeMessages, areas);
  if (selectedStartedAt !== null) {
    for (const detection of shakeMessages) {
      const startedAt = parseP2pTimestamp(detection.startedAt);
      if (startedAt !== selectedStartedAt) continue;
      const at = parseP2pTimestamp(detection.updatedAt);
      if (at === null) continue;
      if (detection.count <= 0 || detection.confidence <= 0) {
        monitorFrames.push({ at, kind: 'shake-none', detection });
        continue;
      }
      const detectedAreas = areas.flatMap((area) => {
        const confidence = areaConfidence(detection, area.code);
        return confidence !== undefined && confidence > 0 && hasValidCoordinates(target) &&
          distanceKm(target.latitude!, target.longitude!, area.latitude, area.longitude) <= MAX_SHAKE_REGION_DISTANCE_KM
          ? [{ area, confidence }] : [];
      });
      monitorFrames.push({ at, kind: 'shake', detection, areas: detectedAreas });
    }
  }

  monitorFrames.sort(compareReplayFrames);
  // Late 551 details remain publication history; they cannot extend monitoring playback.
  const lastMonitorAt = monitorFrames.at(-1)?.at;
  const relevantQuakes = lastMonitorAt === undefined ? quakeFrames : quakeFrames.filter((frame) => frame.at <= lastMonitorAt);
  return [...relevantQuakes, ...monitorFrames]
    .sort(compareReplayFrames)
    .slice(0, REPLAY_MAX_FRAMES);
}

function selectEewEventId(target: Earthquake, targetAt: number, messages: readonly EewMessage[]): string | null {
  if (!hasValidCoordinates(target)) return null;
  const bestByEventId = new Map<string, { score: number; issuedAt: number }>();
  for (const eew of messages) {
    if (eew.cancelled || !eew.earthquake) continue;
    const originAt = parseP2pTimestamp(eew.earthquake.originTime);
    const hypocenter = eew.earthquake.hypocenter;
    if (originAt === null || Math.abs(originAt - targetAt) > EVENT_MATCH_WINDOW_MS ||
        !isValidCoordinate(hypocenter.latitude, -90, 90) || !isValidCoordinate(hypocenter.longitude, -180, 180)) continue;
    const distance = distanceKm(target.latitude!, target.longitude!, hypocenter.latitude!, hypocenter.longitude!);
    if (distance > MAX_EPICENTER_DISTANCE_KM) continue;
    const issuedAt = parseP2pTimestamp(eew.issue.time);
    if (issuedAt === null) continue;
    const score = Math.abs(originAt - targetAt) + distance * 1_000;
    const current = bestByEventId.get(eew.issue.eventId);
    if (!current || score < current.score) bestByEventId.set(eew.issue.eventId, { score, issuedAt });
  }
  const candidates = [...bestByEventId].map(([eventId, candidate]) => ({ eventId, ...candidate }))
    .sort((a, b) => a.score - b.score || a.issuedAt - b.issuedAt);
  if (candidates.length > 1 && candidates[0]!.score === candidates[1]!.score) return null;
  return candidates[0]?.eventId ?? null;
}

function selectShakeStartedAt(
  target: Earthquake,
  targetAt: number,
  messages: readonly ShakeDetection[],
  areas: readonly EpspArea[],
): number | null {
  if (!hasValidCoordinates(target)) return null;
  const candidates = new Map<number, number>();
  for (const detection of messages) {
    const startedAt = parseP2pTimestamp(detection.startedAt);
    if (startedAt === null || Math.abs(startedAt - targetAt) > EVENT_MATCH_WINDOW_MS) continue;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const area of areas) {
      if (areaConfidence(detection, area.code) === undefined) continue;
      const distance = distanceKm(target.latitude!, target.longitude!, area.latitude, area.longitude);
      if (distance < nearestDistance) nearestDistance = distance;
    }
    if (nearestDistance <= MAX_SHAKE_REGION_DISTANCE_KM) {
      const score = Math.abs(startedAt - targetAt) + nearestDistance * 1_000;
      candidates.set(startedAt, Math.min(candidates.get(startedAt) ?? Number.POSITIVE_INFINITY, score));
    }
  }
  return [...candidates].sort((left, right) => left[1] - right[1])[0]?.[0] ?? null;
}

function compareReplayFrames(left: ReplayFrame, right: ReplayFrame): number {
  return left.at - right.at || frameOrder(left) - frameOrder(right);
}

function frameOrder(frame: ReplayFrame): number {
  switch (frame.kind) {
    case 'quake': return 0;
    case 'eew': return 1;
    case 'eew-cancelled': return 2;
    case 'shake': return 3;
    case 'shake-none': return 4;
  }
}

function areaConfidence(detection: ShakeDetection, code: string): number | undefined {
  return detection.areaConfidences.get(code) ?? detection.areaConfidences.get(String(Number(code)));
}

function compatibleQuake(target: Earthquake, candidate: Earthquake): boolean {
  if (hasValidCoordinates(target) && hasValidCoordinates(candidate) &&
      distanceKm(target.latitude!, target.longitude!, candidate.latitude!, candidate.longitude!) > MAX_EPICENTER_DISTANCE_KM) return false;
  const targetName = concreteName(target.hypocenter);
  const candidateName = concreteName(candidate.hypocenter);
  if (!targetName || !candidateName || targetName === candidateName || targetName.includes(candidateName) || candidateName.includes(targetName)) return true;
  const targetPrefecture = targetName.match(/北海道|東京都|京都府|大阪府|[一-龠ぁ-んァ-ヶ]{2,3}県/)?.[0];
  const candidatePrefecture = candidateName.match(/北海道|東京都|京都府|大阪府|[一-龠ぁ-んァ-ヶ]{2,3}県/)?.[0];
  return !targetPrefecture || !candidatePrefecture || targetPrefecture === candidatePrefecture;
}

function concreteName(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.replace(/[\s　]/g, '');
  return ['不明', '震源未判明', '調査中'].includes(normalized) ? null : normalized;
}

function hasValidCoordinates(value: Earthquake): boolean {
  return isValidCoordinate(value.latitude, -90, 90) && isValidCoordinate(value.longitude, -180, 180);
}

function isValidCoordinate(value: number | null, min: number, max: number): boolean {
  return value !== null && Number.isFinite(value) && value >= min && value <= max;
}

function distanceKm(latitude1: number, longitude1: number, latitude2: number, longitude2: number): number {
  const radians = Math.PI / 180;
  const dLat = (latitude2 - latitude1) * radians;
  const dLon = (longitude2 - longitude1) * radians;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(latitude1 * radians) * Math.cos(latitude2 * radians) * Math.sin(dLon / 2) ** 2;
  return 6_371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
