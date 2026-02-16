// geminiService.ts — ReasonRoute AI Gemini Integration Layer v5.0
//
// v5.0 fixes:
//   1. Natural-language input detection: if the stops textarea contains
//      free text (not CSV lines), Gemini parses it into structured stops.
//      This fixes the "give me a route from A to B" → blank NaN result.
//   2. Heatmap grid uses grid[row=y][col=x] (correct, from v4.0 fix).
//   3. Input validation: throws a user-friendly error if < 2 nodes parsed.

import { GoogleGenAI } from "@google/genai";
import { Node } from "./baslineSolver";
import {
  runReasonRouteEngine,
  EngineInput,
  EngineResult,
  CompressionPattern,
  Constraint,
} from "./reasonRouteEngine";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

export type OptimizationResult = {
  nodes: Node[];
  baselinePath: string[];
  optimizedPath: string[];
  disruptions: { x: number; y: number; radius: number; description: string }[];
  logs: string[];
  engineLogs: string[];
  metrics: {
    baseline: { distance: number; time: number; emissions: number };
    optimized: { distance: number; time: number; emissions: number };
    improvement: { distancePct: number; timePct: number; emissionsPct: number };
  };
  detectedPatterns: CompressionPattern[];
  constraintViolations: {
    baselineLateMinutes:     number;
    optimizedLateMinutes:    number;
    baselineHardViolations:  number;
    optimizedHardViolations: number;
    lateMinutesReductionPct: number;
    hasConstraints:          boolean;
  };
};

type DisruptionZone = { x: number; y: number; radius: number; description: string };

const NL_KEYWORDS = /\b(give|get|find|route|from|to|via|path|optimize|between|shortest|fastest|best|how|go|travel|going|plan)\b/i;

function looksLikeNaturalLanguage(input: string): boolean {
  const lines = input.split("\n").map(l => l.trim()).filter(Boolean);
  // If any line has a numeric second column it is CSV — place names like
  // "Indiranagar to Whitefield Road" would otherwise trigger NL_KEYWORDS.
  if (lines.some(l => { const p = l.split(","); return p.length >= 2 && !isNaN(Number(p[1]?.trim())); })) return false;
  if (lines.length === 1 && (lines[0].length > 40 || NL_KEYWORDS.test(lines[0]))) return true;
  return lines.some(l => NL_KEYWORDS.test(l));
}

async function parseNaturalLanguageToNodes(
  nlText: string
): Promise<{ nodes: Node[]; depotId: string }> {
  const prompt = `
You are parsing a logistics routing request into structured delivery stops.

User input: "${nlText}"

Extract all named locations (source, destination, waypoints).
The FIRST location mentioned is the depot/start.
Place each stop on a 0-100 conceptual grid where:
  x=0 is far west, x=100 is far east
  y=0 is far north, y=100 is far south

For locations you recognise as real places, use approximate relative coordinates.
For unknown locations, spread them out reasonably.

Return ONLY a valid JSON array of objects with this exact shape:
[
  { "id": "node_0", "label": "Camp Street", "x": 20, "y": 60, "type": "depot" },
  { "id": "node_1", "label": "Golden Arrow Bus Station", "x": 85, "y": 15, "type": "stop" }
]

Rules:
- At least 2 items (depot + 1 stop)
- "type" is "depot" for the first item, "stop" for all others
- x and y are numbers 5-95
- No extra text, no markdown, ONLY the JSON array
`;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: { parts: [{ text: prompt }] },
      config: { responseMimeType: "application/json", temperature: 0 },
    });
    const text    = response.text ?? "[]";
    const cleaned = text.replace(/```json|```/g, "").trim();
    const parsed  = JSON.parse(cleaned) as any[];

    if (!Array.isArray(parsed) || parsed.length < 2) {
      throw new Error("Gemini returned too few stops.");
    }

    const nodes: Node[] = parsed.map((item: any, i: number) => ({
      id:    item.id    ?? `node_${i}`,
      x:     Math.min(95, Math.max(5, Number(item.x) || 50)),
      y:     Math.min(95, Math.max(5, Number(item.y) || 50)),
      type:  item.type  ?? (i === 0 ? "depot" : "stop"),
      label: item.label ?? item.name ?? `Stop ${i}`,
    }));

    return { nodes, depotId: nodes[0].id };
  } catch {
    const parts = nlText.toLowerCase().split(/\bto\b/);
    const labels = parts.map(p => p.replace(/^.*?(from|route|path|optimize)\b/i, "").trim());
    if (labels.length < 2 || !labels[0] || !labels[1]) {
      throw new Error(`Cannot parse stops from: "${nlText}". Please enter one stop per line.`);
    }
    const nodes: Node[] = [
      { id:"node_0", x:20, y:50, type:"depot", label: labels[0] } as Node,
      { id:"node_1", x:80, y:50, type:"stop",  label: labels[1] } as Node,
    ];
    return { nodes, depotId: "node_0" };
  }
}

