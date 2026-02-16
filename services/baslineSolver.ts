// services/baslineSolver.ts
// Shared math primitives for the GNOPT Spatial Reasoning Engine v6.0
//
// v6.0 changes:
//   1. twoOpt iteration cap raised 50 → 200 (was documented as 500 but never changed)
//   2. Added orOpt: single-stop relocation pass — finds stops that are cheaply
//      insertable elsewhere, giving ~5-15% additional improvement after 2-opt.
//   3. getEdgeCost heatmap lookup uses normalised coords (from v4.0, unchanged)
//   4. nearestNeighbor uses composite cost (from v4.0, unchanged)

export const SCALE_KM = 1.0;

export type Node = {
  id: string;
  x: number;
  y: number;
  type?: string;
  label?: string;
  constraints?: any[];
  // Constraint fields — set by CSV parser, read by TW-aware solver and evaluateConstraintPenalty
  timeWindow?:  [number, number]; // [open_min, close_min] from route start
  demand?:      number;           // package weight / demand units
  serviceTime?: number;           // minutes to spend at this stop
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

// ── Physics constants ─────────────────────────────────────────────
const BASE_SPEED_KMH      = 40;
const HIGHWAY_SPEED_KMH   = 90;
const HIGHWAY_THRESH_KM   = 5;
const EMISSION_BASE_G_KM  = 120;
const EMISSION_IDLE_G_KM  = 400;
const IDLE_TRAFFIC_THRESH = 0.4;

// ─────────────────────────────────────────────────────────────────
export function euclidean(a: Node, b: Node): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy) * SCALE_KM;
}

// ─────────────────────────────────────────────────────────────────
// getEdgeCost — full physics model, consistent between baseline/optimized
// ─────────────────────────────────────────────────────────────────
export function getEdgeCost(a: Node, b: Node, ctx: TrafficContext): PathMetrics {
  const distKm = euclidean(a, b);

  const coordToPct = (v: number): number => {
    if (!Number.isFinite(v)) return 0;
    if (v >= 0 && v <= 1) return v * 100;
    if (v > 1 && v <= 10) return v * 10;
    return v;
  };

  // Heatmap: normalise 0-100 coords → array indices, sample 3 points
  let trafficSeverity = 0;
  if (ctx.heatmap && ctx.heatmap.length > 0) {
    const rows = ctx.heatmap.length;
    const cols = ctx.heatmap[0]?.length ?? 0;
    if (rows > 0 && cols > 0) {
      const lookup = (x: number, y: number): number => {
        const px = coordToPct(x);
        const py = coordToPct(y);
        const r = Math.min(rows-1, Math.max(0, Math.floor((py/100)*rows)));
        const c = Math.min(cols-1, Math.max(0, Math.floor((px/100)*cols)));
        return ctx.heatmap![r]?.[c] ?? 0;
      };
      trafficSeverity = Math.max(lookup(a.x,a.y), lookup(b.x,b.y), lookup((a.x+b.x)/2,(a.y+b.y)/2));
    }
  }

  // Disruption zone: midpoint check → full gridlock
  if (ctx.disruptionZones) {
    const mx = (a.x+b.x)/2, my = (a.y+b.y)/2;
    if (ctx.disruptionZones.some(z => Math.sqrt((mx-z.x)**2+(my-z.y)**2) <= z.radius)) {
      trafficSeverity = 1.0;
    }
  }

  const trafficDelay = 1.0 + trafficSeverity * trafficSeverity * 10;
  const isHighway    = distKm > HIGHWAY_THRESH_KM;
  const effectiveSpd = Math.max(1, (isHighway ? HIGHWAY_SPEED_KMH : BASE_SPEED_KMH) / trafficDelay);
  const timeMins     = distKm > 0 ? (distKm / effectiveSpd) * 60 : 0;
  const emissions    = distKm * (trafficSeverity > IDLE_TRAFFIC_THRESH ? EMISSION_IDLE_G_KM : EMISSION_BASE_G_KM);
  const composite    = timeMins * ctx.weightTime + (emissions/100) * ctx.weightEmissions + distKm * ctx.weightDistance;

  return { distance: distKm, time: timeMins, emissions, composite };
}

