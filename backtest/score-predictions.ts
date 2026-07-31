import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { observationsByVehicle, type VehicleObservation } from '../shared/profile.js';
import { expectedSnapshotGapSeconds, serviceElapsedMs } from '../bus-seat-collector/schedule.js';
import { loadSnapshots } from './data-source.js';

// 라이브 예측 채점. build-data.ts가 발행할 때마다 남긴 예측을, 나중에 실제로 관측된
// 좌석과 대조한다. 백테스트(backtest.ts)는 과거 데이터로 예측을 다시 만들어 채점하므로
// "그때 화면이 실제로 뭐라고 말했는가"는 검증하지 못한다. 낡은 프로파일이 배포됐거나
// 발행이 멈춘 종류의 문제는 여기서만 드러난다.

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDirectory, '..', '..');

// 예측 시각으로부터 이 시간 안에 대상 정류장에 도착하지 않으면 대조를 포기한다.
const matchWindowMs = 90 * 60_000;

// 신선도 경보 임계. 수집 간격 두 배(수집기가 스스로 재시도하는 한 사이클 공백은
// 봐준다)에 발행 워크플로 지연 여유를 더한다. 고정 임계(25분)를 쓰던 때는 수집이
// 성긴 시간대(낮 20분·창 밖 매시 1회)의 정상 발행이 전부 경보에 걸려, 검증
// 워크플로가 생긴 날부터 하루 수백 건씩 오탐을 냈다.
//
// 운행 시간 밖 발행은 채점하지 않는다. 수집도 승객도 없는 시간대라 낡은 게 정상이고
// 해가 없다. 실제로 자정 아카이브 크론이 밀리면 심야 발행은 이틀 전 데이터까지
// 물게 되는데, 아침 첫 수집이 오면 저절로 낫는다.
//
// 간격은 근거부터 발행까지 구간이 가로지르는 시대 중 가장 성긴 것을 쓴다. 끝점만
// 보면 새는 경우가 있다: 조밀 구간이 막 시작한 발행의 근거는 직전의 성긴 시대 것이
// 정상이라, 발행 시각 간격만으로는 그 경계마다 오탐이 난다.
// 나이도 운행 시간만 세서(serviceElapsedMs) 잰다 — 새벽 첫 발행이 그날 첫 수집보다
// 먼저 돌면 근거가 전날 저녁 스냅샷인 게 정상이기 때문이다.
const publishLagAllowanceMs = 15 * 60_000;

function stalenessAlarmMs(publishedMs: number, basisMs: number): number | null {
  if (expectedSnapshotGapSeconds(publishedMs) === null) return null;
  let sparsestGapSeconds: number | null = null;
  for (let cursor = basisMs; cursor <= publishedMs; cursor += 60_000) {
    const gap = expectedSnapshotGapSeconds(cursor);
    if (gap !== null && (sparsestGapSeconds === null || gap > sparsestGapSeconds)) sparsestGapSeconds = gap;
  }
  if (sparsestGapSeconds === null) return null;
  return sparsestGapSeconds * 2 * 1000 + publishLagAllowanceMs;
}

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
    if (age === null) {
      unknownBasis += 1;
    } else {
      const predictedAt = Date.parse(row.at);
      const alarmMs = stalenessAlarmMs(predictedAt, predictedAt - age);
      if (alarmMs !== null && serviceElapsedMs(predictedAt - age, predictedAt) > alarmMs) staleBasis += 1;
    }
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
  console.log(`근거 관측이 발행 시각 수집 주기보다 낡은 예측 ${staleBasis}건 · 근거를 못 찾은 예측 ${unknownBasis}건`);
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
