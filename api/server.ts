import express from 'express';
import cors from 'cors';
import { ensureLocalEnvLoaded } from '../services/env';
import { getAiConfigStatus, optimizeRoute } from '../services/geminiService';
import { getRoutingConfigStatus, routePathOnRoads } from '../services/roadRoutingService';
import {
  AppConfigStatus,
  FleetComparison,
  FleetConfig,
  FleetRoutePlan,
  Geofence,
  Metrics,
  Node,
  OptimizationResult,
  RouteDiagnostics,
  RouteSummary,
  RoutedRoad,
} from '../types';

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

function longestLegKm(road?: RoutedRoad | null): number {
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

function normalizeFleetConfig(result: OptimizationResult): FleetConfig {
  const routeCount = Math.max(result.optimizedRoutes?.length ?? 0, result.baselineRoutes?.length ?? 0, result.fleetConfig?.vehicleCount ?? 0, 1);
  const vehicleLabels = Array.from({ length: routeCount }, (_, index) => result.fleetConfig?.vehicleLabels?.[index] ?? `Vehicle ${index + 1}`);
  return {
    vehicleCount: routeCount,
    vehicleLabels,
  };
}

function buildRouteSummary(path: string[], nodeMap: Map<string, OptimizationResult['nodes'][number]>, road?: RoutedRoad | null): RouteSummary {
  const stopIds = path.filter((id, index) => index !== 0 && index !== path.length - 1);
  return {
    totalLegs: Math.max(0, path.length - 1),
    stopCount: stopIds.length,
    firstStopLabel: labelOf(nodeMap, stopIds[0]),
    lastStopLabel: labelOf(nodeMap, stopIds[stopIds.length - 1]),
    longestLegKm: longestLegKm(road),
  };
}

function routeMetrics(road?: RoutedRoad | null): Metrics {
  if (!road) return { distance: 0, time: 0, emissions: 0 };
  return {
    distance: road.distanceKm,
    time: road.durationMin,
    emissions: computeRoadEmissions(road.distanceKm, road.durationMin),
  };
}

function buildFleetRoutePlan(
  path: string[],
  vehicleIndex: number,
  vehicleLabel: string,
  nodeMap: Map<string, OptimizationResult['nodes'][number]>,
  road?: RoutedRoad | null
): FleetRoutePlan {
  return {
    routeId: `vehicle_${vehicleIndex + 1}`,
    vehicleIndex,
    vehicleLabel,
    path,
    road: road ?? null,
    metrics: routeMetrics(road),
    summary: buildRouteSummary(path, nodeMap, road),
    warnings: road?.warnings ?? [],
  };
}

async function buildFleetRoutePlans(
  nodes: Node[],
  paths: string[][],
  geofences: Geofence[],
  fleetConfig: FleetConfig
): Promise<FleetRoutePlan[]> {
  const nodeMap = new Map(nodes.map(node => [node.id, node]));
  const roads = await Promise.all(paths.map(path => routePathOnRoads(nodes, path, geofences)));
  return paths.map((path, index) =>
    buildFleetRoutePlan(path, index, fleetConfig.vehicleLabels?.[index] ?? `Vehicle ${index + 1}`, nodeMap, roads[index])
  );
}

function aggregateRouteMetrics(routes: FleetRoutePlan[]): Metrics {
  return routes.reduce(
    (totals, route) => ({
      distance: +(totals.distance + route.metrics.distance).toFixed(2),
      time: +(totals.time + route.metrics.time).toFixed(1),
      emissions: +(totals.emissions + route.metrics.emissions).toFixed(3),
    }),
    { distance: 0, time: 0, emissions: 0 }
  );
}

function buildComparison(baseline: Metrics, optimized: Metrics): FleetComparison {
  const improvement = buildImprovement(baseline, optimized);
  if (improvement.timePct > 0 || (improvement.timePct === 0 && (improvement.distancePct > 0 || improvement.emissionsPct > 0))) {
    return {
      status: 'improved',
      headline: 'Fleet plan improved',
      detail: `Time ${improvement.timePct}% better, distance ${improvement.distancePct}% better, emissions ${improvement.emissionsPct}% better.`,
    };
  }
  if (improvement.timePct < 0) {
    return {
      status: 'worsened',
      headline: 'Fleet plan worsened',
      detail: `Road-level traffic evaluation erased the ordering gain. Time moved ${Math.abs(improvement.timePct)}% in the wrong direction.`,
    };
  }
  return {
    status: 'mixed',
    headline: 'Fleet result is mixed',
    detail: `Some fleet metrics improved while others stayed flat or regressed. Time ${improvement.timePct}%, distance ${improvement.distancePct}%, emissions ${improvement.emissionsPct}%.`,
  };
}

function buildDiagnostics(result: OptimizationResult): RouteDiagnostics {
  const allRoads = [...(result.baselineRoutes ?? []), ...(result.optimizedRoutes ?? [])]
    .map(route => route.road)
    .filter((road): road is RoutedRoad => Boolean(road));
  const fallbackLegCount = allRoads.reduce((sum, road) => sum + (road.fallbackLegCount ?? 0), 0);
  const cacheStatuses = allRoads.map(road => road.cacheStatus).filter(Boolean);
  const cacheStatus =
    cacheStatuses.length === 0
      ? 'none'
      : cacheStatuses.every(status => status === 'hit')
        ? 'hit'
        : cacheStatuses.every(status => status === 'miss')
          ? 'miss'
          : 'mixed';
  const providers = new Set(allRoads.map(road => road.source));
  const primaryProvider = providers.has('mapbox') ? 'mapbox' : providers.has('osrm') ? 'osrm' : result.coordinateMode === 'geo' ? 'synthetic' : 'demo';
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
        ? allRoads.some(road => road.source === 'synthetic')
          ? 'synthetic_fallback'
          : 'partial_fallback'
        : 'full_osrm';

  return {
    routingStatus,
    fallbackLegCount,
    cacheStatus,
    geofenceImpact,
    provider: primaryProvider,
    trafficMode: allRoads.some(road => road.source === 'mapbox') ? 'historical_or_live' : 'freeflow',
    warnings: [...new Set(allRoads.flatMap(road => road.warnings ?? []))],
  };
}

function fleetGeojsonFeatures(result: OptimizationResult) {
  const features: any[] = [];
  const pushRouteFeature = (route: FleetRoutePlan, collection: 'baseline' | 'optimized') => {
    const label = `${collection}:${route.vehicleLabel}`;
    if (route.road?.coordinates?.length) {
      features.push({
        type: 'Feature',
        properties: {
          label,
          collection,
          vehicleLabel: route.vehicleLabel,
          vehicleIndex: route.vehicleIndex,
          routeId: route.routeId,
          source: route.road.source,
        },
        geometry: {
          type: 'LineString',
          coordinates: route.road.coordinates.map(([lat, lng]) => [lng, lat]),
        },
      });
      return;
    }

    const nodeMap = new Map(result.nodes.map(node => [node.id, node]));
    features.push({
      type: 'Feature',
      properties: {
        label,
        collection,
        vehicleLabel: route.vehicleLabel,
        vehicleIndex: route.vehicleIndex,
        routeId: route.routeId,
        source: 'node-order',
      },
      geometry: {
        type: 'LineString',
        coordinates: route.path
          .map(id => nodeMap.get(id))
          .filter(Boolean)
          .map(node =>
            result.coordinateMode === 'geo' && typeof node!.lat === 'number' && typeof node!.lng === 'number'
              ? [node!.lng, node!.lat]
              : [node!.x, node!.y]
          ),
      },
    });
  };

  result.baselineRoutes.forEach(route => pushRouteFeature(route, 'baseline'));
  result.optimizedRoutes.forEach(route => pushRouteFeature(route, 'optimized'));
  return features;
}

async function applyRoadRouting(result: OptimizationResult, geofences: Geofence[] = []): Promise<OptimizationResult> {
  const fleetConfig = normalizeFleetConfig(result);
  const baselinePaths = result.baselineRoutes?.length ? result.baselineRoutes.map(route => route.path) : [result.baselinePath];
  const optimizedPaths = result.optimizedRoutes?.length ? result.optimizedRoutes.map(route => route.path) : [result.aiOptimizedPath ?? result.optimizedPath];

  if (result.coordinateMode !== 'geo') {
    const nodeMap = new Map(result.nodes.map(node => [node.id, node]));
    const baselineRoutes = baselinePaths.map((path, index) =>
      buildFleetRoutePlan(path, index, fleetConfig.vehicleLabels?.[index] ?? `Vehicle ${index + 1}`, nodeMap, null)
    );
    const optimizedRoutes = optimizedPaths.map((path, index) =>
      buildFleetRoutePlan(path, index, fleetConfig.vehicleLabels?.[index] ?? `Vehicle ${index + 1}`, nodeMap, null)
    );
    const baselineMetrics = aggregateRouteMetrics(baselineRoutes);
    const optimizedMetrics = aggregateRouteMetrics(optimizedRoutes);
    const next = {
      ...result,
      fleetConfig,
      geofences,
      baselineRoutes,
      optimizedRoutes,
      metrics: {
        baseline: baselineMetrics,
        optimized: optimizedMetrics,
        improvement: buildImprovement(baselineMetrics, optimizedMetrics),
      },
      comparison: buildComparison(baselineMetrics, optimizedMetrics),
    };
    return {
      ...next,
      diagnostics: buildDiagnostics(next),
      baselineRoad: baselineRoutes[0]?.road ?? null,
      optimizedRoad: optimizedRoutes[0]?.road ?? null,
      routeWarnings: next.diagnostics?.warnings ?? [],
    };
  }

  const baselineRoutes = await buildFleetRoutePlans(result.nodes as Node[], baselinePaths, geofences, fleetConfig);
  const optimizedRoutes = await buildFleetRoutePlans(result.nodes as Node[], optimizedPaths, geofences, fleetConfig);
  const baselineMetrics = aggregateRouteMetrics(baselineRoutes);
  const optimizedMetrics = aggregateRouteMetrics(optimizedRoutes);
  const diagnosticsSeed: OptimizationResult = {
    ...result,
    fleetConfig,
    geofences,
    baselineRoutes,
    optimizedRoutes,
    baselineRoad: baselineRoutes[0]?.road ?? null,
    optimizedRoad: optimizedRoutes[0]?.road ?? null,
    metrics: {
      baseline: baselineMetrics,
      optimized: optimizedMetrics,
      improvement: buildImprovement(baselineMetrics, optimizedMetrics),
    },
  };
  const diagnostics = buildDiagnostics(diagnosticsSeed);

  return {
    ...diagnosticsSeed,
    comparison: buildComparison(baselineMetrics, optimizedMetrics),
    diagnostics,
    routeWarnings: diagnostics.warnings,
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
    const { stopsText, stops, images, preferences, optimization, geofences, fleet } = req.body ?? {};

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

    const baseResult = await optimizeRoute(stopsInput, contextImages, preferences, optimization, fleet as FleetConfig | undefined);
    const result = await applyRoadRouting(baseResult as unknown as OptimizationResult, Array.isArray(geofences) ? geofences : []);

    res.json({
      ok: true,
      meta: { generatedAt: new Date().toISOString() },
      result,
      geojson: {
        type: 'FeatureCollection',
        features: fleetGeojsonFeatures(result),
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'Unknown error' });
  }
});

app.post(['/reroute', '/api/reroute'], async (req, res) => {
  try {
    const { result, geofences } = req.body ?? {};
    if (!result || !Array.isArray(result.nodes) || !Array.isArray(result.baselinePath) || !Array.isArray(result.optimizedPath)) {
      return res.status(400).json({ error: 'A prior optimization result payload is required.' });
    }

    const rerouted = await applyRoadRouting(
      result as OptimizationResult,
      Array.isArray(geofences) ? geofences : result.geofences ?? []
    );

    res.json({
      ok: true,
      meta: { generatedAt: new Date().toISOString() },
      result: rerouted,
      geojson: {
        type: 'FeatureCollection',
        features: fleetGeojsonFeatures(rerouted),
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'Unknown error' });
  }
});

app.listen(port, () => {
  console.log(`[reasonroute-api] listening on http://localhost:${port}`);
});
