import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Download, FileJson, GripVertical, Play, Terminal, Upload, X } from 'lucide-react';
import clsx from 'clsx';
import { OptimizationResult, ProcessingStatus } from '../types';

interface SidebarProps {
  onOptimize: (
    stops: string,
    images: File[],
    preferences?: { weightTime?: number; weightEmissions?: number; weightDistance?: number },
    optimization?: { mode?: 'fast' | 'quality'; timeBudgetMs?: number; baselineMode?: 'dynamic' | 'distance' }
  ) => void;
  onApplyManualOrder: (manualRouteOrder: string[]) => void;
  onClearManualOverride: () => void;
  onSelectStop: (selectedStopId?: string) => void;
  status: ProcessingStatus;
  result: OptimizationResult | null;
  history: { ts: string; improvement: { distancePct: number; timePct: number; emissionsPct: number }; baseline: number; optimized: number }[];
  errorMessage?: string | null;
}

const SAMPLE_SCENARIOS = [
  {
    label: 'Geo demo',
    value: `Stop, Lat, Lng
Warehouse Hub, 12.9716, 77.5946
Indiranagar Drop, 12.9784, 77.6408
Koramangala Stop, 12.9352, 77.6245
HSR Layout Stop, 12.9116, 77.6474
BTM Layout Stop, 12.9166, 77.6101
Jayanagar Stop, 12.9250, 77.5938
Rajajinagar Stop, 12.9915, 77.5544`,
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

function buildManualList(result: OptimizationResult): string[] {
  const path = result.manualRouteOrder?.length ? result.manualRouteOrder : result.optimizedPath;
  if (path.length >= 2 && path[0] === path[path.length - 1]) {
    return path.slice(1, -1);
  }
  return path.slice(1);
}

const Sidebar: React.FC<SidebarProps> = ({
  onOptimize,
  onApplyManualOrder,
  onClearManualOverride,
  onSelectStop,
  status,
  result,
  history,
  errorMessage,
}) => {
  const [stops, setStops] = useState(SAMPLE_SCENARIOS[0].value);
  const [images, setImages] = useState<File[]>([]);
  const [jsonFileName, setJsonFileName] = useState<string | null>(null);
  const [weights, setWeights] = useState({
    weightTime: 0.5,
    weightEmissions: 0.3,
    weightDistance: 0.2,
  });
  const [optimization, setOptimization] = useState<{ mode: 'fast' | 'quality'; timeBudgetMs: number }>({
    mode: 'fast',
    timeBudgetMs: 40,
  });
  const [baselineMode, setBaselineMode] = useState<'dynamic' | 'distance'>('dynamic');
  const [manualStops, setManualStops] = useState<string[]>([]);
  const [draggedStopId, setDraggedStopId] = useState<string | null>(null);
  const logContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [result?.logs, status]);

  useEffect(() => {
    if (result) {
      setManualStops(buildManualList(result));
    }
  }, [result]);

  const isProcessing =
    status !== ProcessingStatus.IDLE &&
    status !== ProcessingStatus.COMPLETE &&
    status !== ProcessingStatus.ERROR;

  const nodeMap = useMemo(() => new Map(result?.nodes.map(node => [node.id, node]) ?? []), [result]);

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
        const raw = reader.result as string;
        const parsed = JSON.parse(raw);
        const nodeToCSV = (node: any) => {
          const label = node.label ?? node.name ?? node.id ?? 'Stop';
          if (typeof node.lat === 'number' && typeof node.lng === 'number') {
            return `${label}, ${node.lat}, ${node.lng}`;
          }
          if (typeof node.x === 'number' && typeof node.y === 'number') {
            return `${label}, ${node.x}, ${node.y}`;
          }
          return String(label);
        };

        if (Array.isArray(parsed)) {
          setStops(parsed.map(item => (typeof item === 'string' ? item : nodeToCSV(item))).join('\n'));
          return;
        }
        if (parsed && Array.isArray(parsed.nodes)) {
          setStops(parsed.nodes.map(nodeToCSV).join('\n'));
          return;
        }
        setStops(JSON.stringify(parsed, null, 2));
      } catch {
        setStops(reader.result as string);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const reorderManualStop = (sourceId: string, targetId: string) => {
    setManualStops(prev => {
      const sourceIndex = prev.indexOf(sourceId);
      const targetIndex = prev.indexOf(targetId);
      if (sourceIndex === -1 || targetIndex === -1 || sourceIndex === targetIndex) return prev;
      const copy = [...prev];
      const [moved] = copy.splice(sourceIndex, 1);
      copy.splice(targetIndex, 0, moved);
      return copy;
    });
  };

  const applyManualOrder = () => {
    if (!result || manualStops.length === 0) return;
    const basePath = result.aiOptimizedPath ?? result.optimizedPath;
    const depotStart = basePath[0];
    const depotEnd = basePath[basePath.length - 1] === depotStart ? basePath[basePath.length - 1] : undefined;
    const manualRouteOrder = depotEnd
      ? [depotStart, ...manualStops, depotEnd]
      : [depotStart, ...manualStops];
    onApplyManualOrder(manualRouteOrder);
  };

  const handleExport = () => {
    if (!result) return;
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(result, null, 2));
    const anchor = document.createElement('a');
    anchor.setAttribute('href', dataStr);
    anchor.setAttribute('download', 'Driver_Manifest.json');
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  };

  const handleExportGeojson = () => {
    if (!result) return;
    const featureForRoad = (label: string, road: OptimizationResult['baselineRoad']) =>
      road?.coordinates?.length
        ? {
            type: 'Feature',
            properties: { label, source: road.source },
            geometry: {
              type: 'LineString',
              coordinates: road.coordinates.map(([lat, lng]) => [lng, lat]),
            },
          }
        : null;

    const fallbackFeature = (path: string[], label: string) => ({
      type: 'Feature',
      properties: { label, source: 'node-order' },
      geometry: {
        type: 'LineString',
        coordinates: path
          .map(id => nodeMap.get(id))
          .filter(Boolean)
          .map(node =>
            result.coordinateMode === 'geo' && typeof node!.lng === 'number' && typeof node!.lat === 'number'
              ? [node!.lng, node!.lat]
              : [node!.x, node!.y]
          ),
      },
    });

    const geojson = {
      type: 'FeatureCollection',
      features: [
        featureForRoad('baseline', result.baselineRoad) ?? fallbackFeature(result.baselinePath, 'baseline'),
        featureForRoad(result.activeRouteLabel === 'manual' ? 'manual' : 'optimized', result.optimizedRoad) ??
          fallbackFeature(result.optimizedPath, result.activeRouteLabel === 'manual' ? 'manual' : 'optimized'),
      ],
    };

    const dataStr = 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(geojson, null, 2));
    const anchor = document.createElement('a');
    anchor.setAttribute('href', dataStr);
    anchor.setAttribute('download', 'Driver_Route.geojson');
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  };

  return (
    <div className="flex flex-col h-full bg-slate-900 border-r border-slate-800 text-slate-300">
      <div className="p-6 border-b border-slate-800">
        <h1 className="text-2xl font-bold bg-gradient-to-r from-blue-400 to-emerald-400 bg-clip-text text-transparent">
          ReasonRoute AI
        </h1>
        <p className="text-xs text-slate-500 font-mono mt-1">SPATIAL-REASONING ENGINE v2.5</p>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        <div className="space-y-4">
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-bold uppercase tracking-wider text-slate-500">Delivery Stops</label>
              <div className="flex items-center gap-2">
                {SAMPLE_SCENARIOS.map(sample => (
                  <button
                    key={sample.label}
                    type="button"
                    className="text-[10px] font-mono px-2 py-1 rounded border border-slate-700 text-slate-400 hover:text-emerald-300 hover:border-emerald-500/40 transition-colors"
                    onClick={() => setStops(sample.value)}
                    disabled={isProcessing}
                  >
                    {sample.label}
                  </button>
                ))}
                <label
                  className={clsx(
                    'flex items-center gap-1.5 text-[10px] font-mono px-2 py-1 rounded border cursor-pointer transition-colors select-none',
                    isProcessing
                      ? 'border-slate-800 text-slate-700 cursor-not-allowed'
                      : 'border-slate-700 text-slate-400 hover:text-emerald-400 hover:border-emerald-500/50'
                  )}
                >
                  <FileJson className="w-3 h-3 flex-shrink-0" />
                  <span>{jsonFileName ? jsonFileName.slice(0, 14) : 'Upload JSON'}</span>
                  <input
                    type="file"
                    className="hidden"
                    accept=".json,application/json"
                    onChange={handleJsonUpload}
                    disabled={isProcessing}
                  />
                </label>
              </div>
            </div>
            <textarea
              className="w-full h-36 bg-slate-950 border border-slate-800 rounded-md p-3 text-sm font-mono focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 outline-none resize-none text-slate-300"
              value={stops}
              onChange={e => setStops(e.target.value)}
              disabled={isProcessing}
              placeholder={'One stop per line:\nLabel, lat, lng\nor\nLabel, x, y'}
            />
            <p className="mt-2 text-[11px] text-slate-500">Road routing is enabled only for valid `lat,lng` rows.</p>
          </div>

          {errorMessage && (
            <div className="rounded-md border border-red-500/40 bg-red-950/20 px-3 py-2 text-xs text-red-300">
              {errorMessage}
            </div>
          )}

          {result?.validation?.warnings?.length ? (
            <div className="rounded-md border border-amber-500/30 bg-amber-950/20 px-3 py-2 text-xs text-amber-200 space-y-1">
              {result.validation.warnings.map((warning, index) => (
                <div key={index}>{warning}</div>
              ))}
            </div>
          ) : null}

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-bold uppercase tracking-wider text-slate-500">Preference Weights</label>
              <span className="text-[10px] text-slate-500 font-mono">Time / Emissions / Distance</span>
            </div>
            {([
              { key: 'weightTime', label: 'Time Priority' },
              { key: 'weightEmissions', label: 'Emissions Priority' },
              { key: 'weightDistance', label: 'Distance Priority' },
            ] as const).map(({ key, label }) => (
              <div key={key} className="flex items-center gap-3">
                <span className="w-28 text-[11px] text-slate-400">{label}</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={weights[key]}
                  onChange={e => setWeights(prev => ({ ...prev, [key]: Number(e.target.value) }))}
                  disabled={isProcessing}
                  className="flex-1 accent-emerald-500"
                />
                <span className="w-10 text-right text-[11px] font-mono text-slate-400">{weights[key].toFixed(2)}</span>
              </div>
            ))}
          </div>

          <div className="space-y-2 pt-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-bold uppercase tracking-wider text-slate-500">Optimization Mode</label>
              <span className="text-[10px] text-slate-500 font-mono">{optimization.mode}</span>
            </div>
            <div className="flex items-center gap-2 text-[11px] text-slate-400">
              <input
                type="checkbox"
                checked={optimization.mode === 'quality'}
                onChange={e => setOptimization(prev => ({ ...prev, mode: e.target.checked ? 'quality' : 'fast' }))}
                disabled={isProcessing}
                className="accent-emerald-500"
                id="quality-toggle"
              />
              <label htmlFor="quality-toggle" className="cursor-pointer">Enable quality search</label>
            </div>
            <div className="flex items-center gap-3">
              <span className="w-24 text-[11px] text-slate-400">Time budget (ms)</span>
              <input
                type="range"
                min={20}
                max={250}
                step={10}
                value={optimization.timeBudgetMs}
                onChange={e => setOptimization(prev => ({ ...prev, timeBudgetMs: Number(e.target.value) }))}
                disabled={isProcessing}
                className="flex-1 accent-emerald-500"
              />
              <span className="w-10 text-right text-[11px] font-mono text-slate-400">{optimization.timeBudgetMs}</span>
            </div>
            <div className="flex items-center gap-2 text-[11px] text-slate-400">
              <input
                type="checkbox"
                checked={baselineMode === 'distance'}
                onChange={e => setBaselineMode(e.target.checked ? 'distance' : 'dynamic')}
                disabled={isProcessing}
                className="accent-emerald-500"
                id="baseline-toggle"
              />
              <label htmlFor="baseline-toggle" className="cursor-pointer">Fix baseline to distance-only</label>
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">Image Fallback</label>
            <div className={clsx('border-2 border-dashed border-slate-800 rounded-md p-4 transition-colors', images.length ? 'bg-emerald-950/20 border-emerald-500/30' : 'hover:border-slate-600')}>
              <label className="flex flex-col items-center cursor-pointer">
                <Upload className={clsx('w-6 h-6 mb-2', images.length ? 'text-emerald-400' : 'text-slate-600')} />
                <span className="text-xs text-slate-500">
                  {images.length ? `${images.length} image${images.length > 1 ? 's' : ''} attached` : 'Upload traffic / incident image'}
                </span>
                <input
                  type="file"
                  className="hidden"
                  onChange={handleImageChange}
                  accept="image/*"
                  multiple
                  disabled={isProcessing}
                />
              </label>
            </div>
            {images.length > 0 && (
              <div className="mt-2 space-y-1">
                {images.map((img, index) => (
                  <div key={index} className="flex items-center justify-between text-[11px] bg-slate-950/60 border border-slate-800 rounded px-2 py-1">
                    <span className="truncate mr-2">{img.name}</span>
                    <button type="button" className="text-slate-500 hover:text-red-400" onClick={() => setImages(prev => prev.filter((_, i) => i !== index))}>
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <button
            onClick={() => onOptimize(stops, images, weights, { ...optimization, baselineMode })}
            disabled={isProcessing || !stops.trim()}
            className={clsx(
              'w-full py-3 px-4 rounded-md flex items-center justify-center font-bold transition-all',
              isProcessing ? 'bg-slate-800 text-slate-500 cursor-not-allowed' : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-900/20'
            )}
          >
            {isProcessing ? (
              <span className="flex items-center">Processing...</span>
            ) : (
              <>
                <Play className="w-4 h-4 mr-2" />
                OPTIMIZE ROUTE
              </>
            )}
          </button>
        </div>

        {result && result.coordinateMode === 'geo' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-xs font-bold uppercase tracking-wider text-slate-500">Manual Route Override</label>
              {result.overrideMode === 'manual_order' && (
                <button type="button" className="text-[10px] font-mono text-amber-300 hover:text-amber-200" onClick={onClearManualOverride}>
                  Clear override
                </button>
              )}
            </div>
            {result.routeSummary && (
              <div className="grid grid-cols-2 gap-2 text-[11px]">
                <div className="rounded border border-slate-800 bg-slate-950/60 px-2 py-2">
                  <div className="text-slate-500">First stop</div>
                  <div className="text-slate-200 truncate">{result.routeSummary.firstStopLabel}</div>
                </div>
                <div className="rounded border border-slate-800 bg-slate-950/60 px-2 py-2">
                  <div className="text-slate-500">Last stop</div>
                  <div className="text-slate-200 truncate">{result.routeSummary.lastStopLabel}</div>
                </div>
                <div className="rounded border border-slate-800 bg-slate-950/60 px-2 py-2">
                  <div className="text-slate-500">Total legs</div>
                  <div className="text-slate-200">{result.routeSummary.totalLegs}</div>
                </div>
                <div className="rounded border border-slate-800 bg-slate-950/60 px-2 py-2">
                  <div className="text-slate-500">Longest leg</div>
                  <div className="text-slate-200">{result.routeSummary.longestLegKm.toFixed(1)} km</div>
                </div>
              </div>
            )}
            <div className="space-y-1 max-h-48 overflow-y-auto pr-1">
              {manualStops.map((nodeId, index) => (
                <div
                  key={nodeId}
                  draggable={!isProcessing}
                  onDragStart={() => setDraggedStopId(nodeId)}
                  onDragOver={event => event.preventDefault()}
                  onDrop={() => {
                    if (draggedStopId) reorderManualStop(draggedStopId, nodeId);
                    setDraggedStopId(null);
                  }}
                  onDragEnd={() => setDraggedStopId(null)}
                  onClick={() => onSelectStop(nodeId)}
                  className={clsx(
                    'flex items-center gap-2 rounded border px-2 py-2 text-[11px] cursor-pointer',
                    result.routeFocus?.selectedStopId === nodeId
                      ? 'border-emerald-500/50 bg-emerald-950/20'
                      : 'border-slate-800 bg-slate-950/60'
                  )}
                >
                  <GripVertical className="w-3 h-3 text-slate-500" />
                  <div className="flex h-5 w-5 items-center justify-center rounded-full bg-slate-800 text-[10px] font-bold text-slate-200">
                    {index + 1}
                  </div>
                  <div className="flex-1 text-slate-300 truncate">{nodeMap.get(nodeId)?.label ?? nodeId}</div>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={applyManualOrder}
              disabled={isProcessing || !result}
              className="w-full rounded border border-slate-700 px-3 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800"
            >
              Apply Manual Order
            </button>
          </div>
        )}

        {result?.routeWarnings?.length ? (
          <div className="rounded-md border border-amber-500/30 bg-amber-950/20 px-3 py-2 text-xs text-amber-200 space-y-1">
            {result.routeWarnings.map((warning, index) => (
              <div key={index} className="flex items-start gap-2">
                <AlertCircle className="w-3 h-3 mt-0.5" />
                <span>{warning}</span>
              </div>
            ))}
          </div>
        ) : null}

        {result?.diagnostics && (
          <div className="rounded-md border border-slate-800 bg-slate-950/60 px-3 py-2 text-[11px] space-y-1">
            <div className="text-xs font-bold uppercase tracking-wider text-slate-500">Routing Diagnostics</div>
            <div className="flex justify-between"><span className="text-slate-500">Routing</span><span>{result.diagnostics.routingStatus}</span></div>
            <div className="flex justify-between"><span className="text-slate-500">Cache</span><span>{result.diagnostics.cacheStatus}</span></div>
            <div className="flex justify-between"><span className="text-slate-500">Fallback legs</span><span>{result.diagnostics.fallbackLegCount}</span></div>
            <div className="flex justify-between"><span className="text-slate-500">Geofence impact</span><span>{result.diagnostics.geofenceImpact}</span></div>
          </div>
        )}

        <div className="flex flex-col h-64">
          <label className="flex items-center text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
            <Terminal className="w-3 h-3 mr-1" />
            Dispatcher-Friendly Reasoning
          </label>
          <div ref={logContainerRef} className="flex-1 bg-slate-950 rounded-md border border-slate-800 p-3 overflow-y-auto font-mono text-xs space-y-1">
            {status === ProcessingStatus.IDLE && <div className="text-slate-600 italic">Ready to initialize framework...</div>}
            {result?.logs.map((log, index) => (
              <div key={index} className="flex gap-2">
                <span className="text-emerald-500/50">[{String(index).padStart(2, '0')}]</span>
                <span className="text-slate-400">{log}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="flex flex-col">
          <label className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">Recent Runs</label>
          <div className="bg-slate-950 rounded-md border border-slate-800 p-3 space-y-2 max-h-36 overflow-y-auto">
            {history.length === 0 && <div className="text-slate-600 text-xs italic">No runs yet.</div>}
            {history.map((run, index) => (
              <div key={`${run.ts}-${index}`} className="flex items-center justify-between text-[11px] bg-slate-900/60 border border-slate-800 rounded px-2 py-1">
                <div className="flex flex-col">
                  <span className="text-slate-300 font-mono">{new Date(run.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  <span className="text-slate-500">{run.baseline.toFixed(1)} to {run.optimized.toFixed(1)} km</span>
                </div>
                <div className="text-emerald-400 font-mono">{run.improvement.distancePct > 0 ? `-${run.improvement.distancePct}%` : `${run.improvement.distancePct}%`}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="p-4 border-t border-slate-800 bg-slate-900/50 space-y-2">
        <button
          onClick={handleExport}
          disabled={!result}
          className="w-full py-2 px-3 rounded border border-slate-700 hover:bg-slate-800 text-slate-400 hover:text-white transition-colors flex items-center justify-center text-xs font-medium"
        >
          <Download className="w-4 h-4 mr-2" />
          Export Driver_Manifest.json
        </button>
        <button
          onClick={handleExportGeojson}
          disabled={!result}
          className="w-full py-2 px-3 rounded border border-slate-700 hover:bg-slate-800 text-slate-400 hover:text-white transition-colors flex items-center justify-center text-xs font-medium"
        >
          <Download className="w-4 h-4 mr-2" />
          Export Route.geojson
        </button>
      </div>
    </div>
  );
};

export default Sidebar;
