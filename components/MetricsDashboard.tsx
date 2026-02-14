import React from 'react';
import { Metrics } from '../types';
import { ArrowDown, TrendingDown, Clock, Leaf } from 'lucide-react';
import clsx from 'clsx';

interface MetricsDashboardProps {
  baseline: Metrics;
  optimized: Metrics;
}

const MetricCard: React.FC<{ 
  label: string; 
  base: number; 
  opt: number; 
  unit: string; 
  icon: React.ReactNode;
  colorClass: string;
}> = ({ label, base, opt, unit, icon, colorClass }) => {
  const diff = base - opt;
  const percent = ((diff / base) * 100).toFixed(1);

  return (
    <div className="bg-slate-800/50 p-4 rounded-lg border border-slate-700 backdrop-blur-sm">
      <div className="flex items-center gap-2 mb-2">
        <div className={clsx("p-1.5 rounded bg-slate-700/50", colorClass)}>
          {icon}
        </div>
        <span className="text-slate-400 text-xs font-bold uppercase tracking-wider">{label}</span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-mono font-bold text-slate-100">{opt}</span>
        <span className="text-xs text-slate-500 font-mono">{unit}</span>
      </div>
      <div className="mt-2 flex justify-between items-center text-xs">
        <span className="text-slate-500 decoration-slate-600 line-through">Base: {base}</span>
        <span className="flex items-center text-emerald-400 font-mono">
          <ArrowDown className="w-3 h-3 mr-0.5" />
          {percent}%
        </span>
      </div>
    </div>
  );
};

const MetricsDashboard: React.FC<MetricsDashboardProps> = ({ baseline, optimized }) => {
  return (
    <div className="grid grid-cols-3 gap-4 w-full">
      <MetricCard 
        label="Total Distance" 
        base={baseline.distance} 
        opt={optimized.distance} 
        unit="km" 
        icon={<TrendingDown className="w-4 h-4 text-blue-400" />}
        colorClass="text-blue-400"
      />
      <MetricCard 
        label="Est. Time" 
        base={baseline.time} 
        opt={optimized.time} 
        unit="min" 
        icon={<Clock className="w-4 h-4 text-amber-400" />}
        colorClass="text-amber-400"
      />
      <MetricCard 
        label="Emissions" 
        base={baseline.emissions} 
        opt={optimized.emissions} 
        unit="kg CO₂" 
        icon={<Leaf className="w-4 h-4 text-emerald-400" />}
        colorClass="text-emerald-400"
      />
    </div>
  );
};

export default MetricsDashboard;
