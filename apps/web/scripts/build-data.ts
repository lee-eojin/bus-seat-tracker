import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { forecastVehicleStops } from '../../../packages/domain/src/forecast.js';
import { readRouteCache, readSnapshot, type DailyBuckets, type Direction, type HistoryRoute, type LatestPayload, type LatestRoute, type ProfileRoute, type RouteCache, type Snapshot, type VehicleSnapshot } from '../../../packages/domain/src/model.js';
import { buildDeconvolvedProfileRoute, buildHistoryRoute, observationsByVehicle, splitRuns } from '../../../packages/domain/src/profile.js';
import { fullDepartureStreaks } from '../../../packages/domain/src/boarding.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDirectory, '..', '..', '..', '..');
const defaultDataDirectory = path.join(projectRoot, 'data');
const outputDirectory = path.join(projectRoot, 'apps', 'web', 'public', 'data');

interface BuildOptions {
  watch: boolean;
  help: boolean;
  dataDirectory: string | null;
  date: string | null;
  predictionLog: string | null;
}

// 기록할 지평(정류장 수). 백테스트의 horizon 구간(1-2 / 3-5 / 6+)에 하나씩 대응시킨다.
const loggedHorizons = [1, 3, 6];
// 만석 연속 수를 세는 최근 창. 조밀 수집 구간(60초) 안에서만 의미 있는 값이 나온다.
const streakWindowMinutes = 90;

interface Observation {
  sequence: number;
  hour: number;
  remainingSeats: number | null;
}

interface MutableSeatBucket {
  samples: number;
  seatSum: number;
  seatSamples: number;
  minSeats: number | null;
  zeroCount: number;
  unknownCount: number;
}

function readArguments(argumentsList: string[]): BuildOptions {
  const options: BuildOptions = { watch: false, help: false, dataDirectory: null, date: null, predictionLog: null };
  for (const argument of argumentsList) {
    const [name, value] = argument.split('=', 2);
    if (name === '--watch') options.watch = true;
    if (name === '--help') options.help = true;
    if (name === '--data-dir' && value) options.dataDirectory = path.resolve(value);
    if (name === '--date' && value) options.date = value;
    if (name === '--predictions' && value) options.predictionLog = path.resolve(value);
  }
  return options;
}

function printHelp(): void {
  console.log(`Usage:
  npm run build:data
  npm run build:data -- --data-dir=../private-data --watch
  npm run build:data -- --date=2026-07-16
  npm run build:data -- --predictions=../bus-predictions/predictions/2026-07-26.jsonl

수집기 JSONL을 읽어 apps/web/public/data 아래에 화면용 데이터 파일을 생성합니다.
--predictions를 주면 발행 시점의 1, 3, 6정류장 좌석 예측을 JSONL로 덧붙입니다. 차량 가명 ID가 들어가므로
발행 대상 디렉터리 밖(비공개 저장소)을 가리켜야 합니다.`);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function toSeoulParts(isoText: string): { date: string; hour: number } {
  const formatted = new Date(isoText).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' });
  return { date: formatted.slice(0, 10), hour: Number(formatted.slice(11, 13)) };
}

async function loadRouteCaches(dataDirectory: string): Promise<RouteCache[]> {
  const routesDirectory = path.join(dataDirectory, 'routes');
  let fileNames: string[];
  try {
    fileNames = await readdir(routesDirectory);
  } catch (error: unknown) {
    if (isMissingFile(error)) throw new Error(`정류장 캐시가 없습니다: ${routesDirectory}. collector.ts를 먼저 실행하세요.`);
    throw error;
  }

  const caches = await Promise.all(fileNames.filter((fileName) => fileName.endsWith('-stops.json')).map(async (fileName) => {
    const cache = readRouteCache(JSON.parse(await readFile(path.join(routesDirectory, fileName), 'utf8')) as unknown);
    if (!cache) throw new Error(`정류장 캐시 형식이 올바르지 않습니다: ${fileName}`);
    return cache;
  }));
  if (caches.length === 0) throw new Error('정류장 캐시 파일이 비어 있습니다. collector.ts를 먼저 실행하세요.');
  return caches;
}

function findTurnSequence(stops: RouteCache['stops']): number | null {
  const turnStop = stops.find((stop) => stop.isTurnStop);
  if (turnStop) return turnStop.sequence;
  const values = [...new Set(stops.map((stop) => stop.directionSequence).filter((value): value is number => value !== null))];
  return values.length === 1 ? values[0] ?? null : null;
}

function directionOf(sequence: number | null, turnSequence: number | null): Direction | null {
  if (sequence === null || turnSequence === null) return null;
  return sequence <= turnSequence ? 'up' : 'down';
}

async function listSnapshotFiles(dataDirectory: string, routeName: string): Promise<string[]> {
  const snapshotsDirectory = path.join(dataDirectory, 'snapshots');
  try {
    return (await readdir(snapshotsDirectory))
      .filter((fileName) => fileName.startsWith(`${routeName}-`) && fileName.endsWith('.jsonl'))
      .sort()
      .map((fileName) => path.join(snapshotsDirectory, fileName));
  } catch (error: unknown) {
    if (isMissingFile(error)) return [];
    throw error;
  }
}

function parseSnapshots(fileText: string): Snapshot[] {
  return fileText.split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const snapshot = readSnapshot(JSON.parse(line) as unknown);
      return snapshot ? [snapshot] : [];
    } catch {
      return [];
    }
  });
}

