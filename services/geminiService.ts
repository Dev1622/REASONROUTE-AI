// geminiService.ts
// ReasonRoute AI — Gemini Integration Layer v4.0
//
// ARCHITECTURE:
//   Gemini does TWO things only:
//     1. Interpret visual context (traffic/heatmap images) → disruption zones
//     2. Explain the engine's real math decisions in human language → reasoning log
//
//   Gemini does NOT compute routes, coordinates, or metrics.
//   All math is done by reasonRouteEngine.ts (deterministic, auditable).

import { GoogleGenAI } from "@google/genai";
import { Node } from "./baslineSolver";
import {
  runReasonRouteEngine,
  EngineInput,
  EngineResult,
  CompressionPattern,
} from "./reasonRouteEngine";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

// ─────────────────────────────────────────────────────────
// Public result type
// ─────────────────────────────────────────────────────────

export type OptimizationResult = {
  nodes: Node[];
  baselinePath: string[];
  optimizedPath: string[];
  disruptions: {
    x: number;
    y: number;
    radius: number;
    description: string;
  }[];
  logs: string[];         // Gemini-generated human-readable reasoning
  engineLogs: string[];   // Raw engine audit trail
  metrics: {
    baseline: {
      distance: number;   // km
      time: number;       // minutes
      emissions: number;  // kg CO₂
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
};

// ─────────────────────────────────────────────────────────
// Step 1: Parse stops text → deterministic Node[]
// ─────────────────────────────────────────────────────────

function parseStopsToNodes(stopsInput: string): { nodes: Node[]; depotId: string } {
  const lines = stopsInput
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean);

  if (lines.length === 0) throw new Error("No stops provided.");

  const nodes: Node[] = lines.map((line, i) => {
    const parts = line.split(",").map(p => p.trim());
    const label = parts[0];
    const id = `node_${i}`;

    let x: number, y: number;

    if (parts.length >= 3 && !isNaN(Number(parts[1])) && !isNaN(Number(parts[2]))) {
      x = Math.min(95, Math.max(5, Number(parts[1])));
      y = Math.min(95, Math.max(5, Number(parts[2])));
    } else {
      // Spiral layout — deterministic spread on 100×100 grid
      const angle = (i / Math.max(lines.length, 1)) * 2 * Math.PI;
      const radius = i === 0 ? 0 : 20 + (i % 4) * 12;
      x = +(50 + radius * Math.cos(angle)).toFixed(1);
      y = +(50 + radius * Math.sin(angle)).toFixed(1);
    }

    return {
      id,
      x,
      y,
      type: i === 0 ? "depot" : "stop",
      label,
    } as Node & { label: string };
  });

  return { nodes, depotId: nodes[0].id };
}

// ─────────────────────────────────────────────────────────
// Step 2: Visual context extraction (Gemini visual task)
// ─────────────────────────────────────────────────────────

async function extractDisruptionsFromImage(
  imageBase64: string,
  imageMimeType: string
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
      contents: {
        parts: [
          { inlineData: { data: imageBase64, mimeType: imageMimeType } },
          { text: prompt },
        ],
      },
      config: { responseMimeType: "application/json", temperature: 0 },
    });

    const text = response.text ?? "[]";
    const cleaned = text.replace(/```json|```/g, "").trim();
    return JSON.parse(cleaned) as DisruptionZone[];
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────
// Step 3: Reasoning generation (Gemini explanation task)
// Receives real engine numbers, outputs human narrative only
// ─────────────────────────────────────────────────────────

