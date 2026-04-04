import { Geofence, LatLngPoint, Node, RoutedRoad } from '../types';

type RouteFetchResult = {
  coordinates: [number, number][];
  distanceKm: number;
  durationMin: number;
  cacheHit: boolean;
};

const OSRM_BASE_URL = (typeof process !== 'undefined' && process.env?.OSRM_BASE_URL) || 'https://router.project-osrm.org';
const routeCache = new Map<string, Omit<RouteFetchResult, 'cacheHit'>>();
const inflightCache = new Map<string, Promise<Omit<RouteFetchResult, 'cacheHit'>>>();

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
    cacheStatus: 'none',
    fallbackLegCount: Math.max(0, points.length - 1),
    warnings: warning ? [warning] : undefined,
  };
}

function fingerprintPoints(points: LatLngPoint[]): string {
  return points.map(point => `${point.lat.toFixed(6)},${point.lng.toFixed(6)}`).join('|');
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

function pathDirection(path: LatLngPoint[], fromStart: boolean): { lat: number; lng: number } {
  if (path.length < 2) return { lat: 0, lng: 1 };
  const anchor = fromStart ? path[0] : path[path.length - 1];
  const neighbor = fromStart ? path[Math.min(4, path.length - 1)] : path[Math.max(path.length - 5, 0)];
  const lat = fromStart ? neighbor.lat - anchor.lat : anchor.lat - neighbor.lat;
  const lng = fromStart ? neighbor.lng - anchor.lng : anchor.lng - neighbor.lng;
  const length = Math.hypot(lat, lng) || 1;
  return { lat: lat / length, lng: lng / length };
}

function roadBlockViaSets(geofence: Geofence): LatLngPoint[][] {
  if (geofence.kind !== 'road_block' || !geofence.roadSegment?.path?.length) return [];

  const path = geofence.roadSegment.path;
  const start = path[0];
  const end = path[path.length - 1];
  const mid = path[Math.floor(path.length / 2)];
  const startDir = pathDirection(path, true);
  const endDir = pathDirection(path, false);
  const avgDir = { lat: (startDir.lat + endDir.lat) / 2, lng: (startDir.lng + endDir.lng) / 2 };
  const avgLen = Math.hypot(avgDir.lat, avgDir.lng) || 1;
  const tangent = { lat: avgDir.lat / avgLen, lng: avgDir.lng / avgLen };
  const leftNormal = { lat: -tangent.lng, lng: tangent.lat };
  const rightNormal = { lat: tangent.lng, lng: -tangent.lat };

  const pointAt = (base: LatLngPoint, forwardDir: { lat: number; lng: number }, lateralDir: { lat: number; lng: number }, forwardMeters: number, lateralMeters: number): LatLngPoint => {
    const northMeters = forwardDir.lat * forwardMeters * 111320 + lateralDir.lat * lateralMeters * 111320;
    const eastMeters =
      forwardDir.lng * forwardMeters * Math.cos((base.lat * Math.PI) / 180) * 111320 +
      lateralDir.lng * lateralMeters * Math.cos((base.lat * Math.PI) / 180) * 111320;
    return offsetPoint(base, northMeters, eastMeters);
  };

  const leftNearStart = pointAt(start, { lat: -startDir.lat, lng: -startDir.lng }, leftNormal, 180, 220);
  const leftFarStart = pointAt(start, { lat: -startDir.lat, lng: -startDir.lng }, leftNormal, 320, 360);
  const rightNearStart = pointAt(start, { lat: -startDir.lat, lng: -startDir.lng }, rightNormal, 180, 220);
  const rightFarStart = pointAt(start, { lat: -startDir.lat, lng: -startDir.lng }, rightNormal, 320, 360);
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
  const cacheKey = fingerprintPoints(points);
  if (routeCache.has(cacheKey)) {
    return { ...routeCache.get(cacheKey)!, cacheHit: true };
  }
  if (inflightCache.has(cacheKey)) {
    const cached = await inflightCache.get(cacheKey)!;
    return { ...cached, cacheHit: true };
  }

  const coords = points.map(point => `${point.lng},${point.lat}`).join(';');
  const url = `${OSRM_BASE_URL}/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false`;
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

async function routeLegWithAvoidance(start: LatLngPoint, end: LatLngPoint, geofences: Geofence[]): Promise<RoutedRoad> {
  try {
    const direct = await fetchOsrmRoute([start, end]);
    if (geofences.length === 0 || !routeIntersectsAnyGeofence(direct.coordinates, geofences)) {
      return {
        ...direct,
        source: 'osrm',
        cacheStatus: direct.cacheHit ? 'hit' : 'miss',
        fallbackLegCount: 0,
      };
    }

    const candidates = candidateViaSets(geofences);
    let best: RoutedRoad | null = null;
    let bestRoadOnly: RoutedRoad | null = {
      ...direct,
      source: 'osrm',
      cacheStatus: direct.cacheHit ? 'hit' : 'miss',
      fallbackLegCount: 0,
    };

    for (const viaSet of candidates) {
      if (viaSet.some(via => geofences.some(geofence => pointInPolygon(via, geofence.coordinates)))) continue;
      try {
        const routed = await fetchOsrmRoute([start, ...viaSet, end]);
        const candidate: RoutedRoad = {
          ...routed,
          source: 'osrm',
          cacheStatus: routed.cacheHit ? 'hit' : 'miss',
          fallbackLegCount: 0,
        };
        if (!bestRoadOnly || candidate.distanceKm < bestRoadOnly.distanceKm) {
          bestRoadOnly = candidate;
        }
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
        warnings: ['Route was detoured around a blocked geofence.'],
      };
    }

    if (bestRoadOnly) {
      return {
        ...bestRoadOnly,
        cacheStatus: bestRoadOnly.cacheStatus ?? 'mixed',
        fallbackLegCount: 0,
        warnings: ['No clean detour was found, so the closest road-based reroute was kept.'],
      };
    }

    return syntheticRoad([start, end], 'OSRM could not avoid the blocked geofence, so a straight fallback was used for this leg.');
  } catch {
    return syntheticRoad([start, end], 'OSRM routing failed, so a straight fallback was used for this leg.');
  }
}

export async function routePathOnRoads(nodes: Node[], path: string[], geofences: Geofence[] = []): Promise<RoutedRoad | null> {
  const nodeMap = new Map(nodes.map(node => [node.id, node]));
  const routePoints = path
    .map(id => nodeMap.get(id))
    .filter((node): node is Node & { lat: number; lng: number } => Boolean(node) && typeof node.lat === 'number' && typeof node.lng === 'number')
    .map(node => ({ lat: node.lat, lng: node.lng }));

  if (routePoints.length < 2) return null;

  const { geofences: sanitizedGeofences, warnings: sanitizeWarnings } = sanitizeGeofences(geofences);
  const geofenceWarnings = [...validateGeofences(geofences), ...sanitizeWarnings];

  if (sanitizedGeofences.length === 0) {
    try {
      const routed = await fetchOsrmRoute(routePoints);
      return {
        coordinates: routed.coordinates,
        distanceKm: routed.distanceKm,
        durationMin: routed.durationMin,
        source: 'osrm',
        cacheStatus: routed.cacheHit ? 'hit' : 'miss',
        fallbackLegCount: 0,
        warnings: geofenceWarnings.length > 0 ? geofenceWarnings : undefined,
      };
    } catch {
      const fallback = syntheticRoad(routePoints, 'OSRM routing failed, so a straight fallback was used for this route.');
      return {
        ...fallback,
        warnings: [...(fallback.warnings ?? []), ...geofenceWarnings],
      };
    }
  }

  let distanceKm = 0;
  let durationMin = 0;
  const coordinates: [number, number][] = [];
  const warnings: string[] = [...geofenceWarnings];
  let fallbackLegCount = 0;
  let cacheHitCount = 0;
  let cacheMissCount = 0;

  for (let index = 0; index < routePoints.length - 1; index += 1) {
    const routedLeg = await routeLegWithAvoidance(routePoints[index], routePoints[index + 1], sanitizedGeofences);
    distanceKm += routedLeg.distanceKm;
    durationMin += routedLeg.durationMin;
    if (routedLeg.warnings) warnings.push(...routedLeg.warnings);
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
    source: fallbackLegCount > 0 ? 'synthetic' : 'osrm',
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