async function findLatestSnapshot(snapshotFiles: string[]): Promise<Snapshot | null> {
  for (const filePath of snapshotFiles.slice(-2).reverse()) {
    const snapshots = parseSnapshots(await readFile(filePath, 'utf8'));
    const latest = snapshots.at(-1);
    if (latest) return latest;
  }
  return null;
}

function buildLatestRoute(cache: RouteCache, snapshot: Snapshot | null): LatestRoute {
  const turnSequence = findTurnSequence(cache.stops);
  return {
    route: cache.route,
    collectedAt: snapshot?.collectedAt ?? null,
    turnSequence,
    fullDepartureStreaks: {},
    stops: cache.stops.map((stop) => ({
      sequence: stop.sequence,
      name: stop.name,
      direction: directionOf(stop.sequence, turnSequence),
      isTurn: stop.isTurnStop || stop.sequence === turnSequence,
      latitude: stop.latitude,
      longitude: stop.longitude,
    })),
    // 가명 차량 ID도 공개 산출물에는 싣지 않는다 (라이브 경로 readLiveVehicles와 같은 기준).
    vehicles: (snapshot?.vehicles ?? []).map((vehicle: VehicleSnapshot) => ({
      id: null,
      stationSeq: vehicle.currentStopSequence,
      remainingSeats: vehicle.remainingSeats,
      crowded: vehicle.crowded,
      status: vehicle.status,
      direction: directionOf(vehicle.currentStopSequence, turnSequence),
    })),
  };
}

function addObservation(buckets: Map<string, Map<string, MutableSeatBucket>>, observation: Observation): void {
  const sequenceKey = String(observation.sequence);
  const hourKey = String(observation.hour);
  const hours = buckets.get(sequenceKey) ?? new Map<string, MutableSeatBucket>();
  const bucket = hours.get(hourKey) ?? { samples: 0, seatSum: 0, seatSamples: 0, minSeats: null, zeroCount: 0, unknownCount: 0 };
  bucket.samples += 1;
  if (observation.remainingSeats !== null && observation.remainingSeats >= 0) {
    bucket.seatSum += observation.remainingSeats;
    bucket.seatSamples += 1;
    bucket.minSeats = bucket.minSeats === null ? observation.remainingSeats : Math.min(bucket.minSeats, observation.remainingSeats);
    if (observation.remainingSeats === 0) bucket.zeroCount += 1;
  } else {
    bucket.unknownCount += 1;
  }
  hours.set(hourKey, bucket);
  buckets.set(sequenceKey, hours);
}

