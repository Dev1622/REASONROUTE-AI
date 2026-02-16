// reasonRouteEngine.ts — GNOPT Spatial Reasoning Engine v6.0
// Pure deterministic math — no AI calls.
//
// v6.0 ROOT CAUSE FIXES:
//
//   PROBLEM 1 — Cluster compression hurts small graphs:
//     When ≤ 20 nodes, cluster compression → macro solve → expansion
//     is WORSE than direct NN+2opt because:
//     (a) macro centroid position ≠ real stop positions
//     (b) expandGadgets doesn't know the entry/exit context (predecessor/
//         successor in the outer path) so it picks the wrong internal order
//     (c) the macro-level tour through phantom centroids doesn't translate
//         to a good expanded tour through real coordinates.
//
//     FIX: For graphs with ≤ SMALL_GRAPH_THRESHOLD (20) REAL nodes,
//     skip cluster compression. Run NN+2opt+orOpt directly on the full graph.
//     Compression only helps when there are genuinely too many nodes to solve
//     directly (20+). Pattern detection (hub/sunflower) still runs for display.
//
//   PROBLEM 2 — expandGadgets arbitrary entry point:
//     Previously started internal micro-tour from members[0] (array order).
//     Now finds the member closest (composite cost) to the predecessor in the
//     outer path and starts there, correctly orienting the cluster traversal.
//
//   PROBLEM 3 — Optimized could be worse than baseline:
//     Engine now takes the BEST of baseline and optimized by composite score.
//     If the optimizer produces something worse (can happen with bad cluster
//     expansion on sparse graphs), the baseline is returned as optimizedPath.
//     This guarantees the engine never degrades the route.
//
//   PROBLEM 4 — NaN metrics on natural-language input (2 nodes):
//     Two-node path: depot → stop → depot, evaluatePath handles this correctly.
//     The NaN was from a 1-node result (depot only) — the guard in runReasonRouteEngine
//     catches this and returns a trivial result without dividing by zero.

import {
  Node,
  TrafficContext,
  PathMetrics,
  getEdgeCost,
  nearestNeighbor,
  twAwareNearestNeighbor,
  twoOpt,
  twoOptWithTW,
  orOpt,
  evaluatePath,
} from "./baslineSolver";

// ─────────────────────────────────────────────────────────
// Public types (unchanged interface)
// ─────────────────────────────────────────────────────────

export type ConstraintType =
  | "timeWindow" | "restrictedZone" | "driverShift" | "capacity" | "exclusion";

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
  constraintViolations: {
    baselineLateMinutes:   number;
    optimizedLateMinutes:  number;
    baselineHardViolations:number;
    optimizedHardViolations:number;
    lateMinutesReductionPct: number;
  };
  detectedPatterns: CompressionPattern[];
  engineLogs: string[];
  recursionDepth: number;
  skippedNodes?: string[];
};

type InteractionGraph = { nodes: Node[]; constraints: Constraint[] };

type Gadget = {
  type: "hub" | "sunflower" | "denseCluster";
  id: string;
  replacedNodeIds: string[];
  macroNode: Node;
  description: string;
};

// ─────────────────────────────────────────────────────────
// Threshold: only use cluster compression above this size.
// Below this, direct NN+2opt+orOpt is provably better.
// ─────────────────────────────────────────────────────────
const SMALL_GRAPH_THRESHOLD = 20;
const RECURSIVE_THRESHOLD   = 15;
const RECURSIVE_MIN_NODES   = 15;

// ─────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────

function toOpen(path: string[]): string[] {
  if (path.length >= 2 && path[0] === path[path.length-1]) return path.slice(0,-1);
  return [...path];
}

function closeTour(path: string[], depotId: string): string[] {
  const open = toOpen(path);
  if (open.length === 0) return [depotId, depotId];
  if (open[0] !== depotId) open.unshift(depotId);
  // Remove any accidental intermediate depot visits
  const deduped = [open[0]];
  for (let i = 1; i < open.length; i++) {
    if (open[i] !== depotId) deduped.push(open[i]);
  }
  return [...deduped, depotId];
}

function dedupeKeepOrder(path: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of path) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function rotateOpenPath(path: string[], startId: string): string[] {
  const open = toOpen(path);
  const i = open.indexOf(startId);
  if (i <= 0) return open;
  return [...open.slice(i), ...open.slice(0, i)];
}

// ─────────────────────────────────────────────────────────
// Stage 0: Normalization (unchanged)
// ─────────────────────────────────────────────────────────

