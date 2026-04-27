import express from 'express';
import cors from 'cors';
import { ensureLocalEnvLoaded } from '../services/env';
import { getAiConfigStatus, optimizeRoute } from '../services/geminiService';
import { getRoutingConfigStatus, routePathOnRoads } from '../services/roadRoutingService';
import {
  AdjustmentRequest,
  AppConfigStatus,
  DecisionSummary,
  FleetComparison,
  FleetConfig,
  FleetRoutePlan,
  Geofence,
  Metrics,
  Node,
  OptimizationResult,
  PlanningInputs,
  OverrideDelta,
  ProposalSnapshot,
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

function sanitizeReasoningLine(line: string): string {
  return line.replace(/^\[\d+\]\s*/, '').trim();
}

function validateStopsText(stopsText: string) {
  const errors: string[] = [];
  const warnings: string[] = [];
  const lines = stopsText
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    errors.push('Provide at least one depot row and one delivery stop.');
    return { errors, warnings };
  }

  const firstParts = lines[0].split(',').map(part => part.trim());
  if (firstParts.length < 3) {
    errors.push('The first row should include a depot label and two coordinates.');
  }
  if (firstParts[0] && !/(depot|warehouse|hub)/i.test(firstParts[0])) {
    warnings.push('The first row does not look like a depot or warehouse label. Confirm the depot is listed first.');
  }

  const seenLabels = new Set<string>();
  let geoRows = 0;

  for (const [index, line] of lines.entries()) {
    const parts = line.split(',').map(part => part.trim());
    const label = parts[0];
    if (!label) {
      errors.push(`Row ${index + 1} is missing a stop label.`);
      continue;
    }

    const normalizedLabel = label.toLowerCase();
    if (seenLabels.has(normalizedLabel)) {
      warnings.push(`Duplicate stop label detected: ${label}.`);
    } else {
      seenLabels.add(normalizedLabel);
    }

    if (parts.length >= 3) {
      const a = Number(parts[1]);
      const b = Number(parts[2]);
      if (!Number.isFinite(a) || !Number.isFinite(b)) {
        errors.push(`Row ${index + 1} has invalid coordinates.`);
      } else {
        geoRows += 1;
        const looksGeo = Math.abs(a) <= 90 && Math.abs(b) <= 180;
        const looksDemo = Math.abs(a) <= 100 && Math.abs(b) <= 100;
        if (!looksGeo && !looksDemo) {
          warnings.push(`Row ${index + 1} has unusual coordinate values.`);
        }
      }
    } else {
      warnings.push(`Row ${index + 1} is missing full coordinate data.`);
    }
  }

  if (geoRows < 2) {
    errors.push('At least two rows need valid coordinates for pilot routing.');
  }

  return { errors, warnings };
}

function routeHeadline(result: OptimizationResult): string {
  switch (result.decisionStatus) {
    case 'approved':
      return 'Proposal approved for dispatch';
    case 'updated_proposal':
      return 'Updated proposal is ready for review';
    case 'adjustment_requested':
      return 'Adjustment request is being evaluated';
    case 'proposed':
    default:
      return 'Route proposal is ready for review';
  }
}

function buildOverrideDelta(previousProposal: ProposalSnapshot | undefined, nextMetrics: OptimizationResult['metrics']['optimized']): OverrideDelta | undefined {
  if (!previousProposal) return undefined;
  const prev = previousProposal.metrics.optimized;
  const timeMin = +(nextMetrics.time - prev.time).toFixed(1);
  const distanceKm = +(nextMetrics.distance - prev.distance).toFixed(2);
  const emissionsKg = +(nextMetrics.emissions - prev.emissions).toFixed(3);
  const estimatedFuelCost = +(distanceKm * 0.72).toFixed(2);
  const improving = timeMin <= 0 && distanceKm <= 0 && emissionsKg <= 0;
  const worsening = timeMin >= 0 && distanceKm >= 0 && emissionsKg >= 0;
  const direction: OverrideDelta['direction'] =
    Math.abs(timeMin) < 0.1 && Math.abs(distanceKm) < 0.05 && Math.abs(emissionsKg) < 0.01
      ? 'flat'
      : improving
        ? 'better'
        : worsening
          ? 'worse'
          : 'mixed';
  const timePhrase = `${timeMin >= 0 ? '+' : ''}${timeMin.toFixed(1)} min`;
  const distancePhrase = `${distanceKm >= 0 ? '+' : ''}${distanceKm.toFixed(2)} km`;
  const costPhrase = `${estimatedFuelCost >= 0 ? '+' : ''}$${Math.abs(estimatedFuelCost).toFixed(2)}`;

  return {
    timeMin,
    distanceKm,
    emissionsKg,
    estimatedFuelCost,
    direction,
    summary:
      direction === 'flat'
        ? 'This adjustment leaves the proposal materially unchanged, so the dispatcher is choosing continuity over a route change.'
        : `Confirming this adjustment changes the plan by ${timePhrase}, ${distancePhrase}, and ${costPhrase} in estimated fuel impact.`,
  };
}

