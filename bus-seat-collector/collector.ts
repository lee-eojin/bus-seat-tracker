import { createHmac } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { asList, isRecord, readNumber, readString, type Route, type RouteStop, type Snapshot, type VehicleSnapshot } from '../shared/model.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDirectory, '..', '..');
const collectorDirectory = path.join(projectRoot, 'bus-seat-collector');
const dataDirectory = process.env.BUS_DATA_DIR ? path.resolve(process.env.BUS_DATA_DIR) : path.join(collectorDirectory, 'data');
const apiBaseUrl = 'https://apis.data.go.kr/6410000';
const apiPaths = {
  routes: '/busrouteservice/v2/getBusRouteListv2',
  routeStops: '/busrouteservice/v2/getBusRouteStationListv2',
  vehicleLocations: '/buslocationservice/v2/getBusLocationListv2',
} as const;

interface CollectorOptions {
  once: boolean;
  help: boolean;
  durationHours: number | null;
  intervalSeconds: number | null;
}

function readArguments(argumentsList: string[]): CollectorOptions {
  const options: CollectorOptions = { once: false, help: false, durationHours: null, intervalSeconds: null };
  for (const argument of argumentsList) {
    const [name, value] = argument.split('=', 2);
    if (name === '--once') options.once = true;
    if (name === '--help') options.help = true;
    if (name === '--duration-hours' && value) options.durationHours = Number(value);
    if (name === '--interval-seconds' && value) options.intervalSeconds = Number(value);
  }
  return options;
}

function printHelp(): void {
  console.log(`Usage:
  npm run collect -- --once
  npm run collect -- --duration-hours=24 --interval-seconds=60

Set GYEONGGI_BUS_API_KEY in bus-seat-collector/.env before collecting.`);
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

async function loadEnvironment(): Promise<void> {
  let environmentText: string;
  try {
    environmentText = await readFile(path.join(collectorDirectory, '.env'), 'utf8');
  } catch (error: unknown) {
    if (isMissingFile(error)) return;
    throw error;
  }

  for (const line of environmentText.split(/\r?\n/)) {
    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) continue;
    const name = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (name && !name.startsWith('#') && !process.env[name]) process.env[name] = value;
  }
}

function getResponseItems(payload: unknown, itemNames: string[]): unknown[] {
  if (!isRecord(payload)) return [];
  const response = isRecord(payload.response) ? payload.response : null;
  const body = response && isRecord(response.msgBody)
    ? response.msgBody
    : isRecord(payload.msgBody)
      ? payload.msgBody
      : response && isRecord(response.body)
        ? response.body
        : isRecord(payload.body)
          ? payload.body
          : payload;

  for (const itemName of itemNames) {
    const items = asList(body[itemName]);
    if (items.length > 0) return items;
  }
  return [];
}

function getQueryTime(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const response = isRecord(payload.response) ? payload.response : null;
  const header = response && isRecord(response.msgHeader)
    ? response.msgHeader
    : isRecord(payload.msgHeader)
      ? payload.msgHeader
      : null;
  return header ? readString(header.queryTime) : null;
}

async function requestApi(apiPath: string, parameters: Record<string, string>, apiKey: string): Promise<unknown> {
  const requestUrl = new URL(apiBaseUrl + apiPath);
  requestUrl.search = new URLSearchParams({ serviceKey: apiKey, format: 'json', ...parameters }).toString();
  const response = await fetch(requestUrl, { signal: AbortSignal.timeout(15_000) });
  const responseText = await response.text();
  if (!response.ok) throw new Error(`API request failed (${response.status}): ${responseText.slice(0, 180)}`);
  try {
    return JSON.parse(responseText) as unknown;
  } catch {
    throw new Error(`API did not return JSON. Confirm the service key and API access: ${responseText.slice(0, 180)}`);
  }
}

async function findRoute(routeName: string, apiKey: string): Promise<Route> {
  const routes = getResponseItems(await requestApi(apiPaths.routes, { keyword: routeName }, apiKey), ['busRouteList', 'busRoute']);
  const candidate = routes.find((route) => isRecord(route) && readString(route.routeName) === routeName);
  if (!isRecord(candidate)) throw new Error(`${routeName}번의 정확한 노선 ID를 찾지 못했습니다.`);
  const id = readString(candidate.routeId);
  const name = readString(candidate.routeName);
  if (!id || !name) throw new Error(`${routeName}번의 노선 응답이 완전하지 않습니다.`);
  return {
    id,
    name,
    type: readString(candidate.routeTypeName),
    startStationName: readString(candidate.startStationName),
    endStationName: readString(candidate.endStationName),
  };
}

function readStop(value: unknown): RouteStop | null {
  if (!isRecord(value)) return null;
  const sequence = readNumber(value.stationSeq);
  if (sequence === null) return null;
  return {
    id: readString(value.stationId),
    name: readString(value.stationName),
    sequence,
    directionSequence: readNumber(value.turnSeq),
    isTurnStop: value.turnYn === 'Y',
    latitude: readNumber(value.y),
    longitude: readNumber(value.x),
  };
}

