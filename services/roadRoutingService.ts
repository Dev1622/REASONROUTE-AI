import { ensureLocalEnvLoaded } from './env';
import { Geofence, LatLngPoint, Node, RouteTrafficSegment, RoutedRoad, TrafficCongestionLevel } from '../types';

ensureLocalEnvLoaded();

type RouteFetchResult = {
  coordinates: [number, number][];
  distanceKm: number;
  durationMin: number;
  cacheHit: boolean;
  source: 'osrm' | 'mapbox';
  trafficSegments?: RouteTrafficSegment[];
};

const routeCache = new Map<string, Omit<RouteFetchResult, 'cacheHit'>>();
const inflightCache = new Map<string, Promise<Omit<RouteFetchResult, 'cacheHit'>>>();
const runtimeWarnings = new Set<string>();
const fallbackWarningCounts = new Map<string, number>();

type DepartAtStatus = {
  raw: string;
  effective: string;
  isConfigured: boolean;
  isValid: boolean;
  isPast: boolean;
  warning?: string;
};

function warnOnce(key: string, message: string) {
  if (runtimeWarnings.has(key)) return;
  runtimeWarnings.add(key);
  console.warn(message);
}

function normalizeMapboxDepartAt(rawValue: string): DepartAtStatus {
  const raw = rawValue.trim();
  if (!raw) {
    return {
      raw,
      effective: '',
      isConfigured: false,
      isValid: false,
      isPast: false,
    };
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return {
      raw,
      effective: '',
      isConfigured: true,
      isValid: false,
      isPast: false,
      warning: `[routing] Ignoring MAPBOX_DEPART_AT because it is not a valid ISO timestamp: ${raw}`,
    };
  }

  if (parsed.getTime() < Date.now()) {
    return {
      raw,
      effective: '',
      isConfigured: true,
      isValid: true,
      isPast: true,
      warning: `[routing] Ignoring MAPBOX_DEPART_AT because it is in the past: ${raw}`,
    };
  }

  return {
    raw,
    effective: raw,
    isConfigured: true,
    isValid: true,
    isPast: false,
  };
}

function logMapboxFallback(error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  const count = (fallbackWarningCounts.get(detail) ?? 0) + 1;
  fallbackWarningCounts.set(detail, count);

  if (count === 1) {
    console.warn('[routing] Mapbox request failed, falling back to OSRM road routing.', error);
    return;
  }

  if (count === 5 || count === 20 || count % 50 === 0) {
    console.warn(`[routing] Mapbox fallback repeated ${count} times. Latest reason: ${detail}`);
  }
}

function normalizeTrafficCongestionLevel(value: unknown): TrafficCongestionLevel {
  return value === 'low' || value === 'moderate' || value === 'heavy' || value === 'severe' ? value : 'unknown';
}

function buildTrafficSegmentsFromMapboxRoute(route: any): RouteTrafficSegment[] | undefined {
  const geometry = route?.geometry?.coordinates;
  const legs = Array.isArray(route?.legs) ? route.legs : [];
  if (!Array.isArray(geometry) || geometry.length < 2 || legs.length === 0) {
    return undefined;
  }

  const routeCoords = geometry.map(([lng, lat]: [number, number]) => [lat, lng] as [number, number]);
  const segments: RouteTrafficSegment[] = [];
  let cursor = 0;

  for (const leg of legs) {
    const congestionValues = Array.isArray(leg?.annotation?.congestion) ? leg.annotation.congestion : [];
    const distanceValues = Array.isArray(leg?.annotation?.distance) ? leg.annotation.distance : [];
    const segmentCount = Math.max(congestionValues.length, distanceValues.length);
    if (segmentCount <= 0) continue;

    for (let index = 0; index < segmentCount; index += 1) {
      const start = routeCoords[cursor + index];
      const end = routeCoords[cursor + index + 1];
      if (!start || !end) break;
      segments.push({
        coordinates: [start, end],
        congestion: normalizeTrafficCongestionLevel(congestionValues[index]),
      });
    }

    cursor += segmentCount;
  }

  return segments.length > 0 ? segments : undefined;
}

