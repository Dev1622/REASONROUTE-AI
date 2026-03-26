// reasonRouteEngine.ts
// GNOPT-Inspired Spatial Reasoning Engine v4.0 

import {
  Node,
  TrafficContext,
  PathMetrics,
  euclidean,
  getEdgeCost,
  nearestNeighbor,
  twoOpt,
  evaluatePath,
} from "./baslineSolver";

// ─────────────────────────────────────────────────────────
// Public types (unchanged)
// ─────────────────────────────────────────────────────────

export type ConstraintType =
  | "timeWindow"
  | "restrictedZone"
  | "driverShift"
  | "capacity"
  | "exclusion";

export type Constraint = {
  id: string;
  type: ConstraintType;
  details: string;
  appliesTo: string[];
  arity: number;
};

export type AlnsOptions = {
  enabled?: boolean;
  maxIterations?: number;
  timeBudgetMs?: number;
  lanes?: number;
  temperatureStart?: number;
  temperatureEnd?: number;
  reactionFactor?: number;
  removeMinFrac?: number;
  removeMaxFrac?: number;
};

export type EngineInput = {
  nodes: Node[];
  depotId: string;
  constraints?: Constraint[];
  trafficHeatmap?: number[][];
  disruptionZones?: { x: number; y: number; radius: number; description: string }[];
  preferences?: {
    weightTime: number;
    weightEmissions: number;
    weightDistance: number;
  };
  optimization?: {
    mode?: "fast" | "quality";
    seed?: number;
    timeBudgetMs?: number;
    benchmarkPure?: boolean;
    alns?: AlnsOptions;
  };
  benchmark?: {
    metric: "cvrplib_euc2d";
    vehicleCount: number;
    vehicleCapacity: number;
    demands: Record<string, number>;
  };
};

export type CompressionPattern = {
  type: "hub" | "sunflower" | "denseCluster" | "depotMacro";
  id: string;
  involvedNodeIds: string[];
  macroNodeId: string;
  description: string;
};

export type EngineResult = {
  baselinePath: string[];
  optimizedPath: string[];
  metrics: {
    baseline: PathMetrics;
    optimized: PathMetrics;
    improvement: {
      distancePct: number;
      timePct: number;
      emissionsPct: number;
    };
  };
  detectedPatterns: CompressionPattern[];
  engineLogs: string[];
  recursionDepth: number;
  skippedNodes?: string[];
  optimizedRoutes?: string[][];
};

// ─────────────────────────────────────────────────────────
// Internal types (unchanged)
// ─────────────────────────────────────────────────────────

type InteractionGraph = {
  nodes: Node[];
  constraints: Constraint[];
};

type Gadget = {
  type: "hub" | "sunflower" | "denseCluster" | "depotMacro";
  id: string;
  replacedNodeIds: string[];
  macroNode: Node;
  description: string;
};

// ─────────────────────────────────────────────────────────
// Stage 0: Normalization (unchanged)
// ─────────────────────────────────────────────────────────

function normalizeConstraints(
  nodes: Node[],
  constraints: Constraint[],
  logs: string[]
): InteractionGraph {
  const result: Constraint[] = [];
  let helperCount = 0;

  for (const c of constraints) {
    if (c.appliesTo.length <= 3) {
      result.push({ ...c, arity: c.appliesTo.length });
      continue;
    }
    let remaining = [...c.appliesTo];
    while (remaining.length > 2) {
      const chunk = remaining.splice(0, 2);
      const helperName = `_h${helperCount++}`;
      result.push({
        id: `${c.id}_s${helperCount}`,
        type: c.type,
        details: `${c.details} [norm]`,
        appliesTo: [...chunk, helperName],
        arity: 3,
      });
      remaining.unshift(helperName);
    }
    logs.push(`[Norm] Decomposed ${c.id} (arity ${c.appliesTo.length}) into binary tree.`);
  }

  return { nodes, constraints: result };
}

// ─────────────────────────────────────────────────────────
// Stage 2: Pattern Compression & Trap Removal (unchanged)
// ─────────────────────────────────────────────────────────

function buildConstraintDegreeMap(g: InteractionGraph): Map<string, number> {
  const map = new Map<string, number>();
  for (const c of g.constraints) {
    for (const nodeId of c.appliesTo) {
      map.set(nodeId, (map.get(nodeId) ?? 0) + 1);
    }
  }
  return map;
}

function getCentroid(nodeIds: string[], allNodes: Node[]): { x: number; y: number } {
  const members = allNodes.filter(n => nodeIds.includes(n.id));
  if (members.length === 0) return { x: 50, y: 50 };
  const x = members.reduce((s, n) => s + n.x, 0) / members.length;
  const y = members.reduce((s, n) => s + n.y, 0) / members.length;
  return { x, y };
}

function detectGeoClusters(nodes: Node[], threshold: number): Map<string, string[]> {
  const visited  = new Set<string>();
  const clusters = new Map<string, string[]>();

  for (const pivot of nodes) {
    if (visited.has(pivot.id)) continue;
    const members = nodes.filter(n => {
      if (visited.has(n.id)) return false;
      const dx = n.x - pivot.x;
      const dy = n.y - pivot.y;
      return Math.sqrt(dx * dx + dy * dy) <= threshold;
    });
    if (members.length >= 3) {
      members.forEach(m => visited.add(m.id));
      clusters.set(pivot.id, members.map(m => m.id));
    }
  }
  return clusters;
}

function applyGadget(g: InteractionGraph, gadget: Gadget): InteractionGraph {
  const nodes = [
    ...g.nodes.filter(n => !gadget.replacedNodeIds.includes(n.id)),
    gadget.macroNode,
  ];
  const constraints = g.constraints.map(c => ({
    ...c,
    appliesTo: c.appliesTo.map(id =>
      gadget.replacedNodeIds.includes(id) ? gadget.macroNode.id : id
    ),
  }));
  return { nodes, constraints };
}

