import React, { useState } from 'react';
import Sidebar from './components/Sidebar';
import MapVisualization from './components/MapVisualization';
import MetricsDashboard from './components/MetricsDashboard';
import { optimizeRoute } from './services/geminiService';
import { OptimizationResult, ProcessingStatus } from './types';

const App: React.FC = () => {
  const [status, setStatus] = useState<ProcessingStatus>(ProcessingStatus.IDLE);
  const [result, setResult] = useState<OptimizationResult | null>(null);
  const [history, setHistory] = useState<
    { ts: string; improvement: OptimizationResult['metrics']['improvement']; baseline: number; optimized: number }[]
  >([]);

  const handleOptimization = async (
    stopsInput: string,
    images: File[],
    preferences?: { weightTime?: number; weightEmissions?: number; weightDistance?: number }
  ) => {
    setStatus(ProcessingStatus.ANALYZING);
    setResult(null); // Reset previous results

    try {
      const encodedImages = await Promise.all(
        images.map(
          (file) =>
            new Promise<{ base64: string; mimeType: string }>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => {
                const result = reader.result as string;
                const base64 = result.split(',')[1];
                resolve({ base64, mimeType: file.type });
              };
              reader.onerror = reject;
              reader.readAsDataURL(file);
            })
        )
      );

      // Simulate step-by-step UI updates for effect (since API is single call)
      /*setTimeout(() => setStatus(ProcessingStatus.COMPRESSING), 1500);*/
      
      const apiResult = await optimizeRoute(stopsInput, encodedImages, preferences);
      
      setResult(apiResult);
      setStatus(ProcessingStatus.COMPLETE);
      setHistory(prev => [
        {
          ts: new Date().toISOString(),
          improvement: apiResult.metrics.improvement,
          baseline: apiResult.metrics.baseline.distance,
          optimized: apiResult.metrics.optimized.distance,
        },
        ...prev,
      ].slice(0, 6));

    } catch (error) {
      console.error(error);
      setStatus(ProcessingStatus.ERROR);
    }
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-950 text-slate-200">
      {/* Left Panel: 30% */}
      <div className="w-[350px] lg:w-[30%] min-w-[300px] flex-shrink-0 z-10 shadow-2xl">
        <Sidebar 
          onOptimize={handleOptimization} 
          status={status}
          result={result}
          history={history}
        />
      </div>

      {/* Right Panel: 70% */}
      <div className="flex-1 flex flex-col h-full relative">
        {/* Map Container */}
        <div className="flex-1 p-6 relative">
             <div className="h-full w-full rounded-xl overflow-hidden shadow-2xl border border-slate-800/50 bg-slate-900/50 backdrop-blur-sm">
                 <MapVisualization 
                    data={result} 
                    loading={status !== ProcessingStatus.IDLE && status !== ProcessingStatus.COMPLETE && status !== ProcessingStatus.ERROR} 
                 />
             </div>
             
             {/* Overlay Badge */}
             <div className="absolute top-10 left-10 bg-slate-900/80 backdrop-blur border border-slate-700 px-3 py-1 rounded text-xs font-mono text-slate-400">
                FRAMEWORK: <span className="text-blue-400">SPATIAL-REASONING</span>
             </div>
        </div>

        {/* Metrics Panel - Bottom Fixed within Right Panel */}
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
                     {status === ProcessingStatus.COMPLETE ? "Metrics unavailable" : "Waiting for optimization results..."}
                </div>
            )}
        </div>
      </div>
    </div>
  );
};

export default App;
