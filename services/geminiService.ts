import { GoogleGenAI } from "@google/genai";
import { Node } from "./baslineSolver";
import { ensureLocalEnvLoaded } from "./env";
import {
  runReasonRouteEngine,
  EngineInput,
  EngineResult,
  CompressionPattern,
} from "./reasonRouteEngine";
import { FleetComparison, FleetConfig, FleetRoutePlan, Geofence, RoutedRoad, ValidationSummary } from "../types";

ensureLocalEnvLoaded();

function getApiKey() {
  return (
    (typeof process !== "undefined" && process.env
      ? process.env.GEMINI_API_KEY ?? process.env.API_KEY
      : undefined) ??
    (typeof import.meta !== "undefined" && (import.meta as any).env
      ? (import.meta as any).env.VITE_GEMINI_API_KEY ?? (import.meta as any).env.VITE_API_KEY
      : undefined)
  );
}

function getAiClient() {
  const apiKey = getApiKey();
  return apiKey ? new GoogleGenAI({ apiKey }) : null;
}

export function getAiConfigStatus() {
  return {
    geminiConfigured: Boolean(getApiKey()),
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: () => T | Promise<T>): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>(resolve => setTimeout(() => resolve(fallback()), ms)),
  ]);
}

export type OptimizationResult = {
  nodes: Node[];
  baselinePath: string[];
  optimizedPath: string[];
  fleetConfig?: FleetConfig;
  baselineRoutes: FleetRoutePlan[];
  optimizedRoutes: FleetRoutePlan[];
  comparison?: FleetComparison;
  aiOptimizedPath?: string[];
  disruptions: {
    x: number;
    y: number;
    radius: number;
    description: string;
    lat?: number;
    lng?: number;
    radiusMeters?: number;
  }[];
  geofences?: Geofence[];
  baselineRoad?: RoutedRoad | null;
  optimizedRoad?: RoutedRoad | null;
  coordinateMode: "geo" | "demo";
  overrideMode?: "none" | "manual_order";
  activeRouteLabel?: "optimized" | "manual";
  manualRouteOrder?: string[];
  validation?: ValidationSummary;
  routeWarnings?: string[];
  logs: string[];
  engineLogs: string[];
  metrics: {
    baseline: {
      distance: number;
      time: number;
      emissions: number;
    };
    optimized: {
      distance: number;
      time: number;
      emissions: number;
    };
    improvement: {
      distancePct: number;
      timePct: number;
      emissionsPct: number;
    };
  };
  detectedPatterns: CompressionPattern[];
};

type DisruptionZone = {
  x: number;
  y: number;
  radius: number;
  description: string;
  lat?: number;
  lng?: number;
  radiusMeters?: number;
};

type ParseStopsResult = {
  nodes: Node[];
  depotId: string;
  coordinateMode: "geo" | "demo";
  validation: ValidationSummary;
};

function normalizeFleetConfig(fleet: FleetConfig | undefined, stopCount: number): FleetConfig {
  const requestedCount = Math.max(2, Math.min(5, Math.round(fleet?.vehicleCount ?? 3)));
  const vehicleCount = Math.max(1, Math.min(requestedCount, Math.max(stopCount, 1)));
  const vehicleLabels = Array.from({ length: vehicleCount }, (_, index) => {
    const raw = fleet?.vehicleLabels?.[index]?.trim();
    return raw && raw.length > 0 ? raw : `Vehicle ${index + 1}`;
  });
  return { vehicleCount, vehicleLabels };
}

function summarizePath(path: string[], nodeMap: Map<string, Node>) {
  const stopIds = path.filter((id, index) => index !== 0 && index !== path.length - 1);
  return {
    totalLegs: Math.max(0, path.length - 1),
    stopCount: stopIds.length,
    firstStopLabel: stopIds[0] ? nodeMap.get(stopIds[0])?.label ?? stopIds[0] : "N/A",
    lastStopLabel: stopIds[stopIds.length - 1] ? nodeMap.get(stopIds[stopIds.length - 1])?.label ?? stopIds[stopIds.length - 1] : "N/A",
    longestLegKm: 0,
  };
}

