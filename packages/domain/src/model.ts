export type Direction = 'up' | 'down';

export type SeatState = 'ok' | 'warn' | 'bad' | 'unknown';

// 승차할 수 없는 정류장. GBIS는 고속도로 진출입로·톨게이트처럼 노선이 지나가기만 하는
// 지점을 정류장 목록에 함께 내려주고, 이름 끝의 표기로만 구분한다.
//
// 표기가 바뀐 적이 있다. 2026-07 중 `(경유)` → `(미정차)`로 관측됐고, 한쪽만 보던 코드가
// 조용히 아무것도 못 걸러 냈다. 새 표기가 또 생기면 여기만 고친다.
const nonBoardingMarkers = ['미정차', '경유'] as const;

export function isNonBoardingStop(name: string | null): boolean {
  if (!name) return false;
  return nonBoardingMarkers.some((marker) => name.includes(`(${marker})`));
}

export interface Route {
  id: string;
  name: string;
  type: string | null;
  startStationName: string | null;
  endStationName: string | null;
}

export interface RouteStop {
  id: string | null;
  name: string | null;
  sequence: number;
  directionSequence: number | null;
  isTurnStop: boolean;
  latitude: number | null;
  longitude: number | null;
}

export interface VehicleSnapshot {
  id: string | null;
  currentStopId: string | null;
  currentStopSequence: number | null;
  remainingSeats: number | null;
  crowded: number | null;
  status: number | null;
}

export interface Snapshot {
  collectedAt: string;
  route: Route;
  apiQueryTime: string | null;
  vehicles: VehicleSnapshot[];
}

export interface RouteCache {
  cachedAt: string;
  route: Route;
  stops: RouteStop[];
}

export interface DisplayStop {
  sequence: number;
  name: string | null;
  direction: Direction | null;
  isTurn: boolean;
  latitude: number | null;
  longitude: number | null;
}

export interface DisplayVehicle {
  id: string | null;
  stationSeq: number | null;
  remainingSeats: number | null;
  crowded: number | null;
  status: number | null;
  direction: Direction | null;
}

export interface LatestRoute {
  route: Route;
  collectedAt: string | null;
  turnSequence: number | null;
  stops: DisplayStop[];
  vehicles: DisplayVehicle[];
  // 정류장 시퀀스 → 마지막 큐 해소 이후 만석으로 떠난 버스 수 (boarding.ts).
  // 조밀 관측이 없는 정류장은 도착·출발을 가릴 수 없어 항목 자체가 없다 — 0과 다르다.
  fullDepartureStreaks: Record<string, number>;
}

export interface LatestPayload {
  generatedAt: string;
  routes: LatestRoute[];
}

export interface HistoryBucket {
  samples: number;
  zeroCount: number;
}

export type HistoryBuckets = Record<string, Record<string, HistoryBucket>>;

export interface HistoryRoute {
  weekday: HistoryBuckets;
  weekend: HistoryBuckets;
}

export interface HistoryPayload {
  generatedAt: string;
  routes: Record<string, HistoryRoute>;
}

export interface ProfileCell {
  weight: number;
  demandSum: number;
  demandSquaredSum: number;
  censoredWeight: number;
}

export type ProfileBuckets = Record<string, Record<string, ProfileCell>>;

export type DepletionCounts = Record<string, Record<string, number>>;

export interface ProfileRoute {
  weekday: ProfileBuckets;
  weekend: ProfileBuckets;
  depletion: { weekday: DepletionCounts; weekend: DepletionCounts };
}

export interface ProfilePayload {
  generatedAt: string;
  routes: Record<string, ProfileRoute>;
}

export interface SeatBucket {
  samples: number;
  minSeats: number | null;
  zeroCount: number;
  unknownCount: number;
  avgSeats: number | null;
}

export type DailyBuckets = Record<string, Record<string, SeatBucket>>;

type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asList(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

export function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function readIdentifier(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return readString(value);
}

export function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

export function readRoute(value: unknown): Route | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id);
  const name = readString(value.name);
  if (!id || !name) return null;

  return {
    id,
    name,
    type: readString(value.type),
    startStationName: readString(value.startStationName),
    endStationName: readString(value.endStationName),
  };
}

function readDirection(value: unknown): Direction | null {
  return value === 'up' || value === 'down' ? value : null;
}

function readRouteStop(value: unknown): RouteStop | null {
  if (!isRecord(value)) return null;
  const sequence = readNumber(value.sequence);
  if (sequence === null) return null;

  return {
    id: readString(value.id),
    name: readString(value.name),
    sequence,
    directionSequence: readNumber(value.directionSequence),
    isTurnStop: value.isTurnStop === true,
    latitude: readNumber(value.latitude),
    longitude: readNumber(value.longitude),
  };
}

