import express from 'express';
import cors from 'cors';
import { ensureLocalEnvLoaded } from '../services/env';
import { getAiConfigStatus, optimizeRoute } from '../services/geminiService';
import { getRoutingConfigStatus, routePathOnRoads } from '../services/roadRoutingService';
import { AppConfigStatus, Geofence, Metrics, Node, OptimizationResult } from '../types';

type ImagePayload = { base64: string; mimeType: string };

ensureLocalEnvLoaded();

const app = express();
app.use(cors());
app.use(express.json({ limit: '12mb' }));

const port = process.env.PORT ? Number(process.env.PORT) : 8788;

function toStopsText(stops: any[]): string {
  return stops
    .map(stop => {
      if (typeof stop === 'string') return stop;
      const label = stop?.label ?? stop?.name ?? stop?.id ?? 'Stop';
      if (typeof stop?.lat === 'number' && typeof stop?.lng === 'number') {
        return `${label}, ${stop.lat}, ${stop.lng}`;
      }
      if (typeof stop?.x === 'number' && typeof stop?.y === 'number') {
        return `${label}, ${stop.x}, ${stop.y}`;
      }
      return String(label);
    })
    .join('\n');
}

function buildImprovement(baseline: Metrics, optimized: Metrics) {
  const pct = (base: number, next: number) => (base > 0 ? +(((base - next) / base) * 100).toFixed(1) : 0);
  return {
    distancePct: pct(baseline.distance, optimized.distance),
    timePct: pct(baseline.time, optimized.time),
    emissionsPct: pct(baseline.emissions, optimized.emissions),
  };
}

function computeRoadEmissions(distanceKm: number, durationMin: number): number {
  const freeflowMinutes = distanceKm > 0 ? (distanceKm / 35) * 60 : 0;
  const congestionPenaltyKg = Math.max(0, durationMin - freeflowMinutes) * 0.015;
  return +(distanceKm * 0.12 + congestionPenaltyKg).toFixed(3);
}

function labelOf(nodeMap: Map<string, OptimizationResult['nodes'][number]>, id?: string): string {
  return id ? nodeMap.get(id)?.label ?? id : 'N/A';
}

function longestLegKm(road?: OptimizationResult['optimizedRoad'] | OptimizationResult['baselineRoad']): number {
  if (!road || road.coordinates.length < 2) return 0;
  let longest = 0;
  for (let i = 0; i < road.coordinates.length - 1; i += 1) {
    const [lat1, lng1] = road.coordinates[i];
    const [lat2, lng2] = road.coordinates[i + 1];
    const dx = lat2 - lat1;
    const dy = lng2 - lng1;
    longest = Math.max(longest, Math.sqrt(dx * dx + dy * dy) * 111);
  }
  return +longest.toFixed(1);
}

function buildRouteSummary(result: OptimizationResult): OptimizationResult['routeSummary'] {
  const nodeMap = new Map(result.nodes.map(node => [node.id, node]));
  const activePath = result.optimizedPath;
  const stopIds = activePath.filter((id, index) => index !== 0 && index !== activePath.length - 1);
  const selectedLegIndex = result.routeFocus?.selectedLegIndex ?? undefined;
  return {
    totalLegs: Math.max(0, activePath.length - 1),
    firstStopLabel: labelOf(nodeMap, stopIds[0]),
    lastStopLabel: labelOf(nodeMap, stopIds[stopIds.length - 1]),
    longestLegKm: longestLegKm(result.optimizedRoad ?? result.baselineRoad),
    selectedStopEtaMin:
      selectedLegIndex !== undefined && result.optimizedRoad
        ? +((result.optimizedRoad.durationMin / Math.max(result.optimizedPath.length - 1, 1)) * (selectedLegIndex + 1)).toFixed(1)
        : undefined,
  };
}

function buildDiagnostics(result: OptimizationResult): OptimizationResult['diagnostics'] {
  const fallbackLegCount = (result.optimizedRoad?.fallbackLegCount ?? 0) + (result.baselineRoad?.fallbackLegCount ?? 0);
  const cacheStatuses = [result.baselineRoad?.cacheStatus, result.optimizedRoad?.cacheStatus].filter(Boolean);
  const cacheStatus =
    cacheStatuses.length === 0
      ? 'none'
      : cacheStatuses.every(status => status === 'hit')
        ? 'hit'
        : cacheStatuses.every(status => status === 'miss')
          ? 'miss'
          : 'mixed';
  const geofenceImpact =
    result.geofences?.length
      ? fallbackLegCount > 0
        ? 'blocked_fallback'
        : 'detoured'
      : 'none';
  const routingStatus =
    result.coordinateMode !== 'geo'
      ? 'demo_mode'
      : fallbackLegCount > 0
        ? result.optimizedRoad?.source === 'synthetic'
          ? 'synthetic_fallback'
          : 'partial_fallback'
        : 'full_osrm';

  return {
    routingStatus,
    fallbackLegCount,
    cacheStatus,
    geofenceImpact,
    provider:
      result.coordinateMode !== 'geo'
        ? 'demo'
        : result.optimizedRoad?.source ?? result.baselineRoad?.source ?? 'synthetic',
    trafficMode:
      result.coordinateMode !== 'geo'
        ? 'freeflow'
        : result.optimizedRoad?.source === 'mapbox' || result.baselineRoad?.source === 'mapbox'
          ? 'historical_or_live'
          : 'freeflow',
    warnings: [...(result.routeWarnings ?? [])],
  };
}

