// services/baslineSolver.ts
// Shared math primitives for the GNOPT Spatial Reasoning Engine.

export const SCALE_KM = 1.0;

export type Node = {
  id: string;
  x: number;
  y: number;
  type?: string;
  label?: string;
  constraints?: any[];
};

export type TrafficContext = {
  heatmap?: number[][];
  disruptionZones?: { x: number; y: number; radius: number; description: string }[];
  weightTime: number;
  weightEmissions: number;
  weightDistance: number;
};

export type PathMetrics = {
  distance:  number;
  time:      number;
  emissions: number;
  composite: number;
};

// PHYSICS CONSTANTS
const BASE_SPEED_KMH      = 40;
const HIGHWAY_SPEED_KMH   = 90;
const HIGHWAY_THRESH_KM   = 5;
const EMISSION_BASE_G_KM  = 120;
const EMISSION_IDLE_G_KM  = 400; // Heavy penalty for gridlock
const IDLE_TRAFFIC_THRESH = 0.4;

export function euclidean(a: Node, b: Node): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy) * SCALE_KM;
}

// ---------------------------------------------------------
// SMART COST (For Optimized Engine & Evaluation)
// ---------------------------------------------------------
export function getEdgeCost(a: Node, b: Node, ctx: TrafficContext): PathMetrics {
  const distKm = euclidean(a, b);

  // 1. Heatmap Scanning (Start, Mid, End)
  let trafficSeverity = 0;
  if (ctx.heatmap && ctx.heatmap.length > 0) {
    const getSev = (x: number, y: number) => {
       const rows = ctx.heatmap!.length;
       const cols = ctx.heatmap![0]?.length || 0;
       const r = Math.min(Math.max(Math.floor(x), 0), rows - 1);
       const c = Math.min(Math.max(Math.floor(y), 0), cols - 1);
       return ctx.heatmap![r]?.[c] ?? 0;
    };
    
    const s1 = getSev(a.x, a.y);
    const s2 = getSev(b.x, b.y);
    const s3 = getSev((a.x + b.x)/2, (a.y + b.y)/2);
    trafficSeverity = Math.max(s1, s2, s3);
  }

  // 2. Disruption Zone Check
  if (ctx.disruptionZones) {
      const hit = ctx.disruptionZones.some(z => {
          const mx = (a.x + b.x)/2;
          const my = (a.y + b.y)/2;
          return Math.sqrt((mx-z.x)**2 + (my-z.y)**2) <= z.radius;
      });
      if (hit) trafficSeverity = 1.0;
  }

  // 3. Physics Calculation
  const trafficDelay  = 1.0 + (trafficSeverity * trafficSeverity * 10);
  const isHighway     = distKm > HIGHWAY_THRESH_KM;
  const rawSpeed      = isHighway ? HIGHWAY_SPEED_KMH : BASE_SPEED_KMH;
  const effectiveSpd  = Math.max(1, rawSpeed / trafficDelay); 
  
  const timeMins      = distKm > 0 ? (distKm / effectiveSpd) * 60 : 0;
  const emissionRate  = trafficSeverity > IDLE_TRAFFIC_THRESH ? EMISSION_IDLE_G_KM : EMISSION_BASE_G_KM;
  const emissions     = distKm * emissionRate;

  const composite =
    timeMins              * ctx.weightTime      +
    (emissions / 100)     * ctx.weightEmissions +
    distKm                * ctx.weightDistance;

  return { distance: distKm, time: timeMins, emissions, composite };
}

// ---------------------------------------------------------
// DUMB SOLVER (For Baseline Only - Ignores Traffic)
// ---------------------------------------------------------
export function nearestNeighbor(
  nodes: Node[],
  startId: string,
  ctx: TrafficContext
): string[] {
  if (nodes.length === 0) return [];
  const unvisited = new Set(nodes.map(n => n.id));
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const path: string[] = [startId];
  unvisited.delete(startId);
  
  let currentId = startId;

  while (unvisited.size > 0) {
    let bestId = "";
    let minDist = Infinity;
    const current = nodeMap.get(currentId)!;

    for (const candidateId of unvisited) {
      const candidate = nodeMap.get(candidateId)!;
      // PURE GEOMETRY (Dumb)
      const d = euclidean(current, candidate);
      if (d < minDist) {
        minDist = d;
        bestId = candidateId;
      }
    }

    if (bestId) {
      path.push(bestId);
      unvisited.delete(bestId);
      currentId = bestId;
    } else {
      break;
    }
  }
  
  if (path[0] !== path[path.length-1]) path.push(path[0]);
  return path;
}

export function twoOpt(
  path: string[],
  nodeMap: Map<string, Node>,
  ctx: TrafficContext
): string[] {
  let best = [...path];
  let improved = true;
  let iterations = 0;

  while (improved && iterations < 50) {
    improved = false;
    iterations++;
    for (let i = 1; i < best.length - 2; i++) {
      for (let k = i + 1; k < best.length - 1; k++) {
        const a = nodeMap.get(best[i - 1])!;
        const b = nodeMap.get(best[i])!;
        const c = nodeMap.get(best[k])!;
        const d = nodeMap.get(best[k + 1])!;
        
        // PURE GEOMETRY (Dumb)
        const curDist = euclidean(a, b) + euclidean(c, d);
        const newDist = euclidean(a, c) + euclidean(b, d);

        if (newDist < curDist) {
          best = [...best.slice(0, i), ...best.slice(i, k + 1).reverse(), ...best.slice(k + 1)];
          improved = true;
        }
      }
    }
  }
  return best;
}

// ---------------------------------------------------------
// UTILITIES
// ---------------------------------------------------------

export function evaluatePath(
  path: string[],
  nodeMap: Map<string, Node>,
  ctx: TrafficContext
): PathMetrics {
  const total: PathMetrics = { distance: 0, time: 0, emissions: 0, composite: 0 };
  for (let i = 0; i < path.length - 1; i++) {
    const a = nodeMap.get(path[i]);
    const b = nodeMap.get(path[i + 1]);
    if (a && b) {
      const e = getEdgeCost(a, b, ctx);
      total.distance  += e.distance;
      total.time      += e.time;
      total.emissions += e.emissions;
      total.composite += e.composite;
    }
  }
  return total;
}

// RESTORED: This was missing!
export function routeDistance(path: string[], nodeMap: Map<string, Node>): number {
  let total = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const a = nodeMap.get(path[i]);
    const b = nodeMap.get(path[i + 1]);
    if (a && b) total += euclidean(a, b);
  }
  return total;
}