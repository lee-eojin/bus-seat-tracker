import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type RouteCache } from '../shared/model.js';
import {
  applyNetDemand,
  buildDeconvolvedProfileRoute,
  distributionMean,
  netDemandAt,
  observationsByVehicle,
  pointDistribution,
  splitRuns,
  toSeoulBucket,
  type VehicleObservation,
} from '../shared/profile.js';
import { loadRouteCaches, loadSnapshots } from './data-source.js';

// 좌석 관측만으로 정류장 대기 인원을 복원한다 (docs/queue-recovery.md).
//
// 직행좌석버스는 입석이 없다. 그러므로 버스가 좌석을 남기고 출발했다는 것은 그 순간
// 대기 줄이 비었다는 뜻이고, 이 사건이 큐 길이 0의 관측점이 된다. 큐가 0인 두 시점
// 사이에서는 줄에 들어온 사람과 버스로 나간 사람이 같으므로, 관측 불가능한 도착량을
// 관측 가능한 승차량으로 대신 셀 수 있다.
//
//   λ = Σ승차(t₀, t₁] / (t₁ − t₀)          t₀·t₁은 둘 다 큐 해소 시점이어야 한다
//   대기(t) = λ · (t − t₀) − Σ승차(t₀, t]

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDirectory, '..', '..');

interface Options {
  dataDirectory: string;
  routeName: string;
  stopSequence: number;
  fromHour: number;
  toHour: number;
  upstreamFrom: number;
  correct: boolean;
  includeWeekend: boolean;
  jsonPath: string | null;
}

function readArguments(argumentsList: string[]): Options {
  const options: Options = {
    dataDirectory: path.join(projectRoot, 'bus-seat-collector', 'data'),
    routeName: '3330',
    stopSequence: 22,
    fromHour: 17,
    toHour: 21,
    upstreamFrom: 18,
    correct: true,
    includeWeekend: false,
    jsonPath: null,
  };
  for (const argument of argumentsList) {
    const [name, value] = argument.split('=', 2);
    if (name === '--data-dir' && value) options.dataDirectory = path.resolve(value);
    if (name === '--route' && value) options.routeName = value;
    if (name === '--stop' && value) options.stopSequence = Number(value);
    if (name === '--from-hour' && value) options.fromHour = Number(value);
    if (name === '--to-hour' && value) options.toHour = Number(value);
    if (name === '--upstream-from' && value) options.upstreamFrom = Number(value);
    if (name === '--no-correct') options.correct = false;
    if (name === '--include-weekend') options.includeWeekend = true;
    if (name === '--json' && value) options.jsonPath = path.resolve(value);
  }
  return options;
}

const seoulHour = (time: number): number => new Date(time + 9 * 3600 * 1000).getUTCHours();
const seoulClock = (time: number): string => new Date(time + 9 * 3600 * 1000).toISOString().slice(11, 16);

// 대상 정류장 바로 뒤에 이어지는 경유지들. 승차가 없으므로 여기서 읽은 잔여석이
// 곧 대상 정류장의 출발 상태다. 경유지가 아닌 정류장을 섞으면 하차분이 들어와
// 도착률이 음수로 나온다 (docs/queue-recovery.md §7 구현 주의).
function passThroughAfter(cache: RouteCache, stopSequence: number): number[] {
  const byySequence = new Map(cache.stops.map((stop) => [stop.sequence, stop.name]));
  const sequences: number[] = [];
  for (let sequence = stopSequence + 1; ; sequence += 1) {
    const name = byySequence.get(sequence);
    if (!name || !name.includes('경유')) break;
    sequences.push(sequence);
  }
  return sequences;
}

interface Pass {
  at: number;
  readSequence: number;
  readAtStop: boolean;
  observedSeats: number;
  arrivalSeats: number;
  departureSeats: number;
  rawBoarding: number;
  boarding: number;
  cleared: boolean;
}

