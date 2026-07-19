import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRouteCache, readSnapshot, type DailyBuckets, type Direction, type LatestPayload, type LatestRoute, type RouteCache, type Snapshot, type VehicleSnapshot } from '../shared/model.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDirectory, '..', '..');
const defaultDataDirectory = path.join(projectRoot, 'bus-seat-collector', 'data');
const outputDirectory = path.join(projectRoot, 'prototype-bus', 'data');

interface BuildOptions {
  watch: boolean;
  help: boolean;
  dataDirectory: string | null;
  date: string | null;
}

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
  const options: BuildOptions = { watch: false, help: false, dataDirectory: null, date: null };
  for (const argument of argumentsList) {
    const [name, value] = argument.split('=', 2);
    if (name === '--watch') options.watch = true;
    if (name === '--help') options.help = true;
    if (name === '--data-dir' && value) options.dataDirectory = path.resolve(value);
    if (name === '--date' && value) options.date = value;
  }
  return options;
}

function printHelp(): void {
  console.log(`Usage:
  npm run build:data
  npm run build:data -- --data-dir=../private-data --watch
  npm run build:data -- --date=2026-07-16

수집기 JSONL을 읽어 prototype-bus/data/latest.js와 daily.js를 생성합니다.`);
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
    if (isMissingFile(error)) throw new Error(`정류장 캐시가 없습니다: ${routesDirectory} — collector.ts를 먼저 실행하세요.`);
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
    stops: cache.stops.map((stop) => ({
      sequence: stop.sequence,
      name: stop.name,
      direction: directionOf(stop.sequence, turnSequence),
      isTurn: stop.isTurnStop || stop.sequence === turnSequence,
    })),
    vehicles: (snapshot?.vehicles ?? []).map((vehicle: VehicleSnapshot) => ({
      id: vehicle.id,
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

async function writeGlobalScript(fileName: string, globalName: '__LATEST__' | '__DAILY__', payload: unknown): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(path.join(outputDirectory, fileName), `window.${globalName} = ${JSON.stringify(payload)};\n`);
}

async function buildOnce(dataDirectory: string, targetDate: string): Promise<void> {
  const caches = await loadRouteCaches(dataDirectory);
  const latestRoutes: LatestRoute[] = [];
  const dailyDays: Record<string, { [date: string]: { bySeqHour: DailyBuckets } }> = {};

  for (const cache of caches) {
    const snapshotFiles = await listSnapshotFiles(dataDirectory, cache.route.name);
    latestRoutes.push(buildLatestRoute(cache, await findLatestSnapshot(snapshotFiles)));
    dailyDays[cache.route.name] = { [targetDate]: { bySeqHour: await buildDailyRoute(snapshotFiles, targetDate) } };
  }

  const latest: LatestPayload = { generatedAt: new Date().toISOString(), routes: latestRoutes };
  await writeGlobalScript('latest.js', '__LATEST__', latest);
  await writeGlobalScript('daily.js', '__DAILY__', { generatedAt: latest.generatedAt, days: dailyDays });
  console.log(`${new Date().toLocaleTimeString('ko-KR')} · 집계 완료 (${latestRoutes.map((entry) => `${entry.route.name} ${entry.vehicles.length}대`).join(', ')})`);
}

async function main(): Promise<void> {
  const options = readArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const dataDirectory = options.dataDirectory ?? defaultDataDirectory;
  const targetDate = options.date ?? toSeoulParts(new Date().toISOString()).date;
  await buildOnce(dataDirectory, targetDate);
  if (!options.watch) return;
  setInterval(() => {
    void buildOnce(dataDirectory, options.date ?? toSeoulParts(new Date().toISOString()).date).catch((error: unknown) => {
      console.error(`집계 실패: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, 60_000);
}

main().catch((error: unknown) => {
  console.error(`집계기를 시작하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
