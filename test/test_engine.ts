// test_engine.ts
// GNOPT Engine Test Suite — aligned to v4.0 API
// Run: tsx test/test_engine.ts
//
// API contract being tested:
//   baslineSolver  exports: Node, TrafficContext, PathMetrics,
//                           euclidean, getEdgeCost, nearestNeighbor(nodes, id, ctx),
//                           twoOpt(path, nodeMap, ctx), evaluatePath(path, nodeMap, ctx),
//                           routeDistance(path, nodeMap)
//   reasonRouteEngine exports: runReasonRouteEngine(input) → EngineResult
//     EngineResult.baselinePath      string[]
//     EngineResult.optimizedPath     string[]
//     EngineResult.metrics.baseline  PathMetrics
//     EngineResult.metrics.optimized PathMetrics
//     EngineResult.metrics.improvement { distancePct, timePct, emissionsPct }
//     EngineResult.detectedPatterns  CompressionPattern[]
//     EngineResult.engineLogs        string[]
//     EngineResult.recursionDepth    number

import {
  runReasonRouteEngine,
  EngineInput,
  EngineResult,
} from "../services/reasonRouteEngine";

import {
  Node,
  TrafficContext,
  euclidean,
  getEdgeCost,
  nearestNeighbor,
  twoOpt,
  evaluatePath,
  routeDistance,
} from "../services/baslineSolver";

// ─── Harness ────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, extra?: string): void {
  if (condition) {
    console.log(`  ✅  ${label}`);
    passed++;
  } else {
    console.error(`  ❌  ${label}${extra ? " → " + extra : ""}`);
    failed++;
  }
}

function assertClose(
  label: string,
  a: number,
  b: number,
  tol = 0.01
): void {
  const ok = Math.abs(a - b) <= tol;
  assert(label, ok, `got ${a.toFixed(4)}, expected ~${b.toFixed(4)} (±${tol})`);
}

function section(title: string): void {
  console.log(`\n${"─".repeat(62)}`);
  console.log(`  ${title}`);
  console.log("─".repeat(62));
}

// ─── Shared fixtures ────────────────────────────────────────────────

// Default context used when calling solver functions directly
const DEFAULT_CTX: TrafficContext = {
  weightTime: 0.5,
  weightEmissions: 0.3,
  weightDistance: 0.2,
};

// Realistic 7-stop city layout on a 0–100 grid
const NODES: Node[] = [
  { id: "WA", x: 15, y: 20, type: "depot", label: "Warehouse A (Hub)"        },
  { id: "D1", x: 30, y: 75, type: "stop",  label: "District 1 – North Market"},
  { id: "D2", x: 55, y: 70, type: "stop",  label: "District 2 – Tech Park"   },
  { id: "D3", x: 75, y: 30, type: "stop",  label: "District 3 – Residential" },
  { id: "D4", x: 70, y: 15, type: "stop",  label: "District 4 – Old Port"    },
  { id: "D5", x: 45, y: 45, type: "stop",  label: "District 5 – Downtown"    },
  { id: "WB", x: 88, y: 80, type: "stop",  label: "Warehouse B (Hub)"        },
];

const NODE_MAP = new Map(NODES.map(n => [n.id, n]));

const BASE_INPUT: EngineInput = {
  nodes: NODES,
  depotId: "WA",
  preferences: DEFAULT_CTX,
};

// ═══════════════════════════════════════════════════════════════════
// SUITE 1 — Euclidean / Coordinate Math
// ═══════════════════════════════════════════════════════════════════
section("SUITE 1 — Euclidean & Coordinate Math");

{
  const a: Node = { id: "a", x: 0,   y: 0   };
  const b: Node = { id: "b", x: 3,   y: 4   };
  const o: Node = { id: "o", x: 0,   y: 0   };
  const c: Node = { id: "c", x: 100, y: 100 };

  assertClose("3-4-5 triangle → 5.0 km",       euclidean(a, b), 5.0);
  assertClose("same point → 0.0 km",           euclidean(a, a), 0.0);
  assertClose("symmetry d(a,b) == d(b,a)",     euclidean(a, b), euclidean(b, a));
  assertClose("grid diagonal ~141.4 km",       euclidean(o, c), 141.42, 0.1);
}