interface Interval {
  from: number;
  to: number;
  minutes: number;
  buses: number;
  contaminated: number;
  boarding: number;
  lambda: number;
}

// 상류 관측에서 대상 정류장 도착 잔여석까지 좌석 분포를 전파한다. 기대 승차를 그냥 빼면
// 상류 기대치가 좌석 수를 넘을 때 음수로 잘리는데, 실제 버스는 자리가 없으면 그만큼만
// 태우므로 분포 전파가 이 제약을 지켜 준다 (docs/queue-recovery.md §8).
function propagateToStop(
  profile: ReturnType<typeof buildDeconvolvedProfileRoute>,
  fromSequence: number,
  stopSequence: number,
  seats: number,
  bucket: number,
): number {
  let distribution = pointDistribution(seats);
  for (let sequence = fromSequence; sequence < stopSequence; sequence += 1) {
    distribution = applyNetDemand(distribution, netDemandAt(profile, sequence, bucket, false));
  }
  return distributionMean(distribution);
}

function passesForDay(
  runs: VehicleObservation[][],
  options: Options,
  passThrough: number[],
  profile: ReturnType<typeof buildDeconvolvedProfileRoute> | null,
): Pass[] {
  const passes: Pass[] = [];
  for (const run of runs) {
    const inWindow = run.filter((point) => seoulHour(point.time) >= options.fromHour && seoulHour(point.time) < options.toHour);
    const after = inWindow.find((point) => passThrough.includes(point.sequence));
    if (!after) continue;
    const atStop = inWindow.find((point) => point.sequence === options.stopSequence);
    const upstream = inWindow.filter((point) => point.sequence >= options.upstreamFrom && point.sequence < options.stopSequence).pop();
    const source = atStop ?? upstream;
    if (!source) continue;

    const readAtStop = source.sequence === options.stopSequence;
    const arrivalSeats = readAtStop || !profile
      ? source.seats
      : propagateToStop(profile, source.sequence, options.stopSequence, source.seats, source.bucket);
    passes.push({
      at: source.time,
      readSequence: source.sequence,
      readAtStop,
      observedSeats: source.seats,
      arrivalSeats,
      departureSeats: after.seats,
      rawBoarding: source.seats - after.seats,
      boarding: Math.max(0, arrivalSeats - after.seats),
      cleared: after.seats > 0,
    });
  }
  return passes.sort((left, right) => left.at - right.at);
}

// 큐 해소 → 다음 큐 해소 구간마다 λ를 낸다. 같은 시각에 여러 대가 해소하면
// (샘플링이 순서를 못 가림) 마지막 대를 경계로 삼는다.
function intervalsOf(passes: Pass[]): Interval[] {
  const lastAtTime = new Map<number, number>();
  passes.forEach((item, index) => {
    if (item.cleared) lastAtTime.set(item.at, index);
  });
  const clears = [...lastAtTime.values()].sort((left, right) => left - right);
  const intervals: Interval[] = [];
  for (let index = 0; index + 1 < clears.length; index += 1) {
    const start = clears[index]!;
    const end = clears[index + 1]!;
    const window = passes.slice(start + 1, end + 1);
    const minutes = (passes[end]!.at - passes[start]!.at) / 60_000;
    if (minutes <= 0 || window.length === 0) continue;
    const boarding = window.reduce((sum, item) => sum + item.boarding, 0);
    intervals.push({
      from: passes[start]!.at,
      to: passes[end]!.at,
      minutes,
      buses: window.length,
      contaminated: window.filter((item) => !item.readAtStop).length,
      boarding,
      lambda: boarding / minutes,
    });
  }
  return intervals;
}

function describe(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const middle = Math.floor(sorted.length / 2);
  return {
    count: values.length,
    mean,
    median: sorted.length % 2 === 0 ? ((sorted[middle - 1]! + sorted[middle]!) / 2) : sorted[middle]!,
    sd: Math.sqrt(variance),
    cv: mean === 0 ? null : Math.sqrt(variance) / mean,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
  };
}

