// geminiService.ts
// ReasonRoute AI — Gemini Integration Layer v4.0
// FIX: heatmap grid built as grid[row=y][col=x] to match getEdgeCost lookup.
//      Previously it was grid[x][y] (transposed), so disruption zones from
//      images were written to wrong cells — engine saw traffic in wrong locations.

import { GoogleGenAI } from "@google/genai";
import { Node } from "./baslineSolver";
import {
  runReasonRouteEngine,
  EngineInput,
  EngineResult,
  CompressionPattern,
} from "./reasonRouteEngine";

// Resolve API key in both Node (CLI) and Vite/browser builds.
// Prefer GEMINI_API_KEY; keep API_KEY/VITE_API_KEY as legacy fallbacks.
const apiKey =
  (typeof process !== "undefined" && process.env
    ? process.env.GEMINI_API_KEY ?? process.env.API_KEY
    : undefined) ??
  (typeof import.meta !== "undefined" && (import.meta as any).env
    ? (import.meta as any).env.VITE_GEMINI_API_KEY ?? (import.meta as any).env.VITE_API_KEY
    : undefined);

const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;
// NOTE: If you see fallback logs in the UI, open DevTools and check for
// "[gemini-error]" entries — they'll surface any auth/CORS/model issues.

// Simple timeout wrapper to avoid indefinite hangs when external calls stall.
async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: () => T | Promise<T>): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>(resolve => setTimeout(() => resolve(fallback()), ms)),
  ]);
}

// ─────────────────────────────────────────────────────────
// Public result type (unchanged)
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
};

// ─────────────────────────────────────────────────────────
// Step 1: Parse stops text → deterministic Node[] (unchanged)
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
    const id    = `node_${i}`;

    let x: number, y: number;

    if (parts.length >= 3 && !isNaN(Number(parts[1])) && !isNaN(Number(parts[2]))) {
      x = Math.min(95, Math.max(5, Number(parts[1])));
      y = Math.min(95, Math.max(5, Number(parts[2])));
    } else {
      const angle  = (i / Math.max(lines.length, 1)) * 2 * Math.PI;
      const radius = i === 0 ? 0 : 20 + (i % 4) * 12;
      x = +(50 + radius * Math.cos(angle)).toFixed(1);
      y = +(50 + radius * Math.sin(angle)).toFixed(1);
    }

    return { id, x, y, type: i === 0 ? "depot" : "stop", label } as Node & { label: string };
  });

  return { nodes, depotId: nodes[0].id };
}

// ─────────────────────────────────────────────────────────
// Step 2: Visual context extraction (unchanged)
// ─────────────────────────────────────────────────────────

async function extractDisruptionsFromImage(
  imageBase64: string,
  imageMimeType: string
): Promise<DisruptionZone[]> {
  if (!ai) return [];

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

    const text    = response.text ?? "[]";
    const cleaned = text.replace(/```json|```/g, "").trim();
    return JSON.parse(cleaned) as DisruptionZone[];
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────
// Step 3: Reasoning generation (unchanged)
// ─────────────────────────────────────────────────────────

async function generateReasoningLog(
  nodes: Node[],
  engineResult: EngineResult,
  disruptions: DisruptionZone[]
): Promise<string[]> {
  const buildLocalLog = () => {
    const { baseline, optimized, improvement } = engineResult.metrics;
    const lines: string[] = [];
    lines.push(
      `[00] Context: ${engineResult.baselinePath.length - 1} legs, ` +
      `${(baseline.distance).toFixed(1)} km base, weights active.`
    );
    lines.push(
      `[01] Baseline: nearest-neighbor + 2-opt scored ${baseline.composite.toFixed(2)} (dist/time/emiss ${baseline.distance.toFixed(1)} km / ${baseline.time.toFixed(1)} min / ${(baseline.emissions/1000).toFixed(2)} kg).`
    );
    if (engineResult.detectedPatterns?.length) {
      lines.push(
        `[02] Patterns: ${engineResult.detectedPatterns.map(p => `${p.type}`).join(", ")} detected; compressed graph explored.`
      );
    } else {
      lines.push(`[02] Patterns: none detected (sparse graph).`);
    }
    lines.push(
      `[03] Optimized: composite ${optimized.composite.toFixed(2)} with detours => ${optimized.distance.toFixed(1)} km, ${optimized.time.toFixed(1)} min, ${(optimized.emissions/1000).toFixed(2)} kg.`
    );
    if (disruptions.length > 0) {
      lines.push(`[04] Image context: ${disruptions.length} disruption zone(s) applied to cost grid.`);
    } else {
      lines.push(`[04] Image context: none applied.`);
    }
    lines.push(
      `[05] Net improvement: dist ${improvement.distancePct}% | time ${improvement.timePct}% | emissions ${improvement.emissionsPct}%.`
    );
    return lines;
  };

  const fallback = () => buildLocalLog();

  if (!ai || !apiKey) return fallback();

  const labelOf = (id: string) => (nodes.find(n => n.id === id) as any)?.label ?? id;

  const baselinePath  = engineResult.baselinePath.map(labelOf).join(" → ");
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
    const response = await withTimeout(
      ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: { parts: [{ text: prompt }] },
        config: { responseMimeType: "application/json", temperature: 0.2 },
      }),
      8000,
      () => ({ text: "[]" } as any)
    );

    const text    = response.text ?? "[]";
    const cleaned = text.replace(/```json|```/g, "").trim();
    const parsed  = JSON.parse(cleaned);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : fallback();
  } catch (err) {
    console.error("[Gemini] reasoning log failed", err);
    return fallback();
  }
}