function parseStopsToNodes(stopsInput: string): { nodes: Node[]; depotId: string; constraints: Constraint[] } {
  let lines = stopsInput.split("\n").map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) throw new Error("No stops provided.");

  // Skip header row: if col2 is not numeric it's a header ("Name,Lat,Lng,...")
  if (lines.length > 1) {
    const firstParts = lines[0].split(",").map(p => p.trim());
    if (firstParts.length >= 2 && isNaN(Number(firstParts[1]))) lines = lines.slice(1);
  }

  const num = (s: string): number | null => {
    const n = Number(s);
    return s.trim() !== "" && !isNaN(n) ? n : null;
  };

  type RawStop = {
    label: string; rawX: number | null; rawY: number | null;
    twOpen: number | null; twClose: number | null;
    demand: number | null; serviceTime: number | null;
  };

  const rawStops: RawStop[] = lines.map(line => {
    const p = line.split(",").map(s => s.trim());
    const hasCoords = p.length >= 3 && !isNaN(Number(p[1])) && !isNaN(Number(p[2]));
    return {
      label:       p[0],
      rawX:        hasCoords ? Number(p[1]) : null,
      rawY:        hasCoords ? Number(p[2]) : null,
      twOpen:      p.length >= 5 ? num(p[3]) : null,
      twClose:     p.length >= 5 ? num(p[4]) : null,
      demand:      p.length >= 6 ? num(p[5]) : null,
      serviceTime: p.length >= 7 ? num(p[6]) : null,
    };
  });

  const withCoords = rawStops.filter(s => s.rawX !== null);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const s of withCoords) {
    minX = Math.min(minX, s.rawX!); maxX = Math.max(maxX, s.rawX!);
    minY = Math.min(minY, s.rawY!); maxY = Math.max(maxY, s.rawY!);
  }

  const norm = (v: number, lo: number, hi: number) =>
    hi === lo ? 50 : +(5 + ((v - lo) / (hi - lo)) * 90).toFixed(1);

  const nodes: Node[] = rawStops.map((s, i) => {
    const id = `node_${i}`;
    let x: number, y: number;
    if (s.rawX !== null && s.rawY !== null) {
      x = norm(s.rawX, minX, maxX);
      y = norm(s.rawY, minY, maxY);
    } else {
      const angle  = (i / Math.max(lines.length, 1)) * 2 * Math.PI;
      const radius = i === 0 ? 0 : 20 + (i % 4) * 12;
      x = +(50 + radius * Math.cos(angle)).toFixed(1);
      y = +(50 + radius * Math.sin(angle)).toFixed(1);
    }
    const node: Node = { id, x, y, type: i === 0 ? "depot" : "stop", label: s.label };
    if (s.twOpen !== null && s.twClose !== null && s.twClose > s.twOpen) {
      node.timeWindow = [s.twOpen, s.twClose];
    }
    if (s.demand !== null && s.demand > 0)           node.demand      = s.demand;
    if (s.serviceTime !== null && s.serviceTime > 0) node.serviceTime = s.serviceTime;
    return node;
  });

  if (nodes.length < 2) throw new Error("Please provide at least 2 stops (depot + 1 delivery).");

  // Build Constraint[] from nodes that have time windows
  const depotId = nodes[0].id;
  const constraints: Constraint[] = [];

  const twNodes = nodes.filter(n => n.id !== depotId && Array.isArray(n.timeWindow));
  if (twNodes.length > 0) {
    const byNode: Record<string, { start: number; end: number; serviceTime?: number }> = {};
    for (const n of twNodes) {
      byNode[n.id] = { start: n.timeWindow![0], end: n.timeWindow![1], serviceTime: n.serviceTime };
    }
    constraints.push({
      id: "tw_global", type: "timeWindow",
      details: JSON.stringify({ byNode }),
      appliesTo: [depotId, ...twNodes.map(n => n.id)],
      arity: Math.min(twNodes.length + 1, 3),
    });
  }

  const demandNodes = nodes.filter(n => n.id !== depotId && n.demand != null && n.demand! > 0);
  if (demandNodes.length > 0) {
    const demandByNode: Record<string, number> = {};
    for (const n of demandNodes) demandByNode[n.id] = n.demand!;
    constraints.push({
      id: "cap_global", type: "capacity",
      details: JSON.stringify({ vehicleCapacity: 200, demandByNode }),
      appliesTo: [depotId, ...demandNodes.map(n => n.id)],
      arity: Math.min(demandNodes.length + 1, 3),
    });
  }

  return { nodes, depotId, constraints };
}

