import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Download, FileJson, Play, RefreshCcw, Sparkles, Terminal, Upload, X } from 'lucide-react';
import clsx from 'clsx';
import * as XLSX from 'xlsx';
import {
  AdjustmentReasonCode,
  AdjustmentRequest,
  AppConfigStatus,
  CompanyHistoricalMetricsBaseline,
  CompanyHistoricalRouteOutcome,
  FleetConfig,
  FleetRoutePlan,
  OptimizationResult,
  ProcessingStatus,
  ShadowPilotAggregateSnapshot,
  ShadowPilotScenarioRecord,
  ShadowPilotScenarioSummary,
} from '../types';

interface SidebarProps {
  onOptimize: (
    stops: string,
    images: File[],
    preferences?: { weightTime?: number; weightEmissions?: number; weightDistance?: number },
    optimization?: { mode?: 'fast' | 'quality'; timeBudgetMs?: number; baselineMode?: 'dynamic' | 'distance' },
    fleet?: FleetConfig,
    scenarioMeta?: {
      scenarioId?: string;
      organizationName?: string;
      scenarioLabel?: string;
      routeDate?: string;
      shiftLabel?: string;
      historicalBaseline?: CompanyHistoricalMetricsBaseline;
      historicalRoutes?: CompanyHistoricalRouteOutcome[];
    }
  ) => void;
  onSaveScenario: (payload: {
    organizationName: string;
    scenarioLabel: string;
    routeDate?: string;
    shiftLabel?: string;
    stopsText: string;
    fleet?: FleetConfig;
    preferences?: { weightTime?: number; weightEmissions?: number; weightDistance?: number };
    optimization?: { mode?: 'fast' | 'quality'; timeBudgetMs?: number; baselineMode?: 'dynamic' | 'distance' };
    historicalBaseline?: CompanyHistoricalMetricsBaseline;
    historicalRoutes?: CompanyHistoricalRouteOutcome[];
  }) => void;
  onReplayScenario: (scenarioId: string) => void;
  onApprove: () => void;
  onPreviewAdjustment: (adjustmentRequest: AdjustmentRequest) => void;
  onConfirmAdjustment: () => void;
  onCancelAdjustmentPreview: () => void;
  onUseAlternative: (result: OptimizationResult) => void;
  onSelectRoute: (routeId?: string) => void;
  status: ProcessingStatus;
  result: OptimizationResult | null;
  previewActive: boolean;
  history: { ts: string; improvement: { distancePct: number; timePct: number; emissionsPct: number }; baseline: number; optimized: number; vehicles: number; fallbackLegCount: number; rerouted: boolean; timeDelta: number; emissionsDelta: number }[];
  errorMessage?: string | null;
  configStatus: AppConfigStatus | null;
  scenarios: ShadowPilotScenarioSummary[];
  pilotAggregate: ShadowPilotAggregateSnapshot | null;
  activeScenario: ShadowPilotScenarioRecord | null;
}

const SAMPLE_SCENARIOS = [
  {
    label: 'US demo',
    value: `Chicago Depot, 41.8781, -87.6298
West Loop Drop, 41.8840, -87.6470
Lincoln Park Stop, 41.9214, -87.6513
Logan Square Stop, 41.9231, -87.7093
Wicker Park Stop, 41.9088, -87.6796
Hyde Park Stop, 41.7943, -87.5907
Bridgeport Stop, 41.8378, -87.6511`,
  },
  {
    label: 'Grid demo',
    value: `Depot, 10, 10
North Cluster, 20, 25
Port, 15, 40
Airport, 60, 80
CBD, 55, 60
Stadium, 52, 45
Residential, 40, 55
Clinic, 35, 35`,
  },
];

function downloadText(filename: string, content: string, mimeType: string) {
  const anchor = document.createElement('a');
  anchor.href = `data:${mimeType};charset=utf-8,${encodeURIComponent(content)}`;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
}

function routeFeature(result: OptimizationResult, route: FleetRoutePlan, collection: 'baseline' | 'optimized') {
  const nodeMap = new Map(result.nodes.map(node => [node.id, node]));
  return {
    type: 'Feature',
    properties: { collection, routeId: route.routeId, vehicleLabel: route.vehicleLabel, source: route.road?.source ?? 'node-order' },
    geometry: {
      type: 'LineString',
      coordinates: (route.road?.coordinates?.length
        ? route.road.coordinates.map(([lat, lng]) => [lng, lat])
        : route.path
            .map(id => nodeMap.get(id))
            .filter(Boolean)
            .map(node => (result.coordinateMode === 'geo' && typeof node!.lat === 'number' && typeof node!.lng === 'number' ? [node!.lng, node!.lat] : [node!.x, node!.y]))) as number[][],
    },
  };
}

function buildFleetSummary(result: OptimizationResult) {
  return {
    generatedAt: new Date().toISOString(),
    decisionStatus: result.decisionStatus,
    decisionSummary: result.decisionSummary,
    adjustmentRequest: result.adjustmentRequest,
    previousProposal: result.previousProposal,
    overrideDelta: result.overrideDelta,
    driverMessage: result.driverMessage,
    pilotReport: result.pilotReport,
    proofReport: result.proofReport,
    internalBaselineComparison: result.internalBaselineComparison,
    organizationComparison: result.organizationComparison,
    overrideAnalysis: result.overrideAnalysis,
    organizationName: result.organizationName,
    scenarioLabel: result.scenarioLabel,
    routeDate: result.routeDate,
    shiftLabel: result.shiftLabel,
    fleetConfig: result.fleetConfig,
    comparison: result.comparison,
    metrics: result.metrics,
    diagnostics: result.diagnostics,
    optimizedRoutes: result.optimizedRoutes.map(route => ({ vehicleLabel: route.vehicleLabel, metrics: route.metrics, summary: route.summary })),
    baselineRoutes: result.baselineRoutes.map(route => ({ vehicleLabel: route.vehicleLabel, metrics: route.metrics, summary: route.summary })),
  };
}

