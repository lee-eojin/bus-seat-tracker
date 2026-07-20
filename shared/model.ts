export type Direction = 'up' | 'down';

export type SeatState = 'ok' | 'warn' | 'bad' | 'unknown';

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

export function readLatestPayload(value: unknown): LatestPayload | null {
  if (!isRecord(value)) return null;
  const generatedAt = readString(value.generatedAt);
  if (!generatedAt) return null;
  return { generatedAt, routes: asList(value.routes).map(readLatestRoute).filter((route): route is LatestRoute => route !== null) };
}
