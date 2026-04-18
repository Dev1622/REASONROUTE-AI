import React, { useEffect, useState } from 'react';
import Sidebar from './components/Sidebar';
import MapVisualization from './components/MapVisualization';
import MetricsDashboard from './components/MetricsDashboard';
import { fetchConfigStatus, optimizeViaApi, rerouteViaApi } from './services/apiClient';
import { AppConfigStatus, DisplayFilters, FleetConfig, Geofence, OptimizationResult, ProcessingStatus, RouteFocus } from './types';

const App: React.FC = () => {
  const [status, setStatus] = useState<ProcessingStatus>(ProcessingStatus.IDLE);
  const [result, setResult] = useState<OptimizationResult | null>(null);
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
    { ts: string; improvement: OptimizationResult['metrics']['improvement']; baseline: number; optimized: number; vehicles: number }[]
  >([]);
  const [configStatus, setConfigStatus] = useState<AppConfigStatus | null>(null);
  const [metricsCollapsed, setMetricsCollapsed] = useState(false);

  useEffect(() => {
    fetchConfigStatus().then(setConfigStatus).catch(() => setConfigStatus(null));
  }, []);

  useEffect(() => {
    setResult(prev => (prev ? { ...prev, displayFilters, routeFocus } : prev));
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

  const applyResult = (nextResult: OptimizationResult) => {
    const selectedRouteId = routeFocus.selectedRouteId ?? nextResult.optimizedRoutes?.[0]?.routeId;
    setResult({
      ...nextResult,
      displayFilters,
      routeFocus: {
        ...routeFocus,
        selectedRouteId,
      },
    });
    setStatus(ProcessingStatus.COMPLETE);
    setHistory(prev => [
      {
        ts: new Date().toISOString(),
        improvement: nextResult.metrics.improvement,
        baseline: nextResult.metrics.baseline.distance,
        optimized: nextResult.metrics.optimized.distance,
        vehicles: nextResult.fleetConfig?.vehicleCount ?? nextResult.optimizedRoutes.length,
      },
      ...prev,
    ].slice(0, 6));
  };

  const handleOptimization = async (
    stopsInput: string,
    images: File[],
    preferences?: { weightTime?: number; weightEmissions?: number; weightDistance?: number },
    optimization?: { mode?: 'fast' | 'quality'; timeBudgetMs?: number; baselineMode?: 'dynamic' | 'distance' },
    fleet?: FleetConfig
  ) => {
    setStatus(ProcessingStatus.ANALYZING);
    setErrorMessage(null);
    setResult(null);

    try {
      const encodedImages = await encodeImages(images);
      const apiResult = await optimizeViaApi({
        stopsText: stopsInput,
        images: encodedImages,
        preferences,
        optimization,
        fleet,
      });
      applyResult(apiResult);
    } catch (error: any) {
      console.error(error);
      setErrorMessage(error?.message ?? 'Optimization failed.');
      setStatus(ProcessingStatus.ERROR);
    }
  };

  const handleReroute = async (overrides: { geofences?: Geofence[] }) => {
    if (!result) return;
    setStatus(ProcessingStatus.OPTIMIZING);
    setErrorMessage(null);

    try {
      const nextResult = await rerouteViaApi({
        result,
        geofences: overrides.geofences ?? result.geofences,
      });
      applyResult(nextResult);
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
          onSelectRoute={selectedRouteId => setRouteFocus(prev => ({ ...prev, selectedRouteId, fitToActiveRoute: true }))}
          status={status}
          result={result}
          history={history}
          errorMessage={errorMessage}
          configStatus={configStatus}
        />
      </div>

      <div className="relative flex h-full flex-1 flex-col">
        <div className="relative flex-1 p-4">
          <div className="h-full w-full overflow-hidden rounded-xl border border-slate-800/50 bg-slate-900/50 shadow-2xl backdrop-blur-sm">
            <MapVisualization
              data={result}
              loading={status !== ProcessingStatus.IDLE && status !== ProcessingStatus.COMPLETE && status !== ProcessingStatus.ERROR}
              onGeofencesChange={geofences => handleReroute({ geofences })}
              filters={displayFilters}
              focus={routeFocus}
              onFiltersChange={setDisplayFilters}
              onFocusChange={setRouteFocus}
            />
          </div>

          <div className="absolute left-8 top-8 rounded border border-slate-700 bg-slate-900/80 px-3 py-1 text-xs font-mono text-slate-400 backdrop-blur">
            FRAMEWORK: <span className="text-blue-400">SPATIAL-REASONING</span>
          </div>
          <div className="pointer-events-none absolute inset-x-6 bottom-6 z-30">
            {result && result.metrics ? (
              <div className="pointer-events-auto rounded-2xl border border-slate-800 bg-slate-900 p-4 shadow-[0_20px_60px_-25px_rgba(0,0,0,0.75)]">
                <div className="mb-3 flex items-center justify-between">
                  <div className="text-xs font-bold uppercase tracking-wider text-slate-500">Performance Metrics</div>
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
                    <span>{result.comparison?.headline ?? 'Fleet metrics ready'}</span>
                    <span className="text-slate-500">Distance {result.metrics.optimized.distance.toFixed(1)} km</span>
                    <span className="text-slate-500">Time {result.metrics.optimized.time.toFixed(1)} min</span>
                    <span className="text-slate-500">{result.optimizedRoutes.length} routes</span>
                  </div>
                ) : (
                  <MetricsDashboard
                    baseline={result.metrics.baseline}
                    optimized={result.metrics.optimized}
                    improvement={result.metrics.improvement}
                    comparison={result.comparison}
                    routeCount={result.optimizedRoutes.length}
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
