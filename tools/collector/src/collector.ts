import { createHmac } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { asList, isNonBoardingStop, isRecord, readIdentifier, readNumber, readGbisResultError, readRouteCache, readUpstreamErrorEnvelope, type Route, type RouteCache, type RouteStop, type Snapshot, type VehicleSnapshot } from '../../../packages/domain/src/model.js';
import { classifyFailure, describeFailure, toSingleCause, transientExitCode, UpstreamFailure } from './failure-kind.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDirectory, '..', '..', '..', '..');
const collectorDirectory = path.join(projectRoot, 'tools', 'collector');
const dataDirectory = process.env.BUS_DATA_DIR ? path.resolve(process.env.BUS_DATA_DIR) : path.join(projectRoot, 'data');
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

Set GYEONGGI_BUS_API_KEY in tools/collector/.env before collecting.`);
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

// 성공 사이클은 두 노선을 합쳐 0.9~1.6초 만에 끝난다. 예전의 15초는 연결이 막힌 러너에서
// undici의 기본 연결 타임아웃(10초)에 밀려 발화조차 못 하던 죽은 예산이었다. 관측된 최대치의
// 네 배로 줄여, 막힌 경로에서 버리는 시간을 10.5초에서 6초로 낮춘다.
const requestTimeoutMs = Number(process.env.GBIS_REQUEST_TIMEOUT_MS ?? 6_000);

/** 오류 본문에 키가 섞여 나올 경우를 대비해 지운다. 로그는 공개 저장소의 실행 기록에 남는다. */
function redactKey(text: string, apiKey: string): string {
  return apiKey ? text.split(apiKey).join('***') : text;
}

async function requestApi(apiPath: string, parameters: Record<string, string>, apiKey: string): Promise<unknown> {
  const requestUrl = new URL(apiBaseUrl + apiPath);
  requestUrl.search = new URLSearchParams({ serviceKey: apiKey, format: 'json', ...parameters }).toString();

  let response: Response;
  try {
    response = await fetch(requestUrl, { signal: AbortSignal.timeout(requestTimeoutMs) });
  } catch (error: unknown) {
    // undici는 연결 단계 실패를 전부 `TypeError: fetch failed`로 감싸고 진짜 원인을 cause에 넣는다.
    // cause를 달아 올려야 분류가 UND_ERR_CONNECT_TIMEOUT 같은 코드를 볼 수 있다.
    throw new UpstreamFailure(`상류에 연결하지 못했습니다 (${apiPath})`, { cause: error });
  }

  const responseText = redactKey(await response.text(), apiKey);

  let payload: unknown = null;
  let parsed = true;
  try {
    payload = JSON.parse(responseText) as unknown;
  } catch {
    parsed = false;
  }

  // 상류는 키나 한도 문제를 4xx로도, HTTP 200 본문으로도 알려온다. 어느 쪽이든 같은 오류 봉투를
  // 쓰므로 먼저 읽어 코드와 문구를 뽑는다. 200에 담겨 오는 쪽을 보지 않으면 항목 목록이 비어
  // "운행 차량 0대 저장"으로 성공 집계되고, 빈 스냅샷이 정상 관측으로 남는다.
  const envelope = parsed ? readUpstreamErrorEnvelope(payload) : null;
  if (envelope) {
    throw new UpstreamFailure(`상류가 오류를 반환했습니다 (${apiPath}): ${envelope.message}`, {
      httpStatus: response.status,
      upstreamCode: envelope.code,
    });
  }

  if (!response.ok) {
    throw new UpstreamFailure(`API request failed (${response.status}): ${responseText.slice(0, 180)}`, {
      httpStatus: response.status,
    });
  }

  if (!parsed) {
    // 상류가 XML을 돌려주는 경우도 있다. 이유가 본문에 있으니 코드로 뽑아 분류에 넘긴다.
    const marker = /<returnReasonCode>([^<]+)<\/returnReasonCode>/.exec(responseText)?.[1]
      ?? /<returnAuthMsg>([^<]+)<\/returnAuthMsg>/.exec(responseText)?.[1]
      ?? null;
    throw new UpstreamFailure(`API did not return JSON. Confirm the service key and API access: ${responseText.slice(0, 180)}`, {
      httpStatus: response.status,
      upstreamCode: marker,
    });
  }

  // GBIS 자체 결과 코드도 본다. 명세상 0이 정상이고 4가 결과 없음이며, 나머지는 오류다.
  // 통과시키면 항목 목록이 비어 "운행 차량 0대 저장"이 정상 관측으로 남는다.
  const resultError = readGbisResultError(payload);
  if (resultError) {
    throw new UpstreamFailure(`상류가 결과 코드 ${resultError.code}을 반환했습니다 (${apiPath}): ${resultError.message}`, {
      httpStatus: response.status,
      upstreamCode: resultError.code,
      codeSpace: 'gbis',
    });
  }

  return payload;
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

// 노선 정보를 갱신하지 못하는 것과 좌석을 관측하지 못하는 것은 다른 사건이다.
// busrouteservice가 한도 소진이나 장애로 막혀도, 노선 ID와 정류장 순서는 거의 변하지 않으므로
// 만료된 캐시로 좌석 수집을 계속하는 편이 그날 표본을 통째로 버리는 것보다 낫다.
// 승차 불가 지점은 이름 끝 표기로만 구분되고, 그 표기가 실제로 바뀐 적이 있다
// (2026-07 중 `(경유)` → `(미정차)`). 판정자가 못 알아보면 화면이 못 타는 지점에
// 판정을 띄우고 분석 도구의 출발 좌석 판정이 조용히 죽는다. 에러가 나지 않아
// 알아채기 어려우므로, 있던 것이 사라지는 순간을 잡는다.
function warnIfNonBoardingMarkersVanished(routeName: string, previous: RouteCache | undefined, stops: RouteStop[]): void {
  const before = previous?.stops.filter((stop) => isNonBoardingStop(stop.name)).length ?? 0;
  const after = stops.filter((stop) => isNonBoardingStop(stop.name)).length;
  if (before > 0 && after === 0) {
    console.warn(
      `${routeName}번의 승차 불가 지점이 ${before}곳에서 0곳이 됐습니다. ` +
      `표기가 바뀌었을 수 있습니다 — packages/domain/src/model.ts의 nonBoardingMarkers를 확인하세요.`,
    );
    return;
  }
  if (after === 0) {
    console.warn(`${routeName}번에서 승차 불가 지점을 찾지 못했습니다. 표기를 확인하세요.`);
  }
}

async function resolveRoutes(routeNames: string[], apiKey: string, refreshRoutes: boolean): Promise<Route[]> {
  // --refresh-routes는 캐시를 건너뛰라는 뜻이지 버리라는 뜻이 아니다. 갱신에 실패하면
  // 가진 캐시로 돌아갈 수 있어야 강제 갱신이 수집을 멈추는 발판이 되지 않는다.
  const cachedRoutes = await loadCachedRoutes();
  const atMs = Date.now();
  const reused: string[] = [];
  const failures: unknown[] = [];

  const resolved = await Promise.all(routeNames.map(async (routeName): Promise<Route | null> => {
    const cache = cachedRoutes.get(routeName);
    if (!refreshRoutes && cache && isCacheFresh(cache, atMs)) {
      reused.push(routeName);
      return cache.route;
    }

    try {
      const route = await findRoute(routeName, apiKey);
      const stops = await fetchRouteStops(route, apiKey);
      warnIfNonBoardingMarkersVanished(routeName, cache, stops);
      await cacheRouteStops(route, stops);
      return route;
    } catch (error: unknown) {
      if (cache) {
        console.warn(`${routeName}번 노선 정보를 갱신하지 못해 ${cache.cachedAt} 캐시로 수집합니다: ${describeFailure(error)}`);
        return cache.route;
      }
      failures.push(error);
      console.error(`${routeName}번 노선 정보가 없어 이번 수집에서 제외합니다: ${describeFailure(error)}`);
      return null;
    }
  }));

  const routes = resolved.filter((route): route is Route => route !== null);
  // 원인을 달아 올린다. 여기서 끊으면 저절로 낫는 연결 실패가 조치가 필요한 실패로 분류돼
  // 사람을 부른다. 실제로 첫 구현이 그랬다.
  if (routes.length === 0) {
    throw new Error(`수집할 노선을 하나도 확인하지 못했습니다: ${routeNames.join(', ')}번`, {
      cause: toSingleCause(failures, `노선 ${failures.length}개 확인 실패`),
    });
  }
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
  // 한 노선의 실패가 다른 노선의 성공분까지 버리면 호출만 소비된다. 성공분은 저장하고
  // 전부 실패했을 때만 사이클 실패로 던진다 — 부분 실패의 공백은 검증 워크플로의
  // 노선별 수집 공백 경고가 잡는다.
  const results = await Promise.allSettled(routes.map((route) => fetchVehicleSnapshot(route, apiKey, hashSecret)));
  const snapshots = results
    .filter((result): result is PromiseFulfilledResult<Snapshot> => result.status === 'fulfilled')
    .map((result) => result.value);
  await Promise.all(snapshots.map(appendSnapshot));

  const vehicleCount = snapshots.reduce((count, snapshot) => count + snapshot.vehicles.length, 0);
  console.log(`${new Date().toLocaleTimeString('ko-KR')} · ${snapshots.length}개 노선, 운행 차량 ${vehicleCount}대 저장`);

  // 실패는 성공분을 저장한 뒤에 던진다. 삼키면 워크플로의 단발 재시도와 3연속 실패
  // 알림이 부분 실패를 영영 못 보고, 던지기 전에 저장하지 않으면 성공한 호출이 버려진다.
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failures.length > 0) {
    // 실패를 전부 매단다. 첫 실패만 올리면 노선 순서 하나로 성격이 갈린다. 3330이 연결
    // 타임아웃, 1650이 키 폐기로 갈린 사이클에서 앞의 것만 보면 저절로 낫는 실패가 되고,
    // 키가 죽은 사실이 종료 코드에서 사라진다.
    const cause = toSingleCause(failures.map((failure) => failure.reason), `노선 ${failures.length}개 수집 실패`);
    throw new Error(
      `노선 ${failures.length}/${routes.length}개 수집 실패 (성공분 ${snapshots.length}개는 저장): ${describeFailure(cause)}`,
      { cause },
    );
  }
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
      console.error(`수집 실패: ${describeFailure(error)}`);
    }
    if (Date.now() + intervalSeconds * 1_000 >= endsAt) break;
    await new Promise<void>((resolve) => setTimeout(resolve, intervalSeconds * 1_000));
  } while (Date.now() < endsAt);
}

// 종료 코드로 실패의 성격을 알린다. 워크플로는 이 값으로 경고와 실패를 가른다.
// 저절로 낫는 실패까지 사람을 부르면 정작 키가 죽은 날의 알림이 묻힌다.
main().catch((error: unknown) => {
  const kind = classifyFailure(error);
  console.error(`수집기를 시작하지 못했습니다 [${kind}]: ${describeFailure(error)}`);
  process.exitCode = kind === 'transient' ? transientExitCode : 1;
});
