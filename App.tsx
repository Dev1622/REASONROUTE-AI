import React, { useEffect, useState } from 'react';
import Sidebar from './components/Sidebar';
import MapVisualization from './components/MapVisualization';
import MetricsDashboard from './components/MetricsDashboard';
import {
  fetchConfigStatus,
  fetchShadowPilotAggregate,
  getShadowPilotScenario,
  importShadowPilotScenario,
  listShadowPilotScenarios,
  optimizeViaApi,
  replayShadowPilotScenario,
  rerouteViaApi,
} from './services/apiClient';
import {
  AdjustmentRequest,
  AppConfigStatus,
  CompanyHistoricalMetricsBaseline,
  CompanyHistoricalRouteOutcome,
  DisplayFilters,
  FleetConfig,
  Geofence,
  OptimizationResult,
  PilotReportSnapshot,
  ProcessingStatus,
  RouteFocus,
  ShadowPilotAggregateSnapshot,
  ShadowPilotScenarioRecord,
  ShadowPilotScenarioSummary,
} from './types';

const App: React.FC = () => {
  const [status, setStatus] = useState<ProcessingStatus>(ProcessingStatus.IDLE);
  const [result, setResult] = useState<OptimizationResult | null>(null);
  const [previewResult, setPreviewResult] = useState<OptimizationResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [displayFilters, setDisplayFilters] = useState<DisplayFilters>({
    showBaseline: true,
    showOptimized: true,
    showLabels: true,
    showTraffic: false,
    upcomingStops: null,
  });
  const [routeFocus, setRouteFocus] = useState<RouteFocus>({
    fitToActiveRoute: true,
  });
  const [history, setHistory] = useState<
    { ts: string; improvement: OptimizationResult['metrics']['improvement']; baseline: number; optimized: number; vehicles: number; fallbackLegCount: number; rerouted: boolean; timeDelta: number; emissionsDelta: number }[]
  >([]);
  const [configStatus, setConfigStatus] = useState<AppConfigStatus | null>(null);
  const [metricsCollapsed, setMetricsCollapsed] = useState(false);
  const [approvalCount, setApprovalCount] = useState(0);
  const [rerouteCount, setRerouteCount] = useState(0);
  const [scenarios, setScenarios] = useState<ShadowPilotScenarioSummary[]>([]);
  const [pilotAggregate, setPilotAggregate] = useState<ShadowPilotAggregateSnapshot | null>(null);
  const [activeScenario, setActiveScenario] = useState<ShadowPilotScenarioRecord | null>(null);

  useEffect(() => {
    fetchConfigStatus().then(setConfigStatus).catch(() => setConfigStatus(null));
    listShadowPilotScenarios().then(setScenarios).catch(() => setScenarios([]));
    fetchShadowPilotAggregate().then(setPilotAggregate).catch(() => setPilotAggregate(null));
  }, []);

  useEffect(() => {
    setResult(prev => (prev ? { ...prev, displayFilters, routeFocus } : prev));
    setPreviewResult(prev => (prev ? { ...prev, displayFilters, routeFocus } : prev));
  }, [displayFilters, routeFocus]);

  const encodeImages = async (images: File[]) =>
    Promise.all(
      images.map(
        file =>
          new Promise<{ base64: string; mimeType: string }>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
              const content = reader.result as string;
              resolve({ base64: content.split(',')[1], mimeType: file.type });
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
          })
      )
    );

  const buildPilotReport = (
    nextResult: OptimizationResult,
    nextHistory: { ts: string; improvement: OptimizationResult['metrics']['improvement']; baseline: number; optimized: number; vehicles: number; fallbackLegCount: number; rerouted: boolean; timeDelta: number; emissionsDelta: number }[],
    nextRerouteCount: number,
    nextApprovalCount: number
  ): PilotReportSnapshot => {
    const runCount = nextHistory.length;
    const fallbackRuns = nextHistory.filter(entry => entry.fallbackLegCount > 0).length;
    return {
      runCount,
      rerouteCount: nextRerouteCount,
      approvedCount: nextApprovalCount,
      fallbackRatePct: runCount > 0 ? +((fallbackRuns / runCount) * 100).toFixed(1) : 0,
      distanceDeltaKm: +nextHistory.reduce((sum, entry) => sum + (entry.baseline - entry.optimized), 0).toFixed(2),
      timeDeltaMin: +nextHistory.reduce((sum, entry) => sum + entry.timeDelta, 0).toFixed(1),
      emissionsDeltaKg: +nextHistory.reduce((sum, entry) => sum + entry.emissionsDelta, 0).toFixed(3),
    };
  };

  const applyResult = (nextResult: OptimizationResult, overrides?: { rerouteCount?: number; approvalCount?: number }) => {
    const selectedRouteId = routeFocus.selectedRouteId ?? nextResult.optimizedRoutes?.[0]?.routeId;
    setPreviewResult(null);
    setHistory(prev => {
      const nextHistory = [
        {
          ts: new Date().toISOString(),
          improvement: nextResult.metrics.improvement,
          baseline: nextResult.metrics.baseline.distance,
          optimized: nextResult.metrics.optimized.distance,
          vehicles: nextResult.fleetConfig?.vehicleCount ?? nextResult.optimizedRoutes.length,
          fallbackLegCount: nextResult.diagnostics?.fallbackLegCount ?? 0,
          rerouted: nextResult.decisionStatus === 'updated_proposal',
          timeDelta: +(nextResult.metrics.baseline.time - nextResult.metrics.optimized.time).toFixed(1),
          emissionsDelta: +(nextResult.metrics.baseline.emissions - nextResult.metrics.optimized.emissions).toFixed(3),
        },
        ...prev,
      ].slice(0, 12);
      setResult({
        ...nextResult,
        pilotReport: buildPilotReport(nextResult, nextHistory, overrides?.rerouteCount ?? rerouteCount, overrides?.approvalCount ?? approvalCount),
        displayFilters,
        routeFocus: {
          ...routeFocus,
          selectedRouteId,
        },
      });
      setStatus(ProcessingStatus.COMPLETE);
      return nextHistory;
    });
  };
  const activeResult = previewResult ?? result;

  const buildBlockedRoadAdjustment = (currentGeofences: Geofence[] | undefined, nextGeofences: Geofence[]): AdjustmentRequest | undefined => {
    const previousCount = currentGeofences?.length ?? 0;
    if (nextGeofences.length > previousCount) {
      return {
        type: 'avoid_blocked_corridor',
        label: 'Avoid blocked corridor',
        reasonCode: 'blocked_corridor',
        note: 'Dispatcher marked a corridor to avoid on the live map.',
      };
    }
    return undefined;
  };

  const handleOptimization = async (
    stopsInput: string,
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
  ) => {
    setStatus(ProcessingStatus.ANALYZING);
    setErrorMessage(null);
    setResult(null);
    setPreviewResult(null);

    try {
      const encodedImages = await encodeImages(images);
      const apiResult = await optimizeViaApi({
        stopsText: stopsInput,
        images: encodedImages,
        preferences,
        optimization,
        fleet,
        ...scenarioMeta,
      });
      applyResult(apiResult);
    } catch (error: any) {
      console.error(error);
      setErrorMessage(error?.message ?? 'Optimization failed.');
      setStatus(ProcessingStatus.ERROR);
    }
  };

  const handleApprove = () => {
    if (previewResult) return;
    setApprovalCount(prev => prev + 1);
    setResult(prev =>
      prev
        ? {
            ...prev,
            decisionStatus: 'approved',
            pilotReport: prev.pilotReport
              ? {
                  ...prev.pilotReport,
                  approvedCount: prev.pilotReport.approvedCount + 1,
                }
              : prev.pilotReport,
            decisionSummary: prev.decisionSummary
              ? {
                  ...prev.decisionSummary,
                  title: 'Dispatcher approved the proposed route',
                  reviewPrompt: 'Approved for dispatch.',
                }
              : prev.decisionSummary,
          }
        : prev
    );
  };

  const handlePreviewAdjustment = async (adjustmentRequest: AdjustmentRequest) => {
    if (!result) return;
    setStatus(ProcessingStatus.OPTIMIZING);
    setErrorMessage(null);

    try {
      const nextPreview = await rerouteViaApi({
        result,
        geofences: result.geofences,
        adjustmentRequest,
        previewOnly: true,
      });
      setPreviewResult({
        ...nextPreview,
        pilotReport: result.pilotReport,
        displayFilters,
        routeFocus: {
          ...routeFocus,
          selectedRouteId: routeFocus.selectedRouteId ?? nextPreview.optimizedRoutes?.[0]?.routeId,
        },
      });
      setStatus(ProcessingStatus.COMPLETE);
    } catch (error: any) {
      console.error(error);
      setErrorMessage(error?.message ?? 'Adjustment preview failed.');
      setStatus(ProcessingStatus.ERROR);
    }
  };

  const refreshShadowPilotCollections = async () => {
    const [nextScenarios, nextAggregate] = await Promise.all([
      listShadowPilotScenarios().catch(() => []),
      fetchShadowPilotAggregate().catch(() => null),
    ]);
    setScenarios(nextScenarios);
    setPilotAggregate(nextAggregate);
  };

  const handleSaveScenario = async (payload: {
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
  }) => {
    setStatus(ProcessingStatus.ANALYZING);
    setErrorMessage(null);
    try {
      const scenario = await importShadowPilotScenario(payload);
      setActiveScenario(scenario);
      await refreshShadowPilotCollections();
      setStatus(ProcessingStatus.COMPLETE);
    } catch (error: any) {
      setErrorMessage(error?.message ?? 'Scenario import failed.');
      setStatus(ProcessingStatus.ERROR);
    }
  };

  const handleReplayScenario = async (scenarioId: string) => {
    setStatus(ProcessingStatus.OPTIMIZING);
    setErrorMessage(null);
    setPreviewResult(null);
    try {
      const [scenario, replayed] = await Promise.all([
        getShadowPilotScenario(scenarioId),
        replayShadowPilotScenario(scenarioId),
      ]);
      setActiveScenario(scenario);
      applyResult(replayed.result);
      await refreshShadowPilotCollections();
    } catch (error: any) {
      setErrorMessage(error?.message ?? 'Scenario replay failed.');
      setStatus(ProcessingStatus.ERROR);
    }
  };

  const handleConfirmPreview = () => {
    if (!previewResult) return;
    setRerouteCount(prev => prev + 1);
    applyResult(previewResult, { rerouteCount: rerouteCount + 1 });
  };

  const handleCancelPreview = () => {
    setPreviewResult(null);
    setStatus(ProcessingStatus.COMPLETE);
  };

  const handleUseAlternative = (alternativeResult: OptimizationResult) => {
    setPreviewResult({
      ...alternativeResult,
      pilotReport: result?.pilotReport ?? alternativeResult.pilotReport,
      displayFilters,
      routeFocus: {
        ...routeFocus,
        selectedRouteId: routeFocus.selectedRouteId ?? alternativeResult.optimizedRoutes?.[0]?.routeId,
      },
    });
    setStatus(ProcessingStatus.COMPLETE);
  };

  const handleReroute = async (overrides: { geofences?: Geofence[]; adjustmentRequest?: AdjustmentRequest }) => {
    if (!result) return;
    setPreviewResult(null);
    setStatus(ProcessingStatus.OPTIMIZING);
    setErrorMessage(null);

    try {
      const nextGeofences = overrides.geofences ?? result.geofences;
      const adjustmentRequest = overrides.adjustmentRequest ?? buildBlockedRoadAdjustment(result.geofences, nextGeofences ?? []);
      const nextRerouteCount = adjustmentRequest ? rerouteCount + 1 : rerouteCount;
      if (adjustmentRequest) {
        setRerouteCount(nextRerouteCount);
      }
      const nextResult = await rerouteViaApi({
        result,
        geofences: nextGeofences,
        adjustmentRequest,
      });
      applyResult(nextResult, { rerouteCount: nextRerouteCount });
    } catch (error: any) {
      console.error(error);
      setErrorMessage(error?.message ?? 'Road reroute failed.');
      setStatus(ProcessingStatus.ERROR);
    }
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-950 text-slate-200">
      <div className="w-[380px] lg:w-[32%] min-w-[320px] flex-shrink-0 z-10 shadow-2xl">
        <Sidebar
          onOptimize={handleOptimization}
          onSaveScenario={handleSaveScenario}
          onReplayScenario={handleReplayScenario}
          onApprove={handleApprove}
          onPreviewAdjustment={handlePreviewAdjustment}
          onConfirmAdjustment={handleConfirmPreview}
          onCancelAdjustmentPreview={handleCancelPreview}
          onUseAlternative={handleUseAlternative}
          onSelectRoute={selectedRouteId => setRouteFocus(prev => ({ ...prev, selectedRouteId, fitToActiveRoute: true }))}
          status={status}
          result={activeResult}
          previewActive={Boolean(previewResult)}
          history={history}
          errorMessage={errorMessage}
          configStatus={configStatus}
          scenarios={scenarios}
          pilotAggregate={pilotAggregate}
          activeScenario={activeScenario}
        />
      </div>

      <div className="relative flex h-full flex-1 flex-col">
        <div className="relative flex-1 p-4">
          <div className="h-full w-full overflow-hidden rounded-xl border border-slate-800/50 bg-slate-900/50 shadow-2xl backdrop-blur-sm">
            <MapVisualization
              data={activeResult}
              loading={status !== ProcessingStatus.IDLE && status !== ProcessingStatus.COMPLETE && status !== ProcessingStatus.ERROR}
              onGeofencesChange={geofences => handleReroute({ geofences })}
              filters={displayFilters}
              focus={routeFocus}
              onFiltersChange={setDisplayFilters}
              onFocusChange={setRouteFocus}
            />
          </div>

          <div className="absolute left-8 top-8 rounded border border-violet-500/20 bg-slate-900/85 px-3 py-1 text-xs font-mono text-slate-300 backdrop-blur">
            GLASS BOX REVIEW <span className="text-violet-300">|</span> NEGOTIATED ROUTING
          </div>
          <div className="pointer-events-none absolute inset-x-6 bottom-6 z-30">
            {activeResult && activeResult.metrics ? (
              <div className="pointer-events-auto rounded-2xl border border-slate-800 bg-slate-900 p-4 shadow-[0_20px_60px_-25px_rgba(0,0,0,0.75)]">
                <div className="mb-3 flex items-center justify-between">
                  <div className="text-xs font-bold uppercase tracking-wider text-slate-500">Proposal Decision Summary</div>
                  <button
                    type="button"
                    className="rounded border border-slate-700 px-2 py-1 text-[10px] font-mono text-slate-300 hover:bg-slate-800"
                    onClick={() => setMetricsCollapsed(prev => !prev)}
                  >
                    {metricsCollapsed ? 'Open' : 'Min'}
                  </button>
                </div>
                {metricsCollapsed ? (
                  <div className="flex flex-wrap items-center gap-4 text-sm font-mono text-slate-300">
                    <span>{activeResult.comparison?.headline ?? 'Proposal evidence ready'}</span>
                    <span className="text-slate-500">Distance {activeResult.metrics.optimized.distance.toFixed(1)} km</span>
                    <span className="text-slate-500">Time {activeResult.metrics.optimized.time.toFixed(1)} min</span>
                    <span className="text-slate-500">{activeResult.optimizedRoutes.length} vehicles</span>
                  </div>
                ) : (
                  <MetricsDashboard
                    baseline={activeResult.metrics.baseline}
                    optimized={activeResult.metrics.optimized}
                    improvement={activeResult.metrics.improvement}
                    comparison={activeResult.comparison}
                    routeCount={activeResult.optimizedRoutes.length}
                  />
                )}
              </div>
            ) : status !== ProcessingStatus.IDLE ? (
              <div className="pointer-events-auto flex h-24 items-center justify-center rounded-2xl border border-dashed border-slate-800 bg-slate-900 text-sm font-mono text-slate-600">
                {status === ProcessingStatus.COMPLETE ? 'Metrics unavailable' : 'Waiting for optimization results...'}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
};

export default App;