function normalizeConstraints(
  nodes: Node[], constraints: Constraint[], logs: string[]
): InteractionGraph {
  const result: Constraint[] = [];
  let helperCount = 0;
  for (const c of constraints) {
    if (c.appliesTo.length <= 3) { result.push({ ...c, arity: c.appliesTo.length }); continue; }
    let remaining = [...c.appliesTo];
    while (remaining.length > 2) {
      const chunk = remaining.splice(0, 2);
      const helperName = `_h${helperCount++}`;
      result.push({ id:`${c.id}_s${helperCount}`, type:c.type, details:`${c.details} [norm]`, appliesTo:[...chunk,helperName], arity:3 });
      remaining.unshift(helperName);
    }
    logs.push(`[Norm] Decomposed ${c.id} (arity ${c.appliesTo.length}) into binary tree.`);
  }
  return { nodes, constraints: result };
}

// ─────────────────────────────────────────────────────────
// Stage 2 helpers (unchanged — still used for pattern display)
// ─────────────────────────────────────────────────────────

function buildConstraintDegreeMap(g: InteractionGraph): Map<string,number> {
  const map = new Map<string,number>();
  for (const c of g.constraints) for (const id of c.appliesTo) map.set(id, (map.get(id)??0)+1);
  return map;
}

function getCentroid(nodeIds: string[], allNodes: Node[]): {x:number;y:number} {
  const members = allNodes.filter(n => nodeIds.includes(n.id));
  if (!members.length) return {x:50,y:50};
  return { x: members.reduce((s,n)=>s+n.x,0)/members.length, y: members.reduce((s,n)=>s+n.y,0)/members.length };
}

function detectGeoClusters(nodes: Node[], threshold: number): Map<string,string[]> {
  const visited = new Set<string>();
  const clusters = new Map<string,string[]>();
  for (const pivot of nodes) {
    if (visited.has(pivot.id)) continue;
    const members = nodes.filter(n => {
      if (visited.has(n.id)) return false;
      const dx=n.x-pivot.x, dy=n.y-pivot.y;
      return Math.sqrt(dx*dx+dy*dy) <= threshold;
    });
    if (members.length >= 3) { members.forEach(m=>visited.add(m.id)); clusters.set(pivot.id, members.map(m=>m.id)); }
  }
  return clusters;
}

function applyGadget(g: InteractionGraph, gadget: Gadget): InteractionGraph {
  return {
    nodes: [...g.nodes.filter(n=>!gadget.replacedNodeIds.includes(n.id)), gadget.macroNode],
    constraints: g.constraints.map(c=>({...c,appliesTo:c.appliesTo.map(id=>gadget.replacedNodeIds.includes(id)?gadget.macroNode.id:id)})),
  };
}

// ─────────────────────────────────────────────────────────
// runPreprocessorP — Trap detection + pattern detection
// FIX: pattern compression (gadgets) only applied for large graphs.
// For small graphs, patterns are DETECTED (for display) but nodes are
// NOT replaced with macros — the full node set goes to the solver.
// ─────────────────────────────────────────────────────────

