import React from 'react';
import { Metrics, FleetComparison } from '../types';
import { ArrowDown, Clock, Leaf, Route, TrendingDown } from 'lucide-react';
import clsx from 'clsx';

interface MetricsDashboardProps {
  baseline: Metrics;
  optimized: Metrics;
  improvement?: { distancePct: number; timePct: number; emissionsPct: number };
  comparison?: FleetComparison;
  routeCount: number;
}

const MetricCard: React.FC<{
  label: string;
  base: number;
  opt: number;
  unit: string;
  icon: React.ReactNode;
  colorClass: string;
  percentOverride?: number;
}> = ({ label, base, opt, unit, icon, colorClass, percentOverride }) => {
  const percent = percentOverride !== undefined ? percentOverride.toFixed(1) : base !== 0 ? (((base - opt) / base) * 100).toFixed(1) : '0.0';
  return (
    <div className="rounded-xl border border-slate-700/80 bg-slate-900/70 p-3 backdrop-blur-sm">
      <div className="mb-2 flex items-center gap-2">
        <div className={clsx('rounded bg-slate-700/50 p-1.5', colorClass)}>{icon}</div>
        <span className="text-xs font-bold uppercase tracking-wider text-slate-400">{label}</span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-2xl font-bold text-slate-100">{opt}</span>
        <span className="font-mono text-xs text-slate-500">{unit}</span>
      </div>
      <div className="mt-2 flex items-center justify-between text-xs">
        <span className="line-through decoration-slate-600 text-slate-500">Base: {base}</span>
        <span className="flex items-center font-mono text-emerald-400"><ArrowDown className="mr-0.5 h-3 w-3" />{percent}%</span>
      </div>
    </div>
  );
};

const MetricsDashboard: React.FC<MetricsDashboardProps> = ({ baseline, optimized, improvement, comparison, routeCount }) => {
  return (
    <div className="space-y-3">
      {comparison && (
        <div className={clsx('rounded-xl border px-4 py-3 text-sm', comparison.status === 'improved' ? 'border-emerald-500/30 bg-emerald-950/15 text-emerald-200' : comparison.status === 'worsened' ? 'border-red-500/30 bg-red-950/15 text-red-200' : comparison.status === 'validated' ? 'border-blue-500/30 bg-blue-950/15 text-blue-200' : 'border-amber-500/30 bg-amber-950/15 text-amber-200')}>
          <div className="font-semibold">{comparison.headline}</div>
          <div className="mt-1 text-xs">{comparison.detail}</div>
        </div>
      )}
      <div className="grid w-full grid-cols-2 gap-3 xl:grid-cols-4">
        <MetricCard label="Proposed Distance" base={baseline.distance} opt={optimized.distance} unit="km" icon={<TrendingDown className="h-4 w-4 text-blue-400" />} colorClass="text-blue-400" percentOverride={improvement?.distancePct} />
        <MetricCard label="Proposed ETA" base={baseline.time} opt={optimized.time} unit="min" icon={<Clock className="h-4 w-4 text-amber-400" />} colorClass="text-amber-400" percentOverride={improvement?.timePct} />
        <MetricCard label="Proposed Emissions" base={baseline.emissions} opt={optimized.emissions} unit="kg CO2" icon={<Leaf className="h-4 w-4 text-emerald-400" />} colorClass="text-emerald-400" percentOverride={improvement?.emissionsPct} />
        <div className="rounded-xl border border-slate-700/80 bg-slate-900/70 p-3 backdrop-blur-sm">
          <div className="mb-2 flex items-center gap-2">
            <div className="rounded bg-slate-700/50 p-1.5 text-fuchsia-400"><Route className="h-4 w-4" /></div>
            <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Vehicles In Proposal</span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-2xl font-bold text-slate-100">{routeCount}</span>
            <span className="font-mono text-xs text-slate-500">vehicles</span>
          </div>
          <div className="mt-2 text-xs text-slate-500">These totals support the proposal story and give the dispatcher context before negotiating a change.</div>
        </div>
      </div>
    </div>
  );
};

export default MetricsDashboard;
