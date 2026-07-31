// 수집 스케줄. 워크플로(collect-bus-seats.yml)와 예산 계산기(scripts/call-budget.mjs)가
// 같은 정의를 쓴다. 예전에는 이 로직이 워크플로 안 인라인 JS로만 있어 테스트도 검산도
// 불가능했고, DEPLOY.md의 호출 예산 표를 손으로 세다가 실제와 어긋났다.
//
// 모든 함수가 시각을 인자로 받는다. 그래야 하루치를 돌려 볼 수 있다.

/**
 * start, end       창 경계 (KST 자정 기준 분). start 오름차순이어야 하고,
 *                  경계가 맞닿은 창은 앞의 것이 먼저 잡힌다.
 * interval         창의 기본 간격(초)
 * denseStart/End   창 안의 조밀 구간
 * denseDay         조밀 구간을 적용할 요일(0=일). 없으면 매일
 */
export interface CollectionWindow {
  start: number;
  end: number;
  interval: number;
  denseStart?: number;
  denseEnd?: number;
  denseInterval?: number;
  denseDay?: number;
}

export const peakIntervalSeconds = 600;
export const denseIntervalSeconds = 60;
export const daytimeIntervalSeconds = 1200;
export const calibrationIntervalSeconds = 120;

// 피크 조밀 구간은 정류장별 도착과 출발을 한 번의 관측으로 잡기 위한 것이다
// (docs/queue-recovery.md §8). 10분 간격에서는 버스가 관측 사이에 5~7정류장을 지나
// 정류장 단위 승차량을 읽을 수 없다. 배치 근거는 만석 분포 실측(RUNNING.md)과 필드
// 기록 시각이다. 아침 절정 07:00-08:00과 범계역 기록(08:37), 저녁 절정 18:00-18:30과
// 판교역 기록(18:57)이 모두 안에 들어온다. 전 피크를 60초로 돌리면 API 한도에 육박한다.
//
// 낮 창은 매시 1회 크론이 남기던 공백을 메운다. 60분 간격 관측은 순수요 학습의 운행
// 분할 기준(shared/profile.ts runSplitGapMs 45분)에 전부 걸려 관측쌍을 하나도 만들지
// 못했고, 그 결과 10:30~16:30 버킷의 μ가 통째로 0이었다. μ가 0이면 판정이 좌석만 보고
// 무조건 여유로 나간다. 이 구간은 잔여석 0 판독이 실측 0건이라 검열이 없고, 검열이
// 없으면 좌석 차이가 곧 순수요라 구간합 역산이 편향 없이 식별된다. 아침만큼 촘촘할
// 필요가 없어 20분으로 둔다.
//
// 수요일 낮 보정 구간은 역산의 정답을 만든다. 2분 간격이면 관측 사이 이동이 1정류장
// 안쪽이라 정류장별 승차가 직접 읽히고, 같은 구간을 20분으로 다운샘플해 역산한 값과
// 대조할 수 있다. 아침은 검열 때문에 이 대조가 성립하지 않는다.
export const weekdayWindows: CollectionWindow[] = [
  { start: 390, end: 600, interval: peakIntervalSeconds, denseStart: 420, denseEnd: 540, denseInterval: denseIntervalSeconds },
  { start: 600, end: 960, interval: daytimeIntervalSeconds, denseStart: 780, denseEnd: 810, denseInterval: calibrationIntervalSeconds, denseDay: 3 },
  { start: 1050, end: 1230, interval: peakIntervalSeconds, denseStart: 1080, denseEnd: 1170, denseInterval: denseIntervalSeconds },
];

// 주말은 창 없이 균등 스냅샷만 한다.
export const weekendWindows: CollectionWindow[] = [];

// 창 시작 몇 분 전부터 실행이 창을 이어받을 수 있는지. 시동 크론이 스로틀돼도
// 이 범위 안에 도착한 어떤 실행이든 창을 맡는다.
export const windowHandoverMinutes = 60;

const kstOffsetMs = 9 * 3600 * 1000;

function seoulClock(atMs: number): Date {
  return new Date(atMs + kstOffsetMs);
}

export function seoulDay(atMs: number): number {
  return seoulClock(atMs).getUTCDay();
}

