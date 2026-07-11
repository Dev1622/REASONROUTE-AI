import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
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

type BksSolution = {
  routes: number[][];
  cost?: number;
};

type CliArgs = {
  vrpPath?: string;
  solPath?: string;
  vehicles?: number;
  ortoolsBudgetMs?: number;
  engineMode: "fast" | "quality";
  engineBudgetMs: number;
  seed: number;
  outputJson?: string;
  demo: boolean;
};

type SolverRun = {
  name: string;
  feasible: boolean;
  totalCost?: number;
  runtimeMs: number;
  routes: number[][];
  notes?: string[];
};

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    engineMode: "quality",
    engineBudgetMs: 200,
    seed: 20260704,
    demo: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--vrp") args.vrpPath = argv[++i];
    else if (arg === "--sol") args.solPath = argv[++i];
    else if (arg === "--vehicles") args.vehicles = Number(argv[++i]);
    else if (arg === "--time-limit-sec") args.ortoolsBudgetMs = Number(argv[++i]) * 1000;
    else if (arg === "--ortools-budget-ms") args.ortoolsBudgetMs = Number(argv[++i]);
    else if (arg === "--engine-budget-ms") args.engineBudgetMs = Number(argv[++i]);
    else if (arg === "--seed") args.seed = Number(argv[++i]);
    else if (arg === "--output-json") args.outputJson = argv[++i];
    else if (arg === "--mode") {
      const mode = String(argv[++i] ?? "").toLowerCase();
      args.engineMode = mode === "fast" ? "fast" : "quality";
    } else if (arg === "--demo") {
      args.demo = true;
    }
  }

  return args;
}

function must<T>(value: T | undefined, message: string): T {
  if (value === undefined || value === null) {
    throw new Error(message);
  }
  return value;
}

function parseNameVehiclesHint(name: string): number | undefined {
  const match = /-k(\d+)$/i.exec(name.trim());
  return match ? Number(match[1]) : undefined;
}

function parseCvrplib(text: string): CvrpInstance {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
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
      if (parts.length < 2) continue;
      const key = parts[0].trim().toUpperCase();
      const value = parts.slice(1).join(":").trim();
      if (key === "NAME") name = value;
      if (key === "DIMENSION") dimension = Number(value);
      if (key === "CAPACITY") capacity = Number(value);
      if (key === "EDGE_WEIGHT_TYPE") edgeWeightType = value.toUpperCase();
      continue;
    }

    if (section === "coords") {
      const parts = line.split(/\s+/);
      if (parts.length >= 3) {
        nodes.set(Number(parts[0]), { x: Number(parts[1]), y: Number(parts[2]) });
      }
      continue;
    }

    if (section === "demands") {
      const parts = line.split(/\s+/);
      if (parts.length >= 2) demands.set(Number(parts[0]), Number(parts[1]));
      continue;
    }

    if (section === "depot") {
      const id = Number(line.split(/\s+/)[0]);
      if (id > 0) depot = id;
    }
  }

  if (dimension <= 0) dimension = nodes.size;
  if (edgeWeightType !== "EUC_2D") {
    throw new Error(`Unsupported EDGE_WEIGHT_TYPE=${edgeWeightType}.`);
  }
  if (nodes.size === 0) {
    throw new Error("No coordinates found in VRP input.");
  }

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
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const routes: number[][] = [];
  let cost: number | undefined;

  for (const line of lines) {
    const routeMatch = /^Route\s*#?\d*\s*:\s*(.*)$/i.exec(line);
    if (routeMatch) {
      const route = routeMatch[1]
        .split(/\s+/)
        .map(value => Number(value))
        .filter(value => Number.isFinite(value) && value > 0);
      if (route.length > 0) routes.push(route);
      continue;
    }

    const costMatch = /\b(?:COST|OBJECTIVE\s*_?\s*VALUE)\b[^0-9-]*([0-9]+(?:\.[0-9]+)?)/i.exec(line);
    if (costMatch) cost = Number(costMatch[1]);
  }

  return { routes, cost };
}

