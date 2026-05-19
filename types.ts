export interface Node {
  id: string;
  x: number; // Normalized 0-100
  y: number; // Normalized 0-100
  lat?: number;
  lng?: number;
  type: 'hub' | 'stop' | 'warehouse' | 'depot' | 'virtual';
  label: string;
}

export interface LatLngPoint {
  lat: number;
  lng: number;
}

export interface RoadBlockSegment {
  start: LatLngPoint;
  end: LatLngPoint;
  path: LatLngPoint[];
}

export interface Geofence {
  id: string;
  label: string;
  coordinates: LatLngPoint[];
  kind?: 'polygon' | 'road_block';
  roadSegment?: RoadBlockSegment;
}

export interface Disruption {
  x: number;
  y: number;
  radius: number;
  description: string;
  lat?: number;
  lng?: number;
  radiusMeters?: number;
}

export type TrafficCongestionLevel = 'low' | 'moderate' | 'heavy' | 'severe' | 'unknown';

export interface RouteTrafficSegment {
  coordinates: [number, number][];
  congestion: TrafficCongestionLevel;
}

export interface RoutedRoad {
  coordinates: [number, number][];
  distanceKm: number;
  durationMin: number;
  source: 'osrm' | 'mapbox' | 'synthetic';
  trafficSegments?: RouteTrafficSegment[];
  cacheStatus?: 'hit' | 'miss' | 'mixed' | 'none';
  fallbackLegCount?: number;
  warnings?: string[];
}

export interface ValidationSummary {
  errors: string[];
  warnings: string[];
}

export interface RouteSummary {
  totalLegs: number;
  stopCount?: number;
  firstStopLabel: string;
  lastStopLabel: string;
  longestLegKm: number;
  selectedStopEtaMin?: number;
}

export interface RouteDiagnostics {
  routingStatus: 'full_osrm' | 'partial_fallback' | 'synthetic_fallback' | 'demo_mode';
  fallbackLegCount: number;
  cacheStatus: 'hit' | 'miss' | 'mixed' | 'none';
  geofenceImpact: 'none' | 'detoured' | 'blocked_fallback';
  provider?: 'osrm' | 'mapbox' | 'synthetic' | 'demo';
  trafficMode?: 'historical_or_live' | 'freeflow';
  optimizationTimeMs?: number;
  roadRoutingTimeMs?: number;
  totalProcessingTimeMs?: number;
  dispatcherReady?: boolean;
  warnings: string[];
}

export interface AppConfigStatus {
  ready: boolean;
  routingProvider: 'osrm' | 'mapbox';
  trafficModeReady: boolean;
  mapboxConfigured: boolean;
  geminiConfigured: boolean;
  historicalReplayReady: boolean;
  notes: string[];
}

export interface DisplayFilters {
  showBaseline: boolean;
  showOptimized: boolean;
  showLabels: boolean;
  showTraffic: boolean;
  upcomingStops: number | null;
}

export interface RouteFocus {
  selectedStopId?: string;
  selectedLegIndex?: number;
  selectedRouteId?: string;
  fitToActiveRoute?: boolean;
}

export interface Metrics {
  distance: number; // km
  time: number; // minutes
  emissions: number; // kg CO2
}

export interface Improvement {
  distancePct: number;
  timePct: number;
  emissionsPct: number;
}

export interface FleetConfig {
  vehicleCount: number;
  vehicleLabels?: string[];
}

export interface FleetRoutePlan {
  routeId: string;
  vehicleIndex: number;
  vehicleLabel: string;
  path: string[];
  road?: RoutedRoad | null;
  metrics: Metrics;
  summary: RouteSummary;
  warnings?: string[];
}

export interface FleetComparison {
  status: 'improved' | 'worsened' | 'mixed' | 'validated';
  headline: string;
  detail: string;
}

export type DecisionStatus = 'proposed' | 'approved' | 'adjustment_requested' | 'updated_proposal';

export type AdjustmentType = 'prioritize_eta' | 're_evaluate' | 'simplify_route' | 'avoid_blocked_corridor';