export function seoulMinutes(atMs: number): number {
  const shifted = seoulClock(atMs);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

function isWeekend(day: number): boolean {
  return day === 0 || day === 6;
}

export function windowsFor(atMs: number): CollectionWindow[] {
  return isWeekend(seoulDay(atMs)) ? weekendWindows : weekdayWindows;
}

export interface ActiveWindow {
  startMs: number;
  endMs: number;
  interval: number;
}

export function activeWindow(atMs: number): ActiveWindow | null {
  const minutes = seoulMinutes(atMs);
  const found = windowsFor(atMs).find(
    (candidate) => minutes >= candidate.start - windowHandoverMinutes && minutes < candidate.end,
  );
  if (!found) return null;
  const shifted = seoulClock(atMs);
  const kstMidnight = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  return {
    startMs: kstMidnight + found.start * 60_000 - kstOffsetMs,
    endMs: kstMidnight + found.end * 60_000 - kstOffsetMs,
    interval: found.interval,
  };
}

function coveringWindow(atMs: number): CollectionWindow | null {
  const minutes = seoulMinutes(atMs);
  return windowsFor(atMs).find((candidate) => minutes >= candidate.start && minutes < candidate.end) ?? null;
}

function windowIntervalSeconds(window: CollectionWindow, atMs: number): number {
  const minutes = seoulMinutes(atMs);
  const dense = window.denseStart !== undefined
    && window.denseEnd !== undefined
    && minutes >= window.denseStart
    && minutes < window.denseEnd
    && (window.denseDay === undefined || window.denseDay === seoulDay(atMs));
  return dense ? (window.denseInterval ?? window.interval) : window.interval;
}

/** 루프가 조밀 구간을 넘나들 수 있으므로 간격은 사이클마다 다시 정한다. */
export function scheduledIntervalSeconds(atMs: number): number {
  const found = coveringWindow(atMs);
  return found ? windowIntervalSeconds(found, atMs) : peakIntervalSeconds;
}

// 창 밖 운행 시간대는 매시 정각 크론의 스냅샷 1회가 전부다 (collect-bus-seats.yml).
export const offWindowSnapshotGapSeconds = 3600;

/**
 * 이 시각에 최신 스냅샷이 정상적으로 얼마나 낡아 있을 수 있는지(초).
 * 창 안은 그 구간의 수집 간격, 창 밖 운행 시간대는 매시 1회 간격이다.
 * 운행 시간 밖은 수집 자체가 없으므로 null — 신선도를 따질 수 없다.
 */
export function expectedSnapshotGapSeconds(atMs: number): number | null {
  if (!withinServiceHours(atMs)) return null;
  const found = coveringWindow(atMs);
  return found ? windowIntervalSeconds(found, atMs) : offWindowSnapshotGapSeconds;
}

/**
 * 두 시각 사이에서 운행 시간에 든 부분만 센 경과(ms). 관측 신선도는 이걸로 재야 한다.
 * 벽시계 나이로 재면 심야 무수집 공백을 가로지르는 새벽 첫 발행이 전날 저녁 스냅샷을
 * 근거로 삼는 정상 상황까지 낡음으로 오판한다.
 */
export function serviceElapsedMs(fromMs: number, toMs: number): number {
  let total = 0;
  for (let cursor = fromMs; cursor < toMs; cursor += 60_000) {
    if (withinServiceHours(cursor)) total += Math.min(60_000, toMs - cursor);
  }
  return total;
}

// 스냅샷 운행 시간대 (KST): 평일 05:00-22:00, 주말 06:00 이후.
// 마지막 정시 실행이 스로틀로 밀려도 남도록 평일 끝에 한 시간 여유를 뒀고,
// 그 밖의 심야에는 수집하지 않는다.
export const weekdayServiceStart = 300;
export const weekdayServiceEnd = 1320;
export const weekendServiceStart = 360;

export function withinServiceHours(atMs: number): boolean {
  const minutes = seoulMinutes(atMs);
  if (isWeekend(seoulDay(atMs))) return minutes >= weekendServiceStart;
  return minutes >= weekdayServiceStart && minutes < weekdayServiceEnd;
}
