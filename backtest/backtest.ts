import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRouteCache, readSnapshot, type RouteCache, type Snapshot } from '../shared/model.js';
import {
  applyNetDemand,
  buildDeconvolvedProfileRoute,
  buildHistoryRoute,
  buildProfileRoute,
  defaultSeatCapacity,
  distributionMean,
  distributionQuantile,
  netDemandAt,
  observationsByVehicle,
  pairMaxGapMs,
  pointDistribution,
  splitRuns,
  toSeoulBucket,
  type VehicleObservation,
} from '../shared/profile.js';

// v2 §11.2 rolling-origin 백테스트 (층 1: 노선 좌석 상태).
// 과제: 결정 관측(seq x, 좌석 S_x)에서 같은 운행의 하류 관측(seq m) 도착 좌석을 예측하고
//       실제 S_m과 대조한다. 정답은 데이터가 스스로 준다(self-supervised).
// 학습 누수 차단: 프로파일은 test일 이전 날짜로만 학습한다.

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDirectory, '..', '..');

interface Options {
  dataDirectory: string;
}

function readArguments(argumentsList: string[]): Options {
  let dataDirectory = path.join(projectRoot, 'bus-seat-collector', 'data');
  for (const argument of argumentsList) {
    const [name, value] = argument.split('=', 2);
    if (name === '--data-dir' && value) dataDirectory = path.resolve(value);
  }
  return { dataDirectory };
}

function parseSnapshots(fileText: string): Snapshot[] {
  return fileText.split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const snapshot = readSnapshot(JSON.parse(line) as unknown);
      return snapshot ? [snapshot] : [];
    } catch {
      return [];
    }
  });
}

async function loadRouteCaches(dataDirectory: string): Promise<RouteCache[]> {
  const routesDirectory = path.join(dataDirectory, 'routes');
  const fileNames = await readdir(routesDirectory);
  const caches: RouteCache[] = [];
  for (const fileName of fileNames.filter((name) => name.endsWith('-stops.json'))) {
    const cache = readRouteCache(JSON.parse(await readFile(path.join(routesDirectory, fileName), 'utf8')) as unknown);
    if (cache) caches.push(cache);
  }
  return caches;
}

async function loadSnapshots(dataDirectory: string, routeName: string): Promise<Snapshot[]> {
  const snapshotsDirectory = path.join(dataDirectory, 'snapshots');
  const fileNames = (await readdir(snapshotsDirectory))
    .filter((name) => name.startsWith(`${routeName}-`) && name.endsWith('.jsonl'))
    .sort();
  const snapshots: Snapshot[] = [];
  for (const fileName of fileNames) {
    for (const snapshot of parseSnapshots(await readFile(path.join(snapshotsDirectory, fileName), 'utf8'))) snapshots.push(snapshot);
  }
  return snapshots;
}

type ModelKey = 'naive-persist' | 'profile-propagate' | 'profile-deconv' | 'uniform-arrival' | 'deconv-arrival' | 'full-frequency' | 'conservative';
const MODELS: ModelKey[] = ['naive-persist', 'profile-propagate', 'profile-deconv', 'uniform-arrival', 'deconv-arrival', 'full-frequency', 'conservative'];

interface Prediction {
  seats: number | null; // 좌석 점추정 (없으면 MAE 제외)
  fullProbability: number; // P(도착 시 만석)
  low: number | null; // 예측구간 하한 (없으면 coverage 제외)
  high: number | null;
}

interface Instance {
  horizonStops: number;
  actualSeats: number;
  actualFull: boolean;
  predictions: Record<ModelKey, Prediction>;
}

function horizonLabel(stops: number): string {
  if (stops <= 2) return '1-2';
  if (stops <= 5) return '3-5';
  return '6+';
}

interface Accumulator {
  n: number;
  pointN: number;
  absError: number;
  brier: number;
  intervalN: number;
  covered: number;
}

function emptyAccumulator(): Accumulator {
  return { n: 0, pointN: 0, absError: 0, brier: 0, intervalN: 0, covered: 0 };
}

