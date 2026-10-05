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
