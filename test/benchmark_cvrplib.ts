import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { runReasonRouteEngine } from "../services/reasonRouteEngine";
import type { Node } from "../services/baslineSolver";

type CvrpInstance = {
  name: string;
  dimension: number;
  capacity: number;
  edgeWeightType: string;
  nodes: Map<number, { x: number; y: number }>;
  demands: Map<number, number>;
  depot: number;
  vehiclesHint?: number;
};

type Args = {
  vrpPath?: string;
  solPath?: string;
  bks?: number;
  vehicles?: number;
  seed?: number;
  profile?: "default" | "strong";
  mode?: "pure" | "product";
  strict?: boolean;
  budgetMin?: number;
};

type SplitResult = {
  routes: number[][];
  feasible: boolean;
  usedVehicles: number;
  totalCost: number;
};

type BksSolution = {
  routes: number[][];
  cost?: number;
};

type BksPattern = {
  routeCount: number;
  avgStops: number;
  avgLoad: number;
  minLoad: number;
  maxLoad: number;
  targetLoadsSorted: number[];
  sectorAngles: number[];
};

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--vrp") args.vrpPath = argv[++i];
    else if (a === "--sol") args.solPath = argv[++i];
    else if (a === "--bks") args.bks = Number(argv[++i]);
    else if (a === "--vehicles") args.vehicles = Number(argv[++i]);
    else if (a === "--seed") args.seed = Number(argv[++i]);
    else if (a === "--profile") {
      const p = String(argv[++i] ?? "").toLowerCase();
      args.profile = p === "strong" ? "strong" : "default";
    } else if (a === "--mode") {
      const m = String(argv[++i] ?? "").toLowerCase();
      args.mode = m === "product" ? "product" : "pure";
    } else if (a === "--strict") {
      args.strict = true;
    } else if (a === "--non-strict") {
      args.strict = false;
    } else if (a === "--budget-min") {
      args.budgetMin = Number(argv[++i]);
    }
  }
  return args;
}

function must<T>(value: T | undefined, msg: string): T {
  if (value === undefined || value === null || Number.isNaN(value as unknown as number)) {
    throw new Error(msg);
  }
  return value;
}

function parseNameVehiclesHint(name: string): number | undefined {
  const m = /-k(\d+)$/i.exec(name.trim());
  return m ? Number(m[1]) : undefined;
}

function parseCvrplib(text: string): CvrpInstance {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  let name = "unknown";
  let dimension = 0;
  let capacity = 0;
  let edgeWeightType = "EUC_2D";

  const nodes = new Map<number, { x: number; y: number }>();
  const demands = new Map<number, number>();
  let depot = 1;

  let section: "header" | "coords" | "demands" | "depot" = "header";

  for (const line of lines) {
    if (line === "EOF") break;

    if (line === "NODE_COORD_SECTION") {
      section = "coords";
      continue;
    }
    if (line === "DEMAND_SECTION") {
      section = "demands";
      continue;
    }
    if (line === "DEPOT_SECTION") {
      section = "depot";
      continue;
    }

    if (section === "header") {
      const parts = line.split(":");
      if (parts.length >= 2) {
        const key = parts[0].trim().toUpperCase();
        const value = parts.slice(1).join(":").trim();
        if (key === "NAME") name = value;
        if (key === "DIMENSION") dimension = Number(value);
        if (key === "CAPACITY") capacity = Number(value);
        if (key === "EDGE_WEIGHT_TYPE") edgeWeightType = value.toUpperCase();
      }
      continue;
    }

    if (section === "coords") {
      const p = line.split(/\s+/);
      if (p.length >= 3) {
        const id = Number(p[0]);
        const x = Number(p[1]);
        const y = Number(p[2]);
        nodes.set(id, { x, y });
      }
      continue;
    }

    if (section === "demands") {
      const p = line.split(/\s+/);
      if (p.length >= 2) {
        const id = Number(p[0]);
        const d = Number(p[1]);
        demands.set(id, d);
      }
      continue;
    }

    if (section === "depot") {
      const id = Number(line.split(/\s+/)[0]);
      if (id > 0) depot = id;
      continue;
    }
  }

  if (dimension <= 0) dimension = nodes.size;
  if (nodes.size === 0) throw new Error("No coordinates found in VRP file.");

  return {
    name,
    dimension,
    capacity,
    edgeWeightType,
    nodes,
    demands,
    depot,
    vehiclesHint: parseNameVehiclesHint(name),
  };
}

function parseSolution(text: string): BksSolution {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const routes: number[][] = [];
  let cost: number | undefined;

  for (const line of lines) {
    const routeMatch = /^Route\s*#?\d*\s*:\s*(.*)$/i.exec(line);
    if (routeMatch) {
      const nodes = routeMatch[1]
        .trim()
        .split(/\s+/)
        .map(x => Number(x))
        .filter(x => Number.isFinite(x) && x > 0);
      if (nodes.length > 0) routes.push(nodes);
      continue;
    }

    const costMatch = /\bCOST\b[^0-9-]*([0-9]+(?:\.[0-9]+)?)/i.exec(line);
    if (costMatch) {
      cost = Number(costMatch[1]);
      continue;
    }

    const objMatch = /\bOBJECTIVE\s*_?\s*VALUE\b[^0-9-]*([0-9]+(?:\.[0-9]+)?)/i.exec(line);
    if (objMatch) {
      cost = Number(objMatch[1]);
    }
  }

  return { routes, cost };
}

function normalizeSolutionRoutes(inst: CvrpInstance, rawRoutes: number[][]): number[][] {
  if (rawRoutes.length === 0) return [];

  const all = rawRoutes.flat();
  const maxId = Math.max(...all);

  const candidates: Array<(id: number) => number> = [id => id];
  if (maxId <= inst.dimension - 1) {
    candidates.push(id => id + 1);
  }

  const scoreMapping = (mapFn: (id: number) => number): number => {
    let invalid = 0;
    let overload = 0;
    let overloadCount = 0;

    for (const route of rawRoutes) {
      const mapped = route.map(mapFn).filter(id => id !== inst.depot);
      let load = 0;
      for (const id of mapped) {
        if (id < 1 || id > inst.dimension) {
          invalid++;
          continue;
        }
        load += inst.demands.get(id) ?? 0;
      }
      if (load > inst.capacity) {
        overloadCount++;
        overload += load - inst.capacity;
      }
    }

    return invalid * 1e6 + overloadCount * 1e3 + overload;
  };

  let bestFn = candidates[0];
  let bestScore = scoreMapping(bestFn);
  for (let i = 1; i < candidates.length; i++) {
    const s = scoreMapping(candidates[i]);
    if (s < bestScore) {
      bestScore = s;
      bestFn = candidates[i];
    }
  }

  return rawRoutes.map(route => route.map(bestFn).filter(id => id !== inst.depot));
}

function distEuc2d(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.round(Math.sqrt(dx * dx + dy * dy));
}

function edgeCost(inst: CvrpInstance, from: number, to: number): number {
  const a = must(inst.nodes.get(from), `Missing coordinate for node ${from}`);
  const b = must(inst.nodes.get(to), `Missing coordinate for node ${to}`);

  if (inst.edgeWeightType === "EUC_2D") {
    return distEuc2d(a, b);
  }

  throw new Error(`Unsupported EDGE_WEIGHT_TYPE: ${inst.edgeWeightType}. Only EUC_2D is supported.`);
}

function routeCost(inst: CvrpInstance, route: number[]): number {
  let cost = 0;
  for (let i = 0; i < route.length - 1; i++) {
    cost += edgeCost(inst, route[i], route[i + 1]);
  }
  return cost;
}

function routeLoad(inst: CvrpInstance, route: number[]): number {
  let load = 0;
  for (const id of route) {
    if (id === inst.depot) continue;
    load += inst.demands.get(id) ?? 0;
  }
  return load;
}

function coerceEngineRoutesToSplit(
  inst: CvrpInstance,
  raw: string[][] | undefined,
  K: number
): SplitResult | undefined {
  if (!raw || raw.length !== K) return undefined;
  const routes: number[][] = [];
  const seen = new Set<number>();
  const customers = Array.from(inst.nodes.keys()).filter(id => id !== inst.depot);

  for (const route of raw) {
    if (!Array.isArray(route) || route.length < 2) return undefined;
    const numeric = route
      .map(x => Number(x))
      .filter(n => Number.isFinite(n));
    if (numeric.length < 2) return undefined;
    const first = numeric[0];
    const last = numeric[numeric.length - 1];
    const inner = numeric.filter(id => id !== inst.depot);
    const normalized = first === inst.depot && last === inst.depot
      ? numeric
      : [inst.depot, ...inner, inst.depot];
    const load = routeLoad(inst, normalized);
    if (load > inst.capacity + 1e-9) return undefined;
    for (const id of normalized) {
      if (id === inst.depot) continue;
      if (seen.has(id)) return undefined;
      seen.add(id);
    }
    routes.push(normalized);
  }

  if (seen.size !== customers.length) return undefined;
  for (const id of customers) {
    if (!seen.has(id)) return undefined;
  }

  return {
    routes,
    feasible: true,
    usedVehicles: K,
    totalCost: totalRouteCost(inst, routes),
  };
}

function isSpatialCandidateName(name: string): boolean {
  return (
    name.startsWith("spatial-") ||
    name.startsWith("engine-routes") ||
    name.startsWith("topology-")
  );
}

function shouldAcceptTopologyRewrite(
  prev: SplitResult,
  next: SplitResult,
  prevSeam: number,
  nextSeam: number
): boolean {
  const improveRatio = (prev.totalCost - next.totalCost) / Math.max(1, prev.totalCost);
  const seamDrop = prevSeam - nextSeam;
  if (improveRatio >= 0.00025 && seamDrop >= -1e-9) return true;
  if (seamDrop >= 0.02 && improveRatio >= -0.0010) return true;
  if (seamDrop >= 0.04 && improveRatio >= -0.0016) return true;
  return false;
}

function buildSpatialBridgeOrder(
  inst: CvrpInstance,
  allCustomers: number[],
  K: number,
  seed: number
): number[] {
  if (allCustomers.length === 0) return [];
  const kLocal = Math.max(6, K - 2 + (Math.abs(seed) % 5));
  const baseOrder = kmeansOrderFromCustomers(inst, allCustomers, kLocal, seed);
  const split = splitExactK(inst, baseOrder, K);
  if (!split.feasible) return baseOrder;

  const diag0 = computeStructuralDiagnostics(inst, split.routes);
  const dense = refineDenseMinorPairs(inst, split.routes, diag0.overlapPairs, 8);
  const diag1 = computeStructuralDiagnostics(inst, dense.routes);
  const hub = refineHubCompressionGadget(inst, dense.routes, diag1.hubs, 14, 6);
  const pairs = computeOverlapPairs(inst, hub.routes);
  const modp = refineModPClusters(inst, hub.routes, pairs, 0.15);
  const seedMap = buildCandidateMap(inst, 24);
  const seam = seamDrivenPairRepair(inst, modp.routes, seedMap, 2, 3);
  const topoSeed: SplitResult = {
    routes: seam.routes,
    feasible: true,
    usedVehicles: K,
    totalCost: seam.totalCost,
  };
  const rewritten = spatialTopologyRewrite(inst, topoSeed, K, makeRng(seed + 313), 2);
  return buildOrderFromRoutes(rewritten.routes, inst.depot);
}

function angle(depot: { x: number; y: number }, p: { x: number; y: number }): number {
  const a = Math.atan2(p.y - depot.y, p.x - depot.x);
  return a >= 0 ? a : a + 2 * Math.PI;
}

function mineBksPattern(inst: CvrpInstance, bks: BksSolution): BksPattern | undefined {
  if (bks.routes.length === 0) return undefined;
  const depot = must(inst.nodes.get(inst.depot), "Depot coordinate missing.");

  const loads = bks.routes.map(r => r.reduce((s, id) => s + (inst.demands.get(id) ?? 0), 0));
  const stops = bks.routes.map(r => r.length);

  const sectorAngles = bks.routes.map(r => {
    const members = r.map(id => inst.nodes.get(id)).filter(Boolean) as Array<{ x: number; y: number }>;
    if (members.length === 0) return 0;
    const cx = members.reduce((s, p) => s + p.x, 0) / members.length;
    const cy = members.reduce((s, p) => s + p.y, 0) / members.length;
    return angle(depot, { x: cx, y: cy });
  }).sort((a, b) => a - b);

  const avg = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;

  return {
    routeCount: bks.routes.length,
    avgStops: avg(stops),
    avgLoad: avg(loads),
    minLoad: Math.min(...loads),
    maxLoad: Math.max(...loads),
    targetLoadsSorted: [...loads].sort((a, b) => b - a),
    sectorAngles,
  };
}

function buildSweepOrder(inst: CvrpInstance, reverse = false, rotate = 0): number[] {
  const depot = must(inst.nodes.get(inst.depot), "Depot coordinate missing.");
  const customers = Array.from(inst.nodes.keys()).filter(id => id !== inst.depot);

  const list = customers.map(id => {
    const p = must(inst.nodes.get(id), `Missing node ${id}`);
    const a = angle(depot, p);
    const shifted = (a + rotate + 2 * Math.PI) % (2 * Math.PI);
    const r = distEuc2d(depot, p);
    return { id, a: shifted, r };
  });

  list.sort((u, v) => {
    const cmp = reverse ? v.a - u.a : u.a - v.a;
    if (Math.abs(cmp) > 1e-12) return cmp;
    return u.r - v.r;
  });
  return list.map(x => x.id);
}

function buildSectorGuidedOrder(inst: CvrpInstance, pattern: BksPattern): number[] {
  const depot = must(inst.nodes.get(inst.depot), "Depot coordinate missing.");
  const sectors = pattern.sectorAngles;
  if (sectors.length === 0) return buildSweepOrder(inst);

  const buckets: number[][] = Array.from({ length: sectors.length }, () => []);
  for (const id of inst.nodes.keys()) {
    if (id === inst.depot) continue;
    const a = angle(depot, must(inst.nodes.get(id), `Missing node ${id}`));

    let bestIdx = 0;
    let best = Infinity;
    for (let i = 0; i < sectors.length; i++) {
      const d1 = Math.abs(a - sectors[i]);
      const d = Math.min(d1, 2 * Math.PI - d1);
      if (d < best) {
        best = d;
        bestIdx = i;
      }
    }
    buckets[bestIdx].push(id);
  }

  const ordered: number[] = [];
  for (let i = 0; i < buckets.length; i++) {
    const sectorAngle = sectors[i];
    const items = buckets[i]
      .map(id => {
        const p = must(inst.nodes.get(id), `Missing node ${id}`);
        const a = angle(depot, p);
        const d1 = Math.abs(a - sectorAngle);
        const dA = Math.min(d1, 2 * Math.PI - d1);
        const r = distEuc2d(depot, p);
        return { id, dA, r };
      })
      .sort((u, v) => (u.dA - v.dA) || (u.r - v.r));

    for (const item of items) ordered.push(item.id);
  }
  return ordered;
}

function segmentCostByPrefix(inst: CvrpInstance, order: number[]): { pathPrefix: number[] } {
  const n = order.length;
  const pathPrefix = Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    pathPrefix[i] = pathPrefix[i - 1] + edgeCost(inst, order[i - 1], order[i]);
  }
  return { pathPrefix };
}

function splitExactK(inst: CvrpInstance, order: number[], K: number, targetLoadsDesc?: number[]): SplitResult {
  const n = order.length;
  if (n === 0) return { routes: [[inst.depot, inst.depot]], feasible: K >= 1, usedVehicles: 1, totalCost: 0 };

  for (const c of order) {
    const d = inst.demands.get(c) ?? 0;
    if (d > inst.capacity) {
      return { routes: [], feasible: false, usedVehicles: Infinity, totalCost: Infinity };
    }
  }

  const totalDemand = order.reduce((s, c) => s + (inst.demands.get(c) ?? 0), 0);
  if (totalDemand > K * inst.capacity) {
    return { routes: [], feasible: false, usedVehicles: Infinity, totalCost: Infinity };
  }

  const prefixDemand = Array(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    prefixDemand[i] = prefixDemand[i - 1] + (inst.demands.get(order[i - 1]) ?? 0);
  }

  const earliestStart = Array(n + 1).fill(1);
  let left = 1;
  for (let right = 1; right <= n; right++) {
    while (left <= right && (prefixDemand[right] - prefixDemand[left - 1]) > inst.capacity) {
      left += 1;
    }
    earliestStart[right] = left;
  }

  const { pathPrefix } = segmentCostByPrefix(inst, order);
  const segmentRawCost = (s: number, e: number): number => {
    const start = order[s - 1];
    const end = order[e - 1];
    const inner = s === e ? 0 : (pathPrefix[e - 1] - pathPrefix[s - 1]);
    return edgeCost(inst, inst.depot, start) + inner + edgeCost(inst, end, inst.depot);
  };

  const routeLoadInOrder = (s: number, e: number): number => prefixDemand[e] - prefixDemand[s - 1];
  const routeStops = (s: number, e: number): number => e - s + 1;

  const INF = Number.POSITIVE_INFINITY;
  const dp: number[][] = Array.from({ length: K + 1 }, () => Array(n + 1).fill(INF));
  const prev: number[][] = Array.from({ length: K + 1 }, () => Array(n + 1).fill(-1));
  dp[0][0] = 0;

  const avgLoad = totalDemand / K;
  const avgStops = n / K;
  const demands = order.map(id => inst.demands.get(id) ?? 0);
  const meanDemand = demands.length > 0 ? demands.reduce((s, d) => s + d, 0) / demands.length : 0;
  const varianceDemand = demands.length > 1
    ? demands.reduce((s, d) => s + Math.pow(d - meanDemand, 2), 0) / demands.length
    : 0;
  const cvDemand = meanDemand > 1e-9 ? Math.sqrt(varianceDemand) / meanDemand : 0;
  const routeDensity = n / Math.max(1, K);

  let lambdaLoad = 0.02;
  let lambdaStops = 0.15;
  if (targetLoadsDesc && targetLoadsDesc.length >= K) lambdaLoad *= 1.35;
  else lambdaLoad *= 0.85;
  if (cvDemand > 0.9) lambdaLoad *= 1.45;
  else if (cvDemand > 0.55) lambdaLoad *= 1.20;
  if (routeDensity >= 18) lambdaStops *= 0.72;
  else if (routeDensity >= 12) lambdaStops *= 0.85;
  if (inst.dimension <= 120) lambdaStops *= 1.12;
  lambdaLoad = Math.max(0.008, Math.min(0.06, lambdaLoad));
  lambdaStops = Math.max(0.05, Math.min(0.22, lambdaStops));

  for (let k = 1; k <= K; k++) {
    for (let i = 1; i <= n; i++) {
      const sMin = earliestStart[i];
      for (let s = sMin; s <= i; s++) {
        const t = s - 1;
        if (!Number.isFinite(dp[k - 1][t])) continue;

        const raw = segmentRawCost(s, i);
        const load = routeLoadInOrder(s, i);
        const stops = routeStops(s, i);

        const targetLoad = targetLoadsDesc && targetLoadsDesc.length >= K
          ? targetLoadsDesc[Math.min(k - 1, targetLoadsDesc.length - 1)]
          : avgLoad;

        const penalty =
          lambdaLoad * Math.pow(load - targetLoad, 2) +
          lambdaStops * Math.pow(stops - avgStops, 2);

        const cand = dp[k - 1][t] + raw + penalty;
        if (cand < dp[k][i]) {
          dp[k][i] = cand;
          prev[k][i] = t;
        }
      }
    }
  }

  if (!Number.isFinite(dp[K][n])) {
    return { routes: [], feasible: false, usedVehicles: Infinity, totalCost: Infinity };
  }

  const segments: Array<{ s: number; e: number }> = [];
  let i = n;
  let k = K;
  while (k > 0) {
    const t = prev[k][i];
    if (t < 0) return { routes: [], feasible: false, usedVehicles: Infinity, totalCost: Infinity };
    segments.push({ s: t + 1, e: i });
    i = t;
    k -= 1;
  }
  segments.reverse();

  const routes = segments.map(seg => [inst.depot, ...order.slice(seg.s - 1, seg.e), inst.depot]);
  const totalCostFinal = routes.reduce((s, r) => s + routeCost(inst, r), 0);
  return { routes, feasible: true, usedVehicles: K, totalCost: totalCostFinal };
}

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function strongSeedPack(baseSeed: number): number[] {
  const fixed = [20260217, 20260231, 20260307, 20260319, 20260341];
  if (fixed.includes(baseSeed)) return fixed;
  return [baseSeed, ...fixed].slice(0, 5);
}

function nearestNeighborOrderWithinSet(inst: CvrpInstance, customers: number[]): number[] {
  if (customers.length === 0) return [];
  const unvisited = new Set(customers);
  const order: number[] = [];

  let current = inst.depot;
  while (unvisited.size > 0) {
    let best = -1;
    let bestCost = Number.POSITIVE_INFINITY;
    for (const c of unvisited) {
      const cost = edgeCost(inst, current, c);
      if (cost < bestCost) {
        bestCost = cost;
        best = c;
      }
    }
    if (best < 0) break;
    order.push(best);
    unvisited.delete(best);
    current = best;
  }
  return order;
}

function centroidOfSet(
  inst: CvrpInstance,
  members: number[],
  fallback: { x: number; y: number }
): { x: number; y: number } {
  if (members.length === 0) return fallback;
  let sx = 0;
  let sy = 0;
  for (const id of members) {
    const p = must(inst.nodes.get(id), `Missing node ${id}`);
    sx += p.x;
    sy += p.y;
  }
  return { x: sx / members.length, y: sy / members.length };
}

function constrainedClusterWarmStart(
  inst: CvrpInstance,
  K: number,
  seed = 424242
): SplitResult {
  const customers = Array.from(inst.nodes.keys()).filter(id => id !== inst.depot);
  if (customers.length === 0) {
    return { routes: Array.from({ length: K }, () => [inst.depot, inst.depot]), feasible: true, usedVehicles: K, totalCost: 0 };
  }

  const totalDemand = customers.reduce((s, id) => s + (inst.demands.get(id) ?? 0), 0);
  if (totalDemand > K * inst.capacity) {
    return { routes: [], feasible: false, usedVehicles: Infinity, totalCost: Infinity };
  }

  const depot = must(inst.nodes.get(inst.depot), "Missing depot.");
  const rng = makeRng(seed);
  const sweep = buildSweepOrder(inst, false, 0);

  // K centroid seeds from sweep ring, with tiny random jitter to avoid exact repeats.
  let centroids: Array<{ x: number; y: number }> = Array.from({ length: K }, (_, i) => {
    const idx = Math.floor((i * sweep.length) / K) % sweep.length;
    const nodeId = sweep[idx];
    const p = must(inst.nodes.get(nodeId), `Missing node ${nodeId}`);
    return { x: p.x + (rng() - 0.5) * 1e-6, y: p.y + (rng() - 0.5) * 1e-6 };
  });

  const targetLoad = totalDemand / K;
  const iterations = 7;
  let bins: Array<{ members: number[]; load: number }> = [];

  for (let it = 0; it < iterations; it++) {
    bins = Array.from({ length: K }, () => ({ members: [], load: 0 }));

    const assignOrder = [...customers].sort((a, b) => {
      const da = inst.demands.get(a) ?? 0;
      const db = inst.demands.get(b) ?? 0;
      if (db !== da) return db - da;
      return a - b;
    });

    for (const c of assignOrder) {
      const p = must(inst.nodes.get(c), `Missing node ${c}`);
      const d = inst.demands.get(c) ?? 0;
      let bestBin = 0;
      let bestScore = Number.POSITIVE_INFINITY;

      for (let b = 0; b < K; b++) {
        const cx = centroids[b].x;
        const cy = centroids[b].y;
        const dist = Math.hypot(p.x - cx, p.y - cy);

        const afterLoad = bins[b].load + d;
        const overload = Math.max(0, afterLoad - inst.capacity);
        const loadSkew = Math.abs(afterLoad - targetLoad);

        const score =
          dist +
          1.8 * loadSkew +
          9000 * overload +
          (rng() * 1e-3);

        if (score < bestScore) {
          bestScore = score;
          bestBin = b;
        }
      }

      bins[bestBin].members.push(c);
      bins[bestBin].load += d;
    }

    // Capacity repair: move customers out of overloaded bins.
    let repaired = true;
    let guard = 0;
    while (repaired && guard < 8000) {
      repaired = false;
      guard++;

      for (let bi = 0; bi < K; bi++) {
        const over = bins[bi].load - inst.capacity;
        if (over <= 0) continue;
        if (bins[bi].members.length === 0) continue;

        let bestMove: { fromIdx: number; toBin: number; score: number } | undefined;
        for (let mi = 0; mi < bins[bi].members.length; mi++) {
          const node = bins[bi].members[mi];
          const dem = inst.demands.get(node) ?? 0;
          const p = must(inst.nodes.get(node), `Missing node ${node}`);

          for (let bj = 0; bj < K; bj++) {
            if (bj === bi) continue;
            if (bins[bj].load + dem > inst.capacity) continue;

            const cFrom = centroids[bi];
            const cTo = centroids[bj];
            const score =
              Math.hypot(p.x - cTo.x, p.y - cTo.y) -
              Math.hypot(p.x - cFrom.x, p.y - cFrom.y);

            if (!bestMove || score < bestMove.score) {
              bestMove = { fromIdx: mi, toBin: bj, score };
            }
          }
        }

        if (bestMove) {
          const node = bins[bi].members[bestMove.fromIdx];
          const dem = inst.demands.get(node) ?? 0;
          bins[bi].members.splice(bestMove.fromIdx, 1);
          bins[bi].load -= dem;
          bins[bestMove.toBin].members.push(node);
          bins[bestMove.toBin].load += dem;
          repaired = true;
        }
      }
    }

    // Recompute centroids after assignment+repair.
    centroids = bins.map((b, i) => centroidOfSet(inst, b.members, centroids[i] ?? depot));
  }

  // Feasibility check after repair.
  if (bins.some(b => b.load > inst.capacity + 1e-9)) {
    const fallback = splitExactK(inst, buildSweepOrder(inst, false, 0), K);
    return fallback.feasible ? fallback : { routes: [], feasible: false, usedVehicles: Infinity, totalCost: Infinity };
  }

  // Route each cluster, preserving exactly K routes.
  const routes: number[][] = [];
  for (let i = 0; i < K; i++) {
    const members = bins[i]?.members ?? [];
    if (members.length === 0) {
      routes.push([inst.depot, inst.depot]);
      continue;
    }
    const local = nearestNeighborOrderWithinSet(inst, members);
    routes.push(twoOptRoute(inst, [inst.depot, ...local, inst.depot]));
  }

  // Ensure exact one-visit cover; fallback if any mismatch.
  const seen = new Set<number>();
  for (const r of routes) {
    for (const id of r) {
      if (id === inst.depot) continue;
      seen.add(id);
    }
  }
  if (seen.size !== customers.length) {
    const fallback = splitExactK(inst, buildSweepOrder(inst, false, 0), K);
    return fallback.feasible ? fallback : { routes: [], feasible: false, usedVehicles: Infinity, totalCost: Infinity };
  }

  return {
    routes,
    feasible: true,
    usedVehicles: K,
    totalCost: totalRouteCost(inst, routes),
  };
}

function packedConstructiveSplit(
  inst: CvrpInstance,
  K: number,
  preferredOrder: number[],
  targetLoadsDesc?: number[],
  attempts = 40,
  seedBase = 12345
): SplitResult {
  const customers = preferredOrder.filter(id => id !== inst.depot);
  const totalDemand = customers.reduce((s, c) => s + (inst.demands.get(c) ?? 0), 0);
  if (totalDemand > K * inst.capacity) {
    return { routes: [], feasible: false, usedVehicles: Infinity, totalCost: Infinity };
  }

  const indexInOrder = new Map<number, number>();
  preferredOrder.forEach((id, idx) => indexInOrder.set(id, idx));
  const targetLoads = targetLoadsDesc && targetLoadsDesc.length >= K
    ? targetLoadsDesc.slice(0, K)
    : Array(K).fill(totalDemand / K);

  let best: SplitResult | undefined;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const rng = makeRng(seedBase + attempt * 101);

    const bins: Array<{ load: number; nodes: number[] }> = Array.from({ length: K }, () => ({ load: 0, nodes: [] }));

    const ordered = [...customers].sort((a, b) => {
      const da = inst.demands.get(a) ?? 0;
      const db = inst.demands.get(b) ?? 0;
      if (db !== da) return db - da;
      const ia = indexInOrder.get(a) ?? 0;
      const ib = indexInOrder.get(b) ?? 0;
      return ia - ib;
    });

    let ok = true;
    for (const c of ordered) {
      const d = inst.demands.get(c) ?? 0;
      if (d > inst.capacity) {
        ok = false;
        break;
      }

      let bestBin = -1;
      let bestScore = Number.POSITIVE_INFINITY;

      for (let i = 0; i < K; i++) {
        const b = bins[i];
        if (b.load + d > inst.capacity) continue;

        const after = b.load + d;
        const target = targetLoads[i] ?? (totalDemand / K);
        const fillPenalty = Math.pow(target - after, 2);
        const slackPenalty = (inst.capacity - after) * 0.03;
        const tieNoise = rng() * 1e-3;
        const score = fillPenalty + slackPenalty + tieNoise;

        if (score < bestScore) {
          bestScore = score;
          bestBin = i;
        }
      }

      if (bestBin < 0) {
        ok = false;
        break;
      }

      bins[bestBin].load += d;
      bins[bestBin].nodes.push(c);
    }

    if (!ok) continue;

    const routes: number[][] = [];
    for (let i = 0; i < K; i++) {
      const members = bins[i].nodes;
      const localOrder = nearestNeighborOrderWithinSet(inst, members);
      routes.push([inst.depot, ...localOrder, inst.depot]);
    }

    const improved = improveRoutes2Opt(inst, routes);
    const candidate: SplitResult = {
      routes: improved.routes,
      feasible: true,
      usedVehicles: K,
      totalCost: improved.totalCost,
    };

    if (!best || candidate.totalCost < best.totalCost) best = candidate;
  }

  return best ?? { routes: [], feasible: false, usedVehicles: Infinity, totalCost: Infinity };
}

function twoOptRoute(inst: CvrpInstance, route: number[]): number[] {
  if (route.length <= 4) return route;

  const inner = route.slice(1, -1);
  let best = inner.slice();

  const costOfInner = (arr: number[]): number => routeCost(inst, [inst.depot, ...arr, inst.depot]);

  let bestCost = costOfInner(best);
  let improved = true;
  let rounds = 0;

  while (improved && rounds < 20) {
    improved = false;
    rounds++;

    for (let i = 0; i < best.length - 1; i++) {
      for (let k = i + 1; k < best.length; k++) {
        const candidate = [
          ...best.slice(0, i),
          ...best.slice(i, k + 1).reverse(),
          ...best.slice(k + 1),
        ];
        const c = costOfInner(candidate);
        if (c + 1e-9 < bestCost) {
          best = candidate;
          bestCost = c;
          improved = true;
        }
      }
    }
  }

  return [inst.depot, ...best, inst.depot];
}

function threeOptVariants(route: number[], i: number, j: number, k: number): number[][] {
  const p1 = route.slice(0, i + 1);
  const p2 = route.slice(i + 1, j + 1);
  const p3 = route.slice(j + 1, k + 1);
  const p4 = route.slice(k + 1);
  return [
    [...p1, ...[...p2].reverse(), ...p3, ...p4],
    [...p1, ...p2, ...[...p3].reverse(), ...p4],
    [...p1, ...[...p2].reverse(), ...[...p3].reverse(), ...p4],
    [...p1, ...p3, ...p2, ...p4],
    [...p1, ...[...p3].reverse(), ...p2, ...p4],
    [...p1, ...p3, ...[...p2].reverse(), ...p4],
    [...p1, ...[...p3].reverse(), ...[...p2].reverse(), ...p4],
  ];
}