async function generateReasoningLog(
  nodes: Node[],
  engineResult: EngineResult,
  disruptions: DisruptionZone[]
): Promise<string[]> {
  // Build label lookup
  const labelOf = (id: string) =>
    (nodes.find(n => n.id === id) as any)?.label ?? id;

  const baselinePath = engineResult.baselinePath.map(labelOf).join(" → ");
  const optimizedPath = engineResult.optimizedPath.map(labelOf).join(" → ");
  const { baseline, optimized, improvement } = engineResult.metrics;
  const patterns = engineResult.detectedPatterns;

  const prompt = `
You are the ReasonRoute AI reasoning layer.
The GNOPT math engine has already computed everything. Explain its decisions in plain English.
Reference ONLY the exact figures below. Do not invent numbers.

=== REAL ENGINE OUTPUT ===
Baseline route:  ${baselinePath}
Optimized route: ${optimizedPath}

Baseline:   ${baseline.distance.toFixed(2)} km | ${baseline.time.toFixed(1)} min | ${(baseline.emissions / 1000).toFixed(3)} kg CO₂
Optimized:  ${optimized.distance.toFixed(2)} km | ${optimized.time.toFixed(1)} min | ${(optimized.emissions / 1000).toFixed(3)} kg CO₂
Improvement: Distance ${improvement.distancePct > 0 ? "↓" : "↑"}${Math.abs(improvement.distancePct)}% | Time ${improvement.timePct > 0 ? "↓" : "↑"}${Math.abs(improvement.timePct)}% | Emissions ${improvement.emissionsPct > 0 ? "↓" : "↑"}${Math.abs(improvement.emissionsPct)}%

Structural patterns detected:
${patterns.length > 0 ? patterns.map(p => `  [${p.type}] ${p.description}`).join("\n") : "  None (small/sparse graph)"}

Key engine stages:
${engineResult.engineLogs.slice(1, 7).map(l => `  ${l}`).join("\n")}
${disruptions.length > 0 ? `\nVisual disruptions from uploaded image:\n${disruptions.map(d => `  - ${d.description}`).join("\n")}` : ""}
=== END DATA ===

Write 4–6 reasoning log entries as a JSON array of strings.
Format each as: "[00] Stage name: explanation."
Use logistics terminology. Final entry must state the net improvement with exact numbers.
Output ONLY the JSON array.
`;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: { parts: [{ text: prompt }] },
      config: { responseMimeType: "application/json", temperature: 0.2 },
    });

    const text = response.text ?? "[]";
    const cleaned = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // Safe fallback: format engine logs as reasoning entries
    return engineResult.engineLogs.slice(1, 7).map((log, i) => {
      const n = String(i).padStart(2, "0");
      return `[${n}] ${log.replace(/^\[[^\]]+\]\s*/, "")}`;
    });
  }
}

// ─────────────────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────────────────

export const optimizeRoute = async (
  stopsInput: string,
  contextImageBase64?: string,
  contextImageMimeType?: string,
  preferences?: {
    weightTime?: number;
    weightEmissions?: number;
    weightDistance?: number;
  }
): Promise<OptimizationResult> => {

  // 1. Parse stops deterministically
  const { nodes, depotId } = parseStopsToNodes(stopsInput);

  // 2. Extract disruptions from image (Gemini visual role)
  let disruptions: DisruptionZone[] = [];
  let heatmapForEngine: number[][] | undefined;

  if (contextImageBase64 && contextImageMimeType) {
    disruptions = await extractDisruptionsFromImage(contextImageBase64, contextImageMimeType);

    // Convert disruptions → heatmap grid for the engine
    if (disruptions.length > 0) {
      const grid: number[][] = Array.from({ length: 100 }, () =>
        new Array(100).fill(0)
      );
      for (const zone of disruptions) {
        const cx = Math.round(Math.min(99, Math.max(0, zone.x)));
        const cy = Math.round(Math.min(99, Math.max(0, zone.y)));
        const r = Math.max(1, Math.min(30, zone.radius));
        for (let dx = -r; dx <= r; dx++) {
          for (let dy = -r; dy <= r; dy++) {
            const nx = cx + dx, ny = cy + dy;
            if (nx >= 0 && nx < 100 && ny >= 0 && ny < 100) {
              const severity = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) / r) * 0.9;
              grid[nx][ny] = Math.max(grid[nx][ny], severity);
            }
          }
        }
      }
      heatmapForEngine = grid;
    }
  }

  // 3. Run deterministic GNOPT math engine
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
  };

  const engineResult = runReasonRouteEngine(engineInput);

  // 4. Gemini explains the engine's decisions (no math, only narrative)
  const reasoningLog = await generateReasoningLog(nodes, engineResult, disruptions);

  // 5. Return — emissions converted grams → kg for UI
  const toKg = (g: number) => +(g / 1000).toFixed(3);

  return {
    nodes,
    baselinePath: engineResult.baselinePath,
    optimizedPath: engineResult.optimizedPath,
    disruptions,
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