async function extractDisruptionsFromImage(
  imageBase64: string, imageMimeType: string
): Promise<DisruptionZone[]> {
  const prompt = `
Analyze this traffic heatmap or road condition image.
Identify disruption zones: traffic jams, road closures, floods, construction, accidents.

For each disruption, output a JSON array item with:
- x: position 0-100 (left to right)
- y: position 0-100 (top to bottom)
- radius: zone size 5-30
- description: what you see in plain English

Return ONLY a valid JSON array. If nothing found, return [].
`;
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: { parts: [{ inlineData: { data: imageBase64, mimeType: imageMimeType } }, { text: prompt }] },
      config: { responseMimeType: "application/json", temperature: 0 },
    });
    const cleaned = (response.text ?? "[]").replace(/```json|```/g, "").trim();
    return JSON.parse(cleaned) as DisruptionZone[];
  } catch {
    return [];
  }
}

async function detectDisruptionsFromPixels(
  imageBase64: string,
  imageMimeType: string
): Promise<DisruptionZone[]> {
  if (typeof Image === "undefined" || typeof document === "undefined") return [];

  const src = `data:${imageMimeType};base64,${imageBase64}`;
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = reject;
    el.src = src;
  }).catch(() => null);

  if (!img) return [];

  const SIZE = 100;
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return [];

  ctx.drawImage(img, 0, 0, SIZE, SIZE);
  const data = ctx.getImageData(0, 0, SIZE, SIZE).data;

  const isHot: boolean[] = new Array(SIZE * SIZE).fill(false);
  const idx = (x: number, y: number) => y * SIZE + x;

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const p = idx(x, y) * 4;
      const r = data[p] / 255;
      const g = data[p + 1] / 255;
      const b = data[p + 2] / 255;
      const a = data[p + 3] / 255;
      if (a < 0.15) continue;
      const redDominance = r - Math.max(g, b);
      const warmMix = r * 0.9 + g * 0.4 - b * 0.5;
      const score = Math.max(redDominance, warmMix - 0.45);
      if (score > 0.18) isHot[idx(x, y)] = true;
    }
  }

  const visited: boolean[] = new Array(SIZE * SIZE).fill(false);
  const zones: DisruptionZone[] = [];
  const dirs = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const start = idx(x, y);
      if (!isHot[start] || visited[start]) continue;

      const q: Array<[number, number]> = [[x, y]];
      visited[start] = true;
      let area = 0, sx = 0, sy = 0;

      while (q.length > 0) {
        const [cx, cy] = q.pop()!;
        area++; sx += cx; sy += cy;
        for (const [dx, dy] of dirs) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || nx >= SIZE || ny < 0 || ny >= SIZE) continue;
          const ni = idx(nx, ny);
          if (!isHot[ni] || visited[ni]) continue;
          visited[ni] = true;
          q.push([nx, ny]);
        }
      }

      if (area < 20) continue;
      const cx = sx / area, cy = sy / area;
      const radius = Math.max(5, Math.min(30, Math.sqrt(area / Math.PI) * 1.4));
      zones.push({ x: +cx.toFixed(1), y: +cy.toFixed(1), radius: +radius.toFixed(1), description: "Pixel-detected congestion hotspot" });
    }
  }

  return zones.sort((a, b) => b.radius - a.radius).slice(0, 6);
}