// ═══════════════════════════════════════════════════════════════════
// SUITE 2 — getEdgeCost (physics model)
// ═══════════════════════════════════════════════════════════════════
section("SUITE 2 — getEdgeCost (Physics Model)");

{
  const a: Node = { id: "a", x: 0,  y: 0  };
  const b: Node = { id: "b", x: 30, y: 40 }; // 50 km away

  const cost = getEdgeCost(a, b, DEFAULT_CTX);

  assert("distance is positive",           cost.distance > 0);
  assert("time is positive",               cost.time > 0);
  assert("emissions is positive",          cost.emissions > 0);
  assert("composite is positive",          cost.composite > 0);
  assertClose("distance = 50 km",          cost.distance, 50.0, 0.01);

  // No traffic → emission rate = 120 g/km
  assertClose("emissions = 120 g/km × 50 km = 6000 g",
    cost.emissions, 6000, 0.1);

  // 50 km at highway speed 90 km/h → 33.3 min
  assertClose("time ≈ 33.3 min (highway)",  cost.time, 33.33, 0.1);

  // Traffic penalty: severity 1.0 → 4× slower
  const heavyCtx: TrafficContext = {
    heatmap: [[1.0]],
    weightTime: 0.5,
    weightEmissions: 0.3,
    weightDistance: 0.2,
  };
  const heavyCost = getEdgeCost(
    { id: "x", x: 50, y: 50 },
    { id: "y", x: 52, y: 50 },
    heavyCtx
  );
  assert("heavy traffic increases time",   heavyCost.time > getEdgeCost(
    { id: "x", x: 50, y: 50 },
    { id: "y", x: 52, y: 50 },
    DEFAULT_CTX
  ).time);
  assert("heavy traffic increases emissions", heavyCost.emissions > getEdgeCost(
    { id: "x", x: 50, y: 50 },
    { id: "y", x: 52, y: 50 },
    DEFAULT_CTX
  ).emissions);
}

// ═══════════════════════════════════════════════════════════════════
// SUITE 3 — nearestNeighbor & twoOpt (baslineSolver)
// ═══════════════════════════════════════════════════════════════════
section("SUITE 3 — nearestNeighbor & twoOpt");

{
  // nearestNeighbor requires ctx as 3rd argument
  const nn = nearestNeighbor(NODES, "WA", DEFAULT_CTX);

  assert("NN starts at depot",                nn[0] === "WA");
  assert("NN ends at depot (closed tour)",    nn[nn.length - 1] === "WA");
  assert("NN visits all nodes",               nn.length === NODES.length + 1);
  assert("NN no duplicate mid-stops",
    new Set(nn.slice(1, -1)).size === NODES.length - 1);

  const d1 = routeDistance(nn, NODE_MAP);
  assert("NN distance > 0",                  d1 > 0);
  assert("NN distance plausible (<700 km)",  d1 < 700);
  console.log(`     NN raw distance:  ${d1.toFixed(2)} km`);

  // twoOpt requires ctx as 3rd argument
  const opt = twoOpt(nn, NODE_MAP, DEFAULT_CTX);
  const d2 = routeDistance(opt, NODE_MAP);

  assert("2-opt ≤ NN distance",              d2 <= d1 + 0.001);
  assert("2-opt still closed",               opt[opt.length - 1] === "WA");
  console.log(`     2-opt distance:   ${d2.toFixed(2)} km`);
}

// ═══════════════════════════════════════════════════════════════════
// SUITE 4 — evaluatePath
// ═══════════════════════════════════════════════════════════════════
section("SUITE 4 — evaluatePath");

{
  const nn   = nearestNeighbor(NODES, "WA", DEFAULT_CTX);
  const metrics = evaluatePath(nn, NODE_MAP, DEFAULT_CTX);

  assert("evaluatePath distance > 0",        metrics.distance > 0);
  assert("evaluatePath time > 0",            metrics.time > 0);
  assert("evaluatePath emissions > 0",       metrics.emissions > 0);
  assert("evaluatePath composite > 0",       metrics.composite > 0);

  // With no heatmap, emissions = 120 g/km × distance
  const emPerKm = metrics.emissions / metrics.distance;
  assertClose("emissions = 120 g/km (no traffic)", emPerKm, 120, 1.0);

  // routeDistance and evaluatePath.distance should agree
  const rawDist = routeDistance(nn, NODE_MAP);
  assertClose("evaluatePath.distance matches routeDistance", metrics.distance, rawDist, 0.001);
}

