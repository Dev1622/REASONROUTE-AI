import { runReasonRouteEngine } from '../services/reasonRouteEngine';
import type { Node } from '../services/baslineSolver';

function assert(label: string, condition: boolean, extra?: string): void {
  if (!condition) {
    throw new Error(`${label}${extra ? ` -> ${extra}` : ''}`);
  }
  console.log(`ok ${label}`);
}

function buildUrbanNodes(): Node[] {
  const depot: Node = { id: 'depot', x: 50, y: 50, type: 'depot', label: 'Central Hub' };
  const rings = [
    { count: 18, radius: 12 },
    { count: 18, radius: 24 },
    { count: 14, radius: 34 },
  ];

  const stops: Node[] = [];
  let idx = 1;
  for (const ring of rings) {
    for (let i = 0; i < ring.count; i += 1) {
      const angle = (i / ring.count) * Math.PI * 2 + (idx % 3) * 0.08;
      const x = +(50 + ring.radius * Math.cos(angle) + ((idx % 5) - 2) * 1.1).toFixed(2);
      const y = +(50 + ring.radius * Math.sin(angle) + ((idx % 4) - 1.5) * 1.1).toFixed(2);
      stops.push({ id: `s${idx}`, x, y, type: 'stop', label: `Stop ${idx}` });
      idx += 1;
    }
  }

  return [depot, ...stops];
}

const nodes = buildUrbanNodes();
const result = runReasonRouteEngine({
  nodes,
  depotId: 'depot',
  preferences: {
    weightTime: 0.6,
    weightEmissions: 0.2,
    weightDistance: 0.2,
  },
  optimization: {
    mode: 'quality',
    timeBudgetMs: 120,
  },
});

assert('tour starts at depot', result.optimizedPath[0] === 'depot');
assert('tour ends at depot', result.optimizedPath[result.optimizedPath.length - 1] === 'depot');
assert(
  'optimized composite stays within baseline guardrail',
  result.metrics.optimized.composite <= result.metrics.baseline.composite * 1.02,
  `baseline=${result.metrics.baseline.composite.toFixed(2)} optimized=${result.metrics.optimized.composite.toFixed(2)}`
);
assert(
  'optimized distance does not materially regress',
  result.metrics.optimized.distance <= result.metrics.baseline.distance * 1.01,
  `baseline=${result.metrics.baseline.distance.toFixed(2)} optimized=${result.metrics.optimized.distance.toFixed(2)}`
);

console.log('large urban sanity complete');