function accumulate(target: Accumulator, prediction: Prediction, actualSeats: number, actualFull: boolean): void {
  target.n += 1;
  if (prediction.seats !== null) {
    target.pointN += 1;
    target.absError += Math.abs(prediction.seats - actualSeats);
  }
  target.brier += (prediction.fullProbability - (actualFull ? 1 : 0)) ** 2;
  if (prediction.low !== null && prediction.high !== null) {
    target.intervalN += 1;
    if (actualSeats >= prediction.low && actualSeats <= prediction.high) target.covered += 1;
  }
}

function routeFullRate(history: ReturnType<typeof buildHistoryRoute>): number {
  let samples = 0;
  let zero = 0;
  for (const hours of Object.values(history.weekday)) {
    for (const bucket of Object.values(hours)) {
      samples += bucket.samples;
      zero += bucket.zeroCount;
    }
  }
  return samples > 0 ? zero / samples : 0;
}

function fullFrequencyAt(history: ReturnType<typeof buildHistoryRoute>, sequence: number, bucket: number, fallback: number): number {
  const cell = history.weekday[String(sequence)]?.[String(((bucket % 48) + 48) % 48)];
  return cell && cell.samples > 0 ? cell.zeroCount / cell.samples : fallback;
}

// 시작 좌석에서 구간 정류장마다 순수요 분포를 순차 적용 (끝점 버킷으로 조회).
function propagateProfile(profile: ReturnType<typeof buildProfileRoute>, from: VehicleObservation, to: VehicleObservation, stopSequences: number[]): Prediction {
  let distribution = pointDistribution(from.seats);
  for (const sequence of stopSequences) {
    const estimate = netDemandAt(profile, sequence, to.bucket, to.weekend);
    distribution = applyNetDemand(distribution, estimate);
  }
  return {
    seats: distributionMean(distribution),
    fullProbability: distribution[0] ?? 0,
    low: distributionQuantile(distribution, 0.1),
    high: distributionQuantile(distribution, 0.9),
  };
}

interface FoldProfiles {
  uniformDeparture: ReturnType<typeof buildProfileRoute>;
  deconvDeparture: ReturnType<typeof buildProfileRoute>;
  uniformArrival: ReturnType<typeof buildProfileRoute>;
  deconvArrival: ReturnType<typeof buildProfileRoute>;
}

function predictInstance(
  from: VehicleObservation,
  to: VehicleObservation,
  departureStops: number[],
  arrivalStops: number[],
  profiles: FoldProfiles,
  history: ReturnType<typeof buildHistoryRoute>,
  baseFullRate: number,
): Record<ModelKey, Prediction> {
  return {
    'naive-persist': { seats: from.seats, fullProbability: from.seats === 0 ? 1 : 0, low: from.seats, high: from.seats },
    'profile-propagate': propagateProfile(profiles.uniformDeparture, from, to, departureStops),
    'profile-deconv': propagateProfile(profiles.deconvDeparture, from, to, departureStops),
    'uniform-arrival': propagateProfile(profiles.uniformArrival, from, to, arrivalStops),
    'deconv-arrival': propagateProfile(profiles.deconvArrival, from, to, arrivalStops),
    'full-frequency': { seats: null, fullProbability: fullFrequencyAt(history, to.sequence, to.bucket, baseFullRate), low: null, high: null },
    'conservative': { seats: null, fullProbability: 0, low: null, high: null },
  };
}

interface FoldResult {
  testDate: string;
  trainDates: string[];
  instances: Instance[];
}