function buildFleetRoutePlans(
  paths: string[][] | undefined,
  nodeMap: Map<string, Node>,
  depotId: string,
  fleetConfig: FleetConfig
): FleetRoutePlan[] {
  const resolvedPaths = paths?.length
    ? paths
    : Array.from({ length: fleetConfig.vehicleCount }, () => [depotId, depotId]);

  return resolvedPaths.map((path, index) => ({
    routeId: `vehicle_${index + 1}`,
    vehicleIndex: index,
    vehicleLabel: fleetConfig.vehicleLabels?.[index] ?? `Vehicle ${index + 1}`,
    path,
    road: null,
    metrics: { distance: 0, time: 0, emissions: 0 },
    summary: summarizePath(path, nodeMap),
    warnings: [],
  }));
}

function hasHeaderKeywords(line: string): boolean {
  const normalized = line.toLowerCase();
  return normalized.includes("lat") || normalized.includes("lng") || normalized.includes("lon") || normalized.includes("longitude");
}

function looksLikeGeoRows(rows: Array<{ a: number; b: number }>): boolean {
  if (rows.length === 0) return false;
  if (rows.some(({ a, b }) => Math.abs(a) > 100 || Math.abs(b) > 100)) return true;

  const allHaveDecimals = rows.every(({ a, b }) => !Number.isInteger(a) || !Number.isInteger(b));
  if (!allHaveDecimals) return false;

  const lats = rows.map(r => r.a);
  const lngs = rows.map(r => r.b);
  const latSpan = Math.max(...lats) - Math.min(...lats);
  const lngSpan = Math.max(...lngs) - Math.min(...lngs);
  return latSpan <= 5 && lngSpan <= 5;
}

function normalizeGeoToDemoSpace(points: Array<{ lat: number; lng: number }>): Array<{ x: number; y: number }> {
  const minLat = Math.min(...points.map(p => p.lat));
  const maxLat = Math.max(...points.map(p => p.lat));
  const minLng = Math.min(...points.map(p => p.lng));
  const maxLng = Math.max(...points.map(p => p.lng));
  const latSpan = Math.max(maxLat - minLat, 0.0001);
  const lngSpan = Math.max(maxLng - minLng, 0.0001);

  return points.map(({ lat, lng }) => ({
    x: +(5 + ((lng - minLng) / lngSpan) * 90).toFixed(2),
    y: +(5 + ((lat - minLat) / latSpan) * 90).toFixed(2),
  }));
}

function projectDisruptionsToGeo(disruptions: DisruptionZone[], nodes: Node[]): DisruptionZone[] {
  const geoNodes = nodes.filter(
    (node): node is Node & { lat: number; lng: number } =>
      typeof (node as Node & { lat?: number }).lat === "number" &&
      typeof (node as Node & { lng?: number }).lng === "number"
  );
  if (geoNodes.length === 0) return disruptions;

  const minLat = Math.min(...geoNodes.map(node => node.lat));
  const maxLat = Math.max(...geoNodes.map(node => node.lat));
  const minLng = Math.min(...geoNodes.map(node => node.lng));
  const maxLng = Math.max(...geoNodes.map(node => node.lng));
  const latSpan = Math.max(maxLat - minLat, 0.001);
  const lngSpan = Math.max(maxLng - minLng, 0.001);
  const centerLat = (minLat + maxLat) / 2;
  const metersPerLatDegree = 111_320;
  const metersPerLngDegree = Math.max(1, 111_320 * Math.cos((centerLat * Math.PI) / 180));
  const spanMeters = Math.max(latSpan * metersPerLatDegree, lngSpan * metersPerLngDegree);

  return disruptions.map(zone => ({
    ...zone,
    lat: +(maxLat - (zone.y / 100) * latSpan).toFixed(6),
    lng: +(minLng + (zone.x / 100) * lngSpan).toFixed(6),
    radiusMeters: Math.max(75, Math.round((zone.radius / 100) * spanMeters)),
  }));
}