export type AdjustmentReasonCode =
  | 'school_zone_traffic'
  | 'bridge_or_trailer_constraint'
  | 'customer_dock_access'
  | 'driver_preference'
  | 'dispatcher_review'
  | 'blocked_corridor';

export interface OverrideDelta {
  timeMin: number;
  distanceKm: number;
  emissionsKg: number;
  estimatedFuelCost: number;
  direction: 'better' | 'worse' | 'mixed' | 'flat';
  summary: string;
}

export interface AdjustmentRequest {
  type: AdjustmentType;
  label: string;
  reasonCode?: AdjustmentReasonCode;
  note?: string;
}

export interface DecisionSummary {
  title: string;
  summary: string;
  evidence: string[];
  reviewPrompt?: string;
  changeLabel?: string;
  overrideDelta?: OverrideDelta;
  driverMessage?: string;
}

export interface PlanningInputs {
  stopsText: string;
  preferences?: { weightTime?: number; weightEmissions?: number; weightDistance?: number };
  optimization?: { mode?: 'fast' | 'quality'; timeBudgetMs?: number; baselineMode?: 'dynamic' | 'distance' };
  fleet?: FleetConfig;
}

export interface ProposalSnapshot {
  decisionStatus: DecisionStatus;
  comparison?: FleetComparison;
  metrics: {
    baseline: Metrics;
    optimized: Metrics;
    improvement: Improvement;
  };
  decisionSummary?: DecisionSummary;
  adjustmentRequest?: AdjustmentRequest;
  overrideDelta?: OverrideDelta;
  driverMessage?: string;
}

export interface PilotReportSnapshot {
  runCount: number;
  rerouteCount: number;
  approvedCount: number;
  fallbackRatePct: number;
  distanceDeltaKm: number;
  timeDeltaMin: number;
  emissionsDeltaKg: number;
}

export interface CompanyHistoricalMetricsBaseline extends Partial<Metrics> {
  vehicleCount?: number;
  fuelCost?: number;
  routeCount?: number;
  stopCount?: number;
  routeDate?: string;
  shiftLabel?: string;
  notes?: string;
}

export interface CompanyHistoricalRouteOutcome {
  routeId: string;
  vehicleLabel: string;
  stopLabels?: string[];
  stopIds?: string[];
  metrics?: Partial<Metrics>;
  notes?: string;
}

export interface ShadowPilotScenarioInput {
  organizationName: string;
  scenarioLabel: string;
  routeDate?: string;
  shiftLabel?: string;
  stopsText: string;
  fleet?: FleetConfig;
  preferences?: PlanningInputs['preferences'];
  optimization?: PlanningInputs['optimization'];
  historicalBaseline?: CompanyHistoricalMetricsBaseline;
  historicalRoutes?: CompanyHistoricalRouteOutcome[];
}

export interface ShadowPilotScenarioRecord extends ShadowPilotScenarioInput {
  id: string;
  createdAt: string;
  updatedAt: string;
  lastRunId?: string;
  runIds: string[];
}

export interface ProofMetricDelta {
  baselineValue: number | null;
  proposalValue: number | null;
  delta: number | null;
  deltaPct?: number | null;
  direction: 'better' | 'worse' | 'flat' | 'unknown';
}

export interface ShadowPilotComparisonSummary {
  baselineSource: 'system' | 'organization';
  headline: string;
  detail: string;
  distance: ProofMetricDelta;
  time: ProofMetricDelta;
  emissions: ProofMetricDelta;
  fuelCost?: ProofMetricDelta;
}

export interface ShadowPilotOverrideAnalysis {
  classification: 'system_correct' | 'dispatcher_correct' | 'third_alternative_exists' | 'insufficient_evidence';
  headline: string;
  detail: string;
  avoidableOverride: boolean;
  estimatedLeakage?: number;
  savedIfAccepted?: number;
}