async function generateReasoningLog(
  nodes: Node[], engineResult: EngineResult, disruptions: DisruptionZone[]
): Promise<string[]> {
  const labelOf = (id: string) => nodes.find(n => n.id === id)?.label ?? id;
  const { baseline, optimized, improvement } = engineResult.metrics;
  const patterns = engineResult.detectedPatterns;

  const prompt = `
You are the ReasonRoute AI reasoning layer.
The GNOPT math engine has already computed everything. Explain its decisions in plain English.
Reference ONLY the exact figures below. Do not invent numbers.

=== REAL ENGINE OUTPUT ===
Baseline route:  ${engineResult.baselinePath.map(labelOf).join(" → ")}
Optimized route: ${engineResult.optimizedPath.map(labelOf).join(" → ")}

Baseline:   ${baseline.distance.toFixed(2)} km | ${baseline.time.toFixed(1)} min | ${(baseline.emissions/1000).toFixed(3)} kg CO₂
Optimized:  ${optimized.distance.toFixed(2)} km | ${optimized.time.toFixed(1)} min | ${(optimized.emissions/1000).toFixed(3)} kg CO₂
Improvement: Distance ${improvement.distancePct > 0 ? "↓" : "↑"}${Math.abs(improvement.distancePct)}% | Time ${improvement.timePct > 0 ? "↓" : "↑"}${Math.abs(improvement.timePct)}% | Emissions ${improvement.emissionsPct > 0 ? "↓" : "↑"}${Math.abs(improvement.emissionsPct)}%

Structural patterns detected:
${patterns.length > 0 ? patterns.map(p => `  [${p.type}] ${p.description}`).join("\n") : "  None (small/sparse graph)"}

Key engine stages:
${engineResult.engineLogs.slice(1, 10).map(l => `  ${l}`).join("\n")}
${disruptions.length > 0 ? `\nVisual disruptions:\n${disruptions.map(d => `  - ${d.description}`).join("\n")}` : ""}
=== END DATA ===

Write 5–7 reasoning log entries as a JSON array of strings.
Format: "[00] Stage name: explanation."

IMPORTANT: If the engine logs show constraint violations (late=X min, penalty=Y),
explain which stops had time windows, what the baseline violated, and how the
optimized route resolved it. This is the most important thing to explain.
If baseline late > 0 and optimized late = 0, say exactly that — "zero violations".

Final entry must state the net result with exact numbers.
Output ONLY the JSON array.
`;
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: { parts: [{ text: prompt }] },
      config: { responseMimeType: "application/json", temperature: 0.2 },
    });
    const cleaned = (response.text ?? "[]").replace(/```json|```/g, "").trim();
    const parsed  = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return engineResult.engineLogs.slice(0, 15).map((log, i) =>
      `[${String(i).padStart(2,"0")}] ${log.replace(/^\[[^\]]+\]\s*/, "")}`
    );
  }
}

