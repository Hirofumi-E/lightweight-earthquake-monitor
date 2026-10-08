import { parseEarthquake, parseEew, parseShakeDetection } from './api';
import { parseP2pTimestamp } from './timeUtils';
import type { Earthquake, EewMessage, EpspArea, ShakeDetection } from './types';

export type ReplayFrame =
  | { at: number; kind: 'quake'; earthquake: Earthquake }
  | { at: number; kind: 'eew'; eew: EewMessage }
  | { at: number; kind: 'shake'; detection: ShakeDetection; areas: readonly { area: EpspArea; confidence: number }[] };

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

/** A timeline needs at least two distinct visual states from EEW or sensing records. */
export function hasVisualReplay(frames: readonly ReplayFrame[]): boolean {
  const states = new Set<string>();
  for (const frame of frames) {
    if (frame.kind === 'eew') {
      const center = frame.eew.earthquake?.hypocenter;
      states.add(JSON.stringify(['eew', center?.latitude, center?.longitude,
        frame.eew.areas.map((area) => [area.pref, area.scaleTo]).sort()]));
    } else if (frame.kind === 'shake') {
      states.add(JSON.stringify(['shake', frame.areas.map(({ area, confidence }) =>
        [area.code, confidence >= .8 ? 'A' : confidence >= .6 ? 'B' : 'C']).sort()]));
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
 * Match historical packets to one selected 551 event using time and spatial
 * evidence. A timestamp-only candidate is intentionally excluded for 556/9611.
 */
export function buildReplayFrames(
  payloads: readonly unknown[],
  target: Earthquake,
  areas: readonly EpspArea[],
): ReplayFrame[] {
  const targetAt = parseP2pTimestamp(target.time);
  if (targetAt === null) return [];
  const frames: ReplayFrame[] = [];
  const ids = new Set<string>();
  const windowStart = targetAt - TIMELINE_WINDOW_MS;
  const windowEnd = targetAt + TIMELINE_WINDOW_MS;

  for (const payload of payloads) {
    if (!isRecord(payload) || typeof payload.id !== 'string' || ids.has(payload.id)) continue;
    const quake = parseEarthquake(payload);
    if (quake && quake.time === target.time && compatibleQuake(target, quake)) {
      const at = parseP2pTimestamp(quake.issueTime) ?? parseP2pTimestamp(quake.basicTime) ?? targetAt;
      if (at >= windowStart && at <= windowEnd) {
        ids.add(quake.id);
        frames.push({ at, kind: 'quake', earthquake: quake });
      }
      continue;
    }

    const eew = parseEew(payload);
    if (eew && !eew.test && !eew.cancelled && eew.earthquake && matchesEew(target, targetAt, eew)) {
      const at = parseP2pTimestamp(eew.issue.time) ?? parseP2pTimestamp(eew.time);
      if (at !== null && at >= windowStart && at <= windowEnd) {
        ids.add(eew.id);
        frames.push({ at, kind: 'eew', eew });
      }
      continue;
    }

    const detection = parseShakeDetection(payload);
    if (detection && matchesShake(target, targetAt, detection, areas)) {
      const at = parseP2pTimestamp(detection.updatedAt) ?? parseP2pTimestamp(detection.time);
      if (at !== null && at >= windowStart && at <= windowEnd) {
        ids.add(detection.id);
        const detectedAreas = areas.flatMap((area) => {
          const confidence = detection.areaConfidences.get(area.code) ?? detection.areaConfidences.get(String(Number(area.code)));
          return confidence !== undefined && confidence > 0 &&
            distanceKm(target.latitude!, target.longitude!, area.latitude, area.longitude) <= MAX_SHAKE_REGION_DISTANCE_KM
            ? [{ area, confidence }] : [];
        });
        frames.push({ at, kind: 'shake', detection, areas: detectedAreas });
      }
    }
  }

  return frames
    .sort((left, right) => left.at - right.at)
    .slice(0, REPLAY_MAX_FRAMES);
}

function matchesEew(target: Earthquake, targetAt: number, eew: EewMessage): boolean {
  const originAt = parseP2pTimestamp(eew.earthquake?.originTime);
  const hypocenter = eew.earthquake?.hypocenter;
  if (originAt === null || !hypocenter || Math.abs(originAt - targetAt) > EVENT_MATCH_WINDOW_MS) return false;
  return hasValidCoordinates(target) && isValidCoordinate(hypocenter.latitude, -90, 90) &&
    isValidCoordinate(hypocenter.longitude, -180, 180) &&
    distanceKm(target.latitude!, target.longitude!, hypocenter.latitude!, hypocenter.longitude!) <= MAX_EPICENTER_DISTANCE_KM;
}

function matchesShake(target: Earthquake, targetAt: number, detection: ShakeDetection, areas: readonly EpspArea[]): boolean {
  const startedAt = parseP2pTimestamp(detection.startedAt);
  if (startedAt === null || Math.abs(startedAt - targetAt) > EVENT_MATCH_WINDOW_MS || !hasValidCoordinates(target)) return false;
  return areas.some((area) => {
    const confidence = detection.areaConfidences.get(area.code) ?? detection.areaConfidences.get(String(Number(area.code)));
    return confidence !== undefined && confidence >= 0.8 &&
      distanceKm(target.latitude!, target.longitude!, area.latitude, area.longitude) <= MAX_SHAKE_REGION_DISTANCE_KM;
  });
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
