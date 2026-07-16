import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const dataDirectory = process.env.BUS_DATA_DIR
  ? path.resolve(process.env.BUS_DATA_DIR)
  : path.join(currentDirectory, 'data');
const apiBaseUrl = 'https://apis.data.go.kr/6410000';
const apiPaths = {
  routes: '/busrouteservice/v2/getBusRouteListv2',
  routeStops: '/busrouteservice/v2/getBusRouteStationListv2',
  vehicleLocations: '/buslocationservice/v2/getBusLocationListv2',
};

function readArguments(argumentsList) {
  return argumentsList.reduce((options, argument) => {
    const [name, value] = argument.split('=');

    if (name === '--once') {
      return { ...options, once: true };
    }

    if (name === '--help') {
      return { ...options, help: true };
    }

    if (name === '--duration-hours' && value) {
      return { ...options, durationHours: Number(value) };
    }

    if (name === '--interval-seconds' && value) {
      return { ...options, intervalSeconds: Number(value) };
    }

    return options;
  }, {});
}

function printHelp() {
  console.log(`Usage:
  node collector.mjs --once
  node collector.mjs --duration-hours=24 --interval-seconds=60

Set GYEONGGI_BUS_API_KEY in .env before collecting.`);
}

async function loadEnvironment() {
  const environmentPath = path.join(currentDirectory, '.env');
  let environmentText;

  try {
    environmentText = await readFile(environmentPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return;
    }
    throw error;
  }

  for (const line of environmentText.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmedLine.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const name = trimmedLine.slice(0, separatorIndex).trim();
    const value = trimmedLine.slice(separatorIndex + 1).trim();
    if (name && !process.env[name]) {
      process.env[name] = value;
    }
  }
}

function asList(value) {
  if (!value) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function firstListAt(object, paths) {
  for (const keys of paths) {
    let value = object;
    for (const key of keys) {
      value = value?.[key];
    }
    const list = asList(value);
    if (list.length > 0) {
      return list;
    }
  }
  return [];
}

function getResponseItems(payload, itemNames) {
  const body = payload?.response?.msgBody ?? payload?.msgBody ?? payload?.response?.body ?? payload?.body ?? payload;
  return firstListAt(body, itemNames.map((itemName) => [itemName]));
}

async function requestApi(apiPath, parameters, apiKey) {
  const requestUrl = new URL(apiBaseUrl + apiPath);
  requestUrl.search = new URLSearchParams({
    serviceKey: apiKey,
    format: 'json',
    ...parameters,
  }).toString();

  const response = await fetch(requestUrl, { signal: AbortSignal.timeout(15_000) });
  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(`API request failed (${response.status}): ${responseText.slice(0, 180)}`);
  }

  try {
    return JSON.parse(responseText);
  } catch {
    throw new Error(`API did not return JSON. Confirm the service key and API access: ${responseText.slice(0, 180)}`);
  }
}

async function findRoute(routeName, apiKey) {
  const payload = await requestApi(apiPaths.routes, { keyword: routeName }, apiKey);
  const routes = getResponseItems(payload, ['busRouteList', 'busRoute']);
  const route = routes.find((candidate) => String(candidate.routeName) === routeName);

  if (!route?.routeId) {
    throw new Error(`${routeName}번의 정확한 노선 ID를 찾지 못했습니다.`);
  }

  return {
    id: String(route.routeId),
    name: String(route.routeName),
    type: route.routeTypeName ?? null,
    startStationName: route.startStationName ?? null,
    endStationName: route.endStationName ?? null,
  };
}

