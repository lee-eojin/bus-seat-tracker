import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isNonBoardingStop, type RouteCache } from '../shared/model.js';
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
import { boardingVerdict, expectedDemandAt, nextFullDepartureStreak, queueStatement, verdictSeatMargin, type BoardingVerdict } from '../shared/boarding.js';
import { loadRouteCaches, loadSnapshots } from './data-source.js';

// 좌석 관측만으로 정류장 대기 인원을 복원한다 (docs/04-queue-recovery.md).
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
  allStops: boolean;
  verdict: boolean;
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
    allStops: false,
    verdict: false,
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
    if (name === '--all-stops') options.allStops = true;
    if (name === '--verdict') options.verdict = true;
    if (name === '--json' && value) options.jsonPath = path.resolve(value);
  }
  return options;
}

const seoulHour = (time: number): number => new Date(time + 9 * 3600 * 1000).getUTCHours();
const seoulClock = (time: number): string => new Date(time + 9 * 3600 * 1000).toISOString().slice(11, 16);

// 대상 정류장 바로 뒤에 이어지는 미정차 지점들. 승차가 없으므로 여기서 읽은 잔여석이
// 곧 대상 정류장의 출발 상태다. 승차 가능한 정류장을 섞으면 하차분이 들어와
// 도착률이 음수로 나온다 (docs/04-queue-recovery.md §7 구현 주의).
function passThroughAfter(cache: RouteCache, stopSequence: number): number[] {
  const byName = new Map(cache.stops.map((stop) => [stop.sequence, stop.name]));
  const sequences: number[] = [];
  for (let sequence = stopSequence + 1; ; sequence += 1) {
    const name = byName.get(sequence);
    if (name === undefined || !isNonBoardingStop(name)) break;
    sequences.push(sequence);
  }
  return sequences;
}

interface Pass {
  at: number;
  readSequence: number;
  readAtStop: boolean;
  direct: boolean;
  observedSeats: number;
  arrivalSeats: number;
  departureSeats: number;
  rawBoarding: number;
  boarding: number;
  cleared: boolean;
}