function buildDemoInstance(): CvrpInstance {
  const nodes = new Map<number, { x: number; y: number }>([
    [1, { x: 50, y: 50 }],
    [2, { x: 12, y: 68 }],
    [3, { x: 18, y: 80 }],
    [4, { x: 25, y: 20 }],
    [5, { x: 30, y: 35 }],
    [6, { x: 68, y: 20 }],
    [7, { x: 78, y: 28 }],
    [8, { x: 75, y: 72 }],
    [9, { x: 84, y: 80 }],
    [10, { x: 58, y: 58 }],
  ]);
  const demands = new Map<number, number>([
    [1, 0],
    [2, 2],
    [3, 2],
    [4, 3],
    [5, 2],
    [6, 3],
    [7, 2],
    [8, 2],
    [9, 2],
    [10, 2],
  ]);

  return {
    name: "demo-cvrp-k3",
    dimension: nodes.size,
    capacity: 8,
    edgeWeightType: "EUC_2D",
    nodes,
    demands,
    depot: 1,
    vehiclesHint: 3,
  };
}

function edgeCost(inst: CvrpInstance, from: number, to: number): number {
  const a = must(inst.nodes.get(from), `Missing node ${from}`);
  const b = must(inst.nodes.get(to), `Missing node ${to}`);
  return Math.round(Math.hypot(a.x - b.x, a.y - b.y));
}

function routeLoad(inst: CvrpInstance, route: number[]): number {
  return route.reduce((sum, nodeId) => sum + (nodeId === inst.depot ? 0 : (inst.demands.get(nodeId) ?? 0)), 0);
}

function routeCost(inst: CvrpInstance, route: number[]): number {
  let total = 0;
  for (let i = 0; i < route.length - 1; i++) total += edgeCost(inst, route[i], route[i + 1]);
  return total;
}

function totalCost(inst: CvrpInstance, routes: number[][]): number {
  return routes.reduce((sum, route) => sum + routeCost(inst, route), 0);
}

function verifyRoutes(inst: CvrpInstance, routes: number[][], vehicles: number): string[] {
  const issues: string[] = [];
  const customers = Array.from(inst.nodes.keys()).filter(id => id !== inst.depot);
  const seen = new Set<number>();

  if (routes.length !== vehicles) {
    issues.push(`expected ${vehicles} routes, got ${routes.length}`);
  }

  routes.forEach((route, index) => {
    if (route.length < 2) {
      issues.push(`route ${index + 1} is empty`);
      return;
    }
    if (route[0] !== inst.depot || route[route.length - 1] !== inst.depot) {
      issues.push(`route ${index + 1} does not start/end at depot`);
    }
    const load = routeLoad(inst, route);
    if (load > inst.capacity) {
      issues.push(`route ${index + 1} exceeds capacity (${load} > ${inst.capacity})`);
    }
    for (const nodeId of route) {
      if (nodeId === inst.depot) continue;
      if (seen.has(nodeId)) issues.push(`customer ${nodeId} visited more than once`);
      seen.add(nodeId);
    }
  });

  for (const customer of customers) {
    if (!seen.has(customer)) issues.push(`customer ${customer} missing from solution`);
  }

  return issues;
}

function loadInstance(args: CliArgs): { instance: CvrpInstance; bks?: BksSolution } {
  if (args.demo || !args.vrpPath) {
    return { instance: buildDemoInstance() };
  }

  const instance = parseCvrplib(readFileSync(args.vrpPath, "utf8"));
  const bks = args.solPath ? parseSolution(readFileSync(args.solPath, "utf8")) : undefined;
  return { instance, bks };
}

function orderedNodeEntries(inst: CvrpInstance): Array<[number, { x: number; y: number }]> {
  const rest = Array.from(inst.nodes.entries())
    .filter(([id]) => id !== inst.depot)
    .sort((a, b) => a[0] - b[0]);
  return [[inst.depot, must(inst.nodes.get(inst.depot), "Missing depot node")], ...rest];
}

function toEngineNodes(inst: CvrpInstance): Node[] {
  return orderedNodeEntries(inst).map(([id, point]) => ({
    id: String(id),
    x: point.x,
    y: point.y,
    type: id === inst.depot ? "depot" : "stop",
  }));
}