function deriveDecisionEvidence(result: OptimizationResult, adjustmentRequest?: AdjustmentRequest): string[] {
  const evidence = (result.logs ?? []).map(sanitizeReasoningLine).filter(Boolean).slice(0, 3);
  const notes: string[] = [];

  if (adjustmentRequest) {
    notes.push(`Dispatcher negotiation request: ${adjustmentRequest.label}.`);
  }
  if (result.geofences?.length) {
    notes.push(`The proposal avoids ${result.geofences.length} blocked corridor${result.geofences.length === 1 ? '' : 's'} captured on the live map.`);
  }
  if (result.routeWarnings?.length) {
    notes.push(result.routeWarnings[0]);
  }

  return [...notes, ...evidence].slice(0, 4);
}

function buildDriverMessage(result: OptimizationResult, adjustmentRequest?: AdjustmentRequest): string {
  const evidence = deriveDecisionEvidence(result, adjustmentRequest);
  const firstReason = evidence[0] ?? 'ReasonRoute selected the clearest route under current conditions.';
  return `Route update: ${firstReason}`;
}

function buildDecisionSummary(result: OptimizationResult, adjustmentRequest?: AdjustmentRequest): DecisionSummary {
  const comparison = result.comparison;
  const metrics = result.metrics.optimized;
  const fallbackSensitive =
    result.diagnostics?.routingStatus === 'partial_fallback' || result.diagnostics?.routingStatus === 'synthetic_fallback';
  return {
    title: routeHeadline(result),
    summary:
      comparison?.headline === 'Route validated'
        ? `ReasonRoute re-checked the dispatch plan and found no materially better alternative under the current constraints.`
        : fallbackSensitive
          ? `${result.optimizedRoutes.length} route${result.optimizedRoutes.length === 1 ? '' : 's'} selected with fallback-aware road evidence. Distance and emissions remain directional, and ETA should be reviewed alongside routing warnings before dispatch.`
          : `${result.optimizedRoutes.length} route${result.optimizedRoutes.length === 1 ? '' : 's'} selected as the current best dispatch proposal at ${metrics.time.toFixed(1)} min ETA, ${metrics.distance.toFixed(1)} km, and ${metrics.emissions.toFixed(2)} kg CO2.`,
    evidence: deriveDecisionEvidence(result, adjustmentRequest),
    reviewPrompt:
      result.decisionStatus === 'approved'
        ? 'Approved for dispatch.'
        : result.decisionStatus === 'updated_proposal'
          ? 'Review the updated tradeoff below before dispatching or keeping the earlier proposal.'
          : 'Review the proposal, then approve it or request an adjustment.',
    changeLabel: adjustmentRequest?.label,
    overrideDelta: result.overrideDelta,
    driverMessage: result.driverMessage,
  };
}

function snapshotProposal(result: OptimizationResult): ProposalSnapshot {
  return {
    decisionStatus: result.decisionStatus ?? 'proposed',
    comparison: result.comparison,
    metrics: result.metrics,
    decisionSummary: result.decisionSummary,
    adjustmentRequest: result.adjustmentRequest,
    overrideDelta: result.overrideDelta,
    driverMessage: result.driverMessage,
  };
}

function withDecisionSummary(
  result: OptimizationResult,
  options: {
    decisionStatus?: OptimizationResult['decisionStatus'];
    adjustmentRequest?: AdjustmentRequest;
    previousProposal?: ProposalSnapshot;
    overrideDelta?: OverrideDelta;
    driverMessage?: string;
  } = {}
): OptimizationResult {
  const overrideDelta = options.overrideDelta ?? (options.previousProposal ? buildOverrideDelta(options.previousProposal, result.metrics.optimized) : result.overrideDelta);
  const driverMessage = options.driverMessage ?? buildDriverMessage({ ...result, overrideDelta }, options.adjustmentRequest);
  const next: OptimizationResult = {
    ...result,
    decisionStatus: options.decisionStatus ?? result.decisionStatus ?? 'proposed',
    adjustmentRequest: options.adjustmentRequest,
    previousProposal: options.previousProposal ?? result.previousProposal,
    overrideDelta,
    driverMessage,
  };
  return {
    ...next,
    decisionSummary: buildDecisionSummary(next, options.adjustmentRequest),
  };
}