async function buildDailyRoute(snapshotFiles: string[], targetDate: string): Promise<DailyBuckets> {
  const latestObservations = new Map<string, Observation>();
  for (const filePath of snapshotFiles) {
    for (const snapshot of parseSnapshots(await readFile(filePath, 'utf8'))) {
      const { date, hour } = toSeoulParts(snapshot.collectedAt);
      if (date !== targetDate) continue;
      for (const vehicle of snapshot.vehicles) {
        if (vehicle.currentStopSequence === null) continue;
        latestObservations.set(`${vehicle.id}|${vehicle.currentStopSequence}|${hour}`, {
          sequence: vehicle.currentStopSequence,
          hour,
          remainingSeats: vehicle.remainingSeats,
        });
      }
    }
  }

  const buckets = new Map<string, Map<string, MutableSeatBucket>>();
  for (const observation of latestObservations.values()) addObservation(buckets, observation);

  const daily: DailyBuckets = {};
  for (const [sequence, hours] of buckets) {
    daily[sequence] = {};
    for (const [hour, bucket] of hours) {
      daily[sequence][hour] = {
        samples: bucket.samples,
        minSeats: bucket.minSeats,
        zeroCount: bucket.zeroCount,
        unknownCount: bucket.unknownCount,
        avgSeats: bucket.seatSamples > 0 ? Math.round((bucket.seatSum / bucket.seatSamples) * 10) / 10 : null,
      };
    }
  }
  return daily;
}

async function loadSnapshots(snapshotFiles: string[]): Promise<Snapshot[]> {
  const snapshots: Snapshot[] = [];
  for (const filePath of snapshotFiles) {
    for (const snapshot of parseSnapshots(await readFile(filePath, 'utf8'))) snapshots.push(snapshot);
  }
  return snapshots;
}

async function writeGlobalScript(fileName: string, globalName: '__LATEST__' | '__DAILY__' | '__HISTORY__' | '__PROFILE__', payload: unknown): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(path.join(outputDirectory, fileName), `window.${globalName} = ${JSON.stringify(payload)};\n`);
}

interface PredictionRow {
  at: string;
  route: string;
  vehicle: string;
  from: number;
  fromSeats: number;
  target: number;
  horizon: number;
  seats: number;
  boardable: number;
  lowConfidence: boolean;
}

// 발행 시점의 좌석 예측을 남긴다. 다음 날 실제 관측과 대조하면 재현 채점(백테스트)이
// 잡지 못하는 파이프라인 문제(낡은 프로파일, 멈춘 발행)가 드러난다.
// 차량 가명 ID가 들어가므로 이 파일은 비공개 저장소에만 쓴다 (docs/architecture.md 데이터 경계).
function forecastRows(cache: RouteCache, snapshot: Snapshot | null, profile: ProfileRoute, generatedAt: string): PredictionRow[] {
  if (!snapshot) return [];
  const baseMs = Date.parse(generatedAt);
  const turnSequence = findTurnSequence(cache.stops);
  const orderedStops = [...cache.stops].sort((left, right) => left.sequence - right.sequence);
  const deepest = Math.max(...loggedHorizons);
  const rows: PredictionRow[] = [];

  for (const vehicle of snapshot.vehicles) {
    if (vehicle.id === null || vehicle.currentStopSequence === null) continue;
    if (vehicle.remainingSeats === null || vehicle.remainingSeats < 0) continue;
    // 화면은 같은 방향 정류장만 늘어놓으므로 회차점 너머는 세지 않는다.
    const heading = directionOf(vehicle.currentStopSequence, turnSequence);

    const stops = [];
    for (const stop of orderedStops) {
      if (stop.sequence <= vehicle.currentStopSequence) continue;
      if (directionOf(stop.sequence, turnSequence) !== heading) break;
      stops.push({ sequence: stop.sequence, name: stop.name });
      if (stops.length >= deepest) break;
    }

    const forecasts = forecastVehicleStops({
      routeName: cache.route.name,
      currentSequence: vehicle.currentStopSequence,
      remainingSeats: vehicle.remainingSeats,
      stops,
      profile,
      fullDepartureStreaks: {},
      forecastAt: baseMs,
    });
    for (const forecast of forecasts) {
      if (!loggedHorizons.includes(forecast.horizon)) continue;
      rows.push({
        at: generatedAt,
        route: cache.route.name,
        vehicle: vehicle.id,
        from: vehicle.currentStopSequence,
        fromSeats: vehicle.remainingSeats,
        target: forecast.sequence,
        horizon: forecast.horizon,
        seats: Number(forecast.arrivalMean.toFixed(2)),
        boardable: Number(forecast.seatAvailableProbability.toFixed(4)),
        lowConfidence: forecast.lowConfidence,
      });
    }
  }
  return rows;
}

