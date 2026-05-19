import { promises as fs } from 'fs';
import path from 'path';
import {
  ShadowPilotAggregateSnapshot,
  ShadowPilotRunRecord,
  ShadowPilotScenarioRecord,
  ShadowPilotScenarioSummary,
} from '../types';

interface ShadowPilotStoreData {
  scenarios: ShadowPilotScenarioRecord[];
  runs: ShadowPilotRunRecord[];
}

const STORE_DIR = path.resolve(process.cwd(), 'data');
const STORE_PATH = path.join(STORE_DIR, 'shadow-pilot-store.json');

function createEmptyStore(): ShadowPilotStoreData {
  return {
    scenarios: [],
    runs: [],
  };
}

async function ensureStoreFile() {
  await fs.mkdir(STORE_DIR, { recursive: true });
  try {
    await fs.access(STORE_PATH);
  } catch {
    await fs.writeFile(STORE_PATH, JSON.stringify(createEmptyStore(), null, 2), 'utf8');
  }
}

async function readStore(): Promise<ShadowPilotStoreData> {
  await ensureStoreFile();
  const raw = await fs.readFile(STORE_PATH, 'utf8');
  try {
    const parsed = JSON.parse(raw) as Partial<ShadowPilotStoreData>;
    return {
      scenarios: Array.isArray(parsed.scenarios) ? parsed.scenarios : [],
      runs: Array.isArray(parsed.runs) ? parsed.runs : [],
    };
  } catch {
    return createEmptyStore();
  }
}

async function writeStore(data: ShadowPilotStoreData): Promise<void> {
  await ensureStoreFile();
  await fs.writeFile(STORE_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function buildScenarioSummary(record: ShadowPilotScenarioRecord, runs: ShadowPilotRunRecord[]): ShadowPilotScenarioSummary {
  const lastRun = runs
    .filter(run => run.scenarioId === record.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

  return {
    id: record.id,
    organizationName: record.organizationName,
    scenarioLabel: record.scenarioLabel,
    routeDate: record.routeDate,
    shiftLabel: record.shiftLabel,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    runCount: record.runIds.length,
    lastRunAt: lastRun?.createdAt,
    lastRunId: lastRun?.id ?? record.lastRunId,
  };
}

function sumMetric(values: Array<number | undefined | null>): number {
  return +values.reduce((sum, value) => sum + (Number.isFinite(value as number) ? Number(value) : 0), 0).toFixed(3);
}

export async function createShadowPilotScenario(
  input: Omit<ShadowPilotScenarioRecord, 'id' | 'createdAt' | 'updatedAt' | 'lastRunId' | 'runIds'>
): Promise<ShadowPilotScenarioRecord> {
  const store = await readStore();
  const now = new Date().toISOString();
  const scenario: ShadowPilotScenarioRecord = {
    ...input,
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    runIds: [],
  };
  store.scenarios.unshift(scenario);
  await writeStore(store);
  return scenario;
}

export async function listShadowPilotScenarios(): Promise<ShadowPilotScenarioSummary[]> {
  const store = await readStore();
  return store.scenarios.map(record => buildScenarioSummary(record, store.runs));
}

export async function getShadowPilotScenario(id: string): Promise<ShadowPilotScenarioRecord | undefined> {
  const store = await readStore();
  return store.scenarios.find(record => record.id === id);
}

export async function saveShadowPilotRun(run: ShadowPilotRunRecord): Promise<ShadowPilotRunRecord> {
  const store = await readStore();
  store.runs.unshift(run);
  if (run.scenarioId) {
    const scenario = store.scenarios.find(record => record.id === run.scenarioId);
    if (scenario) {
      scenario.lastRunId = run.id;
      scenario.updatedAt = run.createdAt;
      scenario.runIds = [run.id, ...scenario.runIds.filter(existing => existing !== run.id)];
    }
  }
  await writeStore(store);
  return run;
}

export async function listShadowPilotRuns(): Promise<ShadowPilotRunRecord[]> {
  const store = await readStore();
  return store.runs;
}

export async function getShadowPilotRun(id: string): Promise<ShadowPilotRunRecord | undefined> {
  const store = await readStore();
  return store.runs.find(run => run.id === id);
}

export async function getShadowPilotAggregate(): Promise<ShadowPilotAggregateSnapshot> {
  const store = await readStore();
  const organizations = new Set(store.scenarios.map(record => record.organizationName.trim().toLowerCase()).filter(Boolean));
  const latestRunAt = store.runs
    .map(run => run.createdAt)
    .sort((a, b) => b.localeCompare(a))[0];

  return {
    scenarioCount: store.scenarios.length,
    runCount: store.runs.length,
    organizationCount: organizations.size,
    latestRunAt,
    historicalComparisonCount: store.runs.filter(run => Boolean(run.report.organizationComparison)).length,
    systemCorrectCount: store.runs.filter(run => run.report.overrideAnalysis.classification === 'system_correct').length,
    dispatcherCorrectCount: store.runs.filter(run => run.report.overrideAnalysis.classification === 'dispatcher_correct').length,
    thirdAlternativeCount: store.runs.filter(run => run.report.overrideAnalysis.classification === 'third_alternative_exists').length,
    cumulativeDistanceSavedKm: +sumMetric(store.runs.map(run => run.report.organizationComparison?.distance.delta ?? run.report.internalBaselineComparison.distance.delta)).toFixed(2),
    cumulativeTimeSavedMin: +sumMetric(store.runs.map(run => run.report.organizationComparison?.time.delta ?? run.report.internalBaselineComparison.time.delta)).toFixed(1),
    cumulativeEmissionsSavedKg: +sumMetric(store.runs.map(run => run.report.organizationComparison?.emissions.delta ?? run.report.internalBaselineComparison.emissions.delta)).toFixed(3),
    cumulativeHistoricalFuelSavings: +sumMetric(store.runs.map(run => run.report.organizationComparison?.fuelCost?.delta)).toFixed(2),
  };
}

export async function getShadowPilotStorePath(): Promise<string> {
  await ensureStoreFile();
  return STORE_PATH;
}
