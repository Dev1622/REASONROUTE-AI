// reasonRouteEngine.ts
// GNOPT-Inspired Spatial Reasoning Engine v4.0
// Pure deterministic math — no AI calls here.
// Responsibilities:
//   Stage 0 — Normalization (constraint arity reduction)
//   Stage 1 — Baseline (composite-cost nearest-neighbor + 2-opt)
//   Stage 2 — Pattern Compression (Hub, Sunflower, Dense-Cluster detection) AND Trap Removal
//   Stage 3 — Recursive Refinement (spectral partition + local solve)
//   Output  — Structured result with REAL metrics on a single coordinate system

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
// Public types
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
  skippedNodes?: string[]; // Added to track removed traps
};

// ─────────────────────────────────────────────────────────
// Internal types
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
// Stage 0: Normalization
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
// Stage 2: Pattern Compression & Trap Removal
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

function detectGeoClusters(
  nodes: Node[],
  threshold: number
): Map<string, string[]> {
  const visited = new Set<string>();
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
): { compressedGraph: InteractionGraph; gadgets: Gadget[]; patterns: CompressionPattern[], skippedNodes: string[] } {
  
  // 1. TRAP FILTERING: Remove nodes in gridlock or disruption zones
  const safeNodes: Node[] = [];
  const skippedNodes: string[] = [];

  const getSeverity = (x: number, y: number) => {
    if (!ctx.heatmap || ctx.heatmap.length === 0) return 0;
    // Clamp coordinates to heatmap bounds
    const ix = Math.min(Math.max(Math.floor(x), 0), ctx.heatmap.length - 1);
    const iy = Math.min(Math.max(Math.floor(y), 0), ctx.heatmap[0].length - 1);
    return ctx.heatmap[ix]?.[iy] || 0;
  };

  for (const n of graph.nodes) {
    // Never remove the depot
    if (n.id === depotId) {
      safeNodes.push(n);
      continue;
    }

    // Check Heatmap Severity (Fire/Gridlock)
    const severity = getSeverity(n.x, n.y);
    
    // Check Manual Disruption Zones
    const inDisruption = ctx.disruptionZones?.some(z => {
      const dx = n.x - z.x;
      const dy = n.y - z.y;
      return Math.sqrt(dx*dx + dy*dy) <= z.radius;
    });

    // Threshold: 0.85 (High Traffic/Fire) or explicitly disrupted
    if (severity > 0.85 || inDisruption) {
      skippedNodes.push(n.id);
      logs.push(`[Context Override] Node ${n.id} is in Gridlock/Disruption (Sev: ${severity.toFixed(2)}). REMOVING.`);
    } else {
      safeNodes.push(n);
    }
  }

  // 2. Pattern Compression (Run on SAFE nodes only)
  let current = { nodes: [...safeNodes], constraints: [...graph.constraints] };
  const gadgets: Gadget[] = [];
  const patterns: CompressionPattern[] = [];
  let counter = 0;

  // A. Hub detection (high constraint-degree nodes)
  if (current.constraints.length > 0) {
    const degreeMap = buildConstraintDegreeMap(current);
    for (const [nodeId, degree] of degreeMap) {
      if (degree > 4 && nodeId !== depotId) {
        const hubNode = current.nodes.find(n => n.id === nodeId);
        if (!hubNode) continue;
        const macroId = `HUB_${nodeId}`;
        const macro: Node = { ...hubNode, id: macroId, type: "virtual" };
        const gadget: Gadget = {
          type: "hub",
          id: `g_hub_${counter++}`,
          replacedNodeIds: [nodeId],
          macroNode: macro,
          description: `Hub at ${nodeId} (degree ${degree})`,
        };
        gadgets.push(gadget);
        patterns.push({
          type: "hub",
          id: gadget.id,
          involvedNodeIds: [nodeId],
          macroNodeId: macroId,
          description: `Parity-star hub at node ${nodeId} (${degree} constraint connections). Compressed.`,
        });
        current = applyGadget(current, gadget);
        logs.push(`[Stage 2] Hub detected at ${nodeId} (degree=${degree}). → ${macroId}`);
      }
    }
  }

  // B. Sunflower detection (constraint touching many nodes)
  for (const c of current.constraints) {
    const active = c.appliesTo.filter(id => current.nodes.some(n => n.id === id));
    if (active.length >= 4) {
      const petals = active.slice(1);
      const safe = petals.filter(id => id !== depotId);
      if (safe.length < 2) continue;
      const macroId = `SUN_${c.id}`;
      const { x, y } = getCentroid(active, current.nodes);
      const macro: Node = { id: macroId, x, y, type: "virtual" };
      const gadget: Gadget = {
        type: "sunflower",
        id: `g_sun_${counter++}`,
        replacedNodeIds: safe,
        macroNode: macro,
        description: `Sunflower on ${c.id} (${safe.length} petals)`,
      };
      gadgets.push(gadget);
      patterns.push({
        type: "sunflower",
        id: gadget.id,
        involvedNodeIds: active,
        macroNodeId: macroId,
        description: `Sunflower pattern: constraint ${c.id} links ${active.length} nodes. Petals compressed.`,
      });
      current = applyGadget(current, gadget);
      logs.push(`[Stage 2] Sunflower on ${c.id} (${safe.length} petals) → ${macroId}`);
    }
  }

  // C. Dense geographic cluster detection
  const nonDepotReal = current.nodes.filter(
    n => n.id !== depotId && n.type !== "virtual"
  );
  const CLUSTER_THRESH = 20; // ~20 grid units
  const clusters = detectGeoClusters(nonDepotReal, CLUSTER_THRESH);

  for (const [pivotId, memberIds] of clusters) {
    const safe = memberIds.filter(id => id !== depotId);
    if (safe.length < 2) continue;
    // Skip if all already replaced
    const stillPresent = safe.filter(id => current.nodes.some(n => n.id === id));
    if (stillPresent.length < 2) continue;

    const macroId = `CLUSTER_${pivotId}`;
    const { x, y } = getCentroid(stillPresent, current.nodes);
    const macro: Node = { id: macroId, x, y, type: "virtual" };
    const gadget: Gadget = {
      type: "denseCluster",
      id: `g_cluster_${counter++}`,
      replacedNodeIds: stillPresent,
      macroNode: macro,
      description: `Dense cluster of ${stillPresent.length} stops near (${x.toFixed(1)},${y.toFixed(1)})`,
    };
    gadgets.push(gadget);
    patterns.push({
      type: "denseCluster",
      id: gadget.id,
      involvedNodeIds: stillPresent,
      macroNodeId: macroId,
      description: `Dense Minor: ${stillPresent.length} stops within ${CLUSTER_THRESH} units of ${pivotId}. Micro-routed internally.`,
    });
    current = applyGadget(current, gadget);
    logs.push(`[Stage 2] Dense cluster near ${pivotId} (${stillPresent.length} stops) → ${macroId}`);
  }

  return { compressedGraph: current, gadgets, patterns, skippedNodes };
}