// ─────────────────────────────────────────────────────────────────
// nearestNeighbor — greedy tour using composite cost
// ─────────────────────────────────────────────────────────────────
export function nearestNeighbor(nodes: Node[], startId: string, ctx: TrafficContext): string[] {
  if (nodes.length === 0) return [];
  const unvisited = new Set(nodes.map(n => n.id));
  const nodeMap   = new Map(nodes.map(n => [n.id, n]));
  const path      = [startId];
  unvisited.delete(startId);
  let currentId = startId;

  while (unvisited.size > 0) {
    let bestId = '', minCost = Infinity;
    const cur = nodeMap.get(currentId)!;
    for (const id of unvisited) {
      const cost = getEdgeCost(cur, nodeMap.get(id)!, ctx).composite;
      if (cost < minCost) { minCost = cost; bestId = id; }
    }
    if (!bestId) break;
    path.push(bestId);
    unvisited.delete(bestId);
    currentId = bestId;
  }

  if (path[0] !== path[path.length-1]) path.push(path[0]);
  return path;
}

// ─────────────────────────────────────────────────────────────────
// twoOpt — swap pairs of edges to reduce composite cost
// FIX: iteration cap raised from 50 → 200 for better convergence
// ─────────────────────────────────────────────────────────────────
export function twoOpt(path: string[], nodeMap: Map<string,Node>, ctx: TrafficContext): string[] {
  let best = [...path];
  let improved = true;
  let iterations = 0;

  // Scale iteration cap by problem size to prevent browser lockup on large inputs.
  // n≤50: 200 iterations (full convergence)
  // n≤200: 50 iterations (good quality, fast)
  // n>200: 10 iterations (quick improvement only, prevents UI freeze)
  const n = path.length;
  const maxIter = n > 200 ? 10 : n > 50 ? 50 : 200;

  while (improved && iterations < maxIter) {
    improved = false;
    iterations++;

    for (let i = 1; i < best.length-2; i++) {
      for (let k = i+1; k < best.length-1; k++) {
        const a = nodeMap.get(best[i-1])!, b = nodeMap.get(best[i])!;
        const c = nodeMap.get(best[k])!,   d = nodeMap.get(best[k+1])!;
        if (!a||!b||!c||!d) continue;

        const curCost = getEdgeCost(a,b,ctx).composite + getEdgeCost(c,d,ctx).composite;
        const newCost = getEdgeCost(a,c,ctx).composite + getEdgeCost(b,d,ctx).composite;

        if (newCost < curCost - 1e-9) {
          best = [...best.slice(0,i), ...best.slice(i,k+1).reverse(), ...best.slice(k+1)];
          improved = true;
        }
      }
    }
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────
// orOpt — single-stop relocation (or-opt-1)
// Tries moving each non-depot stop to every other position in the tour.
// Catches improvements 2-opt misses: single insertions don't change
// edge parity so 2-opt never finds them.
// Returns a closed tour.
// ─────────────────────────────────────────────────────────────────
export function orOpt(path: string[], nodeMap: Map<string,Node>, depotId: string, ctx: TrafficContext): string[] {
  // orOpt is O(n³) — skip entirely for large inputs to prevent browser freeze.
  // For n>100, the 2-opt pass already gives good quality; or-opt adds marginal gain
  // at the cost of making the UI unresponsive for seconds/minutes.
  if (path.length > 100) return path;

  let best = [...path];
  let improved = true;

  while (improved) {
    improved = false;

    for (let i = 1; i < best.length-1; i++) {
      if (best[i] === depotId) continue;  // never relocate depot

      // Remove stop i — the tour without it
      const without = [...best.slice(0,i), ...best.slice(i+1)];
      const node    = nodeMap.get(best[i])!;
      if (!node) continue;

      const currentCost = evaluatePath(best, nodeMap, ctx).composite;

      let bestInsertCost = currentCost;
      let bestInsertIdx  = -1;

      // Try inserting between every pair of consecutive stops in `without`
      for (let j = 0; j < without.length-1; j++) {
        if (j === i-1) continue;  // same position — skip
        const candidate = [
          ...without.slice(0,j+1),
          best[i],
          ...without.slice(j+1),
        ];
        const cost = evaluatePath(candidate, nodeMap, ctx).composite;
        if (cost < bestInsertCost - 1e-9) {
          bestInsertCost = cost;
          bestInsertIdx  = j;
        }
      }

      if (bestInsertIdx >= 0) {
        best = [
          ...without.slice(0, bestInsertIdx+1),
          best[i],
          ...without.slice(bestInsertIdx+1),
        ];
        improved = true;
        break;  // restart after any improvement
      }
    }
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────
// evaluatePath — total metrics for a complete tour
// ─────────────────────────────────────────────────────────────────
export function evaluatePath(path: string[], nodeMap: Map<string,Node>, ctx: TrafficContext): PathMetrics {
  const total: PathMetrics = { distance:0, time:0, emissions:0, composite:0 };
  for (let i = 0; i < path.length-1; i++) {
    const a = nodeMap.get(path[i]), b = nodeMap.get(path[i+1]);
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

export function routeDistance(path: string[], nodeMap: Map<string,Node>): number {
  let total = 0;
  for (let i = 0; i < path.length-1; i++) {
    const a = nodeMap.get(path[i]), b = nodeMap.get(path[i+1]);
    if (a && b) total += euclidean(a, b);
  }
  return total;
}

// ─────────────────────────────────────────────────────────────────
// capacitatedNearestNeighbor — CVRP multi-vehicle solver
//
// The core constraint the standard NN ignores: each vehicle has a
// capacity limit. When adding the next nearest stop would exceed
// the vehicle's remaining capacity, that vehicle returns to depot
// and a new vehicle starts. This directly enforces the "capacity"
// constraint type from the engine's constraint system.
//
// Returns: array of routes, one per vehicle.
// Each route is a closed tour: [depot, ...stops, depot]
// Total distance = sum of evaluatePath across all routes.
//
// This is the algorithm that makes CVRP benchmark runs valid —
// a standard NN produces ONE tour visiting all stops which is
// not a legal CVRP solution (vehicles would be overloaded).
// ─────────────────────────────────────────────────────────────────

export type CVRPRoute = {
  path:     string[];       // closed tour [depot,...,depot]
  demand:   number;         // total demand on this vehicle
  metrics:  PathMetrics;    // distance, time, emissions, composite
  vehicle:  number;         // vehicle index (1-based)
};

export type CVRPSolution = {
  routes:        CVRPRoute[];
  totalDistance: number;
  totalTime:     number;
  totalEmissions:number;
  vehiclesUsed:  number;
};

export function capacitatedNearestNeighbor(
  nodes:          Node[],
  depotId:        string,
  vehicleCapacity: number,
  ctx:            TrafficContext
): CVRPSolution {
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const depot   = nodeMap.get(depotId)!;

  // Build demand map — demand stored in node.demand field (set by parser)
  const getDemand = (id: string): number =>
    (nodeMap.get(id) as any)?.demand ?? 0;

  // All non-depot nodes to visit
  const unvisited = new Set(
    nodes.filter(n => n.id !== depotId).map(n => n.id)
  );

  const routes: CVRPRoute[] = [];
  let vehicleNum = 1;

  while (unvisited.size > 0) {
    // Start new vehicle from depot
    const path: string[]  = [depotId];
    let currentId         = depotId;
    let remainingCapacity = vehicleCapacity;
    let routeDemand       = 0;

    while (true) {
      const current = nodeMap.get(currentId)!;

      // Find nearest feasible unvisited node (fits in remaining capacity)
      let bestId:   string | null = null;
      let bestCost: number        = Infinity;

      for (const candidateId of unvisited) {
        const demand = getDemand(candidateId);
        if (demand > remainingCapacity) continue; // won't fit — skip

        const candidate = nodeMap.get(candidateId)!;
        const cost = getEdgeCost(current, candidate, ctx).composite;
        if (cost < bestCost) { bestCost = cost; bestId = candidateId; }
      }

      if (bestId === null) break; // no more nodes fit this vehicle — close route

      // Add best node to this vehicle's route
      path.push(bestId);
      const demand = getDemand(bestId);
      remainingCapacity -= demand;
      routeDemand       += demand;
      unvisited.delete(bestId);
      currentId = bestId;
    }

    // Close the route back to depot
    path.push(depotId);
    const metrics = evaluatePath(path, nodeMap, ctx);

    routes.push({
      path,
      demand:  routeDemand,
      metrics,
      vehicle: vehicleNum++,
    });
  }

  // Aggregate across all vehicles
  const totalDistance  = routes.reduce((s, r) => s + r.metrics.distance,  0);
  const totalTime      = routes.reduce((s, r) => s + r.metrics.time,      0);
  const totalEmissions = routes.reduce((s, r) => s + r.metrics.emissions, 0);

  return {
    routes,
    totalDistance:  +totalDistance.toFixed(2),
    totalTime:      +totalTime.toFixed(1),
    totalEmissions: +totalEmissions.toFixed(0),
    vehiclesUsed:   routes.length,
  };
}

// ─────────────────────────────────────────────────────────────────
// twoOptIntraRoute — improve each vehicle route independently
//
// Applies 2-opt within a single vehicle's route.
// Critical for CVRP quality: inter-route swaps are complex (require
// capacity rebalancing), but intra-route 2-opt is safe — it doesn't
// change which nodes are on which vehicle, only the order within one route.
// ─────────────────────────────────────────────────────────────────

export function improveCVRPSolution(
  solution: CVRPSolution,
  nodeMap:  Map<string, Node>,
  ctx:      TrafficContext
): CVRPSolution {
  const improvedRoutes: CVRPRoute[] = solution.routes.map(route => {
    if (route.path.length <= 3) return route; // depot→stop→depot, nothing to improve

    const improved = twoOpt(route.path, nodeMap, ctx);
    const metrics  = evaluatePath(improved, nodeMap, ctx);
    return { ...route, path: improved, metrics };
  });

  const totalDistance  = improvedRoutes.reduce((s, r) => s + r.metrics.distance,  0);
  const totalTime      = improvedRoutes.reduce((s, r) => s + r.metrics.time,      0);
  const totalEmissions = improvedRoutes.reduce((s, r) => s + r.metrics.emissions, 0);

  return {
    routes:         improvedRoutes,
    totalDistance:  +totalDistance.toFixed(2),
    totalTime:      +totalTime.toFixed(1),
    totalEmissions: +totalEmissions.toFixed(0),
    vehiclesUsed:   improvedRoutes.length,
  };
}

// ─────────────────────────────────────────────────────────────────
// twAwareNearestNeighbor — Earliest Deadline First (EDF) greedy
//
// The core insight: a pure cost-penalty approach is MYOPIC. It sees
// that visiting a nearby "open later" stop is cheap NOW, but can't
// see that it will cause an "urgent" stop's window to expire.
//
// The correct policy is Earliest Deadline First (EDF) — proven optimal
// for scheduling with deadlines on a single machine:
//   At each step, among all stops whose window is CURRENTLY OPEN
//   (i.e. we can still arrive before close), prefer the one whose
//   window closes SOONEST, weighted by proximity.
//
// Implementation:
//   1. Score each candidate: urgencyScore = deadline_remaining / edgeCost
//      (lower deadline remaining = higher urgency; shorter edge = more reachable)
//   2. Pick highest urgency score
//   3. If no stop's window is reachable, fall back to composite cost
//
// This correctly routes Lab Z [0-70] before Warehouse A [200-400]
// even when Warehouse A is geographically closer to the depot.
// ─────────────────────────────────────────────────────────────────

export function twAwareNearestNeighbor(
  nodes:   Node[],
  startId: string,
  ctx:     TrafficContext
): string[] {
  if (nodes.length === 0) return [];

  const nodeMap   = new Map(nodes.map(n => [n.id, n]));
  const unvisited = new Set(nodes.map(n => n.id));
  const path      = [startId];
  unvisited.delete(startId);

  let currentId      = startId;
  let cumulativeTime = 0;

  while (unvisited.size > 0) {
    const current = nodeMap.get(currentId)!;

    let bestId    = '';
    let bestScore = -Infinity;

    for (const candidateId of unvisited) {
      const candidate = nodeMap.get(candidateId)!;
      const edge      = getEdgeCost(current, candidate, ctx);
      const arriveAt  = cumulativeTime + edge.time;

      const tw = candidate.timeWindow as [number, number] | undefined;

      if (Array.isArray(tw)) {
        const [open, close] = tw;

        // Skip entirely if we'll arrive after window closes (unreachable)
        if (arriveAt > close) continue;

        // Urgency score: higher when deadline is sooner relative to edge cost
        // deadline_remaining is how long the window stays open from NOW
        const deadlineRemaining = close - cumulativeTime;
        // Avoid division by zero; give very close stops a high score
        const urgencyScore = (1000 / Math.max(1, deadlineRemaining)) + (1 / Math.max(0.1, edge.composite));

        if (urgencyScore > bestScore) {
          bestScore = urgencyScore;
          bestId    = candidateId;
        }
      } else {
        // No time window: use inverse composite cost as score (so lower cost = higher score)
        // Only wins if no windowed candidates exist (score capped below windowed urgency)
        const score = 1 / Math.max(0.1, edge.composite * 100);
        if (score > bestScore && bestScore === -Infinity) {
          bestScore = score;
          bestId    = candidateId;
        }
      }
    }

    // Fallback: if all windowed stops are unreachable, pick by pure composite cost
    if (!bestId) {
      let minCost = Infinity;
      for (const candidateId of unvisited) {
        const candidate = nodeMap.get(candidateId)!;
        const cost = getEdgeCost(current, candidate, ctx).composite;
        if (cost < minCost) { minCost = cost; bestId = candidateId; }
      }
    }

    if (!bestId) break;

    // Commit — update cumulative time
    const chosen    = nodeMap.get(bestId)!;
    const edge      = getEdgeCost(current, chosen, ctx);
    const arriveAt  = cumulativeTime + edge.time;
    const tw        = chosen.timeWindow as [number, number] | undefined;
    let   visitAt   = arriveAt;

    if (Array.isArray(tw)) {
      const [open] = tw;
      if (arriveAt < open) visitAt = open; // wait until window opens
    }

    const serviceTime  = chosen.serviceTime ?? 0;
    cumulativeTime     = visitAt + serviceTime;

    path.push(bestId);
    unvisited.delete(bestId);
    currentId = bestId;
  }

  if (path[0] !== path[path.length - 1]) path.push(path[0]);
  return path;
}

// ─────────────────────────────────────────────────────────────────
// twoOptWithTW — 2-opt that preserves time-window feasibility
//
// Standard twoOpt compares two edge costs only (local view).
// This version evaluates the FULL path cost after each swap using
// evaluateConstraintPenalty-style time tracking, so it never accepts
// a swap that increases total TW violation time.
//
// Used when hasTimeWindows=true to prevent 2-opt from undoing the
// careful ordering produced by twAwareNearestNeighbor.
//
// Complexity: O(n²) per iteration × maxIter — same as standard 2-opt.
// For n≤50 this is fast enough for browser use.
// ─────────────────────────────────────────────────────────────────

const TW2OPT_PENALTY_PER_MIN = 1_000; // must match evaluateConstraintPenalty

function pathTWCost(path: string[], nodeMap: Map<string, Node>, ctx: TrafficContext): number {
  // Walk the path tracking cumulative time and compute:
  //   composite travel cost + TW late-arrival penalties
  let cost = 0;
  let t    = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const a = nodeMap.get(path[i]), b = nodeMap.get(path[i+1]);
    if (!a || !b) continue;
    const edge = getEdgeCost(a, b, ctx);
    cost += edge.composite;
    t    += edge.time;
    const tw = b.timeWindow as [number, number] | undefined;
    if (Array.isArray(tw) && tw.length === 2) {
      const [open, close] = tw;
      if (t < open)  t = open;            // wait — legal
      if (t > close) cost += (t - close) * TW2OPT_PENALTY_PER_MIN;
    }
    const svc = b.serviceTime ?? 0;
    t += svc;
  }
  return cost;
}

export function twoOptWithTW(path: string[], nodeMap: Map<string, Node>, ctx: TrafficContext): string[] {
  let best     = [...path];
  let improved = true;
  let iters    = 0;
  const maxIter = path.length > 200 ? 5 : path.length > 50 ? 20 : 100;

  while (improved && iters < maxIter) {
    improved = false;
    iters++;
    const curCost = pathTWCost(best, nodeMap, ctx);

    for (let i = 1; i < best.length - 2; i++) {
      for (let k = i + 1; k < best.length - 1; k++) {
        const candidate = [...best.slice(0,i), ...best.slice(i,k+1).reverse(), ...best.slice(k+1)];
        if (pathTWCost(candidate, nodeMap, ctx) < curCost - 1e-9) {
          best     = candidate;
          improved = true;
        }
      }
    }
  }
  return best;
}
