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

export interface RoutedRoad {
  coordinates: [number, number][];
  distanceKm: number;
  durationMin: number;
  source: 'osrm' | 'synthetic';
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
  warnings: string[];
}

export interface DisplayFilters {
  showBaseline: boolean;
  showOptimized: boolean;
  showLabels: boolean;
  upcomingStops: number | null;
}

export interface RouteFocus {
  selectedStopId?: string;
  selectedLegIndex?: number;
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

export interface OptimizationResult {
  nodes: Node[];
  baselinePath: string[]; // Array of Node IDs
  optimizedPath: string[]; // Array of Node IDs
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
  routeSummary?: RouteSummary;
  diagnostics?: RouteDiagnostics;
  displayFilters?: DisplayFilters;
  routeFocus?: RouteFocus;
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