async function fetchRouteStops(route, apiKey) {
  const payload = await requestApi(apiPaths.routeStops, { routeId: route.id }, apiKey);
  const stops = getResponseItems(payload, ['busRouteStationList', 'busRouteStation']);

  if (stops.length === 0) {
    throw new Error(`${route.name}번의 정류장 목록이 비어 있습니다.`);
  }

  return stops.map((stop) => ({
    id: stop.stationId ? String(stop.stationId) : null,
    name: stop.stationName ?? null,
    sequence: Number(stop.stationSeq),
    directionSequence: stop.turnSeq ? Number(stop.turnSeq) : null,
    isTurnStop: stop.turnYn === 'Y',
    latitude: stop.y ? Number(stop.y) : null,
    longitude: stop.x ? Number(stop.x) : null,
  }));
}

async function fetchVehicleSnapshot(route, apiKey) {
  const payload = await requestApi(apiPaths.vehicleLocations, { routeId: route.id }, apiKey);
  const vehicles = getResponseItems(payload, ['busLocationList', 'busLocation']);

  return {
    collectedAt: new Date().toISOString(),
    route,
    apiQueryTime: payload?.response?.msgHeader?.queryTime ?? payload?.msgHeader?.queryTime ?? null,
    vehicles: vehicles.map((vehicle) => ({
      id: anonymizeVehicleId(vehicle, apiKey),
      currentStopId: vehicle.stationId ? String(vehicle.stationId) : null,
      currentStopSequence: vehicle.stationSeq ? Number(vehicle.stationSeq) : null,
      remainingSeats: vehicle.remainSeatCnt === undefined ? null : Number(vehicle.remainSeatCnt),
      crowded: vehicle.crowded === undefined ? null : Number(vehicle.crowded),
      status: vehicle.stateCd === undefined ? null : Number(vehicle.stateCd),
    })),
  };
}

function anonymizeVehicleId(vehicle, apiKey) {
  const vehicleId = vehicle.plateNo ?? vehicle.vehId;
  return vehicleId
    ? createHmac('sha256', apiKey).update(String(vehicleId)).digest('hex').slice(0, 16)
    : null;
}

async function cacheRouteStops(route, stops) {
  const routesDirectory = path.join(dataDirectory, 'routes');
  await mkdir(routesDirectory, { recursive: true });
  await writeFile(
    path.join(routesDirectory, `${route.id}-stops.json`),
    JSON.stringify({ cachedAt: new Date().toISOString(), route, stops }, null, 2) + '\n',
  );
}

async function appendSnapshot(snapshot) {
  const snapshotsDirectory = path.join(dataDirectory, 'snapshots');
  await mkdir(snapshotsDirectory, { recursive: true });
  const date = snapshot.collectedAt.slice(0, 10);
  const filePath = path.join(snapshotsDirectory, `${snapshot.route.name}-${date}.jsonl`);
  await appendFile(filePath, JSON.stringify(snapshot) + '\n');
  return filePath;
}

async function collectOnce(routes, apiKey) {
  const snapshots = await Promise.all(routes.map((route) => fetchVehicleSnapshot(route, apiKey)));
  const savedFiles = await Promise.all(snapshots.map(appendSnapshot));
  const vehicleCount = snapshots.reduce((count, snapshot) => count + snapshot.vehicles.length, 0);
  console.log(`${new Date().toLocaleTimeString('ko-KR')} · ${snapshots.length}개 노선, 운행 차량 ${vehicleCount}대 저장`);
  return savedFiles;
}

async function main() {
  const options = readArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  await loadEnvironment();
  const apiKey = process.env.GYEONGGI_BUS_API_KEY;
  if (!apiKey) {
    throw new Error('GYEONGGI_BUS_API_KEY가 없습니다. .env.example을 복사해 .env에 입력하세요.');
  }

  const routeNames = (process.env.ROUTE_NAMES ?? '3330,1650')
    .split(',')
    .map((routeName) => routeName.trim())
    .filter(Boolean);
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
    } catch (error) {
      console.error(`수집 실패: ${error.message}`);
    }

    if (Date.now() + intervalSeconds * 1_000 >= endsAt) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1_000));
  } while (Date.now() < endsAt);
}

main().catch((error) => {
  console.error(`수집기를 시작하지 못했습니다: ${error.message}`);
  process.exitCode = 1;
});