function runReasonRouteBenchmark(inst: CvrpInstance, vehicles: number, args: CliArgs): SolverRun {
  const nodes = toEngineNodes(inst);
  const demands = Object.fromEntries(Array.from(inst.demands.entries()).map(([id, demand]) => [String(id), demand]));

  const started = process.hrtime.bigint();
  const result = runReasonRouteEngine({
    nodes,
    depotId: String(inst.depot),
    baselineMode: "distance",
    optimization: {
      mode: args.engineMode,
      seed: args.seed,
      timeBudgetMs: args.engineBudgetMs,
      benchmarkPure: true,
    },
    preferences: {
      weightTime: 0,
      weightEmissions: 0,
      weightDistance: 1,
    },
    benchmark: {
      metric: "cvrplib_euc2d",
      vehicleCount: vehicles,
      vehicleCapacity: inst.capacity,
      demands,
    },
  });
  const runtimeMs = Number(process.hrtime.bigint() - started) / 1e6;

  const routes = (result.optimizedRoutes ?? []).map(route => route.map(id => Number(id)));
  const issues = verifyRoutes(inst, routes, vehicles);

  return {
    name: "ReasonRoute",
    feasible: issues.length === 0,
    totalCost: issues.length === 0 ? totalCost(inst, routes) : undefined,
    runtimeMs,
    routes,
    notes: issues.length > 0 ? issues : [
      `patterns=${result.detectedPatterns.length}`,
      `recursionDepth=${result.recursionDepth}`,
      `engineDistance=${result.metrics.optimized.distance.toFixed(2)}`,
    ],
  };
}

function runOrToolsBenchmark(inst: CvrpInstance, vehicles: number, args: CliArgs): SolverRun {
  const orderedNodes = orderedNodeEntries(inst);
  const ortoolsBudgetMs = Math.max(1, Math.round(args.ortoolsBudgetMs ?? args.engineBudgetMs));
  const payload = {
    nodes: orderedNodes.map(([id, point]) => ({
      id,
      x: point.x,
      y: point.y,
      demand: inst.demands.get(id) ?? 0,
    })),
    depotIndex: 0,
    vehicleCount: vehicles,
    vehicleCapacity: inst.capacity,
    timeLimitMs: ortoolsBudgetMs,
    firstSolutionStrategy: "PATH_CHEAPEST_ARC",
    localSearchMetaheuristic: "GUIDED_LOCAL_SEARCH",
  };

  const pythonScript = path.resolve("test", "ortools_cvrp_solver.py");
  const proc = spawnSync("python", [pythonScript], {
    cwd: process.cwd(),
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: Math.max(1000, ortoolsBudgetMs + 5000),
  });

  if (proc.error) {
    return {
      name: "OR-Tools",
      feasible: false,
      runtimeMs: 0,
      routes: [],
      notes: [proc.error.message],
    };
  }
  if (proc.status !== 0) {
    return {
      name: "OR-Tools",
      feasible: false,
      runtimeMs: 0,
      routes: [],
      notes: [proc.stderr.trim() || "python solver exited with a non-zero status"],
    };
  }

  const parsed = JSON.parse(proc.stdout) as {
    feasible: boolean;
    runtimeMs: number;
    routes: number[][];
    totalCost?: number | null;
    status: string;
  };

  const nodeIds = orderedNodes.map(([id]) => id);
  const routes = parsed.routes.map(route => route.map(index => nodeIds[index]));
  const issues = parsed.feasible ? verifyRoutes(inst, routes, vehicles) : [`status=${parsed.status}`];

  return {
    name: "OR-Tools",
    feasible: parsed.feasible && issues.length === 0,
    totalCost: parsed.feasible && issues.length === 0 ? totalCost(inst, routes) : undefined,
    runtimeMs: parsed.runtimeMs,
    routes,
    notes: issues.length > 0 ? issues : [`status=${parsed.status}`],
  };
}

