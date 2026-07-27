import { createHmac } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { asList, isRecord, readIdentifier, readNumber, readRouteCache, type Route, type RouteCache, type RouteStop, type Snapshot, type VehicleSnapshot } from '../shared/model.js';

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

// 노선 ID와 정류장 목록은 노선이 조정될 때만 바뀌는데, 수집 워크플로는 조밀 구간에서 60초마다
// 이 파일을 새 프로세스로 띄운다. 매번 다시 받으면 busrouteservice 호출이 사이클당 노선 수 × 2회씩
// 쌓여 일 한도(서비스당 1,000회)를 좌석과 무관한 노선 정보만으로 태운다. 좌석 관측이 쓰는
// buslocationservice 몫을 남기려면 캐시를 먼저 본다.
const routeCacheHours = Number(process.env.ROUTE_CACHE_HOURS ?? 24);

interface CollectorOptions {
  once: boolean;
  help: boolean;
  refreshRoutes: boolean;
  durationHours: number | null;
  intervalSeconds: number | null;
}

function readArguments(argumentsList: string[]): CollectorOptions {
  const options: CollectorOptions = { once: false, help: false, refreshRoutes: false, durationHours: null, intervalSeconds: null };
  for (const argument of argumentsList) {
    const [name, value] = argument.split('=', 2);
    if (name === '--once') options.once = true;
    if (name === '--help') options.help = true;
    if (name === '--refresh-routes') options.refreshRoutes = true;
    if (name === '--duration-hours' && value) options.durationHours = Number(value);
    if (name === '--interval-seconds' && value) options.intervalSeconds = Number(value);
  }
  return options;
}

