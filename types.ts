export interface Node {
  id: string;
  x: number; // Normalized 0-100
  y: number; // Normalized 0-100
  type: 'hub' | 'stop' | 'warehouse';
  label: string;
}

export interface Disruption {
  x: number;
  y: number;
  radius: number;
  description: string;
}

export interface Metrics {
  distance: number; // km
  time: number; // minutes
  emissions: number; // kg CO2
}

export interface OptimizationResult {
  nodes: Node[];
  baselinePath: string[]; // Array of Node IDs
  optimizedPath: string[]; // Array of Node IDs
  disruptions: Disruption[];
  metrics: {
    baseline: Metrics;
    optimized: Metrics;
  };
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