function runFold(snapshotsByRoute: Map<string, Snapshot[]>, stopsByRoute: Map<string, number[]>, testDate: string, trainDates: string[]): FoldResult {
  const trainSet = new Set(trainDates);
  const instances: Instance[] = [];

  for (const [routeName, snapshots] of snapshotsByRoute) {
    const stopSet = stopsByRoute.get(routeName);
    if (!stopSet) continue;
    const sortedStops = [...stopSet].sort((left, right) => left - right);
    const inTraining = (date: string): boolean => trainSet.has(date);
    const profiles: FoldProfiles = {
      uniformDeparture: buildProfileRoute(snapshots, inTraining),
      deconvDeparture: buildDeconvolvedProfileRoute(snapshots, inTraining),
      uniformArrival: buildProfileRoute(snapshots, inTraining, 'arrival'),
      deconvArrival: buildDeconvolvedProfileRoute(snapshots, inTraining, 'arrival'),
    };
    const history = buildHistoryRoute(snapshots, inTraining);
    const baseFullRate = routeFullRate(history);

    const byVehicle = observationsByVehicle(snapshots, (date) => date === testDate);
    for (const observations of byVehicle.values()) {
      for (const run of splitRuns(observations)) {
        for (let index = 1; index < run.length; index += 1) {
          const from = run[index - 1];
          const to = run[index];
          if (!from || !to) continue;
          if (to.sequence <= from.sequence) continue;
          if (to.time - from.time > pairMaxGapMs) continue;
          const departureStops = sortedStops.filter((sequence) => sequence > from.sequence && sequence <= to.sequence);
          if (departureStops.length === 0) continue;
          const arrivalStops = sortedStops.filter((sequence) => sequence >= from.sequence && sequence < to.sequence);
          instances.push({
            horizonStops: to.sequence - from.sequence,
            actualSeats: to.seats,
            actualFull: to.seats === 0,
            predictions: predictInstance(from, to, departureStops, arrivalStops, profiles, history, baseFullRate),
          });
        }
      }
    }
  }
  return { testDate, trainDates, instances };
}

function report(folds: FoldResult[]): void {
  const capacity = defaultSeatCapacity;
  const pooled: Instance[] = folds.flatMap((fold) => fold.instances);
  const horizonOrder = ['1-2', '3-5', '6+'];

  console.log('═'.repeat(78));
  console.log('v2 층-1 백테스트 · rolling-origin (프로파일은 test일 이전 날짜로만 학습)');
  console.log(`좌석 정원 상수 ${capacity} · 예측구간 10~90% (목표 포함률 80%)`);
  console.log('═'.repeat(78));

  for (const fold of folds) {
    const full = fold.instances.filter((instance) => instance.actualFull).length;
    console.log(`\n[fold] test ${fold.testDate}  ← train ${fold.trainDates.join(',')}  | 관측쌍 ${fold.instances.length}건 (실제 만석 ${full}건)`);
  }

  const fullCount = pooled.filter((instance) => instance.actualFull).length;
  console.log(`\n[pooled] 총 관측쌍 ${pooled.length}건 · 실제 만석 ${fullCount}건 (${pooled.length ? (fullCount / pooled.length * 100).toFixed(1) : '0'}%)`);

  // horizon별 MAE — 2×2: 귀속 규약(departure/arrival) × 배분(균등/역산). * = 행 최소
  console.log('\n── 도착 좌석 MAE (horizon 정류장 수별, * = 최소) ─────────────');
  console.log('horizon      n      naive   uni(dep)   dec(dep)   uni(arr)   dec(arr)');
  for (const label of [...horizonOrder, 'all']) {
    const subset = label === 'all' ? pooled : pooled.filter((instance) => horizonLabel(instance.horizonStops) === label);
    if (subset.length === 0) continue;
    const keys: ModelKey[] = ['naive-persist', 'profile-propagate', 'profile-deconv', 'uniform-arrival', 'deconv-arrival'];
    const maes = keys.map((key) => {
      const accumulator = emptyAccumulator();
      for (const instance of subset) accumulate(accumulator, instance.predictions[key], instance.actualSeats, instance.actualFull);
      return accumulator.absError / accumulator.pointN;
    });
    const minValue = Math.min(...maes);
    const cells = maes.map((value, index) => (value.toFixed(3) + (value === minValue ? '*' : '')).padStart(index === 0 ? 9 : 10));
    console.log(`${label.padEnd(8)} ${String(subset.length).padStart(6)}  ${cells.join(' ')}`);
  }

  // 만석 사건 Brier (전 후보) + 예측구간 포함률
  console.log('\n── 만석 사건 Brier score (낮을수록 좋음) ──────────────────');
  const accumulators = new Map<ModelKey, Accumulator>();
  for (const model of MODELS) accumulators.set(model, emptyAccumulator());
  for (const instance of pooled) {
    for (const model of MODELS) accumulate(accumulators.get(model)!, instance.predictions[model], instance.actualSeats, instance.actualFull);
  }
  for (const model of MODELS) {
    const accumulator = accumulators.get(model)!;
    const brier = accumulator.brier / accumulator.n;
    console.log(`  ${model.padEnd(20)} Brier ${brier.toFixed(4)}`);
  }
  console.log('');
  for (const key of ['profile-propagate', 'profile-deconv', 'uniform-arrival', 'deconv-arrival'] as const) {
    const accumulator = accumulators.get(key)!;
    console.log(`  ${key.padEnd(20)} 예측구간 포함률 ${(accumulator.covered / accumulator.intervalN * 100).toFixed(1)}% (n=${accumulator.intervalN}, 목표 80%)`);
  }

  // 만석확률 보정 (프로파일 4종)
  const bins: Array<[number, number]> = [[0, 0.05], [0.05, 0.2], [0.2, 0.5], [0.5, 1.01]];
  for (const key of ['profile-propagate', 'profile-deconv', 'uniform-arrival', 'deconv-arrival'] as const) {
    console.log(`\n── ${key} 만석확률 보정 (예측 vs 실제) ─────────`);
    console.log('예측확률 구간     n    평균예측    실제만석률');
    for (const [low, high] of bins) {
      const subset = pooled.filter((instance) => {
        const probability = instance.predictions[key].fullProbability;
        return probability >= low && probability < high;
      });
      if (subset.length === 0) continue;
      const meanPredicted = subset.reduce((sum, instance) => sum + instance.predictions[key].fullProbability, 0) / subset.length;
      const empirical = subset.filter((instance) => instance.actualFull).length / subset.length;
      console.log(`  [${low.toFixed(2)}, ${high >= 1 ? '1.00' : high.toFixed(2)})  ${String(subset.length).padStart(6)}    ${meanPredicted.toFixed(3).padStart(6)}     ${empirical.toFixed(3).padStart(6)}`);
    }
  }

  console.log('\n' + '─'.repeat(78));
  console.log('주의: 평일 rolling-origin·표본 소량. 수치는 방향성이며 결론이 아니다.');
  console.log('마지막 날은 진행 중인 부분 데이터일 수 있다. 운행 재구성이 옳다는 가정 하의 평가.');
  console.log('─'.repeat(78));
}