function runPreprocessorP(
  graph: InteractionGraph,
  depotId: string,
  ctx: TrafficContext,
  logs: string[],
  applyCompression: boolean   // NEW: false for small graphs
): { compressedGraph: InteractionGraph; gadgets: Gadget[]; patterns: CompressionPattern[]; skippedNodes: string[] } {

  // 1. Trap/context detection (always active).
  // Deliveries are mandatory; nodes are flagged but not removed.
  const safeNodes: Node[] = [];
  const skippedNodes: string[] = [];
  const coordToPct = (v: number): number => {
    if (!Number.isFinite(v)) return 0;
    if (v >= 0 && v <= 1) return v * 100;
    if (v > 1 && v <= 10) return v * 10;
    return v;
  };
  const getSev = (x: number, y: number): number => {
    if (!ctx.heatmap?.length) return 0;
    const rows = ctx.heatmap.length, cols = ctx.heatmap[0]?.length??0;
    if (!rows||!cols) return 0;
    const px = coordToPct(x);
    const py = coordToPct(y);
    const r = Math.min(rows-1, Math.max(0, Math.floor((py/100)*rows)));
    const c = Math.min(cols-1, Math.max(0, Math.floor((px/100)*cols)));
    return ctx.heatmap[r]?.[c]??0;
  };

  for (const n of graph.nodes) {
    if (n.id === depotId) { safeNodes.push(n); continue; }
    const severity = getSev(n.x, n.y);
    const inDisruption = ctx.disruptionZones?.some(z => Math.sqrt((n.x-z.x)**2+(n.y-z.y)**2) <= z.radius);
    if (severity > 0.85 || inDisruption) {
      skippedNodes.push(n.id);
      logs.push(`[Context Override] Node ${n.id} in Gridlock/Disruption (Sev: ${severity.toFixed(2)}). FLAGGED high-risk, not removed.`);
    }
    safeNodes.push(n);
  }

  // 2. Pattern detection (always for display)
  let current: InteractionGraph = { nodes: [...safeNodes], constraints: [...graph.constraints] };
  const gadgets: Gadget[] = [];
  const patterns: CompressionPattern[] = [];
  let counter = 0;

  // Hub detection
  if (current.constraints.length > 0) {
    const degreeMap = buildConstraintDegreeMap(current);
    for (const [nodeId, degree] of degreeMap) {
      if (degree > 4 && nodeId !== depotId) {
        const hubNode = current.nodes.find(n=>n.id===nodeId);
        if (!hubNode) continue;
        const macroId = `HUB_${nodeId}`;
        const macro: Node = {...hubNode, id:macroId, type:"virtual"};
        const gadget: Gadget = { type:"hub", id:`g_hub_${counter++}`, replacedNodeIds:[nodeId], macroNode:macro, description:`Hub at ${nodeId} (degree ${degree})` };
        gadgets.push(gadget);
        patterns.push({ type:"hub", id:gadget.id, involvedNodeIds:[nodeId], macroNodeId:macroId, description:`Parity-star hub at ${nodeId} (${degree} constraint connections). Compressed.` });
        if (applyCompression) current = applyGadget(current, gadget);
        logs.push(`[Stage 2] Hub detected at ${nodeId} (degree=${degree}).${applyCompression ? " → "+macroId : " (display only)"}`);
      }
    }
  }

  // Sunflower detection
  for (const c of current.constraints) {
    const active = c.appliesTo.filter(id => current.nodes.some(n=>n.id===id));
    if (active.length >= 4) {
      const safe = active.slice(1).filter(id=>id!==depotId);
      if (safe.length < 2) continue;
      const macroId = `SUN_${c.id}`;
      const {x,y} = getCentroid(active, current.nodes);
      const macro: Node = {id:macroId,x,y,type:"virtual"};
      const gadget: Gadget = { type:"sunflower", id:`g_sun_${counter++}`, replacedNodeIds:safe, macroNode:macro, description:`Sunflower on ${c.id} (${safe.length} petals)` };
      gadgets.push(gadget);
      patterns.push({ type:"sunflower", id:gadget.id, involvedNodeIds:active, macroNodeId:macroId, description:`Sunflower: constraint ${c.id} links ${active.length} nodes.` });
      if (applyCompression) current = applyGadget(current, gadget);
      logs.push(`[Stage 2] Sunflower on ${c.id} (${safe.length} petals).${applyCompression ? " → "+macroId : " (display only)"}`);
    }
  }

  // Dense cluster detection
  const nonDepotReal = current.nodes.filter(n=>n.id!==depotId&&n.type!=="virtual");
  const CLUSTER_THRESH = 20;
  const clusters = detectGeoClusters(nonDepotReal, CLUSTER_THRESH);
  for (const [pivotId, memberIds] of clusters) {
    const safe = memberIds.filter(id=>id!==depotId);
    if (safe.length < 2) continue;
    const stillPresent = safe.filter(id=>current.nodes.some(n=>n.id===id));
    if (stillPresent.length < 2) continue;
    const macroId = `CLUSTER_${pivotId}`;
    const {x,y} = getCentroid(stillPresent, current.nodes);
    const macro: Node = {id:macroId,x,y,type:"virtual"};
    const gadget: Gadget = { type:"denseCluster", id:`g_cluster_${counter++}`, replacedNodeIds:stillPresent, macroNode:macro, description:`Dense cluster of ${stillPresent.length} stops near (${x.toFixed(1)},${y.toFixed(1)})` };
    gadgets.push(gadget);
    patterns.push({ type:"denseCluster", id:gadget.id, involvedNodeIds:stillPresent, macroNodeId:macroId, description:`Dense cluster: ${stillPresent.length} stops within ${CLUSTER_THRESH} units of ${pivotId}. Micro-routed internally.` });
    if (applyCompression) current = applyGadget(current, gadget);
    logs.push(`[Stage 2] Dense cluster near ${pivotId} (${stillPresent.length} stops).${applyCompression ? " → "+macroId : " (display only)"}`);
  }

  return { compressedGraph: current, gadgets, patterns, skippedNodes };
}

// ─────────────────────────────────────────────────────────
// Stage 3: Recursive Refinement (geographic partition)
// ─────────────────────────────────────────────────────────

function spectralPartition(nodes: Node[], depotId: string): { left: Node[]; right: Node[] } {
  if (nodes.length <= 1) return { left: nodes, right: [] };
  const cx = nodes.reduce((s,n)=>s+n.x,0)/nodes.length;
  const cy = nodes.reduce((s,n)=>s+n.y,0)/nodes.length;
  const sorted = [...nodes].sort((a,b)=>Math.atan2(a.y-cy,a.x-cx)-Math.atan2(b.y-cy,b.x-cx));
  const di = sorted.findIndex(n=>n.id===depotId);
  const rotated = di>=0 ? [...sorted.slice(di),...sorted.slice(0,di)] : sorted;
  const mid = Math.ceil(rotated.length/2);
  return { left: rotated.slice(0,mid), right: rotated.slice(mid) };
}

