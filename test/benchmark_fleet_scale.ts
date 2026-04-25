import { optimizeRoute } from '../services/geminiService';

type Args = {
  stops: number;
  vehicles: number;
  repeats: number;
  budgetMs: number;
};

function parseArgs(argv: string[]): Args {
  const getNumber = (flag: string, fallback: number) => {
    const index = argv.indexOf(flag);
    if (index === -1) return fallback;
    const value = Number(argv[index + 1]);
    return Number.isFinite(value) ? value : fallback;
  };

  return {
    stops: getNumber('--stops', 100),
    vehicles: getNumber('--vehicles', 25),
    repeats: getNumber('--repeats', 3),
    budgetMs: getNumber('--budget-ms', 250),
  };
}

function buildSyntheticStops(stopCount: number): string {
  const lines = ['Depot, 50, 50'];
  for (let i = 0; i < stopCount; i += 1) {
    const ring = 12 + (i % 10) * 3.3;
    const angle = (i / Math.max(stopCount, 1)) * Math.PI * 2 * 3.2;
    const jitterX = ((i % 7) - 3) * 0.9;
    const jitterY = ((i % 5) - 2) * 0.8;
    const x = Math.max(5, Math.min(95, +(50 + ring * Math.cos(angle) + jitterX).toFixed(2)));
    const y = Math.max(5, Math.min(95, +(50 + ring * Math.sin(angle) + jitterY).toFixed(2)));
    lines.push(`Stop ${i + 1}, ${x}, ${y}`);
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stopsText = buildSyntheticStops(args.stops);
  const wallTimes: number[] = [];
  const optimizationTimes: number[] = [];

  for (let run = 0; run < args.repeats; run += 1) {
    const startedAt = Date.now();
    const result = await optimizeRoute(
      stopsText,
      [],
      {
        weightTime: 0.6,
        weightEmissions: 0.2,
        weightDistance: 0.2,
      },
      {
        mode: 'quality',
        timeBudgetMs: args.budgetMs,
      },
      {
        vehicleCount: args.vehicles,
      }
    );
    const wallTimeMs = Date.now() - startedAt;
    wallTimes.push(wallTimeMs);
    optimizationTimes.push(result.optimizationTimeMs ?? wallTimeMs);
    console.log(
      `run ${run + 1}: wall=${wallTimeMs}ms optimize=${result.optimizationTimeMs ?? 0}ms routes=${result.optimizedRoutes.length} distance=${result.metrics.optimized.distance.toFixed(2)}km`
    );
  }

  const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
  const max = (values: number[]) => Math.max(...values);
  const min = (values: number[]) => Math.min(...values);

  console.log('');
  console.log(`fleet-scale benchmark`);
  console.log(`stops=${args.stops} vehicles=${args.vehicles} repeats=${args.repeats} budgetMs=${args.budgetMs}`);
  console.log(`wall avg=${average(wallTimes).toFixed(1)}ms min=${min(wallTimes)}ms max=${max(wallTimes)}ms`);
  console.log(`opt avg=${average(optimizationTimes).toFixed(1)}ms min=${min(optimizationTimes)}ms max=${max(optimizationTimes)}ms`);
  console.log(`dispatcher target (<30s): ${max(wallTimes) < 30_000 ? 'PASS' : 'FAIL'}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