function normalizePlanningInputs(result: OptimizationResult): PlanningInputs | undefined {
  if (result.planningInputs?.stopsText?.trim()) {
    return result.planningInputs;
  }
  if (!Array.isArray(result.nodes) || result.nodes.length === 0) return undefined;
  return {
    stopsText: toStopsText(result.nodes),
    preferences: undefined,
    optimization: undefined,
    fleet: result.fleetConfig,
  };
}

function applyAdjustmentToInputs(inputs: PlanningInputs, adjustmentRequest: AdjustmentRequest): PlanningInputs {
  const currentPreferences = inputs.preferences ?? {};
  const currentOptimization = inputs.optimization ?? {};

  switch (adjustmentRequest.type) {
    case 'prioritize_eta':
      return {
        ...inputs,
        preferences: { weightTime: 0.8, weightDistance: 0.1, weightEmissions: 0.1 },
        optimization: {
          ...currentOptimization,
          mode: 'quality',
          timeBudgetMs: Math.max(currentOptimization.timeBudgetMs ?? 40, 120),
        },
      };
    case 're_evaluate':
      return {
        ...inputs,
        preferences: {
          weightTime: currentPreferences.weightTime ?? 0.55,
          weightDistance: currentPreferences.weightDistance ?? 0.25,
          weightEmissions: currentPreferences.weightEmissions ?? 0.2,
        },
        optimization: {
          ...currentOptimization,
          mode: 'quality',
          timeBudgetMs: Math.max(currentOptimization.timeBudgetMs ?? 40, 180),
        },
      };
    case 'simplify_route':
      return {
        ...inputs,
        preferences: { weightTime: 0.45, weightDistance: 0.4, weightEmissions: 0.15 },
        optimization: {
          ...currentOptimization,
          mode: 'quality',
          timeBudgetMs: Math.max(currentOptimization.timeBudgetMs ?? 40, 100),
        },
      };
    case 'avoid_blocked_corridor':
    default:
      return inputs;
  }
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
  if (
    Math.abs(improvement.timePct) < 0.1 &&
    Math.abs(improvement.distancePct) < 0.1 &&
    Math.abs(improvement.emissionsPct) < 0.1
  ) {
    return {
      status: 'validated',
      headline: 'Route validated',
      detail: 'No materially better alternative was found under the current constraints.',
    };
  }
  if (improvement.timePct > 0 || (improvement.timePct === 0 && (improvement.distancePct > 0 || improvement.emissionsPct > 0))) {
    return {
      status: 'improved',
      headline: 'Proposed route outperformed the baseline',
      detail: `Time ${improvement.timePct}% better, distance ${improvement.distancePct}% better, emissions ${improvement.emissionsPct}% better.`,
    };
  }
  if (improvement.timePct < 0) {
    return {
      status: 'worsened',
      headline: 'Route needs dispatcher review',
      detail: `Road-level traffic evaluation weakened the initial gain. Time moved ${Math.abs(improvement.timePct)}% in the wrong direction.`,
    };
  }
  return {
    status: 'mixed',
    headline: 'Route trade-offs are balanced',
    detail: `Some metrics improved while others stayed flat. Time ${improvement.timePct}%, distance ${improvement.distancePct}%, emissions ${improvement.emissionsPct}%.`,
  };
}