interface DayPasses {
  passes: Pass[];
  direct: number;
  viaPassThrough: number;
  skipped: number;
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
// 태우므로 분포 전파가 이 제약을 지켜 준다 (docs/04-queue-recovery.md §8).
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
): DayPasses {
  const passes: Pass[] = [];
  let direct = 0;
  let viaPassThrough = 0;
  let skipped = 0;

  for (const run of runs) {
    const inWindow = run.filter((point) => seoulHour(point.time) >= options.fromHour && seoulHour(point.time) < options.toHour);
    const atStop = inWindow.filter((point) => point.sequence === options.stopSequence);

    // 조밀 관측이 있으면 같은 정류장에서 도착·출발을 직접 읽는다. 경유지 트릭은 10분
    // 샘플링의 우회책이었고 1분 간격에서는 필요 없다. 정차 중 갱신이 섞이는 문제도
    // 여기서는 사라진다 — 첫 관측이 도착, 마지막 관측이 출발이다.
    if (atStop.length >= 2) {
      const first = atStop[0]!;
      const last = atStop[atStop.length - 1]!;
      direct += 1;
      passes.push({
        at: first.time,
        readSequence: options.stopSequence,
        readAtStop: true,
        direct: true,
        observedSeats: first.seats,
        arrivalSeats: first.seats,
        departureSeats: last.seats,
        rawBoarding: first.seats - last.seats,
        boarding: Math.max(0, first.seats - last.seats),
        cleared: last.seats > 0,
      });
      continue;
    }

    // 관측이 한 번뿐이면 도착인지 출발인지 가릴 수 없어 하류 경유지로 판정한다.
    const after = inWindow.find((point) => passThrough.includes(point.sequence));
    const source = atStop[0] ?? inWindow.filter((point) => point.sequence >= options.upstreamFrom && point.sequence < options.stopSequence).pop();
    if (!after || !source) {
      if (inWindow.some((point) => point.sequence >= options.stopSequence)) skipped += 1;
      continue;
    }

    const readAtStop = source.sequence === options.stopSequence;
    const arrivalSeats = readAtStop || !profile
      ? source.seats
      : propagateToStop(profile, source.sequence, options.stopSequence, source.seats, source.bucket);
    viaPassThrough += 1;
    passes.push({
      at: source.time,
      readSequence: source.sequence,
      readAtStop,
      direct: false,
      observedSeats: source.seats,
      arrivalSeats,
      departureSeats: after.seats,
      rawBoarding: source.seats - after.seats,
      boarding: Math.max(0, arrivalSeats - after.seats),
      cleared: after.seats > 0,
    });
  }
  return { passes: passes.sort((left, right) => left.at - right.at), direct, viaPassThrough, skipped };
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
    console.log('하류 미정차 지점 없음 — 조밀 관측(같은 정류장 2회 이상)으로만 도착·출발을 읽는다.');
  } else {
    console.log(`하류 미정차 지점: ${passThrough.join(', ')} (조밀 관측이 없을 때만 사용)`);
  }
  console.log(`관측 창 ${options.fromHour}~${options.toHour}시 · 상류 대체 허용 seq${options.upstreamFrom} 이상 · 상류 오염 보정 ${options.correct ? '켬' : '끔'}`);

  const snapshots = await loadSnapshots(options.dataDirectory, options.routeName);
  const dates = [...new Set(snapshots.map((snapshot) => toSeoulBucket(snapshot.collectedAt).date))].sort()
    .filter((date) => {
      if (options.includeWeekend) return true;
      const day = new Date(`${date}T12:00:00+09:00`).getUTCDay();
      return day !== 0 && day !== 6;
    });

  // 정류장 전체를 훑을 때 날짜마다 다시 만들지 않도록 운행 분할을 미리 캐싱한다.
  const runsByDate = new Map<string, VehicleObservation[][]>();
  for (const date of dates) {
    const runs: VehicleObservation[][] = [];
    for (const observations of observationsByVehicle(snapshots, (day) => day === date).values()) {
      runs.push(...splitRuns(observations));
    }
    runsByDate.set(date, runs);
  }

  if (options.allStops) {
    console.log('\n' + '═'.repeat(78));
    console.log('정류장별 도착률 λ 프로파일 (2단계)');
    console.log('═'.repeat(78));
    console.log('  seq  정류장                        구간  총승차   총분   λ(시간가중)  직독/경유지/불가');
    const rows: Array<{ sequence: number; name: string; intervals: number; boarding: number; minutes: number; lambda: number; direct: number; via: number; skipped: number }> = [];
    for (const stop of cache.stops) {
      if (isNonBoardingStop(stop.name)) continue;
      const stopOptions = { ...options, stopSequence: stop.sequence };
      const through = passThroughAfter(cache, stop.sequence);
      let boarding = 0;
      let minutes = 0;
      let count = 0;
      let direct = 0;
      let via = 0;
      let skipped = 0;
      for (const date of dates) {
        const day = passesForDay(runsByDate.get(date)!, stopOptions, through, null);
        direct += day.direct;
        via += day.viaPassThrough;
        skipped += day.skipped;
        for (const interval of intervalsOf(day.passes)) {
          boarding += interval.boarding;
          minutes += interval.minutes;
          count += 1;
        }
      }
      if (count === 0) continue;
      rows.push({ sequence: stop.sequence, name: stop.name ?? '?', intervals: count, boarding, minutes, lambda: minutes > 0 ? boarding / minutes : 0, direct, via, skipped });
    }
    for (const row of rows.sort((left, right) => right.lambda - left.lambda)) {
      console.log(
        `  ${String(row.sequence).padStart(3)}  ${row.name.slice(0, 26).padEnd(28)}${String(row.intervals).padStart(4)}${row.boarding.toFixed(0).padStart(8)}${row.minutes.toFixed(0).padStart(7)}${row.lambda.toFixed(2).padStart(12)}   ${row.direct}/${row.via}/${row.skipped}`,
      );
    }
    console.log(`\n  정류장 ${rows.length}곳에서 λ 산출 · 전체 ${cache.stops.length}곳`);
    if (options.jsonPath) {
      await writeFile(options.jsonPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), route: options.routeName, dates, window: { fromHour: options.fromHour, toHour: options.toHour }, stops: rows }, null, 2)}\n`);
      console.log(`\n결과 저장: ${options.jsonPath}`);
    }
    return;
  }

  const allIntervals: Array<Interval & { date: string }> = [];
  const allPasses: Array<Pass & { date: string }> = [];

  for (const date of dates) {
    // 보정에 쓰는 프로파일에서 그날은 뺀다 (leave-one-day-out).
    const profile = options.correct
      ? buildDeconvolvedProfileRoute(snapshots, (day) => dates.includes(day) && day !== date, 'arrival')
      : null;
    const day = passesForDay(runsByDate.get(date)!, options, passThrough, profile);
    const passes = day.passes;
    const intervals = intervalsOf(passes);
    allPasses.push(...passes.map((item) => ({ ...item, date })));
    allIntervals.push(...intervals.map((item) => ({ ...item, date })));

    const clears = passes.filter((item) => item.cleared).length;
    console.log(
      `\n[${date}] 통과 ${passes.length}대 (조밀 직독 ${day.direct} · 경유지 ${day.viaPassThrough} · 판정불가 ${day.skipped}) ` +
      `· 큐해소 ${clears}건 · 산출 구간 ${intervals.length}개`,
    );
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
  console.log('버스 통과 시점의 대기 인원 (λ 없이, 가정 없이)');
  console.log('═'.repeat(78));
  console.log('  날짜   시각   도착석 → 출발석   대기 인원');
  for (const pass of allPasses) {
    const statement = queueStatement(pass);
    const mark = statement.exact ? '=' : '≥';
    const note = statement.exact ? '정확 (좌석 남기고 출발)' : '하한 (만차 출발 — 못 탄 사람은 흔적 없음)';
    console.log(
      `  ${pass.date.slice(5)} ${seoulClock(pass.at)}  ${pass.arrivalSeats.toFixed(0).padStart(4)}석 → ${String(pass.departureSeats).padStart(3)}석   ` +
      `${mark} ${statement.people.toFixed(0).padStart(3)}명  ${note}`,
    );
  }

  if (options.verdict) {
    const label: Record<BoardingVerdict, string> = { roomy: '여유', tight: '빠듯', unlikely: '어려움' };
    const matrix = new Map<BoardingVerdict, { cleared: number; full: number }>([
      ['roomy', { cleared: 0, full: 0 }],
      ['tight', { cleared: 0, full: 0 }],
      ['unlikely', { cleared: 0, full: 0 }],
    ]);

    console.log('\n' + '═'.repeat(78));
    console.log(`탑승 가능성 판정 · 여유폭 ${verdictSeatMargin}석 (docs/04-queue-recovery.md §10)`);
    console.log('═'.repeat(78));
    console.log('  날짜   시각    좌석   기대수요  만석연속   판정     실제');
    for (const date of dates) {
      // 판정 대상일은 프로파일 학습에서 뺀다.
      const profile = buildDeconvolvedProfileRoute(snapshots, (day) => dates.includes(day) && day !== date, 'arrival');
      let streak = 0;
      for (const pass of allPasses.filter((item) => item.date === date)) {
        const shifted = new Date(pass.at + 9 * 3600 * 1000);
        const bucket = shifted.getUTCHours() * 2 + (shifted.getUTCMinutes() >= 30 ? 1 : 0);
        const demand = expectedDemandAt((at) => netDemandAt(profile, options.stopSequence, at, false).mean, bucket);
        const verdict = boardingVerdict({ arrivalSeats: pass.arrivalSeats, expectedDemand: demand, fullDepartureStreak: streak });
        matrix.get(verdict)![pass.cleared ? 'cleared' : 'full'] += 1;
        console.log(
          `  ${date.slice(5)} ${seoulClock(pass.at)}  ${pass.arrivalSeats.toFixed(0).padStart(4)}석  ${demand.toFixed(1).padStart(7)}  ${String(streak).padStart(7)}   ${label[verdict].padEnd(7)} ${pass.cleared ? '전원 탑승' : '만차'}`,
        );
        streak = nextFullDepartureStreak(streak, pass);
      }
    }

    console.log('\n  판정     전원 탑승   만차(못 탄 사람 가능)');
    for (const [verdict, counts] of matrix) {
      console.log(`  ${label[verdict].padEnd(7)} ${String(counts.cleared).padStart(8)}   ${String(counts.full).padStart(14)}`);
    }
    return;
  }

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
    .filter((stop) => !isNonBoardingStop(stop.name) && passThroughAfter(cache, stop.sequence).length > 0)
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