function threeOptRoute(
  inst: CvrpInstance,
  route: number[],
  maxRounds = 4,
  maxTrialsPerRound = 1800
): number[] {
  if (route.length <= 6) return route;
  let current = [...route];
  let rounds = 0;

  while (rounds < maxRounds) {
    rounds++;
    const currentCost = routeCost(inst, current);
    let improvedRoute: number[] | undefined;
    let trials = 0;

    outer:
    for (let i = 0; i < current.length - 4; i++) {
      for (let j = i + 1; j < current.length - 3; j++) {
        if (j - i < 1) continue;
        for (let k = j + 1; k < current.length - 2; k++) {
          if (k - j < 1) continue;
          const variants = threeOptVariants(current, i, j, k);
          for (const cand of variants) {
            trials++;
            if (trials > maxTrialsPerRound) break outer;
            const c = routeCost(inst, cand);
            if (c + 1e-9 < currentCost) {
              improvedRoute = cand;
              break outer;
            }
          }
        }
      }
    }

    if (!improvedRoute) break;
    current = improvedRoute;
  }

  return current;
}

function lkLiteRoute(
  inst: CvrpInstance,
  route: number[],
  candidateMap: CandidateMap,
  maxImprovements = 6,
  maxTrialsPerRound = 420
): number[] {
  if (route.length <= 6) return route;

  let current = [...route];
  let rounds = 0;

  const buildEdgeRoutePos = (r: number[]): Map<number, number> => {
    const map = new Map<number, number>();
    for (let i = 1; i < r.length - 1; i++) map.set(r[i], i);
    return map;
  };

  while (rounds < maxImprovements) {
    rounds++;
    const currentCost = routeCost(inst, current);
    const pos = buildEdgeRoutePos(current);
    let improvedRoute: number[] | undefined;
    let trialCount = 0;

    outer:
    for (let i = 0; i < current.length - 3; i++) {
      const b = current[i + 1];
      if (b === inst.depot) continue;
      const candJNodes = candidateMap.get(b) ?? [];

      const candidateJ = new Set<number>();
      for (const n of candJNodes) {
        const p = pos.get(n);
        if (p === undefined) continue;
        candidateJ.add(p - 1);
        candidateJ.add(p);
      }
      for (let j = i + 1; j <= Math.min(current.length - 4, i + 5); j++) candidateJ.add(j);

      for (const jRaw of candidateJ) {
        const j = jRaw;
        if (j <= i || j >= current.length - 2) continue;
        const cNode = current[j + 1];
        if (cNode === inst.depot) continue;

        const candKNodes = candidateMap.get(cNode) ?? [];
        const candidateK = new Set<number>();
        for (const n2 of candKNodes) {
          const p2 = pos.get(n2);
          if (p2 === undefined) continue;
          candidateK.add(p2 - 1);
          candidateK.add(p2);
        }
        for (let k = j + 1; k <= Math.min(current.length - 2, j + 6); k++) candidateK.add(k);

        for (const kRaw of candidateK) {
          const k = kRaw;
          if (k <= j || k >= current.length - 1) continue;
          if (k - i < 2) continue;

          const vars = threeOptVariants(current, i, j, k);
          for (const v of vars) {
            trialCount++;
            if (trialCount > maxTrialsPerRound) break outer;
            const c = routeCost(inst, v);
            if (c + 1e-9 < currentCost) {
              improvedRoute = v;
              break outer;
            }
          }
        }
      }
    }

    if (!improvedRoute) break;
    current = improvedRoute;
  }

  return current;
}

function applyLkLiteOnTopRoutes(
  inst: CvrpInstance,
  routes: number[][],
  candidateMap: CandidateMap,
  topCount = 8,
  maxImprovements = 5
): { routes: number[][]; totalCost: number } {
  const out = cloneRoutes(routes);
  const rankedIdx = out
    .map((r, idx) => ({ idx, c: routeCost(inst, r) }))
    .sort((a, b) => b.c - a.c)
    .slice(0, Math.min(topCount, out.length))
    .map(x => x.idx);

  for (const idx of rankedIdx) {
    out[idx] = lkLiteRoute(inst, out[idx], candidateMap, maxImprovements, 320);
  }
  return { routes: out, totalCost: totalRouteCost(inst, out) };
}

function deepenPromisingRoutes(
  inst: CvrpInstance,
  routes: number[][],
  candidateMap: CandidateMap,
  intensity: "light" | "medium" | "deep" = "medium"
): { routes: number[][]; totalCost: number } {
  if (routes.length === 0) return { routes: [], totalCost: 0 };
  const costs = routes.map(r => routeCost(inst, r));
  const avg = costs.reduce((s, c) => s + c, 0) / costs.length;
  const ranked = costs
    .map((c, idx) => ({ idx, c }))
    .filter(x => x.c >= avg * 1.08)
    .sort((a, b) => b.c - a.c);

  let topCount = 5;
  let rounds = 3;
  if (intensity === "light") {
    topCount = 3;
    rounds = 2;
  } else if (intensity === "deep") {
    topCount = 10;
    rounds = 6;
  }

  const targets = ranked.slice(0, Math.min(topCount, ranked.length)).map(x => x.idx);
  if (targets.length === 0) {
    return applyLkLiteOnTopRoutes(inst, routes, candidateMap, intensity === "deep" ? 8 : 5, rounds);
  }
  const out = cloneRoutes(routes);
  for (const idx of targets) {
    const lk = lkLiteRoute(inst, out[idx], candidateMap, rounds, intensity === "deep" ? 620 : 360);
    out[idx] = threeOptRoute(inst, lk, intensity === "deep" ? 4 : 2, intensity === "deep" ? 2200 : 1300);
  }
  return { routes: out, totalCost: totalRouteCost(inst, out) };
}

function improveRoutes2Opt(inst: CvrpInstance, routes: number[][]): { routes: number[][]; totalCost: number } {
  const improved = routes.map(r => threeOptRoute(inst, twoOptRoute(inst, r), 2, 900));
  const total = improved.reduce((s, r) => s + routeCost(inst, r), 0);
  return { routes: improved, totalCost: total };
}

function cloneRoutes(routes: number[][]): number[][] {
  return routes.map(r => [...r]);
}

function routeLoads(inst: CvrpInstance, routes: number[][]): number[] {
  return routes.map(r => routeLoad(inst, r));
}

function totalRouteCost(inst: CvrpInstance, routes: number[][]): number {
  return routes.reduce((s, r) => s + routeCost(inst, r), 0);
}

type CandidateMap = Map<number, number[]>;

function buildCandidateMap(inst: CvrpInstance, k = 20): CandidateMap {
  const customers = Array.from(inst.nodes.keys()).filter(id => id !== inst.depot);
  const out: CandidateMap = new Map();

  for (const a of customers) {
    const pa = must(inst.nodes.get(a), `Missing node ${a}`);
    const neigh = customers
      .filter(b => b !== a)
      .map(b => {
        const pb = must(inst.nodes.get(b), `Missing node ${b}`);
        const d = Math.hypot(pa.x - pb.x, pa.y - pb.y);
        return { b, d };
      })
      .sort((u, v) => u.d - v.d)
      .slice(0, k)
      .map(x => x.b);
    out.set(a, neigh);
  }
  return out;
}

function buildNodeRouteMap(routes: number[][], depot: number): Map<number, number> {
  const map = new Map<number, number>();
  for (let r = 0; r < routes.length; r++) {
    for (const n of routes[r]) {
      if (n !== depot) map.set(n, r);
    }
  }
  return map;
}

function buildNodeIndexMap(route: number[]): Map<number, number> {
  const map = new Map<number, number>();
  for (let i = 1; i < route.length - 1; i++) map.set(route[i], i);
  return map;
}

function swapStarNeighborhood(
  inst: CvrpInstance,
  startRoutes: number[][],
  candidateMap: CandidateMap,
  maxPasses = 1
): { routes: number[][]; totalCost: number } {
  const routes = cloneRoutes(startRoutes);
  const loads = routeLoads(inst, routes);

  let pass = 0;
  let improved = true;
  while (improved && pass < maxPasses) {
    pass++;
    improved = false;

    const routeOf = buildNodeRouteMap(routes, inst.depot);
    const indexByRoute = routes.map(r => buildNodeIndexMap(r));

    let best: {
      ri: number; rj: number; ia: number; ib: number; loadA: number; loadB: number; delta: number;
    } | undefined;

    for (let ri = 0; ri < routes.length; ri++) {
      const A = routes[ri];
      for (let ia = 1; ia < A.length - 1; ia++) {
        const a = A[ia];
        const da = inst.demands.get(a) ?? 0;
        const cand = candidateMap.get(a) ?? [];
        for (const b of cand) {
          const rj = routeOf.get(b);
          if (rj === undefined || rj === ri) continue;

          const B = routes[rj];
          const ib = indexByRoute[rj].get(b);
          if (ib === undefined || ib <= 0 || ib >= B.length - 1) continue;

          const db = inst.demands.get(b) ?? 0;
          const loadA = loads[ri] - da + db;
          const loadB = loads[rj] - db + da;
          if (loadA > inst.capacity || loadB > inst.capacity) continue;

          const aPrev = A[ia - 1];
          const aNext = A[ia + 1];
          const bPrev = B[ib - 1];
          const bNext = B[ib + 1];

          const deltaA =
            edgeCost(inst, aPrev, b) + edgeCost(inst, b, aNext) -
            edgeCost(inst, aPrev, a) - edgeCost(inst, a, aNext);
          const deltaB =
            edgeCost(inst, bPrev, a) + edgeCost(inst, a, bNext) -
            edgeCost(inst, bPrev, b) - edgeCost(inst, b, bNext);
          const delta = deltaA + deltaB;

          if (delta < -1e-9 && (!best || delta < best.delta)) {
            best = { ri, rj, ia, ib, loadA, loadB, delta };
          }
        }
      }
    }

    if (!best) break;
    const A = routes[best.ri];
    const B = routes[best.rj];
    const a = A[best.ia];
    const b = B[best.ib];
    A[best.ia] = b;
    B[best.ib] = a;
    loads[best.ri] = best.loadA;
    loads[best.rj] = best.loadB;
    improved = true;
  }

  return { routes, totalCost: totalRouteCost(inst, routes) };
}

function twoOptStarNeighborhood(
  inst: CvrpInstance,
  startRoutes: number[][],
  candidateMap: CandidateMap,
  maxPasses = 1
): { routes: number[][]; totalCost: number } {
  const routes = cloneRoutes(startRoutes);
  const loads = routeLoads(inst, routes);

  let pass = 0;
  let improved = true;
  while (improved && pass < maxPasses) {
    pass++;
    improved = false;

    const routeOf = buildNodeRouteMap(routes, inst.depot);

    let best: {
      ri: number; rj: number; ia: number; ib: number; newLoadA: number; newLoadB: number; delta: number;
    } | undefined;

    for (let ri = 0; ri < routes.length; ri++) {
      const A = routes[ri];
      if (A.length <= 3) continue;

      const prefixA = Array(A.length).fill(0);
      for (let i = 1; i < A.length - 1; i++) prefixA[i] = prefixA[i - 1] + (inst.demands.get(A[i]) ?? 0);
      const loadA = loads[ri];

      for (let ia = 0; ia < A.length - 2; ia++) {
        const a = A[ia];
        const aNext = A[ia + 1];
        const cand = candidateMap.get(aNext) ?? [];

        for (const bNode of cand) {
          const rj = routeOf.get(bNode);
          if (rj === undefined || rj === ri) continue;
          const B = routes[rj];
          if (B.length <= 3) continue;

          const loadB = loads[rj];
          const prefixB = Array(B.length).fill(0);
          for (let i = 1; i < B.length - 1; i++) prefixB[i] = prefixB[i - 1] + (inst.demands.get(B[i]) ?? 0);

          for (let ib = 0; ib < B.length - 2; ib++) {
            const b = B[ib];
            const bNext = B[ib + 1];
            if (b !== bNode && bNext !== bNode) continue;

            const tailLoadA = loadA - prefixA[ia];
            const tailLoadB = loadB - prefixB[ib];
            const newLoadA = prefixA[ia] + tailLoadB;
            const newLoadB = prefixB[ib] + tailLoadA;
            if (newLoadA > inst.capacity || newLoadB > inst.capacity) continue;

            const delta =
              edgeCost(inst, a, bNext) + edgeCost(inst, b, aNext) -
              edgeCost(inst, a, aNext) - edgeCost(inst, b, bNext);

            if (delta < -1e-9 && (!best || delta < best.delta)) {
              best = { ri, rj, ia, ib, newLoadA, newLoadB, delta };
            }
          }
        }
      }
    }

    if (!best) break;
    const A = routes[best.ri];
    const B = routes[best.rj];
    const prefixA = A.slice(0, best.ia + 1);
    const tailA = A.slice(best.ia + 1, -1);
    const prefixB = B.slice(0, best.ib + 1);
    const tailB = B.slice(best.ib + 1, -1);

    routes[best.ri] = [...prefixA, ...tailB, inst.depot];
    routes[best.rj] = [...prefixB, ...tailA, inst.depot];
    loads[best.ri] = best.newLoadA;
    loads[best.rj] = best.newLoadB;
    improved = true;
  }

  return { routes, totalCost: totalRouteCost(inst, routes) };
}

function crossExchange22Neighborhood(
  inst: CvrpInstance,
  startRoutes: number[][],
  candidateMap: CandidateMap,
  maxPasses = 1
): { routes: number[][]; totalCost: number } {
  const routes = cloneRoutes(startRoutes);
  const loads = routeLoads(inst, routes);

  let pass = 0;
  let improved = true;
  while (improved && pass < maxPasses) {
    pass++;
    improved = false;

    const routeOf = buildNodeRouteMap(routes, inst.depot);
    const indexByRoute = routes.map(r => buildNodeIndexMap(r));

    let best: {
      ri: number; rj: number; ia: number; ib: number; newLoadA: number; newLoadB: number; delta: number;
    } | undefined;

    for (let ri = 0; ri < routes.length; ri++) {
      const A = routes[ri];
      if (A.length < 6) continue; // depot + at least 2 customers + depot

      for (let ia = 1; ia < A.length - 2; ia++) {
        const a1 = A[ia];
        const a2 = A[ia + 1];
        const demA = (inst.demands.get(a1) ?? 0) + (inst.demands.get(a2) ?? 0);
        const neigh = candidateMap.get(a1) ?? [];

        for (const b1cand of neigh) {
          const rj = routeOf.get(b1cand);
          if (rj === undefined || rj === ri) continue;
          const B = routes[rj];
          if (B.length < 6) continue;
          const ib = indexByRoute[rj].get(b1cand);
          if (ib === undefined || ib < 1 || ib >= B.length - 2) continue;

          const b1 = B[ib];
          const b2 = B[ib + 1];
          const demB = (inst.demands.get(b1) ?? 0) + (inst.demands.get(b2) ?? 0);

          const newLoadA = loads[ri] - demA + demB;
          const newLoadB = loads[rj] - demB + demA;
          if (newLoadA > inst.capacity || newLoadB > inst.capacity) continue;

          const aPrev = A[ia - 1];
          const aNext = A[ia + 2];
          const bPrev = B[ib - 1];
          const bNext = B[ib + 2];

          const deltaA =
            edgeCost(inst, aPrev, b1) + edgeCost(inst, b2, aNext) -
            edgeCost(inst, aPrev, a1) - edgeCost(inst, a2, aNext);
          const deltaB =
            edgeCost(inst, bPrev, a1) + edgeCost(inst, a2, bNext) -
            edgeCost(inst, bPrev, b1) - edgeCost(inst, b2, bNext);
          const delta = deltaA + deltaB;

          if (delta < -1e-9 && (!best || delta < best.delta)) {
            best = { ri, rj, ia, ib, newLoadA, newLoadB, delta };
          }
        }
      }
    }

    if (!best) break;
    const A = routes[best.ri];
    const B = routes[best.rj];
    const aSeg: [number, number] = [A[best.ia], A[best.ia + 1]];
    const bSeg: [number, number] = [B[best.ib], B[best.ib + 1]];
    A.splice(best.ia, 2, ...bSeg);
    B.splice(best.ib, 2, ...aSeg);
    loads[best.ri] = best.newLoadA;
    loads[best.rj] = best.newLoadB;
    improved = true;
  }

  return { routes, totalCost: totalRouteCost(inst, routes) };
}

function fastInterRouteKernel(
  inst: CvrpInstance,
  startRoutes: number[][],
  candidateMap: CandidateMap,
  rounds = 1
): { routes: number[][]; totalCost: number } {
  let current = cloneRoutes(startRoutes);
  for (let r = 0; r < rounds; r++) {
    const relocate = interRouteRelocateSwap(inst, current, 1);
    const stringRelocate = interRouteStringRelocateNeighborhood(inst, relocate.routes, candidateMap, 1);
    const swap = swapStarNeighborhood(inst, stringRelocate.routes, candidateMap, 1);
    const twoStar = twoOptStarNeighborhood(inst, swap.routes, candidateMap, 1);
    const cross22 = crossExchange22Neighborhood(inst, twoStar.routes, candidateMap, 1);
    const boundary = boundaryBandCrossRouteExchange(inst, cross22.routes, 1, 0.22, 3);
    const exchange = twoRouteExchangeNeighborhood(inst, boundary.routes, 1);
    current = exchange.routes;
  }
  return { routes: current, totalCost: totalRouteCost(inst, current) };
}

function boundaryBandCrossRouteExchange(
  inst: CvrpInstance,
  startRoutes: number[][],
  maxPasses = 1,
  bandFraction = 0.20,
  maxSegLen = 3
): { routes: number[][]; totalCost: number; improved: number } {
  const routes = cloneRoutes(startRoutes);
  const loads = routeLoads(inst, routes);
  const depot = must(inst.nodes.get(inst.depot), "Missing depot.");
  let improved = 0;
  let pass = 0;
  let changed = true;

  const routeAngle = (route: number[]): number => {
    const c = computeRouteCentroid(inst, route);
    return Math.atan2(c.y - depot.y, c.x - depot.x);
  };

  while (changed && pass < maxPasses) {
    pass++;
    changed = false;
    const order = routes
      .map((r, idx) => ({ idx, a: routeAngle(r) }))
      .sort((u, v) => u.a - v.a)
      .map(x => x.idx);
    const pairs: Array<[number, number]> = [];
    for (let i = 0; i < order.length - 1; i++) pairs.push([order[i], order[i + 1]]);
    if (order.length >= 2) pairs.push([order[order.length - 1], order[0]]);

    pairLoop:
    for (const [ri, rj] of pairs) {
      const A = routes[ri];
      const B = routes[rj];
      if (A.length <= 3 || B.length <= 3) continue;

      const innerA = A.length - 2;
      const innerB = B.length - 2;
      const bandA = Math.max(1, Math.floor(innerA * bandFraction));
      const bandB = Math.max(1, Math.floor(innerB * bandFraction));

      let best:
        | { kind: "splice"; ia: number; ib: number; newA: number[]; newB: number[]; newLoadA: number; newLoadB: number; delta: number }
        | { kind: "swapSeg"; ia: number; la: number; ib: number; lb: number; newA: number[]; newB: number[]; newLoadA: number; newLoadB: number; delta: number }
        | undefined;

      const oldPair = routeCost(inst, A) + routeCost(inst, B);

      // 2-opt* splice on boundary bands (tail exchange).
      const startIA = Math.max(1, A.length - 1 - bandA);
      const endIA = A.length - 2;
      const startIB = 1;
      const endIB = Math.min(B.length - 2, bandB);
      for (let ia = startIA; ia <= endIA; ia++) {
        const tailA = A.slice(ia + 1, -1);
        const tailLoadA = tailA.reduce((s, n) => s + (inst.demands.get(n) ?? 0), 0);
        const prefixLoadA = loads[ri] - tailLoadA;
        for (let ib = startIB; ib <= endIB; ib++) {
          const tailB = B.slice(ib + 1, -1);
          const tailLoadB = tailB.reduce((s, n) => s + (inst.demands.get(n) ?? 0), 0);
          const prefixLoadB = loads[rj] - tailLoadB;
          const newLoadA = prefixLoadA + tailLoadB;
          const newLoadB = prefixLoadB + tailLoadA;
          if (newLoadA > inst.capacity || newLoadB > inst.capacity) continue;

          const newA = [...A.slice(0, ia + 1), ...tailB, inst.depot];
          const newB = [...B.slice(0, ib + 1), ...tailA, inst.depot];
          if (newA.length <= 2 || newB.length <= 2) continue;
          const newPair = routeCost(inst, newA) + routeCost(inst, newB);
          const delta = newPair - oldPair;
          if (delta < -1e-9 && (!best || delta < best.delta)) {
            best = { kind: "splice", ia, ib, newA, newB, newLoadA, newLoadB, delta };
          }
        }
      }

      // Segment swap near end/start boundary (1..maxSegLen).
      const aStartMin = Math.max(1, A.length - 1 - bandA);
      const aStartMax = A.length - 2;
      const bStartMin = 1;
      const bStartMax = Math.min(B.length - 2, bandB);
      for (let ia = aStartMin; ia <= aStartMax; ia++) {
        for (let la = 1; la <= maxSegLen && ia + la <= A.length - 1; la++) {
          const segA = A.slice(ia, ia + la);
          if (segA.length === 0 || segA.includes(inst.depot)) continue;
          const loadSegA = segA.reduce((s, n) => s + (inst.demands.get(n) ?? 0), 0);
          for (let ib = bStartMin; ib <= bStartMax; ib++) {
            for (let lb = 1; lb <= maxSegLen && ib + lb <= B.length - 1; lb++) {
              const segB = B.slice(ib, ib + lb);
              if (segB.length === 0 || segB.includes(inst.depot)) continue;
              const loadSegB = segB.reduce((s, n) => s + (inst.demands.get(n) ?? 0), 0);
              const newLoadA = loads[ri] - loadSegA + loadSegB;
              const newLoadB = loads[rj] - loadSegB + loadSegA;
              if (newLoadA > inst.capacity || newLoadB > inst.capacity) continue;

              const newA = [...A.slice(0, ia), ...segB, ...A.slice(ia + la)];
              const newB = [...B.slice(0, ib), ...segA, ...B.slice(ib + lb)];
              const newPair = routeCost(inst, newA) + routeCost(inst, newB);
              const delta = newPair - oldPair;
              if (delta < -1e-9 && (!best || delta < best.delta)) {
                best = { kind: "swapSeg", ia, la, ib, lb, newA, newB, newLoadA, newLoadB, delta };
              }
            }
          }
        }
      }

      if (best) {
        routes[ri] = best.newA;
        routes[rj] = best.newB;
        loads[ri] = best.newLoadA;
        loads[rj] = best.newLoadB;
        improved++;
        changed = true;
        break pairLoop;
      }
    }
  }

  return { routes, totalCost: totalRouteCost(inst, routes), improved };
}

function routeInnerDemand(inst: CvrpInstance, route: number[]): number {
  let sum = 0;
  for (let i = 1; i < route.length - 1; i++) sum += inst.demands.get(route[i]) ?? 0;
  return sum;
}

function interRouteRelocateSwap(
  inst: CvrpInstance,
  startRoutes: number[][],
  maxPasses = 2
): { routes: number[][]; totalCost: number } {
  const routes = cloneRoutes(startRoutes);
  const loads = routeLoads(inst, routes);

  let pass = 0;
  let improved = true;

  while (improved && pass < maxPasses) {
    pass++;
    improved = false;

    relocateLoop:
    for (let ri = 0; ri < routes.length; ri++) {
      for (let rj = 0; rj < routes.length; rj++) {
        if (ri === rj) continue;

        const from = routes[ri];
        const to = routes[rj];
        for (let i = 1; i < from.length - 1; i++) {
          const node = from[i];
          const dem = inst.demands.get(node) ?? 0;
          if (loads[rj] + dem > inst.capacity) continue;

          for (let j = 1; j < to.length; j++) {
            const newFrom = [...from.slice(0, i), ...from.slice(i + 1)];
            const newTo = [...to.slice(0, j), node, ...to.slice(j)];

            const oldCost = routeCost(inst, from) + routeCost(inst, to);
            const newCost = routeCost(inst, newFrom) + routeCost(inst, newTo);

            if (newCost + 1e-9 < oldCost) {
              routes[ri] = newFrom;
              routes[rj] = newTo;
              loads[ri] -= dem;
              loads[rj] += dem;
              improved = true;
              break relocateLoop;
            }
          }
        }
      }
    }

    if (improved) continue;

    swapLoop:
    for (let ri = 0; ri < routes.length; ri++) {
      for (let rj = ri + 1; rj < routes.length; rj++) {
        const a = routes[ri];
        const b = routes[rj];

        for (let i = 1; i < a.length - 1; i++) {
          const ni = a[i];
          const di = inst.demands.get(ni) ?? 0;

          for (let j = 1; j < b.length - 1; j++) {
            const nj = b[j];
            const dj = inst.demands.get(nj) ?? 0;

            const loadA = loads[ri] - di + dj;
            const loadB = loads[rj] - dj + di;
            if (loadA > inst.capacity || loadB > inst.capacity) continue;

            const newA = [...a];
            const newB = [...b];
            newA[i] = nj;
            newB[j] = ni;

            const oldCost = routeCost(inst, a) + routeCost(inst, b);
            const newCost = routeCost(inst, newA) + routeCost(inst, newB);

            if (newCost + 1e-9 < oldCost) {
              routes[ri] = newA;
              routes[rj] = newB;
              loads[ri] = loadA;
              loads[rj] = loadB;
              improved = true;
              break swapLoop;
            }
          }
        }
      }
    }
  }

  return { routes, totalCost: totalRouteCost(inst, routes) };
}

function interRouteStringRelocateNeighborhood(
  inst: CvrpInstance,
  startRoutes: number[][],
  candidateMap: CandidateMap,
  maxPasses = 1
): { routes: number[][]; totalCost: number } {
  const routes = cloneRoutes(startRoutes);
  const loads = routeLoads(inst, routes);
  let pass = 0;
  let improved = true;

  while (improved && pass < maxPasses) {
    pass++;
    improved = false;
    const routeOf = buildNodeRouteMap(routes, inst.depot);

    relocateChain:
    for (let ri = 0; ri < routes.length; ri++) {
      const from = routes[ri];
      if (from.length <= 4) continue;

      for (const blockLen of [3, 2]) {
        if (from.length - 2 < blockLen) continue;
        for (let i = 1; i + blockLen - 1 < from.length - 1; i++) {
          const block = from.slice(i, i + blockLen);
          const blockDem = block.reduce((s, n) => s + (inst.demands.get(n) ?? 0), 0);
          const newFrom = [...from.slice(0, i), ...from.slice(i + blockLen)];
          const oldFromCost = routeCost(inst, from);
          const newFromCost = routeCost(inst, newFrom);

          const targetSet = new Set<number>();
          const probes = [block[0], block[block.length - 1]];
          for (const p of probes) {
            const neigh = candidateMap.get(p) ?? [];
            for (const n of neigh) {
              const rj = routeOf.get(n);
              if (rj !== undefined && rj !== ri) targetSet.add(rj);
            }
          }
          if (targetSet.size === 0) {
            for (let rj = 0; rj < routes.length; rj++) {
              if (rj !== ri) targetSet.add(rj);
            }
          }

          for (const rj of targetSet) {
            if (loads[rj] + blockDem > inst.capacity) continue;
            const to = routes[rj];
            const oldToCost = routeCost(inst, to);
            const inserted = tryInsertBestChainPosition(inst, to, block);
            const newPairCost = newFromCost + oldToCost + inserted.delta;
            const oldPairCost = oldFromCost + oldToCost;
            if (newPairCost + 1e-9 < oldPairCost) {
              routes[ri] = newFrom;
              routes[rj] = inserted.route;
              loads[ri] -= blockDem;
              loads[rj] += blockDem;
              improved = true;
              break relocateChain;
            }
          }
        }
      }
    }
  }

  return { routes, totalCost: totalRouteCost(inst, routes) };
}

function twoRouteExchangeNeighborhood(
  inst: CvrpInstance,
  startRoutes: number[][],
  maxPasses = 1
): { routes: number[][]; totalCost: number } {
  const routes = cloneRoutes(startRoutes);
  let pass = 0;
  let improved = true;

  while (improved && pass < maxPasses) {
    improved = false;
    pass++;

    exchangeLoop:
    for (let ri = 0; ri < routes.length; ri++) {
      for (let rj = ri + 1; rj < routes.length; rj++) {
        const a = routes[ri];
        const b = routes[rj];

        for (let ci = 1; ci < a.length - 1; ci++) {
          for (let cj = 1; cj < b.length - 1; cj++) {
            const prefixA = a.slice(1, ci + 1);
            const suffixA = a.slice(ci + 1, -1);
            const prefixB = b.slice(1, cj + 1);
            const suffixB = b.slice(cj + 1, -1);

            const newAInner = [...prefixA, ...suffixB];
            const newBInner = [...prefixB, ...suffixA];

            const loadA = newAInner.reduce((s, n) => s + (inst.demands.get(n) ?? 0), 0);
            const loadB = newBInner.reduce((s, n) => s + (inst.demands.get(n) ?? 0), 0);
            if (loadA > inst.capacity || loadB > inst.capacity) continue;

            const newA = [inst.depot, ...newAInner, inst.depot];
            const newB = [inst.depot, ...newBInner, inst.depot];

            const oldCost = routeCost(inst, a) + routeCost(inst, b);
            const newCost = routeCost(inst, newA) + routeCost(inst, newB);
            if (newCost + 1e-9 < oldCost) {
              routes[ri] = newA;
              routes[rj] = newB;
              improved = true;
              break exchangeLoop;
            }
          }
        }
      }
    }
  }

  return { routes, totalCost: totalRouteCost(inst, routes) };
}

function ejectionChainNeighborhood(
  inst: CvrpInstance,
  startRoutes: number[][],
  rng: () => number,
  trials = 400,
  candidateMap?: CandidateMap,
  maxChainLen = 3
): { routes: number[][]; totalCost: number } {
  const routes = cloneRoutes(startRoutes);
  let currentCost = totalRouteCost(inst, routes);

  for (let t = 0; t < trials; t++) {
    const r1 = Math.floor(rng() * routes.length);
    const A = routes[r1];
    if (A.length <= 3) continue;

    const ia = 1 + Math.floor(rng() * (A.length - 2));
    const chainLen = Math.min(
      maxChainLen,
      Math.max(1, A.length - 1 - ia),
      rng() < 0.55 ? 1 : (2 + Math.floor(rng() * 2))
    );
    const ejectChain = A.slice(ia, ia + chainLen);
    if (ejectChain.length === 0) continue;
    const chainHead = ejectChain[0];
    const chainDem = ejectChain.reduce((s, n) => s + (inst.demands.get(n) ?? 0), 0);

    const routeOf = buildNodeRouteMap(routes, inst.depot);
    let candidateR2: number[] = [];
    if (candidateMap) {
      const neigh = candidateMap.get(chainHead) ?? [];
      candidateR2 = [...new Set(neigh.map(n => routeOf.get(n)).filter((x): x is number => x !== undefined && x !== r1))];
    }
    if (candidateR2.length === 0) {
      candidateR2 = Array.from({ length: routes.length }, (_, idx) => idx).filter(idx => idx !== r1);
    }
    if (candidateR2.length === 0) continue;
    const r2 = candidateR2[Math.floor(rng() * candidateR2.length)];
    const B = routes[r2];
    if (B.length <= 3) continue;

    const ib = 1 + Math.floor(rng() * (B.length - 2));
    const nb = B[ib];
    const db = inst.demands.get(nb) ?? 0;

    const loadA0 = routeInnerDemand(inst, A);
    const loadB0 = routeInnerDemand(inst, B);
    if (loadB0 - db + chainDem > inst.capacity) continue;

    const A1 = [...A.slice(0, ia), ...A.slice(ia + chainLen)];
    if (routeInnerDemand(inst, A1) > inst.capacity || routeInnerDemand(inst, A1) < 0) continue;
    const B1 = [...B.slice(0, ib), ...ejectChain, ...B.slice(ib + 1)];

    let candidateR3: number[] = [];
    if (candidateMap) {
      const neigh2 = candidateMap.get(nb) ?? [];
      candidateR3 = [...new Set(neigh2.map(n => routeOf.get(n)).filter((x): x is number => x !== undefined && x !== r1 && x !== r2))];
    }
    if (candidateR3.length === 0) {
      candidateR3 = Array.from({ length: routes.length }, (_, idx) => idx).filter(idx => idx !== r1 && idx !== r2);
    }
    if (candidateR3.length === 0) continue;
    const r3 = candidateR3[Math.floor(rng() * candidateR3.length)];
    const C = routes[r3];
    const loadC0 = routeInnerDemand(inst, C);
    if (loadC0 + db > inst.capacity) continue;

    let bestC: number[] | undefined;
    let bestDeltaC = Number.POSITIVE_INFINITY;
    for (let p = 1; p < C.length; p++) {
      const prev = C[p - 1];
      const next = C[p];
      const delta = edgeCost(inst, prev, nb) + edgeCost(inst, nb, next) - edgeCost(inst, prev, next);
      if (delta < bestDeltaC) {
        bestDeltaC = delta;
        bestC = [...C.slice(0, p), nb, ...C.slice(p)];
      }
    }

    if (!bestC) continue;

    const oldCost = routeCost(inst, A) + routeCost(inst, B) + routeCost(inst, C);
    const newCost = routeCost(inst, A1) + routeCost(inst, B1) + routeCost(inst, bestC);

    if (newCost + 1e-9 < oldCost) {
      routes[r1] = A1;
      routes[r2] = B1;
      routes[r3] = bestC;
      currentCost += (newCost - oldCost);
    }
  }

  return { routes, totalCost: currentCost };
}

