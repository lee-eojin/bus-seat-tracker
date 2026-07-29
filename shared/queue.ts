// 대기 인원 추정.
//
// 좌석을 남기고 떠난 버스는 그 순간 줄이 비었다는 뜻이다. 입석이 없는데 자리가 남았다면
// 기다리던 사람이 없었다는 얘기가 되기 때문이다. 그래서
//
//   대기(t) = λ × (t − 마지막 해소 시각) − 그 사이 탑승 인원
//
// λ는 `npm run queue -- --all-stops`가 낸 값이다. 정의는 docs/queue-recovery.md와 같고
// 해소 사건 사이의 총 승차를 구간 길이로 나눈 것이다. 아래 표는 2026-07-20~07-28 평일
// 관측에서 구간 5개 이상, λ 0.2 이상인 정류장만 실었다. 없는 자리는 추정하지 않는다.
//
// 검증: 2026-07-24 18:57 판교역 현장 계수 38명. λ 2.69로 역산하면 마지막 해소 이후
// 14.1분이고, 그 시간대 배차와 만석 통과 빈도에 맞는다 (field-observations.jsonl).

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

/** 표본이 얇아 점추정을 그대로 읽히면 안 된다. 폭을 넓게 잡아 범위로 보여준다. */
export function queueRange(estimate: QueueEstimate): { low: number; high: number } {
  const spread = 0.35;
  return {
    low: Math.max(0, Math.floor(estimate.people * (1 - spread))),
    high: Math.ceil(estimate.people * (1 + spread)),
  };
}