// ─────────────────────────────────────────────────────────
// Stage 3: Recursive Refinement
// ─────────────────────────────────────────────────────────

function spectralPartition(
  nodes: Node[],
  depotId: string,
  ctx: TrafficContext
): { left: Node[]; right: Node[] } {
  const depot = nodes.find(n => n.id === depotId) ?? nodes[0];
  const sorted = [...nodes].sort((a, b) => {
    return (
      getEdgeCost(depot, a, ctx).composite -
      getEdgeCost(depot, b, ctx).composite
    );
  });
  const mid = Math.ceil(sorted.length / 2);
  return { left: sorted.slice(0, mid), right: sorted.slice(mid) };
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
    const greedy = nearestNeighbor(nodes, startId, ctx);
    return twoOpt(greedy, nodeMap, ctx);
  }

  const { left, right } = spectralPartition(nodes, depotId, ctx);
  if (right.length === 0) {
    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    const greedy = nearestNeighbor(nodes, depotId, ctx);
    return twoOpt(greedy, nodeMap, ctx);
  }

  const leftDepot = left.some(n => n.id === depotId) ? depotId : left[0].id;
  const rightDepot = right[0].id;

  const leftPath = recursiveSolve(
    { nodes: left, constraints: graph.constraints },
    leftDepot,
    ctx,
    depth + 1,
    maxDepth
  );
  const rightPath = recursiveSolve(
    { nodes: right, constraints: graph.constraints },
    rightDepot,
    ctx,
    depth + 1,
    maxDepth
  );

  const stitched = [...leftPath];
  const skip = rightPath[0] === leftPath[leftPath.length - 1] ? 1 : 0;
  stitched.push(...rightPath.slice(skip));
  return stitched;
}

// ─────────────────────────────────────────────────────────
// Gadget expansion: macro-nodes → original stops (micro-routed)
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
    const members = allOriginalNodes.filter(n =>
      gadget.replacedNodeIds.includes(n.id)
    );
    if (members.length === 0) continue;
    if (members.length === 1) {
      result.push(members[0].id);
      continue;
    }
    // Micro-route internally
    const nodeMap = new Map(members.map(n => [n.id, n]));
    const local = nearestNeighbor(members, members[0].id, ctx);
    const optimized = twoOpt(local, nodeMap, ctx);
    // Drop the return-to-depot at end of local sub-tour (it's an intermediate segment)
    result.push(...optimized.slice(0, -1));
  }

  return result;
}