function readVehicleSnapshot(value: unknown): VehicleSnapshot | null {
  if (!isRecord(value)) return null;
  return {
    id: readString(value.id),
    currentStopId: readString(value.currentStopId),
    currentStopSequence: readNumber(value.currentStopSequence),
    remainingSeats: readNumber(value.remainingSeats),
    crowded: readNumber(value.crowded),
    status: readNumber(value.status),
  };
}

export interface UpstreamErrorEnvelope {
  /** 공공데이터포털 공통 오류 코드. 20, 30, 31은 키와 권한, 22는 일일 한도, 01, 05, 23은 일시적. */
  code: string;
  message: string;
}

/**
 * 공공데이터포털의 오류 봉투를 읽는다. 정상 응답에는 이 봉투가 없으므로 null이다.
 *
 * 상류는 키나 한도 문제를 HTTP 200 본문에 담아 보내기도 한다. 이걸 보지 않으면 항목 목록이 비어
 * "차량 0대"가 정상 응답처럼 지나간다. 수집기에서는 빈 스냅샷이 관측으로 남고, `/api/live`에서는
 * "운행 중인 차량이 없습니다"가 120초 캐시된다. 두 경로가 같은 규칙을 봐야 해서 여기 둔다.
 *
 * `returnAuthMsg`는 언어에 따라 달라진다(실측에서 "등록되지 않은 서비스키"가 왔다).
 * 판정은 숫자인 `returnReasonCode`로 하고 문구는 사람이 읽을 메시지로만 쓴다.
 */
export function readUpstreamErrorEnvelope(payload: unknown): UpstreamErrorEnvelope | null {
  if (!isRecord(payload)) return null;
  const envelope = isRecord(payload.OpenAPI_ServiceResponse) ? payload.OpenAPI_ServiceResponse : null;
  const header = envelope && isRecord(envelope.cmmMsgHeader) ? envelope.cmmMsgHeader : null;
  if (!header) return null;

  const reasonCode = readIdentifier(header.returnReasonCode);
  const authMessage = readIdentifier(header.returnAuthMsg) ?? '';
  const detail = readIdentifier(header.errMsg) ?? '';
  // 03이 NODATA다. 운행 차량이 없다는 뜻이라 오류가 아니다. 부분 문자열로 넓게 잡으면
  // 진짜 오류까지 삼키므로 코드와 NODATA 표기만 본다.
  const noData = reasonCode === '03'
    || authMessage.toUpperCase().includes('NODATA')
    || detail.toUpperCase().includes('NODATA');
  if (noData) return null;

  return {
    code: reasonCode ?? authMessage ?? 'UNKNOWN',
    message: [authMessage, detail].filter(Boolean).join(' '),
  };
}

export function readRouteCache(value: unknown): RouteCache | null {
  if (!isRecord(value)) return null;
  const cachedAt = readString(value.cachedAt);
  const route = readRoute(value.route);
  if (!cachedAt || !route) return null;

  const stops = asList(value.stops).map(readRouteStop).filter((stop): stop is RouteStop => stop !== null);
  return stops.length > 0 ? { cachedAt, route, stops } : null;
}

export function readSnapshot(value: unknown): Snapshot | null {
  if (!isRecord(value)) return null;
  const collectedAt = readString(value.collectedAt);
  const route = readRoute(value.route);
  if (!collectedAt || !route) return null;

  return {
    collectedAt,
    route,
    apiQueryTime: readString(value.apiQueryTime),
    vehicles: asList(value.vehicles).map(readVehicleSnapshot).filter((vehicle): vehicle is VehicleSnapshot => vehicle !== null),
  };
}

function readDisplayStop(value: unknown): DisplayStop | null {
  if (!isRecord(value)) return null;
  const sequence = readNumber(value.sequence);
  if (sequence === null) return null;
  return {
    sequence,
    name: readString(value.name),
    direction: readDirection(value.direction),
    isTurn: value.isTurn === true,
    latitude: readNumber(value.latitude),
    longitude: readNumber(value.longitude),
  };
}

function readDisplayVehicle(value: unknown): DisplayVehicle | null {
  if (!isRecord(value)) return null;
  return {
    id: readString(value.id),
    stationSeq: readNumber(value.stationSeq),
    remainingSeats: readNumber(value.remainingSeats),
    crowded: readNumber(value.crowded),
    status: readNumber(value.status),
    direction: readDirection(value.direction),
  };
}