function routeGeojsonFeature(
  result: OptimizationResult,
  roadKey: 'baselineRoad' | 'optimizedRoad',
  pathKey: 'baselinePath' | 'optimizedPath',
  label: string
) {
  const road = result[roadKey];
  if (road?.coordinates?.length) {
    return {
      type: 'Feature',
      properties: { label, source: road.source },
      geometry: {
        type: 'LineString',
        coordinates: road.coordinates.map(([lat, lng]) => [lng, lat]),
      },
    };
  }

  const nodeMap = new Map(result.nodes.map(node => [node.id, node]));
  return {
    type: 'Feature',
    properties: { label, source: 'node-order' },
    geometry: {
      type: 'LineString',
      coordinates: result[pathKey]
        .map(id => nodeMap.get(id))
        .filter(Boolean)
        .map(node =>
          result.coordinateMode === 'geo' && typeof node!.lat === 'number' && typeof node!.lng === 'number'
            ? [node!.lng, node!.lat]
            : [node!.x, node!.y]
        ),
    },
  };
}

async function applyRoadRouting(
  result: OptimizationResult,
  geofences: Geofence[] = [],
  manualRouteOrder?: string[]
): Promise<OptimizationResult> {
  if (result.coordinateMode !== 'geo') {
    const next = {
      ...result,
      geofences,
      manualRouteOrder,
      overrideMode: manualRouteOrder?.length ? 'manual_order' : 'none',
      activeRouteLabel: manualRouteOrder?.length ? 'manual' : 'optimized',
      aiOptimizedPath: result.aiOptimizedPath ?? result.optimizedPath,
    } as OptimizationResult;
    return {
      ...next,
      routeSummary: buildRouteSummary(next),
      diagnostics: buildDiagnostics(next),
    };
  }

  const aiOptimizedPath = result.aiOptimizedPath ?? result.optimizedPath;
  const activePath = manualRouteOrder?.length ? manualRouteOrder : aiOptimizedPath;
  const baselineRoad = await routePathOnRoads(result.nodes as Node[], result.baselinePath, []);
  const optimizedRoad = await routePathOnRoads(result.nodes as Node[], activePath, geofences);

  const baselineMetrics: Metrics = baselineRoad
    ? {
        distance: baselineRoad.distanceKm,
        time: baselineRoad.durationMin,
        emissions: computeRoadEmissions(baselineRoad.distanceKm, baselineRoad.durationMin),
      }
    : result.metrics.baseline;

  const optimizedMetrics: Metrics = optimizedRoad
    ? {
        distance: optimizedRoad.distanceKm,
        time: optimizedRoad.durationMin,
        emissions: computeRoadEmissions(optimizedRoad.distanceKm, optimizedRoad.durationMin),
      }
    : result.metrics.optimized;

  const routeWarnings = [
    ...(baselineRoad?.warnings ?? []),
    ...(optimizedRoad?.warnings ?? []),
  ];

  const logs = [...result.logs];
  const roadBlockCount = geofences.filter(geofence => geofence.kind === 'road_block').length;
  if (manualRouteOrder?.length) {
    logs.unshift('[00] Dispatcher override active: the stop order was manually adjusted and re-routed on real roads.');
  } else if (geofences.length > 0) {
    logs.unshift(
      roadBlockCount === geofences.length
        ? `[00] Route updated with ${roadBlockCount} dispatcher road block${roadBlockCount === 1 ? '' : 's'} and recalculated on real roads.`
        : `[00] Route updated with ${geofences.length} dispatcher geofence${geofences.length === 1 ? '' : 's'} and recalculated on real roads.`
    );
  }

  const next: OptimizationResult = {
    ...result,
    aiOptimizedPath,
    optimizedPath: activePath,
    geofences,
    manualRouteOrder,
    overrideMode: manualRouteOrder?.length ? 'manual_order' : 'none',
    activeRouteLabel: manualRouteOrder?.length ? 'manual' : 'optimized',
    baselineRoad,
    optimizedRoad,
    routeWarnings,
    logs,
    metrics: {
      baseline: baselineMetrics,
      optimized: optimizedMetrics,
      improvement: buildImprovement(baselineMetrics, optimizedMetrics),
    },
  };

  return {
    ...next,
    routeSummary: buildRouteSummary(next),
    diagnostics: buildDiagnostics(next),
  };
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.get(['/config', '/api/config'], (_req, res) => {
  const routing = getRoutingConfigStatus();
  const ai = getAiConfigStatus();
  const notes: string[] = [];

  if (routing.routingProvider === 'mapbox' && routing.trafficModeReady) {
    notes.push('Traffic mode ready: Mapbox traffic routing is configured.');
  } else {
    notes.push('OSRM fallback active: traffic-aware routing is not fully configured yet.');
  }
  if (!ai.geminiConfigured) {
    notes.push('Gemini API key is missing, so AI-generated reasoning and image disruption extraction are disabled.');
  }
  if (routing.routingProvider === 'mapbox' && routing.departAtConfigured && !routing.departAtValid) {
    notes.push('MAPBOX_DEPART_AT is set but invalid or in the past, so live traffic routing is being used instead.');
  } else if (routing.routingProvider === 'mapbox' && !routing.historicalReplayReady) {
    notes.push('Historical replay is optional. Set MAPBOX_DEPART_AT to test a future dispatch window.');
  }

  const payload: AppConfigStatus = {
    ready: routing.trafficModeReady && ai.geminiConfigured,
    routingProvider: routing.routingProvider,
    trafficModeReady: routing.trafficModeReady,
    mapboxConfigured: routing.mapboxConfigured,
    geminiConfigured: ai.geminiConfigured,
    historicalReplayReady: routing.historicalReplayReady,
    notes,
  };

  res.json(payload);
});

app.post(['/optimize', '/api/optimize'], async (req, res) => {
  try {
    const { stopsText, stops, images, preferences, optimization, geofences } = req.body ?? {};

    let stopsInput: string | undefined = typeof stopsText === 'string' && stopsText.trim() ? stopsText : undefined;
    if (!stopsInput && Array.isArray(stops)) {
      stopsInput = toStopsText(stops);
    }

    if (!stopsInput) {
      return res.status(400).json({ error: 'stopsText or stops array is required' });
    }

    const contextImages: ImagePayload[] = Array.isArray(images)
      ? images
          .filter(
            (img: any) =>
              img &&
              typeof img.base64 === 'string' &&
              img.base64.trim().length > 0 &&
              typeof img.mimeType === 'string'
          )
          .map((img: any) => ({ base64: img.base64, mimeType: img.mimeType }))
      : [];

    const baseResult = await optimizeRoute(stopsInput, contextImages, preferences, optimization);
    const result = await applyRoadRouting(baseResult as unknown as OptimizationResult, Array.isArray(geofences) ? geofences : []);

    const geojson = {
      type: 'FeatureCollection',
      features: [
        routeGeojsonFeature(result, 'baselineRoad', 'baselinePath', 'baseline'),
        routeGeojsonFeature(result, 'optimizedRoad', 'optimizedPath', result.activeRouteLabel === 'manual' ? 'manual' : 'optimized'),
      ],
    };

    res.json({
      ok: true,
      meta: { generatedAt: new Date().toISOString() },
      result,
      geojson,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'Unknown error' });
  }
});

app.post(['/reroute', '/api/reroute'], async (req, res) => {
  try {
    const { result, geofences, manualRouteOrder } = req.body ?? {};
    if (!result || !Array.isArray(result.nodes) || !Array.isArray(result.baselinePath) || !Array.isArray(result.optimizedPath)) {
      return res.status(400).json({ error: 'A prior optimization result payload is required.' });
    }

    const rerouted = await applyRoadRouting(
      result as OptimizationResult,
      Array.isArray(geofences) ? geofences : result.geofences ?? [],
      Array.isArray(manualRouteOrder) ? manualRouteOrder : undefined
    );

    const geojson = {
      type: 'FeatureCollection',
      features: [
        routeGeojsonFeature(rerouted, 'baselineRoad', 'baselinePath', 'baseline'),
        routeGeojsonFeature(rerouted, 'optimizedRoad', 'optimizedPath', rerouted.activeRouteLabel === 'manual' ? 'manual' : 'optimized'),
      ],
    };

    res.json({
      ok: true,
      meta: { generatedAt: new Date().toISOString() },
      result: rerouted,
      geojson,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'Unknown error' });
  }
});

app.listen(port, () => {
  console.log(`[reasonroute-api] listening on http://localhost:${port}`);
});