function tryInsertBestPosition(inst: CvrpInstance, route: number[], node: number): { route: number[]; delta: number } {
  let bestDelta = Number.POSITIVE_INFINITY;
  let bestRoute = route;

  for (let pos = 1; pos < route.length; pos++) {
    const prev = route[pos - 1];
    const next = route[pos];
    const delta = edgeCost(inst, prev, node) + edgeCost(inst, node, next) - edgeCost(inst, prev, next);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestRoute = [...route.slice(0, pos), node, ...route.slice(pos)];
    }
  }

  return { route: bestRoute, delta: bestDelta };
}

function tryInsertBestChainPosition(
  inst: CvrpInstance,
  route: number[],
  chain: number[]
): { route: number[]; delta: number } {
  let bestDelta = Number.POSITIVE_INFINITY;
  let bestRoute = route;

  const variants = chain.length > 1 ? [chain, [...chain].reverse()] : [chain];
  for (const seq of variants) {
    for (let pos = 1; pos < route.length; pos++) {
      const prev = route[pos - 1];
      const next = route[pos];

      let inCost = edgeCost(inst, prev, seq[0]);
      for (let i = 0; i < seq.length - 1; i++) {
        inCost += edgeCost(inst, seq[i], seq[i + 1]);
      }
      inCost += edgeCost(inst, seq[seq.length - 1], next);

      const delta = inCost - edgeCost(inst, prev, next);
      if (delta < bestDelta) {
        bestDelta = delta;
        bestRoute = [...route.slice(0, pos), ...seq, ...route.slice(pos)];
      }
    }
  }

  return { route: bestRoute, delta: bestDelta };
}

function decodeWithLockedRoutes(
  inst: CvrpInstance,
  lockedRoutes: number[][],
  parentOrderA: number[],
  parentOrderB: number[],
  K: number,
  candidateMap: CandidateMap,
  targetLoadsDesc?: number[]
): SplitResult | undefined {
  const routes = cloneRoutes(lockedRoutes);
  while (routes.length < K) routes.push([inst.depot, inst.depot]);
  if (routes.length > K) routes.length = K;

  // Child repair v2: resolve duplicate fragments and capacity overflow before regret insertion.
  const overflowPending: number[] = [];
  const owned = new Set<number>();
  for (let r = 0; r < routes.length; r++) {
    const route = routes[r];
    const clean: number[] = [inst.depot];
    for (let i = 1; i < route.length - 1; i++) {
      const id = route[i];
      if (id === inst.depot || owned.has(id)) {
        overflowPending.push(id);
        continue;
      }
      owned.add(id);
      clean.push(id);
    }
    clean.push(inst.depot);
    routes[r] = clean;
  }

  for (let r = 0; r < routes.length; r++) {
    let route = routes[r];
    while (routeLoad(inst, route) > inst.capacity && route.length > 3) {
      let removeAt = 1;
      let bestGain = -Number.POSITIVE_INFINITY;
      for (let i = 1; i < route.length - 1; i++) {
        const prev = route[i - 1];
        const cur = route[i];
        const next = route[i + 1];
        const gain = edgeCost(inst, prev, cur) + edgeCost(inst, cur, next) - edgeCost(inst, prev, next);
        if (gain > bestGain) {
          bestGain = gain;
          removeAt = i;
        }
      }
      overflowPending.push(route[removeAt]);
      route = [...route.slice(0, removeAt), ...route.slice(removeAt + 1)];
    }
    routes[r] = route;
  }

  const loads = routeLoads(inst, routes);
  const seen = new Set<number>();
  for (const route of routes) {
    for (const id of route) {
      if (id !== inst.depot) seen.add(id);
    }
  }

  const pending: number[] = [];
  overflowPending
    .filter(id => id !== inst.depot)
    .sort((a, b) => (inst.demands.get(b) ?? 0) - (inst.demands.get(a) ?? 0))
    .forEach(id => {
      if (!seen.has(id)) {
        seen.add(id);
        pending.push(id);
      }
    });
  const pushMissing = (order: number[]) => {
    for (const id of order) {
      if (id === inst.depot || seen.has(id)) continue;
      seen.add(id);
      pending.push(id);
    }
  };
  pushMissing(parentOrderB);
  pushMissing(parentOrderA);

  const windowSize = 24;
  while (pending.length > 0) {
    const w = Math.min(windowSize, pending.length);
    let chosenIdx = -1;
    let chosenRoute = -1;
    let chosenDelta = Number.POSITIVE_INFINITY;
    let bestRegret = -Number.POSITIVE_INFINITY;
    let chosenCandidateRoute: number[] | undefined;

    for (let i = 0; i < w; i++) {
      const node = pending[i];
      const dem = inst.demands.get(node) ?? 0;
      let best1 = Number.POSITIVE_INFINITY;
      let best2 = Number.POSITIVE_INFINITY;
      let bestRouteIdx = -1;
      let bestRouteCandidate: number[] | undefined;

      for (let r = 0; r < routes.length; r++) {
        if (loads[r] + dem > inst.capacity) continue;
        const candidate = tryInsertBestPosition(inst, routes[r], node);
        if (candidate.delta < best1) {
          best2 = best1;
          best1 = candidate.delta;
          bestRouteIdx = r;
          bestRouteCandidate = candidate.route;
        } else if (candidate.delta < best2) {
          best2 = candidate.delta;
        }
      }

      if (bestRouteIdx < 0 || !bestRouteCandidate) continue;
      const regret = Number.isFinite(best2) ? (best2 - best1) : 1e9;
      if (regret > bestRegret || (Math.abs(regret - bestRegret) < 1e-9 && best1 < chosenDelta)) {
        bestRegret = regret;
        chosenIdx = i;
        chosenRoute = bestRouteIdx;
        chosenDelta = best1;
        chosenCandidateRoute = bestRouteCandidate;
      }
    }

    if (chosenIdx < 0 || chosenRoute < 0 || !chosenCandidateRoute) {
      // Fallback: decode full order if insertion got stuck.
      const full = splitExactK(inst, parentOrderA, K, targetLoadsDesc);
      if (full.feasible) return full;
      const alt = splitExactK(inst, parentOrderB, K, targetLoadsDesc);
      return alt.feasible ? alt : undefined;
    }

    const node = pending[chosenIdx];
    const dem = inst.demands.get(node) ?? 0;
    routes[chosenRoute] = chosenCandidateRoute;
    loads[chosenRoute] += dem;
    pending.splice(chosenIdx, 1);
  }

  const improved = improveRoutes2Opt(inst, routes);
  const refined = fastInterRouteKernel(inst, improved.routes, candidateMap, 1);
  const lkRefined = deepenPromisingRoutes(inst, refined.routes, candidateMap, "medium");
  const total = lkRefined.totalCost;
  return {
    routes: lkRefined.routes,
    feasible: true,
    usedVehicles: K,
    totalCost: total,
  };
}

function extractRemovedChains(currentRoutes: number[][], picked: Set<number>): { chains: number[][]; singles: number[] } {
  const chains: number[][] = [];
  const singles: number[] = [];

  for (const route of currentRoutes) {
    let i = 1;
    while (i < route.length - 1) {
      if (!picked.has(route[i])) {
        i++;
        continue;
      }
      const run: number[] = [];
      while (i < route.length - 1 && picked.has(route[i])) {
        run.push(route[i]);
        i++;
      }
      let p = 0;
      while (p < run.length) {
        const remaining = run.length - p;
        if (remaining >= 3) {
          chains.push(run.slice(p, p + 3));
          p += 3;
        } else if (remaining === 2) {
          chains.push(run.slice(p, p + 2));
          p += 2;
        } else {
          singles.push(run[p]);
          p += 1;
        }
      }
    }
  }

  return { chains, singles };
}

function selectTargetedDestroySet(
  inst: CvrpInstance,
  routes: number[][],
  pair: { i: number; j: number } | undefined,
  removeCount: number,
  rng: () => number
): Set<number> {
  const picked = new Set<number>();
  const customers = routes.flat().filter(id => id !== inst.depot);
  if (!pair || pair.i < 0 || pair.j < 0 || pair.i >= routes.length || pair.j >= routes.length || pair.i === pair.j) {
    while (picked.size < removeCount && picked.size < customers.length) {
      picked.add(customers[Math.floor(rng() * customers.length)]);
    }
    return picked;
  }

  const ri = routes[pair.i].filter(id => id !== inst.depot);
  const rj = routes[pair.j].filter(id => id !== inst.depot);
  const ci = computeRouteCentroid(inst, routes[pair.i]);
  const cj = computeRouteCentroid(inst, routes[pair.j]);

  const interleavedCandidates: Array<{ id: number; severity: number }> = [];
  const pushSeverity = (id: number, own: { x: number; y: number }, other: { x: number; y: number }) => {
    const p = must(inst.nodes.get(id), `Missing node ${id}`);
    const dOwn = Math.hypot(p.x - own.x, p.y - own.y);
    const dOther = Math.hypot(p.x - other.x, p.y - other.y);
    interleavedCandidates.push({ id, severity: dOwn - dOther });
  };
  ri.forEach(id => pushSeverity(id, ci, cj));
  rj.forEach(id => pushSeverity(id, cj, ci));
  interleavedCandidates.sort((a, b) => b.severity - a.severity);

  // 1) pull likely misassigned interleaved customers first
  for (const c of interleavedCandidates) {
    if (c.severity <= 0 && picked.size >= Math.floor(removeCount * 0.5)) break;
    picked.add(c.id);
    if (picked.size >= removeCount) return picked;
  }

  // 2) include local neighborhood around already picked nodes (cross-route neighborhood)
  const base = [...picked];
  for (const b of base) {
    const pb = must(inst.nodes.get(b), `Missing node ${b}`);
    const neighbors = [...ri, ...rj]
      .filter(x => x !== b && !picked.has(x))
      .map(x => {
        const q = must(inst.nodes.get(x), `Missing node ${x}`);
        return { id: x, d: Math.hypot(pb.x - q.x, pb.y - q.y) };
      })
      .sort((u, v) => u.d - v.d)
      .slice(0, 4);
    for (const n of neighbors) {
      picked.add(n.id);
      if (picked.size >= removeCount) return picked;
    }
  }

  // 3) top off from pair routes, then global fallback
  const local = [...ri, ...rj].filter(x => !picked.has(x));
  while (picked.size < removeCount && local.length > 0) {
    const idx = Math.floor(rng() * local.length);
    picked.add(local[idx]);
    local.splice(idx, 1);
  }
  while (picked.size < removeCount && picked.size < customers.length) {
    picked.add(customers[Math.floor(rng() * customers.length)]);
  }

  return picked;
}

function selectAdaptiveShawDestroySet(
  inst: CvrpInstance,
  routes: number[][],
  removeCount: number,
  rng: () => number,
  focusPair?: { i: number; j: number },
  stagnation = 0
): Set<number> {
  const customers = routes.flat().filter(id => id !== inst.depot);
  if (customers.length === 0 || removeCount <= 0) return new Set<number>();
  const cappedRemove = Math.min(removeCount, customers.length);
  const picked = new Set<number>();
  const routeOf = new Map<number, number>();
  for (let r = 0; r < routes.length; r++) {
    for (const n of routes[r]) if (n !== inst.depot) routeOf.set(n, r);
  }

  let seedPool = customers;
  if (focusPair && focusPair.i < routes.length && focusPair.j < routes.length && rng() < 0.68) {
    const f = [...routes[focusPair.i], ...routes[focusPair.j]].filter(id => id !== inst.depot);
    if (f.length > 0) seedPool = f;
  }
  const first = seedPool[Math.floor(rng() * seedPool.length)];
  picked.add(first);

  const baseNode = must(inst.nodes.get(first), `Missing node ${first}`);
  const demandBase = inst.demands.get(first) ?? 0;
  const geoScale = Math.max(1, Math.sqrt(inst.dimension));
  const routeBias = 0.30 + Math.min(0.25, 0.03 * stagnation);
  const demandBias = 0.45 + Math.min(0.30, 0.02 * stagnation);
  const sameRouteBias = 0.60 + Math.min(0.35, 0.03 * stagnation);
  const alpha = 2.4 + Math.min(2.2, 0.20 * stagnation);

  while (picked.size < cappedRemove) {
    const anchorArr = [...picked];
    const anchor = anchorArr[Math.floor(rng() * anchorArr.length)];
    const pa = must(inst.nodes.get(anchor), `Missing node ${anchor}`);
    const da = inst.demands.get(anchor) ?? demandBase;
    const ra = routeOf.get(anchor);
    const scored: Array<{ id: number; rel: number }> = [];
    for (const id of customers) {
      if (picked.has(id)) continue;
      const p = must(inst.nodes.get(id), `Missing node ${id}`);
      const dDist = Math.hypot(pa.x - p.x, pa.y - p.y) / geoScale;
      const dDem = Math.abs((inst.demands.get(id) ?? 0) - da) / Math.max(1, inst.capacity);
      const sameRoute = routeOf.get(id) === ra ? 1 : 0;
      const baseDist = Math.hypot(baseNode.x - p.x, baseNode.y - p.y) / geoScale;
      const relatedness = dDist + demandBias * dDem + routeBias * baseDist - sameRouteBias * sameRoute;
      scored.push({ id, rel: relatedness });
    }
    if (scored.length === 0) break;
    scored.sort((a, b) => a.rel - b.rel);
    const window = Math.min(scored.length, 24 + Math.min(24, stagnation * 2));
    const idx = Math.min(window - 1, Math.floor(Math.pow(rng(), alpha) * window));
    picked.add(scored[idx].id);
  }

  return picked;
}

function destroyRepairLns(
  inst: CvrpInstance,
  startRoutes: number[][],
  iterations: number,
  rng: () => number,
  candidateMap: CandidateMap,
  startTemp = 350,
  cooling = 0.988,
  chainTrialsPerIter = 40,
  focusPair?: { i: number; j: number }
): { routes: number[][]; totalCost: number } {
  let currentRoutes = cloneRoutes(startRoutes);
  let currentCost = totalRouteCost(inst, currentRoutes);

  let incumbentRoutes = cloneRoutes(currentRoutes);
  let incumbentCost = currentCost;

  let temp = startTemp;
  const activeFocus = focusPair;
  let lnsNoImprove = 0;
  const fallbackK = Math.max(24, Math.min(52, Math.floor(Math.sqrt(Math.max(1, inst.dimension - 1))) + 26));
  const firstEntry = candidateMap.entries().next().value as [number, number[]] | undefined;
  const baseK = firstEntry ? firstEntry[1].length : fallbackK;
  const relaxedCandidateMap = buildCandidateMap(inst, Math.min(56, Math.max(baseK + 12, 34)));

  const customersOf = (routes: number[][]) => routes.flat().filter(id => id !== inst.depot);

  for (let it = 0; it < iterations; it++) {
    const working = cloneRoutes(currentRoutes);
    const loads = routeLoads(inst, working);

    const customers = customersOf(working);
    const targeted = !!activeFocus && rng() < (0.26 + Math.min(0.25, lnsNoImprove * 0.03));
    const stagnationBoost = Math.min(0.10, lnsNoImprove * 0.012);
    const frac = targeted
      ? (0.05 + 0.05 * rng() + stagnationBoost)
      : (0.08 + 0.08 * rng() + stagnationBoost);
    const removeCount = Math.max(1, Math.floor(customers.length * frac));
    const useShaw = rng() < (0.56 + Math.min(0.24, lnsNoImprove * 0.03));
    const picked = useShaw
      ? selectAdaptiveShawDestroySet(inst, working, removeCount, rng, activeFocus, lnsNoImprove)
      : (targeted
        ? selectTargetedDestroySet(inst, working, activeFocus, removeCount, rng)
        : selectTargetedDestroySet(inst, working, undefined, removeCount, rng));

    const { chains, singles } = extractRemovedChains(currentRoutes, picked);
    for (let r = 0; r < working.length; r++) {
      const keep: number[] = [inst.depot];
      for (let i = 1; i < working[r].length - 1; i++) {
        const n = working[r][i];
        if (!picked.has(n)) {
          keep.push(n);
        } else {
          loads[r] -= inst.demands.get(n) ?? 0;
        }
      }
      keep.push(inst.depot);
      working[r] = keep;
    }

    chains.sort((a, b) =>
      b.reduce((s, id) => s + (inst.demands.get(id) ?? 0), 0) -
      a.reduce((s, id) => s + (inst.demands.get(id) ?? 0), 0)
    );
    singles.sort((a, b) => (inst.demands.get(b) ?? 0) - (inst.demands.get(a) ?? 0));

    let feasible = true;
    const pendingChains = [...chains];
    const pendingSingles = [...singles];

    while (pendingChains.length > 0) {
      const chain = pendingChains.shift()!;
      const dem = chain.reduce((s, id) => s + (inst.demands.get(id) ?? 0), 0);
      let bestRouteIdx = -1;
      let bestCandidate: number[] | undefined;
      let bestDelta = Number.POSITIVE_INFINITY;

      for (let r = 0; r < working.length; r++) {
        if (loads[r] + dem > inst.capacity) continue;
        const candidate = tryInsertBestChainPosition(inst, working[r], chain);
        if (candidate.delta < bestDelta) {
          bestDelta = candidate.delta;
          bestRouteIdx = r;
          bestCandidate = candidate.route;
        }
      }

      if (bestRouteIdx < 0 || !bestCandidate) {
        if (chain.length > 1) {
          for (const node of chain) pendingSingles.push(node);
          continue;
        }
        feasible = false;
        break;
      }

      working[bestRouteIdx] = bestCandidate;
      loads[bestRouteIdx] += dem;
    }

    if (!feasible) {
      temp *= cooling;
      continue;
    }

    for (const node of pendingSingles) {
      const dem = inst.demands.get(node) ?? 0;
      let bestRouteIdx = -1;
      let bestCandidate: number[] | undefined;
      let bestDelta = Number.POSITIVE_INFINITY;

      for (let r = 0; r < working.length; r++) {
        if (loads[r] + dem > inst.capacity) continue;
        const candidate = tryInsertBestPosition(inst, working[r], node);
        if (candidate.delta < bestDelta) {
          bestDelta = candidate.delta;
          bestRouteIdx = r;
          bestCandidate = candidate.route;
        }
      }

      if (bestRouteIdx < 0 || !bestCandidate) {
        feasible = false;
        break;
      }

      working[bestRouteIdx] = bestCandidate;
      loads[bestRouteIdx] += dem;
    }

    if (!feasible) {
      temp *= cooling;
      continue;
    }

    const twoOpted = improveRoutes2Opt(inst, working);
    const relaxNow = lnsNoImprove >= 6 || (it > 0 && it % 5 === 0);
    const activeMap = relaxNow ? relaxedCandidateMap : candidateMap;
    const kernel = fastInterRouteKernel(inst, twoOpted.routes, activeMap, relaxNow ? 2 : 1);
    const lkKernel = deepenPromisingRoutes(inst, kernel.routes, activeMap, relaxNow ? "medium" : "light");
    const chainDepth = relaxNow ? 5 : 4;
    const chained = ejectionChainNeighborhood(inst, lkKernel.routes, rng, chainTrialsPerIter, activeMap, chainDepth);
    const deepCross = relaxNow
      ? crossExchange22Neighborhood(inst, chained.routes, activeMap, 1)
      : chained;

    const candidateRoutes = deepCross.routes;
    const candidateCost = deepCross.totalCost;

    const delta = candidateCost - currentCost;
    const acceptProbBoost = relaxNow ? 1.35 : 1.0;
    const accept = delta <= 0 || rng() < Math.exp((-delta * acceptProbBoost) / Math.max(1, temp));

    if (accept) {
      currentRoutes = candidateRoutes;
      currentCost = candidateCost;
      if (currentCost + 1e-9 < incumbentCost) {
        incumbentRoutes = cloneRoutes(currentRoutes);
        incumbentCost = currentCost;
        lnsNoImprove = 0;
      } else {
        lnsNoImprove++;
      }
    } else {
      lnsNoImprove++;
    }

    temp *= cooling;
  }

  return { routes: incumbentRoutes, totalCost: incumbentCost };
}

function polishCandidate(
  inst: CvrpInstance,
  split: SplitResult,
  seed: number,
  lnsIterations = 14,
  chainTrials = 80,
  chainTrialsPerLnsIter = 30
): SplitResult {
  if (!split.feasible) return split;

  const rng = makeRng(seed);
  const candidateMapK = chooseCandidateMapK(inst, lnsIterations, chainTrials);
  const candidateMap = buildCandidateMap(inst, candidateMapK);

  const two = improveRoutes2Opt(inst, split.routes);
  const kernel = fastInterRouteKernel(inst, two.routes, candidateMap, 1);
  const seamKernel = boundaryBandCrossRouteExchange(inst, kernel.routes, 2, 0.22, 3);
  const seamRepairPre = seamDrivenPairRepair(inst, seamKernel.routes, candidateMap, 2, 3);
  const lkKernel = deepenPromisingRoutes(inst, seamRepairPre.routes, candidateMap, "medium");
  const exchange = lkKernel;
  const chain = ejectionChainNeighborhood(inst, exchange.routes, rng, chainTrials, candidateMap, 4);
  const top = computeTopOverlapPair(inst, chain.routes);
  const focusPair = top ? { i: top.i, j: top.j } : undefined;
  const lns = destroyRepairLns(inst, chain.routes, lnsIterations, rng, candidateMap, 300, 0.989, chainTrialsPerLnsIter, focusPair);
  const seamRepairPost = seamDrivenPairRepair(inst, lns.routes, candidateMap, 2, 3);

  return {
    routes: seamRepairPost.routes,
    feasible: true,
    usedVehicles: split.usedVehicles,
    totalCost: seamRepairPost.totalCost,
  };
}

function seamDrivenPairRepair(
  inst: CvrpInstance,
  startRoutes: number[][],
  candidateMap: CandidateMap,
  maxRounds = 2,
  pairsPerRound = 3
): { routes: number[][]; totalCost: number; improved: number } {
  let current = cloneRoutes(startRoutes);
  let improved = 0;

  for (let round = 0; round < maxRounds; round++) {
    const overlapPairs = computeOverlapPairs(inst, current);
    if (overlapPairs.length === 0) break;

    let roundImproved = false;
    for (const p of overlapPairs.slice(0, pairsPerRound)) {
      const i = p.i;
      const j = p.j;
      if (i < 0 || j < 0 || i >= current.length || j >= current.length || i === j) continue;

      const pairRoutes = [current[i], current[j]];
      const oldPairCost = routeCost(inst, pairRoutes[0]) + routeCost(inst, pairRoutes[1]);

      const step1 = interRouteStringRelocateNeighborhood(inst, pairRoutes, candidateMap, 1);
      const step2 = crossExchange22Neighborhood(inst, step1.routes, candidateMap, 1);
      const step3 = boundaryBandCrossRouteExchange(inst, step2.routes, 1, 0.24, 3);
      const step4 = improveRoutes2Opt(inst, step3.routes);
      const newPair = step4.routes;
      const newPairCost = routeCost(inst, newPair[0]) + routeCost(inst, newPair[1]);

      if (newPairCost + 1e-9 < oldPairCost) {
        current[i] = newPair[0];
        current[j] = newPair[1];
        improved++;
        roundImproved = true;
      }
    }

    if (!roundImproved) break;
  }

  return { routes: current, totalCost: totalRouteCost(inst, current), improved };
}

function chooseCandidateMapK(inst: CvrpInstance, lnsIterations: number, chainTrials: number): number {
  const customerCount = Math.max(1, inst.dimension - 1);
  let k = 18;
  if (customerCount >= 160) k = 22;
  if (customerCount >= 350) k = 26;
  if (customerCount >= 700) k = 30;
  if (lnsIterations >= 22) k += 2;
  if (chainTrials >= 150) k += 2;
  return Math.max(16, Math.min(36, k));
}

function rotateOrder(order: number[], shift: number): number[] {
  if (order.length === 0) return order;
  const s = ((shift % order.length) + order.length) % order.length;
  if (s === 0) return [...order];
  return [...order.slice(s), ...order.slice(0, s)];
}

function buildOrderFromRoutes(routes: number[][], depotId: number): number[] {
  const seen = new Set<number>();
  const order: number[] = [];
  for (const route of routes) {
    for (const id of route) {
      if (id === depotId) continue;
      if (!seen.has(id)) {
        seen.add(id);
        order.push(id);
      }
    }
  }
  return order;
}

function nearestNeighborOrderFromSeed(inst: CvrpInstance, customers: number[], seed: number): number[] {
  if (customers.length === 0) return [];
  const unvisited = new Set(customers);
  const order: number[] = [];

  let current = unvisited.has(seed) ? seed : customers[0];
  order.push(current);
  unvisited.delete(current);

  while (unvisited.size > 0) {
    let best = -1;
    let bestCost = Number.POSITIVE_INFINITY;
    for (const c of unvisited) {
      const cost = edgeCost(inst, current, c);
      if (cost < bestCost) {
        bestCost = cost;
        best = c;
      }
    }
    if (best < 0) break;
    order.push(best);
    unvisited.delete(best);
    current = best;
  }
  return order;
}

function pathRelinkOrders(orderA: number[], orderB: number[], steps = 8): number[][] {
  if (orderA.length === 0 || orderB.length === 0 || orderA.length !== orderB.length) return [];

  const posA = new Map<number, number>();
  const posB = new Map<number, number>();
  orderA.forEach((id, i) => posA.set(id, i));
  orderB.forEach((id, i) => posB.set(id, i));

  const out: number[][] = [];
  for (let s = 1; s <= steps; s++) {
    const alpha = s / (steps + 1);
    const blended = [...orderA].sort((u, v) => {
      const ku = (1 - alpha) * (posA.get(u) ?? 0) + alpha * (posB.get(u) ?? 0);
      const kv = (1 - alpha) * (posA.get(v) ?? 0) + alpha * (posB.get(v) ?? 0);
      return ku - kv;
    });
    out.push(blended);
  }
  return out;
}

function orderCrossoverOX(parentA: number[], parentB: number[], rng: () => number): number[] {
  const n = parentA.length;
  if (n === 0 || n !== parentB.length) return [...parentA];

  const child = Array<number>(n).fill(-1);
  const i = Math.floor(rng() * n);
  const j = Math.floor(rng() * n);
  const l = Math.min(i, j);
  const r = Math.max(i, j);

  const taken = new Set<number>();
  for (let p = l; p <= r; p++) {
    child[p] = parentA[p];
    taken.add(parentA[p]);
  }

  let w = (r + 1) % n;
  for (let step = 0; step < n; step++) {
    const v = parentB[(r + 1 + step) % n];
    if (taken.has(v)) continue;
    child[w] = v;
    taken.add(v);
    w = (w + 1) % n;
  }

  return child;
}

function mutateOrder(order: number[], rng: () => number): number[] {
  if (order.length < 4) return [...order];
  const out = [...order];
  const mode = Math.floor(rng() * 3);
  if (mode === 0) {
    const a = Math.floor(rng() * out.length);
    const b = Math.floor(rng() * out.length);
    const t = out[a];
    out[a] = out[b];
    out[b] = t;
    return out;
  }
  if (mode === 1) {
    const a = Math.floor(rng() * out.length);
    const b = Math.floor(rng() * out.length);
    const l = Math.min(a, b);
    const r = Math.max(a, b);
    return [...out.slice(0, l), ...out.slice(l, r + 1).reverse(), ...out.slice(r + 1)];
  }
  const shift = 1 + Math.floor(rng() * Math.max(1, Math.floor(out.length / 8)));
  return rotateOrder(out, shift);
}

type HgsIndividual = {
  name: string;
  order: number[];
  split: SplitResult;
  routeOf: Map<number, number>;
};

function signatureFromOrder(order: number[]): string {
  return order.join(",");
}

type PoolRoute = {
  id: number;
  key: string;
  route: number[];
  customers: number[];
  cost: number;
  load: number;
  centroidX: number;
  centroidY: number;
  depotEdgeCost: number;
};

function routeKey(route: number[], depot: number): string {
  return route.filter(x => x !== depot).join(",");
}

function routeEdgeSignature(route: number[], depot: number): Set<string> {
  const sig = new Set<string>();
  const inner = route.filter(x => x !== depot);
  for (let i = 0; i < inner.length - 1; i++) {
    const a = inner[i];
    const b = inner[i + 1];
    const u = Math.min(a, b);
    const v = Math.max(a, b);
    sig.add(`${u}|${v}`);
  }
  return sig;
}