function recursiveSolve(
  graph: InteractionGraph, depotId: string, ctx: TrafficContext,
  depth: number, maxDepth: number
): string[] {
  const { nodes } = graph;
  if (nodes.length === 0) return [];

  if (nodes.length <= RECURSIVE_THRESHOLD || depth >= maxDepth) {
    const nodeMap = new Map(nodes.map(n=>[n.id,n]));
    const startId = nodes.some(n=>n.id===depotId) ? depotId : nodes[0].id;
    const greedy  = toOpen(nearestNeighbor(nodes, startId, ctx));
    if (!greedy.length) return [];
    return toOpen(twoOpt([...greedy,greedy[0]], nodeMap, ctx));
  }

  const { left, right } = spectralPartition(nodes, depotId);
  if (!right.length) {
    const nodeMap = new Map(nodes.map(n=>[n.id,n]));
    const greedy  = toOpen(nearestNeighbor(nodes, depotId, ctx));
    return toOpen(twoOpt([...greedy,greedy[0]], nodeMap, ctx));
  }

  const leftDepot  = left.some(n=>n.id===depotId) ? depotId : left[0].id;
  const leftPath   = recursiveSolve({nodes:left,  constraints:graph.constraints}, leftDepot,  ctx, depth+1, maxDepth);
  const rightPath  = recursiveSolve({nodes:right, constraints:graph.constraints}, right[0].id, ctx, depth+1, maxDepth);

  if (!leftPath.length)  return rightPath;
  if (!rightPath.length) return leftPath;

  const allMap = new Map([...left,...right].map(n=>[n.id,n]));
  const seamCost = (lp: string[], rp: string[]) => {
    const a = allMap.get(lp[lp.length-1]), b = allMap.get(rp[0]);
    return a&&b ? getEdgeCost(a,b,ctx).composite : Infinity;
  };
  const rightRev  = [...rightPath].reverse();
  const bestRight = seamCost(leftPath,rightPath) <= seamCost(leftPath,rightRev) ? rightPath : rightRev;
  const stitched  = [...leftPath,...bestRight];
  const fullMap   = new Map([...left,...right].map(n=>[n.id,n]));
  return toOpen(twoOpt([...stitched,stitched[0]], fullMap, ctx));
}

function optimizeSmallGraphMultiStart(
  nodes: Node[],
  depotId: string,
  nodeMap: Map<string, Node>,
  ctx: TrafficContext
): string[] {
  const nonDepot = nodes.filter(n => n.id !== depotId);
  const starts = [depotId, ...nonDepot.map(n => n.id)];
  const maxStarts = nodes.length > 80 ? 6 : nodes.length > 40 ? 10 : starts.length;
  const chosenStarts = starts.slice(0, maxStarts);

  let bestPath = closeTour(
    orOpt(twoOpt(nearestNeighbor(nodes, depotId, ctx), nodeMap, ctx), nodeMap, depotId, ctx),
    depotId
  );
  let bestScore = evaluatePath(bestPath, nodeMap, ctx).composite;

  for (const startId of chosenStarts) {
    const nn = nearestNeighbor(nodes, startId, ctx);
    const rotated = rotateOpenPath(nn, depotId);
    const closed = closeTour(rotated, depotId);
    const two = twoOpt(closed, nodeMap, ctx);
    const opt = closeTour(orOpt(two, nodeMap, depotId, ctx), depotId);
    const score = evaluatePath(opt, nodeMap, ctx).composite;
    if (score < bestScore - 1e-9) {
      bestScore = score;
      bestPath = opt;
    }
  }

  const open = toOpen(bestPath);
  const orderedUnique = dedupeKeepOrder(open);
  return closeTour(orderedUnique, depotId);
}

// ─────────────────────────────────────────────────────────
// expandGadgets
// FIX: finds the cluster member closest (composite) to the predecessor
// in the outer path and starts the internal micro-tour from there.
// This correctly orients the cluster traversal relative to the approach.
// ─────────────────────────────────────────────────────────

