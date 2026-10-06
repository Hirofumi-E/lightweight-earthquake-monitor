import type { Earthquake } from './types';
import projectionConfig from './mapProjectionConfig.json';

export interface MapPoint {
  x: number;
  y: number;
}

const { minLongitude, maxLongitude, minLatitude, maxLatitude, viewBoxSize, padding } = projectionConfig;
const centerLongitude = (minLongitude + maxLongitude) / 2;
const centerLatitude = (minLatitude + maxLatitude) / 2;
const longitudeScale = Math.cos((centerLatitude * Math.PI) / 180);
const mapScale = (viewBoxSize - 2 * padding) / Math.max(
  (maxLongitude - minLongitude) * longitudeScale,
  maxLatitude - minLatitude,
);

/** Shared equirectangular projection used for both the GIS SVG and epicenters. */
export function projectEpicenter(earthquake: Pick<Earthquake, 'latitude' | 'longitude'>): MapPoint | null {
  const { latitude, longitude } = earthquake;
  if (latitude === null || longitude === null || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (
    longitude < minLongitude || longitude > maxLongitude ||
    latitude < minLatitude || latitude > maxLatitude
  ) return null;

  return {
    x: viewBoxSize / 2 + (longitude - centerLongitude) * longitudeScale * mapScale,
    y: viewBoxSize / 2 - (latitude - centerLatitude) * mapScale,
  };
}