function getRoutingEnv() {
  const osrmBaseUrl = (typeof process !== 'undefined' && process.env?.OSRM_BASE_URL) || 'https://router.project-osrm.org';
  const mapboxBaseUrl = (typeof process !== 'undefined' && process.env?.MAPBOX_DIRECTIONS_BASE_URL) || 'https://api.mapbox.com/directions/v5';
  const mapboxAccessToken = (typeof process !== 'undefined' && process.env?.MAPBOX_ACCESS_TOKEN) || '';
  const mapboxProfile = (typeof process !== 'undefined' && process.env?.MAPBOX_DIRECTIONS_PROFILE) || 'mapbox/driving-traffic';
  const mapboxDepartAtRaw = (typeof process !== 'undefined' && process.env?.MAPBOX_DEPART_AT) || '';
  const mapboxDepartAtStatus = normalizeMapboxDepartAt(mapboxDepartAtRaw);
  const routingProvider = ((typeof process !== 'undefined' && process.env?.ROUTING_PROVIDER) || '').trim().toLowerCase();
  const activeRoutingProvider: 'osrm' | 'mapbox' =
    routingProvider === 'osrm'
      ? 'osrm'
      : routingProvider === 'mapbox'
        ? (mapboxAccessToken ? 'mapbox' : 'osrm')
        : (mapboxAccessToken ? 'mapbox' : 'osrm');

  if (mapboxDepartAtStatus.warning) {
    warnOnce(`mapbox-depart-at:${mapboxDepartAtStatus.raw}`, mapboxDepartAtStatus.warning);
  }

  return {
    osrmBaseUrl,
    mapboxBaseUrl,
    mapboxAccessToken,
    mapboxProfile,
    mapboxDepartAt: mapboxDepartAtStatus.effective,
    mapboxDepartAtConfigured: mapboxDepartAtStatus.isConfigured,
    mapboxDepartAtValid: mapboxDepartAtStatus.isValid && !mapboxDepartAtStatus.isPast,
    activeRoutingProvider,
  };
}

export function getRoutingConfigStatus() {
  const env = getRoutingEnv();
  return {
    routingProvider: env.activeRoutingProvider,
    mapboxConfigured: Boolean(env.mapboxAccessToken),
    trafficModeReady: env.activeRoutingProvider === 'mapbox' && Boolean(env.mapboxAccessToken),
    historicalReplayReady: env.activeRoutingProvider === 'mapbox' && Boolean(env.mapboxDepartAt),
    departAtConfigured: env.mapboxDepartAtConfigured,
    departAtValid: env.mapboxDepartAtValid,
  };
}

function haversineKm(a: LatLngPoint, b: LatLngPoint): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const earthRadiusKm = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const root =
    sinLat * sinLat +
    Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(root), Math.sqrt(1 - root));
}

function syntheticRoad(points: LatLngPoint[], warning?: string): RoutedRoad {
  let distanceKm = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    distanceKm += haversineKm(points[i], points[i + 1]);
  }
  const durationMin = distanceKm > 0 ? (distanceKm / 32) * 60 : 0;
  return {
    coordinates: points.map(point => [point.lat, point.lng]),
    distanceKm: +distanceKm.toFixed(2),
    durationMin: +durationMin.toFixed(1),
    source: 'synthetic',
    trafficSegments: undefined,
    cacheStatus: 'none',
    fallbackLegCount: Math.max(0, points.length - 1),
    warnings: warning ? [warning] : undefined,
  };
}

function fingerprintPoints(points: LatLngPoint[]): string {
  return points.map(point => `${point.lat.toFixed(6)},${point.lng.toFixed(6)}`).join('|');
}

function sampleRoadBlockExcludePoints(geofences: Geofence[]): LatLngPoint[] {
  const samples: LatLngPoint[] = [];
  for (const geofence of geofences) {
    if (geofence.kind !== 'road_block' || !geofence.roadSegment?.path?.length) continue;
    const path = geofence.roadSegment.path;
    const sampleCount = Math.min(12, path.length);
    for (let i = 0; i < sampleCount; i += 1) {
      const index = Math.round((i * (path.length - 1)) / Math.max(sampleCount - 1, 1));
      samples.push(path[index]);
    }
  }
  return dedupeCandidatePoints(samples).slice(0, 50);
}