async function main(): Promise<void> {
  const options = readArguments(process.argv.slice(2));
  const caches = await loadRouteCaches(options.dataDirectory);
  const cache = caches.find((entry) => entry.route.name === options.routeName);
  if (!cache) throw new Error(`노선 캐시를 찾지 못했습니다: ${options.routeName}`);

  const passThrough = passThroughAfter(cache, options.stopSequence);
  const stopName = cache.stops.find((stop) => stop.sequence === options.stopSequence)?.name ?? '(이름 없음)';

  console.log('═'.repeat(78));
  console.log(`대기 인원 복원 · ${options.routeName} seq${options.stopSequence} ${stopName}`);
  console.log('═'.repeat(78));
  if (passThrough.length === 0) {
    console.log('이 정류장 뒤에 경유지가 없어 출발 잔여석을 깨끗하게 읽을 수 없습니다.');
    console.log('연속 시퀀스 관측이 필요하며, 현재 수집 해상도에서는 거의 잡히지 않습니다.\n');
  } else {
    console.log(`출발 잔여석 판정 정류장(경유지): ${passThrough.join(', ')}`);
  }
  console.log(`관측 창 ${options.fromHour}~${options.toHour}시 · 상류 대체 허용 seq${options.upstreamFrom} 이상 · 상류 오염 보정 ${options.correct ? '켬' : '끔'}`);

  const snapshots = await loadSnapshots(options.dataDirectory, options.routeName);
  const dates = [...new Set(snapshots.map((snapshot) => toSeoulBucket(snapshot.collectedAt).date))].sort()
    .filter((date) => {
      if (options.includeWeekend) return true;
      const day = new Date(`${date}T12:00:00+09:00`).getUTCDay();
      return day !== 0 && day !== 6;
    });

  const allIntervals: Array<Interval & { date: string }> = [];
  const allPasses: Array<Pass & { date: string }> = [];

  for (const date of dates) {
    // 보정에 쓰는 프로파일에서 그날은 뺀다 (leave-one-day-out).
    const profile = options.correct
      ? buildDeconvolvedProfileRoute(snapshots, (day) => dates.includes(day) && day !== date, 'arrival')
      : null;
    const runs: VehicleObservation[][] = [];
    for (const observations of observationsByVehicle(snapshots, (day) => day === date).values()) {
      runs.push(...splitRuns(observations));
    }
    const passes = passesForDay(runs, options, passThrough, profile);
    const intervals = intervalsOf(passes);
    allPasses.push(...passes.map((item) => ({ ...item, date })));
    allIntervals.push(...intervals.map((item) => ({ ...item, date })));

    const clears = passes.filter((item) => item.cleared).length;
    console.log(`\n[${date}] 통과 ${passes.length}대 · 큐해소 ${clears}건 · 산출 구간 ${intervals.length}개`);
    for (const interval of intervals) {
      console.log(
        `   ${seoulClock(interval.from)}~${seoulClock(interval.to)}  ${String(Math.round(interval.minutes)).padStart(4)}분 ` +
        `${String(interval.buses).padStart(3)}대 (상류대체 ${interval.contaminated}대)  승차 ${interval.boarding.toFixed(0).padStart(4)}명  λ ${interval.lambda.toFixed(2).padStart(6)}`,
      );
    }
  }

  const lambdas = allIntervals.map((interval) => interval.lambda);
  const overall = describe(lambdas);
  const longRuns = allIntervals.filter((interval) => interval.minutes >= 40);
  const longStats = describe(longRuns.map((interval) => interval.lambda));

  console.log('\n' + '═'.repeat(78));
  console.log('λ 분포');
  console.log('═'.repeat(78));
  if (overall) {
    const totalBoarding = allIntervals.reduce((sum, interval) => sum + interval.boarding, 0);
    const totalMinutes = allIntervals.reduce((sum, interval) => sum + interval.minutes, 0);
    console.log(`  전체 구간 ${overall.count}개 · 평균 ${overall.mean.toFixed(2)} · 중앙값 ${overall.median.toFixed(2)} · 표준편차 ${overall.sd.toFixed(2)} · 범위 ${overall.min.toFixed(2)}~${overall.max.toFixed(2)}`);
    console.log(`  시간가중 평균 λ ${(totalBoarding / totalMinutes).toFixed(2)}명/분 (승차 ${totalBoarding.toFixed(0)}명 / ${totalMinutes.toFixed(0)}분)`);
  }
  if (longStats) {
    console.log(`\n  40분 이상 구간 ${longStats.count}개 · 평균 ${longStats.mean.toFixed(2)} · 표준편차 ${longStats.sd.toFixed(2)} · 변동계수 ${longStats.cv?.toFixed(2) ?? '—'} · 범위 ${longStats.min.toFixed(2)}~${longStats.max.toFixed(2)}`);
    for (const interval of [...longRuns].sort((left, right) => right.minutes - left.minutes)) {
      console.log(`    ${interval.date} ${seoulClock(interval.from)}~${seoulClock(interval.to)}  ${String(Math.round(interval.minutes)).padStart(3)}분  λ ${interval.lambda.toFixed(2)}  (상류대체 ${interval.contaminated}/${interval.buses}대)`);
    }
  }

  console.log('\n' + '═'.repeat(78));
  console.log('시간대별 λ (구간 중점 기준 30분 버킷)');
  console.log('═'.repeat(78));
  const byBucket = new Map<number, number[]>();
  for (const interval of allIntervals) {
    const middle = interval.from + (interval.to - interval.from) / 2;
    const shifted = new Date(middle + 9 * 3600 * 1000);
    const bucket = shifted.getUTCHours() * 2 + (shifted.getUTCMinutes() >= 30 ? 1 : 0);
    byBucket.set(bucket, [...(byBucket.get(bucket) ?? []), interval.lambda]);
  }
  for (const bucket of [...byBucket.keys()].sort((left, right) => left - right)) {
    const stats = describe(byBucket.get(bucket)!)!;
    const label = `${String(Math.floor(bucket / 2)).padStart(2, '0')}:${bucket % 2 ? '30' : '00'}`;
    const spread = stats.count > 1 ? `${stats.min.toFixed(2)}~${stats.max.toFixed(2)}` : '—';
    console.log(`  ${label}  n=${stats.count}  평균 ${stats.mean.toFixed(2).padStart(5)}  범위 ${spread}`);
  }

  console.log('\n' + '═'.repeat(78));
  console.log('확장 진단 — 출발 잔여석을 깨끗하게 읽을 수 있는 정류장');
  console.log('═'.repeat(78));
  const clean = cache.stops
    .filter((stop) => !(stop.name ?? '').includes('경유') && passThroughAfter(cache, stop.sequence).length > 0)
    .map((stop) => `seq${stop.sequence} ${stop.name}`);
  console.log(`  전체 ${cache.stops.length}개 중 ${clean.length}개`);
  for (const label of clean) console.log(`    ${label}`);

  if (options.jsonPath) {
    await writeFile(options.jsonPath, `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      route: options.routeName,
      stop: { sequence: options.stopSequence, name: stopName, passThrough },
      window: { fromHour: options.fromHour, toHour: options.toHour },
      corrected: options.correct,
      dates,
      overall,
      longRuns: longStats,
      intervals: allIntervals,
      // 문서의 통과 이력 표와 보정 검증(§5·§8)이 이 배열에서 그대로 나온다.
      passes: allPasses.map((item) => ({ ...item, clock: seoulClock(item.at) })),
    }, null, 2)}\n`);
    console.log(`\n결과 저장: ${options.jsonPath}`);
  }
}

main().catch((error: unknown) => {
  console.error(`대기 인원 복원 실패: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