async function fetchRouteStops(route: Route, apiKey: string): Promise<RouteStop[]> {
  const stops = getResponseItems(await requestApi(apiPaths.routeStops, { routeId: route.id }, apiKey), ['busRouteStationList', 'busRouteStation'])
    .map(readStop)
    .filter((stop): stop is RouteStop => stop !== null);
  if (stops.length === 0) throw new Error(`${route.name}번의 정류장 목록이 비어 있습니다.`);
  return stops;
}

function anonymizeVehicleId(vehicle: Record<string, unknown>, apiKey: string): string | null {
  const vehicleId = readString(vehicle.plateNo) ?? readString(vehicle.vehId);
  return vehicleId ? createHmac('sha256', apiKey).update(vehicleId).digest('hex').slice(0, 16) : null;
}

function readVehicle(value: unknown, apiKey: string): VehicleSnapshot | null {
  if (!isRecord(value)) return null;
  return {
    id: anonymizeVehicleId(value, apiKey),
    currentStopId: readString(value.stationId),
    currentStopSequence: readNumber(value.stationSeq),
    remainingSeats: readNumber(value.remainSeatCnt),
    crowded: readNumber(value.crowded),
    status: readNumber(value.stateCd),
  };
}

async function fetchVehicleSnapshot(route: Route, apiKey: string): Promise<Snapshot> {
  const payload = await requestApi(apiPaths.vehicleLocations, { routeId: route.id }, apiKey);
  return {
    collectedAt: new Date().toISOString(),
    route,
    apiQueryTime: getQueryTime(payload),
    vehicles: getResponseItems(payload, ['busLocationList', 'busLocation'])
      .map((vehicle) => readVehicle(vehicle, apiKey))
      .filter((vehicle): vehicle is VehicleSnapshot => vehicle !== null),
  };
}

async function cacheRouteStops(route: Route, stops: RouteStop[]): Promise<void> {
  const routesDirectory = path.join(dataDirectory, 'routes');
  await mkdir(routesDirectory, { recursive: true });
  await writeFile(path.join(routesDirectory, `${route.id}-stops.json`), `${JSON.stringify({ cachedAt: new Date().toISOString(), route, stops }, null, 2)}\n`);
}

async function appendSnapshot(snapshot: Snapshot): Promise<void> {
  const snapshotsDirectory = path.join(dataDirectory, 'snapshots');
  await mkdir(snapshotsDirectory, { recursive: true });
  const filePath = path.join(snapshotsDirectory, `${snapshot.route.name}-${snapshot.collectedAt.slice(0, 10)}.jsonl`);
  await appendFile(filePath, `${JSON.stringify(snapshot)}\n`);
}

async function collectOnce(routes: Route[], apiKey: string): Promise<void> {
  const snapshots = await Promise.all(routes.map((route) => fetchVehicleSnapshot(route, apiKey)));
  await Promise.all(snapshots.map(appendSnapshot));
  const vehicleCount = snapshots.reduce((count, snapshot) => count + snapshot.vehicles.length, 0);
  console.log(`${new Date().toLocaleTimeString('ko-KR')} · ${snapshots.length}개 노선, 운행 차량 ${vehicleCount}대 저장`);
}

async function main(): Promise<void> {
  const options = readArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  await loadEnvironment();
  const apiKey = process.env.GYEONGGI_BUS_API_KEY;
  if (!apiKey) throw new Error('GYEONGGI_BUS_API_KEY가 없습니다. .env.example을 복사해 .env에 입력하세요.');

  const routeNames = (process.env.ROUTE_NAMES ?? '3330,1650').split(',').map((routeName) => routeName.trim()).filter(Boolean);
  const routes = await Promise.all(routeNames.map((routeName) => findRoute(routeName, apiKey)));
  await Promise.all(routes.map(async (route) => cacheRouteStops(route, await fetchRouteStops(route, apiKey))));
  if (options.once) {
    await collectOnce(routes, apiKey);
    return;
  }

  const durationHours = options.durationHours ?? Number(process.env.COLLECTION_DURATION_HOURS ?? 24);
  const intervalSeconds = options.intervalSeconds ?? Number(process.env.COLLECTION_INTERVAL_SECONDS ?? 60);
  if (!Number.isFinite(durationHours) || durationHours <= 0 || !Number.isFinite(intervalSeconds) || intervalSeconds < 10) {
    throw new Error('수집 시간은 0보다 크고, 수집 간격은 10초 이상이어야 합니다.');
  }

  const endsAt = Date.now() + durationHours * 60 * 60 * 1_000;
  do {
    try {
      await collectOnce(routes, apiKey);
    } catch (error: unknown) {
      console.error(`수집 실패: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (Date.now() + intervalSeconds * 1_000 >= endsAt) break;
    await new Promise<void>((resolve) => setTimeout(resolve, intervalSeconds * 1_000));
  } while (Date.now() < endsAt);
}

main().catch((error: unknown) => {
  console.error(`수집기를 시작하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
