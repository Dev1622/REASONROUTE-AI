import React, { useState, useEffect, useRef } from 'react';
import { Upload, Play, Download, Terminal, AlertCircle, FileJson } from 'lucide-react';
import clsx from 'clsx';
import { OptimizationResult, ProcessingStatus } from '../types';

interface SidebarProps {
  onOptimize: (stops: string, image: File | null) => void;
  status: ProcessingStatus;
  result: OptimizationResult | null;
}

const DEFAULT_STOPS = `Warehouse A (Hub)
District 1 - North Market
District 2 - Tech Park
District 3 - Residential Zone B
District 4 - Old Port
District 5 - Downtown Core
Warehouse B (Hub)
`;

const Sidebar: React.FC<SidebarProps> = ({ onOptimize, status, result }) => {
  const [stops, setStops]           = useState(DEFAULT_STOPS);
  const [image, setImage]           = useState<File | null>(null);
  const [jsonFileName, setJsonFileName] = useState<string | null>(null);
  const logContainerRef             = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [result?.logs, status]);

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.[0]) setImage(e.target.files[0]);
  };

  // ── JSON Upload handler ────────────────────────────────────────
  // Accepts two JSON shapes without breaking the existing text pipeline:
  //
  //   Shape A — EngineInput  { nodes: [{id, x, y, label?}], depotId, ... }
  //             Converts nodes to "Label, x, y" CSV lines the text parser handles.
  //
  //   Shape B — Array of stop objects  [{name/label, x?, y?}]  or strings
  //             Same CSV conversion.
  //
  //   Shape C — Any other JSON (e.g. burning-city full payload with trafficHeatmap)
  //             Extracts the nodes array if present and treats everything else
  //             as a raw text fallback so no data is lost.
  //
  // The text area is the canonical input — JSON just pre-populates it.
  // ──────────────────────────────────────────────────────────────
  const handleJsonUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setJsonFileName(file.name);

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const raw    = reader.result as string;
        const parsed = JSON.parse(raw);

        let csvLines: string[] = [];

        const nodeToCSV = (n: any): string => {
          const label = n.label ?? n.name ?? n.id ?? 'Stop';
          if (typeof n.x === 'number' && typeof n.y === 'number') {
            return `${label}, ${n.x}, ${n.y}`;
          }
          return String(label);
        };

        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          // Shape A: EngineInput — has a nodes array
          if (Array.isArray(parsed.nodes)) {
            csvLines = parsed.nodes.map(nodeToCSV);
          } else {
            // Unknown object — pretty-print so user can see it
            setStops(JSON.stringify(parsed, null, 2));
            return;
          }
        } else if (Array.isArray(parsed)) {
          // Shape B: array of stops
          csvLines = parsed.map((item: any) =>
            typeof item === 'string' ? item : nodeToCSV(item)
          );
        } else {
          setStops(raw);
          return;
        }

        setStops(csvLines.join('\n'));
      } catch {
        // Not valid JSON — load as plain text
        setStops(reader.result as string);
      }
    };
    reader.readAsText(file);
    e.target.value = ''; // allow re-upload of same file
  };

  const handleExport = () => {
    if (!result) return;
    const dataStr =
      'data:text/json;charset=utf-8,' +
      encodeURIComponent(JSON.stringify(result, null, 2));
    const a = document.createElement('a');
    a.setAttribute('href', dataStr);
    a.setAttribute('download', 'Driver_Manifest.json');
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const isProcessing =
    status !== ProcessingStatus.IDLE &&
    status !== ProcessingStatus.COMPLETE &&
    status !== ProcessingStatus.ERROR;

  return (
    <div className="flex flex-col h-full bg-slate-900 border-r border-slate-800 text-slate-300">

      {/* Header */}
      <div className="p-6 border-b border-slate-800">
        <h1 className="text-2xl font-bold bg-gradient-to-r from-blue-400 to-emerald-400 bg-clip-text text-transparent">
          ReasonRoute AI
        </h1>
        <p className="text-xs text-slate-500 font-mono mt-1">SPATIAL-REASONING ENGINE v2.5</p>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-6">

        {/* Input Section */}
        <div className="space-y-4">

          {/* Stops label row: title + JSON upload button */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-bold uppercase tracking-wider text-slate-500">
                Delivery Stops (CSV/Text)
              </label>

              {/* JSON upload — sits inline with the label, no layout disruption */}
              <label
                className={clsx(
                  'flex items-center gap-1.5 text-[10px] font-mono px-2 py-1 rounded border cursor-pointer transition-colors select-none',
                  isProcessing
                    ? 'border-slate-800 text-slate-700 cursor-not-allowed'
                    : 'border-slate-700 text-slate-400 hover:text-emerald-400 hover:border-emerald-500/50 active:scale-95'
                )}
                title="Upload a JSON file (EngineInput format or array of stops)"
              >
                <FileJson className="w-3 h-3 flex-shrink-0" />
                <span>{jsonFileName ? jsonFileName.slice(0, 14) + (jsonFileName.length > 14 ? '…' : '') : 'Upload JSON'}</span>
                <input
                  type="file"
                  className="hidden"
                  accept=".json,application/json"
                  onChange={handleJsonUpload}
                  disabled={isProcessing}
                />
              </label>
            </div>

            <textarea
              className="w-full h-32 bg-slate-950 border border-slate-800 rounded-md p-3 text-sm font-mono focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 outline-none resize-none text-slate-300"
              value={stops}
              onChange={(e) => setStops(e.target.value)}
              disabled={isProcessing}
              placeholder={"One stop per line:\nLabel, x, y\n— or —\nUpload JSON above"}
            />
          </div>

          {/* Image upload (unchanged) */}
          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
              Context Awareness
            </label>
            <div className={clsx(
              'border-2 border-dashed border-slate-800 rounded-md p-4 transition-colors',
              image ? 'bg-emerald-950/20 border-emerald-500/30' : 'hover:border-slate-600'
            )}>
              <label className="flex flex-col items-center cursor-pointer">
                <Upload className={clsx('w-6 h-6 mb-2', image ? 'text-emerald-400' : 'text-slate-600')} />
                <span className="text-xs text-slate-500">
                  {image ? image.name : 'Upload Heatmap / Traffic Image'}
                </span>
                <input
                  type="file"
                  className="hidden"
                  onChange={handleImageChange}
                  accept="image/*"
                  disabled={isProcessing}
                />
              </label>
            </div>
            {image && (
              <p className="text-[10px] text-emerald-500/80 mt-1 flex items-center">
                <AlertCircle className="w-3 h-3 mr-1" />
                Spatial override enabled
              </p>
            )}
          </div>

          {/* Optimize button (unchanged) */}
          <button
            onClick={() => onOptimize(stops, image)}
            disabled={isProcessing}
            className={clsx(
              'w-full py-3 px-4 rounded-md flex items-center justify-center font-bold transition-all',
              isProcessing
                ? 'bg-slate-800 text-slate-500 cursor-not-allowed'
                : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-900/20'
            )}
          >
            {isProcessing ? (
              <span className="flex items-center">
                <svg className="animate-spin -ml-1 mr-3 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Processing...
              </span>
            ) : (
              <>
                <Play className="w-4 h-4 mr-2" />
                OPTIMIZE ROUTE
              </>
            )}
          </button>
        </div>

        {/* Gemini Reasoning Log (unchanged) */}
        <div className="flex flex-col h-64">
          <label className="flex items-center text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
            <Terminal className="w-3 h-3 mr-1" />
            Gemini Reasoning Log
          </label>
          <div
            ref={logContainerRef}
            className="flex-1 bg-slate-950 rounded-md border border-slate-800 p-3 overflow-y-auto font-mono text-xs space-y-1"
          >
            {status === ProcessingStatus.IDLE && (
              <div className="text-slate-600 italic">Ready to initialize framework...</div>
            )}
            {result?.logs.map((log, i) => (
              <div key={i} className="flex gap-2 animate-in fade-in duration-300">
                <span className="text-emerald-500/50">[{String(i).padStart(2, '0')}]</span>
                <span className={clsx(
                  log.toLowerCase().includes('rerouted') ? 'text-amber-400' :
                  log.toLowerCase().includes('optimized') ? 'text-emerald-300' :
                  'text-slate-400'
                )}>
                  {log}
                </span>
              </div>
            ))}
            {status === ProcessingStatus.ERROR && (
              <div className="text-red-500"> SYSTEM ERROR: Optimization failed.</div>
            )}
          </div>
        </div>
      </div>

      {/* Export (unchanged) */}
      <div className="p-4 border-t border-slate-800 bg-slate-900/50">
        <button
          onClick={handleExport}
          disabled={!result}
          className="w-full py-2 px-3 rounded border border-slate-700 hover:bg-slate-800 text-slate-400 hover:text-white transition-colors flex items-center justify-center text-xs font-medium"
        >
          <Download className="w-4 h-4 mr-2" />
          Export Driver_Manifest.json
        </button>
      </div>
    </div>
  );
};

export default Sidebar;