// ─────────────────────────────────────────────────────────
// Main export (unchanged interface)
// ─────────────────────────────────────────────────────────

type ContextImage = { base64: string; mimeType: string };

export const optimizeRoute = async (
  stopsInput: string,
  contextImages: ContextImage[] = [],
  preferences?: {
    weightTime?: number;
    weightEmissions?: number;
    weightDistance?: number;
  },
  optimization?: { mode?: 'fast' | 'quality'; timeBudgetMs?: number; baselineMode?: 'dynamic' | 'distance' }
): Promise<OptimizationResult> => {

  const { nodes, depotId } = parseStopsToNodes(stopsInput);

  let disruptions: DisruptionZone[] = [];
  let heatmapForEngine: number[][] | undefined;

  if (contextImages.length > 0) {
    const GRID = 100;
    const grid: number[][] = Array.from({ length: GRID }, () => new Array(GRID).fill(0));

    for (const { base64, mimeType } of contextImages) {
      const zones = await extractDisruptionsFromImage(base64, mimeType);
      disruptions.push(...zones);

      for (const zone of zones) {
        const cx = Math.round(Math.min(GRID - 1, Math.max(0, zone.x)));
        const cy = Math.round(Math.min(GRID - 1, Math.max(0, zone.y)));
        const r  = Math.max(1, Math.min(30, zone.radius));

        for (let dx = -r; dx <= r; dx++) {
          for (let dy = -r; dy <= r; dy++) {
            const col = cx + dx;   // x -> column
            const row = cy + dy;   // y -> row
            if (row >= 0 && row < GRID && col >= 0 && col < GRID) {
              const dist     = Math.sqrt(dx * dx + dy * dy);
              const severity = Math.max(0, 1 - dist / r) * 0.9;
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
  // If Gemini is unavailable / timed out, still return deterministic baseline/optimized without disruptions.

  const engineInput: EngineInput = {
    nodes,
    depotId,
    trafficHeatmap:  heatmapForEngine,
    disruptionZones: disruptions,
    preferences: {
      weightTime:      preferences?.weightTime      ?? 0.5,
      weightEmissions: preferences?.weightEmissions ?? 0.3,
      weightDistance:  preferences?.weightDistance  ?? 0.2,
    },
    optimization: {
      mode: optimization?.mode,
      timeBudgetMs: optimization?.timeBudgetMs,
    },
    baselineMode: optimization?.baselineMode,
  };

  const engineResult = runReasonRouteEngine(engineInput);
  const reasoningLog = await generateReasoningLog(nodes, engineResult, disruptions);

  const toKg = (g: number) => +(g / 1000).toFixed(3);

  return {
    nodes,
    baselinePath:    engineResult.baselinePath,
    optimizedPath:   engineResult.optimizedPath,
    disruptions,
    logs:            reasoningLog,
    engineLogs:      engineResult.engineLogs,
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
    detectedPatterns: engineResult.detectedPatterns,
  };
};
