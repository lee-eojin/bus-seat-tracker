import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { observationsByVehicle, type VehicleObservation } from '../shared/profile.js';
import { loadSnapshots } from './data-source.js';

// 라이브 예측 채점. build-data.ts가 발행할 때마다 남긴 예측을, 나중에 실제로 관측된
// 좌석과 대조한다. 백테스트(backtest.ts)는 과거 데이터로 예측을 다시 만들어 채점하므로
// "그때 화면이 실제로 뭐라고 말했는가"는 검증하지 못한다. 낡은 프로파일이 배포됐거나
// 발행이 멈춘 종류의 문제는 여기서만 드러난다.

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDirectory, '..', '..');

// 예측 시각으로부터 이 시간 안에 대상 정류장에 도착하지 않으면 대조를 포기한다.
const matchWindowMs = 90 * 60_000;
// 예측이 근거로 삼은 관측이 이보다 낡았으면 발행 파이프라인을 의심한다.
const stalenessAlarmMs = 25 * 60_000;

interface Options {
  dataDirectory: string;
  predictionsDirectory: string;
  date: string | null;
  scorePath: string | null;
}

interface PredictionRow {
  at: string;
  route: string;
  vehicle: string;
  from: number;
  fromSeats: number;
  target: number;
  horizon: number;
  seats: number;
  boardable: number;
  lowConfidence: boolean;
}

function readArguments(argumentsList: string[]): Options {
  const options: Options = {
    dataDirectory: path.join(projectRoot, 'bus-seat-collector', 'data'),
    predictionsDirectory: path.join(projectRoot, 'predictions'),
    date: null,
    scorePath: null,
  };
  for (const argument of argumentsList) {
    const [name, value] = argument.split('=', 2);
    if (name === '--data-dir' && value) options.dataDirectory = path.resolve(value);
    if (name === '--predictions-dir' && value) options.predictionsDirectory = path.resolve(value);
    if (name === '--date' && value) options.date = value;
    if (name === '--json' && value) options.scorePath = path.resolve(value);
  }
  return options;
}

function isRow(value: unknown): value is PredictionRow {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return typeof row.at === 'string'
    && typeof row.route === 'string'
    && typeof row.vehicle === 'string'
    && typeof row.from === 'number'
    && typeof row.target === 'number'
    && typeof row.horizon === 'number'
    && typeof row.seats === 'number';
}

async function loadPredictions(directory: string, date: string): Promise<PredictionRow[]> {
  const fileNames = (await readdir(directory)).filter((name) => name === `${date}.jsonl`);
  const rows: PredictionRow[] = [];
  for (const fileName of fileNames) {
    for (const line of (await readFile(path.join(directory, fileName), 'utf8')).split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isRow(parsed)) rows.push(parsed);
      } catch {
        continue;
      }
    }
  }
  return rows;
}

interface Scored {
  row: PredictionRow;
  actualSeats: number;
  error: number;
  basisAgeMs: number | null;
}

// 예측 시각 이후 그 차량이 대상 정류장에 실제로 잡힌 첫 관측을 찾는다.
// 대상을 건너뛴 채 지나갔으면(샘플링 공백) 대조를 포기한다.
function matchActual(observations: VehicleObservation[], row: PredictionRow): VehicleObservation | null {
  const predictedAt = Date.parse(row.at);
  for (const observation of observations) {
    if (observation.time < predictedAt) continue;
    if (observation.time - predictedAt > matchWindowMs) return null;
    if (observation.sequence === row.target) return observation;
    if (observation.sequence > row.target) return null;
  }
  return null;
}

// 예측이 근거로 삼은 관측(출발 정류장·좌석)이 예측 시각 기준 얼마나 낡았는지.
function basisAge(observations: VehicleObservation[], row: PredictionRow): number | null {
  const predictedAt = Date.parse(row.at);
  let newest: number | null = null;
  for (const observation of observations) {
    if (observation.time > predictedAt) break;
    if (observation.sequence === row.from && observation.seats === row.fromSeats) newest = observation.time;
  }
  return newest === null ? null : predictedAt - newest;
}