// ─────────────────────────────────────────────────────────
// Main Engine Entry Point
// ─────────────────────────────────────────────────────────

export function runReasonRouteEngine(input: EngineInput): EngineResult {
  const logs: string[] = ["[Engine] GNOPT Spatial Reasoning Engine v4.0 — Start."];
  
  // Create Traffic Context with Heatmap AND Disruption Zones
  const ctx: TrafficContext = {
    heatmap: input.trafficHeatmap,
    disruptionZones: input.disruptionZones, 
    weightTime: input.preferences?.weightTime ?? 0.5,
    weightEmissions: input.preferences?.weightEmissions ?? 0.3,
    weightDistance: input.preferences?.weightDistance ?? 0.2,
  };

  const allNodes = input.nodes;
  const constraints = input.constraints ?? [];
  const depotId = input.depotId;
  const nodeMap = new Map(allNodes.map(n => [n.id, n]));

  // Stage 0
  logs.push("[Stage 0] Normalizing constraints to arity ≤ 3.");
  const normGraph = normalizeConstraints(allNodes, constraints, logs);
  logs.push(
    `[Stage 0] ${allNodes.length} nodes | ${normGraph.constraints.length} normalized constraints.`
  );

  // Stage 1 — Baseline
  logs.push("[Stage 1] Composite-cost nearest-neighbor baseline + 2-opt refinement.");
  const rawGreedy = nearestNeighbor(allNodes, depotId, ctx);
  const baselinePath = twoOpt(rawGreedy, nodeMap, ctx);
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
    normGraph,
    depotId,
    ctx, // Pass context for trap detection
    logs
  );
  
  const pctReduced = (
    (1 - compressedGraph.nodes.length / Math.max(allNodes.length, 1)) * 100
  ).toFixed(1);
  logs.push(
    `[Stage 2] ${allNodes.length} → ${compressedGraph.nodes.length} nodes (${pctReduced}% compressed). ` +
    `${patterns.length} pattern(s) found. ${skippedNodes.length} node(s) removed as traps.`
  );

  // Stage 3 — Recursive Solve
  const maxDepth = Math.max(1, Math.ceil(Math.log2(Math.max(compressedGraph.nodes.length, 2))));
  logs.push(`[Stage 3] Recursive solve on compressed graph (max depth ${maxDepth}).`);
  const macroCandidatePath = recursiveSolve(
    compressedGraph,
    depotId,
    ctx,
    0,
    maxDepth
  );

  // Expand macro-nodes back to real stops
  const expandedPath = expandGadgets(macroCandidatePath, gadgets, allNodes, ctx);

  // Ensure depot is at start
  const finalPath =
    expandedPath.length > 0 && expandedPath[0] === depotId
      ? expandedPath
      : [depotId, ...expandedPath.filter(id => id !== depotId)];

  // Evaluate on ORIGINAL coordinates — same nodeMap as baseline
  const optimizedMetrics = evaluatePath(finalPath, nodeMap, ctx);
  logs.push(
    `[Stage 3] Optimized → ${optimizedMetrics.distance.toFixed(2)} km | ` +
    `${optimizedMetrics.time.toFixed(1)} min | ` +
    `${(optimizedMetrics.emissions / 1000).toFixed(3)} kg CO₂ | ` +
    `Score: ${optimizedMetrics.composite.toFixed(2)}`
  );

  // Improvement percentages
  const pct = (before: number, after: number) =>
    before > 0 ? +((( before - after) / before) * 100).toFixed(1) : 0;

  const improvement = {
    distancePct: pct(baselineMetrics.distance, optimizedMetrics.distance),
    timePct: pct(baselineMetrics.time, optimizedMetrics.time),
    emissionsPct: pct(baselineMetrics.emissions, optimizedMetrics.emissions),
  };

  const arrow = (v: number) => (v > 0 ? `↓${v}%` : v < 0 ? `↑${Math.abs(v)}%` : `→0%`);
  logs.push(
    `[Result] Distance ${arrow(improvement.distancePct)} | ` +
    `Time ${arrow(improvement.timePct)} | ` +
    `Emissions ${arrow(improvement.emissionsPct)}`
  );

  // Log disruption zones if present
  for (const zone of input.disruptionZones ?? []) {
    logs.push(
      `[Context] Disruption zone: "${zone.description}" at (${zone.x}, ${zone.y}), r=${zone.radius}.`
    );
  }

  return {
    baselinePath,
    optimizedPath: finalPath,
    metrics: { baseline: baselineMetrics, optimized: optimizedMetrics, improvement },
    detectedPatterns: patterns,
    engineLogs: logs,
    recursionDepth: maxDepth,
    skippedNodes
  };
}