function printRun(run: SolverRun, bksCost?: number): void {
  const costLabel = run.totalCost === undefined ? "n/a" : String(run.totalCost);
  const gapLabel = run.totalCost !== undefined && bksCost !== undefined
    ? `${(((run.totalCost - bksCost) / bksCost) * 100).toFixed(2)}%`
    : "n/a";
  console.log(`${run.name}`);
  console.log(`  feasible: ${run.feasible ? "yes" : "no"}`);
  console.log(`  totalCost: ${costLabel}`);
  console.log(`  gapToBKS: ${gapLabel}`);
  console.log(`  runtimeMs: ${run.runtimeMs.toFixed(1)}`);
  console.log(`  routes: ${run.routes.map(route => route.join(" -> ")).join(" | ") || "n/a"}`);
  if (run.notes && run.notes.length > 0) {
    console.log(`  notes: ${run.notes.join("; ")}`);
  }
}

function writeJsonReport(outputPath: string, payload: unknown): void {
  const fullPath = path.resolve(outputPath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const { instance, bks } = loadInstance(args);
  const vehicles = args.vehicles ?? instance.vehiclesHint;
  const ortoolsBudgetMs = Math.max(1, Math.round(args.ortoolsBudgetMs ?? args.engineBudgetMs));

  if (!vehicles || vehicles <= 0) {
    throw new Error("Vehicle count is required. Pass --vehicles or use a CVRPLIB name with -kNN.");
  }

  console.log(`Instance: ${instance.name}`);
  console.log(`Customers: ${instance.dimension - 1}`);
  console.log(`Vehicles: ${vehicles}`);
  console.log(`Capacity: ${instance.capacity}`);
  console.log(`Metric: ${instance.edgeWeightType}`);
  console.log(`ReasonRoute budget: ${args.engineBudgetMs} ms`);
  console.log(`OR-Tools budget: ${ortoolsBudgetMs} ms`);
  if (bks?.cost !== undefined) console.log(`BKS cost: ${bks.cost}`);
  console.log("");

  const reasonRoute = runReasonRouteBenchmark(instance, vehicles, args);
  const orTools = runOrToolsBenchmark(instance, vehicles, args);

  printRun(reasonRoute, bks?.cost);
  console.log("");
  printRun(orTools, bks?.cost);

  const winner = reasonRoute.totalCost !== undefined && orTools.totalCost !== undefined
    ? (reasonRoute.totalCost < orTools.totalCost ? "ReasonRoute" : reasonRoute.totalCost > orTools.totalCost ? "OR-Tools" : "Tie")
    : "Undetermined";
  console.log("");
  console.log(`Winner by route cost: ${winner}`);

  if (reasonRoute.totalCost !== undefined && orTools.totalCost !== undefined) {
    const delta = reasonRoute.totalCost - orTools.totalCost;
    const pct = (delta / Math.max(1, orTools.totalCost)) * 100;
    console.log(`ReasonRoute vs OR-Tools delta: ${delta} (${pct.toFixed(2)}%)`);
  }

  console.log("");
  console.log("Interpretation:");
  console.log("  This is a limited CVRP proxy benchmark, not a full state-of-the-art proof.");
  console.log("  ReasonRoute is being evaluated on a derived feasible route split from its global tour, while OR-Tools solves CVRP directly.");
  console.log("  Use real CVRPLIB instances plus BKS comparisons before making quality claims.");

  if (args.outputJson) {
    writeJsonReport(args.outputJson, {
      generatedAt: new Date().toISOString(),
      instance: {
        name: instance.name,
        dimension: instance.dimension,
        capacity: instance.capacity,
        vehicles,
      },
      benchmarkMethodology: {
        class: "limited_cvrp_proxy",
        reasonRouteBudgetMs: args.engineBudgetMs,
        ortoolsBudgetMs,
        note: "ReasonRoute route cost comes from a derived feasible split of the engine output, not a native CVRP solve.",
      },
      bks: bks?.cost,
      reasonRoute,
      orTools,
      winner,
    });
    console.log(`JSON report written to ${path.resolve(args.outputJson)}`);
  }
}

main();