function geofenceFingerprint(geofences: Geofence[]): string {
  return geofences
    .map(geofence =>
      `${geofence.id}:${geofence.coordinates.map(point => `${point.lat.toFixed(5)},${point.lng.toFixed(5)}`).join(';')}`
    )
    .join('|');
}

function polygonArea(points: LatLngPoint[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.lng * b.lat - b.lng * a.lat;
  }
  return Math.abs(area / 2);
}

function boundingBox(points: LatLngPoint[]): { minLat: number; maxLat: number; minLng: number; maxLng: number } {
  return {
    minLat: Math.min(...points.map(point => point.lat)),
    maxLat: Math.max(...points.map(point => point.lat)),
    minLng: Math.min(...points.map(point => point.lng)),
    maxLng: Math.max(...points.map(point => point.lng)),
  };
}

function buildBoundingBoxPolygon(points: LatLngPoint[], pad = 0.0008): LatLngPoint[] {
  const { minLat, maxLat, minLng, maxLng } = boundingBox(points);
  return [
    { lat: minLat - pad, lng: minLng - pad },
    { lat: minLat - pad, lng: maxLng + pad },
    { lat: maxLat + pad, lng: maxLng + pad },
    { lat: maxLat + pad, lng: minLng - pad },
  ];
}

export function validateGeofences(geofences: Geofence[]): string[] {
  const warnings: string[] = [];
  for (const geofence of geofences) {
    if (geofence.coordinates.length < 3) {
      warnings.push(`${geofence.label} needs at least 3 points.`);
      continue;
    }
    if (geofence.kind === 'road_block') {
      continue;
    }
    if (polygonArea(geofence.coordinates) < 0.000001) {
      warnings.push(`${geofence.label} is too small to influence routing reliably.`);
    }
    for (let i = 0; i < geofence.coordinates.length; i += 1) {
      const a1 = geofence.coordinates[i];
      const a2 = geofence.coordinates[(i + 1) % geofence.coordinates.length];
      for (let j = i + 1; j < geofence.coordinates.length; j += 1) {
        if (Math.abs(i - j) <= 1 || (i === 0 && j === geofence.coordinates.length - 1)) continue;
        const b1 = geofence.coordinates[j];
        const b2 = geofence.coordinates[(j + 1) % geofence.coordinates.length];
        if (segmentsIntersect(a1, a2, b1, b2)) {
          warnings.push(`${geofence.label} appears self-intersecting.`);
          j = geofence.coordinates.length;
          i = geofence.coordinates.length;
        }
      }
    }
  }
  return warnings;
}

function geofenceIssues(geofence: Geofence): { selfIntersecting: boolean; tooSmall: boolean } {
  let selfIntersecting = false;
  if (geofence.kind !== 'road_block' && geofence.coordinates.length >= 4) {
    for (let i = 0; i < geofence.coordinates.length; i += 1) {
      const a1 = geofence.coordinates[i];
      const a2 = geofence.coordinates[(i + 1) % geofence.coordinates.length];
      for (let j = i + 1; j < geofence.coordinates.length; j += 1) {
        if (Math.abs(i - j) <= 1 || (i === 0 && j === geofence.coordinates.length - 1)) continue;
        const b1 = geofence.coordinates[j];
        const b2 = geofence.coordinates[(j + 1) % geofence.coordinates.length];
        if (segmentsIntersect(a1, a2, b1, b2)) {
          selfIntersecting = true;
          break;
        }
      }
      if (selfIntersecting) break;
    }
  }

  return {
    selfIntersecting,
    tooSmall: geofence.kind === 'road_block' ? false : polygonArea(geofence.coordinates) < 0.000001,
  };
}

function metersToLatDegrees(meters: number): number {
  return meters / 111320;
}

function metersToLngDegrees(meters: number, atLat: number): number {
  const scale = Math.cos((atLat * Math.PI) / 180) * 111320;
  return meters / Math.max(Math.abs(scale), 1e-6);
}

function offsetPoint(point: LatLngPoint, northMeters: number, eastMeters: number): LatLngPoint {
  return {
    lat: point.lat + metersToLatDegrees(northMeters),
    lng: point.lng + metersToLngDegrees(eastMeters, point.lat),
  };
}

