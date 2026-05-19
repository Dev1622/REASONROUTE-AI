import {
  AdjustmentRequest,
  AppConfigStatus,
  CompanyHistoricalMetricsBaseline,
  CompanyHistoricalRouteOutcome,
  FleetConfig,
  Geofence,
  OptimizationResult,
  ShadowPilotAggregateSnapshot,
  ShadowPilotProofReport,
  ShadowPilotRunRecord,
  ShadowPilotScenarioRecord,
  ShadowPilotScenarioSummary,
} from '../types';

type ImagePayload = { base64: string; mimeType: string };

type OptimizePayload = {
  stopsText: string;
  images: ImagePayload[];
  preferences?: { weightTime?: number; weightEmissions?: number; weightDistance?: number };
  optimization?: { mode?: 'fast' | 'quality'; timeBudgetMs?: number; baselineMode?: 'dynamic' | 'distance' };
  fleet?: FleetConfig;
  geofences?: Geofence[];
  scenarioId?: string;
  organizationName?: string;
  scenarioLabel?: string;
  routeDate?: string;
  shiftLabel?: string;
  historicalBaseline?: CompanyHistoricalMetricsBaseline;
  historicalRoutes?: CompanyHistoricalRouteOutcome[];
};

type ReroutePayload = {
  result: OptimizationResult;
  geofences?: Geofence[];
  manualRouteOrder?: string[];
  adjustmentRequest?: AdjustmentRequest;
  previewOnly?: boolean;
};

async function postJson<T>(path: string, payload: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(json?.error ?? `Request failed: ${response.status}`);
  }
  return json as T;
}

export async function optimizeViaApi(payload: OptimizePayload): Promise<OptimizationResult> {
  const response = await postJson<{ result: OptimizationResult }>('/api/optimize', payload);
  return response.result;
}

export async function rerouteViaApi(payload: ReroutePayload): Promise<OptimizationResult> {
  const response = await postJson<{ result: OptimizationResult }>('/api/reroute', payload);
  return response.result;
}

export async function fetchConfigStatus(): Promise<AppConfigStatus> {
  const response = await fetch('/api/config');
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((json as any)?.error ?? `Request failed: ${response.status}`);
  }
  return json as AppConfigStatus;
}

export type ShadowPilotScenarioImportPayload = {
  organizationName: string;
  scenarioLabel: string;
  routeDate?: string;
  shiftLabel?: string;
  stopsText: string;
  fleet?: FleetConfig;
  preferences?: OptimizePayload['preferences'];
  optimization?: OptimizePayload['optimization'];
  historicalBaseline?: CompanyHistoricalMetricsBaseline;
  historicalRoutes?: CompanyHistoricalRouteOutcome[];
};

export async function importShadowPilotScenario(payload: ShadowPilotScenarioImportPayload): Promise<ShadowPilotScenarioRecord> {
  const response = await postJson<{ scenario: ShadowPilotScenarioRecord }>('/api/shadow-pilot/scenarios/import', payload);
  return response.scenario;
}

export async function listShadowPilotScenarios(): Promise<ShadowPilotScenarioSummary[]> {
  const response = await fetch('/api/shadow-pilot/scenarios');
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((json as any)?.error ?? `Request failed: ${response.status}`);
  }
  return (json as { scenarios: ShadowPilotScenarioSummary[] }).scenarios;
}

export async function getShadowPilotScenario(id: string): Promise<ShadowPilotScenarioRecord> {
  const response = await fetch(`/api/shadow-pilot/scenarios/${encodeURIComponent(id)}`);
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((json as any)?.error ?? `Request failed: ${response.status}`);
  }
  return (json as { scenario: ShadowPilotScenarioRecord }).scenario;
}

export async function replayShadowPilotScenario(id: string, geofences?: Geofence[]): Promise<{ run: ShadowPilotRunRecord; result: OptimizationResult; report: ShadowPilotProofReport }> {
  return postJson<{ run: ShadowPilotRunRecord; result: OptimizationResult; report: ShadowPilotProofReport }>(
    `/api/shadow-pilot/scenarios/${encodeURIComponent(id)}/replay`,
    { geofences }
  );
}

export async function listShadowPilotRuns(): Promise<ShadowPilotRunRecord[]> {
  const response = await fetch('/api/shadow-pilot/runs');
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((json as any)?.error ?? `Request failed: ${response.status}`);
  }
  return (json as { runs: ShadowPilotRunRecord[] }).runs;
}

export async function fetchShadowPilotRun(id: string): Promise<ShadowPilotRunRecord> {
  const response = await fetch(`/api/shadow-pilot/runs/${encodeURIComponent(id)}`);
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((json as any)?.error ?? `Request failed: ${response.status}`);
  }
  return (json as { run: ShadowPilotRunRecord }).run;
}

export async function fetchShadowPilotAggregate(): Promise<ShadowPilotAggregateSnapshot> {
  const response = await fetch('/api/shadow-pilot/aggregate');
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((json as any)?.error ?? `Request failed: ${response.status}`);
  }
  return (json as { aggregate: ShadowPilotAggregateSnapshot }).aggregate;
}
