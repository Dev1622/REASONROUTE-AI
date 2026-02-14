// reasonRouteEngine.ts
// GNOPT-Inspired Spatial Reasoning Engine v4.0
// Pure deterministic math — no AI calls here.
// FIX SUMMARY (this version):
//   1. recursiveSolve now returns OPEN paths (no closing node).
//      Closed tours from nearestNeighbor are stripped to open before stitching.
//      This prevents intermediate depot visits in the middle of long routes.
//   2. finalPath is explicitly closed with depotId at the end.
//      Previously expandGadgets returned an open path and finalPath was never closed,
//      so evaluatePath was missing the last edge back to depot — making optimized
//      metrics incomparable with baseline (which was always closed).

import {
  Node,
  TrafficContext,
  PathMetrics,
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
};

export type CompressionPattern = {
  type: "hub" | "sunflower" | "denseCluster";
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
};

// ─────────────────────────────────────────────────────────
// Internal types (unchanged)
// ─────────────────────────────────────────────────────────

type InteractionGraph = {
  nodes: Node[];
  constraints: Constraint[];
};

type Gadget = {
  type: "hub" | "sunflower" | "denseCluster";
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
  logs: string[]
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

  // 2. Pattern Compression (unchanged logic)
  let current = { nodes: [...safeNodes], constraints: [...graph.constraints] };
  const gadgets: Gadget[]             = [];
  const patterns: CompressionPattern[] = [];
  let counter = 0;

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
  const depot  = nodes.find(n => n.id === depotId) ?? nodes[0];
  const sorted = [...nodes].sort((a, b) =>
    getEdgeCost(depot, a, ctx).composite - getEdgeCost(depot, b, ctx).composite
  );
  const mid = Math.ceil(sorted.length / 2);
  return { left: sorted.slice(0, mid), right: sorted.slice(mid) };
}

/** Strip the closing node from a closed tour so we have an open path.
 *  [A, B, C, A] → [A, B, C]   (safe if already open) */
function toOpen(path: string[]): string[] {
  if (path.length >= 2 && path[0] === path[path.length - 1]) {
    return path.slice(0, -1);
  }
  return path;
}

function recursiveSolve(
  graph: InteractionGraph,
  depotId: string,
  ctx: TrafficContext,
  depth: number,
  maxDepth: number
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

  const { left, right } = spectralPartition(nodes, depotId, ctx);
  if (right.length === 0) {
    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    const greedy  = toOpen(nearestNeighbor(nodes, depotId, ctx));
    return toOpen(twoOpt([...greedy, greedy[0]], nodeMap, ctx));
  }

  const leftDepot = left.some(n => n.id === depotId) ? depotId : left[0].id;
  const rightDepot = right[0].id;

  const leftPath  = recursiveSolve({ nodes: left,  constraints: graph.constraints }, leftDepot,  ctx, depth + 1, maxDepth);
  const rightPath = recursiveSolve({ nodes: right, constraints: graph.constraints }, rightDepot, ctx, depth + 1, maxDepth);

  // Stitch open paths: just concatenate (no depot in the middle)
  return [...leftPath, ...rightPath];
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

export function runReasonRouteEngine(input: EngineInput): EngineResult {
  const logs: string[] = ["[Engine] GNOPT Spatial Reasoning Engine v4.0 — Start."];

  const ctx: TrafficContext = {
    heatmap:         input.trafficHeatmap,
    disruptionZones: input.disruptionZones,
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
    normGraph, depotId, ctx, logs
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
  const finalPath = deduped[deduped.length - 1] !== depotId
    ? [...deduped, depotId]
    : deduped;

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

  return {
    baselinePath,
    optimizedPath: finalPath,
    metrics: { baseline: baselineMetrics, optimized: optimizedMetrics, improvement },
    detectedPatterns: patterns,
    engineLogs: logs,
    recursionDepth: maxDepth,
    skippedNodes,
  };
}