function printHelp(): void {
  console.log(`Usage:
  npm run collect -- --once
  npm run collect -- --duration-hours=24 --interval-seconds=60
  npm run collect -- --once --refresh-routes

노선 ID와 정류장 목록은 ${routeCacheHours}시간 동안 재사용한다. 노선이 조정됐다면 --refresh-routes로
즉시 다시 받고, 주기를 바꾸려면 ROUTE_CACHE_HOURS를 설정한다.

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
  return header ? readIdentifier(header.queryTime) : null;
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
  const candidate = routes.find((route) => isRecord(route) && readIdentifier(route.routeName) === routeName);
  if (!isRecord(candidate)) throw new Error(`${routeName}번의 정확한 노선 ID를 찾지 못했습니다.`);
  const id = readIdentifier(candidate.routeId);
  const name = readIdentifier(candidate.routeName);
  if (!id || !name) throw new Error(`${routeName}번의 노선 응답이 완전하지 않습니다.`);
  return {
    id,
    name,
    type: readIdentifier(candidate.routeTypeName),
    startStationName: readIdentifier(candidate.startStationName),
    endStationName: readIdentifier(candidate.endStationName),
  };
}

function readStop(value: unknown): RouteStop | null {
  if (!isRecord(value)) return null;
  const sequence = readNumber(value.stationSeq);
  if (sequence === null) return null;
  return {
    id: readIdentifier(value.stationId),
    name: readIdentifier(value.stationName),
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

function anonymizeVehicleId(vehicle: Record<string, unknown>, hashSecret: string): string | null {
  const vehicleId = readIdentifier(vehicle.plateNo) ?? readIdentifier(vehicle.vehId);
  return vehicleId ? createHmac('sha256', hashSecret).update(vehicleId).digest('hex').slice(0, 16) : null;
}

function readVehicle(value: unknown, hashSecret: string): VehicleSnapshot | null {
  if (!isRecord(value)) return null;
  return {
    id: anonymizeVehicleId(value, hashSecret),
    currentStopId: readIdentifier(value.stationId),
    currentStopSequence: readNumber(value.stationSeq),
    remainingSeats: readNumber(value.remainSeatCnt),
    crowded: readNumber(value.crowded),
    status: readNumber(value.stateCd),
  };
}

async function fetchVehicleSnapshot(route: Route, apiKey: string, hashSecret: string): Promise<Snapshot> {
  const payload = await requestApi(apiPaths.vehicleLocations, { routeId: route.id }, apiKey);
  return {
    collectedAt: new Date().toISOString(),
    route,
    apiQueryTime: getQueryTime(payload),
    vehicles: getResponseItems(payload, ['busLocationList', 'busLocation'])
      .map((vehicle) => readVehicle(vehicle, hashSecret))
      .filter((vehicle): vehicle is VehicleSnapshot => vehicle !== null),
  };
}

async function cacheRouteStops(route: Route, stops: RouteStop[]): Promise<void> {
  const routesDirectory = path.join(dataDirectory, 'routes');
  await mkdir(routesDirectory, { recursive: true });
  await writeFile(path.join(routesDirectory, `${route.id}-stops.json`), `${JSON.stringify({ cachedAt: new Date().toISOString(), route, stops }, null, 2)}\n`);
}

// 캐시 파일 이름은 노선 ID인데 조회 시점에 아는 것은 노선 번호뿐이라, 디렉터리를 훑어 번호로 색인한다.
async function loadCachedRoutes(): Promise<Map<string, RouteCache>> {
  let fileNames: string[];
  try {
    fileNames = await readdir(path.join(dataDirectory, 'routes'));
  } catch (error: unknown) {
    if (isMissingFile(error)) return new Map();
    throw error;
  }

  const cachedRoutes = new Map<string, RouteCache>();
  for (const fileName of fileNames.filter((name) => name.endsWith('-stops.json'))) {
    const filePath = path.join(dataDirectory, 'routes', fileName);
    try {
      const cache = readRouteCache(JSON.parse(await readFile(filePath, 'utf8')) as unknown);
      if (!cache) continue;
      // 노선이 새 ID를 받으면 같은 번호의 캐시가 둘 남는다. readdir 순서는 보장되지 않으므로
      // 파일 순서가 아니라 수집 시각으로 고른다.
      const previous = cachedRoutes.get(cache.route.name);
      if (!previous || cachedAtMs(cache) > cachedAtMs(previous)) cachedRoutes.set(cache.route.name, cache);
    } catch {
      // 깨진 캐시는 없는 것으로 보고 API에서 다시 받는다. 수집을 멈출 이유는 아니다.
      console.warn(`정류장 캐시를 읽지 못해 다시 받습니다: ${fileName}`);
    }
  }
  return cachedRoutes;
}

function cachedAtMs(cache: RouteCache): number {
  const parsed = Date.parse(cache.cachedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isCacheFresh(cache: RouteCache, atMs: number): boolean {
  return atMs - cachedAtMs(cache) < routeCacheHours * 3_600_000;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// 노선 정보를 갱신하지 못하는 것과 좌석을 관측하지 못하는 것은 다른 사건이다.
// busrouteservice가 한도 소진이나 장애로 막혀도, 노선 ID와 정류장 순서는 거의 변하지 않으므로
// 만료된 캐시로 좌석 수집을 계속하는 편이 그날 표본을 통째로 버리는 것보다 낫다.
async function resolveRoutes(routeNames: string[], apiKey: string, refreshRoutes: boolean): Promise<Route[]> {
  // --refresh-routes는 캐시를 건너뛰라는 뜻이지 버리라는 뜻이 아니다. 갱신에 실패하면
  // 가진 캐시로 돌아갈 수 있어야 강제 갱신이 수집을 멈추는 발판이 되지 않는다.
  const cachedRoutes = await loadCachedRoutes();
  const atMs = Date.now();
  const reused: string[] = [];

  const resolved = await Promise.all(routeNames.map(async (routeName): Promise<Route | null> => {
    const cache = cachedRoutes.get(routeName);
    if (!refreshRoutes && cache && isCacheFresh(cache, atMs)) {
      reused.push(routeName);
      return cache.route;
    }

    try {
      const route = await findRoute(routeName, apiKey);
      await cacheRouteStops(route, await fetchRouteStops(route, apiKey));
      return route;
    } catch (error: unknown) {
      if (cache) {
        console.warn(`${routeName}번 노선 정보를 갱신하지 못해 ${cache.cachedAt} 캐시로 수집합니다: ${describeError(error)}`);
        return cache.route;
      }
      console.error(`${routeName}번 노선 정보가 없어 이번 수집에서 제외합니다: ${describeError(error)}`);
      return null;
    }
  }));

  const routes = resolved.filter((route): route is Route => route !== null);
  if (routes.length === 0) throw new Error(`수집할 노선을 하나도 확인하지 못했습니다: ${routeNames.join(', ')}번`);
  if (reused.length > 0) console.log(`정류장 캐시 재사용: ${reused.join(', ')}번`);
  return routes;
}

function koreanDate(value: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const partValue = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${partValue('year')}-${partValue('month')}-${partValue('day')}`;
}

async function appendSnapshot(snapshot: Snapshot): Promise<void> {
  const snapshotsDirectory = path.join(dataDirectory, 'snapshots');
  await mkdir(snapshotsDirectory, { recursive: true });
  const filePath = path.join(snapshotsDirectory, `${snapshot.route.name}-${koreanDate(new Date(snapshot.collectedAt))}.jsonl`);
  await appendFile(filePath, `${JSON.stringify(snapshot)}\n`);
}

async function collectOnce(routes: Route[], apiKey: string, hashSecret: string): Promise<void> {
  const snapshots = await Promise.all(routes.map((route) => fetchVehicleSnapshot(route, apiKey, hashSecret)));
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
  const hashSecret = process.env.VEHICLE_HASH_SECRET;
  if (!hashSecret) throw new Error('VEHICLE_HASH_SECRET이 없습니다. API 키와 분리된 임의의 긴 값을 입력하세요.');

  const routeNames = (process.env.ROUTE_NAMES ?? '3330,1650').split(',').map((routeName) => routeName.trim()).filter(Boolean);
  const routes = await resolveRoutes(routeNames, apiKey, options.refreshRoutes);
  if (options.once) {
    await collectOnce(routes, apiKey, hashSecret);
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
      await collectOnce(routes, apiKey, hashSecret);
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