function runPreprocessorP(
  graph: InteractionGraph,
  depotId: string,
  ctx: TrafficContext,
  logs: string[],
  benchmarkPure = false
): { compressedGraph: InteractionGraph; gadgets: Gadget[]; patterns: CompressionPattern[]; skippedNodes: string[] } {

  // 1. Trap filtering (unchanged)
  const safeNodes: Node[]    = [];
  const skippedNodes: string[] = [];

  const getSeverity = (x: number, y: number): number => {
    if (!ctx.heatmap || ctx.heatmap.length === 0) return 0;
    const rows = ctx.heatmap.length;
    const cols = ctx.heatmap[0]?.length ?? 0;
    if (rows === 0 || cols === 0) return 0;
    const r = Math.min(rows - 1, Math.max(0, Math.floor((y / 100) * rows)));
    const c = Math.min(cols - 1, Math.max(0, Math.floor((x / 100) * cols)));
    return ctx.heatmap[r]?.[c] ?? 0;
  };

  if (benchmarkPure) {
    safeNodes.push(...graph.nodes);
    logs.push("[Stage 2] Benchmark-pure mode: trap filtering disabled.");
  } else {
    for (const n of graph.nodes) {
      if (n.id === depotId) { safeNodes.push(n); continue; }

      const severity = getSeverity(n.x, n.y);
      const inDisruption = ctx.disruptionZones?.some(z => {
        const dx = n.x - z.x;
        const dy = n.y - z.y;
        return Math.sqrt(dx * dx + dy * dy) <= z.radius;
      });

      if (severity > 0.85 || inDisruption) {
        skippedNodes.push(n.id);
        logs.push(`[Context Override] Node ${n.id} is in Gridlock/Disruption (Sev: ${severity.toFixed(2)}). REMOVING.`);
      } else {
        safeNodes.push(n);
      }
    }
  }

  // 2. Pattern Compression (unchanged logic)
  let current = { nodes: [...safeNodes], constraints: [...graph.constraints] };
  const gadgets: Gadget[]             = [];
  const patterns: CompressionPattern[] = [];
  let counter = 0;

  // 2a. Depot-aware macro grouping (signature compression):
  // group near-depot customers by angle/radius buckets and compress early.
  const depotNode = current.nodes.find(n => n.id === depotId);
  if (depotNode) {
    const reals = current.nodes.filter(n => n.id !== depotId && n.type !== "virtual");
    if (reals.length >= 80) {
      const dists = reals
        .map(n => Math.hypot(n.x - depotNode.x, n.y - depotNode.y))
        .sort((a, b) => a - b);
      const nearIdx = Math.min(dists.length - 1, Math.max(0, Math.floor(dists.length * 0.18)));
      const nearThreshold = dists[nearIdx] ?? 0;
      if (nearThreshold > 0) {
        const groups = new Map<string, string[]>();
        for (const n of reals) {
          const dx = n.x - depotNode.x;
          const dy = n.y - depotNode.y;
          const dist = Math.hypot(dx, dy);
          if (dist > nearThreshold) continue;
          const ang = ((Math.atan2(dy, dx) + Math.PI * 2) % (Math.PI * 2));
          const angleBucket = Math.floor((ang / (Math.PI * 2)) * 12); // 30-degree buckets
          const radiusBucket = Math.min(2, Math.floor((dist / nearThreshold) * 3));
          const key = `${angleBucket}|${radiusBucket}`;
          const arr = groups.get(key);
          if (arr) arr.push(n.id);
          else groups.set(key, [n.id]);
        }

        for (const [sig, ids] of groups) {
          const stillPresent = ids.filter(id => current.nodes.some(n => n.id === id));
          if (stillPresent.length < 3) continue;
          const macroId = `DEPOT_SIG_${counter}`;
          const { x, y } = getCentroid(stillPresent, current.nodes);
          const macro: Node = { id: macroId, x, y, type: "virtual" };
          const gadget: Gadget = {
            type: "depotMacro",
            id: `g_depot_${counter++}`,
            replacedNodeIds: stillPresent,
            macroNode: macro,
            description: `Depot signature group ${sig} (${stillPresent.length} nodes)`,
          };
          gadgets.push(gadget);
          patterns.push({
            type: "depotMacro",
            id: gadget.id,
            involvedNodeIds: stillPresent,
            macroNodeId: macroId,
            description: `Depot-aware signature macro compressed (${stillPresent.length} stops).`,
          });
          current = applyGadget(current, gadget);
          logs.push(`[Stage 2] Depot signature ${sig} (${stillPresent.length} stops) -> ${macroId}`);
        }
      }
    }
  }

  if (current.constraints.length > 0) {
    const degreeMap = buildConstraintDegreeMap(current);
    for (const [nodeId, degree] of degreeMap) {
      if (degree > 4 && nodeId !== depotId) {
        const hubNode = current.nodes.find(n => n.id === nodeId);
        if (!hubNode) continue;
        const macroId = `HUB_${nodeId}`;
        const macro: Node = { ...hubNode, id: macroId, type: "virtual" };
        const gadget: Gadget = { type: "hub", id: `g_hub_${counter++}`, replacedNodeIds: [nodeId], macroNode: macro, description: `Hub at ${nodeId} (degree ${degree})` };
        gadgets.push(gadget);
        patterns.push({ type: "hub", id: gadget.id, involvedNodeIds: [nodeId], macroNodeId: macroId, description: `Parity-star hub at node ${nodeId} (${degree} constraint connections). Compressed.` });
        current = applyGadget(current, gadget);
        logs.push(`[Stage 2] Hub detected at ${nodeId} (degree=${degree}). → ${macroId}`);
      }
    }
  }

  for (const c of current.constraints) {
    const active = c.appliesTo.filter(id => current.nodes.some(n => n.id === id));
    if (active.length >= 4) {
      const petals = active.slice(1);
      const safe   = petals.filter(id => id !== depotId);
      if (safe.length < 2) continue;
      const macroId    = `SUN_${c.id}`;
      const { x, y }   = getCentroid(active, current.nodes);
      const macro: Node = { id: macroId, x, y, type: "virtual" };
      const gadget: Gadget = { type: "sunflower", id: `g_sun_${counter++}`, replacedNodeIds: safe, macroNode: macro, description: `Sunflower on ${c.id} (${safe.length} petals)` };
      gadgets.push(gadget);
      patterns.push({ type: "sunflower", id: gadget.id, involvedNodeIds: active, macroNodeId: macroId, description: `Sunflower pattern: constraint ${c.id} links ${active.length} nodes. Petals compressed.` });
      current = applyGadget(current, gadget);
      logs.push(`[Stage 2] Sunflower on ${c.id} (${safe.length} petals) → ${macroId}`);
    }
  }

  const nonDepotReal = current.nodes.filter(n => n.id !== depotId && n.type !== "virtual");
  const CLUSTER_THRESH = 20;
  const clusters = detectGeoClusters(nonDepotReal, CLUSTER_THRESH);

  for (const [pivotId, memberIds] of clusters) {
    const safe          = memberIds.filter(id => id !== depotId);
    if (safe.length < 2) continue;
    const stillPresent = safe.filter(id => current.nodes.some(n => n.id === id));
    if (stillPresent.length < 2) continue;

    const macroId    = `CLUSTER_${pivotId}`;
    const { x, y }   = getCentroid(stillPresent, current.nodes);
    const macro: Node = { id: macroId, x, y, type: "virtual" };
    const gadget: Gadget = { type: "denseCluster", id: `g_cluster_${counter++}`, replacedNodeIds: stillPresent, macroNode: macro, description: `Dense cluster of ${stillPresent.length} stops near (${x.toFixed(1)},${y.toFixed(1)})` };
    gadgets.push(gadget);
    patterns.push({ type: "denseCluster", id: gadget.id, involvedNodeIds: stillPresent, macroNodeId: macroId, description: `Dense Minor: ${stillPresent.length} stops within ${CLUSTER_THRESH} units of ${pivotId}. Micro-routed internally.` });
    current = applyGadget(current, gadget);
    logs.push(`[Stage 2] Dense cluster near ${pivotId} (${stillPresent.length} stops) → ${macroId}`);
  }

  return { compressedGraph: current, gadgets, patterns, skippedNodes };
}

// ─────────────────────────────────────────────────────────
// Stage 3: Recursive Refinement
// FIX: recursiveSolve now returns OPEN paths (no closing node).
// Previously nearestNeighbor returned closed tours [A,...,A] and the
// stitch logic tried to deduplicate the seam — but this produced
// intermediate depot visits in the middle of multi-partition routes.
// Now: all internal paths are open; depot is closed exactly ONCE
// at the very end in runReasonRouteEngine.
// ─────────────────────────────────────────────────────────

function spectralPartition(
  nodes: Node[],
  depotId: string,
  ctx: TrafficContext
): { left: Node[]; right: Node[] } {
  const depot = nodes.find(n => n.id === depotId) ?? nodes[0];
  const others = nodes.filter(n => n.id !== depot.id);
  if (others.length < 20) {
    const sorted = [...nodes].sort((a, b) =>
      getEdgeCost(depot, a, ctx).composite - getEdgeCost(depot, b, ctx).composite
    );
    const mid = Math.ceil(sorted.length / 2);
    return { left: sorted.slice(0, mid), right: sorted.slice(mid) };
  }

  // Rank-aware clustering proxy: angular buckets + cross-interaction matrix.
  const bucketCount = Math.max(8, Math.min(16, Math.floor(Math.sqrt(others.length / 2))));
  const buckets: Node[][] = Array.from({ length: bucketCount }, () => []);
  const bucketMeta = Array.from({ length: bucketCount }, () => ({
    cx: 0,
    cy: 0,
    r: 0,
    count: 0,
  }));

  for (const n of others) {
    const dx = n.x - depot.x;
    const dy = n.y - depot.y;
    const ang = ((Math.atan2(dy, dx) + Math.PI * 2) % (Math.PI * 2));
    const b = Math.min(bucketCount - 1, Math.floor((ang / (Math.PI * 2)) * bucketCount));
    buckets[b].push(n);
    bucketMeta[b].cx += n.x;
    bucketMeta[b].cy += n.y;
    bucketMeta[b].r += Math.hypot(dx, dy);
    bucketMeta[b].count++;
  }

  for (const m of bucketMeta) {
    if (m.count === 0) continue;
    m.cx /= m.count;
    m.cy /= m.count;
    m.r /= m.count;
  }

  const W: number[][] = Array.from({ length: bucketCount }, () => Array<number>(bucketCount).fill(0));
  for (let i = 0; i < bucketCount; i++) {
    for (let j = i + 1; j < bucketCount; j++) {
      if (bucketMeta[i].count === 0 || bucketMeta[j].count === 0) continue;
      const di = bucketMeta[i];
      const dj = bucketMeta[j];
      const dc = Math.hypot(di.cx - dj.cx, di.cy - dj.cy);
      const dr = Math.abs(di.r - dj.r);
      const angleGap = Math.min(Math.abs(i - j), bucketCount - Math.abs(i - j));
      // Higher means tighter coupling and likely cross-boundary interference.
      const interaction =
        1 / (1 + 0.12 * dc) +
        1 / (1 + 0.15 * dr) +
        1 / (1 + angleGap);
      W[i][j] = interaction;
      W[j][i] = interaction;
    }
  }

  const bucketSizes = buckets.map(b => b.length);
  const total = others.length;
  let bestCut = -1;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let cut = 1; cut < bucketCount; cut++) {
    const leftCount = bucketSizes.slice(0, cut).reduce((s, c) => s + c, 0);
    const rightCount = total - leftCount;
    if (leftCount === 0 || rightCount === 0) continue;

    let cross = 0;
    for (let i = 0; i < cut; i++) {
      for (let j = cut; j < bucketCount; j++) {
        cross += W[i][j];
      }
    }
    const balancePenalty = Math.abs(leftCount - rightCount) / Math.max(1, total);
    const score = cross + 4.0 * balancePenalty;
    if (score < bestScore) {
      bestScore = score;
      bestCut = cut;
    }
  }

  if (bestCut < 0) {
    const sorted = [...nodes].sort((a, b) =>
      getEdgeCost(depot, a, ctx).composite - getEdgeCost(depot, b, ctx).composite
    );
    const mid = Math.ceil(sorted.length / 2);
    return { left: sorted.slice(0, mid), right: sorted.slice(mid) };
  }

  const left = [depot, ...buckets.slice(0, bestCut).flat()];
  const right = buckets.slice(bestCut).flat();
  if (right.length === 0) {
    const sorted = [...nodes].sort((a, b) =>
      getEdgeCost(depot, a, ctx).composite - getEdgeCost(depot, b, ctx).composite
    );
    const mid = Math.ceil(sorted.length / 2);
    return { left: sorted.slice(0, mid), right: sorted.slice(mid) };
  }
  return { left, right };
}