async function buildOnce(dataDirectory: string, targetDate: string, predictionLog: string | null): Promise<void> {
  const caches = await loadRouteCaches(dataDirectory);
  const latestRoutes: LatestRoute[] = [];
  const dailyDays: Record<string, { [date: string]: { bySeqHour: DailyBuckets } }> = {};
  const historyRoutes: Record<string, HistoryRoute> = {};
  const profileRoutes: Record<string, ProfileRoute> = {};
  const generatedAt = new Date().toISOString();
  const predictions: PredictionRow[] = [];

  for (const cache of caches) {
    const snapshotFiles = await listSnapshotFiles(dataDirectory, cache.route.name);
    const latestSnapshot = await findLatestSnapshot(snapshotFiles);
    dailyDays[cache.route.name] = { [targetDate]: { bySeqHour: await buildDailyRoute(snapshotFiles, targetDate) } };
    const snapshots = await loadSnapshots(snapshotFiles);

    // 만석 연속 수는 최근 창의 조밀 관측에서만 나온다. 관측이 없는 정류장은 항목이 비고,
    // 화면은 그것을 "연속 0"이 아니라 "모름"으로 다뤄야 한다 (packages/domain/src/boarding.ts).
    const runs = [...observationsByVehicle(snapshots).values()].flatMap((observations) => splitRuns(observations));
    latestRoutes.push({
      ...buildLatestRoute(cache, latestSnapshot),
      fullDepartureStreaks: fullDepartureStreaks(runs, Date.parse(generatedAt) - streakWindowMinutes * 60_000, Date.parse(generatedAt)),
    });
    historyRoutes[cache.route.name] = buildHistoryRoute(snapshots);
    // 구간합 역산 + 도착 귀속. 균등 배분(1/n)이 정류장 스파이크를 뭉개고 핫스팟을 한 칸
    // 하류로 밀던 문제를 제거한 조합이다 (검증 보고서 §5~§7, §9-1).
    const profile = buildDeconvolvedProfileRoute(snapshots, undefined, 'arrival');
    profileRoutes[cache.route.name] = profile;
    if (predictionLog) predictions.push(...forecastRows(cache, latestSnapshot, profile, generatedAt));
  }

  if (predictionLog && predictions.length > 0) {
    await mkdir(path.dirname(predictionLog), { recursive: true });
    await appendFile(predictionLog, `${predictions.map((row) => JSON.stringify(row)).join('\n')}\n`);
    console.log(`예측 기록 ${predictions.length}건 → ${predictionLog}`);
  }

  const latest: LatestPayload = { generatedAt, routes: latestRoutes };
  await writeGlobalScript('latest.js', '__LATEST__', latest);
  await writeGlobalScript('daily.js', '__DAILY__', { generatedAt: latest.generatedAt, days: dailyDays });
  await writeGlobalScript('history.js', '__HISTORY__', { generatedAt: latest.generatedAt, routes: historyRoutes });
  await writeGlobalScript('profile.js', '__PROFILE__', { generatedAt: latest.generatedAt, routes: profileRoutes });
  console.log(`${new Date().toLocaleTimeString('ko-KR')} 집계 완료 (${latestRoutes.map((entry) => `${entry.route.name} ${entry.vehicles.length}대`).join(', ')})`);
}

async function main(): Promise<void> {
  const options = readArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const dataDirectory = options.dataDirectory ?? defaultDataDirectory;
  const targetDate = options.date ?? toSeoulParts(new Date().toISOString()).date;
  await buildOnce(dataDirectory, targetDate, options.predictionLog);
  if (!options.watch) return;
  setInterval(() => {
    void buildOnce(dataDirectory, options.date ?? toSeoulParts(new Date().toISOString()).date, options.predictionLog).catch((error: unknown) => {
      console.error(`집계 실패: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, 60_000);
}

main().catch((error: unknown) => {
  console.error(`집계기를 시작하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