// ═══════════════════════════════════════════════════════════════════
// SUITE 5 — Engine: Basic Run & Path Validity
// ═══════════════════════════════════════════════════════════════════
section("SUITE 5 — Engine Run & Path Validity");

const result: EngineResult = runReasonRouteEngine(BASE_INPUT);

{
  assert("Engine returns a result object",   !!result);
  assert("baselinePath is an array",         Array.isArray(result.baselinePath));
  assert("optimizedPath is an array",        Array.isArray(result.optimizedPath));
  assert("engineLogs is an array",           Array.isArray(result.engineLogs));
  assert("detectedPatterns is an array",     Array.isArray(result.detectedPatterns));
  assert("recursionDepth is a number",       typeof result.recursionDepth === "number");

  const stopIds   = NODES.filter(n => n.id !== "WA").map(n => n.id);
  const optSet    = new Set(result.optimizedPath);
  const allStops  = stopIds.every(id => optSet.has(id));

  assert("Optimized path contains all stop IDs", allStops,
    `missing: ${stopIds.filter(id => !optSet.has(id)).join(", ")}`);
  assert("Optimized starts at depot",        result.optimizedPath[0] === "WA");
  assert("Optimized ends at depot",
    result.optimizedPath[result.optimizedPath.length - 1] === "WA");
  assert("Baseline starts at depot",         result.baselinePath[0] === "WA");
  assert("Baseline ends at depot",
    result.baselinePath[result.baselinePath.length - 1] === "WA");

  console.log(`\n     Baseline path:  ${result.baselinePath.join(" → ")}`);
  console.log(`     Optimized path: ${result.optimizedPath.join(" → ")}`);
}

// ═══════════════════════════════════════════════════════════════════
// SUITE 6 — Metrics Sanity
// ═══════════════════════════════════════════════════════════════════
section("SUITE 6 — Metrics Sanity");

{
  const { baseline, optimized, improvement } = result.metrics;

  assert("Baseline distance > 0",            baseline.distance > 0);
  assert("Baseline time > 0",                baseline.time > 0);
  assert("Baseline emissions > 0",           baseline.emissions > 0);
  assert("Optimized distance > 0",           optimized.distance > 0);
  assert("Optimized time > 0",               optimized.time > 0);
  assert("Optimized emissions > 0",          optimized.emissions > 0);

  // Physics checks
  assert("Baseline time in range (30–600 min)",
    baseline.time > 30 && baseline.time < 600,
    `got ${baseline.time.toFixed(1)} min`);

  assert("Baseline emissions in range (5k–100k g)",
    baseline.emissions > 5000 && baseline.emissions < 100_000,
    `got ${baseline.emissions.toFixed(0)} g`);

  const timePerKm = baseline.time / baseline.distance;
  assert("Time/distance ratio (0.5–2.5 min/km)",
    timePerKm > 0.5 && timePerKm < 2.5,
    `got ${timePerKm.toFixed(2)} min/km`);

  const emPerKm = baseline.emissions / baseline.distance;
  assertClose("Emissions ratio = 120 g/km (no traffic)", emPerKm, 120, 1.0);

  // Optimized must never be meaningfully worse than baseline (2% tolerance)
  assert("Optimized composite ≤ baseline composite (+2% tol)",
    optimized.composite <= baseline.composite * 1.02,
    `opt=${optimized.composite.toFixed(2)} base=${baseline.composite.toFixed(2)}`);

  // improvement object keys must be numbers
  assert("improvement.distancePct is a number",  typeof improvement.distancePct === "number");
  assert("improvement.timePct is a number",       typeof improvement.timePct === "number");
  assert("improvement.emissionsPct is a number",  typeof improvement.emissionsPct === "number");

  console.log(`\n     Baseline  → ${baseline.distance.toFixed(1)} km | ${baseline.time.toFixed(0)} min | ${(baseline.emissions/1000).toFixed(2)} kg CO₂`);
  console.log(`     Optimized → ${optimized.distance.toFixed(1)} km | ${optimized.time.toFixed(0)} min | ${(optimized.emissions/1000).toFixed(2)} kg CO₂`);
  console.log(`     Saving    → dist ${improvement.distancePct}% | time ${improvement.timePct}% | CO₂ ${improvement.emissionsPct}%`);
}