function readStreaks(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  const streaks: Record<string, number> = {};
  for (const [sequenceKey, streak] of Object.entries(value)) {
    const count = readNumber(streak);
    if (count !== null && count >= 0) streaks[sequenceKey] = count;
  }
  return streaks;
}

function readLatestRoute(value: unknown): LatestRoute | null {
  if (!isRecord(value)) return null;
  const route = readRoute(value.route);
  if (!route) return null;

  return {
    route,
    collectedAt: readString(value.collectedAt),
    turnSequence: readNumber(value.turnSequence),
    stops: asList(value.stops).map(readDisplayStop).filter((stop): stop is DisplayStop => stop !== null),
    vehicles: asList(value.vehicles).map(readDisplayVehicle).filter((vehicle): vehicle is DisplayVehicle => vehicle !== null),
    fullDepartureStreaks: readStreaks(value.fullDepartureStreaks),
  };
}

function readHistoryBuckets(value: unknown): HistoryBuckets {
  if (!isRecord(value)) return {};
  const buckets: HistoryBuckets = {};
  for (const [sequenceKey, hours] of Object.entries(value)) {
    if (!isRecord(hours)) continue;
    buckets[sequenceKey] = {};
    for (const [bucketKey, bucket] of Object.entries(hours)) {
      if (!isRecord(bucket)) continue;
      const samples = readNumber(bucket.samples);
      const zeroCount = readNumber(bucket.zeroCount);
      if (samples === null || zeroCount === null) continue;
      buckets[sequenceKey][bucketKey] = { samples, zeroCount };
    }
  }
  return buckets;
}

export function readHistoryPayload(value: unknown): HistoryPayload | null {
  if (!isRecord(value)) return null;
  const generatedAt = readString(value.generatedAt);
  if (!generatedAt || !isRecord(value.routes)) return null;
  const routes: Record<string, HistoryRoute> = {};
  for (const [routeName, entry] of Object.entries(value.routes)) {
    if (!isRecord(entry)) continue;
    routes[routeName] = { weekday: readHistoryBuckets(entry.weekday), weekend: readHistoryBuckets(entry.weekend) };
  }
  return { generatedAt, routes };
}

function readProfileBuckets(value: unknown): ProfileBuckets {
  if (!isRecord(value)) return {};
  const buckets: ProfileBuckets = {};
  for (const [sequenceKey, byBucket] of Object.entries(value)) {
    if (!isRecord(byBucket)) continue;
    buckets[sequenceKey] = {};
    for (const [bucketKey, cell] of Object.entries(byBucket)) {
      if (!isRecord(cell)) continue;
      const weight = readNumber(cell.weight);
      const demandSum = readNumber(cell.demandSum);
      const demandSquaredSum = readNumber(cell.demandSquaredSum);
      const censoredWeight = readNumber(cell.censoredWeight);
      if (weight === null || demandSum === null || demandSquaredSum === null || censoredWeight === null) continue;
      buckets[sequenceKey][bucketKey] = { weight, demandSum, demandSquaredSum, censoredWeight };
    }
  }
  return buckets;
}

function readDepletionCounts(value: unknown): DepletionCounts {
  if (!isRecord(value)) return {};
  const counts: DepletionCounts = {};
  for (const [bucketKey, bySequence] of Object.entries(value)) {
    if (!isRecord(bySequence)) continue;
    counts[bucketKey] = {};
    for (const [sequenceKey, count] of Object.entries(bySequence)) {
      const parsed = readNumber(count);
      if (parsed !== null) counts[bucketKey][sequenceKey] = parsed;
    }
  }
  return counts;
}

export function readProfilePayload(value: unknown): ProfilePayload | null {
  if (!isRecord(value)) return null;
  const generatedAt = readString(value.generatedAt);
  if (!generatedAt || !isRecord(value.routes)) return null;
  const routes: Record<string, ProfileRoute> = {};
  for (const [routeName, entry] of Object.entries(value.routes)) {
    if (!isRecord(entry)) continue;
    const depletion = isRecord(entry.depletion) ? entry.depletion : {};
    routes[routeName] = {
      weekday: readProfileBuckets(entry.weekday),
      weekend: readProfileBuckets(entry.weekend),
      depletion: {
        weekday: readDepletionCounts(depletion.weekday),
        weekend: readDepletionCounts(depletion.weekend),
      },
    };
  }
  return { generatedAt, routes };
}

export function readLatestPayload(value: unknown): LatestPayload | null {
  if (!isRecord(value)) return null;
  const generatedAt = readString(value.generatedAt);
  if (!generatedAt) return null;
  return { generatedAt, routes: asList(value.routes).map(readLatestRoute).filter((route): route is LatestRoute => route !== null) };
}