function softenComparisonForFallback(comparison: FleetComparison, diagnostics: RouteDiagnostics): FleetComparison {
  if (diagnostics.fallbackLegCount === 0) return comparison;
  if (comparison.status === 'validated') {
    return {
      ...comparison,
      detail: `${comparison.detail} ETA confidence is reduced because some road legs used fallback routing.`,
    };
  }
  return {
    ...comparison,
    detail: `${comparison.detail} ETA confidence is softened because ${diagnostics.fallbackLegCount} leg${diagnostics.fallbackLegCount === 1 ? '' : 's'} used fallback road routing.`,
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
    optimizationTimeMs: result.optimizationTimeMs,
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

async function applyRoadRouting(
  result: OptimizationResult,
  geofences: Geofence[] = [],
  adjustmentRequest?: AdjustmentRequest,
  previousProposal?: ProposalSnapshot
): Promise<OptimizationResult> {
  const fleetConfig = normalizeFleetConfig(result);
  const baselinePaths = result.baselineRoutes?.length ? result.baselineRoutes.map(route => route.path) : [result.baselinePath];
  const optimizedPaths = result.optimizedRoutes?.length ? result.optimizedRoutes.map(route => route.path) : [result.aiOptimizedPath ?? result.optimizedPath];
  const roadRoutingStartedAt = Date.now();

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
    const comparison = buildComparison(baselineMetrics, optimizedMetrics);
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
      comparison,
    };
    const diagnostics = buildDiagnostics(next);
    diagnostics.roadRoutingTimeMs = Date.now() - roadRoutingStartedAt;
    diagnostics.totalProcessingTimeMs = (result.optimizationTimeMs ?? 0) + (diagnostics.roadRoutingTimeMs ?? 0);
    diagnostics.dispatcherReady = (diagnostics.totalProcessingTimeMs ?? 0) <= 30_000;
    const previewSeed = {
      ...next,
      comparison: softenComparisonForFallback(comparison, diagnostics),
      diagnostics,
      routeWarnings: diagnostics.warnings,
    };
    const overrideDelta = buildOverrideDelta(previousProposal, previewSeed.metrics.optimized);
    const driverMessage = buildDriverMessage({ ...previewSeed, overrideDelta }, adjustmentRequest);
    return withDecisionSummary({
      ...previewSeed,
      baselineRoad: baselineRoutes[0]?.road ?? null,
      optimizedRoad: optimizedRoutes[0]?.road ?? null,
    }, {
      decisionStatus: adjustmentRequest ? 'updated_proposal' : result.decisionStatus ?? 'proposed',
      adjustmentRequest,
      previousProposal,
      overrideDelta,
      driverMessage,
    });
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
  diagnostics.roadRoutingTimeMs = Date.now() - roadRoutingStartedAt;
  diagnostics.totalProcessingTimeMs = (result.optimizationTimeMs ?? 0) + (diagnostics.roadRoutingTimeMs ?? 0);
  diagnostics.dispatcherReady = (diagnostics.totalProcessingTimeMs ?? 0) <= 30_000;

  const comparison = softenComparisonForFallback(buildComparison(baselineMetrics, optimizedMetrics), diagnostics);
  const previewSeed = {
    ...diagnosticsSeed,
    comparison,
    diagnostics,
    routeWarnings: diagnostics.warnings,
  };
  const overrideDelta = buildOverrideDelta(previousProposal, previewSeed.metrics.optimized);
  const driverMessage = buildDriverMessage({ ...previewSeed, overrideDelta }, adjustmentRequest);

  return withDecisionSummary({
    ...previewSeed,
  }, {
    decisionStatus: adjustmentRequest ? 'updated_proposal' : result.decisionStatus ?? 'proposed',
    adjustmentRequest,
    previousProposal,
    overrideDelta,
    driverMessage,
  });
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
    const validation = validateStopsText(stopsInput);
    if (validation.errors.length > 0) {
      return res.status(400).json({ error: validation.errors.join(' '), validation });
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
    const result = await applyRoadRouting(
      {
        ...(baseResult as unknown as OptimizationResult),
        validation: {
          errors: [],
          warnings: [...(baseResult.validation?.warnings ?? []), ...validation.warnings],
        },
      },
      Array.isArray(geofences) ? geofences : []
    );

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
    const { result, geofences, adjustmentRequest } = req.body ?? {};
    if (!result || !Array.isArray(result.nodes) || !Array.isArray(result.baselinePath) || !Array.isArray(result.optimizedPath)) {
      return res.status(400).json({ error: 'A prior optimization result payload is required.' });
    }
    if (result.planningInputs?.stopsText) {
      const validation = validateStopsText(result.planningInputs.stopsText);
      if (validation.errors.length > 0) {
        return res.status(400).json({ error: validation.errors.join(' '), validation });
      }
    }
    const previousProposal = snapshotProposal(result as OptimizationResult);
    const nextGeofences = Array.isArray(geofences) ? geofences : result.geofences ?? [];
    if (adjustmentRequest && typeof adjustmentRequest.label !== 'string') {
      return res.status(400).json({ error: 'Adjustment requests need a label.' });
    }
    let rerouted: OptimizationResult;

    if (adjustmentRequest?.type && adjustmentRequest.type !== 'avoid_blocked_corridor') {
      const planningInputs = normalizePlanningInputs(result as OptimizationResult);
      if (!planningInputs?.stopsText) {
        return res.status(400).json({ error: 'The current result does not include enough planning context to apply that adjustment.' });
      }
      const adjustedInputs = applyAdjustmentToInputs(planningInputs, adjustmentRequest as AdjustmentRequest);
      const nextBaseResult = await optimizeRoute(
        adjustedInputs.stopsText,
        [],
        adjustedInputs.preferences,
        adjustedInputs.optimization,
        adjustedInputs.fleet
      );
      rerouted = await applyRoadRouting(
        {
          ...(nextBaseResult as unknown as OptimizationResult),
          planningInputs: adjustedInputs,
        },
        nextGeofences,
        adjustmentRequest as AdjustmentRequest,
        previousProposal
      );
    } else {
      rerouted = await applyRoadRouting(
        result as OptimizationResult,
        nextGeofences,
        adjustmentRequest as AdjustmentRequest | undefined,
        previousProposal
      );
    }

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