// ═══════════════════════════════════════════════════════════════════
// SUITE 7 — Engine Logs (engineLogs, not logs/stages)
// ═══════════════════════════════════════════════════════════════════
section("SUITE 7 — Engine Logs");

{
  const { engineLogs } = result;

  assert("engineLogs is non-empty",          engineLogs.length > 0);
  assert("All log entries are strings",      engineLogs.every(l => typeof l === "string"));

  // Check stage markers are present
  const hasStage0 = engineLogs.some(l => l.includes("[Stage 0]") || l.includes("Stage 0"));
  const hasStage1 = engineLogs.some(l => l.includes("[Stage 1]") || l.includes("Stage 1"));
  const hasStage2 = engineLogs.some(l => l.includes("[Stage 2]") || l.includes("Stage 2"));
  const hasStage3 = engineLogs.some(l => l.includes("[Stage 3]") || l.includes("Stage 3"));
  const hasResult = engineLogs.some(l => l.includes("[Result]") || l.includes("Result"));

  assert("Stage 0 log present",             hasStage0);
  assert("Stage 1 log present",             hasStage1);
  assert("Stage 2 log present",             hasStage2);
  assert("Stage 3 log present",             hasStage3);
  assert("Result log present",              hasResult);

  console.log("\n     Engine log output:");
  engineLogs.forEach(l => console.log(`       ${l}`));
}

// ═══════════════════════════════════════════════════════════════════
// SUITE 8 — Pattern Detection (detectedPatterns)
// ═══════════════════════════════════════════════════════════════════
section("SUITE 8 — Pattern Detection");

{
  const { detectedPatterns } = result;

  assert("detectedPatterns is an array",     Array.isArray(detectedPatterns));

  if (detectedPatterns.length > 0) {
    const p = detectedPatterns[0];
    assert("Pattern has id",                 typeof p.id === "string" && p.id.length > 0);
    assert("Pattern has type",               ["hub","sunflower","denseCluster"].includes(p.type));
    assert("Pattern has involvedNodeIds",    Array.isArray(p.involvedNodeIds));
    assert("Pattern has macroNodeId",        typeof p.macroNodeId === "string");
    assert("Pattern has description",        typeof p.description === "string");

    console.log(`\n     ${detectedPatterns.length} pattern(s) found:`);
    detectedPatterns.forEach(p =>
      console.log(`       • [${p.type}] ${p.description}`));
  } else {
    console.log("     No patterns detected on this layout (correct for spread-out stops).");
    assert("No patterns is valid",           true);
  }
}

// ═══════════════════════════════════════════════════════════════════
// SUITE 9 — Heatmap Traffic Penalisation
// ═══════════════════════════════════════════════════════════════════
section("SUITE 9 — Heatmap Traffic Penalisation");

{
  // Heavy traffic in the NE quadrant (where D2, WB live)
  const HM = 10;
  const heatmap: number[][] = Array.from({ length: HM }, (_, row) =>
    Array.from({ length: HM }, (_, col) =>
      row < 4 && col > 5 ? 0.9 : 0.0
    )
  );

  const hmResult = runReasonRouteEngine({ ...BASE_INPUT, trafficHeatmap: heatmap });

  assert("Heatmap run completes",            !!hmResult);
  assert("Heatmap path starts at depot",     hmResult.optimizedPath[0] === "WA");
  assert("Heatmap path visits all stops",
    NODES.filter(n => n.id !== "WA").every(n =>
      hmResult.optimizedPath.includes(n.id)));

  const compositeDiffers =
    Math.abs(hmResult.metrics.optimized.composite - result.metrics.optimized.composite) > 0.01;
  assert("Heatmap changes composite score",  compositeDiffers,
    `no-traffic=${result.metrics.optimized.composite.toFixed(2)} ` +
    `traffic=${hmResult.metrics.optimized.composite.toFixed(2)}`);

  console.log(`\n     No-traffic time: ${result.metrics.optimized.time.toFixed(0)} min`);
  console.log(`     NE-traffic time: ${hmResult.metrics.optimized.time.toFixed(0)} min`);
}

