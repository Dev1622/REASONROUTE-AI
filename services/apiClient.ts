import { AppConfigStatus, Geofence, OptimizationResult } from '../types';

type ImagePayload = { base64: string; mimeType: string };

type OptimizePayload = {
  stopsText: string;
  images: ImagePayload[];
  preferences?: { weightTime?: number; weightEmissions?: number; weightDistance?: number };
  optimization?: { mode?: 'fast' | 'quality'; timeBudgetMs?: number; baselineMode?: 'dynamic' | 'distance' };
  geofences?: Geofence[];
};

type ReroutePayload = {
  result: OptimizationResult;
  geofences?: Geofence[];
  manualRouteOrder?: string[];
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