function routeCustomerJaccard(a: number[], b: number[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const as = new Set(a);
  let inter = 0;
  for (const x of b) if (as.has(x)) inter++;
  const union = as.size + new Set(b).size - inter;
  return union > 0 ? inter / union : 0;
}

function curateRoutePoolByDiversity(inst: CvrpInstance, pool: PoolRoute[], maxPoolRoutes: number): PoolRoute[] {
  if (pool.length <= maxPoolRoutes) return pool;

  const enriched = pool.map(p => ({
    r: p,
    edgeSig: routeEdgeSignature(p.route, inst.depot),
  }));
  const selected: typeof enriched = [];

  for (const cand of enriched) {
    if (selected.length >= maxPoolRoutes) break;
    let tooSimilar = false;
    for (const s of selected) {
      const jacc = routeCustomerJaccard(cand.r.customers, s.r.customers);
      let edgeInter = 0;
      for (const e of cand.edgeSig) if (s.edgeSig.has(e)) edgeInter++;
      const edgeOverlap = Math.min(cand.edgeSig.size, s.edgeSig.size) > 0
        ? edgeInter / Math.min(cand.edgeSig.size, s.edgeSig.size)
        : 0;
      const cdist = Math.hypot(cand.r.centroidX - s.r.centroidX, cand.r.centroidY - s.r.centroidY);
      if (jacc > 0.80 && edgeOverlap > 0.75 && cdist < 18) {
        // Keep near-duplicates only if they are materially cheaper.
        if (cand.r.cost >= s.r.cost * 0.992) {
          tooSimilar = true;
          break;
        }
      }
    }
    if (!tooSimilar) selected.push(cand);
  }

  if (selected.length < maxPoolRoutes) {
    for (const cand of enriched) {
      if (selected.length >= maxPoolRoutes) break;
      if (!selected.includes(cand)) selected.push(cand);
    }
  }
  return selected.slice(0, maxPoolRoutes).map(x => x.r);
}

function buildRoutePoolFromCandidates(
  inst: CvrpInstance,
  candidates: Array<{ name: string; split: SplitResult }>,
  topCandidates = 90,
  maxPoolRoutes = 3200
): PoolRoute[] {
  const ranked = [...candidates].sort((a, b) => a.split.totalCost - b.split.totalCost).slice(0, topCandidates);
  const depotRanked = [...candidates]
    .sort((a, b) => a.split.totalCost - b.split.totalCost)
    .slice(0, Math.min(candidates.length, Math.max(topCandidates, 120)));
  const bestByKey = new Map<string, PoolRoute>();
  let id = 0;

  const captureRoute = (route: number[]): void => {
    const customers = route.filter(x => x !== inst.depot);
    if (customers.length === 0) return;
    const key = routeKey(route, inst.depot);
    const cost = routeCost(inst, route);
    const load = customers.reduce((s, n) => s + (inst.demands.get(n) ?? 0), 0);
    const centroid = computeRouteCentroid(inst, route);
    const depotEdgeCost = edgeCost(inst, inst.depot, route[1]) + edgeCost(inst, route[route.length - 2], inst.depot);
    const prev = bestByKey.get(key);
    if (!prev || cost < prev.cost) {
      bestByKey.set(key, {
        id: id++,
        key,
        route: [...route],
        customers: [...customers],
        cost,
        load,
        centroidX: centroid.x,
        centroidY: centroid.y,
        depotEdgeCost,
      });
    }
  };

  for (const c of ranked) {
    for (const route of c.split.routes) {
      captureRoute(route);
    }
  }

  // Depot-aware intensifier: inject routes with strongest depot pressure signatures.
  for (const c of depotRanked) {
    const scored = c.split.routes
      .map(route => {
        const cost = routeCost(inst, route);
        const depotEdges = edgeCost(inst, inst.depot, route[1]) + edgeCost(inst, route[route.length - 2], inst.depot);
        const score = depotEdges / Math.max(1, cost);
        return { route, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 2);
    for (const x of scored) {
      captureRoute(x.route);
    }
  }

  const rawPool = [...bestByKey.values()].sort((a, b) => a.cost - b.cost);
  const curated = curateRoutePoolByDiversity(inst, rawPool, maxPoolRoutes);
  return curated.map((r, i) => ({ ...r, id: i }));
}

function routePoolSpFinalizer(
  inst: CvrpInstance,
  incumbent: SplitResult,
  pool: PoolRoute[],
  K: number,
  rng: () => number,
  iterations = 35_000,
  penaltyWeight = 200_000
): { split?: SplitResult; tried: number; accepted: number; feasibleFound: number } {
  if (!incumbent.feasible || incumbent.routes.length !== K || pool.length === 0) {
    return { tried: 0, accepted: 0, feasibleFound: 0 };
  }

  const customers = Array.from(inst.nodes.keys()).filter(x => x !== inst.depot);
  const customerSet = new Set(customers);

  const poolByKey = new Map<string, PoolRoute>();
  for (const p of pool) poolByKey.set(p.key, p);

  const selected: PoolRoute[] = [];
  for (const r of incumbent.routes) {
    const key = routeKey(r, inst.depot);
    const fromPool = poolByKey.get(key);
    if (fromPool) selected.push(fromPool);
    else {
      const customers = r.filter(x => x !== inst.depot);
      const centroid = computeRouteCentroid(inst, r);
      selected.push({
        id: pool.length + selected.length,
        key,
        route: [...r],
        customers: [...customers],
        cost: routeCost(inst, r),
        load: customers.reduce((s, n) => s + (inst.demands.get(n) ?? 0), 0),
        centroidX: centroid.x,
        centroidY: centroid.y,
        depotEdgeCost: edgeCost(inst, inst.depot, r[1]) + edgeCost(inst, r[r.length - 2], inst.depot),
      });
    }
  }
  while (selected.length > K) selected.pop();
  while (selected.length < K) selected.push(pool[Math.floor(rng() * pool.length)]);

  const cover = new Map<number, number>();
  for (const c of customerSet) cover.set(c, 0);
  let totalCost = 0;
  for (const r of selected) {
    totalCost += r.cost;
    for (const c of r.customers) {
      cover.set(c, (cover.get(c) ?? 0) + 1);
    }
  }

  const penaltyOf = (cnt: number): number => Math.abs(cnt - 1);
  let coverPenalty = 0;
  for (const c of customerSet) coverPenalty += penaltyOf(cover.get(c) ?? 0);

  const poolByCustomer = new Map<number, PoolRoute[]>();
  for (const p of pool) {
    for (const c of p.customers) {
      const arr = poolByCustomer.get(c);
      if (arr) arr.push(p);
      else poolByCustomer.set(c, [p]);
    }
  }

  let bestFeasibleCost = Number.POSITIVE_INFINITY;
  let bestFeasibleRoutes: number[][] | undefined;
  if (coverPenalty === 0) {
    bestFeasibleCost = totalCost;
    bestFeasibleRoutes = selected.map(r => [...r.route]);
  }

  let accepted = 0;
  let feasibleFound = coverPenalty === 0 ? 1 : 0;
  let temp = 3_000;
  let dynamicPenaltyWeight = penaltyWeight;
  const cooling = 0.99960;
  let staleIterations = 0;
  let bestObjective = totalCost + dynamicPenaltyWeight * coverPenalty;

  const applyMoveDelta = (moves: Array<{ oldRoute: PoolRoute; newRoute: PoolRoute }>): { deltaPenalty: number; deltaCost: number } => {
    const touched = new Set<number>();
    let deltaCost = 0;
    for (const m of moves) {
      m.oldRoute.customers.forEach(c => touched.add(c));
      m.newRoute.customers.forEach(c => touched.add(c));
      deltaCost += (m.newRoute.cost - m.oldRoute.cost);
    }
    let delta = 0;
    for (const c of touched) {
      const before = cover.get(c) ?? 0;
      let after = before;
      for (const m of moves) {
        if (m.oldRoute.customers.includes(c)) after -= 1;
        if (m.newRoute.customers.includes(c)) after += 1;
      }
      delta += penaltyOf(after) - penaltyOf(before);
    }
    return { deltaPenalty: delta, deltaCost };
  };

  const commitMove = (moves: Array<{ idx: number; oldRoute: PoolRoute; newRoute: PoolRoute }>, deltaPenalty: number, deltaCost: number): void => {
    for (const m of moves) selected[m.idx] = m.newRoute;
    totalCost += deltaCost;
    coverPenalty += deltaPenalty;

    const touched = new Set<number>();
    for (const m of moves) {
      m.oldRoute.customers.forEach(c => touched.add(c));
      m.newRoute.customers.forEach(c => touched.add(c));
    }
    for (const c of touched) {
      const before = cover.get(c) ?? 0;
      let after = before;
      for (const m of moves) {
        if (m.oldRoute.customers.includes(c)) after -= 1;
        if (m.newRoute.customers.includes(c)) after += 1;
      }
      cover.set(c, after);
    }
  };

  for (let it = 0; it < iterations; it++) {
    const hotspots = customers.filter(c => (cover.get(c) ?? 0) !== 1);
    const useTwoMove = hotspots.length >= 2 && rng() < 0.55;

    const oldIdxA = Math.floor(rng() * K);
    const oldRouteA = selected[oldIdxA];
    const pivotA = hotspots.length > 0 ? hotspots[Math.floor(rng() * hotspots.length)] : undefined;
    let candA = pivotA !== undefined ? (poolByCustomer.get(pivotA) ?? []) : [];
    if (candA.length === 0) candA = pool;
    const newRouteA = candA[Math.floor(rng() * candA.length)];
    if (newRouteA.key === oldRouteA.key && !useTwoMove) continue;

    let moves: Array<{ idx: number; oldRoute: PoolRoute; newRoute: PoolRoute }> = [{ idx: oldIdxA, oldRoute: oldRouteA, newRoute: newRouteA }];

    if (useTwoMove) {
      let oldIdxB = Math.floor(rng() * K);
      if (oldIdxB === oldIdxA) oldIdxB = (oldIdxB + 1) % K;
      const oldRouteB = selected[oldIdxB];
      const pivotB = hotspots[Math.floor(rng() * hotspots.length)];
      let candB = poolByCustomer.get(pivotB) ?? [];
      if (candB.length === 0) candB = pool;
      const newRouteB = candB[Math.floor(rng() * candB.length)];
      if (newRouteB.key !== oldRouteB.key) {
        moves = [...moves, { idx: oldIdxB, oldRoute: oldRouteB, newRoute: newRouteB }];
      }
    }

    const moveDelta = applyMoveDelta(moves);
    const deltaObj = moveDelta.deltaCost + dynamicPenaltyWeight * moveDelta.deltaPenalty;
    const accept = deltaObj <= 0 || rng() < Math.exp(-deltaObj / Math.max(1, temp));
    if (!accept) {
      temp *= cooling;
      staleIterations++;
      continue;
    }

    commitMove(moves, moveDelta.deltaPenalty, moveDelta.deltaCost);
    accepted++;

    if (coverPenalty === 0 && totalCost + 1e-9 < bestFeasibleCost) {
      bestFeasibleCost = totalCost;
      bestFeasibleRoutes = selected.map(r => [...r.route]);
      feasibleFound++;
      staleIterations = 0;
    } else {
      staleIterations++;
    }

    const obj = totalCost + dynamicPenaltyWeight * coverPenalty;
    if (obj + 1e-9 < bestObjective) {
      bestObjective = obj;
      staleIterations = 0;
    }
    if (staleIterations > 1_100) {
      temp = Math.max(temp, 2_300);
      staleIterations = 0;
    }
    if (it > 0 && it % 160 === 0) {
      if (coverPenalty > 0) dynamicPenaltyWeight = Math.min(1_200_000, dynamicPenaltyWeight * 1.12);
      else dynamicPenaltyWeight = Math.max(70_000, dynamicPenaltyWeight * 0.92);
    }
    temp *= cooling;
  }

  if (!bestFeasibleRoutes) return { tried: iterations, accepted, feasibleFound };
  return {
    split: {
      routes: bestFeasibleRoutes,
      feasible: true,
      usedVehicles: K,
      totalCost: bestFeasibleCost,
    },
    tried: iterations,
    accepted,
    feasibleFound,
  };
}

function eliteRouteExactSelector(
  inst: CvrpInstance,
  incumbent: SplitResult,
  pool: PoolRoute[],
  K: number,
  maxNodes = 220_000
): SplitResult | undefined {
  if (!incumbent.feasible || incumbent.routes.length !== K) return undefined;

  const customers = Array.from(inst.nodes.keys()).filter(x => x !== inst.depot);
  const customerSet = new Set(customers);
  const routeData = incumbent.routes.map(r => {
    const customers = r.filter(x => x !== inst.depot);
    const centroid = computeRouteCentroid(inst, r);
    return {
      route: [...r],
      customers,
      cost: routeCost(inst, r),
      load: routeLoad(inst, r),
      centroidX: centroid.x,
      centroidY: centroid.y,
    };
  });

  const hotspotScores = new Map<number, number>();
  for (const r of incumbent.routes) {
    for (let i = 0; i < r.length - 1; i++) {
      const a = r[i];
      const b = r[i + 1];
      const score = edgeCost(inst, a, b);
      if (a !== inst.depot) hotspotScores.set(a, Math.max(hotspotScores.get(a) ?? 0, score));
      if (b !== inst.depot) hotspotScores.set(b, Math.max(hotspotScores.get(b) ?? 0, score));
    }
  }

  const buildIncumbentPoolRoute = (slot: number): PoolRoute => {
    const base = routeData[slot];
    return {
      id: -1 - slot,
      key: routeKey(base.route, inst.depot),
      route: [...base.route],
      customers: [...base.customers],
      cost: base.cost,
      load: base.load,
      centroidX: base.centroidX,
      centroidY: base.centroidY,
      depotEdgeCost: edgeCost(inst, inst.depot, base.route[1]) + edgeCost(inst, base.route[base.route.length - 2], inst.depot),
    };
  };

  const attempts = [
    { active: Math.min(8, K), options: 7 },
    { active: Math.min(10, K), options: 8 },
    { active: Math.min(12, K), options: 9 },
  ];

  let globalBestCost = incumbent.totalCost;
  let globalBestRoutes: number[][] | undefined;

  for (const cfg of attempts) {
    const slotScores = routeData
      .map((r, i) => {
        const hotspot = r.customers.reduce((s, c) => s + (hotspotScores.get(c) ?? 0), 0) / Math.max(1, r.customers.length);
        return { i, score: r.cost + 0.35 * hotspot };
      })
      .sort((a, b) => b.score - a.score);
    const activeSlots = slotScores.slice(0, cfg.active).map(x => x.i);
    const activeSet = new Set(activeSlots);
    const fixedRoutes = incumbent.routes.filter((_, idx) => !activeSet.has(idx));

    const chosenBySlot: Array<PoolRoute[]> = [];
    for (const slot of activeSlots) {
      const base = routeData[slot];
      const options = pool
        .map(p => {
          const overlap = routeCustomerJaccard(base.customers, p.customers);
          const loadGap = Math.abs(base.load - p.load) / Math.max(1, inst.capacity);
          const cdist = Math.hypot(base.centroidX - p.centroidX, base.centroidY - p.centroidY);
          const hotspotHit = p.customers.reduce((s, c) => s + (hotspotScores.get(c) ?? 0), 0) / Math.max(1, p.customers.length);
          const score =
            2.2 * overlap +
            0.002 * hotspotHit -
            0.55 * loadGap -
            0.015 * cdist -
            (p.cost - base.cost) / Math.max(1, base.cost);
          return { p, score, overlap };
        })
        .filter(x => x.overlap >= 0.15)
        .sort((a, b) => b.score - a.score)
        .slice(0, cfg.options)
        .map(x => x.p);
      const merged = [buildIncumbentPoolRoute(slot), ...options];
      const uniq = new Map<string, PoolRoute>();
      for (const o of merged) uniq.set(o.key, o);
      chosenBySlot.push([...uniq.values()].sort((a, b) => a.cost - b.cost).slice(0, cfg.options + 1));
    }

    const cover = new Map<number, number>();
    for (const c of customerSet) cover.set(c, 0);
    let missing = customerSet.size;
    let duplicate = 0;
    let fixedCost = 0;
    for (const r of fixedRoutes) {
      fixedCost += routeCost(inst, r);
      for (const c of r) {
        if (c === inst.depot) continue;
        const before = cover.get(c) ?? 0;
        const after = before + 1;
        cover.set(c, after);
        if (before === 0) missing--;
        else if (before === 1) duplicate++;
      }
    }

    const orderedIdx = Array.from({ length: chosenBySlot.length }, (_, i) => i)
      .sort((a, b) => chosenBySlot[a].length - chosenBySlot[b].length);
    const orderedMinRemaining: number[] = Array(orderedIdx.length + 1).fill(0);
    for (let d = orderedIdx.length - 1; d >= 0; d--) {
      const slotIdx = orderedIdx[d];
      const bestC = chosenBySlot[slotIdx].length > 0 ? chosenBySlot[slotIdx][0].cost : Number.POSITIVE_INFINITY;
      orderedMinRemaining[d] = orderedMinRemaining[d + 1] + bestC;
    }
    let nodes = 0;
    let bestCost = globalBestCost;
    let bestRoutes: number[][] | undefined;
    const picked: PoolRoute[] = [];

    const addRoute = (r: PoolRoute): void => {
      for (const c of r.customers) {
        const before = cover.get(c) ?? 0;
        const after = before + 1;
        cover.set(c, after);
        if (before === 0) missing--;
        else if (before === 1) duplicate++;
      }
    };
    const removeRoute = (r: PoolRoute): void => {
      for (const c of r.customers) {
        const before = cover.get(c) ?? 0;
        const after = before - 1;
        cover.set(c, after);
        if (before === 1) missing++;
        else if (before === 2) duplicate--;
      }
    };

    const dfs = (depth: number, partialCost: number): void => {
      if (nodes++ > Math.floor(maxNodes / attempts.length)) return;
      if (partialCost + orderedMinRemaining[depth] >= bestCost - 1e-9) return;
      if (duplicate > 0) return;
      if (depth === orderedIdx.length) {
        if (missing === 0 && duplicate === 0) {
          const activeRoutes = picked.map(x => [...x.route]);
          const allRoutes = [...fixedRoutes.map(r => [...r]), ...activeRoutes];
          const total = totalRouteCost(inst, allRoutes);
          if (allRoutes.length === K && total + 1e-9 < bestCost) {
            bestCost = total;
            bestRoutes = allRoutes;
          }
        }
        return;
      }
      const slotIdx = orderedIdx[depth];
      const options = chosenBySlot[slotIdx];
      for (const option of options) {
        addRoute(option);
        picked.push(option);
        dfs(depth + 1, partialCost + option.cost);
        picked.pop();
        removeRoute(option);
      }
    };

    dfs(0, fixedCost);
    if (bestRoutes && bestCost + 1e-9 < globalBestCost) {
      globalBestCost = bestCost;
      globalBestRoutes = bestRoutes;
    }
  }

  if (!globalBestRoutes) return undefined;
  return {
    routes: globalBestRoutes,
    feasible: true,
    usedVehicles: K,
    totalCost: globalBestCost,
  };
}

function separatorProjection(
  inst: CvrpInstance,
  node: number,
  angle: number
): number {
  const depot = must(inst.nodes.get(inst.depot), "Missing depot.");
  const p = must(inst.nodes.get(node), `Missing node ${node}`);
  const dx = p.x - depot.x;
  const dy = p.y - depot.y;
  const nx = Math.cos(angle);
  const ny = Math.sin(angle);
  return dx * nx + dy * ny;
}

function buildLocalOrdersForSeparator(
  inst: CvrpInstance,
  localCustomers: number[],
  currentRoutes: number[][],
  touchedRoutes: number[],
  rng: () => number,
  angles?: number[]
): number[][] {
  const uniq = new Map<string, number[]>();
  const add = (arr: number[]): void => {
    if (arr.length !== localCustomers.length) return;
    const key = arr.join(",");
    if (!uniq.has(key)) uniq.set(key, arr);
  };

  const currentOrder = buildOrderFromRoutes(touchedRoutes.map(i => currentRoutes[i]), inst.depot);
  add(currentOrder);

  const effectiveAngles = angles && angles.length > 0 ? angles : [rng() * Math.PI * 2, rng() * Math.PI * 2];
  for (const angle of effectiveAngles) {
    add(
      [...localCustomers]
        .map(id => ({ id, p: separatorProjection(inst, id, angle) }))
        .sort((a, b) => a.p - b.p)
        .map(x => x.id)
    );
  }
  if (effectiveAngles.length >= 2) {
    const a0 = effectiveAngles[0];
    const a1 = effectiveAngles[1];
    add(
      [...localCustomers]
        .map(id => ({
          id,
          p: 0.60 * separatorProjection(inst, id, a0) + 0.40 * separatorProjection(inst, id, a1),
        }))
        .sort((u, v) => u.p - v.p)
        .map(x => x.id)
    );
    add(
      [...localCustomers]
        .map(id => ({
          id,
          p: 0.60 * separatorProjection(inst, id, a0) - 0.40 * separatorProjection(inst, id, a1),
        }))
        .sort((u, v) => u.p - v.p)
        .map(x => x.id)
    );
  }

  const seed = localCustomers[Math.floor(rng() * localCustomers.length)];
  add(nearestNeighborOrderFromSeed(inst, localCustomers, seed));
  const kk = Math.max(4, Math.min(localCustomers.length, Math.floor(Math.sqrt(localCustomers.length))));
  add(kmeansOrderFromCustomers(inst, localCustomers, kk, 300000 + Math.floor(rng() * 10000)));

  return [...uniq.values()];
}

function boundaryBranchOrders(
  inst: CvrpInstance,
  baseOrders: number[][],
  boundaryNodes: number[],
  angles: number[],
  maxBranches: number
): number[][] {
  if (baseOrders.length === 0 || boundaryNodes.length === 0 || maxBranches <= 0) return [];
  const pickedBoundary = boundaryNodes.slice(0, Math.min(8, boundaryNodes.length));
  const proj = new Map<number, { a: number; b: number }>();
  for (const n of pickedBoundary) {
    proj.set(n, {
      a: separatorProjection(inst, n, angles[0]),
      b: separatorProjection(inst, n, angles[1]),
    });
  }

  const out = new Map<string, number[]>();
  const branches = Math.min(maxBranches, 1 << pickedBoundary.length);
  for (let bi = 0; bi < branches; bi++) {
    for (const base of baseOrders) {
      const pos = new Map<number, number>();
      base.forEach((id, idx) => pos.set(id, idx));
      const scored = [...base].map(id => {
        const p = proj.get(id);
        if (!p) return { id, key: pos.get(id) ?? 0 };
        const bidx = pickedBoundary.indexOf(id);
        const bit = bidx >= 0 ? ((bi >> bidx) & 1) : 0;
        const sign = bit === 1 ? 1 : -1;
        const offset = sign * (0.35 + 0.002 * Math.abs(p.a + p.b));
        return { id, key: (pos.get(id) ?? 0) + offset };
      });
      const cand = scored.sort((u, v) => u.key - v.key).map(x => x.id);
      const key = cand.join(",");
      if (!out.has(key)) out.set(key, cand);
      if (out.size >= maxBranches * 3) return [...out.values()];
    }
  }
  return [...out.values()];
}

function separatorExactIntensify(
  inst: CvrpInstance,
  incumbent: SplitResult,
  K: number,
  rng: () => number,
  bksLoads?: number[],
  rounds = 6
): { split?: SplitResult; tried: number; improved: number } {
  if (!incumbent.feasible || incumbent.routes.length !== K) return { tried: 0, improved: 0 };
  let current = incumbent;
  let best = incumbent;
  let improved = 0;
  let tried = 0;
  let temp = 220;
  const strongMode = rounds >= 8;
  const boundaryBand = strongMode ? 14 : 12;
  const maxTouched = strongMode ? 18 : 15;
  const basePerSep = strongMode ? 11 : 9;
  const branchCap = strongMode ? 14 : 10;
  const relaxRatio = strongMode ? 0.006 : 0.004;

  for (let round = 0; round < rounds; round++) {
    const angleA = rng() * Math.PI * 2;
    const angleB = angleA + Math.PI / 2 + (rng() - 0.5) * 0.24;
    const scoreByAngle = (angle: number): Array<{ idx: number; score: number }> =>
      current.routes.map((route, idx) => {
        const customers = route.filter(x => x !== inst.depot);
        let pos = 0;
        let neg = 0;
        let boundary = 0;
        for (const c of customers) {
          const v = separatorProjection(inst, c, angle);
          if (v > boundaryBand) pos++;
          else if (v < -boundaryBand) neg++;
          else boundary++;
        }
        const mixed = pos > 0 && neg > 0 ? 1 : 0;
        const score = 3.2 * boundary + 2.2 * mixed + routeCost(inst, route) / 520;
        return { idx, score };
      });

    const topA = scoreByAngle(angleA).sort((a, b) => b.score - a.score).slice(0, basePerSep).map(x => x.idx);
    const topB = scoreByAngle(angleB).sort((a, b) => b.score - a.score).slice(0, basePerSep).map(x => x.idx);
    const touchedRoutes = [...new Set([...topA, ...topB])].slice(0, maxTouched);
    if (touchedRoutes.length < 4) continue;

    const touchedSet = new Set(touchedRoutes);
    const fixedRoutes = current.routes.filter((_, idx) => !touchedSet.has(idx));
    const fixedCost = totalRouteCost(inst, fixedRoutes);
    const localCustomers = touchedRoutes.flatMap(ri => current.routes[ri].filter(x => x !== inst.depot));
    if (localCustomers.length < touchedRoutes.length) continue;
    if (fixedRoutes.length + touchedRoutes.length !== K) continue;

    const localK = touchedRoutes.length;
    const baseOrders = buildLocalOrdersForSeparator(
      inst,
      localCustomers,
      current.routes,
      touchedRoutes,
      rng,
      [angleA, angleB]
    );
    const boundaryNodes = [...localCustomers]
      .map(id => ({
        id,
        d: Math.min(
          Math.abs(separatorProjection(inst, id, angleA)),
          Math.abs(separatorProjection(inst, id, angleB))
        ),
      }))
      .sort((u, v) => u.d - v.d)
      .slice(0, Math.min(localCustomers.length, strongMode ? 14 : 10))
      .map(x => x.id);
    const branchOrders = boundaryBranchOrders(inst, baseOrders, boundaryNodes, [angleA, angleB], branchCap);
    const orders = [...new Map([...baseOrders, ...branchOrders].map(o => [o.join(","), o])).values()];

    let bestRoundCost = current.totalCost;
    for (const order of orders) {
      tried++;
      const localSplit = splitExactK(inst, order, localK, bksLoads);
      if (!localSplit.feasible) continue;
      if (fixedCost + localSplit.totalCost >= bestRoundCost * (1 + relaxRatio) - 1e-9) continue;
      const mergedRoutes = [...fixedRoutes.map(r => [...r]), ...localSplit.routes.map(r => [...r])];
      if (mergedRoutes.length !== K) continue;
      const mergedSplit: SplitResult = {
        routes: mergedRoutes,
        feasible: true,
        usedVehicles: K,
        totalCost: totalRouteCost(inst, mergedRoutes),
      };
      const polished = polishCandidate(
        inst,
        mergedSplit,
        420000 + round * 97 + tried * 13,
        strongMode ? 10 : 8,
        strongMode ? 92 : 70,
        strongMode ? 30 : 24
      );
      if (polished.totalCost + 1e-9 < best.totalCost) {
        best = polished;
        current = polished;
        improved++;
        bestRoundCost = Math.min(bestRoundCost, polished.totalCost);
      } else {
        const worsenLimit = current.totalCost * (1 + (strongMode ? 0.006 : 0.004));
        if (polished.totalCost <= worsenLimit) {
          const delta = polished.totalCost - current.totalCost;
          const accept = delta <= 0 || rng() < Math.exp(-delta / Math.max(1, temp));
          if (accept) {
            current = polished;
            bestRoundCost = Math.min(bestRoundCost, polished.totalCost);
          }
        }
      }
    }
    temp *= 0.92;
  }

  return best.totalCost + 1e-9 < incumbent.totalCost
    ? { split: best, tried, improved }
    : { tried, improved };
}

function routeBundleExactIntensify(
  inst: CvrpInstance,
  incumbent: SplitResult,
  K: number,
  rng: () => number,
  bksLoads?: number[],
  rounds = 4,
  reusePenaltyByRoute?: Map<number, number>
): { split?: SplitResult; tried: number; improved: number; touchedRoutes: number[] } {
  if (!incumbent.feasible || incumbent.routes.length !== K) return { tried: 0, improved: 0, touchedRoutes: [] };
  let current = incumbent;
  let best = incumbent;
  let tried = 0;
  let improved = 0;
  const touchedByBestRound = new Set<number>();
  const strongMode = rounds >= 5;
  const bundleK = strongMode ? 8 : 6;
  const minLoadTarget = Math.floor(inst.capacity * 0.90);
  const penaltyWeight = 22;
  const relaxRatio = strongMode ? 0.006 : 0.004;
  let temp = 200;

  for (let round = 0; round < rounds; round++) {
    const scored = current.routes.map((route, idx) => {
      const load = routeLoad(inst, route);
      const cost = routeCost(inst, route);
      const under = Math.max(0, minLoadTarget - load);
      const depotEdge = edgeCost(inst, inst.depot, route[1]) + edgeCost(inst, route[route.length - 2], inst.depot);
      const overlapPenalty = (reusePenaltyByRoute?.get(idx) ?? 0) * 320;
      const score = cost + 3.5 * under + 0.65 * depotEdge - overlapPenalty;
      return { idx, score };
    });
    const routeIdx = scored
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(bundleK, K))
      .map(x => x.idx);
    if (routeIdx.length < 4) continue;

    const touchedSet = new Set(routeIdx);
    const fixedRoutes = current.routes.filter((_, idx) => !touchedSet.has(idx));
    const fixedCost = totalRouteCost(inst, fixedRoutes);
    const localCustomers = routeIdx.flatMap(ri => current.routes[ri].filter(x => x !== inst.depot));
    const localK = routeIdx.length;

    const angleA = rng() * Math.PI * 2;
    const angleB = angleA + Math.PI / 3;
    const orders = buildLocalOrdersForSeparator(
      inst,
      localCustomers,
      current.routes,
      routeIdx,
      rng,
      [angleA, angleB]
    );
    const branchOrders = boundaryBranchOrders(
      inst,
      orders,
      localCustomers.slice(0, Math.min(localCustomers.length, strongMode ? 10 : 8)),
      [angleA, angleB],
      strongMode ? 12 : 8
    );
    const allOrders = [...new Map([...orders, ...branchOrders].map(o => [o.join(","), o])).values()];
    let bestRoundObj = Number.POSITIVE_INFINITY;
    let bestRoundSplit: SplitResult | undefined;

    for (const order of allOrders) {
      tried++;
      const localSplit = splitExactK(inst, order, localK, bksLoads);
      if (!localSplit.feasible) continue;
      const lowLoadPenalty = localSplit.routes.reduce(
        (s, r) => s + Math.max(0, minLoadTarget - routeLoad(inst, r)),
        0
      );
      const obj = fixedCost + localSplit.totalCost + penaltyWeight * lowLoadPenalty;
      if (obj + 1e-9 >= bestRoundObj * (1 + relaxRatio)) continue;
      const mergedRoutes = [...fixedRoutes.map(r => [...r]), ...localSplit.routes.map(r => [...r])];
      if (mergedRoutes.length !== K) continue;
      bestRoundObj = obj;
      bestRoundSplit = {
        routes: mergedRoutes,
        feasible: true,
        usedVehicles: K,
        totalCost: totalRouteCost(inst, mergedRoutes),
      };
    }

    if (!bestRoundSplit) continue;
    const polished = polishCandidate(
      inst,
      bestRoundSplit,
      530000 + round * 101 + tried * 17,
      strongMode ? 12 : 9,
      strongMode ? 110 : 80,
      strongMode ? 36 : 28
    );
    if (polished.totalCost + 1e-9 < best.totalCost) {
      best = polished;
      current = polished;
      improved++;
      routeIdx.forEach(i => touchedByBestRound.add(i));
    } else {
      const worsenLimit = current.totalCost * (1 + (strongMode ? 0.006 : 0.004));
      if (polished.totalCost <= worsenLimit) {
        const delta = polished.totalCost - current.totalCost;
        const accept = delta <= 0 || rng() < Math.exp(-delta / Math.max(1, temp));
        if (accept) current = polished;
      }
    }
    temp *= 0.93;
  }

  return best.totalCost + 1e-9 < incumbent.totalCost
    ? { split: best, tried, improved, touchedRoutes: [...touchedByBestRound] }
    : { tried, improved, touchedRoutes: [...touchedByBestRound] };
}

function routeBundleChainIntensify(
  inst: CvrpInstance,
  incumbent: SplitResult,
  K: number,
  rng: () => number,
  bksLoads?: number[],
  roundsPerPass = 4
): { split?: SplitResult; tried: number; improved: number; pass1Improved: number; pass2Improved: number } {
  const reusePenalty = new Map<number, number>();
  const p1 = routeBundleExactIntensify(inst, incumbent, K, rng, bksLoads, roundsPerPass, reusePenalty);
  for (const ri of p1.touchedRoutes) reusePenalty.set(ri, (reusePenalty.get(ri) ?? 0) + 1);
  const seedSplit = p1.split ?? incumbent;
  const p2 = routeBundleExactIntensify(inst, seedSplit, K, rng, bksLoads, Math.max(2, roundsPerPass - 1), reusePenalty);

  const bestSplit = p2.split ?? p1.split;
  return {
    split: bestSplit,
    tried: p1.tried + p2.tried,
    improved: p1.improved + p2.improved,
    pass1Improved: p1.improved,
    pass2Improved: p2.improved,
  };
}

function sampleWithoutReplacement(n: number, m: number, rng: () => number): number[] {
  const arr = Array.from({ length: n }, (_, i) => i);
  for (let i = 0; i < arr.length - 1; i++) {
    const j = i + Math.floor(rng() * (arr.length - i));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr.slice(0, Math.max(0, Math.min(m, n)));
}

function srexRouteFragmentCrossover(
  inst: CvrpInstance,
  parentA: HgsIndividual,
  parentB: HgsIndividual,
  rng: () => number
): number[] {
  const child: number[] = [];
  const used = new Set<number>();
  const routesA = parentA.split.routes.map(r => r.filter(id => id !== inst.depot));
  const routesB = parentB.split.routes.map(r => r.filter(id => id !== inst.depot));

  if (routesA.length === 0 || routesB.length === 0) return [...parentA.order];

  // Keep 15%..35% complete routes from parent A.
  const minKeep = Math.max(1, Math.floor(routesA.length * 0.15));
  const maxKeep = Math.max(minKeep, Math.floor(routesA.length * 0.35));
  const keepCount = minKeep + Math.floor(rng() * (maxKeep - minKeep + 1));
  const keepIdx = new Set(sampleWithoutReplacement(routesA.length, keepCount, rng));

  for (let r = 0; r < routesA.length; r++) {
    if (!keepIdx.has(r)) continue;
    for (const id of routesA[r]) {
      if (!used.has(id)) {
        used.add(id);
        child.push(id);
      }
    }
  }

  // Fill with route fragments from parent B while preserving intra-route order.
  for (const route of routesB) {
    for (const id of route) {
      if (!used.has(id)) {
        used.add(id);
        child.push(id);
      }
    }
  }

  // Repair any missing customers (safety).
  for (const id of parentA.order) {
    if (!used.has(id)) {
      used.add(id);
      child.push(id);
    }
  }
  for (const id of parentB.order) {
    if (!used.has(id)) {
      used.add(id);
      child.push(id);
    }
  }

  return child;
}

function srexRouteSetCrossover(
  inst: CvrpInstance,
  parentA: HgsIndividual,
  parentB: HgsIndividual,
  K: number,
  candidateMap: CandidateMap,
  rng: () => number,
  targetLoadsDesc?: number[]
): SplitResult | undefined {
  if (!parentA.split.feasible || !parentB.split.feasible) return undefined;

  const selected: number[][] = [];
  const used = new Set<number>();
  const addRouteIfDisjoint = (route: number[]): boolean => {
    const customers = route.filter(x => x !== inst.depot);
    if (customers.length === 0) return false;
    for (const c of customers) if (used.has(c)) return false;
    const load = customers.reduce((s, c) => s + (inst.demands.get(c) ?? 0), 0);
    if (load > inst.capacity) return false;
    selected.push([inst.depot, ...customers, inst.depot]);
    customers.forEach(c => used.add(c));
    return true;
  };

  const rankParentRoutes = (routes: number[][]): number[][] =>
    routes
      .map(r => r.filter(x => x !== inst.depot))
      .filter(r => r.length > 0)
      .map(r => {
        const full = [inst.depot, ...r, inst.depot];
        const cost = routeCost(inst, full);
        const load = r.reduce((s, c) => s + (inst.demands.get(c) ?? 0), 0);
        const density = r.length / Math.max(1, cost);
        const score = 1.8 * density + 0.6 * (load / Math.max(1, inst.capacity)) - 0.00006 * cost;
        return { r, score };
      })
      .sort((a, b) => b.score - a.score)
      .map(x => x.r);

  const routesA = rankParentRoutes(parentA.split.routes);
  const routesB = rankParentRoutes(parentB.split.routes);

  // Aggressive SREX: preserve larger complete fragments from A before repair.
  const minKeepA = Math.max(1, Math.floor(K * 0.35));
  const maxKeepA = Math.max(minKeepA, Math.floor(K * 0.62));
  const keepA = Math.min(routesA.length, minKeepA + Math.floor(rng() * (maxKeepA - minKeepA + 1)));
  for (let i = 0; i < keepA && selected.length < K; i++) {
    addRouteIfDisjoint([inst.depot, ...routesA[i], inst.depot]);
  }

  // Fill with parent-B route fragments, preserving one slot for decode repair.
  for (const rb of routesB) {
    if (selected.length >= Math.max(0, K - 1)) break;
    addRouteIfDisjoint([inst.depot, ...rb, inst.depot]);
  }

  return decodeWithLockedRoutes(
    inst,
    selected,
    parentA.order,
    parentB.order,
    K,
    candidateMap,
    targetLoadsDesc
  );
}

function buildRouteOfFromSplit(inst: CvrpInstance, split: SplitResult): Map<number, number> {
  const map = new Map<number, number>();
  for (let r = 0; r < split.routes.length; r++) {
    for (const n of split.routes[r]) {
      if (n !== inst.depot) map.set(n, r);
    }
  }
  return map;
}

function buildDiversityPairs(inst: CvrpInstance, k = 14): Array<[number, number]> {
  const candidateMap = buildCandidateMap(inst, k);
  const pairs = new Set<string>();
  for (const [u, neigh] of candidateMap.entries()) {
    for (const v of neigh) {
      const a = Math.min(u, v);
      const b = Math.max(u, v);
      pairs.add(`${a}|${b}`);
    }
  }
  return [...pairs].map(s => {
    const [a, b] = s.split("|").map(Number);
    return [a, b] as [number, number];
  });
}

function brokenPairsDistance(
  routeOfA: Map<number, number>,
  routeOfB: Map<number, number>,
  pairs: Array<[number, number]>
): number {
  if (pairs.length === 0) return 0;
  let denom = 0;
  let broken = 0;
  for (const [u, v] of pairs) {
    const au = routeOfA.get(u);
    const av = routeOfA.get(v);
    const bu = routeOfB.get(u);
    const bv = routeOfB.get(v);
    if (au === undefined || av === undefined || bu === undefined || bv === undefined) continue;
    if (au !== av) continue;
    denom++;
    if (bu !== bv) broken++;
  }
  return denom > 0 ? broken / denom : 0;
}

function diversityContributions(
  population: HgsIndividual[],
  pairs: Array<[number, number]>,
  neighbors = 4
): number[] {
  const n = population.length;
  if (n === 0) return [];
  if (n === 1) return [0];
  const out = Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const dists: number[] = [];
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      dists.push(brokenPairsDistance(population[i].routeOf, population[j].routeOf, pairs));
    }
    dists.sort((a, b) => b - a);
    const take = Math.min(neighbors, dists.length);
    let acc = 0;
    for (let k = 0; k < take; k++) acc += dists[k];
    out[i] = take > 0 ? acc / take : 0;
  }
  return out;
}

function trimPopulationByDiversity(
  population: HgsIndividual[],
  cap: number,
  pairs: Array<[number, number]>
): void {
  if (population.length <= cap) return;
  while (population.length > cap) {
    population.sort((a, b) => a.split.totalCost - b.split.totalCost);
    const n = population.length;
    const div = diversityContributions(population, pairs, 4);
    const bestCost = population[0].split.totalCost;
    const fit: Array<{ idx: number; score: number }> = [];
    for (let i = 0; i < n; i++) {
      const relCost = (population[i].split.totalCost - bestCost) / Math.max(1, bestCost);
      const crowdPenalty = 1 - div[i];
      fit.push({ idx: i, score: relCost + 0.65 * crowdPenalty });
    }
    fit.sort((a, b) => b.score - a.score);
    const drop = fit[0].idx;
    population.splice(drop, 1);
  }
}

function chooseDiverseAnchorsForIntensify(
  inst: CvrpInstance,
  candidates: Array<{ name: string; split: SplitResult }>,
  maxAnchors = 3
): Array<{ name: string; split: SplitResult }> {
  const ranked = [...candidates]
    .filter(c => c.split.feasible)
    .sort((a, b) => a.split.totalCost - b.split.totalCost)
    .slice(0, 12);
  if (ranked.length <= 1) return ranked.slice(0, maxAnchors);

  const pairs = buildDiversityPairs(inst, 12);
  const routeOf = ranked.map(c => buildRouteOfFromSplit(inst, c.split));
  const selectedIdx: number[] = [0];
  const target = Math.min(maxAnchors, ranked.length);

  while (selectedIdx.length < target) {
    let pick = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < ranked.length; i++) {
      if (selectedIdx.includes(i)) continue;
      let minD = Number.POSITIVE_INFINITY;
      for (const j of selectedIdx) {
        const d = brokenPairsDistance(routeOf[i], routeOf[j], pairs);
        if (d < minD) minD = d;
      }
      const relCost =
        (ranked[i].split.totalCost - ranked[0].split.totalCost) / Math.max(1, ranked[0].split.totalCost);
      const score = minD - 0.25 * relCost;
      if (score > bestScore) {
        bestScore = score;
        pick = i;
      }
    }
    if (pick < 0) break;
    if (bestScore < 0.08 && selectedIdx.length >= 2) break;
    selectedIdx.push(pick);
  }

  return selectedIdx.map(i => ranked[i]);
}

