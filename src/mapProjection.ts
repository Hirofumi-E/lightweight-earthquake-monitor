import type { Earthquake } from './types';

export interface MapPoint {
  x: number;
  y: number;
}

const MAP_BOUNDS = {
  minLongitude: 122.5,
  maxLongitude: 146.5,
  minLatitude: 24,
  maxLatitude: 46.5,
  left: 20,
  bottom: 480,
  longitudeScale: 16.67,
  latitudeScale: 20.4,
} as const;

/** Equirectangular projection with longitude scaled for Japan's mean latitude. */
export function projectEpicenter(earthquake: Pick<Earthquake, 'latitude' | 'longitude'>): MapPoint | null {
  const { latitude, longitude } = earthquake;
  if (latitude === null || longitude === null || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (
    longitude < MAP_BOUNDS.minLongitude || longitude > MAP_BOUNDS.maxLongitude ||
    latitude < MAP_BOUNDS.minLatitude || latitude > MAP_BOUNDS.maxLatitude
  ) return null;

  return {
    x: MAP_BOUNDS.left + (longitude - MAP_BOUNDS.minLongitude) * MAP_BOUNDS.longitudeScale,
    y: MAP_BOUNDS.bottom - (latitude - MAP_BOUNDS.minLatitude) * MAP_BOUNDS.latitudeScale,
  };
}