function buildFleetSummaryHtml(result: OptimizationResult) {
  const rows = result.optimizedRoutes
    .map(route => `<tr><td>${route.vehicleLabel}</td><td>${route.summary.stopCount ?? 0}</td><td>${route.metrics.distance.toFixed(2)} km</td><td>${route.metrics.time.toFixed(1)} min</td><td>${route.metrics.emissions.toFixed(3)} kg</td></tr>`)
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><title>Route Decision Summary</title><style>body{font-family:Arial,sans-serif;margin:24px;color:#0f172a}table{width:100%;border-collapse:collapse;margin-top:12px}th,td{border:1px solid #cbd5e1;padding:8px;text-align:left}th{background:#e2e8f0}.cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:16px 0}.card{border:1px solid #cbd5e1;border-radius:10px;padding:12px;background:#f8fafc}.note{margin-top:12px;padding:12px;border:1px solid #cbd5e1;border-radius:10px;background:#f8fafc}</style></head><body><h1>${result.decisionSummary?.title ?? result.comparison?.headline ?? 'Route Decision Summary'}</h1><p>${result.decisionSummary?.summary ?? result.comparison?.detail ?? ''}</p><p><strong>Driver-facing explanation:</strong> ${result.driverMessage ?? result.decisionSummary?.driverMessage ?? 'Not generated'}</p><div class="cards"><div class="card"><strong>Status</strong><br/>${decisionStateLabel(result.decisionStatus)}</div><div class="card"><strong>Distance</strong><br/>${result.metrics.optimized.distance.toFixed(2)} km</div><div class="card"><strong>Time</strong><br/>${result.metrics.optimized.time.toFixed(1)} min</div><div class="card"><strong>Vehicles</strong><br/>${result.fleetConfig?.vehicleCount ?? result.optimizedRoutes.length}</div></div><div class="note"><strong>Negotiation context</strong><br/>Adjustment reason: ${result.adjustmentRequest?.label ?? 'No adjustment requested'}${result.adjustmentRequest?.note ? `<br/>Dispatcher note: ${result.adjustmentRequest.note}` : ''}${result.overrideDelta ? `<br/>Override delta: ${result.overrideDelta.summary}` : ''}</div><table><thead><tr><th>Vehicle</th><th>Stops</th><th>Distance</th><th>Time</th><th>Emissions</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
}

function buildVehicleManifest(result: OptimizationResult, route: FleetRoutePlan) {
  const nodeMap = new Map(result.nodes.map(node => [node.id, node]));
  return {
    generatedAt: new Date().toISOString(),
    decisionStatus: result.decisionStatus,
    decisionSummary: result.decisionSummary,
    adjustmentRequest: result.adjustmentRequest,
    previousProposal: result.previousProposal,
    overrideDelta: result.overrideDelta,
    driverMessage: result.driverMessage,
    vehicleLabel: route.vehicleLabel,
    routeId: route.routeId,
    metrics: route.metrics,
    summary: route.summary,
    diagnostics: {
      source: route.road?.source ?? result.diagnostics?.provider ?? 'unknown',
      cacheStatus: route.road?.cacheStatus ?? 'none',
      fallbackLegCount: route.road?.fallbackLegCount ?? 0,
      warnings: route.warnings ?? [],
    },
    stops: route.path.map((id, index) => {
      const node = nodeMap.get(id);
      return { sequence: index + 1, id, label: node?.label ?? id, type: node?.type ?? 'stop', lat: node?.lat, lng: node?.lng };
    }),
  };
}

const ADJUSTMENT_OPTIONS: AdjustmentRequest[] = [
  { type: 'prioritize_eta', label: 'Prioritize ETA', note: 'Bias the route toward the fastest arrival window.' },
  { type: 're_evaluate', label: 'Re-evaluate', note: 'Run a deeper search before approving this recommendation.' },
  { type: 'simplify_route', label: 'Simplify route', note: 'Prefer a cleaner route shape with fewer detours where possible.' },
];

const TRIBAL_TAGS: { code: AdjustmentReasonCode; label: string; detail: string }[] = [
  { code: 'school_zone_traffic', label: 'School Zone Traffic', detail: 'Local congestion pattern' },
  { code: 'bridge_or_trailer_constraint', label: 'Bridge / Trailer Constraint', detail: 'Avoid clearance or trailer issues' },
  { code: 'customer_dock_access', label: 'Customer Dock Access', detail: 'Docking or turn-in difficulty' },
  { code: 'driver_preference', label: 'Driver Preference', detail: 'Dispatcher wants a familiar route' },
];

type EvidencePanel = 'pilot' | 'routes' | 'diagnostics' | 'exports';

function sanitizeReasoningLine(line: string) {
  return line.replace(/^\[\d+\]\s*/, '').trim();
}

function decisionStateLabel(status?: OptimizationResult['decisionStatus']) {
  switch (status) {
    case 'approved':
      return 'Approved';
    case 'updated_proposal':
      return 'Updated proposal';
    case 'adjustment_requested':
      return 'Adjustment pending';
    case 'proposed':
    default:
      return 'Proposed';
  }
}

function validateStopsTextInput(source: string) {
  const issues: string[] = [];
  const lines = source
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    issues.push('Add at least one depot row and one delivery stop.');
    return issues;
  }

  const firstParts = lines[0].split(',').map(part => part.trim());
  if (firstParts[0] && !/(depot|warehouse|hub)/i.test(firstParts[0])) {
    issues.push('First row should be the depot or warehouse for shadow-pilot routing.');
  }

  const labels = new Set<string>();
  lines.forEach((line, index) => {
    const parts = line.split(',').map(part => part.trim());
    if (!parts[0]) {
      issues.push(`Row ${index + 1} is missing a stop label.`);
      return;
    }
    const key = parts[0].toLowerCase();
    if (labels.has(key)) {
      issues.push(`Duplicate stop label found: ${parts[0]}.`);
    }
    labels.add(key);

    if (parts.length < 3) {
      issues.push(`Row ${index + 1} should include label, lat, lng.`);
      return;
    }

    const lat = Number(parts[1]);
    const lng = Number(parts[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      issues.push(`Row ${index + 1} has invalid coordinates.`);
    }
  });

  return Array.from(new Set(issues));
}

function parseOptionalNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function signed(value: number, digits = 1) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
}

const RouteCard: React.FC<{ route: FleetRoutePlan; selected: boolean; tone: 'baseline' | 'optimized'; onClick: () => void }> = ({ route, selected, tone, onClick }) => {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'w-full rounded border px-3 py-3 text-left text-[11px] transition-colors',
        selected
          ? tone === 'optimized'
            ? 'border-emerald-500/40 bg-emerald-950/15'
            : 'border-amber-500/40 bg-amber-950/15'
          : 'border-slate-800 bg-slate-950/60 hover:border-slate-700'
      )}
    >
      <div className="mb-1 flex items-center justify-between">
        <span className="font-semibold text-slate-200">{route.vehicleLabel}</span>
        <span className="text-slate-500">{route.summary.stopCount ?? 0} stops</span>
      </div>
      <div className="grid grid-cols-3 gap-2 text-slate-400">
        <div>{route.metrics.distance.toFixed(1)} km</div>
        <div>{route.metrics.time.toFixed(1)} min</div>
        <div>{route.metrics.emissions.toFixed(2)} kg</div>
      </div>
      <div className="mt-2 truncate text-slate-500">{route.summary.firstStopLabel} to {route.summary.lastStopLabel}</div>
    </button>
  );
};