function writeBestSolution(inst: CvrpInstance, best: { name: string; split: SplitResult }): { jsonPath: string; solPath: string } {
  const dir = "test/benchmark_results";
  mkdirSync(dir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const base = `${inst.name}_${ts}`;
  const jsonPath = `${dir}/${base}.json`;
  const solPath = `${dir}/${base}.sol`;

  const payload = {
    instance: inst.name,
    dimension: inst.dimension,
    capacity: inst.capacity,
    candidate: best.name,
    totalCost: best.split.totalCost,
    usedVehicles: best.split.usedVehicles,
    routes: best.split.routes,
  };
  writeFileSync(jsonPath, JSON.stringify(payload, null, 2), "utf8");

  const solLines = best.split.routes.map((route, idx) => {
    const inner = route.filter(id => id !== inst.depot).join(" ");
    return `Route #${idx + 1}: ${inner}`;
  });
  solLines.push(`Cost ${best.split.totalCost}`);
  writeFileSync(solPath, `${solLines.join("\n")}\n`, "utf8");

  return { jsonPath, solPath };
}

function validateHistoricalRoutes(inst: CvrpInstance, routes: number[][], expectedVehicles: number): SplitResult | undefined {
  if (routes.length !== expectedVehicles) return undefined;
  const customers = Array.from(inst.nodes.keys()).filter(id => id !== inst.depot);
  const seen = new Set<number>();

  for (const route of routes) {
    if (route.length < 2) return undefined;
    if (route[0] !== inst.depot || route[route.length - 1] !== inst.depot) return undefined;
    const load = routeLoad(inst, route);
    if (load > inst.capacity) return undefined;
    for (const id of route) {
      if (id === inst.depot) continue;
      if (!inst.nodes.has(id)) return undefined;
      if (seen.has(id)) return undefined;
      seen.add(id);
    }
  }

  if (seen.size !== customers.length) return undefined;
  for (const c of customers) {
    if (!seen.has(c)) return undefined;
  }

  return {
    routes: cloneRoutes(routes),
    feasible: true,
    usedVehicles: expectedVehicles,
    totalCost: totalRouteCost(inst, routes),
  };
}

function loadBestHistoricalSeed(inst: CvrpInstance, vehicles: number): { split: SplitResult; source: string; candidate: string } | undefined {
  const dir = "test/benchmark_results";
  let files: string[];
  try {
    files = readdirSync(dir).filter(f => f.endsWith(".json"));
  } catch {
    return undefined;
  }

  let best: { split: SplitResult; source: string; candidate: string } | undefined;
  for (const file of files) {
    const path = `${dir}/${file}`;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as {
        instance?: string;
        routes?: number[][];
        candidate?: string;
        totalCost?: number;
      };
      if (raw.instance !== inst.name || !Array.isArray(raw.routes)) continue;
      const split = validateHistoricalRoutes(inst, raw.routes, vehicles);
      if (!split) continue;
      if (!best || split.totalCost < best.split.totalCost) {
        best = {
          split,
          source: file,
          candidate: raw.candidate ?? "unknown",
        };
      }
    } catch {
      continue;
    }
  }
  return best;
}

function loadPinnedHistoricalSeed(
  inst: CvrpInstance,
  vehicles: number
): { split: SplitResult; source: string; candidate: string } | undefined {
  const dir = "test/benchmark_results/pinned";
  const path = `${dir}/${inst.name}_best.json`;
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      instance?: string;
      routes?: number[][];
      candidate?: string;
      totalCost?: number;
      source?: string;
    };
    if (raw.instance !== inst.name || !Array.isArray(raw.routes)) return undefined;
    const split = validateHistoricalRoutes(inst, raw.routes, vehicles);
    if (!split) return undefined;
    return {
      split,
      source: raw.source ?? `${inst.name}_best.json`,
      candidate: raw.candidate ?? "pinned",
    };
  } catch {
    return undefined;
  }
}

