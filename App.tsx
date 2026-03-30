import React, { useEffect, useState } from 'react';
import Sidebar from './components/Sidebar';
import MapVisualization from './components/MapVisualization';
import MetricsDashboard from './components/MetricsDashboard';
import { optimizeViaApi, rerouteViaApi } from './services/apiClient';
import { DisplayFilters, Geofence, OptimizationResult, ProcessingStatus, RouteFocus } from './types';

const App: React.FC = () => {
  const [status, setStatus] = useState<ProcessingStatus>(ProcessingStatus.IDLE);
  const [result, setResult] = useState<OptimizationResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [displayFilters, setDisplayFilters] = useState<DisplayFilters>({
    showBaseline: true,
    showOptimized: true,
    showLabels: true,
    upcomingStops: null,
  });
  const [routeFocus, setRouteFocus] = useState<RouteFocus>({
    fitToActiveRoute: true,
  });
  const [history, setHistory] = useState<
    { ts: string; improvement: OptimizationResult['metrics']['improvement']; baseline: number; optimized: number }[]
  >([]);

  useEffect(() => {
    setResult(prev => {
      if (!prev) return prev;
      const selectedLegIndex = routeFocus.selectedLegIndex;
      const selectedStopEtaMin =
        selectedLegIndex !== undefined && prev.optimizedRoad
          ? +((prev.optimizedRoad.durationMin / Math.max(prev.optimizedPath.length - 1, 1)) * (selectedLegIndex + 1)).toFixed(1)
          : prev.routeSummary?.selectedStopEtaMin;

      return {
        ...prev,
        displayFilters,
        routeFocus,
        routeSummary: prev.routeSummary
          ? {
              ...prev.routeSummary,
              selectedStopEtaMin,
            }
          : prev.routeSummary,
      };
    });
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
    setResult({
      ...nextResult,
      displayFilters,
      routeFocus,
      routeSummary: nextResult.routeSummary
        ? {
            ...nextResult.routeSummary,
            selectedStopEtaMin:
              routeFocus.selectedLegIndex !== undefined && nextResult.optimizedRoad
                ? +((nextResult.optimizedRoad.durationMin / Math.max(nextResult.optimizedPath.length - 1, 1)) * (routeFocus.selectedLegIndex + 1)).toFixed(1)
                : nextResult.routeSummary.selectedStopEtaMin,
          }
        : nextResult.routeSummary,
    });
    setStatus(ProcessingStatus.COMPLETE);
    setHistory(prev => [
      {
        ts: new Date().toISOString(),
        improvement: nextResult.metrics.improvement,
        baseline: nextResult.metrics.baseline.distance,
        optimized: nextResult.metrics.optimized.distance,
      },
      ...prev,
    ].slice(0, 6));
  };

  const handleOptimization = async (
    stopsInput: string,
    images: File[],
    preferences?: { weightTime?: number; weightEmissions?: number; weightDistance?: number },
    optimization?: { mode?: 'fast' | 'quality'; timeBudgetMs?: number; baselineMode?: 'dynamic' | 'distance' }
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
      });
      applyResult(apiResult);
    } catch (error: any) {
      console.error(error);
      setErrorMessage(error?.message ?? 'Optimization failed.');
      setStatus(ProcessingStatus.ERROR);
    }
  };

  const handleReroute = async (overrides: { geofences?: Geofence[]; manualRouteOrder?: string[] }) => {
    if (!result) return;
    setStatus(ProcessingStatus.OPTIMIZING);
    setErrorMessage(null);

    try {
      const nextResult = await rerouteViaApi({
        result,
        geofences: overrides.geofences ?? result.geofences,
        manualRouteOrder: overrides.manualRouteOrder,
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
          onApplyManualOrder={manualRouteOrder => handleReroute({ manualRouteOrder })}
          onClearManualOverride={() => handleReroute({ manualRouteOrder: undefined })}
          onSelectStop={selectedStopId => setRouteFocus(prev => ({ ...prev, selectedStopId }))}
          status={status}
          result={result}
          history={history}
          errorMessage={errorMessage}
        />
      </div>

      <div className="flex-1 flex flex-col h-full relative">
        <div className="flex-1 p-6 relative">
          <div className="h-full w-full rounded-xl overflow-hidden shadow-2xl border border-slate-800/50 bg-slate-900/50 backdrop-blur-sm">
            <MapVisualization
              data={result}
              loading={status !== ProcessingStatus.IDLE && status !== ProcessingStatus.COMPLETE && status !== ProcessingStatus.ERROR}
              onGeofencesChange={geofences => handleReroute({ geofences, manualRouteOrder: result?.manualRouteOrder })}
              filters={displayFilters}
              focus={routeFocus}
              onFiltersChange={setDisplayFilters}
              onFocusChange={setRouteFocus}
            />
          </div>

          <div className="absolute top-10 left-10 bg-slate-900/80 backdrop-blur border border-slate-700 px-3 py-1 rounded text-xs font-mono text-slate-400">
            FRAMEWORK: <span className="text-blue-400">SPATIAL-REASONING</span>
          </div>
        </div>

        <div className="h-[180px] min-h-[180px] bg-slate-900 border-t border-slate-800 p-6 z-20 shadow-[0_-10px_40px_-15px_rgba(0,0,0,0.3)]">
          <h2 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-4">Performance Metrics</h2>
          {result && result.metrics ? (
            <MetricsDashboard
              baseline={result.metrics.baseline}
              optimized={result.metrics.optimized}
              improvement={result.metrics.improvement}
            />
          ) : (
            <div className="flex items-center justify-center h-24 border border-dashed border-slate-800 rounded-lg text-slate-600 text-sm font-mono">
              {status === ProcessingStatus.COMPLETE ? 'Metrics unavailable' : 'Waiting for optimization results...'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default App;