function pathDirection(path: LatLngPoint[], fromStart: boolean): { north: number; east: number } {
  if (path.length < 2) return { north: 0, east: 1 };
  const anchor = fromStart ? path[0] : path[path.length - 1];
  const neighbor = fromStart ? path[Math.min(4, path.length - 1)] : path[Math.max(path.length - 5, 0)];
  const lat = fromStart ? neighbor.lat - anchor.lat : anchor.lat - neighbor.lat;
  const lng = fromStart ? neighbor.lng - anchor.lng : anchor.lng - neighbor.lng;
  const avgLat = (anchor.lat + neighbor.lat) / 2;
  const north = lat * 111320;
  const east = lng * Math.cos((avgLat * Math.PI) / 180) * 111320;
  const length = Math.hypot(north, east) || 1;
  return { north: north / length, east: east / length };
}

function roadBlockViaSets(geofence: Geofence): LatLngPoint[][] {
  if (geofence.kind !== 'road_block' || !geofence.roadSegment?.path?.length) return [];

  const path = geofence.roadSegment.path;
  const start = path[0];
  const end = path[path.length - 1];
  const mid = path[Math.floor(path.length / 2)];
  const startDir = pathDirection(path, true);
  const endDir = pathDirection(path, false);
  const avgDir = { north: (startDir.north + endDir.north) / 2, east: (startDir.east + endDir.east) / 2 };
  const avgLen = Math.hypot(avgDir.north, avgDir.east) || 1;
  const tangent = { north: avgDir.north / avgLen, east: avgDir.east / avgLen };
  const leftNormal = { north: -tangent.east, east: tangent.north };
  const rightNormal = { north: tangent.east, east: -tangent.north };

  const pointAt = (
    base: LatLngPoint,
    forwardDir: { north: number; east: number },
    lateralDir: { north: number; east: number },
    forwardMeters: number,
    lateralMeters: number
  ): LatLngPoint => {
    const northMeters = forwardDir.north * forwardMeters + lateralDir.north * lateralMeters;
    const eastMeters = forwardDir.east * forwardMeters + lateralDir.east * lateralMeters;
    return offsetPoint(base, northMeters, eastMeters);
  };

  const leftNearStart = pointAt(start, { north: -startDir.north, east: -startDir.east }, leftNormal, 180, 220);
  const leftFarStart = pointAt(start, { north: -startDir.north, east: -startDir.east }, leftNormal, 320, 360);
  const rightNearStart = pointAt(start, { north: -startDir.north, east: -startDir.east }, rightNormal, 180, 220);
  const rightFarStart = pointAt(start, { north: -startDir.north, east: -startDir.east }, rightNormal, 320, 360);
  const leftNearEnd = pointAt(end, endDir, leftNormal, 180, 220);
  const leftFarEnd = pointAt(end, endDir, leftNormal, 320, 360);
  const rightNearEnd = pointAt(end, endDir, rightNormal, 180, 220);
  const rightFarEnd = pointAt(end, endDir, rightNormal, 320, 360);
  const leftMid = pointAt(mid, tangent, leftNormal, 0, 320);
  const rightMid = pointAt(mid, tangent, rightNormal, 0, 320);

  return [
    [leftNearStart, leftNearEnd],
    [rightNearStart, rightNearEnd],
    [leftFarStart, leftFarEnd],
    [rightFarStart, rightFarEnd],
    [leftNearStart, leftMid, leftNearEnd],
    [rightNearStart, rightMid, rightNearEnd],
    [leftFarStart, leftMid, leftFarEnd],
    [rightFarStart, rightMid, rightFarEnd],
  ];
}

function sanitizeGeofences(geofences: Geofence[]): { geofences: Geofence[]; warnings: string[] } {
  const warnings: string[] = [];
  const sanitized = geofences
    .filter(geofence => geofence.coordinates.length >= 3)
    .map(geofence => {
      const issues = geofenceIssues(geofence);
      if (issues.selfIntersecting || issues.tooSmall) {
        warnings.push(
          issues.selfIntersecting
            ? `${geofence.label} was repaired to a simple blocked rectangle before routing.`
            : `${geofence.label} was expanded to a minimum-size blocked rectangle before routing.`
        );
        return {
          ...geofence,
          coordinates: buildBoundingBoxPolygon(geofence.coordinates, issues.tooSmall ? 0.0012 : 0.0008),
        };
      }
      return geofence;
    });

  return { geofences: sanitized, warnings };
}