function pathCompositeCost(
  path: string[],
  nodeMap: Map<string, Node>,
  ctx: TrafficContext
): number {
  if (path.length <= 1) return 0;
  let total = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const a = nodeMap.get(path[i]);
    const b = nodeMap.get(path[i + 1]);
    if (!a || !b) continue;
    total += getEdgeCost(a, b, ctx).composite;
  }
  return total;
}

function stitchOpenPaths(
  leftPath: string[],
  rightPath: string[],
  nodeMap: Map<string, Node>,
  ctx: TrafficContext
): string[] {
  if (leftPath.length === 0) return [...rightPath];
  if (rightPath.length === 0) return [...leftPath];
  const direct = [...leftPath, ...rightPath];
  const reversed = [...leftPath, ...[...rightPath].reverse()];
  const cDirect = pathCompositeCost(direct, nodeMap, ctx);
  const cReversed = pathCompositeCost(reversed, nodeMap, ctx);
  return cReversed + 1e-9 < cDirect ? reversed : direct;
}

function optimizePartitionFromTour(
  nodes: Node[],
  depotId: string,
  ctx: TrafficContext,
  seedOpenPath: string[]
): { left: Node[]; right: Node[] } {
  const depot = nodes.find(n => n.id === depotId) ?? nodes[0];
  const ids = seedOpenPath.filter(id => id !== depot.id);
  if (ids.length < 12) return spectralPartition(nodes, depotId, ctx);

  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const ordered = ids.filter(id => nodeMap.has(id));
  const n = ordered.length;
  if (n < 12) return spectralPartition(nodes, depotId, ctx);

  const avgEdge = pathCompositeCost([depot.id, ...ordered, depot.id], nodeMap, ctx) / Math.max(1, n + 1);
  const minCut = Math.max(3, Math.floor(n * 0.30));
  const maxCut = Math.min(n - 3, Math.ceil(n * 0.70));
  let bestCut = -1;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let k = minCut; k <= maxCut; k++) {
    const a = nodeMap.get(ordered[k - 1]);
    const b = nodeMap.get(ordered[k]);
    if (!a || !b) continue;
    const cross = getEdgeCost(a, b, ctx).composite;
    const balancePenalty = Math.abs((k) - (n - k)) / Math.max(1, n);
    const score = cross + 1.8 * avgEdge * balancePenalty;
    if (score < bestScore) {
      bestScore = score;
      bestCut = k;
    }
  }

  if (bestCut < 0) return spectralPartition(nodes, depotId, ctx);

  const leftIds = new Set<string>(ordered.slice(0, bestCut));
  const rightIds = new Set<string>(ordered.slice(bestCut));
  const left: Node[] = [depot];
  const right: Node[] = [];
  for (const nNode of nodes) {
    if (nNode.id === depot.id) continue;
    if (leftIds.has(nNode.id)) left.push(nNode);
    else if (rightIds.has(nNode.id)) right.push(nNode);
  }
  if (right.length === 0 || left.length <= 1) return spectralPartition(nodes, depotId, ctx);
  return { left, right };
}

/** Strip the closing node from a closed tour so we have an open path.
 *  [A, B, C, A] → [A, B, C]   (safe if already open) */
function toOpen(path: string[]): string[] {
  if (path.length >= 2 && path[0] === path[path.length - 1]) {
    return path.slice(0, -1);
  }
  return path;
}