function summarize(scored: Scored[]) {
  if (scored.length === 0) return { pairs: 0, mae: null, bias: null, boardableBrier: null };
  const absolute = scored.reduce((sum, item) => sum + Math.abs(item.error), 0);
  const signed = scored.reduce((sum, item) => sum + item.error, 0);
  const brier = scored.reduce((sum, item) => sum + (item.row.boardable - (item.actualSeats > 0 ? 1 : 0)) ** 2, 0);
  return {
    pairs: scored.length,
    mae: absolute / scored.length,
    bias: signed / scored.length,
    boardableBrier: brier / scored.length,
  };
}

async function main(): Promise<void> {
  const options = readArguments(process.argv.slice(2));
  const targetDate = options.date ?? toSeoulParts();
  const rows = await loadPredictions(options.predictionsDirectory, targetDate);
  if (rows.length === 0) {
    console.log(`${targetDate} 예측 기록이 없습니다: ${options.predictionsDirectory}`);
    return;
  }

  const routeNames = [...new Set(rows.map((row) => row.route))];
  const observationsByRoute = new Map<string, Map<string, VehicleObservation[]>>();
  for (const routeName of routeNames) {
    observationsByRoute.set(routeName, observationsByVehicle(await loadSnapshots(options.dataDirectory, routeName)));
  }

  const scored: Scored[] = [];
  let unmatched = 0;
  let staleBasis = 0;
  let unknownBasis = 0;
  for (const row of rows) {
    const observations = observationsByRoute.get(row.route)?.get(row.vehicle) ?? [];
    const actual = matchActual(observations, row);
    const age = basisAge(observations, row);
    if (age === null) unknownBasis += 1;
    else if (age > stalenessAlarmMs) staleBasis += 1;
    if (!actual) {
      unmatched += 1;
      continue;
    }
    scored.push({ row, actualSeats: actual.seats, error: row.seats - actual.seats, basisAgeMs: age });
  }

  const horizons = [...new Set(rows.map((row) => row.horizon))].sort((left, right) => left - right);
  const byHorizon = Object.fromEntries(
    horizons.map((horizon) => [horizon, summarize(scored.filter((item) => item.row.horizon === horizon))]),
  );

  const report = {
    date: targetDate,
    generatedAt: new Date().toISOString(),
    predictions: rows.length,
    scored: scored.length,
    unmatched,
    matchRate: rows.length > 0 ? scored.length / rows.length : 0,
    staleBasis,
    unknownBasis,
    overall: summarize(scored),
    byHorizon,
  };

  console.log('═'.repeat(70));
  console.log(`라이브 예측 채점 · ${targetDate}`);
  console.log('═'.repeat(70));
  console.log(`예측 ${rows.length}건 · 대조 성공 ${scored.length}건 (${(report.matchRate * 100).toFixed(1)}%) · 미대조 ${unmatched}건`);
  console.log(`근거 관측이 ${stalenessAlarmMs / 60_000}분 넘게 낡은 예측 ${staleBasis}건 · 근거를 못 찾은 예측 ${unknownBasis}건`);
  console.log('\n지평   n      MAE     편향   탑승가능 Brier');
  for (const horizon of horizons) {
    const metrics = byHorizon[String(horizon)];
    if (!metrics || metrics.pairs === 0) continue;
    console.log(
      `${String(horizon).padStart(3)}  ${String(metrics.pairs).padStart(5)}  ${metrics.mae!.toFixed(3).padStart(7)}  ${metrics.bias!.toFixed(3).padStart(7)}  ${metrics.boardableBrier!.toFixed(4).padStart(9)}`,
    );
  }
  const overall = report.overall;
  if (overall.pairs > 0) {
    console.log(`전체  ${String(overall.pairs).padStart(5)}  ${overall.mae!.toFixed(3).padStart(7)}  ${overall.bias!.toFixed(3).padStart(7)}  ${overall.boardableBrier!.toFixed(4).padStart(9)}`);
  }

  if (options.scorePath) {
    await writeFile(options.scorePath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\n채점 결과 저장: ${options.scorePath}`);
  }
}

function toSeoulParts(): string {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

main().catch((error: unknown) => {
  console.error(`라이브 예측 채점 실패: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
