import { type HistoryRoute, type ProfileCell, type ProfileRoute, type Snapshot } from './model.js';

// 운행 분할 기준: 위치 역행(회차 후 재출발) 또는 45분 이상 공백(차고지 대기)
export const runSplitGapMs = 45 * 60_000;
// 90분 넘게 벌어진 관측쌍은 순수요 귀속이 무의미해 버린다
export const pairMaxGapMs = 90 * 60_000;

export interface VehicleObservation {
  time: number;
  sequence: number;
  seats: number;
  bucket: number;
  weekend: boolean;
  date: string;
}

export function toSeoulBucket(isoText: string): { date: string; bucket: number; weekend: boolean } {
  const seoulClock = new Date(new Date(isoText).getTime() + 9 * 3600 * 1000);
  const day = seoulClock.getUTCDay();
  return {
    date: seoulClock.toISOString().slice(0, 10),
    bucket: seoulClock.getUTCHours() * 2 + (seoulClock.getUTCMinutes() >= 30 ? 1 : 0),
    weekend: day === 0 || day === 6,
  };
}

export function splitRuns(observations: VehicleObservation[]): VehicleObservation[][] {
  const runs: VehicleObservation[][] = [];
  let run: VehicleObservation[] = [];
  for (const observation of observations) {
    const previous = run[run.length - 1];
    if (previous && (observation.sequence < previous.sequence || observation.time - previous.time > runSplitGapMs)) {
      runs.push(run);
      run = [];
    }
    run.push(observation);
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

// 스냅샷을 차량별 관측 시퀀스로 묶는다. acceptDate로 학습 기간(서울 날짜)을 제한할 수 있다.
export function observationsByVehicle(snapshots: Snapshot[], acceptDate?: (date: string) => boolean): Map<string, VehicleObservation[]> {
  const byVehicle = new Map<string, VehicleObservation[]>();
  for (const snapshot of snapshots) {
    const seoul = toSeoulBucket(snapshot.collectedAt);
    if (acceptDate && !acceptDate(seoul.date)) continue;
    const time = new Date(snapshot.collectedAt).getTime();
    for (const vehicle of snapshot.vehicles) {
      if (vehicle.id === null || vehicle.currentStopSequence === null) continue;
      if (vehicle.remainingSeats === null || vehicle.remainingSeats < 0) continue;
      const observations = byVehicle.get(vehicle.id) ?? [];
      observations.push({
        time,
        sequence: vehicle.currentStopSequence,
        seats: vehicle.remainingSeats,
        bucket: seoul.bucket,
        weekend: seoul.weekend,
        date: seoul.date,
      });
      byVehicle.set(vehicle.id, observations);
    }
  }
  for (const observations of byVehicle.values()) observations.sort((left, right) => left.time - right.time);
  return byVehicle;
}

// 구간 귀속 규약 (v2 §4.2의 S⁻/S⁺ 매핑 질문):
// departure — 잔여석이 정류장 "출발(승차 반영 후)" 상태라고 보고 Δ를 (a,b]에 귀속 (기존 동작)
// arrival   — 잔여석이 정류장 "도착(승차 반영 전)" 상태라고 보고 Δ를 [a,b−1]에 귀속
export type SpanAttribution = 'departure' | 'arrival';

function spanStopRange(fromSequence: number, toSequence: number, attribution: SpanAttribution): [number, number] {
  return attribution === 'arrival' ? [fromSequence, toSequence - 1] : [fromSequence + 1, toSequence];
}

// 순수요 프로파일: 같은 운행의 연속 관측쌍에서 Δ좌석을 구간 정류장에 1/n 가중 배분.
// 만석이 낀 쌍은 수요가 은닉되므로(검열) 표본에서 빼고 검열 가중치로만 센다.
export function buildProfileRoute(snapshots: Snapshot[], acceptDate?: (date: string) => boolean, attribution: SpanAttribution = 'departure'): ProfileRoute {
  const profile: ProfileRoute = { weekday: {}, weekend: {}, depletion: { weekday: {}, weekend: {} } };

  for (const observations of observationsByVehicle(snapshots, acceptDate).values()) {
    for (const run of splitRuns(observations)) {
      const depleted = run.find((observation) => observation.seats === 0);
      if (depleted) {
        const group = depleted.weekend ? profile.depletion.weekend : profile.depletion.weekday;
        const bySequence = group[String(depleted.bucket)] ?? {};
        bySequence[String(depleted.sequence)] = (bySequence[String(depleted.sequence)] ?? 0) + 1;
        group[String(depleted.bucket)] = bySequence;
      }

      for (let index = 1; index < run.length; index += 1) {
        const from = run[index - 1];
        const to = run[index];
        if (!from || !to) continue;
        const span = to.sequence - from.sequence;
        if (span <= 0 || to.time - from.time > pairMaxGapMs) continue;
        const censored = from.seats === 0 || to.seats === 0;
        const weight = 1 / span;
        const perStopDemand = (from.seats - to.seats) / span;
        const group = to.weekend ? profile.weekend : profile.weekday;
        const [firstStop, lastStop] = spanStopRange(from.sequence, to.sequence, attribution);
        for (let sequence = firstStop; sequence <= lastStop; sequence += 1) {
          const byBucket = group[String(sequence)] ?? {};
          const cell: ProfileCell = byBucket[String(to.bucket)] ?? { weight: 0, demandSum: 0, demandSquaredSum: 0, censoredWeight: 0 };
          if (censored) {
            cell.censoredWeight += weight;
          } else {
            cell.weight += weight;
            cell.demandSum += weight * perStopDemand;
            cell.demandSquaredSum += weight * perStopDemand * perStopDemand;
          }
          byBucket[String(to.bucket)] = cell;
          group[String(sequence)] = byBucket;
        }
      }
    }
  }
  return profile;
}

// 만석 빈도 히스토리: 같은 날 같은 차량이 같은 셀(정류장×30분)에 여러 번 잡혀도 1회로 센다.
export function buildHistoryRoute(snapshots: Snapshot[], acceptDate?: (date: string) => boolean): HistoryRoute {
  const observations = new Map<string, { sequence: number; bucket: number; weekend: boolean; full: boolean }>();
  for (const snapshot of snapshots) {
    const seoul = toSeoulBucket(snapshot.collectedAt);
    if (acceptDate && !acceptDate(seoul.date)) continue;
    for (const vehicle of snapshot.vehicles) {
      if (vehicle.currentStopSequence === null) continue;
      if (vehicle.remainingSeats === null || vehicle.remainingSeats < 0) continue;
      observations.set(`${seoul.date}|${vehicle.id}|${vehicle.currentStopSequence}|${seoul.bucket}`, {
        sequence: vehicle.currentStopSequence,
        bucket: seoul.bucket,
        weekend: seoul.weekend,
        full: vehicle.remainingSeats === 0,
      });
    }
  }

  const history: HistoryRoute = { weekday: {}, weekend: {} };
  for (const observation of observations.values()) {
    const group = observation.weekend ? history.weekend : history.weekday;
    const sequenceKey = String(observation.sequence);
    const bucketKey = String(observation.bucket);
    const hours = group[sequenceKey] ?? {};
    const bucket = hours[bucketKey] ?? { samples: 0, zeroCount: 0 };
    bucket.samples += 1;
    if (observation.full) bucket.zeroCount += 1;
    hours[bucketKey] = bucket;
    group[sequenceKey] = hours;
  }
  return history;
}

// ── 좌석 순전파 (app.ts forecastVehicle과 동일한 분포 기반 DP를 순수 함수로) ──

export interface NetDemandEstimate {
  mean: number;
  sd: number;
  lowConfidence: boolean;
}

export const defaultSeatCapacity = 80;
export const defaultDemandMinWeight = 1;

function normalCdf(value: number): number {
  const scaled = value / Math.SQRT2;
  const sign = scaled < 0 ? -1 : 1;
  const t = 1 / (1 + 0.3275911 * Math.abs(scaled));
  const polynomial = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  const erf = 1 - polynomial * Math.exp(-scaled * scaled);
  return 0.5 * (1 + sign * erf);
}

function profileCellAt(profile: ProfileRoute, sequence: number, bucket: number, weekend: boolean): ProfileCell | null {
  return (weekend ? profile.weekend : profile.weekday)[String(sequence)]?.[String(((bucket % 48) + 48) % 48)] ?? null;
}

export function netDemandAt(profile: ProfileRoute, sequence: number, bucket: number, weekend: boolean, demandMinWeight = defaultDemandMinWeight): NetDemandEstimate {
  const exact = profileCellAt(profile, sequence, bucket, weekend);
  let weight = exact?.weight ?? 0;
  let demandSum = exact?.demandSum ?? 0;
  let demandSquaredSum = exact?.demandSquaredSum ?? 0;
  let censoredWeight = exact?.censoredWeight ?? 0;
  if (weight < demandMinWeight) {
    for (const nearby of [bucket - 1, bucket + 1]) {
      const cell = profileCellAt(profile, sequence, nearby, weekend);
      if (!cell) continue;
      weight += cell.weight;
      demandSum += cell.demandSum;
      demandSquaredSum += cell.demandSquaredSum;
      censoredWeight += cell.censoredWeight;
    }
  }
  if (weight <= 0) return { mean: 0, sd: 3, lowConfidence: true };
  const mean = demandSum / weight;
  const variance = Math.max(demandSquaredSum / weight - mean * mean, 1);
  const lowConfidence = weight < demandMinWeight || censoredWeight > weight * 0.5;
  return { mean, sd: Math.sqrt(variance) + (lowConfidence ? 1 : 0), lowConfidence };
}

export function applyNetDemand(distribution: number[], estimate: NetDemandEstimate, capacity = defaultSeatCapacity): number[] {
  const next = new Array<number>(capacity + 1).fill(0);
  const lowest = Math.floor(estimate.mean - 3.5 * estimate.sd);
  const highest = Math.ceil(estimate.mean + 3.5 * estimate.sd);
  const demandProbabilities: Array<[number, number]> = [];
  let total = 0;
  for (let demand = lowest; demand <= highest; demand += 1) {
    const probability = normalCdf((demand + 0.5 - estimate.mean) / estimate.sd) - normalCdf((demand - 0.5 - estimate.mean) / estimate.sd);
    if (probability > 1e-4) {
      demandProbabilities.push([demand, probability]);
      total += probability;
    }
  }
  if (total <= 0) return distribution;
  for (let seats = 0; seats <= capacity; seats += 1) {
    const mass = distribution[seats] ?? 0;
    if (mass <= 0) continue;
    for (const [demand, probability] of demandProbabilities) {
      const after = Math.min(capacity, Math.max(0, seats - demand));
      next[after] = (next[after] ?? 0) + mass * (probability / total);
    }
  }
  return next;
}

export function pointDistribution(seats: number, capacity = defaultSeatCapacity): number[] {
  const distribution = new Array<number>(capacity + 1).fill(0);
  distribution[Math.min(Math.max(seats, 0), capacity)] = 1;
  return distribution;
}

export function distributionMean(distribution: number[]): number {
  let mean = 0;
  for (let seats = 0; seats < distribution.length; seats += 1) mean += (distribution[seats] ?? 0) * seats;
  return mean;
}

export function distributionQuantile(distribution: number[], quantile: number): number {
  let cumulative = 0;
  for (let seats = 0; seats < distribution.length; seats += 1) {
    cumulative += distribution[seats] ?? 0;
    if (cumulative >= quantile) return seats;
  }
  return distribution.length - 1;
}

// ── 구간합 역산 프로파일 (v2 §4.3: 균등 배분 제거) ──
// 관측쌍이 주는 것은 구간 합 Δᵢ = Σ_{k∈Kᵢ} N_k 뿐이다. 배분을 가정하지 않고,
// 서로 다른 운행의 구간 경계가 어긋나며 겹치는 것을 제약으로 삼아 정류장별
// 평균·분산을 ridge 최소제곱 좌표하강으로 복원한다. 모든 구간이 동일하게
// 겹치면(추가 정보 없음) 균등 배분과 같은 해로 퇴화한다.

interface SpanObservation {
  stops: number[];
  total: number;
}

const deconvolutionRidge = 1;
const deconvolutionSweeps = 200;
const deconvolutionTolerance = 1e-9;

interface SpanSolution {
  values: Map<number, number>;
  fitted: number[];
}

function solveSpanSums(spans: SpanObservation[], targets: number[], floor: number | null): SpanSolution {
  const covering = new Map<number, number[]>();
  spans.forEach((span, index) => {
    for (const stop of span.stops) {
      const list = covering.get(stop) ?? [];
      list.push(index);
      covering.set(stop, list);
    }
  });

  const values = new Map<number, number>();
  for (const [stop, indexes] of covering) {
    let sum = 0;
    for (const index of indexes) sum += (targets[index] ?? 0) / (spans[index]?.stops.length ?? 1);
    const initial = sum / indexes.length;
    values.set(stop, floor === null ? initial : Math.max(floor, initial));
  }

  const fitted = spans.map((span) => span.stops.reduce((sum, stop) => sum + (values.get(stop) ?? 0), 0));

  for (let sweep = 0; sweep < deconvolutionSweeps; sweep += 1) {
    let largestShift = 0;
    for (const [stop, indexes] of covering) {
      const current = values.get(stop) ?? 0;
      let numerator = 0;
      for (const index of indexes) numerator += (targets[index] ?? 0) - ((fitted[index] ?? 0) - current);
      let next = numerator / (indexes.length + deconvolutionRidge);
      if (floor !== null) next = Math.max(floor, next);
      if (next !== current) {
        for (const index of indexes) fitted[index] = (fitted[index] ?? 0) + next - current;
        values.set(stop, next);
        largestShift = Math.max(largestShift, Math.abs(next - current));
      }
    }
    if (largestShift < deconvolutionTolerance) break;
  }
  return { values, fitted };
}

export function buildDeconvolvedProfileRoute(snapshots: Snapshot[], acceptDate?: (date: string) => boolean, attribution: SpanAttribution = 'departure'): ProfileRoute {
  const profile: ProfileRoute = { weekday: {}, weekend: {}, depletion: { weekday: {}, weekend: {} } };
  const groups = new Map<string, SpanObservation[]>();
  const censoredCovers = new Map<string, number>();

  for (const observations of observationsByVehicle(snapshots, acceptDate).values()) {
    for (const run of splitRuns(observations)) {
      const depleted = run.find((observation) => observation.seats === 0);
      if (depleted) {
        const group = depleted.weekend ? profile.depletion.weekend : profile.depletion.weekday;
        const bySequence = group[String(depleted.bucket)] ?? {};
        bySequence[String(depleted.sequence)] = (bySequence[String(depleted.sequence)] ?? 0) + 1;
        group[String(depleted.bucket)] = bySequence;
      }

      for (let index = 1; index < run.length; index += 1) {
        const from = run[index - 1];
        const to = run[index];
        if (!from || !to) continue;
        const span = to.sequence - from.sequence;
        if (span <= 0 || to.time - from.time > pairMaxGapMs) continue;
        const stops: number[] = [];
        const [firstStop, lastStop] = spanStopRange(from.sequence, to.sequence, attribution);
        for (let sequence = firstStop; sequence <= lastStop; sequence += 1) stops.push(sequence);
        const groupKey = `${to.weekend ? 'weekend' : 'weekday'}|${to.bucket}`;
        if (from.seats === 0 || to.seats === 0) {
          for (const stop of stops) {
            const cellKey = `${groupKey}|${stop}`;
            censoredCovers.set(cellKey, (censoredCovers.get(cellKey) ?? 0) + 1);
          }
          continue;
        }
        const spansForGroup = groups.get(groupKey) ?? [];
        spansForGroup.push({ stops, total: from.seats - to.seats });
        groups.set(groupKey, spansForGroup);
      }
    }
  }

  for (const [groupKey, spans] of groups) {
    const [groupName, bucketKey] = groupKey.split('|');
    if (!bucketKey) continue;
    const target = groupName === 'weekend' ? profile.weekend : profile.weekday;
    const totals = spans.map((span) => span.total);
    const means = solveSpanSums(spans, totals, null);
    const squaredResiduals = spans.map((span, index) => ((totals[index] ?? 0) - (means.fitted[index] ?? 0)) ** 2);
    const variances = solveSpanSums(spans, squaredResiduals, 0);

    const coverCounts = new Map<number, number>();
    for (const span of spans) {
      for (const stop of span.stops) coverCounts.set(stop, (coverCounts.get(stop) ?? 0) + 1);
    }

    for (const [stop, count] of coverCounts) {
      const mean = means.values.get(stop) ?? 0;
      const variance = variances.values.get(stop) ?? 0;
      const byBucket = target[String(stop)] ?? {};
      byBucket[bucketKey] = {
        weight: count,
        demandSum: mean * count,
        demandSquaredSum: (variance + mean * mean) * count,
        censoredWeight: censoredCovers.get(`${groupKey}|${stop}`) ?? 0,
      };
      target[String(stop)] = byBucket;
    }
  }

  // 검열 구간만 지나간 셀도 저신뢰 신호를 위해 남긴다 (균등 배분 빌더와 같은 의미).
  for (const [cellKey, count] of censoredCovers) {
    const [groupName, bucketKey, stopKey] = cellKey.split('|');
    if (!bucketKey || !stopKey) continue;
    const target = groupName === 'weekend' ? profile.weekend : profile.weekday;
    const byBucket = target[stopKey] ?? {};
    if (!byBucket[bucketKey]) {
      byBucket[bucketKey] = { weight: 0, demandSum: 0, demandSquaredSum: 0, censoredWeight: count };
      target[stopKey] = byBucket;
    }
  }

  return profile;
}