function buildSweepClosedTour(
  nodes: Node[],
  depotId: string,
  theta: number,
  reverse: boolean
): string[] {
  const depot = nodes.find(n => n.id === depotId) ?? nodes[0];
  const others = nodes.filter(n => n.id !== depot.id);
  const ordered = others
    .map(n => {
      const a = Math.atan2(n.y - depot.y, n.x - depot.x);
      const rotated = ((a - theta) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
      const r2 = (n.x - depot.x) * (n.x - depot.x) + (n.y - depot.y) * (n.y - depot.y);
      return { id: n.id, rotated, r2 };
    })
    .sort((u, v) => (u.rotated - v.rotated) || (u.r2 - v.r2))
    .map(x => x.id);
  if (reverse) ordered.reverse();
  return [depot.id, ...ordered, depot.id];
}

function sanitizeClosedTour(path: string[], nodes: Node[], depotId: string): string[] {
  const nodeIds = new Set(nodes.map(n => n.id));
  const out: string[] = [depotId];
  const seen = new Set<string>([depotId]);
  for (let i = 1; i < path.length; i++) {
    const id = path[i];
    if (!nodeIds.has(id) || id === depotId || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  for (const n of nodes) {
    if (n.id === depotId) continue;
    if (!seen.has(n.id)) out.push(n.id);
  }
  out.push(depotId);
  return out;
}

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function tourEdges(path: string[]): string[] {
  const edges: string[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    edges.push(`${a}->${b}`);
  }
  return edges;
}

function gnoptCompressCandidateTours(
  candidates: string[][],
  nodeMap: Map<string, Node>,
  ctx: TrafficContext,
  maxKeep: number,
  logs: string[]
): string[][] {
  if (candidates.length <= maxKeep) return candidates;
  const edgeFreq = new Map<string, number>();
  for (const t of candidates) {
    for (const e of tourEdges(t)) edgeFreq.set(e, (edgeFreq.get(e) ?? 0) + 1);
  }
  const coreThreshold = Math.max(2, Math.ceil(candidates.length * 0.55));
  const core = new Set<string>([...edgeFreq.entries()].filter(([, f]) => f >= coreThreshold).map(([e]) => e));

  const incidence = new Map<string, number>();
  for (const e of core) {
    const [a] = e.split("->");
    incidence.set(a, (incidence.get(a) ?? 0) + 1);
  }
  const hubCount = [...incidence.values()].filter(v => v >= 3).length;

  const ranked = candidates
    .map(t => {
      const edges = tourEdges(t);
      let coreHits = 0;
      for (const e of edges) if (core.has(e)) coreHits++;
      const metrics = evaluatePath(t, nodeMap, ctx);
      return { t, edges: new Set(edges), coreHits, score: metrics.composite };
    })
    .sort((a, b) => a.score - b.score);

  const selected: typeof ranked = [];
  const seenCore = new Set<string>();
  for (const cand of ranked) {
    if (selected.length >= maxKeep) break;
    let novelty = 0;
    for (const e of cand.edges) if (!seenCore.has(e)) novelty++;
    const accept = selected.length === 0 || novelty >= 2 || cand.coreHits >= Math.max(1, Math.floor(core.size * 0.15));
    if (!accept) continue;
    selected.push(cand);
    for (const e of cand.edges) seenCore.add(e);
  }
  if (selected.length < Math.min(maxKeep, ranked.length)) {
    for (const cand of ranked) {
      if (selected.length >= Math.min(maxKeep, ranked.length)) break;
      if (!selected.includes(cand)) selected.push(cand);
    }
  }
  logs.push(
    `[Stage 2.5] GNOPT route-candidate compression: ${candidates.length} -> ${selected.length} ` +
    `(coreEdges=${core.size}, hubs=${hubCount}).`
  );
  return selected.map(x => x.t);
}

function separatorBoundaryRefineTour(
  tour: string[],
  nodes: Node[],
  depotId: string,
  nodeMap: Map<string, Node>,
  ctx: TrafficContext,
  rng: () => number
): string[] {
  const depot = nodeMap.get(depotId);
  if (!depot) return tour;
  const ids = tour.filter(id => id !== depotId);
  if (ids.length < 10) return twoOpt(tour, nodeMap, ctx);
  const basePos = new Map<string, number>();
  ids.forEach((id, i) => basePos.set(id, i));
  const angles = [rng() * Math.PI * 2, rng() * Math.PI * 2];
  const variants: string[][] = [];

  for (const angle of angles) {
    const nx = Math.cos(angle);
    const ny = Math.sin(angle);
    const projected = ids
      .map(id => {
        const p = nodeMap.get(id)!;
        const proj = (p.x - depot.x) * nx + (p.y - depot.y) * ny;
        return { id, proj, pos: basePos.get(id) ?? 0 };
      })
      .sort((a, b) => a.proj - b.proj);
    const straight = projected.map(x => x.id);
    const mid = Math.floor(straight.length / 2);
    const band = Math.max(2, Math.floor(straight.length * 0.12));
    const left = straight.slice(0, Math.max(0, mid - band));
    const boundary = straight.slice(Math.max(0, mid - band), Math.min(straight.length, mid + band));
    const right = straight.slice(Math.min(straight.length, mid + band));

    variants.push([depotId, ...left, ...boundary, ...right, depotId]);
    variants.push([depotId, ...left, ...[...boundary].reverse(), ...right, depotId]);
    const blended = projected
      .map(x => ({ id: x.id, key: 0.70 * x.proj + 0.30 * x.pos }))
      .sort((u, v) => u.key - v.key)
      .map(x => x.id);
    variants.push([depotId, ...blended, depotId]);
  }

  let best = tour;
  let bestScore = evaluatePath(tour, nodeMap, ctx).composite;
  for (const v of variants) {
    const clean = sanitizeClosedTour(v, nodes, depotId);
    const opt = twoOpt(clean, nodeMap, ctx);
    const score = evaluatePath(opt, nodeMap, ctx).composite;
    if (score < bestScore) {
      bestScore = score;
      best = opt;
    }
  }
  return best;
}

type AlnsDestroyOperator = {
  name: string;
  level: "micro" | "macro";
  run: (order: string[], removeCount: number) => { kept: string[]; removed: string[] };
};

type AlnsRepairOperator = {
  name: string;
  run: (kept: string[], removed: string[]) => string[];
};

type AlnsOperatorState<T extends { name: string }> = {
  op: T;
  weight: number;
  reward: number;
  used: number;
};

function computeOrderCost(
  order: string[],
  depotId: string,
  nodeMap: Map<string, Node>,
  ctx: TrafficContext
): number {
  const depot = nodeMap.get(depotId);
  if (!depot) return Number.POSITIVE_INFINITY;
  let cost = 0;
  let prev = depot;
  for (const id of order) {
    const n = nodeMap.get(id);
    if (!n) continue;
    cost += getEdgeCost(prev, n, ctx).composite;
    prev = n;
  }
  cost += getEdgeCost(prev, depot, ctx).composite;
  return cost;
}

function insertionDeltaCost(
  order: string[],
  insertId: string,
  pos: number,
  depotId: string,
  nodeMap: Map<string, Node>,
  ctx: TrafficContext
): number {
  const depot = nodeMap.get(depotId);
  const ins = nodeMap.get(insertId);
  if (!depot || !ins) return Number.POSITIVE_INFINITY;
  const prevId = pos > 0 ? order[pos - 1] : depotId;
  const nextId = pos < order.length ? order[pos] : depotId;
  const prev = nodeMap.get(prevId);
  const next = nodeMap.get(nextId);
  if (!prev || !next) return Number.POSITIVE_INFINITY;
  const oldCost = getEdgeCost(prev, next, ctx).composite;
  const newCost = getEdgeCost(prev, ins, ctx).composite + getEdgeCost(ins, next, ctx).composite;
  return newCost - oldCost;
}

function bestInsertionPosition(
  order: string[],
  insertId: string,
  depotId: string,
  nodeMap: Map<string, Node>,
  ctx: TrafficContext
): { pos: number; delta: number } {
  let bestPos = 0;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (let pos = 0; pos <= order.length; pos++) {
    const delta = insertionDeltaCost(order, insertId, pos, depotId, nodeMap, ctx);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestPos = pos;
    }
  }
  return { pos: bestPos, delta: bestDelta };
}

function applyGreedyRepair(
  kept: string[],
  removed: string[],
  depotId: string,
  nodeMap: Map<string, Node>,
  ctx: TrafficContext
): string[] {
  const route = [...kept];
  for (const id of removed) {
    const { pos } = bestInsertionPosition(route, id, depotId, nodeMap, ctx);
    route.splice(pos, 0, id);
  }
  return route;
}

function applyRegretKRepair(
  kept: string[],
  removed: string[],
  depotId: string,
  nodeMap: Map<string, Node>,
  ctx: TrafficContext,
  regretK = 2
): string[] {
  const route = [...kept];
  const pending = [...removed];
  while (pending.length > 0) {
    let bestNodeIdx = 0;
    let bestPos = 0;
    let bestRegret = -1;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (let i = 0; i < pending.length; i++) {
      const id = pending[i];
      const choices: Array<{ pos: number; delta: number }> = [];
      for (let pos = 0; pos <= route.length; pos++) {
        choices.push({ pos, delta: insertionDeltaCost(route, id, pos, depotId, nodeMap, ctx) });
      }
      choices.sort((a, b) => a.delta - b.delta);
      const first = choices[0];
      const pivot = choices[Math.min(regretK - 1, choices.length - 1)];
      const regret = pivot.delta - first.delta;
      if (regret > bestRegret || (Math.abs(regret - bestRegret) < 1e-9 && first.delta < bestDelta)) {
        bestRegret = regret;
        bestDelta = first.delta;
        bestNodeIdx = i;
        bestPos = first.pos;
      }
    }
    const chosen = pending.splice(bestNodeIdx, 1)[0];
    route.splice(bestPos, 0, chosen);
  }
  return route;
}

function selectWeightedOperator<T extends { name: string }>(
  states: Array<AlnsOperatorState<T>>,
  rng: () => number
): AlnsOperatorState<T> {
  const total = states.reduce((s, x) => s + x.weight, 0);
  if (total <= 0) return states[Math.floor(rng() * states.length)];
  let pick = rng() * total;
  for (const st of states) {
    pick -= st.weight;
    if (pick <= 0) return st;
  }
  return states[states.length - 1];
}

function updateAlnsOperatorWeights<T extends { name: string }>(
  states: Array<AlnsOperatorState<T>>,
  reactionFactor: number
): void {
  for (const st of states) {
    if (st.used > 0) {
      const perf = st.reward / st.used;
      st.weight = Math.max(0.05, (1 - reactionFactor) * st.weight + reactionFactor * perf);
    }
    st.reward = 0;
    st.used = 0;
  }
}

function runAdaptiveAlnsTourRefinement(
  startTour: string[],
  nodes: Node[],
  depotId: string,
  nodeMap: Map<string, Node>,
  ctx: TrafficContext,
  rng: () => number,
  timeBudgetMs: number,
  maxIterations: number,
  opts?: AlnsOptions
): {
  tour: string[];
  cost: number;
  bestCost: number;
  iterations: number;
  accepted: number;
  improved: number;
  destroyUsage: string;
  repairUsage: string;
} {
  const customerIds = nodes.filter(n => n.id !== depotId).map(n => n.id);
  const customerSet = new Set(customerIds);
  const depotNode = nodeMap.get(depotId);
  if (!depotNode || customerIds.length < 8) {
    const clean = sanitizeClosedTour(startTour, nodes, depotId);
    const score = evaluatePath(clean, nodeMap, ctx).composite;
    return {
      tour: clean,
      cost: score,
      bestCost: score,
      iterations: 0,
      accepted: 0,
      improved: 0,
      destroyUsage: "n/a",
      repairUsage: "n/a",
    };
  }

  const canonicalOrder = (tour: string[]): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of tour) {
      if (id === depotId) continue;
      if (!customerSet.has(id) || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    for (const id of customerIds) {
      if (!seen.has(id)) out.push(id);
    }
    return out;
  };
  const orderToClosed = (order: string[]): string[] => [depotId, ...order, depotId];
  const pickIndices = (n: number, k: number): number[] => {
    const idx = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = idx[i];
      idx[i] = idx[j];
      idx[j] = t;
    }
    return idx.slice(0, Math.max(0, Math.min(k, n)));
  };
  const nodeById = (id: string): Node | undefined => nodeMap.get(id);

  const destroyOps: AlnsDestroyOperator[] = [
    {
      name: "random-node-removal",
      level: "micro",
      run: (order, removeCount) => {
        const picked = new Set(pickIndices(order.length, removeCount));
        const kept: string[] = [];
        const removed: string[] = [];
        for (let i = 0; i < order.length; i++) {
          if (picked.has(i)) removed.push(order[i]);
          else kept.push(order[i]);
        }
        return { kept, removed };
      },
    },
    {
      name: "cluster-removal",
      level: "macro",
      run: (order, removeCount) => {
        if (order.length === 0) return { kept: [], removed: [] };
        const center = order[Math.floor(rng() * order.length)];
        const cNode = nodeById(center);
        if (!cNode) return { kept: [...order], removed: [] };
        const ranked = order
          .map(id => {
            const n = nodeById(id);
            if (!n) return { id, d: Number.POSITIVE_INFINITY };
            const dx = n.x - cNode.x;
            const dy = n.y - cNode.y;
            return { id, d: dx * dx + dy * dy };
          })
          .sort((a, b) => a.d - b.d);
        const removeSet = new Set(ranked.slice(0, removeCount).map(x => x.id));
        const kept = order.filter(id => !removeSet.has(id));
        const removed = order.filter(id => removeSet.has(id));
        return { kept, removed };
      },
    },
    {
      name: "route-segment-removal",
      level: "macro",
      run: (order, removeCount) => {
        if (order.length === 0) return { kept: [], removed: [] };
        const count = Math.max(1, Math.min(removeCount, order.length));
        const start = Math.floor(rng() * order.length);
        const removeSet = new Set<string>();
        for (let i = 0; i < count; i++) {
          removeSet.add(order[(start + i) % order.length]);
        }
        const kept = order.filter(id => !removeSet.has(id));
        const removed = order.filter(id => removeSet.has(id));
        return { kept, removed };
      },
    },
    {
      name: "depot-split-removal",
      level: "macro",
      run: (order, removeCount) => {
        if (order.length === 0) return { kept: [], removed: [] };
        const angle0 = rng() * Math.PI * 2;
        const width = Math.PI * (0.18 + rng() * 0.12);
        const candidates = order
          .map(id => {
            const n = nodeById(id);
            if (!n) return { id, key: Number.POSITIVE_INFINITY, radial: Number.POSITIVE_INFINITY };
            const dx = n.x - depotNode.x;
            const dy = n.y - depotNode.y;
            const angle = Math.atan2(dy, dx);
            const wrapped = Math.abs((((angle - angle0) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI);
            const radial = Math.sqrt(dx * dx + dy * dy);
            return { id, key: wrapped, radial };
          })
          .sort((a, b) => (a.key - b.key) || (b.radial - a.radial));
        const removeSet = new Set(
          candidates
            .filter(x => Number.isFinite(x.key) && x.key <= width)
            .slice(0, Math.max(1, removeCount))
            .map(x => x.id)
        );
        if (removeSet.size === 0) {
          for (const x of candidates.slice(0, Math.max(1, removeCount))) removeSet.add(x.id);
        }
        const kept = order.filter(id => !removeSet.has(id));
        const removed = order.filter(id => removeSet.has(id));
        return { kept, removed };
      },
    },
    {
      name: "high-cost-edge-removal",
      level: "micro",
      run: (order, removeCount) => {
        if (order.length <= 2) return { kept: [...order], removed: [] };
        const closed = [depotId, ...order, depotId];
        const scored: Array<{ id: string; score: number }> = [];
        for (let i = 1; i < closed.length - 1; i++) {
          const prev = nodeById(closed[i - 1]);
          const cur = nodeById(closed[i]);
          const next = nodeById(closed[i + 1]);
          if (!prev || !cur || !next) continue;
          const score =
            getEdgeCost(prev, cur, ctx).composite +
            getEdgeCost(cur, next, ctx).composite -
            getEdgeCost(prev, next, ctx).composite;
          scored.push({ id: closed[i], score });
        }
        scored.sort((a, b) => b.score - a.score);
        const removeSet = new Set(scored.slice(0, removeCount).map(x => x.id));
        const kept = order.filter(id => !removeSet.has(id));
        const removed = order.filter(id => removeSet.has(id));
        return { kept, removed };
      },
    },
  ];

  const repairOps: AlnsRepairOperator[] = [
    {
      name: "greedy-insert",
      run: (kept, removed) => applyGreedyRepair(kept, removed, depotId, nodeMap, ctx),
    },
    {
      name: "regret2-insert",
      run: (kept, removed) => applyRegretKRepair(kept, removed, depotId, nodeMap, ctx, 2),
    },
    {
      name: "cluster-aware-insert",
      run: (kept, removed) => {
        const sorted = [...removed].sort((a, b) => {
          const na = nodeById(a);
          const nb = nodeById(b);
          if (!na || !nb) return 0;
          const aa = Math.atan2(na.y - depotNode.y, na.x - depotNode.x);
          const ab = Math.atan2(nb.y - depotNode.y, nb.x - depotNode.x);
          return aa - ab;
        });
        return applyGreedyRepair(kept, sorted, depotId, nodeMap, ctx);
      },
    },
  ];

  const dStates: Array<AlnsOperatorState<AlnsDestroyOperator>> = destroyOps.map(op => ({
    op,
    weight: 1,
    reward: 0,
    used: 0,
  }));
  const rStates: Array<AlnsOperatorState<AlnsRepairOperator>> = repairOps.map(op => ({
    op,
    weight: 1,
    reward: 0,
    used: 0,
  }));

  let currentOrder = canonicalOrder(startTour);
  let currentCost = computeOrderCost(currentOrder, depotId, nodeMap, ctx);
  let bestOrder = [...currentOrder];
  let bestCost = currentCost;
  let accepted = 0;
  let improved = 0;
  let iterations = 0;

  const startTemp = Math.max(1, opts?.temperatureStart ?? currentCost * 0.030);
  const endTemp = Math.max(0.001, opts?.temperatureEnd ?? startTemp * 0.22);
  const reaction = Math.max(0.02, Math.min(0.5, opts?.reactionFactor ?? 0.14));
  const updateWindow = 25;
  const removeMinFrac = Math.max(0.02, Math.min(0.40, opts?.removeMinFrac ?? 0.07));
  const removeMaxFrac = Math.max(removeMinFrac + 0.01, Math.min(0.60, opts?.removeMaxFrac ?? 0.35));
  const minRemove = Math.max(2, Math.floor(customerIds.length * removeMinFrac));
  const maxRemove = Math.max(minRemove + 1, Math.floor(customerIds.length * removeMaxFrac));
  const t0 = Date.now();
  const macroEvery = Math.max(4, Math.floor(customerIds.length / 180));

  while (iterations < maxIterations && Date.now() - t0 < timeBudgetMs) {
    iterations++;
    const progress = iterations / Math.max(1, maxIterations);
    // Linear cooling instead of geometric â€” avoids an early temperature cliff
    // and hits the target endTemp steadily each phase.
    const temp = Math.max(
      endTemp,
      startTemp - (startTemp - endTemp) * progress
    );
    const removeCount =
      minRemove + Math.floor(rng() * (Math.max(1, maxRemove - minRemove + 1)));

    let d: AlnsOperatorState<AlnsDestroyOperator>;
    if (iterations % macroEvery === 0) {
      const macroStates = dStates.filter(s => s.op.level === "macro");
      d = macroStates.length > 0 ? selectWeightedOperator(macroStates, rng) : selectWeightedOperator(dStates, rng);
    } else {
      const microStates = dStates.filter(s => s.op.level === "micro");
      d = microStates.length > 0 ? selectWeightedOperator(microStates, rng) : selectWeightedOperator(dStates, rng);
    }
    const r = selectWeightedOperator(rStates, rng);
    d.used++;
    r.used++;

    const partial = d.op.run(currentOrder, removeCount);
    if (partial.removed.length === 0) continue;
    let candidateOrder = r.op.run(partial.kept, partial.removed);
    candidateOrder = canonicalOrder(candidateOrder);

    const candidateTour = twoOpt(orderToClosed(candidateOrder), nodeMap, ctx);
    candidateOrder = canonicalOrder(candidateTour);
    const candidateCost = computeOrderCost(candidateOrder, depotId, nodeMap, ctx);
    const delta = candidateCost - currentCost;
    const acceptProb = delta <= 0 ? 1 : Math.exp(-delta / Math.max(1e-6, temp));
    const acceptedMove = delta <= 0 || rng() < acceptProb;

    if (acceptedMove) {
      accepted++;
      currentOrder = candidateOrder;
      currentCost = candidateCost;
      if (candidateCost + 1e-9 < bestCost) {
        bestCost = candidateCost;
        bestOrder = [...candidateOrder];
        improved++;
        d.reward += 6;
        r.reward += 6;
      } else if (delta <= 0) {
        d.reward += 3;
        r.reward += 3;
      } else {
        d.reward += 1;
        r.reward += 1;
      }
    } else {
      d.reward += 0.15;
      r.reward += 0.15;
    }

    if (iterations % updateWindow === 0) {
      updateAlnsOperatorWeights(dStates, reaction);
      updateAlnsOperatorWeights(rStates, reaction);
    }
  }

  updateAlnsOperatorWeights(dStates, reaction);
  updateAlnsOperatorWeights(rStates, reaction);

  const usage = <T extends { name: string }>(states: Array<AlnsOperatorState<T>>): string =>
    states.map(s => `${s.op.name}:${s.weight.toFixed(2)}`).join(", ");

  const bestTour = sanitizeClosedTour(orderToClosed(bestOrder), nodes, depotId);
  const bestTourCost = evaluatePath(bestTour, nodeMap, ctx).composite;
  return {
    tour: bestTour,
    cost: currentCost,
    bestCost: Math.min(bestCost, bestTourCost),
    iterations,
    accepted,
    improved,
    destroyUsage: usage(dStates),
    repairUsage: usage(rStates),
  };
}

function improveClosedTourEnsemble(
  nodes: Node[],
  depotId: string,
  ctx: TrafficContext,
  nodeMap: Map<string, Node>,
  seedTour: string[],
  baselineTour: string[],
  logs: string[],
  mode: "fast" | "quality",
  seed: number,
  timeBudgetMs: number,
  alnsOptions?: AlnsOptions
): string[] {
  const rng = makeRng(seed);
  const t0 = Date.now();
  const candidates: string[][] = [];
  const add = (tour: string[]): void => {
    const clean = sanitizeClosedTour(tour, nodes, depotId);
    const key = clean.join("->");
    if (!candidates.some(c => c.join("->") === key)) candidates.push(clean);
  };

  add(seedTour);
  add(baselineTour);
  add(buildSweepClosedTour(nodes, depotId, 0, false));
  add(buildSweepClosedTour(nodes, depotId, Math.PI / 2, false));
  add(buildSweepClosedTour(nodes, depotId, 0, true));
  add(buildSweepClosedTour(nodes, depotId, Math.PI / 2, true));
  if (mode === "quality") {
    add(buildSweepClosedTour(nodes, depotId, Math.PI / 4, false));
    add(buildSweepClosedTour(nodes, depotId, 3 * Math.PI / 4, false));
    add(buildSweepClosedTour(nodes, depotId, Math.PI / 4, true));
    add(buildSweepClosedTour(nodes, depotId, 3 * Math.PI / 4, true));
    for (let i = 0; i < 4; i++) {
      const theta = rng() * Math.PI * 2;
      add(buildSweepClosedTour(nodes, depotId, theta, rng() < 0.5));
    }
  }

  const ranked = candidates
    .map(t => ({ t, score: evaluatePath(t, nodeMap, ctx).composite }))
    .sort((a, b) => a.score - b.score);

  const localRefined: string[][] = [];
  for (let i = 0; i < Math.min(2, ranked.length); i++) {
    localRefined.push(twoOpt(ranked[i].t, nodeMap, ctx));
  }
  add(twoOpt(seedTour, nodeMap, ctx));
  for (const t of localRefined) add(t);

  let working = mode === "quality"
    ? gnoptCompressCandidateTours(candidates, nodeMap, ctx, Math.min(10, Math.max(6, Math.floor(candidates.length * 0.6))), logs)
    : candidates;

  if (mode === "quality") {
    const base = [...working]
      .map(t => ({ t, score: evaluatePath(t, nodeMap, ctx).composite }))
      .sort((a, b) => a.score - b.score)
      .slice(0, 3)
      .map(x => x.t);
    for (const t of base) {
      if ((Date.now() - t0) > timeBudgetMs) break;
      const refined = separatorBoundaryRefineTour(t, nodes, depotId, nodeMap, ctx, rng);
      add(refined);
      working = gnoptCompressCandidateTours(candidates, nodeMap, ctx, Math.min(12, candidates.length), logs);
    }
  }

  const alnsEnabled = alnsOptions?.enabled ?? true;
  if (alnsEnabled && candidates.length > 0 && nodes.length >= 24) {
    const sortedForAlns = [...working]
      .map(t => ({ t, score: evaluatePath(t, nodeMap, ctx).composite }))
      .sort((a, b) => a.score - b.score);
    const lanes = Math.max(1, Math.min(4, alnsOptions?.lanes ?? (mode === "quality" ? 3 : 2)));
    const laneCount = Math.min(lanes, sortedForAlns.length);
    const alnsBudgetMs = Math.max(
      20,
      Math.min(
        Math.max(20, timeBudgetMs),
        alnsOptions?.timeBudgetMs ??
          Math.max(30, Math.floor(timeBudgetMs * (mode === "quality" ? 0.72 : 0.55)))
      )
    );
    const maxIterations = Math.max(
      120,
      Math.min(
        15000,
        alnsOptions?.maxIterations ?? (mode === "quality" ? 12000 : 5000)
      )
    );
    const laneBudget = Math.max(15, Math.floor(alnsBudgetMs / laneCount));
    logs.push(
      `[Stage 3] ALNS enabled lanes=${laneCount} iterCap=${maxIterations} budget=${alnsBudgetMs}ms.`
    );
    let bestKnown = sortedForAlns[0].score;
    let bestKnownTour = sortedForAlns[0].t;
    for (let lane = 0; lane < laneCount; lane++) {
      if ((Date.now() - t0) > timeBudgetMs) break;
      const laneSeed = seed + 1009 * (lane + 1);
      const laneRng = makeRng(laneSeed);
      const startTour = lane === 0 ? bestKnownTour : sortedForAlns[lane].t;
      const refined = runAdaptiveAlnsTourRefinement(
        startTour,
        nodes,
        depotId,
        nodeMap,
        ctx,
        laneRng,
        laneBudget,
        maxIterations,
        alnsOptions
      );
      add(refined.tour);
      if (refined.bestCost + 1e-9 < bestKnown) {
        bestKnown = refined.bestCost;
        bestKnownTour = refined.tour;
      }
      logs.push(
        `[Stage 3][ALNS lane ${lane + 1}] iters=${refined.iterations} accepted=${refined.accepted} ` +
          `improved=${refined.improved} best=${refined.bestCost.toFixed(2)}`
      );
      logs.push(`[Stage 3][ALNS lane ${lane + 1}] destroy=${refined.destroyUsage}`);
      logs.push(`[Stage 3][ALNS lane ${lane + 1}] repair=${refined.repairUsage}`);
    }
    add(bestKnownTour);
    working = mode === "quality"
      ? gnoptCompressCandidateTours(
          candidates,
          nodeMap,
          ctx,
          Math.min(14, Math.max(8, Math.floor(candidates.length * 0.7))),
          logs
        )
      : candidates;
  }

  const finalRanked = working
    .map(t => ({ t, metrics: evaluatePath(t, nodeMap, ctx) }))
    .sort((a, b) => a.metrics.composite - b.metrics.composite);
  const winner = finalRanked[0];
  const baseMetrics = evaluatePath(sanitizeClosedTour(baselineTour, nodes, depotId), nodeMap, ctx);
  if (winner.metrics.composite > baseMetrics.composite * 1.02) {
    logs.push("[Stage 3] Ensemble guardrail activated; using baseline-equivalent tour.");
    return sanitizeClosedTour(baselineTour, nodes, depotId);
  }
  logs.push(
    `[Stage 3] Ensemble refinement picked score ${winner.metrics.composite.toFixed(2)} ` +
    `from ${working.length} compressed candidate tour(s).`
  );
  return winner.t;
}

function recursiveSolve(
  graph: InteractionGraph,
  depotId: string,
  ctx: TrafficContext,
  depth: number,
  maxDepth: number,
  repartitionBudget = 1
): string[] {
  const { nodes } = graph;
  if (nodes.length === 0) return [];

  if (nodes.length <= 8 || depth >= maxDepth) {
    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    const startId = nodes.some(n => n.id === depotId) ? depotId : nodes[0].id;
    // nearestNeighbor returns a closed tour — strip the closing node
    const greedy = toOpen(nearestNeighbor(nodes, startId, ctx));
    return toOpen(twoOpt([...greedy, greedy[0]], nodeMap, ctx)); // twoOpt needs closed input, strip after
  }

  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const seedClosed = nearestNeighbor(nodes, depotId, ctx);
  const seedOpen = toOpen(twoOpt(seedClosed, nodeMap, ctx));

  const { left, right } = optimizePartitionFromTour(nodes, depotId, ctx, seedOpen);
  if (right.length === 0) {
    const greedy  = toOpen(nearestNeighbor(nodes, depotId, ctx));
    return toOpen(twoOpt([...greedy, greedy[0]], nodeMap, ctx));
  }

  const leftDepot = left.some(n => n.id === depotId) ? depotId : left[0].id;
  const rightDepot = right[0].id;

  const leftPath  = recursiveSolve({ nodes: left,  constraints: graph.constraints }, leftDepot,  ctx, depth + 1, maxDepth, repartitionBudget);
  const rightPath = recursiveSolve({ nodes: right, constraints: graph.constraints }, rightDepot, ctx, depth + 1, maxDepth, repartitionBudget);
  let best = stitchOpenPaths(leftPath, rightPath, nodeMap, ctx);

  // Gated dynamic repartition: if seam is expensive, recompute a tour-cost cut once.
  if (repartitionBudget > 0 && best.length >= 16) {
    const leftEnd = leftPath[leftPath.length - 1];
    const rightStart = rightPath[0];
    const seamCost = leftEnd && rightStart && nodeMap.get(leftEnd) && nodeMap.get(rightStart)
      ? getEdgeCost(nodeMap.get(leftEnd)!, nodeMap.get(rightStart)!, ctx).composite
      : 0;
    const avgEdge = pathCompositeCost(best, nodeMap, ctx) / Math.max(1, best.length - 1);
    const seamRatio = avgEdge > 0 ? seamCost / avgEdge : 0;

    if (seamRatio > 1.35) {
      const altSplit = optimizePartitionFromTour(nodes, depotId, ctx, best);
      if (altSplit.right.length > 0 && altSplit.left.length > 1) {
        const altLeftDepot = altSplit.left.some(n => n.id === depotId) ? depotId : altSplit.left[0].id;
        const altRightDepot = altSplit.right[0].id;
        const altLeft = recursiveSolve(
          { nodes: altSplit.left, constraints: graph.constraints },
          altLeftDepot,
          ctx,
          depth + 1,
          maxDepth,
          repartitionBudget - 1
        );
        const altRight = recursiveSolve(
          { nodes: altSplit.right, constraints: graph.constraints },
          altRightDepot,
          ctx,
          depth + 1,
          maxDepth,
          repartitionBudget - 1
        );
        const alt = stitchOpenPaths(altLeft, altRight, nodeMap, ctx);
        const bestCost = pathCompositeCost(best, nodeMap, ctx);
        const altCost = pathCompositeCost(alt, nodeMap, ctx);
        if (altCost + 1e-9 < bestCost) best = alt;
      }
    }
  }

  return best;
}

// ─────────────────────────────────────────────────────────
// Gadget expansion (unchanged logic, unchanged interface)
// ─────────────────────────────────────────────────────────

function expandGadgets(
  macroPath: string[],
  gadgets: Gadget[],
  allOriginalNodes: Node[],
  ctx: TrafficContext
): string[] {
  const result: string[] = [];

  for (const id of macroPath) {
    const gadget = gadgets.find(g => g.macroNode.id === id);
    if (!gadget) {
      result.push(id);
      continue;
    }
    const members = allOriginalNodes.filter(n => gadget.replacedNodeIds.includes(n.id));
    if (members.length === 0) continue;
    if (members.length === 1) { result.push(members[0].id); continue; }

    const nodeMap  = new Map(members.map(n => [n.id, n]));
    const local    = nearestNeighbor(members, members[0].id, ctx);     // closed
    const optimized = twoOpt(local, nodeMap, ctx);                      // closed
    // Drop the closing node — path is stitched into the outer tour
    result.push(...toOpen(optimized));
  }

  return result;
}

// ─────────────────────────────────────────────────────────
// Main Engine Entry Point
// ─────────────────────────────────────────────────────────

type BenchmarkSplit = {
  routes: string[][];
  totalCost: number;
};

function benchmarkEdgeCost(a: Node, b: Node): number {
  return Math.round(euclidean(a, b));
}

function benchmarkRouteCost(route: string[], nodeMap: Map<string, Node>): number {
  let cost = 0;
  for (let i = 0; i < route.length - 1; i++) {
    const a = nodeMap.get(route[i]);
    const b = nodeMap.get(route[i + 1]);
    if (!a || !b) return Number.POSITIVE_INFINITY;
    cost += benchmarkEdgeCost(a, b);
  }
  return cost;
}

function benchmarkTwoOpt(route: string[], nodeMap: Map<string, Node>): string[] {
  if (route.length <= 4) return route;
  const cur = [...route];
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 1; i < cur.length - 2; i++) {
      for (let k = i + 1; k < cur.length - 1; k++) {
        const a = nodeMap.get(cur[i - 1]);
        const b = nodeMap.get(cur[i]);
        const c = nodeMap.get(cur[k]);
        const d = nodeMap.get(cur[k + 1]);
        if (!a || !b || !c || !d) continue;
        const oldCost = benchmarkEdgeCost(a, b) + benchmarkEdgeCost(c, d);
        const newCost = benchmarkEdgeCost(a, c) + benchmarkEdgeCost(b, d);
        if (newCost + 1e-9 < oldCost) {
          const rev = cur.slice(i, k + 1).reverse();
          cur.splice(i, k - i + 1, ...rev);
          improved = true;
        }
      }
    }
  }
  return cur;
}

function routeLoad(route: string[], demands: Map<string, number>, depotId: string): number {
  let load = 0;
  for (const id of route) {
    if (id === depotId) continue;
    load += demands.get(id) ?? 0;
  }
  return load;
}

function totalBenchmarkCost(routes: string[][], nodeMap: Map<string, Node>): number {
  return routes.reduce((s, r) => s + benchmarkRouteCost(r, nodeMap), 0);
}

function isFeasibleBenchmarkRoutes(
  routes: string[][],
  allCustomers: string[],
  depotId: string,
  vehicleCount: number,
  vehicleCapacity: number,
  demands: Map<string, number>
): boolean {
  if (routes.length !== vehicleCount) return false;
  const seen = new Set<string>();
  for (const route of routes) {
    if (route.length < 2) return false;
    if (route[0] !== depotId || route[route.length - 1] !== depotId) return false;
    let load = 0;
    for (const id of route) {
      if (id === depotId) continue;
      if (seen.has(id)) return false;
      seen.add(id);
      load += demands.get(id) ?? 0;
    }
    if (load > vehicleCapacity + 1e-9) return false;
  }
  if (seen.size !== allCustomers.length) return false;
  for (const id of allCustomers) {
    if (!seen.has(id)) return false;
  }
  return true;
}

function nearestOrderFromSeed(
  members: string[],
  depotId: string,
  nodeMap: Map<string, Node>
): string[] {
  if (members.length === 0) return [depotId, depotId];
  const unvisited = new Set(members);
  const depot = nodeMap.get(depotId);
  if (!depot) return [depotId, ...members, depotId];

  let start = members[0];
  let startDist = Number.POSITIVE_INFINITY;
  for (const id of members) {
    const n = nodeMap.get(id);
    if (!n) continue;
    const d = benchmarkEdgeCost(depot, n);
    if (d < startDist) {
      startDist = d;
      start = id;
    }
  }

  const order: string[] = [];
  let cur = start;
  unvisited.delete(cur);
  order.push(cur);
  while (unvisited.size > 0) {
    let best = "";
    let bestCost = Number.POSITIVE_INFINITY;
    const cNode = nodeMap.get(cur);
    if (!cNode) break;
    for (const cand of unvisited) {
      const n = nodeMap.get(cand);
      if (!n) continue;
      const c = benchmarkEdgeCost(cNode, n);
      if (c < bestCost) {
        best = cand;
        bestCost = c;
      }
    }
    if (!best) break;
    cur = best;
    unvisited.delete(cur);
    order.push(cur);
  }
  return [depotId, ...order, depotId];
}

function improveInterRouteMoves(
  routes: string[][],
  depotId: string,
  demands: Map<string, number>,
  vehicleCapacity: number,
  nodeMap: Map<string, Node>
): string[][] {
  const out = routes.map(r => [...r]);
  const loads = out.map(r => routeLoad(r, demands, depotId));
  for (let pass = 0; pass < 2; pass++) {
    let improved = false;
    for (let i = 0; i < out.length; i++) {
      for (let j = 0; j < out.length; j++) {
        if (i === j) continue;
        const ri = out[i];
        const rj = out[j];
        for (let pi = 1; pi < ri.length - 1; pi++) {
          const id = ri[pi];
          const d = demands.get(id) ?? 0;
          if (loads[j] + d > vehicleCapacity) continue;
          const baseCost = benchmarkRouteCost(ri, nodeMap) + benchmarkRouteCost(rj, nodeMap);
          const removeRoute = [...ri.slice(0, pi), ...ri.slice(pi + 1)];
          let bestPos = -1;
          let bestDelta = 0;
          for (let pj = 1; pj < rj.length; pj++) {
            const nextJ = [...rj.slice(0, pj), id, ...rj.slice(pj)];
            const nextCost = benchmarkRouteCost(removeRoute, nodeMap) + benchmarkRouteCost(nextJ, nodeMap);
            const delta = baseCost - nextCost;
            if (delta > bestDelta + 1e-9) {
              bestDelta = delta;
              bestPos = pj;
            }
          }
          if (bestPos >= 1) {
            out[i] = removeRoute;
            out[j] = [...rj.slice(0, bestPos), id, ...rj.slice(bestPos)];
            loads[i] -= d;
            loads[j] += d;
            improved = true;
            break;
          }
        }
        if (improved) break;
      }
      if (improved) break;
    }
    if (!improved) break;
  }
  return out;
}

function buildBenchmarkConstrainedRoutes(
  finalPath: string[],
  allNodes: Node[],
  depotId: string,
  benchmark: NonNullable<EngineInput["benchmark"]>,
  logs: string[]
): BenchmarkSplit | undefined {
  if (benchmark.metric !== "cvrplib_euc2d") return undefined;
  const nodeMap = new Map(allNodes.map(n => [n.id, n]));
  if (!nodeMap.has(depotId)) return undefined;

  const demands = new Map<string, number>();
  for (const [id, d] of Object.entries(benchmark.demands)) {
    demands.set(id, Math.max(0, d));
  }
  const allCustomers = allNodes
    .map(n => n.id)
    .filter(id => id !== depotId && (demands.get(id) ?? 0) > 0);

  if (allCustomers.length === 0) {
    return {
      routes: Array.from({ length: benchmark.vehicleCount }, () => [depotId, depotId]),
      totalCost: 0,
    };
  }

  for (const id of allCustomers) {
    if ((demands.get(id) ?? 0) > benchmark.vehicleCapacity) {
      logs.push(`[Benchmark] Node ${id} demand exceeds vehicle capacity.`);
      return undefined;
    }
  }
  const totalDemand = allCustomers.reduce((s, id) => s + (demands.get(id) ?? 0), 0);
  if (totalDemand > benchmark.vehicleCount * benchmark.vehicleCapacity) {
    logs.push("[Benchmark] Infeasible demand/capacity for requested vehicle count.");
    return undefined;
  }

  const seed = finalPath.filter(id => id !== depotId && allCustomers.includes(id));
  const seenSeed = new Set(seed);
  const order = [...seed, ...allCustomers.filter(id => !seenSeed.has(id))];
  const bins: string[][] = Array.from({ length: benchmark.vehicleCount }, () => []);
  const loads = Array<number>(benchmark.vehicleCount).fill(0);

  for (const id of order) {
    const d = demands.get(id) ?? 0;
    let best = -1;
    let bestSlack = Number.POSITIVE_INFINITY;
    for (let k = 0; k < bins.length; k++) {
      if (loads[k] + d > benchmark.vehicleCapacity) continue;
      const slack = benchmark.vehicleCapacity - (loads[k] + d);
      if (slack < bestSlack) {
        best = k;
        bestSlack = slack;
      }
    }
    if (best < 0) {
      logs.push(`[Benchmark] Packing failed for ${id}.`);
      return undefined;
    }
    bins[best].push(id);
    loads[best] += d;
  }

  let routes = bins.map(members => nearestOrderFromSeed(members, depotId, nodeMap));
  routes = routes.map(r => benchmarkTwoOpt(r, nodeMap));
  routes = improveInterRouteMoves(routes, depotId, demands, benchmark.vehicleCapacity, nodeMap);
  routes = routes.map(r => benchmarkTwoOpt(r, nodeMap));

  if (!isFeasibleBenchmarkRoutes(
    routes,
    allCustomers,
    depotId,
    benchmark.vehicleCount,
    benchmark.vehicleCapacity,
    demands
  )) {
    logs.push("[Benchmark] Generated routes failed feasibility checks.");
    return undefined;
  }

  return { routes, totalCost: totalBenchmarkCost(routes, nodeMap) };
}

export function runReasonRouteEngine(input: EngineInput): EngineResult {
  const logs: string[] = ["[Engine] GNOPT Spatial Reasoning Engine v4.0 — Start."];
  const engineMode: "fast" | "quality" =
    input.optimization?.mode ?? (input.nodes.length >= 120 ? "quality" : "fast");
  const engineSeed = input.optimization?.seed ?? 20260217;
  const engineBudgetMs = input.optimization?.timeBudgetMs ?? (engineMode === "quality" ? 150 : 40);
  const benchmarkPure = input.optimization?.benchmarkPure ?? false;
  logs.push(`[Engine] Optimization mode=${engineMode} seed=${engineSeed} budget=${engineBudgetMs}ms`);
  if (benchmarkPure) logs.push("[Engine] Benchmark-pure mode enabled.");
  const ctx: TrafficContext = {
    heatmap:         benchmarkPure ? undefined : input.trafficHeatmap,
    disruptionZones: benchmarkPure ? undefined : input.disruptionZones,
    weightTime:      input.preferences?.weightTime      ?? 0.5,
    weightEmissions: input.preferences?.weightEmissions ?? 0.3,
    weightDistance:  input.preferences?.weightDistance  ?? 0.2,
  };

  const allNodes   = input.nodes;
  const constraints = input.constraints ?? [];
  const depotId    = input.depotId;
  const nodeMap    = new Map(allNodes.map(n => [n.id, n]));

  // Stage 0
  logs.push("[Stage 0] Normalizing constraints to arity ≤ 3.");
  const normGraph = normalizeConstraints(allNodes, constraints, logs);
  logs.push(`[Stage 0] ${allNodes.length} nodes | ${normGraph.constraints.length} normalized constraints.`);

  // Stage 1 — Baseline (nearestNeighbor returns closed, evaluatePath handles it)
  logs.push("[Stage 1] Composite-cost nearest-neighbor baseline + 2-opt refinement.");
  const rawGreedy    = nearestNeighbor(allNodes, depotId, ctx);   // closed tour
  const baselinePath = twoOpt(rawGreedy, nodeMap, ctx);           // closed tour
  const baselineMetrics = evaluatePath(baselinePath, nodeMap, ctx);
  logs.push(
    `[Stage 1] Baseline → ${baselineMetrics.distance.toFixed(2)} km | ` +
    `${baselineMetrics.time.toFixed(1)} min | ` +
    `${(baselineMetrics.emissions / 1000).toFixed(3)} kg CO₂ | ` +
    `Score: ${baselineMetrics.composite.toFixed(2)}`
  );

  // Stage 2 — Compression & Trap Detection
  logs.push("[Stage 2] Preprocessor P — Trap Detection / Hub / Sunflower / Cluster detection.");
  const { compressedGraph, gadgets, patterns, skippedNodes } = runPreprocessorP(
    normGraph, depotId, ctx, logs, benchmarkPure
  );
  const pctReduced = ((1 - compressedGraph.nodes.length / Math.max(allNodes.length, 1)) * 100).toFixed(1);
  logs.push(
    `[Stage 2] ${allNodes.length} → ${compressedGraph.nodes.length} nodes (${pctReduced}% compressed). ` +
    `${patterns.length} pattern(s) found. ${skippedNodes.length} node(s) removed as traps.`
  );

  // Stage 3 — Recursive Solve → returns OPEN path
  const maxDepth = Math.max(1, Math.ceil(Math.log2(Math.max(compressedGraph.nodes.length, 2))));
  logs.push(`[Stage 3] Recursive solve on compressed graph (max depth ${maxDepth}).`);
  const macroCandidatePath = recursiveSolve(compressedGraph, depotId, ctx, 0, maxDepth);

  // Expand macro-nodes → original stops (returns open path)
  const expandedPath = expandGadgets(macroCandidatePath, gadgets, allNodes, ctx);

  // Build finalPath: ensure depot at start AND end (closed tour)
  // FIX: previously depot was only ensured at start; the last edge back
  // to depot was missing, making optimized metrics shorter than they should be.
  const withDepotAtStart =
    expandedPath.length > 0 && expandedPath[0] === depotId
      ? expandedPath
      : [depotId, ...expandedPath.filter(id => id !== depotId)];

  // Remove any accidental intermediate depots (from recursive stitching artifacts)
  const deduped = withDepotAtStart.filter((id, idx) =>
    idx === 0 || id !== depotId
  );

  // Close the tour
  const rawFinalPath = deduped[deduped.length - 1] !== depotId
    ? [...deduped, depotId]
    : deduped;

  const finalPath = improveClosedTourEnsemble(
    allNodes,
    depotId,
    ctx,
    nodeMap,
    rawFinalPath,
    baselinePath,
    logs,
    engineMode,
    engineSeed,
    engineBudgetMs,
    input.optimization?.alns
  );

  // Evaluate on ORIGINAL nodeMap — same as baseline
  const optimizedMetrics = evaluatePath(finalPath, nodeMap, ctx);
  logs.push(
    `[Stage 3] Optimized → ${optimizedMetrics.distance.toFixed(2)} km | ` +
    `${optimizedMetrics.time.toFixed(1)} min | ` +
    `${(optimizedMetrics.emissions / 1000).toFixed(3)} kg CO₂ | ` +
    `Score: ${optimizedMetrics.composite.toFixed(2)}`
  );

  const pct = (before: number, after: number) =>
    before > 0 ? +((( before - after) / before) * 100).toFixed(1) : 0;

  const improvement = {
    distancePct:  pct(baselineMetrics.distance,  optimizedMetrics.distance),
    timePct:      pct(baselineMetrics.time,       optimizedMetrics.time),
    emissionsPct: pct(baselineMetrics.emissions,  optimizedMetrics.emissions),
  };

  const arrow = (v: number) => v > 0 ? `↓${v}%` : v < 0 ? `↑${Math.abs(v)}%` : `→0%`;
  logs.push(
    `[Result] Distance ${arrow(improvement.distancePct)} | ` +
    `Time ${arrow(improvement.timePct)} | ` +
    `Emissions ${arrow(improvement.emissionsPct)}`
  );

  for (const zone of input.disruptionZones ?? []) {
    logs.push(`[Context] Disruption zone: "${zone.description}" at (${zone.x}, ${zone.y}), r=${zone.radius}.`);
  }

  let optimizedRoutes: string[][] | undefined;
  if (input.benchmark) {
    const split = buildBenchmarkConstrainedRoutes(finalPath, allNodes, depotId, input.benchmark, logs);
    if (split) {
      optimizedRoutes = split.routes;
      logs.push(
        `[Benchmark] Built ${split.routes.length} feasible routes | cost=${split.totalCost.toFixed(0)} | metric=${input.benchmark.metric}.`
      );
    } else {
      logs.push("[Benchmark] Route-set generation failed.");
    }
  }

  return {
    baselinePath,
    optimizedPath: finalPath,
    metrics: { baseline: baselineMetrics, optimized: optimizedMetrics, improvement },
    detectedPatterns: patterns,
    engineLogs: logs,
    recursionDepth: maxDepth,
    skippedNodes,
    optimizedRoutes,
  };
}


