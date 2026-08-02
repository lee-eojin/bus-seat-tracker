import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

// 신선도 판정. "발행 시점에 더 새 관측이 있었는데 낡은 근거를 썼는가"만 묻는다.
// 수집이 멎어 새 관측 자체가 없었다면 발행 잘못이 아니므로 여기 잡히지 않는다 —
// 그건 아래 수집 공백 검사가 따로 센다. 고정 임계(25분) 시절에는 수집이 성긴
// 시간대의 정상 발행이 전부 걸렸고, 수집 간격 기반 임계로 바꾼 뒤에도 크론 스로틀이
// 만든 수집 공백을 발행 탓으로 돌려 주말마다 오탐이 났다(2026-08-01, 124건).
//
// 운행 시간 밖 발행은 채점하지 않는다. 수집도 승객도 없는 시간대라 낡은 게 정상이고
// 해가 없다. 실제로 자정 아카이브 크론이 밀리면 심야 발행은 이틀 전 데이터까지
// 물게 되는데, 아침 첫 수집이 오면 저절로 낫는다.
//
// 여유 30분은 발행이 데이터를 클론한 뒤 예측을 만드는 사이에 새 스냅샷이 착지하는
// 경합을 흡수한다.
export const publishFreshnessAllowanceMs = 30 * 60_000;

/** 발행이 그 시점의 최신 관측 대신 낡은 근거를 썼는가. 운행 시간 밖 발행은 묻지 않는다. */
export function staleBasisAt(publishedMs: number, basisMs: number, latestAvailableMs: number | null): boolean {
  if (expectedSnapshotGapSeconds(publishedMs) === null) return false;
  if (latestAvailableMs === null) return false;
  return latestAvailableMs - basisMs > publishFreshnessAllowanceMs;
}

// 수집 공백 허용치. 관측 사이 간격(운행 시간만 합산)이 그 구간에서 기대되는 수집
// 간격의 두 배 + 15분을 넘으면 공백이다. 한 사이클 결손까지는 정상으로 본다.
// 구간이 가로지르는 시대 중 가장 성긴 것을 기준으로 잡아야 심야·조밀 경계에서
// 오탐이 없다.
export function gapToleranceMs(fromMs: number, toMs: number): number | null {
  let sparsestGapSeconds: number | null = null;
  for (let cursor = fromMs; cursor <= toMs; cursor += 60_000) {
    const gap = expectedSnapshotGapSeconds(cursor);
    if (gap !== null && (sparsestGapSeconds === null || gap > sparsestGapSeconds)) sparsestGapSeconds = gap;
  }
  if (sparsestGapSeconds === null) return null;
  return sparsestGapSeconds * 2 * 1000 + 15 * 60_000;
}

export function latestObservationAt(sortedTimes: number[], atMs: number): number | null {
  let low = 0;
  let high = sortedTimes.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (sortedTimes[mid]! <= atMs) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found >= 0 ? sortedTimes[found]! : null;
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
  const observationTimesByRoute = new Map<string, number[]>();
  for (const routeName of routeNames) {
    const byVehicle = observationsByVehicle(await loadSnapshots(options.dataDirectory, routeName));
    observationsByRoute.set(routeName, byVehicle);
    const times = new Set<number>();
    for (const list of byVehicle.values()) for (const observation of list) times.add(observation.time);
    observationTimesByRoute.set(routeName, [...times].sort((left, right) => left - right));
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
      const latestAvailable = latestObservationAt(observationTimesByRoute.get(row.route) ?? [], predictedAt);
      if (staleBasisAt(predictedAt, predictedAt - age, latestAvailable)) staleBasis += 1;
    }
    if (!actual) {
      unmatched += 1;
      continue;
    }
    scored.push({ row, actualSeats: actual.seats, error: row.seats - actual.seats, basisAgeMs: age });
  }

  // 수집 공백. 채점일에 끝나는 관측 간격만 본다 — 공백의 책임은 발행이 아니라
  // 수집(크론 스로틀, 단발 스냅샷 실패)에 있으므로 실패가 아니라 보고 대상이다.
  const dayStartMs = Date.parse(`${targetDate}T00:00:00+09:00`);
  const dayEndMs = dayStartMs + 24 * 3600 * 1000;
  const collectionGaps: Array<{ route: string; from: string; to: string; serviceMinutes: number }> = [];
  for (const [routeName, times] of observationTimesByRoute) {
    for (let index = 1; index < times.length; index += 1) {
      const from = times[index - 1]!;
      const to = times[index]!;
      if (to < dayStartMs || to >= dayEndMs) continue;
      const tolerance = gapToleranceMs(from, to);
      if (tolerance === null) continue;
      const elapsed = serviceElapsedMs(from, to);
      if (elapsed > tolerance) {
        collectionGaps.push({
          route: routeName,
          from: new Date(from).toISOString(),
          to: new Date(to).toISOString(),
          serviceMinutes: Math.round(elapsed / 60_000),
        });
      }
    }
  }
  collectionGaps.sort((left, right) => right.serviceMinutes - left.serviceMinutes);

  const horizons = [...new Set(rows.map((row) => row.horizon))].sort((left, right) => left - right);
  const byHorizon = Object.fromEntries(
    horizons.map((horizon) => [horizon, summarize(scored.filter((item) => item.row.horizon === horizon))]),
  );

  const targetDay = new Date(`${targetDate}T00:00:00Z`).getUTCDay();
  const report = {
    date: targetDate,
    weekend: targetDay === 0 || targetDay === 6,
    generatedAt: new Date().toISOString(),
    predictions: rows.length,
    scored: scored.length,
    unmatched,
    matchRate: rows.length > 0 ? scored.length / rows.length : 0,
    staleBasis,
    unknownBasis,
    collectionGaps,
    overall: summarize(scored),
    byHorizon,
  };

  console.log('═'.repeat(70));
  console.log(`라이브 예측 채점 · ${targetDate}`);
  console.log('═'.repeat(70));
  console.log(`예측 ${rows.length}건 · 대조 성공 ${scored.length}건 (${(report.matchRate * 100).toFixed(1)}%) · 미대조 ${unmatched}건`);
  console.log(`더 새 관측이 있는데 낡은 근거로 발행된 예측 ${staleBasis}건 · 근거를 못 찾은 예측 ${unknownBasis}건`);
  if (collectionGaps.length > 0) {
    const worst = collectionGaps[0]!;
    console.log(`수집 공백 ${collectionGaps.length}건 · 최대 ${worst.serviceMinutes}분 (${worst.route}, 운행 시간 기준)`);
  }
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

// 직접 실행일 때만 채점을 돌린다. 테스트가 정책 함수를 임포트할 때 부수 효과가 없어야 한다.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(`라이브 예측 채점 실패: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