function pointInPolygon(point: LatLngPoint, polygon: LatLngPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].lng;
    const yi = polygon[i].lat;
    const xj = polygon[j].lng;
    const yj = polygon[j].lat;
    const intersects =
      yi > point.lat !== yj > point.lat &&
      point.lng < ((xj - xi) * (point.lat - yi)) / (yj - yi + Number.EPSILON) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function orientation(a: LatLngPoint, b: LatLngPoint, c: LatLngPoint): number {
  const value = (b.lng - a.lng) * (c.lat - b.lat) - (b.lat - a.lat) * (c.lng - b.lng);
  if (Math.abs(value) < 1e-10) return 0;
  return value > 0 ? 1 : 2;
}

function onSegment(a: LatLngPoint, b: LatLngPoint, c: LatLngPoint): boolean {
  return (
    b.lng <= Math.max(a.lng, c.lng) + 1e-10 &&
    b.lng + 1e-10 >= Math.min(a.lng, c.lng) &&
    b.lat <= Math.max(a.lat, c.lat) + 1e-10 &&
    b.lat + 1e-10 >= Math.min(a.lat, c.lat)
  );
}

function segmentsIntersect(p1: LatLngPoint, q1: LatLngPoint, p2: LatLngPoint, q2: LatLngPoint): boolean {
  const o1 = orientation(p1, q1, p2);
  const o2 = orientation(p1, q1, q2);
  const o3 = orientation(p2, q2, p1);
  const o4 = orientation(p2, q2, q1);

  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(p1, p2, q1)) return true;
  if (o2 === 0 && onSegment(p1, q2, q1)) return true;
  if (o3 === 0 && onSegment(p2, p1, q2)) return true;
  if (o4 === 0 && onSegment(p2, q1, q2)) return true;
  return false;
}

function routeIntersectsGeofence(routeCoords: [number, number][], geofence: Geofence): boolean {
  const polygon = geofence.coordinates;
  if (polygon.length < 3) return false;

  const routePoints = routeCoords.map(([lat, lng]) => ({ lat, lng }));
  if (routePoints.some(point => pointInPolygon(point, polygon))) return true;

  for (let i = 0; i < routePoints.length - 1; i += 1) {
    const start = routePoints[i];
    const end = routePoints[i + 1];
    for (let j = 0; j < polygon.length; j += 1) {
      const polyStart = polygon[j];
      const polyEnd = polygon[(j + 1) % polygon.length];
      if (segmentsIntersect(start, end, polyStart, polyEnd)) return true;
    }
  }

  return false;
}

function routeIntersectsAnyGeofence(routeCoords: [number, number][], geofences: Geofence[]): boolean {
  return geofences.some(geofence => routeIntersectsGeofence(routeCoords, geofence));
}

function getExpandedCandidatePoints(geofence: Geofence): LatLngPoint[] {
  if (geofence.kind === 'road_block' && geofence.roadSegment?.path?.length) {
    const path = geofence.roadSegment.path;
    const start = path[0];
    const end = path[path.length - 1];
    const mid = path[Math.floor(path.length / 2)];
    const deltaLat = end.lat - start.lat;
    const deltaLng = end.lng - start.lng;
    const length = Math.hypot(deltaLat, deltaLng) || 1;
    const normalLat = -deltaLng / length;
    const normalLng = deltaLat / length;
    const lateralPad = 0.0025;
    const forwardPad = 0.0015;

    return [
      { lat: start.lat - deltaLat * forwardPad + normalLat * lateralPad, lng: start.lng - deltaLng * forwardPad + normalLng * lateralPad },
      { lat: start.lat - deltaLat * forwardPad - normalLat * lateralPad, lng: start.lng - deltaLng * forwardPad - normalLng * lateralPad },
      { lat: end.lat + deltaLat * forwardPad + normalLat * lateralPad, lng: end.lng + deltaLng * forwardPad + normalLng * lateralPad },
      { lat: end.lat + deltaLat * forwardPad - normalLat * lateralPad, lng: end.lng + deltaLng * forwardPad - normalLng * lateralPad },
      { lat: mid.lat + normalLat * lateralPad * 1.4, lng: mid.lng + normalLng * lateralPad * 1.4 },
      { lat: mid.lat - normalLat * lateralPad * 1.4, lng: mid.lng - normalLng * lateralPad * 1.4 },
    ];
  }

  const { minLat, maxLat, minLng, maxLng } = boundingBox(geofence.coordinates);
  const padLat = Math.max(0.002, (maxLat - minLat) * 0.4);
  const padLng = Math.max(0.002, (maxLng - minLng) * 0.4);
  const midLat = (minLat + maxLat) / 2;
  const midLng = (minLng + maxLng) / 2;

  return [
    { lat: minLat - padLat, lng: minLng - padLng },
    { lat: minLat - padLat, lng: maxLng + padLng },
    { lat: maxLat + padLat, lng: minLng - padLng },
    { lat: maxLat + padLat, lng: maxLng + padLng },
    { lat: midLat, lng: minLng - padLng },
    { lat: midLat, lng: maxLng + padLng },
    { lat: minLat - padLat, lng: midLng },
    { lat: maxLat + padLat, lng: midLng },
  ];
}