export interface ShadowPilotProofReport {
  reportId: string;
  generatedAt: string;
  scenarioId?: string;
  runId?: string;
  organizationName?: string;
  scenarioLabel?: string;
  routeDate?: string;
  shiftLabel?: string;
  internalBaselineComparison: ShadowPilotComparisonSummary;
  organizationComparison?: ShadowPilotComparisonSummary;
  overrideAnalysis: ShadowPilotOverrideAnalysis;
  highlights: string[];
  confidenceNotes: string[];
}

export interface ShadowPilotRunRecord {
  id: string;
  scenarioId?: string;
  createdAt: string;
  organizationName?: string;
  scenarioLabel?: string;
  routeDate?: string;
  shiftLabel?: string;
  result: OptimizationResult;
  report: ShadowPilotProofReport;
}

export interface ShadowPilotAggregateSnapshot {
  scenarioCount: number;
  runCount: number;
  organizationCount: number;
  latestRunAt?: string;
  historicalComparisonCount: number;
  systemCorrectCount: number;
  dispatcherCorrectCount: number;
  thirdAlternativeCount: number;
  cumulativeDistanceSavedKm: number;
  cumulativeTimeSavedMin: number;
  cumulativeEmissionsSavedKg: number;
  cumulativeHistoricalFuelSavings?: number;
}

export interface ShadowPilotScenarioSummary {
  id: string;
  organizationName: string;
  scenarioLabel: string;
  routeDate?: string;
  shiftLabel?: string;
  createdAt: string;
  updatedAt: string;
  runCount: number;
  lastRunAt?: string;
  lastRunId?: string;
}

export interface OptimizationResult {
  nodes: Node[];
  baselinePath: string[]; // Array of Node IDs
  optimizedPath: string[]; // Array of Node IDs
  fleetConfig?: FleetConfig;
  baselineRoutes: FleetRoutePlan[];
  optimizedRoutes: FleetRoutePlan[];
  comparison?: FleetComparison;
  aiOptimizedPath?: string[];
  disruptions: Disruption[];
  geofences?: Geofence[];
  baselineRoad?: RoutedRoad | null;
  optimizedRoad?: RoutedRoad | null;
  coordinateMode: 'geo' | 'demo';
  overrideMode?: 'none' | 'manual_order';
  activeRouteLabel?: 'optimized' | 'manual';
  manualRouteOrder?: string[];
  validation?: ValidationSummary;
  routeWarnings?: string[];
  optimizationTimeMs?: number;
  routeSummary?: RouteSummary;
  diagnostics?: RouteDiagnostics;
  displayFilters?: DisplayFilters;
  routeFocus?: RouteFocus;
  decisionStatus?: DecisionStatus;
  decisionSummary?: DecisionSummary;
  adjustmentRequest?: AdjustmentRequest;
  previousProposal?: ProposalSnapshot;
  planningInputs?: PlanningInputs;
  scenarioId?: string;
  scenarioLabel?: string;
  organizationName?: string;
  routeDate?: string;
  shiftLabel?: string;
  historicalBaseline?: CompanyHistoricalMetricsBaseline;
  historicalRoutes?: CompanyHistoricalRouteOutcome[];
  internalBaselineComparison?: ShadowPilotComparisonSummary;
  organizationComparison?: ShadowPilotComparisonSummary;
  overrideAnalysis?: ShadowPilotOverrideAnalysis;
  proofReport?: ShadowPilotProofReport;
  overrideDelta?: OverrideDelta;
  driverMessage?: string;
  pilotReport?: PilotReportSnapshot;
  metrics: {
    baseline: Metrics;
    optimized: Metrics;
    improvement: Improvement;
  };
  engineLogs?: string[];
  detectedPatterns?: { type: string; description: string; id: string; macroNodeId?: string }[];
  logs: string[]; // The reasoning steps
}

export enum ProcessingStatus {
  IDLE = 'IDLE',
  ANALYZING = 'ANALYZING',
  COMPRESSING = 'COMPRESSING',
  OPTIMIZING = 'OPTIMIZING',
  COMPLETE = 'COMPLETE',
  ERROR = 'ERROR'
}
