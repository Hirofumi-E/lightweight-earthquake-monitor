export type P2PQuakeIssueType = 'ScalePrompt' | 'Destination' | 'ScaleAndDestination' | 'DetailScale' | 'Foreign' | 'Other';

export interface P2PQuake {
  id?: string;
  code: number;
  time: string;
  issue?: { type?: P2PQuakeIssueType; correct?: boolean; source?: string; time?: string };
  earthquake?: {
    time?: string;
    hypocenter?: { name?: string; depth?: number; magnitude?: number; latitude?: number; longitude?: number };
    maxScale?: number;
  };
}

export interface P2PUserquake {
  id?: string;
  code: number;
  time?: string;
  area?: number;
}

export interface P2PAreaPeers {
  id: string;
  code: 555;
  time: string;
  areas: Array<{ id: number; peer: number }>;
}

export interface P2PEEWArea {
  pref?: string;
  name?: string;
  scaleFrom?: number;
  scaleTo?: number;
  kindCode?: string;
  arrivalTime?: string | null;
}

export interface P2PEEW {
  id?: string;
  code: number;
  time?: string;
  test?: boolean;
  cancelled?: boolean;
  issue?: {
    time?: string;
    eventId?: string;
    serial?: string | number;
  };
  earthquake?: {
    originTime?: string;
    arrivalTime?: string;
    condition?: string;
    hypocenter?: {
      name?: string;
      reduceName?: string;
      latitude?: number;
      longitude?: number;
      depth?: number;
      magnitude?: number;
    };
  };
  areas?: P2PEEWArea[];
}

export interface P2PEEWDetection {
  id?: string;
  code: number;
  time?: string;
  type?: string;
}

export interface P2PAreaConfidence {
  confidence?: number;
  count?: number;
  display?: string;
}

export interface P2PUserquakeEvaluation {
  id?: string;
  code: number;
  time?: string;
  count?: number;
  confidence?: number;
  started_at?: string;
  updated_at?: string;
  area_confidences?: Record<string, P2PAreaConfidence>;
}

export interface Earthquake {
  /** Stable identifier used by the display event, initially the first raw 551 ID. */
  id: string;
  /** ID of this individual raw 551 announcement; used for transport deduplication. */
  reportId: string;
  time: string;
  /** P2P BasicData.time is retained for receive timing only. */
  basicTime: string | null;
  issueTime: string | null;
  issueType: P2PQuakeIssueType;
  issueCorrect: boolean;
  hypocenter: string | null;
  maxScale: number | null;
  magnitude: number | null;
  depth: number | null;
  latitude: number | null;
  longitude: number | null;
}

export interface ShakeDetection {
  id: string;
  time: string;
  count: number;
  confidence: number;
  startedAt: string;
  updatedAt: string;
  areaConfidences: ReadonlyMap<string, number>;
}

export interface EewArea {
  pref: string;
  name: string;
  scaleFrom: number | null;
  scaleTo: number | null;
  kindCode: string | null;
  arrivalTime: string | null;
}

export interface EewMessage {
  id: string;
  code: 556;
  time: string;
  test: boolean;
  cancelled: boolean;
  issue: {
    time: string;
    eventId: string;
    serial: string;
  };
  earthquake?: {
    originTime: string | null;
    arrivalTime: string | null;
    condition: string | null;
    hypocenter: {
      name: string | null;
      reduceName: string | null;
      latitude: number | null;
      longitude: number | null;
      depth: number | null;
      magnitude: number | null;
    };
  };
  areas: EewArea[];
}

export interface EewDetection {
  id: string;
  code: 554;
  time: string;
  type: string | null;
}

export interface EpspArea {
  code: string;
  region: string;
  prefecture: string;
  name: string;
  latitude: number;
  longitude: number;
}