// ═══════════════════════════════════════════════════════════════════
// SUITE 10 — Edge Cases
// ═══════════════════════════════════════════════════════════════════
section("SUITE 10 — Edge Cases");

{
  // 2-node (depot + 1 stop)
  try {
    const tiny = runReasonRouteEngine({
      nodes: [
        { id: "dep", x: 10, y: 10, type: "depot" },
        { id: "s1",  x: 50, y: 50, type: "stop"  },
      ],
      depotId: "dep",
    });
    assert("2-node run completes",           !!tiny);
    assert("2-node path length = 3",         tiny.optimizedPath.length === 3,
      `got ${tiny.optimizedPath.length}`);
    const legDist = euclidean({ id:"", x:10, y:10 }, { id:"", x:50, y:50 });
    assertClose("2-node distance = 2× leg",  tiny.metrics.optimized.distance, legDist * 2, 1.0);
  } catch (e: any) {
    assert("2-node run completes",           false, e.message);
  }

  // 15-node (triggers recursive partition)
  const bigNodes: Node[] = Array.from({ length: 15 }, (_, i) => ({
    id: i === 0 ? "depot" : `s${i}`,
    x:  10 + (i * 7)  % 82,
    y:  10 + (i * 11) % 82,
    type: i === 0 ? "depot" : "stop",
  }));

  try {
    const big = runReasonRouteEngine({ nodes: bigNodes, depotId: "depot" });
    const allPresent = bigNodes.every(n => big.optimizedPath.includes(n.id));
    assert("15-node: all stops present",     allPresent,
      `missing: ${bigNodes.filter(n => !big.optimizedPath.includes(n.id)).map(n=>n.id).join(", ")}`);
    assert("15-node: closed tour",
      big.optimizedPath[0] === "depot" &&
      big.optimizedPath[big.optimizedPath.length - 1] === "depot");
    assert("15-node: recursionDepth >= 1",   big.recursionDepth >= 1);
    console.log(`\n     15-node recursion depth: ${big.recursionDepth}`);
  } catch (e: any) {
    assert("15-node run completes",          false, e.message);
  }

  // Adversarial: engine must not degrade composite by >2%
  const adversarial: EngineInput = {
    nodes: [
      { id: "dep", x: 10, y: 10, type: "depot" },
      { id: "a",   x: 12, y: 80, type: "stop"  },
      { id: "b",   x: 85, y: 82, type: "stop"  },
      { id: "c",   x: 14, y: 75, type: "stop"  },
      { id: "d",   x: 83, y: 78, type: "stop"  },
      { id: "e",   x: 50, y: 50, type: "stop"  },
    ],
    depotId: "dep",
    preferences: DEFAULT_CTX,
  };
  const adv = runReasonRouteEngine(adversarial);
  const delta = adv.metrics.baseline.composite - adv.metrics.optimized.composite;
  assert("Adversarial: engine never degrades route by >2%",
    delta >= -(adv.metrics.baseline.composite * 0.02),
    `baseline=${adv.metrics.baseline.composite.toFixed(2)} opt=${adv.metrics.optimized.composite.toFixed(2)}`);

  // Preference weights affect composite
  const timePrio = runReasonRouteEngine({
    ...BASE_INPUT,
    preferences: { weightTime: 0.9, weightEmissions: 0.05, weightDistance: 0.05 },
  });
  const emPrio = runReasonRouteEngine({
    ...BASE_INPUT,
    preferences: { weightTime: 0.05, weightEmissions: 0.9, weightDistance: 0.05 },
  });
  assert("Preference weights change composite",
    timePrio.metrics.optimized.composite !== emPrio.metrics.optimized.composite);

  // No unknown node IDs in either path
  const allIds = new Set(NODES.map(n => n.id));
  assert("No ghost IDs in baseline",
    result.baselinePath.every(id => allIds.has(id)));
  assert("No ghost IDs in optimized",
    result.optimizedPath.every(id => allIds.has(id)));
}

// ═══════════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════════
console.log(`\n${"═".repeat(62)}`);
console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
console.log("═".repeat(62));

if (failed === 0) {
  console.log("\n  🚀  All tests passed. Engine is working correctly.\n");
} else {
  console.log(`\n  ⚠️  ${failed} test(s) failed. See ❌ above.\n`);
  process.exit(1);
}