async function main(): Promise<void> {
  const options = readArguments(process.argv.slice(2));
  const caches = await loadRouteCaches(options.dataDirectory);
  if (caches.length === 0) throw new Error(`정류장 캐시가 없습니다: ${options.dataDirectory}/routes`);

  const snapshotsByRoute = new Map<string, Snapshot[]>();
  const stopsByRoute = new Map<string, number[]>();
  const dateSet = new Set<string>();
  for (const cache of caches) {
    const snapshots = await loadSnapshots(options.dataDirectory, cache.route.name);
    snapshotsByRoute.set(cache.route.name, snapshots);
    stopsByRoute.set(cache.route.name, cache.stops.map((stop) => stop.sequence));
    for (const snapshot of snapshots) dateSet.add(toSeoulBucket(snapshot.collectedAt).date);
  }

  // 평일만 rolling-origin. 주말(1일)은 폴드 구성 불가.
  const weekdays = [...dateSet].sort().filter((date) => {
    // 정오 KST로 요일 판정: 자정 KST는 UTC 전날이라 getUTCDay가 하루 밀린다.
    const day = new Date(`${date}T12:00:00+09:00`).getUTCDay();
    return day !== 0 && day !== 6;
  });

  const folds: FoldResult[] = [];
  for (let index = 1; index < weekdays.length; index += 1) {
    const testDate = weekdays[index];
    if (!testDate) continue;
    folds.push(runFold(snapshotsByRoute, stopsByRoute, testDate, weekdays.slice(0, index)));
  }

  if (folds.length === 0) {
    console.log('평일이 2일 미만이라 rolling-origin 폴드를 만들 수 없습니다.');
    return;
  }
  report(folds);
}

main().catch((error: unknown) => {
  console.error(`백테스트 실패: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
