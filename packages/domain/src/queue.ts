// 대기 인원 추정.
//
// 좌석을 남기고 떠난 버스는 그 순간 줄이 비었다는 뜻이다. 입석이 없는데 자리가 남았다면
// 기다리던 사람이 없었다는 얘기가 되기 때문이다. 그래서
//
//   대기(t) = λ × (t − 마지막 해소 시각) − 그 사이 탑승 인원
//
// λ는 `npm run queue -- --all-stops`가 낸 값이다. 정의와 한계는
// docs/model/queue-estimation.md에 정리했고
// 해소 사건 사이의 총 승차를 구간 길이로 나눈 것이다. 아래 표는 2026-07-20~07-28 평일
// 관측에서 구간 5개 이상, λ 0.2 이상인 정류장만 실었다. 없는 자리는 추정하지 않는다.
//
// 검증: 2026-07-24 18:57 판교역 현장 계수 38명. λ 2.69로 역산하면 마지막 해소 이후
// 14.1분이고, 그 시간대 배차와 만석 통과 빈도에 맞는다 (field-observations.jsonl).

import { estimatedTravelTimeMs } from './travel-time.js';

export type QueueWindow = 'morning' | 'evening';

const arrivalRates: Record<string, Record<QueueWindow, Record<number, number>>> = {
  '3330': {
    morning: { 19: 0.41, 22: 0.52, 51: 0.24, 54: 0.3, 55: 1.37, 61: 0.23 },
    evening: { 14: 0.49, 19: 1.69, 20: 0.42, 21: 2.36, 22: 2.69, 56: 0.26, 57: 0.55 },
  },
  '1650': {
    morning: { 24: 0.27, 26: 0.27, 49: 0.4, 50: 0.46, 58: 0.3 },
    evening: { 16: 0.49, 18: 0.2, 21: 0.79, 22: 0.41, 24: 0.21, 61: 0.34, 78: 0.25 },
  },
};

// λ를 낸 창과 같은 시간대에서만 쓴다. 낮이나 심야에 아침 λ를 갖다 쓰면 과대추정이 된다.
export function queueWindowAt(minutesOfDay: number): QueueWindow | null {
  if (minutesOfDay >= 6 * 60 && minutesOfDay < 10 * 60) return 'morning';
  if (minutesOfDay >= 17 * 60 && minutesOfDay < 21 * 60) return 'evening';
  return null;
}

export function arrivalRateAt(routeName: string, sequence: number, window: QueueWindow): number | null {
  return arrivalRates[routeName]?.[window]?.[sequence] ?? null;
}

export interface QueueEstimate {
  /** 추정 대기 인원 */
  people: number;
  /** 마지막 해소로 본 시점부터 흐른 분 */
  elapsedMinutes: number;
  /** 분당 도착률 */
  rate: number;
  /** 해소를 못 봤고 관측 범위만으로 잡은 하한인지 */
  lowerBound: boolean;
}

export interface QueueVehicle {
  stationSeq: number | null;
  remainingSeats: number | null;
}

export interface QueueClearing {
  at: number;
  lowerBound: boolean;
}

const clearingLookaheadStops = 2;
const lowerBoundWindowStops = 10;
const maximumQueueElapsedMinutes = 60;

/**
 * 마지막 해소 시각과 그 뒤 탑승 인원으로 지금 줄을 낸다.
 * `boardedSince`는 해소 이후 이 정류장에서 태운 인원이며 모르면 0을 넣는다.
 */
export function estimateQueue(
  rate: number,
  elapsedMinutes: number,
  boardedSince: number,
  lowerBound: boolean,
): QueueEstimate | null {
  if (!(rate > 0) || !(elapsedMinutes >= 0)) return null;
  const people = Math.max(0, rate * elapsedMinutes - Math.max(0, boardedSince));
  return { people, elapsedMinutes, rate, lowerBound };
}

/** 통계적 신뢰구간이 아니라 표본 부족을 드러내기 위한 임시 ±35% 표시 폭이다. */
export function queueRange(estimate: QueueEstimate): { low: number; high: number } {
  const spread = 0.35;
  return {
    low: Math.max(0, Math.floor(estimate.people * (1 - spread))),
    high: Math.ceil(estimate.people * (1 + spread)),
  };
}

/** 바로 다음 정류장에 좌석을 남긴 차량이 있으면 이번 갱신 시각을 해소 시각으로 쓴다. */
export function detectLiveClearing(
  vehicles: readonly QueueVehicle[],
  sequence: number,
  nowMs: number,
): number | null {
  const cleared = vehicles.some((vehicle) => (
    vehicle.stationSeq === sequence + 1
    && vehicle.remainingSeats !== null
    && vehicle.remainingSeats > 0
  ));
  return cleared ? nowMs : null;
}

/** 하류 차량 위치에서 정류장당 2분을 되짚어 첫 화면의 해소 근거를 만든다. */
export function inferQueueClearing(
  vehicles: readonly QueueVehicle[],
  sequence: number,
  nowMs: number,
): QueueClearing | null {
  const downstream = vehicles
    .flatMap((vehicle) => (
      vehicle.stationSeq !== null && vehicle.stationSeq > sequence
        ? [{ stationSeq: vehicle.stationSeq, remainingSeats: vehicle.remainingSeats }]
        : []
    ))
    .sort((left, right) => left.stationSeq - right.stationSeq);

  if (downstream.length === 0) return null;

  const nearbyClearing = downstream.find((vehicle) => (
    vehicle.stationSeq - sequence <= clearingLookaheadStops
    && vehicle.remainingSeats !== null
    && vehicle.remainingSeats > 0
  ));
  if (nearbyClearing) {
    return {
      at: nowMs - estimatedTravelTimeMs(nearbyClearing.stationSeq - sequence),
      lowerBound: false,
    };
  }

  const inWindow = downstream.filter((vehicle) => (
    vehicle.stationSeq - sequence <= lowerBoundWindowStops
  ));
  const farthest = inWindow[inWindow.length - 1];
  if (!farthest) return null;

  return {
    at: nowMs - estimatedTravelTimeMs(farthest.stationSeq - sequence),
    lowerBound: true,
  };
}

/** 직접 관측과 위치 추론 중 더 최근 근거를 고른다. 동률이면 기존 화면 동작대로 추론을 쓴다. */
export function selectQueueClearing(
  trackedAt: number | null | undefined,
  inferred: QueueClearing | null,
): QueueClearing | null {
  if (trackedAt !== null && trackedAt !== undefined && (!inferred || trackedAt > inferred.at)) {
    return { at: trackedAt, lowerBound: false };
  }
  return inferred;
}

/** 현재 시각 기준 대기 인원을 계산한다. 60분을 넘긴 근거는 버린다. */
export function estimateQueueAt(
  rate: number,
  nowMs: number,
  trackedAt: number | null | undefined,
  inferred: QueueClearing | null,
  boardedSince: number,
): QueueEstimate | null {
  const clearing = selectQueueClearing(trackedAt, inferred);
  if (!clearing) return null;

  const elapsedMinutes = (nowMs - clearing.at) / 60_000;
  if (elapsedMinutes > maximumQueueElapsedMinutes) return null;
  return estimateQueue(rate, elapsedMinutes, boardedSince, clearing.lowerBound);
}
