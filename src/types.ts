export interface P2PQuake {
  id?: string;
  code: number;
  time: string;
  issue?: { type?: string; source?: string; time?: string };
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
  id: string;
  time: string;
  hypocenter: string;
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

export interface EpspArea {
  code: string;
  region: string;
  prefecture: string;
  name: string;
  latitude: number;
  longitude: number;
}