function writePinnedBestSolution(
  inst: CvrpInstance,
  best: { name: string; split: SplitResult },
  sourceFile: string
): string {
  const dir = "test/benchmark_results/pinned";
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/${inst.name}_best.json`;
  const payload = {
    instance: inst.name,
    dimension: inst.dimension,
    capacity: inst.capacity,
    candidate: best.name,
    totalCost: best.split.totalCost,
    usedVehicles: best.split.usedVehicles,
    routes: best.split.routes,
    source: sourceFile,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(path, JSON.stringify(payload, null, 2), "utf8");
  return path;
}

function pruneHistoricalCache(inst: CvrpInstance, vehicles: number, keep = 16): { kept: number; removed: number } {
  const dir = "test/benchmark_results";
  let files: string[];
  try {
    files = readdirSync(dir).filter(f => f.endsWith(".json"));
  } catch {
    return { kept: 0, removed: 0 };
  }

  const valid: Array<{ file: string; cost: number }> = [];
  for (const file of files) {
    const path = `${dir}/${file}`;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as {
        instance?: string;
        routes?: number[][];
        totalCost?: number;
      };
      if (raw.instance !== inst.name || !Array.isArray(raw.routes)) continue;
      const split = validateHistoricalRoutes(inst, raw.routes, vehicles);
      if (!split) continue;
      valid.push({ file, cost: split.totalCost });
    } catch {
      continue;
    }
  }

  valid.sort((a, b) => a.cost - b.cost);
  const keepSet = new Set(valid.slice(0, Math.max(0, keep)).map(x => x.file));
  let removed = 0;
  for (const item of valid) {
    if (keepSet.has(item.file)) continue;
    try {
      unlinkSync(`${dir}/${item.file}`);
      removed++;
    } catch {
      // ignore prune failures
    }
  }
  return { kept: keepSet.size, removed };
}

function percentGap(value: number, bks: number): number {
  return ((value - bks) / bks) * 100;
}

function summarizeLoads(inst: CvrpInstance, routes: number[][]): { min: number; max: number; avg: number } {
  if (routes.length === 0) return { min: 0, max: 0, avg: 0 };
  const loads = routes.map(r => routeLoad(inst, r));
  const min = Math.min(...loads);
  const max = Math.max(...loads);
  const avg = loads.reduce((s, v) => s + v, 0) / loads.length;
  return { min, max, avg };
}

type RouteOverlapPair = {
  i: number;
  j: number;
  score: number;
  moved: number;
  denom: number;
};

type HubScore = {
  node: number;
  score: number;
  crossNeighbors: number;
  depotDist: number;
};

type StructuralDiagnostics = {
  overlapPairs: RouteOverlapPair[];
  hubs: HubScore[];
  seamCostRatio: number;
  dominant: "dense-minor" | "sunflower-core" | "mixed";
};

type SeamKillerStats = {
  rounds: number;
  accepted: number;
  candidates: number;
  seamBefore: number;
  seamAfter: number;
  costBefore: number;
  costAfter: number;
};

function routeSeamContribution(inst: CvrpInstance, route: number[], bandFraction = 0.2): number {
  const inner = route.filter(id => id !== inst.depot);
  if (inner.length === 0) return 0;
  const band = Math.max(1, Math.floor(inner.length * bandFraction));
  const boundary = new Set<number>([
    ...inner.slice(0, Math.min(inner.length, band)),
    ...inner.slice(Math.max(0, inner.length - band)),
  ]);
  let seam = 0;
  let total = 0;
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i];
    const b = route[i + 1];
    const c = edgeCost(inst, a, b);
    total += c;
    if ((a !== inst.depot && boundary.has(a)) || (b !== inst.depot && boundary.has(b))) seam += c;
  }
  return total > 0 ? seam / total : 0;
}

function selectMacroRouteSet(
  inst: CvrpInstance,
  split: SplitResult,
  diag: StructuralDiagnostics,
  maxRoutes = 4
): number[] {
  const score = new Map<number, number>();
  for (const p of diag.overlapPairs.slice(0, 10)) {
    score.set(p.i, (score.get(p.i) ?? 0) + 2.0 * p.score);
    score.set(p.j, (score.get(p.j) ?? 0) + 2.0 * p.score);
  }
  for (let r = 0; r < split.routes.length; r++) {
    const seam = routeSeamContribution(inst, split.routes[r], 0.2);
    score.set(r, (score.get(r) ?? 0) + seam);
  }
  const ranked = [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(x => x[0]);
  const picked = ranked.slice(0, Math.max(3, Math.min(maxRoutes, ranked.length)));
  return [...new Set(picked)].sort((a, b) => a - b);
}

function boundaryExactSubsolverLocal(
  inst: CvrpInstance,
  localRoutes: number[][],
  maxBoundaryNodes = 20
): number[][] {
  if (localRoutes.length === 0) return localRoutes;
  const band = 3;
  const pendingSet = new Set<number>();
  const cores: number[][] = [];
  const coreLoads: number[] = [];

  for (const route of localRoutes) {
    const inner = route.filter(id => id !== inst.depot);
    const b = Math.min(band, Math.floor(Math.max(1, inner.length) / 2));
    const coreStart = Math.min(inner.length, b);
    const coreEnd = Math.max(coreStart, inner.length - b);
    const boundary = [
      ...inner.slice(0, coreStart),
      ...inner.slice(coreEnd),
    ];
    for (const n of boundary) pendingSet.add(n);
    const core = inner.slice(coreStart, coreEnd);
    const rebuilt = [inst.depot, ...core, inst.depot];
    cores.push(rebuilt);
    coreLoads.push(routeLoad(inst, rebuilt));
  }

  const pending = [...pendingSet].slice(0, maxBoundaryNodes);
  pending.sort((a, b) => (inst.demands.get(b) ?? 0) - (inst.demands.get(a) ?? 0));

  for (const node of pending) {
    const dem = inst.demands.get(node) ?? 0;
    let bestRoute = -1;
    let bestCand: number[] | undefined;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (let r = 0; r < cores.length; r++) {
      if (coreLoads[r] + dem > inst.capacity) continue;
      const cand = tryInsertBestPosition(inst, cores[r], node);
      if (cand.delta < bestDelta) {
        bestDelta = cand.delta;
        bestRoute = r;
        bestCand = cand.route;
      }
    }
    if (bestRoute >= 0 && bestCand) {
      cores[bestRoute] = bestCand;
      coreLoads[bestRoute] += dem;
    } else {
      // fallback: put back into least loaded feasible route
      let idx = -1;
      let bestSlack = Number.POSITIVE_INFINITY;
      for (let r = 0; r < cores.length; r++) {
        if (coreLoads[r] + dem > inst.capacity) continue;
        const slack = inst.capacity - (coreLoads[r] + dem);
        if (slack < bestSlack) {
          bestSlack = slack;
          idx = r;
        }
      }
      if (idx >= 0) {
        const pos = tryInsertBestPosition(inst, cores[idx], node);
        cores[idx] = pos.route;
        coreLoads[idx] += dem;
      }
    }
  }

  const improved = improveRoutes2Opt(inst, cores).routes;
  return improved;
}

function macroRepartitionOneCycle(
  inst: CvrpInstance,
  split: SplitResult,
  K: number,
  rng: () => number
): SplitResult | undefined {
  if (!split.feasible || split.routes.length !== K) return undefined;
  const diag = computeStructuralDiagnostics(inst, split.routes);
  if (diag.seamCostRatio <= 0.65) return undefined;

  const chosen = selectMacroRouteSet(inst, split, diag, 4);
  if (chosen.length < 3) return undefined;

  const pooled = chosen.flatMap(idx => split.routes[idx].filter(x => x !== inst.depot));
  if (pooled.length < 12) return undefined;
  const kLocal = chosen.length;
  const seedNode = pooled[Math.floor(rng() * pooled.length)];
  const orders = [
    nearestNeighborOrderFromSeed(inst, pooled, seedNode),
    nearestNeighborOrderWithinSet(inst, pooled),
    kmeansOrderFromCustomers(inst, pooled, kLocal, Math.floor(rng() * 1_000_000) + 7),
  ];

  let bestLocal: SplitResult | undefined;
  for (const order of orders) {
    const local = splitExactK(inst, order, kLocal);
    if (!local.feasible || local.routes.length !== kLocal) continue;
    const localRefinedRoutes = boundaryExactSubsolverLocal(inst, local.routes, 20);
    const candidateLocal: SplitResult = {
      routes: localRefinedRoutes,
      feasible: true,
      usedVehicles: kLocal,
      totalCost: totalRouteCost(inst, localRefinedRoutes),
    };
    if (!bestLocal || candidateLocal.totalCost < bestLocal.totalCost) bestLocal = candidateLocal;
  }
  if (!bestLocal) return undefined;

  const nextRoutes = split.routes.map(r => [...r]);
  for (let i = 0; i < chosen.length; i++) {
    nextRoutes[chosen[i]] = bestLocal.routes[i];
  }
  const next: SplitResult = {
    routes: nextRoutes,
    feasible: true,
    usedVehicles: K,
    totalCost: totalRouteCost(inst, nextRoutes),
  };

  const nextDiag = computeStructuralDiagnostics(inst, next.routes);
  const improveRatio = (split.totalCost - next.totalCost) / Math.max(1, split.totalCost);
  const seamDrop = diag.seamCostRatio - nextDiag.seamCostRatio;
  // Accept strict improvements first, and allow subtle near-neutral moves if they
  // clearly reduce seam pressure (often unlocked by later intensification).
  if (improveRatio >= 0.00035 && seamDrop >= -1e-9) return next;
  if (seamDrop >= 0.035 && improveRatio >= -0.0015) return next;
  return undefined;
}

function pooledGroupExactRepartition(
  inst: CvrpInstance,
  split: SplitResult,
  K: number,
  rng: () => number,
  minGroup = 4,
  maxGroup = 8
): SplitResult | undefined {
  if (!split.feasible || split.routes.length !== K) return undefined;
  const diag = computeStructuralDiagnostics(inst, split.routes);
  if (diag.seamCostRatio <= 0.66 || diag.overlapPairs.length === 0) return undefined;

  const desired = Math.max(minGroup, Math.min(maxGroup, 4 + Math.floor(rng() * 5)));
  const chosen = selectMacroRouteSet(inst, split, diag, desired);
  if (chosen.length < minGroup) return undefined;
  const kLocal = chosen.length;

  const pooled = chosen.flatMap(idx => split.routes[idx].filter(x => x !== inst.depot));
  if (pooled.length < kLocal * 3) return undefined;
  const pooledSet = new Set<number>(pooled);
  const currentLoads = chosen.map(idx => routeLoad(inst, split.routes[idx])).sort((a, b) => b - a);
  const seedNode = pooled[Math.floor(rng() * pooled.length)];

  const orders = [
    nearestNeighborOrderFromSeed(inst, pooled, seedNode),
    nearestNeighborOrderWithinSet(inst, pooled),
    buildSweepOrder(inst, false, 0).filter(id => pooledSet.has(id)),
    buildSweepOrder(inst, true, 0).filter(id => pooledSet.has(id)),
    kmeansOrderFromCustomers(inst, pooled, kLocal, Math.floor(rng() * 1_000_000) + 41),
    kmeansOrderFromCustomers(inst, pooled, Math.max(6, kLocal + 1), Math.floor(rng() * 1_000_000) + 79),
  ];

  let bestLocal: SplitResult | undefined;
  for (const order of orders) {
    if (order.length !== pooled.length) continue;
    const local = splitExactK(inst, order, kLocal, currentLoads);
    if (!local.feasible || local.routes.length !== kLocal) continue;
    const localBoundary = boundaryExactSubsolverLocal(inst, local.routes, 28);
    const localMap = buildCandidateMap(inst, 24);
    const localSeam = seamDrivenPairRepair(inst, localBoundary, localMap, 2, Math.min(4, Math.max(2, kLocal - 1)));
    const localRefined = improveRoutes2Opt(inst, localSeam.routes);
    const candidateLocal: SplitResult = {
      routes: localRefined.routes,
      feasible: true,
      usedVehicles: kLocal,
      totalCost: localRefined.totalCost,
    };
    if (!bestLocal || candidateLocal.totalCost < bestLocal.totalCost) bestLocal = candidateLocal;
  }
  if (!bestLocal) return undefined;

  const nextRoutes = split.routes.map(r => [...r]);
  for (let i = 0; i < chosen.length; i++) nextRoutes[chosen[i]] = bestLocal.routes[i];
  const next: SplitResult = {
    routes: nextRoutes,
    feasible: true,
    usedVehicles: K,
    totalCost: totalRouteCost(inst, nextRoutes),
  };

  const nextDiag = computeStructuralDiagnostics(inst, next.routes);
  return shouldAcceptTopologyRewrite(split, next, diag.seamCostRatio, nextDiag.seamCostRatio)
    ? next
    : undefined;
}

function seamEscapePhase(
  inst: CvrpInstance,
  split: SplitResult,
  K: number,
  rng: () => number,
  maxCycles = 2
): SplitResult | undefined {
  if (!split.feasible || split.routes.length !== K) return undefined;
  let current = split;
  let accepted = 0;

  for (let cyc = 0; cyc < maxCycles; cyc++) {
    const diag = computeStructuralDiagnostics(inst, current.routes);
    if (diag.seamCostRatio <= 0.68) break;

    const pooled = pooledGroupExactRepartition(inst, current, K, rng, 4, 8);
    const bo = boundaryOverlapExactPass(inst, current, K, rng, 1);
    const macro = macroRepartitionOneCycle(inst, current, K, rng);
    const candidates: SplitResult[] = [];
    if (pooled) candidates.push(pooled);
    if (bo.split) candidates.push(bo.split);
    if (macro) candidates.push(macro);
    if (candidates.length === 0) break;

    let bestNext: SplitResult | undefined;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const cand of candidates) {
      const candDiag = computeStructuralDiagnostics(inst, cand.routes);
      const improveRatio = (current.totalCost - cand.totalCost) / Math.max(1, current.totalCost);
      const seamDrop = diag.seamCostRatio - candDiag.seamCostRatio;
      const accept =
        improveRatio >= 0.0002 ||
        (seamDrop >= 0.02 && improveRatio >= -0.0040) ||
        (seamDrop >= 0.04 && improveRatio >= -0.0060);
      if (!accept) continue;

      const score = seamDrop * 1000 + improveRatio * 400;
      if (score > bestScore) {
        bestScore = score;
        bestNext = cand;
      }
    }

    if (!bestNext) break;
    current = bestNext;
    accepted++;
  }

  return accepted > 0 ? current : undefined;
}

function boundaryOverlapExactPass(
  inst: CvrpInstance,
  split: SplitResult,
  K: number,
  rng: () => number,
  cycles = 2
): { split?: SplitResult; tried: number; accepted: number } {
  if (!split.feasible || split.routes.length !== K) return { tried: 0, accepted: 0 };
  let current = split;
  let tried = 0;
  let accepted = 0;

  for (let cyc = 0; cyc < cycles; cyc++) {
    const diag = computeStructuralDiagnostics(inst, current.routes);
    if (diag.overlapPairs.length === 0) break;

    const chosenSet = new Set<number>();
    const maxPairs = cyc === 0 ? 5 : 4;
    for (const p of diag.overlapPairs.slice(0, 10)) {
      chosenSet.add(p.i);
      chosenSet.add(p.j);
      if (chosenSet.size >= maxPairs) break;
    }
    const chosen = [...chosenSet].sort((a, b) => a - b);
    if (chosen.length < 3) break;

    const pooled = chosen.flatMap(idx => current.routes[idx].filter(x => x !== inst.depot));
    if (pooled.length < 12) continue;
    tried++;
    const kLocal = chosen.length;
    const seedNode = pooled[Math.floor(rng() * pooled.length)];
    const pooledSet = new Set<number>(pooled);
    const orders = [
      nearestNeighborOrderFromSeed(inst, pooled, seedNode),
      nearestNeighborOrderWithinSet(inst, pooled),
      buildSweepOrder(inst, false, 0).filter(id => pooledSet.has(id)),
      kmeansOrderFromCustomers(inst, pooled, kLocal, Math.floor(rng() * 1_000_000) + 19),
    ];

    let bestLocal: SplitResult | undefined;
    for (const order of orders) {
      if (order.length !== pooled.length) continue;
      const local = splitExactK(inst, order, kLocal);
      if (!local.feasible || local.routes.length !== kLocal) continue;
      const localRefinedRoutes = boundaryExactSubsolverLocal(inst, local.routes, 24);
      const candidateLocal: SplitResult = {
        routes: localRefinedRoutes,
        feasible: true,
        usedVehicles: kLocal,
        totalCost: totalRouteCost(inst, localRefinedRoutes),
      };
      if (!bestLocal || candidateLocal.totalCost < bestLocal.totalCost) bestLocal = candidateLocal;
    }
    if (!bestLocal) continue;

    const nextRoutes = current.routes.map(r => [...r]);
    for (let i = 0; i < chosen.length; i++) nextRoutes[chosen[i]] = bestLocal.routes[i];
    const next: SplitResult = {
      routes: nextRoutes,
      feasible: true,
      usedVehicles: K,
      totalCost: totalRouteCost(inst, nextRoutes),
    };

    const nextDiag = computeStructuralDiagnostics(inst, next.routes);
    const improveRatio = (current.totalCost - next.totalCost) / Math.max(1, current.totalCost);
    const seamDrop = diag.seamCostRatio - nextDiag.seamCostRatio;
    if (improveRatio >= 0.00025 || (seamDrop >= 0.02 && improveRatio >= -0.0008)) {
      current = next;
      accepted++;
    }
  }

  return accepted > 0 ? { split: current, tried, accepted } : { tried, accepted };
}

function repartitionTopOverlap(
  inst: CvrpInstance,
  split: SplitResult,
  K: number,
  seamDiag: StructuralDiagnostics,
  minGainRatio = 0.001
): SplitResult {
  if (!split.feasible || seamDiag.seamCostRatio < 0.65) return split;
  if (seamDiag.overlapPairs.length === 0) return split;
  const { i, j } = seamDiag.overlapPairs[0];
  if (i < 0 || j < 0 || i >= split.routes.length || j >= split.routes.length) return split;

  const mergedCustomers = [
    ...split.routes[i].filter(x => x !== inst.depot),
    ...split.routes[j].filter(x => x !== inst.depot),
  ];
  if (mergedCustomers.length === 0) return split;
  const order = nearestNeighborOrderWithinSet(inst, mergedCustomers);
  const local = splitExactK(inst, order, 2);
  if (!local.feasible || local.routes.length !== 2) return split;

  const newRoutes = split.routes.map(r => [...r]);
  newRoutes[i] = local.routes[0];
  newRoutes[j] = local.routes[1];
  const newSplit: SplitResult = {
    feasible: true,
    usedVehicles: split.usedVehicles,
    routes: newRoutes,
    totalCost: totalRouteCost(inst, newRoutes),
  };

  const gain = split.totalCost - newSplit.totalCost;
  const newDiag = computeStructuralDiagnostics(inst, newSplit.routes);
  const seamDrop = seamDiag.seamCostRatio - newDiag.seamCostRatio;
  // Keep strict acceptance but allow subtle/topology-improving candidates.
  const strictAccept = gain > split.totalCost * minGainRatio && seamDrop >= -1e-9;
  const subtleAccept = seamDrop >= 0.03 && gain >= -split.totalCost * 0.0008;
  if (!strictAccept && !subtleAccept) return split;
  return newSplit;
}

function computeOverlapPairs(inst: CvrpInstance, routes: number[][]): RouteOverlapPair[] {
  const centroids = routes.map(r => computeRouteCentroid(inst, r));
  const customersByRoute = routes.map(r => r.filter(id => id !== inst.depot));
  const movedMatrix: number[][] = Array.from({ length: routes.length }, () => Array(routes.length).fill(0));

  for (let ri = 0; ri < customersByRoute.length; ri++) {
    for (const node of customersByRoute[ri]) {
      const p = must(inst.nodes.get(node), `Missing node ${node}`);
      const own = centroids[ri];
      const ownD = Math.hypot(p.x - own.x, p.y - own.y);
      let bestOther = ri;
      let bestOtherD = Number.POSITIVE_INFINITY;
      for (let rj = 0; rj < centroids.length; rj++) {
        if (rj === ri) continue;
        const c = centroids[rj];
        const d = Math.hypot(p.x - c.x, p.y - c.y);
        if (d < bestOtherD) {
          bestOtherD = d;
          bestOther = rj;
        }
      }
      if (bestOther !== ri && bestOtherD < ownD) movedMatrix[ri][bestOther] += 1;
    }
  }

  const pairs: RouteOverlapPair[] = [];
  for (let i = 0; i < routes.length; i++) {
    for (let j = i + 1; j < routes.length; j++) {
      const moved = movedMatrix[i][j] + movedMatrix[j][i];
      const denom = customersByRoute[i].length + customersByRoute[j].length;
      const score = denom > 0 ? moved / denom : 0;
      pairs.push({ i, j, score, moved, denom });
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  return pairs;
}

function computeRouteCentroid(inst: CvrpInstance, route: number[]): { x: number; y: number } {
  const customers = route.filter(id => id !== inst.depot);
  if (customers.length === 0) {
    const d = must(inst.nodes.get(inst.depot), "Missing depot.");
    return { x: d.x, y: d.y };
  }
  let sx = 0;
  let sy = 0;
  for (const id of customers) {
    const p = must(inst.nodes.get(id), `Missing node ${id}`);
    sx += p.x;
    sy += p.y;
  }
  return { x: sx / customers.length, y: sy / customers.length };
}

function computeStructuralDiagnostics(inst: CvrpInstance, routes: number[][]): StructuralDiagnostics {
  const customersByRoute = routes.map(r => r.filter(id => id !== inst.depot));
  const routeOf = new Map<number, number>();
  customersByRoute.forEach((arr, ri) => arr.forEach(id => routeOf.set(id, ri)));
  const overlapPairs = computeOverlapPairs(inst, routes);

  const customers = Array.from(routeOf.keys());
  const depot = must(inst.nodes.get(inst.depot), "Missing depot.");
  const hubs: HubScore[] = [];
  const kNear = 12;
  for (const n of customers) {
    const p = must(inst.nodes.get(n), `Missing node ${n}`);
    const r = routeOf.get(n)!;
    const neigh = customers
      .filter(m => m !== n)
      .map(m => {
        const q = must(inst.nodes.get(m), `Missing node ${m}`);
        return { m, d: Math.hypot(p.x - q.x, p.y - q.y) };
      })
      .sort((a, b) => a.d - b.d)
      .slice(0, kNear);

    const crossNeighbors = neigh.filter(v => routeOf.get(v.m) !== r).length;
    const depotDist = Math.hypot(p.x - depot.x, p.y - depot.y);
    const score = crossNeighbors * 10 - 0.05 * depotDist;
    hubs.push({ node: n, score, crossNeighbors, depotDist });
  }
  hubs.sort((a, b) => b.score - a.score);

  const denseMinorSignal = overlapPairs.length > 0 ? overlapPairs[0].score : 0;
  const sunflowerSignal = hubs.length > 0 ? hubs[0].crossNeighbors / 12 : 0;
  let seamCost = 0;
  let totalCost = 0;
  for (const route of routes) {
    const inner = route.filter(id => id !== inst.depot);
    const band = Math.max(1, Math.floor(inner.length * 0.2));
    const boundary = new Set<number>([
      ...inner.slice(0, Math.min(inner.length, band)),
      ...inner.slice(Math.max(0, inner.length - band)),
    ]);
    for (let i = 0; i < route.length - 1; i++) {
      const a = route[i];
      const b = route[i + 1];
      const c = edgeCost(inst, a, b);
      totalCost += c;
      const seamEdge = (a !== inst.depot && boundary.has(a)) || (b !== inst.depot && boundary.has(b));
      if (seamEdge) seamCost += c;
    }
  }
  const seamCostRatio = totalCost > 0 ? seamCost / totalCost : 0;
  const dominant: "dense-minor" | "sunflower-core" | "mixed" =
    denseMinorSignal >= sunflowerSignal ? "dense-minor" : "sunflower-core";

  return {
    overlapPairs: overlapPairs.slice(0, 12),
    hubs: hubs.slice(0, 60),
    seamCostRatio,
    dominant,
  };
}

function computeTopOverlapPair(inst: CvrpInstance, routes: number[][]): { i: number; j: number; score: number } | undefined {
  if (routes.length < 2) return undefined;
  const centroids = routes.map(r => computeRouteCentroid(inst, r));
  const customersByRoute = routes.map(r => r.filter(id => id !== inst.depot));

  let best: { i: number; j: number; score: number } | undefined;
  for (let i = 0; i < routes.length; i++) {
    for (let j = i + 1; j < routes.length; j++) {
      let moved = 0;
      const denom = customersByRoute[i].length + customersByRoute[j].length;
      if (denom === 0) continue;

      for (const node of customersByRoute[i]) {
        const p = must(inst.nodes.get(node), `Missing node ${node}`);
        const dOwn = Math.hypot(p.x - centroids[i].x, p.y - centroids[i].y);
        const dOther = Math.hypot(p.x - centroids[j].x, p.y - centroids[j].y);
        if (dOther < dOwn) moved++;
      }
      for (const node of customersByRoute[j]) {
        const p = must(inst.nodes.get(node), `Missing node ${node}`);
        const dOwn = Math.hypot(p.x - centroids[j].x, p.y - centroids[j].y);
        const dOther = Math.hypot(p.x - centroids[i].x, p.y - centroids[i].y);
        if (dOther < dOwn) moved++;
      }

      const score = moved / denom;
      if (!best || score > best.score) best = { i, j, score };
    }
  }
  return best;
}

function refineDenseMinorPairs(
  inst: CvrpInstance,
  routes: number[][],
  overlapPairs: RouteOverlapPair[],
  maxPairs = 6
): { routes: number[][]; totalCost: number } {
  const out = cloneRoutes(routes);
  let improved = false;

  for (let t = 0; t < Math.min(maxPairs, overlapPairs.length); t++) {
    const { i, j } = overlapPairs[t];
    const a = out[i];
    const b = out[j];
    const customers = [...a.filter(x => x !== inst.depot), ...b.filter(x => x !== inst.depot)];
    if (customers.length < 4) continue;

    const localOrder = nearestNeighborOrderWithinSet(inst, customers);
    const split = splitExactK(inst, localOrder, 2);
    if (!split.feasible || split.routes.length !== 2) continue;

    const candidateA = twoOptRoute(inst, split.routes[0]);
    const candidateB = twoOptRoute(inst, split.routes[1]);
    const oldCost = routeCost(inst, a) + routeCost(inst, b);
    const newCost = routeCost(inst, candidateA) + routeCost(inst, candidateB);
    if (newCost + 1e-9 < oldCost) {
      out[i] = candidateA;
      out[j] = candidateB;
      improved = true;
    }
  }

  return improved ? { routes: out, totalCost: totalRouteCost(inst, out) } : { routes, totalCost: totalRouteCost(inst, routes) };
}

function pairScoreFromMap(a: number, b: number, map: Map<string, number>): number {
  const i = Math.min(a, b);
  const j = Math.max(a, b);
  return map.get(`${i}|${j}`) ?? 0;
}

function findModPTriples(
  routeCount: number,
  overlapPairs: RouteOverlapPair[],
  threshold = 0.15,
  maxClusters = 12
): number[][] {
  const map = new Map<string, number>();
  for (const p of overlapPairs) map.set(`${Math.min(p.i, p.j)}|${Math.max(p.i, p.j)}`, p.score);

  const clusters: number[][] = [];
  const seen = new Set<string>();

  for (const p of overlapPairs) {
    if (p.score < threshold) break;
    let set = [p.i, p.j];

    // Add nodes connected to all current nodes, up to 5-route block.
    for (let candidate = 0; candidate < routeCount && set.length < 5; candidate++) {
      if (set.includes(candidate)) continue;
      let ok = true;
      for (const s of set) {
        if (pairScoreFromMap(candidate, s, map) < threshold) {
          ok = false;
          break;
        }
      }
      if (ok) set.push(candidate);
    }

    if (set.length >= 3) {
      set = [...set].sort((a, b) => a - b);
      const key = set.join(",");
      if (!seen.has(key)) {
        seen.add(key);
        clusters.push(set);
      }
    }

    if (clusters.length >= maxClusters) break;
  }

  return clusters;
}

function kmeansOrderFromCustomers(
  inst: CvrpInstance,
  customers: number[],
  k: number,
  seed: number
): number[] {
  if (customers.length === 0) return [];
  const rng = makeRng(seed);
  const points = customers.map(id => ({ id, p: must(inst.nodes.get(id), `Missing node ${id}`) }));

  // Seed centroids from random points.
  const centroids: Array<{ x: number; y: number }> = [];
  const taken = new Set<number>();
  while (centroids.length < k && taken.size < points.length) {
    const idx = Math.floor(rng() * points.length);
    if (taken.has(idx)) continue;
    taken.add(idx);
    centroids.push({ x: points[idx].p.x, y: points[idx].p.y });
  }
  while (centroids.length < k) centroids.push({ ...centroids[0] });

  let labels = Array(points.length).fill(0);
  for (let iter = 0; iter < 8; iter++) {
    // assign
    for (let i = 0; i < points.length; i++) {
      let best = 0;
      let bestD = Number.POSITIVE_INFINITY;
      for (let c = 0; c < k; c++) {
        const dx = points[i].p.x - centroids[c].x;
        const dy = points[i].p.y - centroids[c].y;
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      labels[i] = best;
    }
    // update
    const sx = Array(k).fill(0);
    const sy = Array(k).fill(0);
    const cnt = Array(k).fill(0);
    for (let i = 0; i < points.length; i++) {
      const c = labels[i];
      sx[c] += points[i].p.x;
      sy[c] += points[i].p.y;
      cnt[c] += 1;
    }
    for (let c = 0; c < k; c++) {
      if (cnt[c] > 0) {
        centroids[c].x = sx[c] / cnt[c];
        centroids[c].y = sy[c] / cnt[c];
      }
    }
  }

  const depot = must(inst.nodes.get(inst.depot), "Missing depot.");
  const centroidAngles = centroids.map((c, idx) => ({
    idx,
    a: Math.atan2(c.y - depot.y, c.x - depot.x),
  })).sort((u, v) => u.a - v.a);

  const clusterOrder = centroidAngles.map(x => x.idx);
  const ordered: number[] = [];
  for (const cidx of clusterOrder) {
    const members = points.filter((_, i) => labels[i] === cidx).map(x => x.id);
    const seq = nearestNeighborOrderWithinSet(inst, members);
    ordered.push(...seq);
  }
  return ordered;
}

function refineModPCluster(
  inst: CvrpInstance,
  routes: number[][],
  cluster: number[]
): { routes: number[][]; totalCost: number; improved: boolean } {
  const out = cloneRoutes(routes);
  const pooled = cluster.flatMap(r => out[r].filter(id => id !== inst.depot));
  const K = cluster.length;
  if (pooled.length < K * 2) return { routes, totalCost: totalRouteCost(inst, routes), improved: false };

  const oldCost = cluster.reduce((s, r) => s + routeCost(inst, out[r]), 0);
  const localLoads = cluster.map(r => routeLoad(inst, out[r])).sort((a, b) => b - a);

  const candidates: number[][] = [];
  candidates.push(nearestNeighborOrderWithinSet(inst, pooled));
  candidates.push(buildSweepOrder(inst, false, 0).filter(id => pooled.includes(id)));
  for (let s = 0; s < 4; s++) {
    candidates.push(kmeansOrderFromCustomers(inst, pooled, K, 7000 + s * 31));
  }

  let best: SplitResult | undefined;
  for (const order of candidates) {
    if (order.length !== pooled.length) continue;
    const split = splitExactK(inst, order, K, localLoads);
    if (!split.feasible || split.routes.length !== K) continue;
    const improved = improveRoutes2Opt(inst, split.routes);
    const score = improved.totalCost;
    if (!best || score < best.totalCost) {
      best = {
        routes: improved.routes,
        feasible: true,
        usedVehicles: K,
        totalCost: score,
      };
    }
  }

  if (!best) return { routes, totalCost: totalRouteCost(inst, routes), improved: false };
  if (best.totalCost + 1e-9 >= oldCost) return { routes, totalCost: totalRouteCost(inst, routes), improved: false };

  for (let i = 0; i < cluster.length; i++) {
    out[cluster[i]] = best.routes[i];
  }
  return { routes: out, totalCost: totalRouteCost(inst, out), improved: true };
}

function refineModPClusters(
  inst: CvrpInstance,
  routes: number[][],
  overlapPairs: RouteOverlapPair[],
  threshold = 0.15
): { routes: number[][]; totalCost: number; improvedCount: number; clustersTried: number } {
  let current = cloneRoutes(routes);
  let improvedCount = 0;
  let clustersTried = 0;

  const clusters = findModPTriples(current.length, overlapPairs, threshold, 12);
  for (const cl of clusters) {
    clustersTried++;
    const ref = refineModPCluster(inst, current, cl);
    if (ref.improved) {
      current = ref.routes;
      improvedCount++;
    }
  }

  return { routes: current, totalCost: totalRouteCost(inst, current), improvedCount, clustersTried };
}

function refineHubCompressionGadget(
  inst: CvrpInstance,
  routes: number[][],
  hubs: HubScore[],
  maxHubs = 25,
  neighborsPerHub = 6
): { routes: number[][]; totalCost: number } {
  const out = cloneRoutes(routes);
  const loads = routeLoads(inst, out);
  const allCustomers = out.flat().filter(id => id !== inst.depot);
  const topHubs = hubs.slice(0, maxHubs).map(h => h.node);

  const findRouteOf = (node: number): number => {
    for (let r = 0; r < out.length; r++) {
      if (out[r].includes(node)) return r;
    }
    return -1;
  };

  const bestInsertIntoAnyRoute = (node: number, excludeRoute: number): { routeIdx: number; route: number[]; delta: number } | undefined => {
    let best: { routeIdx: number; route: number[]; delta: number } | undefined;
    const dem = inst.demands.get(node) ?? 0;
    for (let r = 0; r < out.length; r++) {
      if (r === excludeRoute) continue;
      if (loads[r] + dem > inst.capacity) continue;
      const candidate = tryInsertBestPosition(inst, out[r], node);
      if (!best || candidate.delta < best.delta) {
        best = { routeIdx: r, route: candidate.route, delta: candidate.delta };
      }
    }
    return best;
  };

  for (const hub of topHubs) {
    const hubRouteIdx = findRouteOf(hub);
    if (hubRouteIdx < 0) continue;

    const hubDemand = inst.demands.get(hub) ?? 0;
    const hubPoint = must(inst.nodes.get(hub), `Missing node ${hub}`);
    const nearest = allCustomers
      .filter(x => x !== hub)
      .map(x => {
        const p = must(inst.nodes.get(x), `Missing node ${x}`);
        return { id: x, d: Math.hypot(p.x - hubPoint.x, p.y - hubPoint.y) };
      })
      .sort((a, b) => a.d - b.d)
      .slice(0, neighborsPerHub)
      .map(x => x.id);

    const desired = new Set<number>([hub, ...nearest]);

    // Pull nearest neighbors into hub route, evicting mismatched customers when needed.
    for (const cand of nearest) {
      const src = findRouteOf(cand);
      if (src < 0 || src === hubRouteIdx) continue;

      const dem = inst.demands.get(cand) ?? 0;
      const canFitDirect = loads[hubRouteIdx] + dem <= inst.capacity;

      if (!canFitDirect) {
        // Evict one non-desired customer from hub route to make space.
        const hubCustomers = out[hubRouteIdx].filter(x => x !== inst.depot && x !== hub && !desired.has(x));
        let evicted = false;
        for (const victim of hubCustomers) {
          const vd = inst.demands.get(victim) ?? 0;
          if (loads[hubRouteIdx] - vd + dem > inst.capacity) continue;
          const dst = bestInsertIntoAnyRoute(victim, hubRouteIdx);
          if (!dst) continue;

          out[hubRouteIdx] = out[hubRouteIdx].filter(x => x !== victim);
          loads[hubRouteIdx] -= vd;
          out[dst.routeIdx] = dst.route;
          loads[dst.routeIdx] += vd;
          evicted = true;
          break;
        }
        if (!evicted && loads[hubRouteIdx] + dem > inst.capacity) continue;
      }

      // Move candidate into hub route.
      out[src] = out[src].filter(x => x !== cand);
      loads[src] -= dem;
      const ins = tryInsertBestPosition(inst, out[hubRouteIdx], cand);
      out[hubRouteIdx] = ins.route;
      loads[hubRouteIdx] += dem;
    }

    // Rebuild the entire hub route around the hub as route seed.
    const customers = out[hubRouteIdx].filter(x => x !== inst.depot);
    if (!customers.includes(hub)) continue;
    const rebuilt = nearestNeighborOrderFromSeed(inst, customers, hub);
    const rebuiltRoute = twoOptRoute(inst, [inst.depot, ...rebuilt, inst.depot]);
    out[hubRouteIdx] = rebuiltRoute;
    loads[hubRouteIdx] = routeLoad(inst, rebuiltRoute);
    if (loads[hubRouteIdx] < hubDemand || loads[hubRouteIdx] > inst.capacity) {
      // Revert if any numeric instability creates infeasible route.
      out[hubRouteIdx] = [inst.depot, ...customers, inst.depot];
      loads[hubRouteIdx] = routeLoad(inst, out[hubRouteIdx]);
    }
  }

  return { routes: out, totalCost: totalRouteCost(inst, out) };
}

function seamKillerGlobalReplacement(
  inst: CvrpInstance,
  split: SplitResult,
  K: number,
  rng: () => number,
  maxRounds = 2
): { split: SplitResult; stats: SeamKillerStats } {
  const initialDiag = computeStructuralDiagnostics(inst, split.routes);
  const stats: SeamKillerStats = {
    rounds: 0,
    accepted: 0,
    candidates: 0,
    seamBefore: initialDiag.seamCostRatio,
    seamAfter: initialDiag.seamCostRatio,
    costBefore: split.totalCost,
    costAfter: split.totalCost,
  };
  if (!split.feasible || split.routes.length !== K) return { split, stats };

  let current = split;
  for (let round = 0; round < maxRounds; round++) {
    const diag = computeStructuralDiagnostics(inst, current.routes);
    if (diag.seamCostRatio <= 0.68) break;
    stats.rounds++;

    const options: SplitResult[] = [];
    const addCandidate = (routes: number[][]): void => {
      if (routes.length !== K) return;
      const cand: SplitResult = {
        routes,
        feasible: true,
        usedVehicles: K,
        totalCost: totalRouteCost(inst, routes),
      };
      options.push(cand);
    };

    const dense = refineDenseMinorPairs(inst, current.routes, diag.overlapPairs, 6);
    const densePairs = computeOverlapPairs(inst, dense.routes);
    const modp = refineModPClusters(inst, dense.routes, densePairs, 0.16);
    const modpDiag = computeStructuralDiagnostics(inst, modp.routes);
    const hub = refineHubCompressionGadget(inst, modp.routes, modpDiag.hubs, 16, 6);
    const seamMap = buildCandidateMap(inst, 22);
    const seam = seamDrivenPairRepair(inst, hub.routes, seamMap, 2, 3);
    const topo = improveRoutes2Opt(inst, seam.routes);
    addCandidate(topo.routes);

    const pooled = pooledGroupExactRepartition(inst, current, K, rng, 4, 7);
    if (pooled) options.push(pooled);

    const bo = boundaryOverlapExactPass(inst, current, K, rng, 1);
    if (bo.split) options.push(bo.split);

    const macro = macroRepartitionOneCycle(inst, current, K, rng);
    if (macro) options.push(macro);

    if (options.length === 0) break;
    stats.candidates += options.length;

    let bestNext: SplitResult | undefined;
    let bestMerit = Number.NEGATIVE_INFINITY;
    for (const cand of options) {
      const candDiag = computeStructuralDiagnostics(inst, cand.routes);
      const improveRatio = (current.totalCost - cand.totalCost) / Math.max(1, current.totalCost);
      const seamDrop = diag.seamCostRatio - candDiag.seamCostRatio;
      const acceptable =
        (improveRatio >= 0.0002 && seamDrop >= -0.002) ||
        (seamDrop >= 0.018 && improveRatio >= -0.0010) ||
        (seamDrop >= 0.035 && improveRatio >= -0.0020);
      if (!acceptable) continue;
      const merit = seamDrop * 1000 + improveRatio * 380;
      if (merit > bestMerit) {
        bestMerit = merit;
        bestNext = cand;
      }
    }

    if (!bestNext) break;
    current = bestNext;
    stats.accepted++;
  }

  const finalDiag = computeStructuralDiagnostics(inst, current.routes);
  stats.seamAfter = finalDiag.seamCostRatio;
  stats.costAfter = current.totalCost;
  return { split: current, stats };
}

function spatialTopologyRewrite(
  inst: CvrpInstance,
  split: SplitResult,
  K: number,
  rng: () => number,
  cycles = 3
): SplitResult {
  if (!split.feasible || split.routes.length !== K) return split;
  let current = split;
  for (let cyc = 0; cyc < cycles; cyc++) {
    const diag = computeStructuralDiagnostics(inst, current.routes);
    let bestCandidate = current;
    let bestSeam = diag.seamCostRatio;

    const rep = repartitionTopOverlap(inst, current, K, diag, 0.00015);
    if (rep !== current) {
      const repDiag = computeStructuralDiagnostics(inst, rep.routes);
      if (shouldAcceptTopologyRewrite(current, rep, bestSeam, repDiag.seamCostRatio)) {
        bestCandidate = rep;
        bestSeam = repDiag.seamCostRatio;
      }
    }

    const bo = boundaryOverlapExactPass(inst, current, K, rng, 2);
    if (bo.split) {
      const boDiag = computeStructuralDiagnostics(inst, bo.split.routes);
      if (shouldAcceptTopologyRewrite(current, bo.split, bestSeam, boDiag.seamCostRatio)) {
        bestCandidate = bo.split;
        bestSeam = boDiag.seamCostRatio;
      }
    }

    const pooled = pooledGroupExactRepartition(inst, current, K, rng, 4, 8);
    if (pooled) {
      const pDiag = computeStructuralDiagnostics(inst, pooled.routes);
      if (shouldAcceptTopologyRewrite(current, pooled, bestSeam, pDiag.seamCostRatio)) {
        bestCandidate = pooled;
        bestSeam = pDiag.seamCostRatio;
      }
    }

    const macro = macroRepartitionOneCycle(inst, current, K, rng);
    if (macro) {
      const mDiag = computeStructuralDiagnostics(inst, macro.routes);
      if (shouldAcceptTopologyRewrite(current, macro, bestSeam, mDiag.seamCostRatio)) {
        bestCandidate = macro;
        bestSeam = mDiag.seamCostRatio;
      }
    }

    if (bestCandidate === current) break;
    current = bestCandidate;
  }
  return current;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const vrpPath = must(
    args.vrpPath,
    "Usage: npx tsx test/benchmark_cvrplib.ts --vrp <path> [--sol <path> | --bks <value>] [--vehicles <k>] [--profile default|strong] [--seed <n>] [--strict|--non-strict] [--budget-min <5..60>]"
  );

  const vrpText = readFileSync(vrpPath, "utf8");
  const inst = parseCvrplib(vrpText);
  const strictBenchmark = args.strict ?? true;

  let bksCost = args.bks;
  let bksRoutes: BksSolution | undefined;
  if (args.solPath) {
    const solText = readFileSync(args.solPath, "utf8");
    const raw = parseSolution(solText);
    if (!strictBenchmark) {
      bksRoutes = {
        routes: normalizeSolutionRoutes(inst, raw.routes),
        cost: raw.cost,
      };
    }
    bksCost = bksCost ?? bksRoutes?.cost;
    bksCost = bksCost ?? raw.cost;
  }

  const vehiclesTarget = args.vehicles ?? inst.vehiclesHint;
  const K = must(vehiclesTarget, "Vehicle target is required (use --vehicles or instance name with -kX).");
  const runProfile = args.profile ?? "default";
  const runMode: "pure" | "product" = args.mode ?? "pure";
  // Checkpoint rollback mode: keep the objective-aligned 10.79-era wiring and
  // disable later heavy structural phases that inflated runtime.
  const rollbackTo1079Checkpoint = true;
  const spatialLock = runMode === "pure" && !rollbackTo1079Checkpoint;
  const plateauBreakMode = runMode === "pure" && !rollbackTo1079Checkpoint;
  const strongRun = runProfile === "strong";
  const baseSeed = Number.isFinite(args.seed ?? NaN) ? Number(args.seed) : 20260217;
  const seedPack = strongRun ? strongSeedPack(baseSeed) : [baseSeed];

  const engineNodes: Node[] = Array.from(inst.nodes.entries()).map(([id, p]) => ({
    id: String(id),
    x: p.x,
    y: p.y,
    type: id === inst.depot ? "depot" : "stop",
  }));

  const t0 = process.hrtime.bigint();
  const out = runReasonRouteEngine({
    nodes: engineNodes,
    depotId: String(inst.depot),
    preferences: { weightTime: 0, weightEmissions: 0, weightDistance: 1 },
    optimization: {
      mode: strongRun ? "quality" : "fast",
      timeBudgetMs: strongRun ? 260 : 120,
      benchmarkPure: runMode === "pure",
    },
    benchmark: {
      metric: "cvrplib_euc2d",
      vehicleCount: K,
      vehicleCapacity: inst.capacity,
      demands: Object.fromEntries(
        Array.from(inst.demands.entries()).map(([id, d]) => [String(id), d])
      ),
    },
  });
  const t1 = process.hrtime.bigint();
  const runtimeMs = Number(t1 - t0) / 1e6;
  const engineOrderRaw = out.optimizedPath
    .map(id => Number(id))
    .filter(n => Number.isFinite(n) && n !== inst.depot);
  const engineRouteSplit = coerceEngineRoutesToSplit(inst, out.optimizedRoutes, K);

  const allCustomers = Array.from(inst.nodes.keys()).filter(id => id !== inst.depot);
  const dedupOrder = (order: number[]): number[] => {
    const seen = new Set<number>();
    const result: number[] = [];
    for (const id of order) {
      if (id === inst.depot) continue;
      if (!seen.has(id)) {
        seen.add(id);
        result.push(id);
      }
    }
    for (const id of allCustomers) {
      if (!seen.has(id)) result.push(id);
    }
    return result;
  };
  const spatialSeedOrders: Array<{ name: string; order: number[] }> = seedPack.map((s, idx) => ({
    name: `spatial-seed-${idx + 1}`,
    order: dedupOrder(buildSpatialBridgeOrder(inst, allCustomers, K, s + idx * 97)),
  }));

  const bksPattern = !strictBenchmark && bksRoutes ? mineBksPattern(inst, bksRoutes) : undefined;
  const historicalPrune = strictBenchmark
    ? { kept: 0, removed: 0 }
    : pruneHistoricalCache(inst, K, strongRun ? 20 : 12);
  const historicalSeedRaw = strictBenchmark ? undefined : loadBestHistoricalSeed(inst, K);
  const pinnedSeed = strictBenchmark ? undefined : loadPinnedHistoricalSeed(inst, K);
  const historicalSeed =
    historicalSeedRaw && pinnedSeed
      ? (historicalSeedRaw.split.totalCost <= pinnedSeed.split.totalCost ? historicalSeedRaw : pinnedSeed)
      : (historicalSeedRaw ?? pinnedSeed);

  const candidates: Array<{ name: string; split: SplitResult }> = [];
  let best: { name: string; split: SplitResult } | undefined;
  let bestSpatial: { name: string; split: SplitResult } | undefined;
  const seenSignatures = new Set<string>();

  const registerCandidate = (name: string, split: SplitResult): boolean => {
    if (!split.feasible) return false;
    const spatialCandidate = isSpatialCandidateName(name);
    if (spatialLock && bestSpatial && !spatialCandidate) {
      // Prevent legacy basin from dominating unless it is clearly better.
      const mustBeat = bestSpatial.split.totalCost * 0.992;
      if (split.totalCost > mustBeat) return false;
    }
    const signature = split.routes
      .map(route => route.filter(id => id !== inst.depot).join(","))
      .join("|");
    if (seenSignatures.has(signature)) return false;
    seenSignatures.add(signature);
    candidates.push({ name, split });
    if (!best || split.totalCost < best.split.totalCost) {
      best = { name, split };
    }
    if (spatialCandidate && (!bestSpatial || split.totalCost < bestSpatial.split.totalCost)) {
      bestSpatial = { name, split };
    }
    return true;
  };

  // Runtime guards: cache order lower-bounds and prune dominated/non-promising work.
  const orderLowerBound = new Map<string, number>();
  const triedStartOrders = new Set<string>();
  let pruneOrderDominated = 0;
  let pruneIncumbentBound = 0;
  let pruneStartDuplicate = 0;
  let pruneHeadstartPolish = 0;
  type DeferredCandidate = {
    name: string;
    split: SplitResult;
    order?: number[];
    reason: "headstart" | "multistart" | "hgs";
    overRatio: number;
    insertedAt: number;
  };
  const deferredBank: DeferredCandidate[] = [];
  const deferredSeen = new Set<string>();
  const deferredMax = strongRun ? 160 : 110;
  let deferredStored = 0;
  let deferredPolished = 0;
  let deferredAccepted = 0;
  let deferredDropped = 0;
  let historicalDeferred = 0;
  let historicalLateAccepted = 0;
  let deferredHistorical:
    | { source: string; candidate: string; split: SplitResult; order: number[] }
    | undefined;

  const incumbentCost = (): number => best?.split.totalCost ?? Number.POSITIVE_INFINITY;
  const exceedsIncumbent = (cost: number, slackRatio: number): boolean => {
    const inc = incumbentCost();
    return Number.isFinite(inc) && cost > inc * (1 + slackRatio);
  };
  const noteOrderLowerBound = (order: number[], cost: number): void => {
    const sig = signatureFromOrder(order);
    const prev = orderLowerBound.get(sig);
    if (prev === undefined || cost + 1e-9 < prev) {
      orderLowerBound.set(sig, cost);
    }
  };
  const isOrderDominated = (order: number[], cost: number): boolean => {
    const sig = signatureFromOrder(order);
    const prev = orderLowerBound.get(sig);
    return prev !== undefined && prev <= cost + 1e-9;
  };
  const cloneSplitResult = (split: SplitResult): SplitResult => ({
    routes: cloneRoutes(split.routes),
    feasible: split.feasible,
    usedVehicles: split.usedVehicles,
    totalCost: split.totalCost,
  });
  const parkDeferred = (
    name: string,
    split: SplitResult,
    reason: "headstart" | "multistart" | "hgs",
    order?: number[]
  ): void => {
    const inc = incumbentCost();
    if (!Number.isFinite(inc) || !split.feasible) return;
    const overRatio = (split.totalCost - inc) / Math.max(1, inc);
    if (overRatio <= 0) return;
    const key = split.routes
      .map(route => route.filter(id => id !== inst.depot).join(","))
      .join("|");
    if (deferredSeen.has(key)) return;
    deferredSeen.add(key);
    deferredBank.push({
      name,
      split: cloneSplitResult(split),
      order: order ? [...order] : undefined,
      reason,
      overRatio,
      insertedAt: deferredStored,
    });
    deferredStored++;
    if (deferredBank.length > deferredMax) {
      deferredBank.sort((a, b) => {
        if (a.overRatio !== b.overRatio) return a.overRatio - b.overRatio;
        return a.insertedAt - b.insertedAt;
      });
      while (deferredBank.length > deferredMax) {
        deferredBank.pop();
        deferredDropped++;
      }
    }
  };

  let engineRoutesFeasible = 0;
  let engineRoutesAccepted = 0;
  let engineRoutePostPolishGain = 0;
  let engineRouteSeamBefore: number | undefined;
  let engineRouteSeamAfter: number | undefined;
  let seamKillerRounds = 0;
  let seamKillerAccepted = 0;
  let seamKillerCandidates = 0;
  let seamKillerSeamBefore: number | undefined;
  let seamKillerSeamAfter: number | undefined;
  let seamKillerCostGain = 0;
  let spatialIntensifyRounds = 0;
  let spatialIntensifyAccepted = 0;
  let seamEscapeTried = 0;
  let seamEscapeAccepted = 0;

  if (engineRouteSplit?.feasible) {
    engineRoutesFeasible = 1;
    const acceptedRaw = registerCandidate("engine-routes+exactK", engineRouteSplit);
    if (acceptedRaw) engineRoutesAccepted++;
    const engineOrder = buildOrderFromRoutes(engineRouteSplit.routes, inst.depot);
    noteOrderLowerBound(engineOrder, engineRouteSplit.totalCost);
    const diagBefore = computeStructuralDiagnostics(inst, engineRouteSplit.routes);
    engineRouteSeamBefore = diagBefore.seamCostRatio;

    const polished = polishCandidate(
      inst,
      engineRouteSplit,
      930001,
      strongRun ? 48 : 34,
      strongRun ? 230 : 160,
      strongRun ? 92 : 58
    );
    const acceptedPolished = registerCandidate("engine-routes+polish", polished);
    if (acceptedPolished) engineRoutesAccepted++;
    const diagAfter = computeStructuralDiagnostics(inst, polished.routes);
    engineRouteSeamAfter = diagAfter.seamCostRatio;
    engineRoutePostPolishGain = engineRouteSplit.totalCost - polished.totalCost;
  }

  const baseOrders: Array<{ name: string; order: number[] }> = [
    { name: "sweep-0", order: buildSweepOrder(inst, false, 0) },
    { name: "sweep-rev", order: buildSweepOrder(inst, true, 0) },
    { name: "sweep-90", order: buildSweepOrder(inst, false, Math.PI / 2) },
    { name: "sweep-180", order: buildSweepOrder(inst, false, Math.PI) },
  ];
  baseOrders.unshift(...spatialSeedOrders);
  if (engineOrderRaw.length > 0) {
    baseOrders.unshift({ name: "engine-order", order: dedupOrder(engineOrderRaw) });
  }
  if (bksPattern) {
    baseOrders.push({ name: "bks-sector-guided", order: buildSectorGuidedOrder(inst, bksPattern) });
  }

  let seedCounter = 1000;

  for (const c of baseOrders) {
    const split = splitExactK(inst, c.order, K, bksPattern?.targetLoadsSorted);
    if (!split.feasible) continue;
    if (isOrderDominated(c.order, split.totalCost)) {
      pruneOrderDominated++;
      continue;
    }
    noteOrderLowerBound(c.order, split.totalCost);
    const relaxedHead = c.name.startsWith("engine-order") || c.name.startsWith("spatial-");
    const headSlack = relaxedHead ? (strongRun ? 0.24 : 0.30) : (strongRun ? 0.14 : 0.18);
    if (exceedsIncumbent(split.totalCost, headSlack)) {
      pruneHeadstartPolish++;
      parkDeferred(`${c.name}+exactK`, split, "headstart", c.order);
      registerCandidate(`${c.name}+exactK(raw-pruned)`, split);
      continue;
    }
    const polished = polishCandidate(inst, split, seedCounter++, 40);
    noteOrderLowerBound(c.order, polished.totalCost);
    registerCandidate(`${c.name}+exactK+exchange+lns`, polished);
  }

  const clusterSeed = constrainedClusterWarmStart(inst, K, 424242);
  if (clusterSeed.feasible) {
    registerCandidate("cluster-warmstart", clusterSeed);
    const clusterOrder = buildOrderFromRoutes(clusterSeed.routes, inst.depot);
    noteOrderLowerBound(clusterOrder, clusterSeed.totalCost);
    if (!exceedsIncumbent(clusterSeed.totalCost, strongRun ? 0.10 : 0.14)) {
      const clusterPolished = polishCandidate(inst, clusterSeed, 424243, 52, 260, 95);
      noteOrderLowerBound(clusterOrder, clusterPolished.totalCost);
      registerCandidate("cluster-warmstart+deep", clusterPolished);
    } else {
      pruneHeadstartPolish++;
      parkDeferred("cluster-warmstart", clusterSeed, "headstart", clusterOrder);
    }
  }

  if (historicalSeed) {
    const historicalOrder = buildOrderFromRoutes(historicalSeed.split.routes, inst.depot);
    noteOrderLowerBound(historicalOrder, historicalSeed.split.totalCost);
    if (!plateauBreakMode) {
      // Defer historical injection to avoid anchoring early search in one cached basin.
      deferredHistorical = {
        source: historicalSeed.source,
        candidate: historicalSeed.candidate,
        split: cloneSplitResult(historicalSeed.split),
        order: historicalOrder,
      };
      historicalDeferred = 1;
    }
  }

  const strongSeedOrder = bksPattern ? buildSectorGuidedOrder(inst, bksPattern) : buildSweepOrder(inst, false, 0);
  const warm = packedConstructiveSplit(inst, K, strongSeedOrder, bksPattern?.targetLoadsSorted, 55, 12345);
  if (warm.feasible) {
    noteOrderLowerBound(strongSeedOrder, warm.totalCost);
    if (!exceedsIncumbent(warm.totalCost, strongRun ? 0.10 : 0.12)) {
      const warmPolished = polishCandidate(inst, warm, 99001, 44, 260, 90);
      noteOrderLowerBound(strongSeedOrder, warmPolished.totalCost);
      registerCandidate("warmstart-sector+deep", warmPolished);
    } else {
      pruneHeadstartPolish++;
      parkDeferred("warmstart-sector", warm, "headstart", strongSeedOrder);
      registerCandidate("warmstart-sector(raw-pruned)", warm);
    }
  }

  // SeamKiller: deterministic global topology replacement stage before multi-start.
  if (best) {
    const seamKillerRng = makeRng(seedPack[0] + 1701);
    const seamKilled = seamKillerGlobalReplacement(inst, best.split, K, seamKillerRng, strongRun ? 2 : 1);
    seamKillerRounds = seamKilled.stats.rounds;
    seamKillerAccepted = seamKilled.stats.accepted;
    seamKillerCandidates = seamKilled.stats.candidates;
    seamKillerSeamBefore = seamKilled.stats.seamBefore;
    seamKillerSeamAfter = seamKilled.stats.seamAfter;
    seamKillerCostGain = seamKilled.stats.costBefore - seamKilled.stats.costAfter;
    registerCandidate("seam-killer-global", seamKilled.split);
  }

  // Spatial-first dedicated refinement rounds:
  // protect and deeply refine spatial-origin incumbents before generic multi-start.
  if (!rollbackTo1079Checkpoint && bestSpatial) {
    let currentSpatial = bestSpatial.split;
    const rounds = strongRun ? 3 : 2;
    const spatialRng = makeRng(seedPack[0] + 701);
    for (let r = 0; r < rounds; r++) {
      spatialIntensifyRounds++;
      const polished = polishCandidate(
        inst,
        currentSpatial,
        940000 + r * 101,
        strongRun ? 56 : 40,
        strongRun ? 290 : 210,
        strongRun ? 110 : 76
      );
      let candidate = polished;
      const bo = boundaryOverlapExactPass(inst, candidate, K, spatialRng, strongRun ? 3 : 2);
      if (bo.split) candidate = bo.split;
      const topo = spatialTopologyRewrite(inst, candidate, K, spatialRng, strongRun ? 3 : 2);
      candidate = topo;
      registerCandidate(`topology-rewrite-${r + 1}`, topo);
      registerCandidate(`spatial-intensify-${r + 1}`, candidate);
      if (candidate.totalCost + 1e-9 < currentSpatial.totalCost) {
        currentSpatial = candidate;
        spatialIntensifyAccepted++;
      }
    }
  }

  // Plateau-break escape: allow seam-first topology jumps with bounded uphill tolerance,
  // then re-polish back toward cost objective.
  if (!rollbackTo1079Checkpoint && plateauBreakMode && best) {
    const escapeRounds = strongRun ? 2 : 1;
    const escapeRng = makeRng(seedPack[0] + 991);
    let escapeBase = bestSpatial?.split ?? best.split;
    for (let er = 0; er < escapeRounds; er++) {
      seamEscapeTried++;
      const escaped = seamEscapePhase(inst, escapeBase, K, escapeRng, strongRun ? 2 : 1);
      if (!escaped) continue;
      const recovered = polishCandidate(
        inst,
        escaped,
        980500 + er * 113,
        strongRun ? 30 : 22,
        strongRun ? 160 : 120,
        strongRun ? 58 : 42
      );
      const before = candidates.length;
      registerCandidate(`spatial-escape-${er + 1}`, recovered);
      if (candidates.length > before) {
        seamEscapeAccepted++;
      }
      escapeBase = recovered.totalCost <= escapeBase.totalCost ? recovered : escapeBase;
    }
  }

  // Stage E/D/Hub structural refinement BEFORE multi-start:
  // mod-p first, then dense-minor cleanup, then hub compression.
  let structuralBefore: StructuralDiagnostics | undefined;
  let structuralAfter: StructuralDiagnostics | undefined;
  let modPTried = 0;
  let modPImproved = 0;
  let axiomBoostAccepted = 0;
  let structuralSeedOrder: number[] | undefined;
  if (!rollbackTo1079Checkpoint && best) {
    // Use warm-start incumbent as structural input seed before multi-start.
    const structuralInput = best.split;
    structuralBefore = computeStructuralDiagnostics(inst, structuralInput.routes);

    // Gated repartition: only if seam ratio is high.
    const repartitioned = repartitionTopOverlap(inst, structuralInput, K, structuralBefore, 0.001);
    if (repartitioned !== structuralInput && repartitioned.totalCost + 1e-9 < structuralInput.totalCost) {
      registerCandidate("repartition-topoverlap", repartitioned);
      best = best.split.totalCost <= repartitioned.totalCost ? best : { name: "repartition-topoverlap", split: repartitioned };
      structuralBefore = computeStructuralDiagnostics(inst, best.split.routes);
    }

    // Reverted to +31.66 structural order: dense -> modP(0.15) -> hub
    const denseRefined = refineDenseMinorPairs(inst, structuralInput.routes, structuralBefore.overlapPairs, 8);
    const allPairs = computeOverlapPairs(inst, denseRefined.routes);
    const modp = refineModPClusters(inst, denseRefined.routes, allPairs, 0.15);
    modPTried = modp.clustersTried;
    modPImproved = modp.improvedCount;
    const hubRefined = refineHubCompressionGadget(inst, modp.routes, structuralBefore.hubs, 30, 8);

    const staged = {
      routes: hubRefined.routes,
      feasible: true,
      usedVehicles: K,
      totalCost: hubRefined.totalCost,
    };

    // Deep polish immediately on Stage-E output, before time-budgeted multi-start.
    const deepPostStageE = polishCandidate(inst, staged, 290001, 80, 320, 120);
    let stagedIncumbent = deepPostStageE;

    // Optional GNOPT axiom boost from the reverted baseline:
    // a second dense->mod-p->hub pass with broader neighborhoods.
    const boostDiag = computeStructuralDiagnostics(inst, deepPostStageE.routes);
    const boostDense = refineDenseMinorPairs(inst, deepPostStageE.routes, boostDiag.overlapPairs, 10);
    const boostPairs = computeOverlapPairs(inst, boostDense.routes);
    const boostModp = refineModPClusters(inst, boostDense.routes, boostPairs, 0.13);
    modPTried += boostModp.clustersTried;
    modPImproved += boostModp.improvedCount;
    const boostHub = refineHubCompressionGadget(inst, boostModp.routes, boostDiag.hubs, 36, 9);
    const boostStaged: SplitResult = {
      routes: boostHub.routes,
      feasible: true,
      usedVehicles: K,
      totalCost: boostHub.totalCost,
    };
    const boostPolished = polishCandidate(inst, boostStaged, 390001, 56, 280, 100);
    if (boostPolished.totalCost + 1e-9 < deepPostStageE.totalCost) {
      stagedIncumbent = boostPolished;
      axiomBoostAccepted = 1;
      registerCandidate("seed0-structural-axiom-boost", boostPolished);
    }

    structuralSeedOrder = buildOrderFromRoutes(stagedIncumbent.routes, inst.depot);

    // Incumbent protection: only register structural output if it actually beats incumbent.
    if (!best || stagedIncumbent.totalCost + 1e-9 < best.split.totalCost) {
      registerCandidate("seed0-structural-deep", stagedIncumbent);
    }

    if (best) structuralAfter = computeStructuralDiagnostics(inst, best.split.routes);
  }

  const searchStart = Date.now();
  const defaultBudgetMin = strongRun ? 30 : 10;
  const budgetMin = Number.isFinite(args.budgetMin ?? NaN)
    ? Math.max(5, Math.min(60, Number(args.budgetMin)))
    : defaultBudgetMin;
  const benchmarkBudgetMs = budgetMin * 60 * 1000;
  const budgetDeadline = searchStart + benchmarkBudgetMs;
  const budgetExceeded = (): boolean => Date.now() >= budgetDeadline;
  const maxStarts = strongRun ? 260 : 220;
  let startsTried = 0;
  let startsFeasible = 0;
  let msNoImprove = 0;
  const msNoImproveLimit = strongRun ? 70 : 56;
  let msEarlyStop = 0;

  while (startsTried < maxStarts && !budgetExceeded()) {
    const msBestBefore = incumbentCost();
    let order: number[];
    let derivedSpatialStart = false;
    if (startsTried === 0 && structuralSeedOrder && structuralSeedOrder.length === allCustomers.length) {
      order = structuralSeedOrder;
    } else {
      const mode = startsTried % 10;
      const ring = Math.floor(startsTried / 10);
      const angleStep = (Math.PI * 2) / 24;
      const theta = (ring % 24) * angleStep;

      if (mode === 0) order = buildSweepOrder(inst, false, theta);
      else if (mode === 1) order = buildSweepOrder(inst, true, theta);
      else if (mode === 2) order = buildSweepOrder(inst, false, theta + Math.PI / 3);
      else if (mode === 3) {
        derivedSpatialStart = true;
        order = rotateOrder(dedupOrder(engineOrderRaw), (ring * 17) % Math.max(1, allCustomers.length));
      }
      else if (mode === 4 && bksPattern) order = rotateOrder(buildSectorGuidedOrder(inst, bksPattern), (ring * 13) % Math.max(1, allCustomers.length));
      else if (mode === 5) order = buildSweepOrder(inst, false, theta + Math.PI / 2);
      else if (mode === 6) {
        const kk = Math.max(6, K - 2 + (ring % 5));
        order = kmeansOrderFromCustomers(inst, allCustomers, kk, 5000 + ring * 19);
      } else if (mode === 7) {
        derivedSpatialStart = true;
        const s = spatialSeedOrders[(ring + startsTried) % Math.max(1, spatialSeedOrders.length)];
        order = rotateOrder(s.order, (ring * 11) % Math.max(1, allCustomers.length));
      } else if (mode === 8) {
        derivedSpatialStart = true;
        order = buildSpatialBridgeOrder(inst, allCustomers, K, 880000 + ring * 37);
      } else {
        const kk = Math.max(6, K + (ring % 4));
        order = kmeansOrderFromCustomers(inst, allCustomers, kk, 8000 + ring * 23);
      }
    }

    startsTried++;
    const orderSig = signatureFromOrder(order);
    if (triedStartOrders.has(orderSig)) {
      pruneStartDuplicate++;
      msNoImprove++;
      if (msNoImprove >= msNoImproveLimit) {
        msEarlyStop = 1;
        break;
      }
      continue;
    }
    triedStartOrders.add(orderSig);

    const attempts = 8 + (startsTried % 6);
    const packed = packedConstructiveSplit(
      inst,
      K,
      order,
      bksPattern?.targetLoadsSorted,
      attempts,
      40000 + startsTried * 31
    );

    if (!packed.feasible) continue;
    startsFeasible++;
    if (isOrderDominated(order, packed.totalCost)) {
      pruneOrderDominated++;
      msNoImprove++;
      if (msNoImprove >= msNoImproveLimit) {
        msEarlyStop = 1;
        break;
      }
      continue;
    }
    noteOrderLowerBound(order, packed.totalCost);
    const msSlack = derivedSpatialStart ? (strongRun ? 0.075 : 0.10) : (strongRun ? 0.045 : 0.06);
    if (exceedsIncumbent(packed.totalCost, msSlack)) {
      pruneIncumbentBound++;
      parkDeferred(`ms-${startsTried}`, packed, "multistart", order);
      msNoImprove++;
      if (msNoImprove >= msNoImproveLimit) {
        msEarlyStop = 1;
        break;
      }
      continue;
    }

    const polished = polishCandidate(inst, packed, 70000 + startsTried * 53, 12 + (startsTried % 6), 55, 22);
    noteOrderLowerBound(order, polished.totalCost);
    registerCandidate(`ms-${startsTried}`, polished);

    if (best && startsTried % 20 === 0) {
      const deep = polishCandidate(inst, best.split, 88000 + startsTried * 7, 40, 240, 95);
      registerCandidate(`incumbent-deep-${startsTried}`, deep);
    }
    const msBestAfter = incumbentCost();
    if (msBestAfter + 1e-9 < msBestBefore) {
      msNoImprove = 0;
    } else {
      msNoImprove++;
      if (msNoImprove >= msNoImproveLimit) {
        msEarlyStop = 1;
        break;
      }
    }
  }

  // Minimal HGS layer: route-order population, OX crossover, mutate, split decode, then education.
  const hgsStart = Date.now();
  const hgsMaxGenerations = strictBenchmark ? 42 : (strongRun ? 180 : 120);
  const hgsPopulationCap = strictBenchmark ? 16 : (strongRun ? 24 : 20);
  const hgsRng = makeRng(seedPack[0]);
  let hgsGenerations = 0;
  let hgsChildrenTried = 0;
  let hgsChildrenAccepted = 0;
  let hgsMediumEducationRuns = 0;
  let hgsDeepEducationRuns = 0;
  let hgsAvgParentDistance = 0;
  let hgsParentPairs = 0;
  let hgsSrexChildren = 0;
  let hgsRouteSrexChildren = 0;
  let hgsOxChildren = 0;
  let hgsChildAttempts = 0;
  let hgsChildrenWithSplit = 0;
  let hgsRecentAttempts = 0;
  let hgsRecentWithSplit = 0;
  let hgsNoImproveGenerations = 0;
  const hgsNoImproveLimit = strongRun ? 26 : 20;
  let hgsEarlyStop = 0;
  let hgsReheats = 0;
  let hgsImmigrantsAccepted = 0;
  const hgsMaxReheats = strongRun ? 3 : 2;

  const rankedForHgs = [...candidates].sort((a, b) => a.split.totalCost - b.split.totalCost);
  const population: HgsIndividual[] = [];
  const seenOrders = new Set<string>();
  const diversityPairs = buildDiversityPairs(inst, 14);
  const hgsCandidateMap = buildCandidateMap(
    inst,
    chooseCandidateMapK(inst, strongRun ? 22 : 14, strongRun ? 170 : 110)
  );
  for (const c of rankedForHgs) {
    const order = buildOrderFromRoutes(c.split.routes, inst.depot);
    if (order.length !== allCustomers.length) continue;
    const sig = signatureFromOrder(order);
    if (seenOrders.has(sig)) continue;
    seenOrders.add(sig);
    population.push({
      name: c.name,
      order,
      split: c.split,
      routeOf: buildRouteOfFromSplit(inst, c.split),
    });
    if (population.length >= hgsPopulationCap) break;
  }

  const pickParentByCost = (): HgsIndividual | undefined => {
    if (population.length === 0) return undefined;
    if (population.length === 1) return population[0];
    const genProgress = hgsGenerations / Math.max(1, hgsMaxGenerations);
    const beta = strongRun
      ? (0.18 + 0.20 * genProgress + Math.min(0.22, 0.03 * hgsNoImproveGenerations))
      : (0.14 + 0.16 * genProgress + Math.min(0.20, 0.03 * hgsNoImproveGenerations));
    const div = diversityContributions(population, diversityPairs, 4);
    const bestCost = population.reduce((m, p) => Math.min(m, p.split.totalCost), Number.POSITIVE_INFINITY);
    let winner: HgsIndividual | undefined;
    let winnerScore = Number.POSITIVE_INFINITY;
    const tSize = Math.min(4, population.length);
    for (let t = 0; t < tSize; t++) {
      const idx = Math.floor(hgsRng() * population.length);
      const ind = population[idx];
      const relCost = (ind.split.totalCost - bestCost) / Math.max(1, bestCost);
      const fitness = relCost - beta * div[idx];
      if (fitness < winnerScore) {
        winnerScore = fitness;
        winner = ind;
      }
    }
    return winner ?? population[0];
  };

  const pickParentDiverse = (anchor: HgsIndividual): HgsIndividual | undefined => {
    if (population.length <= 1) return anchor;
    const sample = Math.min(6, population.length);
    let best: HgsIndividual | undefined;
    let bestScore = -Infinity;
    for (let t = 0; t < sample; t++) {
      const cand = population[Math.floor(hgsRng() * population.length)];
      if (cand === anchor) continue;

      const d = brokenPairsDistance(anchor.routeOf, cand.routeOf, diversityPairs);
      const relativeCost =
        (cand.split.totalCost - population[0].split.totalCost) /
        Math.max(1, population[0].split.totalCost);
      const score = d - 0.35 * relativeCost;
      if (score > bestScore) {
        bestScore = score;
        best = cand;
      }
    }
    return best ?? pickParentByCost();
  };

  while (
    population.length >= 2 &&
    hgsGenerations < hgsMaxGenerations &&
    !budgetExceeded()
  ) {
    hgsGenerations++;
    const genBestBefore = best?.split.totalCost ?? Number.POSITIVE_INFINITY;
    const p1 = pickParentByCost();
    const p2 = p1 ? pickParentDiverse(p1) : undefined;
    if (!p1 || !p2) break;
    const parentDistance = brokenPairsDistance(p1.routeOf, p2.routeOf, diversityPairs);
    hgsAvgParentDistance += parentDistance;
    hgsParentPairs++;

    const children: Array<{ order: number[]; split: SplitResult }> = [];
    const chooseMode = (): "routeSrex" | "fragSrex" | "ox" => {
      const rate = hgsRecentAttempts > 0 ? hgsRecentWithSplit / hgsRecentAttempts : 0.5;
      if (rate < 0.25) {
        const u = hgsRng();
        if (u < 0.20) return "routeSrex";
        if (u < 0.75) return "fragSrex";
        return "ox";
      }
      if (rate < 0.45) {
        const u = hgsRng();
        if (u < 0.35) return "routeSrex";
        if (u < 0.80) return "fragSrex";
        return "ox";
      }
      const u = hgsRng();
      if (u < 0.62) return "routeSrex";
      if (u < 0.90) return "fragSrex";
      return "ox";
    };

    const buildChild = (pa: HgsIndividual, pb: HgsIndividual): void => {
      hgsChildAttempts++;
      hgsRecentAttempts++;
      const mode = chooseMode();

      if (mode === "routeSrex") {
        const s = srexRouteSetCrossover(inst, pa, pb, K, hgsCandidateMap, hgsRng, bksPattern?.targetLoadsSorted);
        hgsRouteSrexChildren++;
        if (s) {
          hgsChildrenWithSplit++;
          hgsRecentWithSplit++;
          children.push({ order: buildOrderFromRoutes(s.routes, inst.depot), split: s });
          return;
        }
      } else if (mode === "fragSrex") {
        let order = srexRouteFragmentCrossover(inst, pa, pb, hgsRng);
        hgsSrexChildren++;
        if (order.length !== allCustomers.length) {
          order = orderCrossoverOX(pa.order, pb.order, hgsRng);
          hgsOxChildren++;
        }
        if (hgsRng() < 0.35) order = mutateOrder(order, hgsRng);
        const split = splitExactK(inst, order, K, bksPattern?.targetLoadsSorted);
        if (split.feasible) {
          hgsChildrenWithSplit++;
          hgsRecentWithSplit++;
          children.push({ order, split });
          return;
        }
      } else {
        let order = orderCrossoverOX(pa.order, pb.order, hgsRng);
        hgsOxChildren++;
        if (hgsRng() < 0.40) order = mutateOrder(order, hgsRng);
        const split = splitExactK(inst, order, K, bksPattern?.targetLoadsSorted);
        if (split.feasible) {
          hgsChildrenWithSplit++;
          hgsRecentWithSplit++;
          children.push({ order, split });
          return;
        }
      }

      // Last-resort fallback to keep generation productive.
      let fallbackOrder = orderCrossoverOX(pa.order, pb.order, hgsRng);
      hgsOxChildren++;
      fallbackOrder = mutateOrder(fallbackOrder, hgsRng);
      const fallback = splitExactK(inst, fallbackOrder, K, bksPattern?.targetLoadsSorted);
      if (fallback.feasible) {
        hgsChildrenWithSplit++;
        hgsRecentWithSplit++;
        children.push({ order: fallbackOrder, split: fallback });
      }
    };

    buildChild(p1, p2);
    buildChild(p2, p1);
    if (hgsRecentAttempts >= 40) {
      hgsRecentAttempts = 0;
      hgsRecentWithSplit = 0;
    }

    for (const child of children) {
      hgsChildrenTried++;
      const sig = signatureFromOrder(child.order);
      if (seenOrders.has(sig)) continue;
      if (isOrderDominated(child.order, child.split.totalCost)) {
        pruneOrderDominated++;
        continue;
      }
      noteOrderLowerBound(child.order, child.split.totalCost);
      const hgsEscape = hgsNoImproveGenerations >= Math.floor(hgsNoImproveLimit / 2);
      const hgsBoundSlack = hgsEscape ? (strongRun ? 0.09 : 0.11) : (strongRun ? 0.05 : 0.07);
      if (exceedsIncumbent(child.split.totalCost, hgsBoundSlack)) {
        pruneIncumbentBound++;
        parkDeferred(`hgs-pre-${hgsGenerations}-${hgsChildrenTried}`, child.split, "hgs", child.order);
        continue;
      }

      // Dynamic light/medium/deep education quotas based on progress + stagnation.
      const light = polishCandidate(inst, child.split, 600000 + hgsChildrenTried * 29, 6, 45, 15);
      const incumbent = best?.split.totalCost ?? Number.POSITIVE_INFINITY;
      const progress = hgsGenerations / Math.max(1, hgsMaxGenerations);
      const stagnating = hgsNoImproveGenerations >= 6;
      const promising = light.totalCost <= incumbent * (stagnating ? 1.03 : 1.015);
      const mediumProb = strongRun
        ? (stagnating ? 0.72 : (progress < 0.55 ? 0.24 : 0.38))
        : (stagnating ? 0.74 : (progress < 0.45 ? 0.28 : 0.45));
      const deepProb = strongRun
        ? (stagnating ? 0.30 : (progress < 0.65 ? 0.05 : 0.10))
        : (stagnating ? 0.36 : (progress < 0.55 ? 0.10 : 0.17));
      const runMedium = promising || hgsRng() < mediumProb;
      const medium = runMedium
        ? polishCandidate(inst, light, 700000 + hgsChildrenTried * 37, 10, 70, 24)
        : light;
      if (runMedium) hgsMediumEducationRuns++;
      const runDeep = runMedium && (medium.totalCost <= incumbent * 1.01 || hgsRng() < deepProb);
      const educated = runDeep
        ? polishCandidate(inst, medium, 800000 + hgsChildrenTried * 43, 18, 120, 40)
        : medium;
      if (runDeep) hgsDeepEducationRuns++;
      const inserted = registerCandidate(`hgs-${hgsGenerations}-${hgsChildrenTried}`, educated);
      if (!inserted) continue;

      hgsChildrenAccepted++;
      seenOrders.add(sig);
      noteOrderLowerBound(child.order, educated.totalCost);
      population.push({
        name: `hgs-${hgsGenerations}-${hgsChildrenTried}`,
        order: child.order,
        split: educated,
        routeOf: buildRouteOfFromSplit(inst, educated),
      });
      trimPopulationByDiversity(population, hgsPopulationCap, diversityPairs);
    }

    const genBestAfter = best?.split.totalCost ?? Number.POSITIVE_INFINITY;
    if (genBestAfter + 1e-9 < genBestBefore) {
      hgsNoImproveGenerations = 0;
    } else {
      hgsNoImproveGenerations++;
        if (hgsNoImproveGenerations >= hgsNoImproveLimit) {
          if (hgsReheats >= hgsMaxReheats) {
            hgsEarlyStop = 1;
            break;
          }
        const immigrantTries = strongRun ? 12 : 9;
        const elites = [...population].sort((a, b) => a.split.totalCost - b.split.totalCost).slice(0, Math.min(4, population.length));
        let added = 0;
        for (let t = 0; t < immigrantTries; t++) {
          const base = elites.length > 0 ? elites[t % elites.length] : population[Math.floor(hgsRng() * population.length)];
          if (!base) continue;
          let order = [...base.order];
          if (elites.length >= 2 && (t % 3 === 1)) {
            const mate = elites[(t + 1) % elites.length];
            order = orderCrossoverOX(base.order, mate.order, hgsRng);
          }
          const rounds = strongRun ? 5 + (t % 4) : 4 + (t % 3);
          for (let r = 0; r < rounds; r++) order = mutateOrder(order, hgsRng);
          const split = splitExactK(inst, order, K, bksPattern?.targetLoadsSorted);
          if (!split.feasible) continue;
          const educated = polishCandidate(
            inst,
            split,
            910000 + hgsGenerations * 131 + t * 17,
            strongRun ? 12 : 9,
            strongRun ? 90 : 64,
            strongRun ? 28 : 20
          );
          const sig = signatureFromOrder(order);
          if (seenOrders.has(sig)) continue;
          const inserted = registerCandidate(`hgs-reheat-${hgsReheats + 1}-${t + 1}`, educated);
          if (!inserted) continue;
          added++;
          hgsImmigrantsAccepted++;
          seenOrders.add(sig);
          population.push({
            name: `hgs-reheat-${hgsReheats + 1}-${t + 1}`,
            order,
            split: educated,
            routeOf: buildRouteOfFromSplit(inst, educated),
          });
        }
        trimPopulationByDiversity(population, hgsPopulationCap, diversityPairs);
        hgsReheats++;
        hgsNoImproveGenerations = 0;
        if (added === 0 && hgsReheats >= hgsMaxReheats) {
          hgsEarlyStop = 1;
          break;
        }
      }
    }
  }
  const hgsElapsedMs = Date.now() - hgsStart;

  // Post-HGS brutal elite intensification: freeze top elites and run deeper neighborhoods.
  let eliteBrutalTried = 0;
  let eliteBrutalAccepted = 0;
  if (!budgetExceeded() && candidates.length > 0) {
    const brutalElites = [...candidates]
      .filter(c => c.split.feasible)
      .sort((a, b) => a.split.totalCost - b.split.totalCost)
      .slice(0, strongRun ? 5 : 3);
    const brutalMap = buildCandidateMap(inst, strongRun ? 46 : 38);
    for (let ei = 0; ei < brutalElites.length && !budgetExceeded(); ei++) {
      eliteBrutalTried++;
      const base = brutalElites[ei].split;
      const deepKernel = fastInterRouteKernel(inst, base.routes, brutalMap, strongRun ? 3 : 2);
      const deepLk = deepenPromisingRoutes(inst, deepKernel.routes, brutalMap, "deep");
      const deepCross = crossExchange22Neighborhood(inst, deepLk.routes, brutalMap, strongRun ? 3 : 2);
      const deepChain = ejectionChainNeighborhood(inst, deepCross.routes, hgsRng, strongRun ? 260 : 180, brutalMap, 6);
      const deepLns = destroyRepairLns(
        inst,
        deepChain.routes,
        strongRun ? 26 : 18,
        hgsRng,
        brutalMap,
        strongRun ? 360 : 300,
        0.991,
        strongRun ? 62 : 44
      );
      const splitDeep: SplitResult = {
        routes: deepLns.routes,
        feasible: true,
        usedVehicles: K,
        totalCost: deepLns.totalCost,
      };
      const before = candidates.length;
      registerCandidate(`elite-brutal-${ei + 1}`, splitDeep);
      if (candidates.length > before) eliteBrutalAccepted++;
    }
  }

  // Rank-based quantum search with pruning + nested-greedy decoding.
  let quantumTried = 0;
  let quantumAccepted = 0;
  let quantumPruned = 0;
  let quantumNestedTried = 0;
  let quantumNestedAccepted = 0;
  if (!budgetExceeded() && allCustomers.length > 0 && candidates.length > 0) {
    const rankedQuantumSeeds = [...candidates]
      .filter(c => c.split.feasible)
      .sort((a, b) => a.split.totalCost - b.split.totalCost);
    const spatialFirst = rankedQuantumSeeds
      .filter(c => isSpatialCandidateName(c.name) || c.name.startsWith("seam-killer"))
      .slice(0, strongRun ? 8 : 5);
    const genericFirst = rankedQuantumSeeds.slice(0, strongRun ? 12 : 8);
    const mixedSeeds = [...spatialFirst, ...genericFirst];
    const seedSigs = new Set<string>();
    const quantumSeedPool = mixedSeeds
      .map(c => buildOrderFromRoutes(c.split.routes, inst.depot))
      .filter(o => o.length === allCustomers.length)
      .filter(o => {
        const sig = signatureFromOrder(o);
        if (seedSigs.has(sig)) return false;
        seedSigs.add(sig);
        return true;
      });
    if (quantumSeedPool.length > 0) {
      const nQ = allCustomers.length;
      const idToIdx = new Map<number, number>();
      allCustomers.forEach((id, i) => idToIdx.set(id, i));
      const rankModel: Float64Array[] = Array.from({ length: nQ }, () => new Float64Array(nQ));
      const quantumCandidateMap = buildCandidateMap(inst, strongRun ? 30 : 24);
      const updateRankModel = (order: number[], weight: number): void => {
        for (let p = 0; p < order.length; p++) {
          const idx = idToIdx.get(order[p]);
          if (idx !== undefined) rankModel[p][idx] += weight;
        }
      };
      quantumSeedPool.forEach((order, i) => updateRankModel(order, 1.0 / (1 + i)));

      const sampleQuantumOrder = (iter: number): number[] => {
        const order: number[] = [];
        const unvisited = new Set<number>(allCustomers);
        const seed = quantumSeedPool[iter % quantumSeedPool.length];
        let current = inst.depot;
        for (let pos = 0; pos < nQ; pos++) {
          const neigh = current === inst.depot ? [] : (quantumCandidateMap.get(current) ?? []);
          const neighSet = new Set<number>(neigh);
          const scored: Array<{ id: number; score: number }> = [];
          for (const id of unvisited) {
            const idx = idToIdx.get(id) ?? 0;
            const rankScore = rankModel[pos][idx];
            const adjBoost = neighSet.has(id) ? 0.55 : 0;
            const distPenalty = 0.012 * edgeCost(inst, current, id);
            const seedPos = pos < seed.length ? (seed[pos] === id ? 0.25 : 0) : 0;
            scored.push({ id, score: rankScore + adjBoost + seedPos - distPenalty });
          }
          scored.sort((a, b) => b.score - a.score);
          const pool = scored.slice(0, Math.min(18, scored.length));
          if (pool.length === 0) break;

          // Nested greedy lookahead inside the top ranked pool.
          const looked = pool.map(c => {
            const nextNeigh = quantumCandidateMap.get(c.id) ?? [];
            let bestNext = Number.POSITIVE_INFINITY;
            for (const nx of nextNeigh) {
              if (!unvisited.has(nx) || nx === c.id) continue;
              const d = edgeCost(inst, c.id, nx);
              if (d < bestNext) bestNext = d;
            }
            if (!Number.isFinite(bestNext)) bestNext = 0;
            return {
              id: c.id,
              merit: c.score - 0.010 * edgeCost(inst, current, c.id) - 0.006 * bestNext,
            };
          }).sort((a, b) => b.merit - a.merit);

          const topPick = looked.slice(0, Math.min(6, looked.length));
          const choose = topPick[Math.floor(Math.pow(hgsRng(), 2.7) * topPick.length)];
          order.push(choose.id);
          unvisited.delete(choose.id);
          current = choose.id;
        }
        for (const id of allCustomers) if (!order.includes(id)) order.push(id);
        return order;
      };

      const quantumIters = strictBenchmark ? 24 : (strongRun ? 128 : 72);
      const nestedCap = strictBenchmark ? 6 : (strongRun ? 24 : 12);
      for (let qi = 0; qi < quantumIters && !budgetExceeded(); qi++) {
        quantumTried++;
        const order = sampleQuantumOrder(qi);
        const split = splitExactK(inst, order, K, bksPattern?.targetLoadsSorted);
        if (!split.feasible) {
          quantumPruned++;
          continue;
        }
        const qInc = incumbentCost();
        const qNear = Number.isFinite(qInc) && split.totalCost <= qInc * (strongRun ? 1.055 : 1.075);
        if (!qNear && isOrderDominated(order, split.totalCost)) {
          quantumPruned++;
          continue;
        }
        noteOrderLowerBound(order, split.totalCost);
        const boundSlack = qi < Math.floor(quantumIters * 0.6)
          ? (strongRun ? 0.11 : 0.14)
          : (strongRun ? 0.08 : 0.11);
        if (exceedsIncumbent(split.totalCost, boundSlack)) {
          quantumPruned++;
          parkDeferred(`quantum-${qi + 1}`, split, "multistart", order);
          if (!qNear && qi % 5 !== 0) continue;
        }
        const polished = polishCandidate(
          inst,
          split,
          940000 + qi * 31,
          (strongRun ? 14 : 10) + (qNear ? 3 : 0),
          (strongRun ? 95 : 72) + (qNear ? 25 : 0),
          (strongRun ? 30 : 22) + (qNear ? 8 : 0)
        );
        if (!qNear) {
          const afterInc = incumbentCost();
          if (Number.isFinite(afterInc) && polished.totalCost > afterInc * (strongRun ? 1.08 : 1.10)) {
            quantumPruned++;
            continue;
          }
        }
        const before = candidates.length;
        registerCandidate(`quantum-rank-${qi + 1}`, polished);
        if (candidates.length > before) {
          quantumAccepted++;
          updateRankModel(order, 0.55);
        } else {
          updateRankModel(order, 0.15);
        }

        const incAfter = incumbentCost();
        const nearNow = Number.isFinite(incAfter) && polished.totalCost <= incAfter * (strictBenchmark ? 1.010 : 1.020);
        if (
          !budgetExceeded() &&
          quantumNestedTried < nestedCap &&
          nearNow
        ) {
          quantumNestedTried++;
          const qMap = buildCandidateMap(inst, strictBenchmark ? 22 : (strongRun ? 30 : 24));
          const k1 = fastInterRouteKernel(inst, polished.routes, qMap, strictBenchmark ? 1 : 2);
          const k2 = crossExchange22Neighborhood(inst, k1.routes, qMap, strictBenchmark ? 1 : 2);
          const k3 = ejectionChainNeighborhood(
            inst,
            k2.routes,
            hgsRng,
            strictBenchmark ? 110 : (strongRun ? 180 : 130),
            qMap,
            strictBenchmark ? 4 : 5
          );
          const k4 = destroyRepairLns(
            inst,
            k3.routes,
            strictBenchmark ? 10 : (strongRun ? 14 : 11),
            hgsRng,
            qMap,
            strictBenchmark ? 90 : (strongRun ? 170 : 120),
            0.992,
            strictBenchmark ? 28 : (strongRun ? 42 : 34)
          );
          const seamFix = seamDrivenPairRepair(inst, k4.routes, qMap, 2, strictBenchmark ? 2 : 3);
          const nestedSplit: SplitResult = {
            routes: seamFix.routes,
            feasible: true,
            usedVehicles: K,
            totalCost: seamFix.totalCost,
          };
          const beforeNested = candidates.length;
          registerCandidate(`quantum-nested-${qi + 1}`, nestedSplit);
          if (candidates.length > beforeNested) quantumNestedAccepted++;
        }
      }
    }
  }

  // Build diverse elite pool before relinking (different structural basins).
  const ranked = [...candidates].sort((a, b) => a.split.totalCost - b.split.totalCost);
  const elite: Array<{ name: string; split: SplitResult }> = [];
  const usedKeys = new Set<string>();
  for (const c of ranked) {
    const diag = computeTopOverlapPair(inst, c.split.routes);
    const key = `${diag?.i ?? -1}|${diag?.j ?? -1}|${Math.round((diag?.score ?? 0) * 20)}`;
    if (usedKeys.has(key)) continue;
    usedKeys.add(key);
    elite.push(c);
    if (elite.length >= 10) break;
  }
  // Fallback if diversity keys were too restrictive.
  for (const c of ranked) {
    if (elite.length >= 10) break;
    if (!elite.includes(c)) elite.push(c);
  }
  let relinkTried = 0;
  let relinkAccepted = 0;
  const relinkStart = Date.now();
  const nearRelinkSlack = strongRun ? 0.006 : 0.009;
  for (let i = 0; i < elite.length && !budgetExceeded(); i++) {
    for (let j = i + 1; j < elite.length && !budgetExceeded(); j++) {
      const aOrder = buildOrderFromRoutes(elite[i].split.routes, inst.depot);
      const bOrder = buildOrderFromRoutes(elite[j].split.routes, inst.depot);
      const blends = pathRelinkOrders(aOrder, bOrder, strictBenchmark ? 4 : 10);
      for (let bi = 0; bi < blends.length && !budgetExceeded(); bi++) {
        relinkTried++;
        const split = splitExactK(inst, blends[bi], K, bksPattern?.targetLoadsSorted);
        if (!split.feasible) continue;
        const inc = incumbentCost();
        const isNear = Number.isFinite(inc) && split.totalCost <= inc * (1 + nearRelinkSlack);
        const baseSeed = 130000 + i * 1000 + j * 100 + bi;
        const polished = isNear
          ? polishCandidate(inst, split, baseSeed, strongRun ? 30 : 22, strongRun ? 150 : 115, strongRun ? 56 : 40)
          : polishCandidate(inst, split, baseSeed, 24, 120, 45);
        const beforeCount = candidates.length;
        registerCandidate(`${isNear ? "relink-near" : "relink"}-${i}-${j}-${bi}`, polished);
        if (candidates.length > beforeCount) relinkAccepted++;
      }
    }
  }
  const relinkElapsedMs = Date.now() - relinkStart;

  // Route-pool SP-lite finalizer over elite route set (fixed-K exact-cover via penalty search).
  const spStart = Date.now();
  const spRng = makeRng(seedPack[0] + 1);
  const routePool = buildRoutePoolFromCandidates(inst, candidates, strongRun ? 130 : 100, strongRun ? 4200 : 3400);
  let spTried = 0;
  let spAccepted = 0;
  let spFeasibleFound = 0;
  let exactCoverAccepted = 0;
  let eliteSelectorAccepted = 0;
  let weakPathSkipped = 0;
  const nearSpSlack = strongRun ? 0.007 : 0.010;
  if (!budgetExceeded() && best && routePool.length > 0) {
    const exactCover = eliteRouteExactSelector(inst, best.split, routePool, K, 280_000);
    if (exactCover) {
      const inc = incumbentCost();
      const isNear = Number.isFinite(inc) && exactCover.totalCost <= inc * (1 + nearSpSlack);
      const polishedExact = isNear
        ? polishCandidate(inst, exactCover, 980000, strongRun ? 24 : 18, strongRun ? 130 : 100, strongRun ? 46 : 34)
        : polishCandidate(inst, exactCover, 980000, 16, 95, 34);
      const beforeExact = candidates.length;
      registerCandidate(`${isNear ? "sp-reduced-exactcover-near" : "sp-reduced-exactcover"}+polish`, polishedExact);
      if (candidates.length > beforeExact) exactCoverAccepted++;
    }

    const spRes = routePoolSpFinalizer(
      inst,
      best.split,
      routePool,
      K,
      spRng,
      strictBenchmark ? 3_000 : (strongRun ? 8_000 : 14_000),
      strictBenchmark ? 90_000 : 240_000
    );
    spTried = spRes.tried;
    spAccepted = spRes.accepted;
    spFeasibleFound = spRes.feasibleFound;
    if (spRes.split) {
      const inc = incumbentCost();
      const isNear = Number.isFinite(inc) && spRes.split.totalCost <= inc * (1 + nearSpSlack);
      const polishedSp = isNear
        ? polishCandidate(inst, spRes.split, 980001, strongRun ? 28 : 20, strongRun ? 150 : 110, strongRun ? 52 : 38)
        : polishCandidate(inst, spRes.split, 980001, 20, 120, 42);
      registerCandidate(`${isNear ? "sp-finalizer-near" : "sp-finalizer"}+polish`, polishedSp);
    }
    if (best) {
      const eliteExact = eliteRouteExactSelector(inst, best.split, routePool, K, 240_000);
      if (eliteExact) {
        const inc = incumbentCost();
        const isNear = Number.isFinite(inc) && eliteExact.totalCost <= inc * (1 + nearSpSlack);
        const polishedElite = isNear
          ? polishCandidate(inst, eliteExact, 980011, strongRun ? 24 : 18, strongRun ? 135 : 100, strongRun ? 48 : 34)
          : polishCandidate(inst, eliteExact, 980011, 18, 110, 40);
        const beforeCount = candidates.length;
        registerCandidate(`${isNear ? "elite-exact-selector-near" : "elite-exact-selector"}+polish`, polishedElite);
        if (candidates.length > beforeCount) eliteSelectorAccepted++;
      }
    }

    // If route-pool exact components are dormant, skip further SP-heavy work and shift time to endgame.
    if (spAccepted === 0 && exactCoverAccepted === 0 && eliteSelectorAccepted === 0) {
      weakPathSkipped = 1;
    }
  }
  const spElapsedMs = Date.now() - spStart;

  // Macro topology cycle: gated repartition + boundary exact subsolve.
  const macroStart = Date.now();
  let macroTried = 0;
  let macroAccepted = 0;
  let boundaryExactTried = 0;
  let boundaryExactAccepted = 0;
  let macroCycles = strongRun ? 3 : 2;
  const macroRng = makeRng(seedPack[0] + 101);
  if (!budgetExceeded() && best && macroCycles > 0) {
    let prevDiag = computeStructuralDiagnostics(inst, best.split.routes);
    for (let cyc = 0; cyc < macroCycles; cyc++) {
      const seamHigh = prevDiag.seamCostRatio > 0.65;
      const stagnant = cyc === 0 || prevDiag.seamCostRatio >= 0.70;
      if (!seamHigh || !stagnant) break;
      macroTried++;
      const next = macroRepartitionOneCycle(inst, best.split, K, macroRng);
      if (!next) break;
      const beforeCount = candidates.length;
      registerCandidate(`macro-repartition-${cyc + 1}`, next);
      if (candidates.length > beforeCount) {
        macroAccepted++;
        if (best && next.totalCost + 1e-9 < best.split.totalCost) {
          best = { name: `macro-repartition-${cyc + 1}`, split: next };
        }
        prevDiag = computeStructuralDiagnostics(inst, best.split.routes);
      } else {
        break;
      }
    }
  }
  const macroElapsedMs = Date.now() - macroStart;

  // Boundary overlap exact recombination on seam-heavy route groups.
  if (!budgetExceeded() && best) {
    const boundaryRng = makeRng(seedPack[0] + 707);
    const bo = boundaryOverlapExactPass(inst, best.split, K, boundaryRng, strongRun ? 3 : 2);
    boundaryExactTried = bo.tried;
    boundaryExactAccepted = bo.accepted;
    if (bo.split) {
      const beforeCount = candidates.length;
      registerCandidate("boundary-overlap-exact", bo.split);
      if (candidates.length > beforeCount && bo.split.totalCost + 1e-9 < best.split.totalCost) {
        best = { name: "boundary-overlap-exact", split: bo.split };
      }
    }
  }

  const intensifyAnchors = budgetExceeded()
    ? []
    : chooseDiverseAnchorsForIntensify(inst, candidates, strictBenchmark ? 1 : (strongRun ? 3 : 2));
  const sepStart = Date.now();
  let sepTried = 0;
  let sepImproved = 0;
  let sepBonusRounds = 0;
  const sepRoundBoost = weakPathSkipped ? (strongRun ? 3 : 2) : 0;
  for (let ai = 0; ai < intensifyAnchors.length && !budgetExceeded(); ai++) {
    const anchor = intensifyAnchors[ai];
    const sepBaseRounds = (strictBenchmark ? 2 : (strongRun ? 4 : 3)) + sepRoundBoost;
    const sepRes = separatorExactIntensify(
      inst,
      anchor.split,
      K,
      spRng,
      bksPattern?.targetLoadsSorted,
      sepBaseRounds
    );
    sepTried += sepRes.tried;
    sepImproved += sepRes.improved;
    if (sepRes.split) registerCandidate(`separator-exact-a${ai}+polish`, sepRes.split);
    if (sepRes.improved > 0) {
      sepBonusRounds = Math.max(sepBonusRounds, strictBenchmark ? 1 : (strongRun ? 4 : 2));
      const bonusSeedSplit = sepRes.split ?? anchor.split;
      const sepBonus = separatorExactIntensify(
        inst,
        bonusSeedSplit,
        K,
        spRng,
        bksPattern?.targetLoadsSorted,
        strictBenchmark ? 1 : (strongRun ? 4 : 2)
      );
      sepTried += sepBonus.tried;
      sepImproved += sepBonus.improved;
      if (sepBonus.split) registerCandidate(`separator-exact-bonus-a${ai}+polish`, sepBonus.split);
    }
  }
  const sepElapsedMs = Date.now() - sepStart;

  const bundleStart = Date.now();
  let bundleTried = 0;
  let bundleImproved = 0;
  let bundlePass1Improved = 0;
  let bundlePass2Improved = 0;
  for (let ai = 0; ai < intensifyAnchors.length && !budgetExceeded(); ai++) {
    const anchor = intensifyAnchors[ai];
    const bundleRes = routeBundleChainIntensify(
      inst,
      anchor.split,
      K,
      spRng,
      bksPattern?.targetLoadsSorted,
      (strictBenchmark ? 2 : (strongRun ? 5 : 4)) + (weakPathSkipped ? (strictBenchmark ? 0 : 2) : 0)
    );
    bundleTried += bundleRes.tried;
    bundleImproved += bundleRes.improved;
    bundlePass1Improved += bundleRes.pass1Improved;
    bundlePass2Improved += bundleRes.pass2Improved;
    if (bundleRes.split) registerCandidate(`bundle-exact-a${ai}+polish`, bundleRes.split);
  }
  const bundleElapsedMs = Date.now() - bundleStart;

  if (!budgetExceeded() && deferredHistorical) {
    const historicalPolished = polishCandidate(
      inst,
      deferredHistorical.split,
      250001,
      strongRun ? 38 : 30,
      strongRun ? 220 : 180,
      strongRun ? 84 : 68
    );
    noteOrderLowerBound(deferredHistorical.order, historicalPolished.totalCost);
    const inserted = registerCandidate(
      `historical-late:${deferredHistorical.candidate}`,
      historicalPolished
    );
    if (inserted) historicalLateAccepted = 1;
  }

  // Endgame intensification: incumbent-only heavy polish + SP reruns.
  const endgameStart = Date.now();
  const endgameMaxIterations = strictBenchmark
    ? 4
    : strongRun
    ? (weakPathSkipped ? 24 : 16)
    : (weakPathSkipped ? 12 : 9);
  let endgameIterations = 0;
  let endgameAccepted = 0;
  let endgameSpAccepted = 0;
  let seedRound = 0;
  let endNoImprove = 0;
  const endNoImproveLimit = weakPathSkipped ? (strongRun ? 8 : 6) : (strongRun ? 7 : 5);
  let endgameEarlyStop = 0;
  while (best && endgameIterations < endgameMaxIterations && !budgetExceeded()) {
    const endBestBefore = incumbentCost();
    const s = seedPack[seedRound % seedPack.length];
    seedRound++;
    endgameIterations++;
    const deep = polishCandidate(
      inst,
      best.split,
      990000 + s * 7 + endgameIterations * 17,
      weakPathSkipped ? 32 : 24,
      weakPathSkipped ? 230 : 190,
      weakPathSkipped ? 80 : 62
    );
    const beforeCount = candidates.length;
    registerCandidate(`endgame-heavy-${endgameIterations}`, deep);
    if (candidates.length > beforeCount) endgameAccepted++;

    if (!weakPathSkipped && endgameIterations % 3 === 0) {
      const endPool = buildRoutePoolFromCandidates(inst, candidates, strongRun ? 130 : 110, strongRun ? 4200 : 3600);
      const endExact = eliteRouteExactSelector(inst, best.split, endPool, K, strongRun ? 260_000 : 180_000);
      if (endExact) {
        const polishedEndExact = polishCandidate(inst, endExact, 991500 + s * 5 + endgameIterations * 11, 12, 70, 26);
        registerCandidate(`endgame-exact-${endgameIterations}`, polishedEndExact);
      }
      const endSp = routePoolSpFinalizer(
        inst,
        best.split,
        endPool,
        K,
        spRng,
        strictBenchmark ? 2_000 : (strongRun ? 6_000 : 10_000),
        strictBenchmark ? 90_000 : 260_000
      );
      if (endSp.split) {
        const polishedEndSp = polishCandidate(inst, endSp.split, 991000 + s * 3 + endgameIterations * 19, 14, 90, 30);
        const beforeSp = candidates.length;
        registerCandidate(`endgame-sp-${endgameIterations}`, polishedEndSp);
        if (candidates.length > beforeSp) endgameSpAccepted++;
      }
    }
    const endBestAfter = incumbentCost();
    if (endBestAfter + 1e-9 < endBestBefore) {
      endNoImprove = 0;
    } else {
      endNoImprove++;
      if (endNoImprove >= endNoImproveLimit) {
        endgameEarlyStop = 1;
        break;
      }
    }
  }
  // Deferred rescue: revisit best parked near-incumbent candidates for extra gap reduction.
  if (!budgetExceeded() && deferredBank.length > 0) {
    const reasonRank = (r: DeferredCandidate["reason"]): number => (r === "hgs" ? 0 : r === "multistart" ? 1 : 2);
    deferredBank.sort((a, b) => {
      if (a.overRatio !== b.overRatio) return a.overRatio - b.overRatio;
      const rr = reasonRank(a.reason) - reasonRank(b.reason);
      if (rr !== 0) return rr;
      return a.insertedAt - b.insertedAt;
    });
    const rescueCount = Math.min(deferredBank.length, strictBenchmark ? 6 : (strongRun ? 22 : 14));
    for (let i = 0; i < rescueCount; i++) {
      const cand = deferredBank[i];
      const tuned = polishCandidate(
        inst,
        cand.split,
        995000 + i * 97,
        strongRun ? 26 : 18,
        strongRun ? 170 : 120,
        strongRun ? 58 : 42
      );
      deferredPolished++;
      if (cand.order) noteOrderLowerBound(cand.order, tuned.totalCost);
      const before = candidates.length;
      registerCandidate(`deferred-rescue-${i + 1}:${cand.reason}:${cand.name}`, tuned);
      if (candidates.length > before) deferredAccepted++;
    }
  }
  const endgameElapsedMs = Date.now() - endgameStart;
  if (best) structuralAfter = computeStructuralDiagnostics(inst, best.split.routes);

  const totalDemand = Array.from(inst.demands.entries())
    .filter(([id]) => id !== inst.depot)
    .reduce((s, [, d]) => s + d, 0);

  const elapsedMs = Date.now() - searchStart;

  console.log("\n=== ReasonRoute CVRPLIB Benchmark (GNOPT Pattern Mode) ===");
  console.log(`Instance:          ${inst.name}`);
  console.log(`Dimension:         ${inst.dimension}`);
  console.log(`Capacity:          ${inst.capacity}`);
  console.log(`Vehicle target:    ${K}`);
  console.log(`Run profile:       ${runProfile}`);
  console.log(`Run mode:          ${runMode}`);
  console.log(`Strict benchmark:  ${strictBenchmark ? "YES" : "NO"}`);
  console.log(`Budget cap:        ${Math.round(benchmarkBudgetMs / 60000)} min`);
  console.log(`Seed pack:         ${seedPack.join(",")}`);
  console.log(`Total demand:      ${totalDemand}`);
  console.log(`Edge weight type:  ${inst.edgeWeightType}`);
  console.log(`Runtime(engine):   ${runtimeMs.toFixed(1)} ms`);

  if (bksPattern) {
    console.log("\n--- BKS Pattern ---");
    console.log(`BKS routes:        ${bksPattern.routeCount}`);
    console.log(`Avg stops/route:   ${bksPattern.avgStops.toFixed(2)}`);
    console.log(`Avg load/route:    ${bksPattern.avgLoad.toFixed(2)}`);
    console.log(`Load range:        ${bksPattern.minLoad}..${bksPattern.maxLoad}`);
  }
  if (!strictBenchmark && historicalSeed) {
    console.log(`Historical seed:   ${historicalSeed.source} (${historicalSeed.candidate})`);
    console.log(`Pinned seed:       ${pinnedSeed ? "YES" : "NO"}`);
    console.log(`History prune:     kept=${historicalPrune.kept} removed=${historicalPrune.removed}`);
    console.log(`History deferred:  ${historicalDeferred ? "YES" : "NO"}${historicalLateAccepted ? " -> late-add" : ""}`);
  }
  console.log(`Engine routes:     ${engineRoutesFeasible ? "feasible" : "unavailable"}`);
  console.log(`Engine accepted:   ${engineRoutesAccepted}`);
  console.log(`Engine polish gain:${engineRoutePostPolishGain.toFixed(1)}`);
  console.log(`SeamKiller rounds: ${seamKillerRounds}`);
  console.log(`SeamKiller accept: ${seamKillerAccepted}/${Math.max(0, seamKillerCandidates)}`);
  console.log(`SeamKiller gain:   ${seamKillerCostGain.toFixed(1)}`);
  console.log(`Spatial rounds:    ${spatialIntensifyRounds}`);
  console.log(`Spatial accepted:  ${spatialIntensifyAccepted}`);
  console.log(`Escape rounds:     ${seamEscapeTried}`);
  console.log(`Escape accepted:   ${seamEscapeAccepted}`);
  if (engineRouteSeamBefore !== undefined) {
    const seamAfter = engineRouteSeamAfter ?? engineRouteSeamBefore;
    console.log(`Engine seam ratio: ${(engineRouteSeamBefore * 100).toFixed(1)}% -> ${(seamAfter * 100).toFixed(1)}%`);
  }
  if (seamKillerSeamBefore !== undefined && seamKillerSeamAfter !== undefined) {
    console.log(`SeamKiller seam:   ${(seamKillerSeamBefore * 100).toFixed(1)}% -> ${(seamKillerSeamAfter * 100).toFixed(1)}%`);
  }

  console.log("\n--- Multi-Start Search ---");
  console.log(`Starts tried:      ${startsTried}`);
  console.log(`Feasible starts:   ${startsFeasible}`);
  console.log(`Prune dup starts:  ${pruneStartDuplicate}`);
  console.log(`Prune order-dom:   ${pruneOrderDominated}`);
  console.log(`Prune by bound:    ${pruneIncumbentBound}`);
  console.log(`Prune head-polish: ${pruneHeadstartPolish}`);
  console.log(`Deferred parked:   ${deferredStored} (drop ${deferredDropped})`);
  console.log(`Deferred rescue:   ${deferredAccepted}/${deferredPolished}`);
  console.log(`MS stagnation:     ${msNoImprove}/${msNoImproveLimit}${msEarlyStop ? " (stop)" : ""}`);
  console.log(`Search elapsed:    ${elapsedMs} ms`);
  console.log(`Relink tried:      ${relinkTried}`);
  console.log(`Relink accepted:   ${relinkAccepted}`);
  console.log(`Relink elapsed:    ${relinkElapsedMs} ms`);
  console.log(`HGS generations:   ${hgsGenerations}`);
  console.log(`HGS children:      ${hgsChildrenAccepted}/${hgsChildrenTried}`);
  console.log(`HGS route-SREX:    ${hgsRouteSrexChildren}`);
  console.log(`HGS SREX kids:     ${hgsSrexChildren}`);
  console.log(`HGS OX kids:       ${hgsOxChildren}`);
  console.log(`HGS split yield:   ${hgsChildrenWithSplit}/${hgsChildAttempts}`);
  console.log(`HGS med edu:       ${hgsMediumEducationRuns}`);
  console.log(`HGS deep edu:      ${hgsDeepEducationRuns}`);
  console.log(`HGS reheats:       ${hgsReheats}/${hgsMaxReheats} (immigrants ${hgsImmigrantsAccepted})`);
  console.log(`HGS parent BPD:    ${hgsParentPairs > 0 ? (hgsAvgParentDistance / hgsParentPairs).toFixed(3) : "0.000"}`);
  console.log(`HGS stagnation:    ${hgsNoImproveGenerations}/${hgsNoImproveLimit}${hgsEarlyStop ? " (stop)" : ""}`);
  console.log(`HGS elapsed:       ${hgsElapsedMs} ms`);
  console.log(`Elite brutal:      ${eliteBrutalAccepted}/${eliteBrutalTried}`);
  console.log(`Quantum tried:     ${quantumTried}`);
  console.log(`Quantum accepted:  ${quantumAccepted}`);
  console.log(`Quantum nested:    ${quantumNestedAccepted}/${quantumNestedTried}`);
  console.log(`Quantum pruned:    ${quantumPruned}`);
  console.log(`SP pool size:      ${routePool.length}`);
  console.log(`SP moves:          ${spAccepted}/${spTried}`);
  console.log(`SP feasible hits:  ${spFeasibleFound}`);
  console.log(`SP exact cover:    ${exactCoverAccepted}`);
  console.log(`SP elite exact:    ${eliteSelectorAccepted}`);
  console.log(`Weak path skip:    ${weakPathSkipped ? "YES" : "NO"}`);
  console.log(`INT anchors:       ${intensifyAnchors.length}`);
  console.log(`Macro cycles:      ${macroAccepted}/${macroTried}`);
  console.log(`Boundary exact:    ${boundaryExactAccepted}/${boundaryExactTried}`);
  console.log(`Macro elapsed:     ${macroElapsedMs} ms`);
  console.log(`SP elapsed:        ${spElapsedMs} ms`);
  console.log(`SEP tries:         ${sepTried}`);
  console.log(`SEP improved:      ${sepImproved}`);
  console.log(`SEP bonus rounds:  ${sepBonusRounds}`);
  console.log(`SEP elapsed:       ${sepElapsedMs} ms`);
  console.log(`BUNDLE tries:      ${bundleTried}`);
  console.log(`BUNDLE improved:   ${bundleImproved}`);
  console.log(`BUNDLE p1/p2:      ${bundlePass1Improved}/${bundlePass2Improved}`);
  console.log(`BUNDLE elapsed:    ${bundleElapsedMs} ms`);
  console.log(`Endgame iters:     ${endgameIterations}`);
  console.log(`End stagnation:    ${endNoImprove}/${endNoImproveLimit}${endgameEarlyStop ? " (stop)" : ""}`);
  console.log(`Endgame accepted:  ${endgameAccepted}`);
  console.log(`Endgame SP adds:   ${endgameSpAccepted}`);
  console.log(`Endgame elapsed:   ${endgameElapsedMs} ms`);
  console.log(`Mod-p tried:       ${modPTried}`);
  console.log(`Mod-p improved:    ${modPImproved}`);
  console.log(`Axiom boost used:  ${axiomBoostAccepted ? "YES" : "NO"}`);
  if (structuralBefore) {
    const top = structuralBefore.overlapPairs[0];
    const hub = structuralBefore.hubs[0];
    console.log(`Seam cost ratio:   ${(structuralBefore.seamCostRatio * 100).toFixed(1)}%`);
    if (top) {
      console.log(`Top overlap pair:  r${top.i + 1}<->r${top.j + 1} score=${top.score.toFixed(3)} moved=${top.moved}/${top.denom}`);
    }
    if (hub) {
      console.log(`Top hub candidate: node=${hub.node} cross=${hub.crossNeighbors}/12 dDepot=${hub.depotDist.toFixed(1)}`);
    }
    console.log(`Dominant pattern:  ${structuralBefore.dominant}`);
  }
  if (structuralAfter) {
    const top = structuralAfter.overlapPairs[0];
    console.log(`Post seam ratio:   ${(structuralAfter.seamCostRatio * 100).toFixed(1)}%`);
    if (top) {
      console.log(`Post-refine overlap: r${top.i + 1}<->r${top.j + 1} score=${top.score.toFixed(3)} moved=${top.moved}/${top.denom}`);
    }
  }

  if (spatialLock && bestSpatial && best) {
    // Spatial winner must stay quality-competitive; avoid forcing poor topology incumbents.
    if (bestSpatial.split.totalCost <= best.split.totalCost * 1.01) {
      best = bestSpatial;
    }
  }

  if (candidates.length === 0 || !best) {
    console.log("\n--- Result ---");
    console.log("No feasible k-limited candidate found.");
  } else {
    const top = [...candidates].sort((a, b) => a.split.totalCost - b.split.totalCost).slice(0, 12);
    console.log("\n--- Top Candidates ---");
    for (const c of top) {
      const loads = summarizeLoads(inst, c.split.routes);
      console.log(`${c.name}: cost=${c.split.totalCost} | load=${loads.min}..${loads.max}`);
    }

    const loads = summarizeLoads(inst, best.split.routes);
    console.log("\n--- Best Result ---");
    console.log(`Best candidate:    ${best.name}`);
    console.log(`Feasible:          YES`);
    console.log(`Vehicles used:     ${best.split.usedVehicles}`);
    console.log(`Total cost:        ${best.split.totalCost}`);
    console.log(`Load range:        ${loads.min}..${loads.max} (avg ${loads.avg.toFixed(2)})`);

    if (bksCost !== undefined) {
      console.log("\n--- Gap vs BKS ---");
      console.log(`BKS:               ${bksCost}`);
      console.log(`Gap:               ${percentGap(best.split.totalCost, bksCost).toFixed(2)}%`);
    } else {
      console.log("\nBKS not provided. Use --sol <solution_file> or --bks <value>.");
    }
    const saved = writeBestSolution(inst, best);
    console.log("\n--- Saved Artifacts ---");
    console.log(`JSON:              ${saved.jsonPath}`);
    console.log(`SOL:               ${saved.solPath}`);
    if (!strictBenchmark) {
      const pinnedPath = writePinnedBestSolution(inst, best, saved.jsonPath);
      console.log(`PINNED:            ${pinnedPath}`);
    }
  }

  console.log("\nNotes:");
  console.log("- Added 2-route exchange and ejection-chain neighborhoods.");
  console.log("- Added SeamKiller global topology replacement stage (deterministic seam-first incumbent rewrite).");
  console.log("- Added path-relinking recombination on top incumbents and persisted best solution artifacts.\n");
}

main();