export const optimizeRoute = async (
  stopsInput: string,
  contextImageBase64?: string,
  contextImageMimeType?: string,
  preferences?: { weightTime?: number; weightEmissions?: number; weightDistance?: number }
): Promise<OptimizationResult> => {

  let nodes: Node[];
  let depotId: string;

  let parsedConstraints: Constraint[] = [];

  if (looksLikeNaturalLanguage(stopsInput)) {
    ({ nodes, depotId } = await parseNaturalLanguageToNodes(stopsInput));
  } else {
    ({ nodes, depotId, constraints: parsedConstraints } = parseStopsToNodes(stopsInput));
  }

  let disruptions: DisruptionZone[] = [];
  let heatmapForEngine: number[][] | undefined;

  if (contextImageBase64 && contextImageMimeType) {
    disruptions = await extractDisruptionsFromImage(contextImageBase64, contextImageMimeType);
    if (disruptions.length === 0) {
      disruptions = await detectDisruptionsFromPixels(contextImageBase64, contextImageMimeType);
    }

    if (disruptions.length > 0) {
      const GRID = 100;
      const grid: number[][] = Array.from({ length: GRID }, () => new Array(GRID).fill(0));

      for (const zone of disruptions) {
        const cx = Math.round(Math.min(GRID-1, Math.max(0, zone.x)));
        const cy = Math.round(Math.min(GRID-1, Math.max(0, zone.y)));
        const r  = Math.max(1, Math.min(30, zone.radius));

        for (let dx = -r; dx <= r; dx++) {
          for (let dy = -r; dy <= r; dy++) {
            const col = cx + dx;
            const row = cy + dy;
            if (row >= 0 && row < GRID && col >= 0 && col < GRID) {
              const severity = Math.max(0, 1 - Math.sqrt(dx*dx + dy*dy) / r) * 0.9;
              grid[row][col] = Math.max(grid[row][col], severity);
            }
          }
        }
      }
      heatmapForEngine = grid;
    }
  }

  const engineInput: EngineInput = {
    nodes,
    depotId,
    constraints:     parsedConstraints.length > 0 ? parsedConstraints : undefined,
    trafficHeatmap:  heatmapForEngine,
    disruptionZones: disruptions,
    preferences: {
      weightTime:      preferences?.weightTime      ?? 0.5,
      weightEmissions: preferences?.weightEmissions ?? 0.3,
      weightDistance:  preferences?.weightDistance  ?? 0.2,
    },
  };

  const engineResult = runReasonRouteEngine(engineInput);
  const reasoningLog = await generateReasoningLog(nodes, engineResult, disruptions);
  const toKg = (g: number) => +(g / 1000).toFixed(3);

  const cv = engineResult.constraintViolations;
  return {
    nodes,
    baselinePath:  engineResult.baselinePath,
    optimizedPath: engineResult.optimizedPath,
    disruptions,
    logs:          reasoningLog,
    engineLogs:    engineResult.engineLogs,
    metrics: {
      baseline: {
        distance:  +engineResult.metrics.baseline.distance.toFixed(2),
        time:      +engineResult.metrics.baseline.time.toFixed(1),
        emissions: toKg(engineResult.metrics.baseline.emissions),
      },
      optimized: {
        distance:  +engineResult.metrics.optimized.distance.toFixed(2),
        time:      +engineResult.metrics.optimized.time.toFixed(1),
        emissions: toKg(engineResult.metrics.optimized.emissions),
      },
      improvement: engineResult.metrics.improvement,
    },
    constraintViolations: {
      baselineLateMinutes:     cv.baselineLateMinutes,
      optimizedLateMinutes:    cv.optimizedLateMinutes,
      baselineHardViolations:  cv.baselineHardViolations,
      optimizedHardViolations: cv.optimizedHardViolations,
      lateMinutesReductionPct: cv.lateMinutesReductionPct,
      hasConstraints:          parsedConstraints.length > 0,
    },
    detectedPatterns: engineResult.detectedPatterns,
  };
};