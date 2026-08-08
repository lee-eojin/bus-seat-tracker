import type { VehicleObservation } from './profile.js';

// 탑승 가능성 판정 (docs/model/boarding-verdict.md).
//
// 좌석 예보만으로는 "탈 수 있는가"에 답할 수 없다. 같은 대기 인원이 좌석에 따라 정반대
// 결론을 내기 때문이다. 대기 29명은 44석 버스에서 전원 탑승이고, 대기 17명은 13석
// 버스에서 4명이 남는다. 판정은 좌석과 대기를 함께 봐야 성립한다.

/** 정류장 한 곳을 지나간 버스 하나의 도착 잔여석과 출발 잔여석. */
export interface StopPass {
  arrivalSeats: number;
  departureSeats: number;
}

export function boardedAt(pass: StopPass): number {
  return Math.max(0, pass.arrivalSeats - pass.departureSeats);
}

/** 좌석을 남기고 떠났다면 타려던 사람이 다 탔다는 뜻이다. */
export function departedWithSeats(pass: StopPass): boolean {
  return pass.departureSeats > 0;
}

/**
 * 버스 한 대의 통과만으로 대기 인원을 말할 수 있는 것 (docs/model/queue-estimation.md).
 *
 *   좌석을 남기고 출발 → 대기 = 승차 인원 (정확)
 *   만차로 출발       → 대기 ≥ 승차 인원 (하한)
 *
 * λ도 구간도 필요 없다. 대신 만차 버스는 하한만 주므로 혼잡할수록 정보가 얇아진다.
 */
export function queueStatement(pass: StopPass): { people: number; exact: boolean } {
  return { people: boardedAt(pass), exact: departedWithSeats(pass) };
}

/** 마지막 큐 해소 이후 만차로 떠난 버스 수. 큐가 쌓이는 중이라는 신호다. */
export function nextFullDepartureStreak(streak: number, pass: StopPass): number {
  return departedWithSeats(pass) ? 0 : streak + 1;
}

/**
 * 정류장별 만석 연속 수를 최근 관측에서 센다.
 *
 * 같은 정류장에서 두 번 이상 잡힌 운행만 쓴다. 한 번뿐이면 그 값이 도착인지 출발인지
 * 가릴 수 없기 때문이다(docs/model/queue-estimation.md). 따라서 조밀 수집 구간 밖에서는
 * 항목이 아예 비고, 그것은 "연속 0"이 아니라 "모름"이다. 호출부는 둘을 구분해야 한다.
 *
 * 창은 [since, until] 양끝을 모두 닫는다. 상한이 없으면 기준 시각 이후의 통과까지 세어
 * 연속이 잘못 끊긴다. 학습 데이터로 과거 시점을 재현할 때 드러나는 차이다.
 */
export function fullDepartureStreaks(runs: VehicleObservation[][], since: number, until: number): Record<string, number> {
  const passesByStop = new Map<number, Array<{ at: number; pass: StopPass }>>();
  for (const run of runs) {
    const byStop = new Map<number, VehicleObservation[]>();
    for (const point of run) {
      if (point.time < since || point.time > until) continue;
      byStop.set(point.sequence, [...(byStop.get(point.sequence) ?? []), point]);
    }
    for (const [sequence, points] of byStop) {
      if (points.length < 2) continue;
      const first = points[0]!;
      const last = points[points.length - 1]!;
      const seen = passesByStop.get(sequence) ?? [];
      seen.push({ at: first.time, pass: { arrivalSeats: first.seats, departureSeats: last.seats } });
      passesByStop.set(sequence, seen);
    }
  }

  const streaks: Record<string, number> = {};
  for (const [sequence, passes] of passesByStop) {
    passes.sort((left, right) => left.at - right.at);
    let streak = 0;
    for (const item of passes) streak = nextFullDepartureStreak(streak, item.pass);
    streaks[String(sequence)] = streak;
  }
  return streaks;
}

export type BoardingVerdict = 'roomy' | 'tight' | 'unlikely';

// 좌석이 기대 수요보다 이만큼 많아야 "여유"로 본다. 좌석 예보와 수요 추정이 각각 3~4명
// 오차가 있는 것을 감안한 값이며, 조밀 수집분이 쌓이면 다시 맞춰야 하는 잠정치다.
export const verdictSeatMargin = 10;

/**
 * 30분 버킷 하나가 검열로 비면 μ가 실제의 몇 분의 1로 내려앉는다. 2026-07-24까지의
 * 학습분에서 범계역 08:00 버킷이 그랬다. 관측의 63%가 만석이라 버려져 μ가 1.88이
 * 됐고, 같은 시간대 실측 승차는 6.0이었다. 인접 버킷의 최댓값을 쓰면 그 셀을 우회한다.
 *
 * 시간축의 계통 밀림 때문이 아니다. 조밀 관측 197개 셀로 ±1 버킷 이동을 대조한 결과
 * 이동 없음이 가장 잘 맞았다(상관 0.466 대 0.420/0.372). 어디까지나 검열 대응이며,
 * 검열 보정이 들어오면 걷어내야 할 임시방편이다.
 */
export function expectedDemandAt(demandAt: (bucket: number) => number, bucket: number): number {
  return Math.max(0, demandAt(bucket), demandAt(bucket + 1));
}

/**
 * 판정 규칙.
 *
 *                 좌석 ≥ 수요 + 여유폭     좌석 < 수요 + 여유폭
 *   만석 연속 0       여유                    빠듯
 *   만석 연속 ≥1      빠듯                    어려움
 *
 * 만석이 이어지면 큐가 쌓이는 중이라 하한을 믿을 수 없다. 다만 큰 버스가 오면 밀린 줄을
 * 한 번에 태우므로(2026-07-27 07:24의 34석, 08:49의 43석) 좌석이 넉넉하면 한 단계 완화한다.
 */
export function boardingVerdict(input: {
  arrivalSeats: number;
  expectedDemand: number;
  fullDepartureStreak: number;
}): BoardingVerdict {
  const roomy = input.arrivalSeats >= input.expectedDemand + verdictSeatMargin;
  if (input.fullDepartureStreak === 0) return roomy ? 'roomy' : 'tight';
  return roomy ? 'tight' : 'unlikely';
}