function dedupeCandidatePoints(points: LatLngPoint[]): LatLngPoint[] {
  const seen = new Set<string>();
  return points.filter(point => {
    const key = `${point.lat.toFixed(5)},${point.lng.toFixed(5)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function candidateViaSets(geofences: Geofence[]): LatLngPoint[][] {
  const structuredRoadBlockSets = geofences.flatMap(roadBlockViaSets);

  const candidates = dedupeCandidatePoints(geofences.flatMap(getExpandedCandidatePoints));
  const single = candidates.map(point => [point]);
  const pairs: LatLngPoint[][] = [];
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      if (pairs.length >= 18) break;
      pairs.push([candidates[i], candidates[j]]);
    }
    if (pairs.length >= 18) break;
  }
  return [...structuredRoadBlockSets, ...single, ...pairs];
}

async function fetchOsrmRoute(points: LatLngPoint[]): Promise<RouteFetchResult> {
  const env = getRoutingEnv();
  const cacheKey = `osrm:${fingerprintPoints(points)}`;
  if (routeCache.has(cacheKey)) {
    return { ...routeCache.get(cacheKey)!, cacheHit: true };
  }
  if (inflightCache.has(cacheKey)) {
    const cached = await inflightCache.get(cacheKey)!;
    return { ...cached, cacheHit: true };
  }

  const coords = points.map(point => `${point.lng},${point.lat}`).join(';');
  const url = `${env.osrmBaseUrl}/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false`;
  const fetchPromise = (async () => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`OSRM request failed with status ${response.status}`);
    }

    const payload = await response.json();
    const route = payload?.routes?.[0];
    if (!route?.geometry?.coordinates) {
      throw new Error('OSRM returned no route geometry');
    }

    const result = {
      coordinates: route.geometry.coordinates.map(([lng, lat]: [number, number]) => [lat, lng]),
      distanceKm: +(route.distance / 1000).toFixed(2),
      durationMin: +(route.duration / 60).toFixed(1),
      source: 'osrm' as const,
    };
    routeCache.set(cacheKey, result);
    return result;
  })();

  inflightCache.set(cacheKey, fetchPromise);
  try {
    const result = await fetchPromise;
    return { ...result, cacheHit: false };
  } finally {
    inflightCache.delete(cacheKey);
  }
}

async function fetchMapboxRoute(points: LatLngPoint[], geofences: Geofence[] = [], applyRoadBlockExclusions = true): Promise<RouteFetchResult> {
  const env = getRoutingEnv();
  const excludePoints = applyRoadBlockExclusions ? sampleRoadBlockExcludePoints(geofences) : [];
  const cacheKey = `mapbox:${fingerprintPoints(points)}:${excludePoints.map(point => `${point.lat.toFixed(6)},${point.lng.toFixed(6)}`).join('|')}:${env.mapboxDepartAt}`;
  if (routeCache.has(cacheKey)) {
    return { ...routeCache.get(cacheKey)!, cacheHit: true };
  }
  if (inflightCache.has(cacheKey)) {
    const cached = await inflightCache.get(cacheKey)!;
    return { ...cached, cacheHit: true };
  }

  const coords = points.map(point => `${point.lng},${point.lat}`).join(';');
  const params = new URLSearchParams({
    access_token: env.mapboxAccessToken,
    geometries: 'geojson',
    overview: 'full',
    steps: 'false',
  });

  if (env.mapboxProfile.includes('driving-traffic')) {
    params.set('annotations', 'congestion,distance,duration');
  }
  if (env.mapboxDepartAt) {
    params.set('depart_at', env.mapboxDepartAt);
  }
  if (excludePoints.length > 0) {
    params.set(
      'exclude',
      excludePoints.map(point => `point(${point.lng} ${point.lat})`).join(',')
    );
  }

  const url = `${env.mapboxBaseUrl}/${env.mapboxProfile}/${coords}?${params.toString()}`;
  const fetchPromise = (async () => {
    const response = await fetch(url);
    if (!response.ok) {
      const rawBody = await response.text();
      let details = rawBody.trim();
      if (details) {
        try {
          const parsed = JSON.parse(rawBody);
          details = parsed?.message || parsed?.code || JSON.stringify(parsed);
        } catch {
          // Keep the raw body when the response is not JSON.
        }
      }
      throw new Error(details ? `Mapbox request failed with status ${response.status}: ${details}` : `Mapbox request failed with status ${response.status}`);
    }

    const payload = await response.json();
    const route = payload?.routes?.[0];
    if (!route?.geometry?.coordinates) {
      throw new Error('Mapbox returned no route geometry');
    }

    const result = {
      coordinates: route.geometry.coordinates.map(([lng, lat]: [number, number]) => [lat, lng]),
      distanceKm: +((route.distance ?? 0) / 1000).toFixed(2),
      durationMin: +((route.duration ?? 0) / 60).toFixed(1),
      source: 'mapbox' as const,
      trafficSegments: buildTrafficSegmentsFromMapboxRoute(route),
    };
    routeCache.set(cacheKey, result);
    return result;
  })();

  inflightCache.set(cacheKey, fetchPromise);
  try {
    const result = await fetchPromise;
    return { ...result, cacheHit: false };
  } finally {
    inflightCache.delete(cacheKey);
  }
}

async function fetchRoutedPath(points: LatLngPoint[], geofences: Geofence[] = [], applyRoadBlockExclusions = true): Promise<RouteFetchResult> {
  const env = getRoutingEnv();
  if (env.activeRoutingProvider === 'mapbox') {
    try {
      return await fetchMapboxRoute(points, geofences, applyRoadBlockExclusions);
    } catch (error) {
      logMapboxFallback(error);
      return fetchOsrmRoute(points);
    }
  }
  return fetchOsrmRoute(points);
}

async function routeLegWithAvoidance(start: LatLngPoint, end: LatLngPoint, geofences: Geofence[]): Promise<RoutedRoad> {
  const env = getRoutingEnv();
  try {
    const direct = await fetchRoutedPath([start, end], [], false);
    if (geofences.length === 0 || !routeIntersectsAnyGeofence(direct.coordinates, geofences)) {
      return {
        ...direct,
        source: direct.source,
        cacheStatus: direct.cacheHit ? 'hit' : 'miss',
        fallbackLegCount: 0,
      };
    }

    const candidates = candidateViaSets(geofences);
    let best: RoutedRoad | null = null;

    for (const viaSet of candidates) {
      if (viaSet.some(via => geofences.some(geofence => pointInPolygon(via, geofence.coordinates)))) continue;
      try {
        const routed = await fetchRoutedPath([start, ...viaSet, end], geofences);
        const candidate: RoutedRoad = {
          ...routed,
          source: routed.source,
          cacheStatus: routed.cacheHit ? 'hit' : 'miss',
          fallbackLegCount: 0,
        };
        if (routeIntersectsAnyGeofence(routed.coordinates, geofences)) continue;
        if (!best || candidate.distanceKm < best.distanceKm) {
          best = candidate;
        }
      } catch {
        continue;
      }
    }

    if (best) {
      return {
        ...best,
        cacheStatus: best.cacheStatus ?? 'mixed',
        fallbackLegCount: 0,
        warnings: [`Route was detoured around a blocked geofence using ${best.source === 'mapbox' ? 'Mapbox traffic routing' : 'OSRM'}.`],
      };
    }

    return {
      ...direct,
      source: direct.source,
      cacheStatus: direct.cacheHit ? 'hit' : 'miss',
      fallbackLegCount: 0,
      warnings: ['No clean road detour was found, so the original road path was kept for this leg.'],
    };
  } catch {
    return syntheticRoad([start, end], `${env.activeRoutingProvider === 'mapbox' ? 'Mapbox traffic routing' : 'OSRM'} failed, so a straight fallback was used for this leg.`);
  }
}

export async function routePathOnRoads(nodes: Node[], path: string[], geofences: Geofence[] = []): Promise<RoutedRoad | null> {
  const env = getRoutingEnv();
  const nodeMap = new Map(nodes.map(node => [node.id, node]));
  const routePoints = path
    .map(id => nodeMap.get(id))
    .filter((node): node is Node & { lat: number; lng: number } => Boolean(node) && typeof node.lat === 'number' && typeof node.lng === 'number')
    .map(node => ({ lat: node.lat, lng: node.lng }));

  if (routePoints.length < 2) return null;

  const { geofences: sanitizedGeofences, warnings: sanitizeWarnings } = sanitizeGeofences(geofences);
  const geofenceWarnings = [...validateGeofences(geofences), ...sanitizeWarnings];

  if (sanitizedGeofences.length === 0) {
    const canRequestWholePath = env.activeRoutingProvider !== 'mapbox' || routePoints.length <= 25;
    if (canRequestWholePath) {
      try {
        const routed = await fetchRoutedPath(routePoints, []);
        return {
          coordinates: routed.coordinates,
          distanceKm: routed.distanceKm,
          durationMin: routed.durationMin,
          source: routed.source,
          trafficSegments: routed.trafficSegments,
          cacheStatus: routed.cacheHit ? 'hit' : 'miss',
          fallbackLegCount: 0,
          warnings: geofenceWarnings.length > 0 ? geofenceWarnings : undefined,
        };
      } catch {
        const fallback = syntheticRoad(routePoints, `${env.activeRoutingProvider === 'mapbox' ? 'Mapbox traffic routing' : 'OSRM'} failed, so a straight fallback was used for this route.`);
        return {
          ...fallback,
          warnings: [...(fallback.warnings ?? []), ...geofenceWarnings],
        };
      }
    }
  }

  let distanceKm = 0;
  let durationMin = 0;
  const coordinates: [number, number][] = [];
  const warnings: string[] = [...geofenceWarnings];
  let fallbackLegCount = 0;
  let cacheHitCount = 0;
  let cacheMissCount = 0;
  const trafficSegments: RouteTrafficSegment[] = [];

  for (let index = 0; index < routePoints.length - 1; index += 1) {
    const routedLeg = await routeLegWithAvoidance(routePoints[index], routePoints[index + 1], sanitizedGeofences);
    distanceKm += routedLeg.distanceKm;
    durationMin += routedLeg.durationMin;
    if (routedLeg.warnings) warnings.push(...routedLeg.warnings);
    if (routedLeg.trafficSegments?.length) trafficSegments.push(...routedLeg.trafficSegments);
    if (routedLeg.source === 'synthetic') fallbackLegCount += 1;
    if (routedLeg.cacheStatus === 'hit') cacheHitCount += 1;
    if (routedLeg.cacheStatus === 'miss') cacheMissCount += 1;

    routedLeg.coordinates.forEach((coord, coordIndex) => {
      if (coordinates.length > 0 && coordIndex === 0) return;
      coordinates.push(coord);
    });
  }

  return {
    coordinates,
    distanceKm: +distanceKm.toFixed(2),
    durationMin: +durationMin.toFixed(1),
    source: fallbackLegCount > 0 ? 'synthetic' : env.activeRoutingProvider,
    trafficSegments: trafficSegments.length > 0 ? trafficSegments : undefined,
    cacheStatus:
      cacheHitCount > 0 && cacheMissCount > 0
        ? 'mixed'
        : cacheHitCount > 0
          ? 'hit'
          : cacheMissCount > 0
            ? 'miss'
            : 'none',
    fallbackLegCount,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}