const Sidebar: React.FC<SidebarProps> = ({
  onOptimize,
  onSaveScenario,
  onReplayScenario,
  onApprove,
  onPreviewAdjustment,
  onConfirmAdjustment,
  onCancelAdjustmentPreview,
  onUseAlternative,
  onSelectRoute,
  status,
  result,
  previewActive,
  history,
  errorMessage,
  configStatus,
  scenarios,
  pilotAggregate,
  activeScenario,
}) => {
  const [stops, setStops] = useState(SAMPLE_SCENARIOS[0].value);
  const [images, setImages] = useState<File[]>([]);
  const [jsonFileName, setJsonFileName] = useState<string | null>(null);
  const [sheetFileName, setSheetFileName] = useState<string | null>(null);
  const [weights, setWeights] = useState({ weightTime: 0.5, weightEmissions: 0.3, weightDistance: 0.2 });
  const [optimization, setOptimization] = useState<{ mode: 'fast' | 'quality'; timeBudgetMs: number }>({ mode: 'fast', timeBudgetMs: 40 });
  const [baselineMode, setBaselineMode] = useState<'dynamic' | 'distance'>('dynamic');
  const [vehicleCount, setVehicleCount] = useState(3);
  const [vehicleNames, setVehicleNames] = useState('Vehicle 1, Vehicle 2, Vehicle 3');
  const [showDebugLogs, setShowDebugLogs] = useState(false);
  const [healthCollapsed, setHealthCollapsed] = useState(false);
  const [setupCollapsed, setSetupCollapsed] = useState(false);
  const [selectedAdjustment, setSelectedAdjustment] = useState<AdjustmentRequest>(ADJUSTMENT_OPTIONS[0]);
  const [selectedTag, setSelectedTag] = useState<AdjustmentReasonCode>('school_zone_traffic');
  const [adjustmentNote, setAdjustmentNote] = useState('');
  const [alternativesOpen, setAlternativesOpen] = useState(false);
  const [importIssues, setImportIssues] = useState<string[]>([]);
  const [evidencePanel, setEvidencePanel] = useState<EvidencePanel>('pilot');
  const [organizationName, setOrganizationName] = useState('Sample Logistics Co.');
  const [scenarioLabel, setScenarioLabel] = useState('Morning Replay');
  const [routeDate, setRouteDate] = useState('');
  const [shiftLabel, setShiftLabel] = useState('AM Shift');
  const [historicalDistance, setHistoricalDistance] = useState('');
  const [historicalTime, setHistoricalTime] = useState('');
  const [historicalEmissions, setHistoricalEmissions] = useState('');
  const [historicalFuelCost, setHistoricalFuelCost] = useState('');
  const logContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (logContainerRef.current) logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
  }, [result?.logs, status]);

  useEffect(() => {
    if (result?.fleetConfig) {
      setVehicleCount(result.fleetConfig.vehicleCount);
      setVehicleNames((result.fleetConfig.vehicleLabels ?? []).join(', '));
    }
  }, [result?.fleetConfig]);

  useEffect(() => {
    if (result?.adjustmentRequest) {
      const matched = ADJUSTMENT_OPTIONS.find(option => option.type === result.adjustmentRequest?.type);
      if (matched) setSelectedAdjustment(matched);
      setAdjustmentNote(result.adjustmentRequest.note ?? '');
      if (result.adjustmentRequest.reasonCode) setSelectedTag(result.adjustmentRequest.reasonCode);
    }
  }, [result?.adjustmentRequest]);

  useEffect(() => {
    setAlternativesOpen(false);
  }, [result?.overrideDelta?.summary]);

  useEffect(() => {
    if (result) {
      setSetupCollapsed(true);
    }
  }, [result]);

  useEffect(() => {
    if (!activeScenario) return;
    setOrganizationName(activeScenario.organizationName);
    setScenarioLabel(activeScenario.scenarioLabel);
    setRouteDate(activeScenario.routeDate ?? '');
    setShiftLabel(activeScenario.shiftLabel ?? '');
    setStops(activeScenario.stopsText);
    setHistoricalDistance(activeScenario.historicalBaseline?.distance?.toString() ?? '');
    setHistoricalTime(activeScenario.historicalBaseline?.time?.toString() ?? '');
    setHistoricalEmissions(activeScenario.historicalBaseline?.emissions?.toString() ?? '');
    setHistoricalFuelCost(activeScenario.historicalBaseline?.fuelCost?.toString() ?? '');
  }, [activeScenario]);

  const isProcessing = ![ProcessingStatus.IDLE, ProcessingStatus.COMPLETE, ProcessingStatus.ERROR].includes(status);
  const parsedVehicleLabels = useMemo(() => vehicleNames.split(',').map(label => label.trim()).filter(Boolean).slice(0, vehicleCount), [vehicleNames, vehicleCount]);
  const selectedTagMeta = useMemo(() => TRIBAL_TAGS.find(tag => tag.code === selectedTag), [selectedTag]);
  const negotiatedAlternatives = result?.negotiatedAlternatives ?? [];
  const shouldShowNegotiatedAlternatives =
    previewActive &&
    Boolean(result?.overrideDelta) &&
    (result?.overrideDelta?.direction === 'worse' || result?.overrideDelta?.direction === 'mixed') &&
    negotiatedAlternatives.length > 0;
  const reasoningEvidence = useMemo(
    () => (result?.decisionSummary?.evidence?.length ? result.decisionSummary.evidence : (result?.logs ?? []).map(sanitizeReasoningLine).filter(Boolean).slice(0, 4)),
    [result]
  );
  const historicalBaseline = useMemo<CompanyHistoricalMetricsBaseline | undefined>(() => {
    const distance = parseOptionalNumber(historicalDistance);
    const time = parseOptionalNumber(historicalTime);
    const emissions = parseOptionalNumber(historicalEmissions);
    const fuelCost = parseOptionalNumber(historicalFuelCost);
    if ([distance, time, emissions, fuelCost].every(value => value === undefined)) {
      return undefined;
    }
    return {
      distance,
      time,
      emissions,
      fuelCost,
      vehicleCount,
      routeDate: routeDate || undefined,
      shiftLabel: shiftLabel || undefined,
    };
  }, [historicalDistance, historicalTime, historicalEmissions, historicalFuelCost, routeDate, shiftLabel, vehicleCount]);

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;
    setImages(prev => [...prev, ...Array.from(e.target.files)]);
    e.target.value = '';
  };

  const handleJsonUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setJsonFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result as string);
        const toLine = (node: any) => `${node.label ?? node.name ?? node.id ?? 'Stop'}, ${node.lat ?? node.x ?? ''}, ${node.lng ?? node.y ?? ''}`;
        const nextStops = Array.isArray(parsed)
          ? parsed.map(item => (typeof item === 'string' ? item : toLine(item))).join('\n')
          : parsed && Array.isArray(parsed.nodes)
            ? parsed.nodes.map(toLine).join('\n')
            : JSON.stringify(parsed, null, 2);
        setStops(nextStops);
        setImportIssues(validateStopsTextInput(nextStops));
      } catch {
        const raw = reader.result as string;
        setStops(raw);
        setImportIssues(validateStopsTextInput(raw));
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const rowsToStops = (rows: unknown[][]) => {
    const cleaned = rows.map(row => (Array.isArray(row) ? row.map(cell => (cell ?? '').toString().trim()) : [])).filter(row => row.some(Boolean));
    const maybeHeader = cleaned[0].map(cell => cell.toLowerCase());
    const hasHeader = maybeHeader.some(cell => ['label', 'stop', 'name', 'lat', 'lng', 'lon', 'longitude'].includes(cell));
    const body = hasHeader ? cleaned.slice(1) : cleaned;
    const labelIndex = hasHeader ? maybeHeader.findIndex(cell => ['label', 'stop', 'name'].includes(cell)) : 0;
    const latIndex = hasHeader ? maybeHeader.findIndex(cell => cell === 'lat' || cell === 'latitude') : 1;
    const lngIndex = hasHeader ? maybeHeader.findIndex(cell => ['lng', 'lon', 'longitude'].includes(cell)) : 2;
    if (latIndex < 0 || lngIndex < 0) throw new Error('The sheet needs latitude and longitude columns.');
    return body.map((row, index) => `${row[labelIndex] || `Stop ${index + 1}`}, ${row[latIndex]}, ${row[lngIndex]}`).join('\n');
  };

  const handleSheetUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setSheetFileName(file.name);
    try {
      const source = file.name.toLowerCase().endsWith('.csv') ? await file.text() : await file.arrayBuffer();
      const workbook = XLSX.read(source, { type: typeof source === 'string' ? 'string' : 'array' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false }) as unknown[][];
      const nextStops = rowsToStops(rows);
      setStops(nextStops);
      setImportIssues(validateStopsTextInput(nextStops));
    } catch (error: any) {
      console.error(error);
      setImportIssues([error?.message ?? 'Spreadsheet import failed.']);
    } finally {
      e.target.value = '';
    }
  };

  const exportFleetJson = () => result && downloadText('Route_Decision.json', JSON.stringify(buildFleetSummary(result), null, 2), 'application/json');
  const exportFleetHtml = () => result && downloadText('Route_Decision.html', buildFleetSummaryHtml(result), 'text/html');
  const exportVehicleManifests = () => result && result.optimizedRoutes.forEach(route => downloadText(`${route.vehicleLabel.replace(/\s+/g, '_')}_Manifest.json`, JSON.stringify(buildVehicleManifest(result, route), null, 2), 'application/json'));
  const exportGeojson = () => result && downloadText('Route_Geometry.geojson', JSON.stringify({ type: 'FeatureCollection', features: [...result.baselineRoutes.map(route => routeFeature(result, route, 'baseline')), ...result.optimizedRoutes.map(route => routeFeature(result, route, 'optimized'))] }, null, 2), 'application/json');
  const pilotReport = result?.pilotReport;

  const handleOptimizeClick = () => {
    const issues = validateStopsTextInput(stops);
    setImportIssues(issues);
    if (issues.length > 0) return;
    onOptimize(
      stops,
      images,
      weights,
      { ...optimization, baselineMode },
      { vehicleCount, vehicleLabels: parsedVehicleLabels },
      {
        scenarioId: activeScenario?.id,
        organizationName: organizationName.trim() || undefined,
        scenarioLabel: scenarioLabel.trim() || undefined,
        routeDate: routeDate || undefined,
        shiftLabel: shiftLabel || undefined,
        historicalBaseline,
        historicalRoutes: activeScenario?.historicalRoutes,
      }
    );
  };

  const handleSaveScenarioClick = () => {
    const issues = validateStopsTextInput(stops);
    setImportIssues(issues);
    if (issues.length > 0) return;
    onSaveScenario({
      organizationName: organizationName.trim(),
      scenarioLabel: scenarioLabel.trim(),
      routeDate: routeDate || undefined,
      shiftLabel: shiftLabel || undefined,
      stopsText: stops,
      fleet: { vehicleCount, vehicleLabels: parsedVehicleLabels },
      preferences: weights,
      optimization: { ...optimization, baselineMode },
      historicalBaseline,
      historicalRoutes: activeScenario?.historicalRoutes,
    });
  };

  const queueAdjustmentReview = () => {
    if (!result) return;
    onPreviewAdjustment({
      ...selectedAdjustment,
      reasonCode: selectedTag,
      note: adjustmentNote.trim() || selectedAdjustment.note,
    });
  };

  return (
    <div className="flex h-full flex-col border-r border-slate-800 bg-slate-900 text-slate-300">
      <div className="border-b border-slate-800 p-6">
        <h1 className="bg-gradient-to-r from-blue-400 to-emerald-400 bg-clip-text text-2xl font-bold text-transparent">ReasonRoute AI</h1>
        <p className="mt-1 font-mono text-xs text-slate-500">GLASS BOX NEGOTIATION LAYER</p>
      </div>
      <div className="flex-1 space-y-6 overflow-y-auto p-6">
        <div className={`rounded-md border px-3 py-3 text-xs ${configStatus?.ready ? 'border-emerald-500/30 bg-emerald-950/15 text-emerald-200' : 'border-amber-500/30 bg-amber-950/20 text-amber-200'}`}>
          <div className="flex items-center justify-between">
            <div className="font-bold uppercase tracking-wider">Pilot Health</div>
            <button type="button" className="rounded border border-slate-700 px-2 py-1 text-[10px] hover:bg-slate-800" onClick={() => setHealthCollapsed(prev => !prev)}>
              {healthCollapsed ? 'Open' : 'Min'}
            </button>
          </div>
          {healthCollapsed ? null : (
            <>
              <div className="mt-2 space-y-1 text-[11px]">
                <div className="flex justify-between"><span className="text-slate-400">Routing provider</span><span>{configStatus?.routingProvider ?? 'unknown'}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Traffic mode</span><span>{configStatus?.trafficModeReady ? 'ready' : 'fallback'}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Mapbox</span><span>{configStatus?.mapboxConfigured ? 'configured' : 'missing'}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Gemini</span><span>{configStatus?.geminiConfigured ? 'configured' : 'missing'}</span></div>
              </div>
              {configStatus?.notes?.map((note, index) => <div key={index} className="mt-1 text-[11px]">{note}</div>)}
            </>
          )}
        </div>

        <div className="rounded-md border border-slate-800 bg-slate-950/35 p-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs font-bold uppercase tracking-wider text-slate-500">Route Setup</div>
              <div className="mt-1 text-[11px] text-slate-500">Real fleet input, optimization controls, and proposal generation stay here when you need to reopen them.</div>
            </div>
            <button type="button" className="rounded border border-slate-700 px-2 py-1 text-[10px] hover:bg-slate-800" onClick={() => setSetupCollapsed(prev => !prev)}>
              {setupCollapsed ? 'Open' : 'Min'}
            </button>
          </div>
          {setupCollapsed ? (
            <div className="mt-3 rounded border border-slate-800 bg-slate-950/60 px-3 py-2 text-[11px] text-slate-500">
              Route review stays primary while this setup workspace is minimized.
            </div>
          ) : (
            <div className="mt-4 space-y-6">
        <div>
          <div className="mb-2 flex items-center justify-between">
            <label className="text-xs font-bold uppercase tracking-wider text-slate-500">Delivery Stops</label>
            <div className="flex items-center gap-2">
              {SAMPLE_SCENARIOS.map(sample => (
                <button
                  key={sample.label}
                  type="button"
                  className="rounded border border-slate-700 px-2 py-1 font-mono text-[10px] text-slate-400 transition-colors hover:border-emerald-500/40 hover:text-emerald-300"
                  onClick={() => {
                    setStops(sample.value);
                    setImportIssues(validateStopsTextInput(sample.value));
                  }}
                  disabled={isProcessing}
                >
                  {sample.label}
                </button>
              ))}
              <label className={clsx('flex cursor-pointer items-center gap-1.5 rounded border px-2 py-1 font-mono text-[10px]', isProcessing ? 'border-slate-800 text-slate-700' : 'border-slate-700 text-slate-400 hover:border-emerald-500/50 hover:text-emerald-400')}>
                <FileJson className="h-3 w-3" />
                <span>{jsonFileName ? jsonFileName.slice(0, 14) : 'Upload JSON'}</span>
                <input type="file" className="hidden" accept=".json,application/json" onChange={handleJsonUpload} disabled={isProcessing} />
              </label>
              <label className={clsx('flex cursor-pointer items-center gap-1.5 rounded border px-2 py-1 font-mono text-[10px]', isProcessing ? 'border-slate-800 text-slate-700' : 'border-slate-700 text-slate-400 hover:border-emerald-500/50 hover:text-emerald-400')}>
                <Upload className="h-3 w-3" />
                <span>{sheetFileName ? sheetFileName.slice(0, 14) : 'Upload CSV/XLSX'}</span>
                <input type="file" className="hidden" accept=".csv,.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv" onChange={handleSheetUpload} disabled={isProcessing} />
              </label>
            </div>
          </div>
          <textarea
            className="h-36 w-full resize-none rounded-md border border-slate-800 bg-slate-950 p-3 font-mono text-sm text-slate-300 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/50"
            value={stops}
            onChange={e => {
              const nextStops = e.target.value;
              setStops(nextStops);
              setImportIssues(validateStopsTextInput(nextStops));
            }}
            disabled={isProcessing}
          />
          <p className="mt-2 text-[11px] text-slate-500">First row should be the depot. ReasonRoute will propose a route plan and explain why it won.</p>
        </div>

        <div className="space-y-3 rounded-md border border-slate-800 bg-slate-950/40 p-3">
          <div className="flex items-center justify-between">
            <label className="text-xs font-bold uppercase tracking-wider text-slate-500">Shadow Pilot Scenario</label>
            <span className="font-mono text-[10px] text-slate-500">historical replay ready</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input
              type="text"
              value={organizationName}
              onChange={e => setOrganizationName(e.target.value)}
              disabled={isProcessing}
              className="rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-emerald-500"
              placeholder="Organization name"
            />
            <input
              type="text"
              value={scenarioLabel}
              onChange={e => setScenarioLabel(e.target.value)}
              disabled={isProcessing}
              className="rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-emerald-500"
              placeholder="Scenario label"
            />
            <input
              type="date"
              value={routeDate}
              onChange={e => setRouteDate(e.target.value)}
              disabled={isProcessing}
              className="rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-emerald-500"
            />
            <input
              type="text"
              value={shiftLabel}
              onChange={e => setShiftLabel(e.target.value)}
              disabled={isProcessing}
              className="rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-emerald-500"
              placeholder="Shift label"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input type="number" value={historicalDistance} onChange={e => setHistoricalDistance(e.target.value)} disabled={isProcessing} className="rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-emerald-500" placeholder="Historical distance km" />
            <input type="number" value={historicalTime} onChange={e => setHistoricalTime(e.target.value)} disabled={isProcessing} className="rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-emerald-500" placeholder="Historical time min" />
            <input type="number" value={historicalEmissions} onChange={e => setHistoricalEmissions(e.target.value)} disabled={isProcessing} className="rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-emerald-500" placeholder="Historical emissions kg" />
            <input type="number" value={historicalFuelCost} onChange={e => setHistoricalFuelCost(e.target.value)} disabled={isProcessing} className="rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-emerald-500" placeholder="Historical fuel cost" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={handleSaveScenarioClick}
              disabled={isProcessing || !organizationName.trim() || !scenarioLabel.trim()}
              className="rounded border border-blue-500/40 bg-blue-950/20 px-3 py-2 text-xs font-semibold text-blue-200 transition-colors hover:bg-blue-950/35 disabled:border-slate-800 disabled:bg-slate-900 disabled:text-slate-600"
            >
              Save Scenario
            </button>
            <button
              type="button"
              onClick={handleOptimizeClick}
              disabled={isProcessing || !stops.trim()}
              className="rounded border border-emerald-500/40 bg-emerald-950/20 px-3 py-2 text-xs font-semibold text-emerald-200 transition-colors hover:bg-emerald-950/35 disabled:border-slate-800 disabled:bg-slate-900 disabled:text-slate-600"
            >
              Plan Fleet
            </button>
          </div>
          <div className="space-y-2">
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Saved historical scenarios</div>
            <div className="max-h-32 space-y-2 overflow-y-auto rounded border border-slate-800 bg-slate-950/70 p-2">
              {scenarios.length === 0 ? <div className="text-[11px] italic text-slate-600">No saved scenarios yet.</div> : null}
              {scenarios.map(scenario => (
                <button
                  key={scenario.id}
                  type="button"
                  disabled={isProcessing}
                  onClick={() => onReplayScenario(scenario.id)}
                  className={clsx(
                    'w-full rounded border px-2 py-2 text-left text-[11px] transition-colors',
                    activeScenario?.id === scenario.id ? 'border-violet-500/40 bg-violet-950/20 text-violet-100' : 'border-slate-800 bg-slate-900/60 text-slate-300 hover:border-slate-700'
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold">{scenario.organizationName}</span>
                    <span className="font-mono text-[10px] text-slate-500">{scenario.runCount} runs</span>
                  </div>
                  <div className="mt-1 text-slate-400">{scenario.scenarioLabel}</div>
                  <div className="mt-1 text-[10px] text-slate-500">{scenario.routeDate ?? 'No date'} {scenario.shiftLabel ? `| ${scenario.shiftLabel}` : ''}</div>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-3 rounded-md border border-slate-800 bg-slate-950/40 p-3">
          <div className="flex items-center justify-between">
            <label className="text-xs font-bold uppercase tracking-wider text-slate-500">Fleet Setup</label>
            <span className="font-mono text-[10px] text-slate-500">Single depot fleet</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="w-24 text-[11px] text-slate-400">Vehicle count</span>
            <input type="range" min={2} max={25} step={1} value={vehicleCount} onChange={e => setVehicleCount(Number(e.target.value))} disabled={isProcessing} className="flex-1 accent-emerald-500" />
            <span className="w-8 text-right font-mono text-[11px] text-slate-300">{vehicleCount}</span>
          </div>
          <input type="text" value={vehicleNames} onChange={e => setVehicleNames(e.target.value)} disabled={isProcessing} className="w-full rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200 outline-none focus:border-emerald-500" placeholder="Vehicle 1, Vehicle 2, Vehicle 3" />
        </div>

        {importIssues.length > 0 && <div className="space-y-1 rounded-md border border-red-500/40 bg-red-950/20 px-3 py-2 text-xs text-red-300">{importIssues.map((issue, index) => <div key={`${issue}-${index}`}>{issue}</div>)}</div>}
        {errorMessage && <div className="rounded-md border border-red-500/40 bg-red-950/20 px-3 py-2 text-xs text-red-300">{errorMessage}</div>}
        {result?.validation?.warnings?.length ? <div className="space-y-1 rounded-md border border-amber-500/30 bg-amber-950/20 px-3 py-2 text-xs text-amber-200">{result.validation.warnings.map((warning, index) => <div key={index}>{warning}</div>)}</div> : null}

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-xs font-bold uppercase tracking-wider text-slate-500">Preference Weights</label>
            <span className="font-mono text-[10px] text-slate-500">Time / Emissions / Distance</span>
          </div>
          {([
            { key: 'weightTime', label: 'Time Priority' },
            { key: 'weightEmissions', label: 'Emissions Priority' },
            { key: 'weightDistance', label: 'Distance Priority' },
          ] as const).map(({ key, label }) => (
            <div key={key} className="flex items-center gap-3">
              <span className="w-28 text-[11px] text-slate-400">{label}</span>
              <input type="range" min={0} max={1} step={0.05} value={weights[key]} onChange={e => setWeights(prev => ({ ...prev, [key]: Number(e.target.value) }))} disabled={isProcessing} className="flex-1 accent-emerald-500" />
              <span className="w-10 text-right font-mono text-[11px] text-slate-400">{weights[key].toFixed(2)}</span>
            </div>
          ))}
        </div>

        <div className="space-y-2 pt-2">
          <div className="flex items-center justify-between">
            <label className="text-xs font-bold uppercase tracking-wider text-slate-500">Optimization Mode</label>
            <span className="font-mono text-[10px] text-slate-500">{optimization.mode}</span>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-slate-400">
            <input type="checkbox" checked={optimization.mode === 'quality'} onChange={e => setOptimization(prev => ({ ...prev, mode: e.target.checked ? 'quality' : 'fast' }))} disabled={isProcessing} className="accent-emerald-500" id="quality-toggle" />
            <label htmlFor="quality-toggle" className="cursor-pointer">Enable quality search</label>
          </div>
          <div className="flex items-center gap-3">
            <span className="w-24 text-[11px] text-slate-400">Time budget (ms)</span>
            <input type="range" min={20} max={250} step={10} value={optimization.timeBudgetMs} onChange={e => setOptimization(prev => ({ ...prev, timeBudgetMs: Number(e.target.value) }))} disabled={isProcessing} className="flex-1 accent-emerald-500" />
            <span className="w-10 text-right font-mono text-[11px] text-slate-400">{optimization.timeBudgetMs}</span>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-slate-400">
            <input type="checkbox" checked={baselineMode === 'distance'} onChange={e => setBaselineMode(e.target.checked ? 'distance' : 'dynamic')} disabled={isProcessing} className="accent-emerald-500" id="baseline-toggle" />
            <label htmlFor="baseline-toggle" className="cursor-pointer">Fix baseline to distance-only</label>
          </div>
        </div>
        <div>
          <label className="mb-2 block text-xs font-bold uppercase tracking-wider text-slate-500">Image Fallback</label>
          <div className={clsx('rounded-md border-2 border-dashed border-slate-800 p-4 transition-colors', images.length ? 'border-emerald-500/30 bg-emerald-950/20' : 'hover:border-slate-600')}>
            <label className="flex cursor-pointer flex-col items-center">
              <Upload className={clsx('mb-2 h-6 w-6', images.length ? 'text-emerald-400' : 'text-slate-600')} />
              <span className="text-xs text-slate-500">{images.length ? `${images.length} image${images.length > 1 ? 's' : ''} attached` : 'Upload traffic / incident image'}</span>
              <input type="file" className="hidden" onChange={handleImageChange} accept="image/*" multiple disabled={isProcessing} />
            </label>
          </div>
          {images.length > 0 && (
            <div className="mt-2 space-y-1">
              {images.map((img, index) => (
                <div key={index} className="flex items-center justify-between rounded border border-slate-800 bg-slate-950/60 px-2 py-1 text-[11px]">
                  <span className="mr-2 truncate">{img.name}</span>
                  <button type="button" className="text-slate-500 hover:text-red-400" onClick={() => setImages(prev => prev.filter((_, i) => i !== index))}>
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        <button onClick={handleOptimizeClick} disabled={isProcessing || !stops.trim()} className={clsx('flex w-full items-center justify-center rounded-md px-4 py-3 font-bold transition-all', isProcessing ? 'cursor-not-allowed bg-slate-800 text-slate-500' : 'bg-emerald-600 text-white shadow-lg shadow-emerald-900/20 hover:bg-emerald-500')}>
          {isProcessing ? <span className="flex items-center">Preparing proposal...</span> : <><Play className="mr-2 h-4 w-4" />PROPOSE ROUTE</>}
        </button>
            </div>
          )}
        </div>
        {result?.comparison && <div className={clsx('rounded-md border px-3 py-3 text-xs', result.comparison.status === 'improved' ? 'border-emerald-500/30 bg-emerald-950/20 text-emerald-200' : result.comparison.status === 'worsened' ? 'border-red-500/30 bg-red-950/20 text-red-200' : result.comparison.status === 'validated' ? 'border-blue-500/30 bg-blue-950/20 text-blue-200' : 'border-amber-500/30 bg-amber-950/20 text-amber-200')}><div className="font-bold uppercase tracking-wider">{result.comparison.headline}</div><div className="mt-1 text-[11px]">{result.comparison.detail}</div></div>}
        {result ? (
          <div className="space-y-3 rounded-md border border-violet-500/20 bg-violet-950/10 p-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-violet-300"><Sparkles className="h-3.5 w-3.5" />{previewActive ? 'Adjustment Preview' : 'Route Review'}</div>
                <div className="mt-2 text-sm font-semibold text-slate-100">{result.decisionSummary?.title ?? 'Route proposal is ready for review'}</div>
                <div className="mt-1 text-xs text-slate-400">{result.decisionSummary?.summary ?? 'Review the recommendation before approving or requesting a change.'}</div>
                {result.organizationName || result.scenarioLabel ? (
                  <div className="mt-2 text-[11px] text-slate-500">
                    {result.organizationName ?? 'Organization'}{result.scenarioLabel ? ` / ${result.scenarioLabel}` : ''}{result.routeDate ? ` / ${result.routeDate}` : ''}
                  </div>
                ) : null}
              </div>
              <div className={clsx('rounded-full border px-2 py-1 font-mono text-[10px] uppercase tracking-wider', result.decisionStatus === 'approved' ? 'border-emerald-500/40 bg-emerald-950/20 text-emerald-300' : result.decisionStatus === 'updated_proposal' ? 'border-violet-500/40 bg-violet-950/20 text-violet-300' : 'border-slate-700 bg-slate-950/60 text-slate-300')}>
                {decisionStateLabel(result.decisionStatus)}
              </div>
            </div>
            <div className="space-y-2 rounded border border-slate-800 bg-slate-950/50 p-3">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Dispatcher knowledge</div>
              <div className="grid grid-cols-2 gap-2">
                {TRIBAL_TAGS.map(tag => (
                  <button
                    key={tag.code}
                    type="button"
                    disabled={isProcessing}
                    className={clsx('rounded border px-2 py-2 text-left text-[11px] transition-colors', selectedTag === tag.code ? 'border-emerald-500/40 bg-emerald-950/20 text-emerald-200' : 'border-slate-800 bg-slate-950/60 text-slate-400 hover:border-slate-700')}
                    onClick={() => setSelectedTag(tag.code)}
                  >
                    <div className="font-semibold">{tag.label}</div>
                    <div className="mt-1 text-[10px] text-slate-500">{tag.detail}</div>
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {ADJUSTMENT_OPTIONS.map(option => (
                <button
                  key={option.type}
                  type="button"
                  disabled={isProcessing}
                  className={clsx('rounded border px-2 py-2 text-[11px] transition-colors', selectedAdjustment.type === option.type ? 'border-violet-500/40 bg-violet-950/20 text-violet-200' : 'border-slate-800 bg-slate-950/60 text-slate-400 hover:border-slate-700')}
                  onClick={() => setSelectedAdjustment(option)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <textarea
              value={adjustmentNote}
              onChange={event => setAdjustmentNote(event.target.value)}
              disabled={isProcessing}
              className="h-20 w-full resize-none rounded border border-slate-800 bg-slate-950/80 px-3 py-2 text-xs text-slate-300 outline-none focus:border-violet-500"
              placeholder="Optional dispatcher note. Example: avoid the school pickup window near this customer."
            />
            {previewActive && result.overrideDelta ? (
              <div className="space-y-2 rounded border border-amber-500/30 bg-amber-950/15 p-3 text-xs text-amber-100">
                <div className="flex items-center justify-between">
                  <div className="font-bold uppercase tracking-wider text-amber-300">Override Cost Delta</div>
                  <span className="font-mono text-[10px] uppercase tracking-wider text-amber-200">{result.overrideDelta.direction}</span>
                </div>
                <div>{result.overrideDelta.summary}</div>
                <div className="grid grid-cols-2 gap-2 font-mono text-[11px]">
                  <div>Time: {result.overrideDelta.timeMin >= 0 ? '+' : ''}{result.overrideDelta.timeMin.toFixed(1)} min</div>
                  <div>Distance: {result.overrideDelta.distanceKm >= 0 ? '+' : ''}{result.overrideDelta.distanceKm.toFixed(2)} km</div>
                  <div>Emissions: {result.overrideDelta.emissionsKg >= 0 ? '+' : ''}{result.overrideDelta.emissionsKg.toFixed(3)} kg</div>
                  <div>Fuel cost: {result.overrideDelta.estimatedFuelCost >= 0 ? '+' : ''}${Math.abs(result.overrideDelta.estimatedFuelCost).toFixed(2)}</div>
                </div>
                {shouldShowNegotiatedAlternatives ? (
                  <div className="space-y-2 rounded border border-amber-400/25 bg-slate-950/50 p-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-semibold text-amber-200">This override adds cost.</div>
                      <button
                        type="button"
                        className="rounded border border-amber-400/30 px-2 py-1 text-left text-[11px] font-semibold text-amber-100 hover:bg-amber-950/30"
                        onClick={() => setAlternativesOpen(prev => !prev)}
                      >
                        {alternativesOpen ? 'Hide safer alternatives' : 'ReasonRoute found safer alternatives'}
                      </button>
                    </div>
                    {alternativesOpen ? (
                      <div className="space-y-2">
                        {negotiatedAlternatives.map(alternative => (
                          <div key={alternative.id} className="rounded border border-slate-700/80 bg-slate-950/70 p-2">
                            <div className="flex items-start justify-between gap-2">
                              <div>
                                <div className="font-bold text-slate-100">{alternative.label}</div>
                                <div className="mt-1 text-[11px] leading-5 text-slate-400">{alternative.summary}</div>
                              </div>
                              <span className={clsx('rounded border px-2 py-1 font-mono text-[10px] uppercase', alternative.delta.direction === 'better' ? 'border-emerald-500/30 text-emerald-300' : alternative.delta.direction === 'worse' ? 'border-red-500/30 text-red-300' : 'border-amber-500/30 text-amber-300')}>
                                {alternative.delta.direction}
                              </span>
                            </div>
                            <div className="mt-2 grid grid-cols-2 gap-1 font-mono text-[10px] text-slate-300">
                              <div>Time {signed(alternative.delta.timeMin)} min</div>
                              <div>Distance {signed(alternative.delta.distanceKm, 2)} km</div>
                              <div>Emissions {signed(alternative.delta.emissionsKg, 3)} kg</div>
                              <div>Fuel {alternative.delta.estimatedFuelCost >= 0 ? '+' : ''}${Math.abs(alternative.delta.estimatedFuelCost).toFixed(2)}</div>
                            </div>
                            <button
                              type="button"
                              disabled={isProcessing}
                              className="mt-2 w-full rounded border border-violet-500/40 bg-violet-950/20 px-3 py-2 text-[11px] font-semibold text-violet-100 transition-colors hover:bg-violet-950/35"
                              onClick={() => onUseAlternative(alternative.result)}
                            >
                              Use This Alternative
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <div className="grid grid-cols-2 gap-2">
                  <button type="button" disabled={isProcessing} className="rounded border border-violet-500/40 bg-violet-950/20 px-3 py-2 text-sm font-semibold text-violet-200 transition-colors hover:bg-violet-950/35" onClick={onConfirmAdjustment}>
                    Confirm Adjustment
                  </button>
                  <button type="button" disabled={isProcessing} className="rounded border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm font-semibold text-slate-300 transition-colors hover:bg-slate-800" onClick={onCancelAdjustmentPreview}>
                    Keep Current Proposal
                  </button>
                </div>
              </div>
            ) : null}
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={isProcessing || result.decisionStatus === 'approved' || previewActive}
                className={clsx('flex items-center justify-center rounded border px-3 py-2 text-sm font-semibold transition-colors', result.decisionStatus === 'approved' ? 'border-slate-800 bg-slate-900 text-slate-500' : 'border-emerald-500/40 bg-emerald-950/20 text-emerald-200 hover:bg-emerald-950/35')}
                onClick={onApprove}
              >
                <CheckCircle2 className="mr-2 h-4 w-4" />Approve Route
              </button>
              <button
                type="button"
                disabled={isProcessing || previewActive}
                className="flex items-center justify-center rounded border border-violet-500/40 bg-violet-950/20 px-3 py-2 text-sm font-semibold text-violet-200 transition-colors hover:bg-violet-950/35"
                onClick={queueAdjustmentReview}
              >
                <RefreshCcw className="mr-2 h-4 w-4" />Request Adjustment
              </button>
            </div>
            <div className="space-y-1 text-[11px] text-slate-500">
              <div>{result.decisionSummary?.reviewPrompt ?? 'Review the route rationale below before dispatch.'}</div>
              {selectedTagMeta ? <div className="text-slate-400">Captured tribal signal: <span className="font-semibold text-slate-300">{selectedTagMeta.label}</span> - {selectedTagMeta.detail}.</div> : null}
            </div>
            {result.previousProposal ? (
              <div className="rounded border border-slate-800 bg-slate-950/60 px-3 py-2 text-[11px] text-slate-400">
                Previous proposal: {result.previousProposal.metrics.optimized.distance.toFixed(1)} km, {result.previousProposal.metrics.optimized.time.toFixed(1)} min.
              </div>
            ) : null}
            {result.overrideDelta ? (
              <div className="rounded border border-slate-800 bg-slate-950/60 px-3 py-2 text-[11px] text-slate-300">
                <div className="mb-1 font-bold uppercase tracking-wider text-slate-500">Applied override delta</div>
                <div>{result.overrideDelta.summary}</div>
              </div>
            ) : null}
            {result.driverMessage ? (
              <div className="rounded border border-blue-500/20 bg-blue-950/10 px-3 py-2 text-[11px] text-blue-100">
                <div className="mb-1 font-bold uppercase tracking-wider text-blue-300">Driver-facing explanation</div>
                <div>{result.driverMessage}</div>
              </div>
            ) : null}
            {result.organizationComparison ? (
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded border border-emerald-500/20 bg-emerald-950/10 px-3 py-2 text-[11px] text-emerald-100">
                  <div className="mb-1 font-bold uppercase tracking-wider text-emerald-300">Historical Comparison</div>
                  <div>{result.organizationComparison.headline}</div>
                  <div className="mt-1 text-emerald-200/80">{result.organizationComparison.detail}</div>
                </div>
                <div className="rounded border border-sky-500/20 bg-sky-950/10 px-3 py-2 text-[11px] text-sky-100">
                  <div className="mb-1 font-bold uppercase tracking-wider text-sky-300">Decision Verdict</div>
                  <div>{result.overrideAnalysis?.headline ?? 'Evidence pending'}</div>
                  <div className="mt-1 text-sky-200/80">{result.overrideAnalysis?.detail}</div>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
        {result?.routeWarnings?.length ? <div className="space-y-1 rounded-md border border-amber-500/30 bg-amber-950/20 px-3 py-2 text-xs text-amber-200">{result.routeWarnings.map((warning, index) => <div key={index} className="flex items-start gap-2"><AlertCircle className="mt-0.5 h-3 w-3" /><span>{warning}</span></div>)}</div> : null}
        <div className="flex h-64 flex-col">
          <div className="mb-2 flex items-center justify-between">
            <label className="flex items-center text-xs font-bold uppercase tracking-wider text-slate-500"><Terminal className="mr-1 h-3 w-3" />{showDebugLogs ? 'Debug Logs' : 'Why This Route'}</label>
            <button type="button" className="font-mono text-[10px] text-slate-500 hover:text-slate-300" onClick={() => setShowDebugLogs(prev => !prev)}>{showDebugLogs ? 'Show route rationale' : 'Show debug'}</button>
          </div>
          <div ref={logContainerRef} className="flex-1 space-y-2 overflow-y-auto rounded-md border border-slate-800 bg-slate-950 p-3 font-mono text-xs">
            {status === ProcessingStatus.IDLE && <div className="italic text-slate-600">Ready to review a route proposal...</div>}
            {showDebugLogs
              ? (result?.engineLogs ?? []).map((log, index) => <div key={index} className="flex gap-2"><span className="text-emerald-500/50">[{String(index).padStart(2, '0')}]</span><span className="text-slate-400">{log}</span></div>)
              : reasoningEvidence.map((line, index) => (
                  <div key={index} className="rounded border border-slate-800 bg-slate-900/60 px-3 py-2">
                    <div className="mb-1 text-[10px] uppercase tracking-wider text-violet-300">Evidence {String(index + 1).padStart(2, '0')}</div>
                    <div className="font-sans text-sm leading-6 text-slate-200">{line}</div>
                  </div>
                ))}
          </div>
        </div>
        <div className="space-y-3 rounded-md border border-slate-800 bg-slate-950/35 p-3">
          <div className="flex items-center justify-between">
            <label className="text-xs font-bold uppercase tracking-wider text-slate-500">Pilot Evidence</label>
            <span className="font-mono text-[10px] text-slate-500">proof / routes / diagnostics / exports</span>
          </div>
          <div className="grid grid-cols-4 gap-2">
            {([
              ['pilot', 'Pilot Evidence'],
              ['routes', 'Routes'],
              ['diagnostics', 'Diagnostics'],
              ['exports', 'Exports'],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={clsx('rounded border px-2 py-2 text-[10px] font-semibold uppercase tracking-wider transition-colors', evidencePanel === key ? 'border-violet-500/40 bg-violet-950/20 text-violet-200' : 'border-slate-800 bg-slate-950/60 text-slate-400 hover:border-slate-700')}
                onClick={() => setEvidencePanel(key)}
              >
                {label}
              </button>
            ))}
          </div>

          {evidencePanel === 'pilot' ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded border border-slate-800 bg-slate-950/70 p-3">
                  <div className="text-[10px] uppercase tracking-wider text-slate-500">Run count</div>
                  <div className="mt-1 font-mono text-xl text-slate-100">{pilotAggregate?.runCount ?? pilotReport?.runCount ?? history.length}</div>
                </div>
                <div className="rounded border border-slate-800 bg-slate-950/70 p-3">
                  <div className="text-[10px] uppercase tracking-wider text-slate-500">Scenario count</div>
                  <div className="mt-1 font-mono text-xl text-slate-100">{pilotAggregate?.scenarioCount ?? 0}</div>
                </div>
                <div className="rounded border border-slate-800 bg-slate-950/70 p-3">
                  <div className="text-[10px] uppercase tracking-wider text-slate-500">Distance saved</div>
                  <div className="mt-1 font-mono text-xl text-emerald-300">{((pilotAggregate?.cumulativeDistanceSavedKm ?? pilotReport?.distanceDeltaKm) ?? 0).toFixed(1)} km</div>
                </div>
                <div className="rounded border border-slate-800 bg-slate-950/70 p-3">
                  <div className="text-[10px] uppercase tracking-wider text-slate-500">Time saved</div>
                  <div className="mt-1 font-mono text-xl text-emerald-300">{((pilotAggregate?.cumulativeTimeSavedMin ?? pilotReport?.timeDeltaMin) ?? 0).toFixed(1)} min</div>
                </div>
              </div>
              <div className="rounded border border-slate-800 bg-slate-950/70 p-3 text-[11px] text-slate-400">
                <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">Session evidence</div>
                <div>Reroutes: {pilotReport?.rerouteCount ?? 0} | Approved proposals: {pilotReport?.approvedCount ?? 0} | Emissions delta: {(pilotReport?.emissionsDeltaKg ?? 0).toFixed(3)} kg CO2</div>
                {pilotAggregate ? (
                  <div className="mt-2">
                    Historical comparisons: {pilotAggregate.historicalComparisonCount} | System correct: {pilotAggregate.systemCorrectCount} | Dispatcher correct: {pilotAggregate.dispatcherCorrectCount} | Third alternative: {pilotAggregate.thirdAlternativeCount}
                  </div>
                ) : null}
              </div>
              {result?.proofReport ? (
                <div className="rounded border border-slate-800 bg-slate-950/70 p-3 text-[11px] text-slate-300">
                  <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">Replay Proof Report</div>
                  <div className="font-semibold text-slate-100">{result.proofReport.organizationComparison?.headline ?? result.proofReport.internalBaselineComparison.headline}</div>
                  <div className="mt-1 text-slate-400">{result.proofReport.overrideAnalysis.detail}</div>
                  <div className="mt-2 grid grid-cols-2 gap-2 font-mono text-[10px]">
                    <div>Distance delta: {result.proofReport.organizationComparison?.distance.delta ?? result.proofReport.internalBaselineComparison.distance.delta ?? 0}</div>
                    <div>Time delta: {result.proofReport.organizationComparison?.time.delta ?? result.proofReport.internalBaselineComparison.time.delta ?? 0}</div>
                    <div>Emissions delta: {result.proofReport.organizationComparison?.emissions.delta ?? result.proofReport.internalBaselineComparison.emissions.delta ?? 0}</div>
                    <div>Fuel delta: {result.proofReport.organizationComparison?.fuelCost?.delta ?? result.proofReport.internalBaselineComparison.fuelCost?.delta ?? 0}</div>
                  </div>
                </div>
              ) : null}
              <div>
                <label className="mb-2 block text-xs font-bold uppercase tracking-wider text-slate-500">Recent Runs</label>
                <div className="max-h-36 space-y-2 overflow-y-auto rounded-md border border-slate-800 bg-slate-950 p-3">
                  {history.length === 0 && <div className="text-xs italic text-slate-600">No runs yet.</div>}
                  {history.map((run, index) => <div key={`${run.ts}-${index}`} className="flex items-center justify-between rounded border border-slate-800 bg-slate-900/60 px-2 py-1 text-[11px]"><div className="flex flex-col"><span className="font-mono text-slate-300">{new Date(run.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span><span className="text-slate-500">{run.vehicles} vehicles | {run.baseline.toFixed(1)} to {run.optimized.toFixed(1)} km</span></div><div className="font-mono text-emerald-400">{run.improvement.distancePct > 0 ? `-${run.improvement.distancePct}%` : `${run.improvement.distancePct}%`}</div></div>)}
                </div>
              </div>
            </div>
          ) : null}

          {evidencePanel === 'routes' && result ? (
            <div className="space-y-3">
              <div><div className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">Proposed Route Set</div><div className="space-y-2">{result.optimizedRoutes.map(route => <RouteCard key={`optimized-${route.routeId}`} route={route} tone="optimized" selected={result.routeFocus?.selectedRouteId === route.routeId} onClick={() => onSelectRoute(route.routeId)} />)}</div></div>
              <div><div className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">Baseline Comparison</div><div className="space-y-2">{result.baselineRoutes.map(route => <RouteCard key={`baseline-${route.routeId}`} route={route} tone="baseline" selected={result.routeFocus?.selectedRouteId === route.routeId} onClick={() => onSelectRoute(route.routeId)} />)}</div></div>
            </div>
          ) : null}

          {evidencePanel === 'diagnostics' && result?.diagnostics ? (
            <div className="space-y-1 rounded-md border border-slate-800 bg-slate-950/60 px-3 py-2 text-[11px]"><div className="text-xs font-bold uppercase tracking-wider text-slate-500">Decision Diagnostics</div><div className="flex justify-between"><span className="text-slate-500">Provider</span><span>{result.diagnostics.provider ?? 'unknown'}</span></div><div className="flex justify-between"><span className="text-slate-500">Traffic mode</span><span>{result.diagnostics.trafficMode ?? 'freeflow'}</span></div><div className="flex justify-between"><span className="text-slate-500">Routing</span><span>{result.diagnostics.routingStatus}</span></div><div className="flex justify-between"><span className="text-slate-500">Cache</span><span>{result.diagnostics.cacheStatus}</span></div><div className="flex justify-between"><span className="text-slate-500">Fallback legs</span><span>{result.diagnostics.fallbackLegCount}</span></div><div className="flex justify-between"><span className="text-slate-500">Geofence impact</span><span>{result.diagnostics.geofenceImpact}</span></div><div className="flex justify-between"><span className="text-slate-500">Optimize time</span><span>{result.diagnostics.optimizationTimeMs ?? 0} ms</span></div><div className="flex justify-between"><span className="text-slate-500">Road routing</span><span>{result.diagnostics.roadRoutingTimeMs ?? 0} ms</span></div><div className="flex justify-between"><span className="text-slate-500">Total processing</span><span>{result.diagnostics.totalProcessingTimeMs ?? 0} ms</span></div><div className="flex justify-between"><span className="text-slate-500">Dispatcher SLA</span><span>{result.diagnostics.dispatcherReady ? 'under 30s' : 'over 30s'}</span></div></div>
          ) : null}

          {evidencePanel === 'exports' ? (
            <div className="space-y-2">
              <button onClick={exportFleetHtml} disabled={!result} className="flex w-full items-center justify-center rounded border border-slate-700 px-3 py-2 text-xs font-medium text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"><Download className="mr-2 h-4 w-4" />Export Route_Decision.html</button>
              <button onClick={exportFleetJson} disabled={!result} className="flex w-full items-center justify-center rounded border border-slate-700 px-3 py-2 text-xs font-medium text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"><Download className="mr-2 h-4 w-4" />Export Route_Decision.json</button>
              <button onClick={exportVehicleManifests} disabled={!result} className="flex w-full items-center justify-center rounded border border-slate-700 px-3 py-2 text-xs font-medium text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"><Download className="mr-2 h-4 w-4" />Export Vehicle Manifests</button>
              <button onClick={exportGeojson} disabled={!result} className="flex w-full items-center justify-center rounded border border-slate-700 px-3 py-2 text-xs font-medium text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"><Download className="mr-2 h-4 w-4" />Export Route_Geometry.geojson</button>
            </div>
          ) : null}
        </div>
      </div>
      <div className="border-t border-slate-800 bg-slate-900/50 p-4">
        <div className="rounded border border-slate-800 bg-slate-950/50 px-3 py-2 text-[11px] text-slate-500">
          Route review stays visible above. Pilot evidence, diagnostics, route sets, and exports stay grouped below so the dispatcher can negotiate the proposal without losing context.
        </div>
      </div>
    </div>
  );
};

export default Sidebar;


