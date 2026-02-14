import React, { useState, useEffect, useRef } from 'react';
import { Upload, FileText, Play, Download, Terminal, AlertCircle } from 'lucide-react';
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
  const [stops, setStops] = useState(DEFAULT_STOPS);
  const [image, setImage] = useState<File | null>(null);
  const logContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [result?.logs, status]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setImage(e.target.files[0]);
    }
  };

  const handleExport = () => {
    if (!result) return;
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(result, null, 2));
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute("href", dataStr);
    downloadAnchorNode.setAttribute("download", "Driver_Manifest.json");
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
  };

  const isProcessing = status !== ProcessingStatus.IDLE && status !== ProcessingStatus.COMPLETE && status !== ProcessingStatus.ERROR;

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
          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">Delivery Stops (CSV/Text)</label>
            <textarea
              className="w-full h-32 bg-slate-950 border border-slate-800 rounded-md p-3 text-sm font-mono focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 outline-none resize-none text-slate-300"
              value={stops}
              onChange={(e) => setStops(e.target.value)}
              disabled={isProcessing}
            />
          </div>

          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">Context Awareness</label>
            <div className={clsx(
              "border-2 border-dashed border-slate-800 rounded-md p-4 transition-colors",
              image ? "bg-emerald-950/20 border-emerald-500/30" : "hover:border-slate-600"
            )}>
              <label className="flex flex-col items-center cursor-pointer">
                <Upload className={clsx("w-6 h-6 mb-2", image ? "text-emerald-400" : "text-slate-600")} />
                <span className="text-xs text-slate-500">
                  {image ? image.name : "Upload Heatmap / Traffic Image"}
                </span>
                <input type="file" className="hidden" onChange={handleFileChange} accept="image/*" disabled={isProcessing} />
              </label>
            </div>
            {image && (
                <p className="text-[10px] text-emerald-500/80 mt-1 flex items-center">
                    <AlertCircle className="w-3 h-3 mr-1" />
                    Spatial override enabled
                </p>
            )}
          </div>

          <button
            onClick={() => onOptimize(stops, image)}
            disabled={isProcessing}
            className={clsx(
              "w-full py-3 px-4 rounded-md flex items-center justify-center font-bold transition-all",
              isProcessing 
                ? "bg-slate-800 text-slate-500 cursor-not-allowed"
                : "bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-900/20"
            )}
          >
            {isProcessing ? (
              <span className="flex items-center">
                <svg className="animate-spin -ml-1 mr-3 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
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

        {/* Logs Section */}
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
                        log.toLowerCase().includes("rerouted") ? "text-amber-400" :
                        log.toLowerCase().includes("optimized") ? "text-emerald-300" :
                        "text-slate-400"
                    )}>{log}</span>
                </div>
             ))}
             {status === ProcessingStatus.ERROR && (
                 <div className="text-red-500"> SYSTEM ERROR: Optimization failed.</div>
             )}
          </div>
        </div>
      </div>

      {/* Footer / Export */}
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