function parseStopsToNodes(stopsInput: string): ParseStopsResult {
  const rawLines = stopsInput
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean);

  if (rawLines.length === 0) throw new Error("No stops provided.");

  const lines = hasHeaderKeywords(rawLines[0]) ? rawLines.slice(1) : rawLines;
  if (lines.length === 0) throw new Error("No stops provided.");

  const validation: ValidationSummary = { errors: [], warnings: [] };
  const numericRows = lines
    .map(line => line.split(",").map(p => p.trim()))
    .filter(parts => parts.length >= 3 && !isNaN(Number(parts[1])) && !isNaN(Number(parts[2])))
    .map(parts => ({ a: Number(parts[1]), b: Number(parts[2]) }));

  const coordinateMode: "geo" | "demo" = looksLikeGeoRows(numericRows) ? "geo" : "demo";
  const normalizedGeoCoords =
    coordinateMode === "geo"
      ? normalizeGeoToDemoSpace(numericRows.map(({ a, b }) => ({ lat: a, lng: b })))
      : [];
  let geoCoordIndex = 0;

  const nodes: Node[] = lines.map((line, i) => {
    const parts = line.split(",").map(p => p.trim());
    const label = parts[0];
    const id = `node_${i}`;

    let x: number;
    let y: number;

    if (parts.length >= 3 && !isNaN(Number(parts[1])) && !isNaN(Number(parts[2]))) {
      if (coordinateMode === "geo") {
        const lat = Number(parts[1]);
        const lng = Number(parts[2]);
        if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
          validation.errors.push(`Invalid lat/lng at row ${i + 1}: "${line}"`);
        }
        const normalized = normalizedGeoCoords[geoCoordIndex] ?? { x: 50, y: 50 };
        geoCoordIndex += 1;
        x = normalized.x;
        y = normalized.y;
        return {
          id,
          x,
          y,
          lat,
          lng,
          type: i === 0 ? "depot" : "stop",
          label,
        } as Node & { label: string; lat: number; lng: number };
      }

      x = Math.min(95, Math.max(5, Number(parts[1])));
      y = Math.min(95, Math.max(5, Number(parts[2])));
    } else {
      if (parts.length > 1 && coordinateMode === "geo") {
        validation.errors.push(`Missing or invalid lat/lng at row ${i + 1}: "${line}"`);
      } else if (parts.length > 1) {
        validation.warnings.push(`Row ${i + 1} did not contain valid coordinates and was auto-placed: "${line}"`);
      }
      const angle = (i / Math.max(lines.length, 1)) * 2 * Math.PI;
      const radius = i === 0 ? 0 : 20 + (i % 4) * 12;
      x = +(50 + radius * Math.cos(angle)).toFixed(1);
      y = +(50 + radius * Math.sin(angle)).toFixed(1);
    }

    return { id, x, y, type: i === 0 ? "depot" : "stop", label } as Node & { label: string };
  });

  if (coordinateMode === "geo" && nodes.some(node => typeof (node as any).lat !== "number" || typeof (node as any).lng !== "number")) {
    validation.errors.push("Every row must provide valid lat/lng values when using geographic mode.");
  }

  return { nodes, depotId: nodes[0].id, coordinateMode, validation };
}

async function extractDisruptionsFromImage(
  imageBase64: string,
  imageMimeType: string
): Promise<DisruptionZone[]> {
  const ai = getAiClient();
  if (!ai) return [];

  const prompt = `
Analyze this traffic heatmap or road condition image.
Identify disruption zones such as traffic jams, closures, flooding, construction, or accidents.

Return only a valid JSON array.
Each item must include:
- x: position from 0 to 100, left to right
- y: position from 0 to 100, top to bottom
- radius: zone size from 5 to 30
- description: plain-English description of the disruption

If nothing is found, return [].
`;

  try {
    const response = await withTimeout(
      ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: {
          parts: [
            { inlineData: { data: imageBase64, mimeType: imageMimeType } },
            { text: prompt },
          ],
        },
        config: { responseMimeType: "application/json", temperature: 0 },
      }),
      12000,
      () => ({ text: "[]" } as any)
    );

    const text = response.text ?? "[]";
    const cleaned = text.replace(/```json|```/g, "").trim();
    return JSON.parse(cleaned) as DisruptionZone[];
  } catch (err) {
    console.warn("[gemini-disruption-error]", err);
    return [];
  }
}