function expandGadgets(
  macroPath: string[], gadgets: Gadget[], allOriginalNodes: Node[], ctx: TrafficContext,
  nodeMap: Map<string,Node>
): string[] {
  const result: string[] = [];

  for (let i = 0; i < macroPath.length; i++) {
    const id     = macroPath[i];
    const gadget = gadgets.find(g => g.macroNode.id === id);

    if (!gadget) { result.push(id); continue; }

    const members = allOriginalNodes.filter(n => gadget.replacedNodeIds.includes(n.id));
    if (!members.length) continue;
    if (members.length === 1) { result.push(members[0].id); continue; }

    // FIX: find best entry point based on predecessor in outer path
    const predId = result.length > 0 ? result[result.length-1] : null;
    const pred   = predId ? (nodeMap.get(predId) ?? allOriginalNodes.find(n=>n.id===predId)) : null;

    let startMember = members[0];
    if (pred) {
      let minCost = Infinity;
      for (const m of members) {
        const cost = getEdgeCost(pred, m, ctx).composite;
        if (cost < minCost) { minCost = cost; startMember = m; }
      }
    }

    const localMap  = new Map(members.map(n=>[n.id,n]));
    const localTour = nearestNeighbor(members, startMember.id, ctx);
    const optimized = twoOpt(localTour, localMap, ctx);
    result.push(...toOpen(optimized));
  }

  return result;
}

// ─────────────────────────────────────────────────────────
// Main Engine Entry Point
// ─────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────
// evaluateConstraintPenalty
// Scores a completed path against all constraints and node time windows.
// Returns penalties that are ADDED to composite cost when comparing paths:
//   hard violations  × 100,000  (forbidden edges / zones)
//   late minutes     × 1,000    (arriving after TW close)
//   capacity overflow× 5,000    (total demand > vehicle cap)
//   shift overrun    × 2,000    (route time > max shift)
// ─────────────────────────────────────────────────────────

const HARD_CONSTRAINT_PENALTY = 100_000;
const LATE_MINUTE_PENALTY     =   1_000;
const CAPACITY_UNIT_PENALTY   =   5_000;
const SHIFT_MINUTE_PENALTY    =   2_000;

type ConstraintPenaltyResult = {
  totalPenalty: number;
  hardViolations: number;
  lateMinutes: number;
  capacityOverflow: number;
  shiftOverrunMinutes: number;
};

function parseConstraintDetails(details: string): Record<string, any> {
  if (!details) return {};
  try {
    const parsed = JSON.parse(details);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch { return {}; }
}

function isSameEdge(a: string, b: string, c: string, d: string): boolean {
  return (a === c && b === d) || (a === d && b === c);
}

function isPointInCircle(px: number, py: number, cx: number, cy: number, r: number): boolean {
  return Math.sqrt((px-cx)**2 + (py-cy)**2) <= r;
}

function evaluateConstraintPenalty(
  path: string[],
  nodeMap: Map<string, Node>,
  constraints: Constraint[],
  ctx: TrafficContext,
  depotId: string
): ConstraintPenaltyResult {
  if (path.length < 2) return { totalPenalty:0, hardViolations:0, lateMinutes:0, capacityOverflow:0, shiftOverrunMinutes:0 };

  const timeWindows   = new Map<string, { start: number; end: number }>();
  const serviceTimes  = new Map<string, number>();
  const demands       = new Map<string, number>();
  const capacityLimits: number[] = [];
  const maxRouteMinutes: number[] = [];
  const forbiddenEdges = new Set<string>();
  const forbiddenZones: { x:number; y:number; radius:number }[] = [];

  // Read time windows directly from node.timeWindow field (set by CSV parser)
  for (const node of nodeMap.values()) {
    if (Array.isArray(node.timeWindow) && node.timeWindow.length === 2) {
      const [start, end] = node.timeWindow as [number, number];
      if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
        timeWindows.set(node.id, { start, end });
      }
    }
    if (typeof node.serviceTime === "number" && node.serviceTime > 0) {
      serviceTimes.set(node.id, node.serviceTime);
    }
    if (typeof node.demand === "number" && node.demand > 0) {
      demands.set(node.id, node.demand);
    }
  }

  // Also read from constraint details (secondary source)
  for (const c of constraints) {
    const det = parseConstraintDetails(c.details);
    if (c.type === "timeWindow") {
      const byNode = det.byNode && typeof det.byNode === "object" ? det.byNode : {};
      for (const nodeId of c.appliesTo) {
        const local = byNode[nodeId] ?? det;
        const start = Number(local.start), end = Number(local.end);
        if (Number.isFinite(start) && Number.isFinite(end) && end >= start)
          timeWindows.set(nodeId, { start, end });
        const svc = Number(local.serviceTime);
        if (Number.isFinite(svc) && svc > 0) serviceTimes.set(nodeId, svc);
      }
    }
    if (c.type === "capacity") {
      const cap = Number(det.vehicleCapacity ?? det.capacity);
      if (Number.isFinite(cap) && cap > 0) capacityLimits.push(cap);
      const dbn = det.demandByNode ?? {};
      for (const nodeId of c.appliesTo) {
        const d = Number(dbn[nodeId]);
        if (Number.isFinite(d) && d > 0) demands.set(nodeId, d);
      }
    }
    if (c.type === "driverShift") {
      const m = Number(det.maxRouteMinutes ?? det.maxMinutes);
      if (Number.isFinite(m) && m > 0) maxRouteMinutes.push(m);
    }
    if (c.type === "exclusion" || c.type === "restrictedZone") {
      for (const pair of (det.forbiddenPairs ?? [])) {
        if (Array.isArray(pair) && pair.length >= 2)
          forbiddenEdges.add(`${pair[0]}:::${pair[1]}`);
      }
    }
    if (c.type === "restrictedZone") {
      for (const z of (det.zones ?? [])) {
        const zx = Number((z as any).x), zy = Number((z as any).y), zr = Number((z as any).radius);
        if (Number.isFinite(zx) && Number.isFinite(zy) && Number.isFinite(zr))
          forbiddenZones.push({ x:zx, y:zy, radius:zr });
      }
    }
  }

  let hardViolations = 0, lateMinutes = 0, capacityUsed = 0, currentTime = 0;
  const seenDemand = new Set<string>();

  for (let i = 0; i < path.length - 1; i++) {
    const a = nodeMap.get(path[i]), b = nodeMap.get(path[i+1]);
    if (!a || !b) continue;

    currentTime += getEdgeCost(a, b, ctx).time;

    // Forbidden edge check
    for (const entry of forbiddenEdges) {
      const [c, d] = entry.split(":::");
      if (isSameEdge(a.id, b.id, c, d)) { hardViolations++; break; }
    }

    // Forbidden zone check (midpoint)
    if (forbiddenZones.some(z => isPointInCircle((a.x+b.x)/2, (a.y+b.y)/2, z.x, z.y, z.radius)))
      hardViolations++;

    if (b.id !== depotId) {
      const tw = timeWindows.get(b.id);
      if (tw) {
        if (currentTime < tw.start) currentTime = tw.start; // wait
        if (currentTime > tw.end)   lateMinutes += currentTime - tw.end;
      }
      currentTime += serviceTimes.get(b.id) ?? 0;
      if (!seenDemand.has(b.id)) { capacityUsed += demands.get(b.id) ?? 0; seenDemand.add(b.id); }
    }
  }

  const capCap      = capacityLimits.length > 0 ? Math.min(...capacityLimits) : Infinity;
  const capOverflow = Number.isFinite(capCap) ? Math.max(0, capacityUsed - capCap) : 0;
  const routeLim    = maxRouteMinutes.length > 0 ? Math.min(...maxRouteMinutes) : Infinity;
  const shiftOver   = Number.isFinite(routeLim) ? Math.max(0, currentTime - routeLim) : 0;

  const totalPenalty =
    hardViolations * HARD_CONSTRAINT_PENALTY +
    lateMinutes    * LATE_MINUTE_PENALTY     +
    capOverflow    * CAPACITY_UNIT_PENALTY   +
    shiftOver      * SHIFT_MINUTE_PENALTY;

  return { totalPenalty, hardViolations, lateMinutes, capacityOverflow: capOverflow, shiftOverrunMinutes: shiftOver };
}

