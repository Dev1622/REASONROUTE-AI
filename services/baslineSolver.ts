// services/baslineSolver.ts
// Shared math primitives for the GNOPT Spatial Reasoning Engine.
// FIX SUMMARY:
//   1. nearestNeighbor now uses getEdgeCost (composite) not euclidean (dumb)
//   2. twoOpt now uses composite cost not euclidean
//   3. getEdgeCost heatmap lookup normalises coordinates to heatmap dimensions
//      (fixes crash/wrong values when heatmap is 10x10 but coords are 0-100)

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
const EMISSION_IDLE_G_KM  = 400;
const IDLE_TRAFFIC_THRESH = 0.4;

export function euclidean(a: Node, b: Node): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy) * SCALE_KM;
}

// ---------------------------------------------------------
// getEdgeCost — Physics model used by BOTH baseline AND optimized
// FIX: heatmap lookup now normalises 0-100 coords to heatmap dimensions
// ---------------------------------------------------------
export function getEdgeCost(a: Node, b: Node, ctx: TrafficContext): PathMetrics {
  const distKm = euclidean(a, b);

  // Heatmap lookup — normalise 0-100 grid coords → heatmap array indices
  let trafficSeverity = 0;
  if (ctx.heatmap && ctx.heatmap.length > 0) {
    const rows = ctx.heatmap.length;
    const cols = ctx.heatmap[0]?.length ?? 0;
    if (rows > 0 && cols > 0) {
      const lookup = (x: number, y: number): number => {
        // Normalise: coords are 0-100, map to [0, rows/cols)
        const r = Math.min(rows - 1, Math.max(0, Math.floor((y / 100) * rows)));
        const c = Math.min(cols - 1, Math.max(0, Math.floor((x / 100) * cols)));
        return ctx.heatmap![r]?.[c] ?? 0;
      };
      // Sample start, midpoint, and end — take the worst
      const s1 = lookup(a.x, a.y);
      const s2 = lookup(b.x, b.y);
      const s3 = lookup((a.x + b.x) / 2, (a.y + b.y) / 2);
      trafficSeverity = Math.max(s1, s2, s3);
    }
  }

  // Disruption zone check — midpoint inside zone → full gridlock
  if (ctx.disruptionZones) {
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const hit = ctx.disruptionZones.some(z => {
      const dx = mx - z.x;
      const dy = my - z.y;
      return Math.sqrt(dx * dx + dy * dy) <= z.radius;
    });
    if (hit) trafficSeverity = 1.0;
  }

  const trafficDelay  = 1.0 + (trafficSeverity * trafficSeverity * 10);
  const isHighway     = distKm > HIGHWAY_THRESH_KM;
  const rawSpeed      = isHighway ? HIGHWAY_SPEED_KMH : BASE_SPEED_KMH;
  const effectiveSpd  = Math.max(1, rawSpeed / trafficDelay);

  const timeMins      = distKm > 0 ? (distKm / effectiveSpd) * 60 : 0;
  const emissionRate  = trafficSeverity > IDLE_TRAFFIC_THRESH ? EMISSION_IDLE_G_KM : EMISSION_BASE_G_KM;
  const emissions     = distKm * emissionRate;

  const composite =
    timeMins          * ctx.weightTime      +
    (emissions / 100) * ctx.weightEmissions +
    distKm            * ctx.weightDistance;

  return { distance: distKm, time: timeMins, emissions, composite };
}

// ---------------------------------------------------------
// nearestNeighbor
// FIX: Now uses getEdgeCost (composite cost) not euclidean.
// Baseline must use the same cost model as the optimizer so both
// paths are scored on identical criteria. Previously baseline used
// pure geometry → it ignored traffic → optimized "looked" worse on
// raw distance even when it correctly avoided high-cost zones.
// ---------------------------------------------------------
export function nearestNeighbor(
  nodes: Node[],
  startId: string,
  ctx: TrafficContext
): string[] {
  if (nodes.length === 0) return [];

  const unvisited = new Set(nodes.map(n => n.id));
  const nodeMap   = new Map(nodes.map(n => [n.id, n]));
  const path: string[]  = [startId];
  unvisited.delete(startId);
  let currentId = startId;

  while (unvisited.size > 0) {
    let bestId   = '';
    let minCost  = Infinity;
    const current = nodeMap.get(currentId)!;

    for (const candidateId of unvisited) {
      const candidate = nodeMap.get(candidateId)!;
      // Use composite cost — same as the optimizer
      const cost = getEdgeCost(current, candidate, ctx).composite;
      if (cost < minCost) {
        minCost = cost;
        bestId  = candidateId;
      }
    }

    if (!bestId) break;
    path.push(bestId);
    unvisited.delete(bestId);
    currentId = bestId;
  }

  if (path[0] !== path[path.length - 1]) path.push(path[0]);
  return path;
}

// ---------------------------------------------------------
// twoOpt
// FIX: Now uses composite cost not euclidean for consistent
// comparison between current and candidate edge swaps.
// ---------------------------------------------------------
export function twoOpt(
  path: string[],
  nodeMap: Map<string, Node>,
  ctx: TrafficContext
): string[] {
  let best      = [...path];
  let improved  = true;
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
        if (!a || !b || !c || !d) continue;

        // Compare composite cost not raw distance
        const curCost = getEdgeCost(a, b, ctx).composite + getEdgeCost(c, d, ctx).composite;
        const newCost = getEdgeCost(a, c, ctx).composite + getEdgeCost(b, d, ctx).composite;

        if (newCost < curCost - 1e-9) {
          best = [
            ...best.slice(0, i),
            ...best.slice(i, k + 1).reverse(),
            ...best.slice(k + 1),
          ];
          improved = true;
        }
      }
    }
  }
  return best;
}

// ---------------------------------------------------------
// evaluatePath — total metrics for a complete tour
// Always on ORIGINAL nodeMap (never compressed coordinates)
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

export function routeDistance(path: string[], nodeMap: Map<string, Node>): number {
  let total = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const a = nodeMap.get(path[i]);
    const b = nodeMap.get(path[i + 1]);
    if (a && b) total += euclidean(a, b);
  }
  return total;
}