async function generateReasoningLog(
  nodes: Node[],
  engineResult: EngineResult,
  disruptions: DisruptionZone[]
): Promise<string[]> {
  const describeDelta = (metric: string, value: number): string => {
    if (value > 0) return `${metric} improved by ${value}%`;
    if (value < 0) return `${metric} worsened by ${Math.abs(value)}%`;
    return `${metric} stayed unchanged`;
  };

  const buildLocalLog = () => {
    const { baseline, optimized, improvement } = engineResult.metrics;
    const lines: string[] = [];
    const stopCount = Math.max(0, engineResult.baselinePath.length - 1);
    const patternHighlights = engineResult.detectedPatterns?.slice(0, 2) ?? [];

    lines.push(
      `[00] We compared the normal route against a route tuned to cut time, distance, and emissions across ${stopCount} delivery legs.`
    );

    if (patternHighlights.length > 0) {
      lines.push(
        `[01] The route keeps nearby stops together because we detected ${patternHighlights.map(p => p.description.toLowerCase()).join(" and ")}.`
      );
    } else {
      lines.push(
        `[01] The stop layout is fairly open, so the route mainly avoids unnecessary backtracking and repeat crossings.`
      );
    }

    if (disruptions.length > 0) {
      lines.push(
        `[02] We also steered around ${disruptions.length} live incident zone${disruptions.length === 1 ? "" : "s"} identified from the uploaded image.`
      );
    } else {
      lines.push(
        `[02] No live incident layer was applied, so the route focused on pure operating efficiency.`
      );
    }

    lines.push(
      `[03] The chosen route finishes at ${optimized.distance.toFixed(1)} km, ${optimized.time.toFixed(1)} min, and ${(optimized.emissions / 1000).toFixed(2)} kg CO2 versus ${baseline.distance.toFixed(1)} km, ${baseline.time.toFixed(1)} min, and ${(baseline.emissions / 1000).toFixed(2)} kg on the baseline.`
    );
    lines.push(
      `[04] Overall, ${describeDelta("time", improvement.timePct)}, ${describeDelta("distance", improvement.distancePct)}, and ${describeDelta("emissions", improvement.emissionsPct)}.`
    );

    return lines;
  };

  const fallback = () => buildLocalLog();
  const ai = getAiClient();
  const apiKey = getApiKey();
  if (!ai || !apiKey) return fallback();

  const labelOf = (id: string) => (nodes.find(n => n.id === id) as any)?.label ?? id;
  const baselinePath = engineResult.baselinePath.map(labelOf).join(" -> ");
  const optimizedPath = engineResult.optimizedPath.map(labelOf).join(" -> ");
  const { baseline, optimized, improvement } = engineResult.metrics;
  const patterns = engineResult.detectedPatterns;

  const prompt = `
You are writing route explanations for dispatchers and operations managers.
Explain why the chosen route is better in plain English.
Do not mention engine stages, graph terms, seeds, candidate tours, or algorithm names.
If there are no incidents, say the route was chosen because it keeps the run cleaner, faster, or lower-emission than the baseline.
If there are incidents, say what the chosen route is avoiding and why that matters.
Use only the facts below. Do not invent numbers, delays, or blockages.

Facts:
- Baseline route: ${baselinePath}
- Optimized route: ${optimizedPath}
- Baseline metrics: ${baseline.distance.toFixed(2)} km, ${baseline.time.toFixed(1)} min, ${(baseline.emissions / 1000).toFixed(3)} kg CO2
- Optimized metrics: ${optimized.distance.toFixed(2)} km, ${optimized.time.toFixed(1)} min, ${(optimized.emissions / 1000).toFixed(3)} kg CO2
- Improvement: distance ${improvement.distancePct}%, time ${improvement.timePct}%, emissions ${improvement.emissionsPct}%
- Patterns detected: ${patterns.length > 0 ? patterns.map(p => p.description).join("; ") : "none"}
- Incidents from image: ${disruptions.length > 0 ? disruptions.map(d => d.description).join("; ") : "none"}

Return a JSON array of exactly 4 strings.
Each string must start with [00], [01], [02], or [03].
Each line should sound like a human dispatcher explanation.
Good tone examples:
"Detected a dense cluster of downtown stops, so the route keeps them together to avoid extra cross-city travel."
"This route is chosen because it gets the truck through the busiest area in one pass instead of doubling back later."
Output only the JSON array.
`;

  try {
    const response = await withTimeout(
      ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: { parts: [{ text: prompt }] },
        config: { responseMimeType: "application/json", temperature: 0.35 },
      }),
      12000,
      () => ({ text: "[]" } as any)
    );

    const text = response.text ?? "[]";
    const cleaned = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed.map(String) : fallback();
  } catch (err) {
    console.error("[Gemini] reasoning log failed", err);
    return fallback();
  }
}

type ContextImage = { base64: string; mimeType: string };

