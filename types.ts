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

export interface AdjustmentRequest {
  type: AdjustmentType;
  label: string;
  note?: string;
}

export interface DecisionSummary {
  title: string;
  summary: string;
  evidence: string[];
  reviewPrompt?: string;
  changeLabel?: string;
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
