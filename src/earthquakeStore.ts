import { parseP2pTimestamp } from './timeUtils';
import type { Earthquake, P2PQuakeIssueType } from './types';

const MAX_EARTHQUAKES = 10;
const MAX_REMEMBERED_IDS = 512;
const CLEARLY_DISTANT_KM = 180;

type EarthquakeField = 'hypocenter' | 'maxScale' | 'magnitude' | 'depth' | 'latitude' | 'longitude';

interface PublicationOrder {
  issuedAt: number;
  correct: boolean;
  typeRank: number;
}

interface FieldPublication extends PublicationOrder {
  value: string | number;
}

interface EventRecord {
  earthquake: Earthquake;
  publications: Partial<Record<EarthquakeField, FieldPublication>>;
  latestPublication: PublicationOrder;
}

export interface EarthquakeMergeResult {
  changed: boolean;
  newEventIds: readonly string[];
  updatedEventIds: readonly string[];
  duplicateReportIds: readonly string[];
}

const ISSUE_TYPE_RANK: Record<P2PQuakeIssueType, number> = {
  Other: 0,
  Foreign: 1,
  ScalePrompt: 1,
  Destination: 2,
  ScaleAndDestination: 3,
  DetailScale: 4,
};

const PREFECTURE_PATTERN = /(北海道|東京都|京都府|大阪府|[一-龠ぁ-んァ-ヶ]{2,3}県)/;
const UNRESOLVED_NAMES = new Set(['不明', '震源地不明', '震源未判明', '調査中', '震源調査中']);

export class EarthquakeStore {
  private events: EventRecord[] = [];
  private earthquakeSnapshot: Earthquake[] = [];
  private readonly seenReportIds = new Set<string>();
  private readonly reportIdOrder: string[] = [];

  get recent(): readonly Earthquake[] {
    return this.earthquakeSnapshot;
  }

  clear(): void {
    this.events = [];
    this.earthquakeSnapshot = [];
    this.seenReportIds.clear();
    this.reportIdOrder.length = 0;
  }

  merge(incoming: readonly Earthquake[]): EarthquakeMergeResult {
    const previousEvents = this.events.map(({ earthquake }) => earthquake);
    const newEventIds = new Set<string>();
    const updatedEventIds = new Set<string>();
    const duplicateReportIds: string[] = [];

    for (const report of incoming) {
      const reportId = report.reportId || report.id;
      if (this.seenReportIds.has(reportId)) {
        duplicateReportIds.push(reportId);
        continue;
      }
      this.rememberReportId(reportId);

      let record = this.findMatchingEvent(report);
      if (!record) {
        record = this.createEvent(report, reportId);
        this.events.push(record);
        newEventIds.add(record.earthquake.id);
      } else if (this.mergeReport(record, report)) {
        updatedEventIds.add(record.earthquake.id);
      }
    }

    this.events.sort((left, right) => right.earthquake.time.localeCompare(left.earthquake.time));
    this.events = this.events.slice(0, MAX_EARTHQUAKES);
    this.earthquakeSnapshot = this.events.map(({ earthquake }) => earthquake);
    const changed = this.events.length !== previousEvents.length || this.events.some((event, index) => event.earthquake !== previousEvents[index]);

    const retainedIds = new Set(this.events.map(({ earthquake }) => earthquake.id));
    return {
      changed,
      newEventIds: [...newEventIds].filter((id) => retainedIds.has(id)),
      updatedEventIds: [...updatedEventIds].filter((id) => retainedIds.has(id)),
      duplicateReportIds,
    };
  }

  private findMatchingEvent(report: Earthquake): EventRecord | undefined {
    const candidates = this.events.filter(({ earthquake }) => earthquake.time === report.time && !clearlyDifferent(earthquake, report));
    if (candidates.length < 2) return candidates[0];

    const ranked = candidates
      .map((record) => ({ record, score: matchingEvidence(record.earthquake, report) }))
      .sort((left, right) => right.score - left.score);
    return ranked[0].score > 0 && ranked[0].score > ranked[1].score ? ranked[0].record : undefined;
  }

  private createEvent(report: Earthquake, reportId: string): EventRecord {
    const event: Earthquake = { ...report, id: reportId, reportId };
    const record: EventRecord = {
      earthquake: event,
      publications: {},
      latestPublication: publicationFor(report),
    };
    this.applyReportFields(record, report);
    return record;
  }

  private mergeReport(record: EventRecord, report: Earthquake): boolean {
    let changed = this.applyReportFields(record, report);
    const publication = publicationFor(report);
    if (isNewerPublication(publication, record.latestPublication)) {
      record.latestPublication = publication;
      record.earthquake = {
        ...record.earthquake,
        reportId: report.reportId,
        basicTime: report.basicTime ?? record.earthquake.basicTime,
        issueTime: report.issueTime ?? record.earthquake.issueTime,
        issueType: report.issueType,
        issueCorrect: report.issueCorrect,
      };
      changed = true;
    }
    return changed;
  }