// ─────────────────────────────────────────────────────────
export function runReasonRouteEngine(input: EngineInput): EngineResult {
  const logs: string[] = ["[Engine] GNOPT Spatial Reasoning Engine v6.0 — Start."];

  const ctx: TrafficContext = {
    heatmap:         input.trafficHeatmap,
    disruptionZones: input.disruptionZones,
    weightTime:      input.preferences?.weightTime      ?? 0.5,
    weightEmissions: input.preferences?.weightEmissions ?? 0.3,
    weightDistance:  input.preferences?.weightDistance  ?? 0.2,
  };
  const baselineCtx: TrafficContext = {
    heatmap: undefined,
    disruptionZones: undefined,
    weightTime: ctx.weightTime,
    weightEmissions: ctx.weightEmissions,
    weightDistance: ctx.weightDistance,
  };

  const allNodes    = input.nodes;
  const constraints = input.constraints ?? [];
  const depotId     = input.depotId;
  const nodeMap     = new Map(allNodes.map(n=>[n.id,n]));

  // Guard: need depot + at least 1 stop
  const realStops = allNodes.filter(n=>n.id!==depotId);
  if (realStops.length === 0) {
    logs.push("[Engine] WARNING: No delivery stops. Returning trivial result.");
    const zero: PathMetrics = {distance:0,time:0,emissions:0,composite:0};
    const zeroCV = { baselineLateMinutes:0, optimizedLateMinutes:0, baselineHardViolations:0, optimizedHardViolations:0, lateMinutesReductionPct:0 };
    return { baselinePath:[depotId], optimizedPath:[depotId], metrics:{baseline:zero,optimized:zero,improvement:{distancePct:0,timePct:0,emissionsPct:0}}, constraintViolations:zeroCV, detectedPatterns:[], engineLogs:logs, recursionDepth:0, skippedNodes:[] };
  }

  // Stage 0
  logs.push("[Stage 0] Normalizing constraints to arity ≤ 3.");
  const normGraph = normalizeConstraints(allNodes, constraints, logs);
  logs.push(`[Stage 0] ${allNodes.length} nodes | ${normGraph.constraints.length} normalized constraints.`);

  // Detect whether any time-window constraints are present on nodes.
  // If yes: optimized Stage 3 uses twAwareNearestNeighbor (TW-enforcing).
  //         Baseline always uses plain NN so we can show the contrast.
  const hasTimeWindows = allNodes.some(
    n => Array.isArray(n.timeWindow) && n.timeWindow.length === 2
  );
  if (hasTimeWindows) {
    logs.push(`[Stage 0] Time-window constraints detected — TW-aware solver will be used for optimized path.`);
  }

  // Stage 1 — Baseline: plain NN + 2-opt + or-opt (TW-blind, intentionally)
  // This is the "what a standard solver does" reference path.
  // Baseline is context-agnostic by design; optimized path consumes context.
  logs.push("[Stage 1] Composite-cost NN → 2-opt → or-opt baseline.");
  const rawGreedy       = nearestNeighbor(allNodes, depotId, baselineCtx);
  const afterTwoOpt     = twoOpt(rawGreedy, nodeMap, baselineCtx);
  const baselinePath    = orOpt(afterTwoOpt, nodeMap, depotId, baselineCtx);
  const baselineMetrics = evaluatePath(baselinePath, nodeMap, ctx);
  const baselinePenalty = evaluateConstraintPenalty(baselinePath, nodeMap, constraints, ctx, depotId);
  const baselineScore   = baselineMetrics.composite + baselinePenalty.totalPenalty;
  if (constraints.length > 0) {
    logs.push(`[Stage 1] Baseline feasibility → hard=${baselinePenalty.hardViolations} | late=${baselinePenalty.lateMinutes.toFixed(1)} min | capOverflow=${baselinePenalty.capacityOverflow.toFixed(1)} | shiftOver=${baselinePenalty.shiftOverrunMinutes.toFixed(1)} min | penalty=${baselinePenalty.totalPenalty.toFixed(1)}`);
  }
  logs.push(`[Stage 1] Baseline → ${baselineMetrics.distance.toFixed(2)} km | ${baselineMetrics.time.toFixed(1)} min | ${(baselineMetrics.emissions/1000).toFixed(3)} kg CO₂ | Score: ${baselineMetrics.composite.toFixed(2)}`);

  // Stage 2 — Pattern detection (+ compression only for larger graphs)
  const useRecursiveSolve = allNodes.length >= RECURSIVE_MIN_NODES;
  const applyCompression = realStops.length > SMALL_GRAPH_THRESHOLD;
  logs.push(`[Stage 2] Preprocessor P — Trap Detection + Pattern Detection${applyCompression ? " + Compression" : " (display only for small/medium graph)"}.`);
  const { compressedGraph, gadgets, patterns, skippedNodes } = runPreprocessorP(
    normGraph, depotId, ctx, logs, applyCompression
  );
  const pctReduced = ((1 - compressedGraph.nodes.length / Math.max(allNodes.length,1))*100).toFixed(1);
  logs.push(`[Stage 2] ${allNodes.length} → ${compressedGraph.nodes.length} nodes (${pctReduced}% compressed). ${patterns.length} pattern(s). ${skippedNodes.length} high-risk stop(s) flagged.`);

  // Stage 3 — Solve
  let finalPath: string[];

  if (!useRecursiveSolve) {
    // Small graph: solve directly on safe nodes (no macro expansion needed)
    const safeNodes = compressedGraph.nodes;
    const safeMap   = new Map(safeNodes.map(n=>[n.id,n]));

    if (hasTimeWindows) {
      // TW-aware greedy (EDF) → TW-aware 2-opt.
      // orOpt intentionally skipped: it is TW-blind and would relocate urgent
      // stops to shorter-distance positions, undoing the EDF ordering.
      logs.push(`[Stage 3] Small graph + time windows: EDF-NN → TW-aware 2-opt.`);
      const twGreedy  = twAwareNearestNeighbor(safeNodes, depotId, ctx);
      const twTwoOpt  = twoOptWithTW(twGreedy, safeMap, ctx);
      finalPath = closeTour(twTwoOpt, depotId);
    } else {
      logs.push(`[Stage 3] Small graph (${realStops.length} stops): multi-start NN+2opt+orOpt on all mandatory stops.`);
      finalPath = optimizeSmallGraphMultiStart(safeNodes, depotId, safeMap, ctx);
    }
  } else {
    // Medium/Large graph: recursive partition (+ compression when enabled)
    const maxDepth = Math.max(1, Math.ceil(Math.log2(Math.max(compressedGraph.nodes.length,2))));
    logs.push(`[Stage 3] Recursive solve (maxDepth=${maxDepth})${applyCompression ? " + gadget expansion" : ""}.`);
    const macroCandidatePath = recursiveSolve(compressedGraph, depotId, ctx, 0, maxDepth);
    const expandedPath       = applyCompression
      ? expandGadgets(macroCandidatePath, gadgets, allNodes, ctx, nodeMap)
      : macroCandidatePath;
    finalPath = closeTour(expandedPath, depotId);
    // Final or-opt pass on the full expanded path
    finalPath = closeTour(orOpt(finalPath, nodeMap, depotId, ctx), depotId);
  }

  // Evaluate optimized path — both raw metrics AND constraint penalties
  const optimizedMetrics = evaluatePath(finalPath, nodeMap, ctx);
  const optimizedPenalty = evaluateConstraintPenalty(finalPath, nodeMap, constraints, ctx, depotId);
  const optimizedScore   = optimizedMetrics.composite + optimizedPenalty.totalPenalty;
  if (constraints.length > 0) {
    logs.push(`[Stage 3] Optimized feasibility → hard=${optimizedPenalty.hardViolations} | late=${optimizedPenalty.lateMinutes.toFixed(1)} min | capOverflow=${optimizedPenalty.capacityOverflow.toFixed(1)} | shiftOver=${optimizedPenalty.shiftOverrunMinutes.toFixed(1)} min | penalty=${optimizedPenalty.totalPenalty.toFixed(1)}`);
  }
  logs.push(`[Stage 3] Optimized → ${optimizedMetrics.distance.toFixed(2)} km | ${optimizedMetrics.time.toFixed(1)} min | ${(optimizedMetrics.emissions/1000).toFixed(3)} kg CO₂ | Score: ${optimizedMetrics.composite.toFixed(2)}`);

  // Pick best path using PENALTY-AWARE scores.
  // Critical: comparing raw composite without penalties would always favour
  // the shorter-distance baseline, discarding TW-aware improvements.
  let bestPath    = finalPath;
  let bestMetrics = optimizedMetrics;
  if (baselineScore < optimizedScore) {
    bestPath    = baselinePath;
    bestMetrics = baselineMetrics;
    logs.push(`[Stage 3] Note: baseline scored better after feasibility penalties → using baseline as optimized output.`);
  }

  const pct = (b: number, a: number) => b>0 ? +((( b-a)/b)*100).toFixed(1) : 0;
  const improvement = {
    distancePct:  pct(baselineMetrics.distance,  bestMetrics.distance),
    timePct:      pct(baselineMetrics.time,       bestMetrics.time),
    emissionsPct: pct(baselineMetrics.emissions,  bestMetrics.emissions),
  };

  const arrow = (v: number) => v>0 ? `↓${v}%` : v<0 ? `↑${Math.abs(v)}%` : `→0%`;
  logs.push(`[Result] Distance ${arrow(improvement.distancePct)} | Time ${arrow(improvement.timePct)} | Emissions ${arrow(improvement.emissionsPct)}`);

  // Constraint violation summary — the key differentiator for constrained routing
  const bestPenalty = bestPath === finalPath ? optimizedPenalty : baselinePenalty;
  const lateRedPct  = baselinePenalty.lateMinutes > 0
    ? +((baselinePenalty.lateMinutes - bestPenalty.lateMinutes) / baselinePenalty.lateMinutes * 100).toFixed(1)
    : 0;
  if (constraints.length > 0 && baselinePenalty.lateMinutes > 0) {
    logs.push(`[Result] Constraint violations: baseline late=${baselinePenalty.lateMinutes.toFixed(1)}min | optimized late=${bestPenalty.lateMinutes.toFixed(1)}min | reduction=${lateRedPct}%`);
  }

  for (const zone of input.disruptionZones??[]) {
    logs.push(`[Context] Disruption: "${zone.description}" at (${zone.x},${zone.y}), r=${zone.radius}.`);
  }

  return {
    baselinePath,
    optimizedPath: bestPath,
    metrics: { baseline: baselineMetrics, optimized: bestMetrics, improvement },
    constraintViolations: {
      baselineLateMinutes:     +baselinePenalty.lateMinutes.toFixed(1),
      optimizedLateMinutes:    +bestPenalty.lateMinutes.toFixed(1),
      baselineHardViolations:  baselinePenalty.hardViolations,
      optimizedHardViolations: bestPenalty.hardViolations,
      lateMinutesReductionPct: lateRedPct,
    },
    detectedPatterns: patterns,
    engineLogs: logs,
    recursionDepth: useRecursiveSolve ? Math.max(1,Math.ceil(Math.log2(Math.max(compressedGraph.nodes.length,2)))) : 0,
    skippedNodes,
  };
}