export const optimizeRoute = async (
  stopsInput: string,
  contextImages: ContextImage[] = [],
  preferences?: {
    weightTime?: number;
    weightEmissions?: number;
    weightDistance?: number;
  },
  optimization?: { mode?: "fast" | "quality"; timeBudgetMs?: number; baselineMode?: "dynamic" | "distance" },
  fleet?: FleetConfig
): Promise<OptimizationResult> => {
  const { nodes, depotId, coordinateMode, validation } = parseStopsToNodes(stopsInput);
  const fleetConfig = normalizeFleetConfig(fleet, nodes.length - 1);
  if (validation.errors.length > 0) {
    throw new Error(validation.errors.join(" "));
  }

  let disruptions: DisruptionZone[] = [];
  let heatmapForEngine: number[][] | undefined;

  if (contextImages.length > 0) {
    const gridSize = 100;
    const grid: number[][] = Array.from({ length: gridSize }, () => new Array(gridSize).fill(0));

    for (const { base64, mimeType } of contextImages) {
      const zones = await extractDisruptionsFromImage(base64, mimeType);
      disruptions.push(...zones);

      for (const zone of zones) {
        const cx = Math.round(Math.min(gridSize - 1, Math.max(0, zone.x)));
        const cy = Math.round(Math.min(gridSize - 1, Math.max(0, zone.y)));
        const radius = Math.max(1, Math.min(30, zone.radius));

        for (let dx = -radius; dx <= radius; dx++) {
          for (let dy = -radius; dy <= radius; dy++) {
            const col = cx + dx;
            const row = cy + dy;
            if (row >= 0 && row < gridSize && col >= 0 && col < gridSize) {
              const dist = Math.sqrt(dx * dx + dy * dy);
              const severity = Math.max(0, 1 - dist / radius) * 0.9;
              grid[row][col] = Math.max(grid[row][col], severity);
            }
          }
        }
      }
    }

    if (disruptions.length > 0) {
      heatmapForEngine = grid;
    }
  }

  const engineInput: EngineInput = {
    nodes,
    depotId,
    trafficHeatmap: heatmapForEngine,
    disruptionZones: disruptions,
    preferences: {
      weightTime: preferences?.weightTime ?? 0.5,
      weightEmissions: preferences?.weightEmissions ?? 0.3,
      weightDistance: preferences?.weightDistance ?? 0.2,
    },
    optimization: {
      mode: optimization?.mode,
      timeBudgetMs: optimization?.timeBudgetMs,
    },
    baselineMode: optimization?.baselineMode,
    benchmark: {
      metric: "cvrplib_euc2d",
      vehicleCount: fleetConfig.vehicleCount,
      vehicleCapacity: Math.max(1, Math.ceil(Math.max(nodes.length - 1, 1) / fleetConfig.vehicleCount)),
      demands: Object.fromEntries(nodes.filter(node => node.id !== depotId).map(node => [node.id, 1])),
    },
  };

  const engineResult = runReasonRouteEngine(engineInput);
  const projectedDisruptions = coordinateMode === "geo" ? projectDisruptionsToGeo(disruptions, nodes) : disruptions;
  const reasoningLog = await generateReasoningLog(nodes, engineResult, projectedDisruptions);
  const toKg = (g: number) => +(g / 1000).toFixed(3);
  const nodeMap = new Map(nodes.map(node => [node.id, node]));
  const baselineRoutes = buildFleetRoutePlans(engineResult.baselineRoutes ?? [engineResult.baselinePath], nodeMap, depotId, fleetConfig);
  const optimizedRoutes = buildFleetRoutePlans(engineResult.optimizedRoutes ?? [engineResult.optimizedPath], nodeMap, depotId, fleetConfig);

  return {
    nodes,
    baselinePath: engineResult.baselinePath,
    optimizedPath: engineResult.optimizedPath,
    fleetConfig,
    baselineRoutes,
    optimizedRoutes,
    aiOptimizedPath: engineResult.optimizedPath,
    disruptions: projectedDisruptions,
    geofences: [],
    baselineRoad: null,
    optimizedRoad: null,
    coordinateMode,
    overrideMode: "none",
    activeRouteLabel: "optimized",
    manualRouteOrder: undefined,
    validation,
    routeWarnings: [],
    logs: reasoningLog,
    engineLogs: engineResult.engineLogs,
    metrics: {
      baseline: {
        distance: +engineResult.metrics.baseline.distance.toFixed(2),
        time: +engineResult.metrics.baseline.time.toFixed(1),
        emissions: toKg(engineResult.metrics.baseline.emissions),
      },
      optimized: {
        distance: +engineResult.metrics.optimized.distance.toFixed(2),
        time: +engineResult.metrics.optimized.time.toFixed(1),
        emissions: toKg(engineResult.metrics.optimized.emissions),
      },
      improvement: engineResult.metrics.improvement,
    },
    detectedPatterns: engineResult.detectedPatterns,
  };
};