  private applyReportFields(record: EventRecord, report: Earthquake): boolean {
    const publication = publicationFor(report);
    const values: Partial<Record<EarthquakeField, string | number>> = {
      ...(report.hypocenter ? { hypocenter: report.hypocenter } : {}),
      ...(report.maxScale !== null ? { maxScale: report.maxScale } : {}),
      ...(report.magnitude !== null ? { magnitude: report.magnitude } : {}),
      ...(report.depth !== null ? { depth: report.depth } : {}),
      ...(validLatitude(report.latitude) ? { latitude: report.latitude! } : {}),
      ...(validLongitude(report.longitude) ? { longitude: report.longitude! } : {}),
    };

    let changed = false;
    const merged = { ...record.earthquake };
    for (const [fieldName, value] of Object.entries(values) as Array<[EarthquakeField, string | number]>) {
      const previous = record.publications[fieldName];
      if (previous && !isNewerPublication(publication, previous)) continue;
      record.publications[fieldName] = { ...publication, value };
      if (merged[fieldName] !== value) {
        (merged[fieldName] as string | number | null) = value;
        changed = true;
      }
    }
    if (changed) record.earthquake = merged;
    return changed;
  }

  private rememberReportId(id: string): void {
    this.seenReportIds.add(id);
    this.reportIdOrder.push(id);
    if (this.reportIdOrder.length > MAX_REMEMBERED_IDS) {
      const expiredId = this.reportIdOrder.shift();
      if (expiredId) this.seenReportIds.delete(expiredId);
    }
  }
}

function publicationFor(report: Earthquake): PublicationOrder {
  return {
    issuedAt: parseP2pTimestamp(report.issueTime) ?? parseP2pTimestamp(report.basicTime) ?? Number.NEGATIVE_INFINITY,
    correct: report.issueCorrect,
    typeRank: ISSUE_TYPE_RANK[report.issueType],
  };
}

function isNewerPublication(incoming: PublicationOrder, previous: PublicationOrder): boolean {
  if (incoming.issuedAt !== previous.issuedAt) return incoming.issuedAt > previous.issuedAt;
  if (incoming.correct !== previous.correct) return incoming.correct;
  return incoming.typeRank > previous.typeRank;
}

function validLatitude(value: number | null): boolean {
  return value !== null && value >= -90 && value <= 90;
}

function validLongitude(value: number | null): boolean {
  return value !== null && value >= -180 && value <= 180;
}

function hasCoordinates(earthquake: Earthquake): boolean {
  return validLatitude(earthquake.latitude) && validLongitude(earthquake.longitude);
}

function concreteName(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim().replace(/[\s　]/g, '');
  return normalized.length > 0 && !UNRESOLVED_NAMES.has(normalized) ? normalized : null;
}

function prefectureName(value: string): string | null {
  return value.match(PREFECTURE_PATTERN)?.[0] ?? null;
}

function clearlyDifferent(left: Earthquake, right: Earthquake): boolean {
  if (hasCoordinates(left) && hasCoordinates(right) && distanceKm(left, right) > CLEARLY_DISTANT_KM) return true;

  const leftName = concreteName(left.hypocenter);
  const rightName = concreteName(right.hypocenter);
  if (!leftName || !rightName || leftName === rightName || leftName.includes(rightName) || rightName.includes(leftName)) return false;

  const leftPrefecture = prefectureName(leftName);
  const rightPrefecture = prefectureName(rightName);
  if (leftPrefecture && rightPrefecture && leftPrefecture !== rightPrefecture) return true;

  const samePrefecture = leftPrefecture && leftPrefecture === rightPrefecture;
  const leftRegion = leftName.match(/北部|南部|東部|西部|沿岸|沖合|沖/);
  const rightRegion = rightName.match(/北部|南部|東部|西部|沿岸|沖合|沖/);
  return Boolean(samePrefecture && leftRegion && rightRegion && leftRegion[0] !== rightRegion[0]);
}

function matchingEvidence(left: Earthquake, right: Earthquake): number {
  if (hasCoordinates(left) && hasCoordinates(right)) {
    const distance = distanceKm(left, right);
    if (distance <= 30) return 100 - distance;
    if (distance <= CLEARLY_DISTANT_KM) return 20 - distance / 10;
  }
  const leftName = concreteName(left.hypocenter);
  const rightName = concreteName(right.hypocenter);
  if (leftName && rightName) {
    if (leftName === rightName) return 100;
    if (leftName.includes(rightName) || rightName.includes(leftName)) return 60;
    if (prefectureName(leftName) && prefectureName(leftName) === prefectureName(rightName)) return 10;
  }
  return 0;
}

function distanceKm(left: Earthquake, right: Earthquake): number {
  const toRadians = (degrees: number): number => degrees * Math.PI / 180;
  const latitudeDelta = toRadians(right.latitude! - left.latitude!);
  const longitudeDelta = toRadians(right.longitude! - left.longitude!);
  const latitudeA = toRadians(left.latitude!);
  const latitudeB = toRadians(right.latitude!);
  const value = Math.sin(latitudeDelta / 2) ** 2 + Math.cos(latitudeA) * Math.cos(latitudeB) * Math.sin(longitudeDelta / 2) ** 2;
  return 6_371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}
