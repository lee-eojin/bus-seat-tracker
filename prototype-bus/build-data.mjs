import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultDataDirectory = path.join(currentDirectory, '..', 'bus-seat-collector', 'data');
const outputDirectory = path.join(currentDirectory, 'data');

function readArguments(argumentsList) {
  return argumentsList.reduce((options, argument) => {
    const [name, value] = argument.split('=');

    if (name === '--watch') {
      return { ...options, watch: true };
    }

    if (name === '--help') {
      return { ...options, help: true };
    }

    if (name === '--data-dir' && value) {
      return { ...options, dataDirectory: path.resolve(value) };
    }

    if (name === '--date' && value) {
      return { ...options, date: value };
    }

    return options;
  }, {});
}

function printHelp() {
  console.log(`Usage:
  node build-data.mjs
  node build-data.mjs --data-dir=../bus-data/data --watch
  node build-data.mjs --date=2026-07-16

수집기 JSONL을 읽어 data/latest.js(현재 상황)와 data/daily.js(시간대 집계)를 생성합니다.`);
}

function toSeoulParts(isoText) {
  const formatted = new Date(isoText).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' });
  return { date: formatted.slice(0, 10), hour: Number(formatted.slice(11, 13)) };
}

async function loadRouteCaches(dataDirectory) {
  const routesDirectory = path.join(dataDirectory, 'routes');
  let fileNames;

  try {
    fileNames = await readdir(routesDirectory);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`정류장 캐시가 없습니다: ${routesDirectory} — collector.mjs를 먼저 실행하세요.`);
    }
    throw error;
  }

  const caches = await Promise.all(
    fileNames
      .filter((fileName) => fileName.endsWith('-stops.json'))
      .map(async (fileName) => JSON.parse(await readFile(path.join(routesDirectory, fileName), 'utf8'))),
  );

  if (caches.length === 0) {
    throw new Error('정류장 캐시 파일이 비어 있습니다. collector.mjs를 먼저 실행하세요.');
  }

  return caches;
}

function findTurnSequence(stops) {
  const turnStop = stops.find((stop) => stop.isTurnStop);
  if (turnStop) {
    return turnStop.sequence;
  }

  const directionValues = [...new Set(
    stops.map((stop) => stop.directionSequence).filter((value) => Number.isFinite(value)),
  )];
  return directionValues.length === 1 ? directionValues[0] : null;
}

function directionOf(sequence, turnSequence) {
  if (!Number.isFinite(turnSequence) || !Number.isFinite(sequence)) {
    return null;
  }
  return sequence <= turnSequence ? 'up' : 'down';
}

async function listSnapshotFiles(dataDirectory, routeName) {
  const snapshotsDirectory = path.join(dataDirectory, 'snapshots');
  let fileNames;

  try {
    fileNames = await readdir(snapshotsDirectory);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  return fileNames
    .filter((fileName) => fileName.startsWith(`${routeName}-`) && fileName.endsWith('.jsonl'))
    .sort()
    .map((fileName) => path.join(snapshotsDirectory, fileName));
}

function parseLines(fileText) {
  return fileText.split('\n').flatMap((line) => {
    if (!line.trim()) {
      return [];
    }
    try {
      const snapshot = JSON.parse(line);
      return Array.isArray(snapshot.vehicles) ? [snapshot] : [];
    } catch {
      return [];
    }
  });
}

async function findLatestSnapshot(snapshotFiles) {
  for (const filePath of [...snapshotFiles].reverse().slice(0, 2)) {
    const snapshots = parseLines(await readFile(filePath, 'utf8'));
    if (snapshots.length > 0) {
      return snapshots.at(-1);
    }
  }
  return null;
}

function buildLatestRoute(cache, snapshot) {
  const turnSequence = findTurnSequence(cache.stops);

  return {
    route: cache.route,
    collectedAt: snapshot?.collectedAt ?? null,
    turnSequence,
    stops: cache.stops.map((stop) => ({
      sequence: stop.sequence,
      name: stop.name,
      direction: directionOf(stop.sequence, turnSequence),
      isTurn: Boolean(stop.isTurnStop) || stop.sequence === turnSequence,
    })),
    vehicles: (snapshot?.vehicles ?? []).map((vehicle) => ({
      id: vehicle.id,
      stationSeq: vehicle.currentStopSequence,
      remainingSeats: vehicle.remainingSeats,
      crowded: vehicle.crowded ?? null,
      status: vehicle.status ?? null,
      direction: directionOf(vehicle.currentStopSequence, turnSequence),
    })),
  };
}

async function buildDailyRoute(snapshotFiles, targetDate) {
  const lastObservations = new Map();

  for (const filePath of snapshotFiles) {
    for (const snapshot of parseLines(await readFile(filePath, 'utf8'))) {
      const { date, hour } = toSeoulParts(snapshot.collectedAt);
      if (date !== targetDate) {
        continue;
      }
      for (const vehicle of snapshot.vehicles) {
        if (!Number.isFinite(vehicle.currentStopSequence)) {
          continue;
        }
        lastObservations.set(`${vehicle.id}|${vehicle.currentStopSequence}|${hour}`, {
          sequence: vehicle.currentStopSequence,
          hour,
          remainingSeats: vehicle.remainingSeats,
        });
      }
    }
  }

  const bySeqHour = {};
  for (const observation of lastObservations.values()) {
    const sequenceKey = String(observation.sequence);
    const hourKey = String(observation.hour);
    bySeqHour[sequenceKey] ??= {};
    const bucket = (bySeqHour[sequenceKey][hourKey] ??= {
      samples: 0, seatSum: 0, seatSamples: 0, minSeats: null, zeroCount: 0, unknownCount: 0,
    });

    bucket.samples += 1;
    const seats = observation.remainingSeats;
    if (Number.isFinite(seats) && seats >= 0) {
      bucket.seatSum += seats;
      bucket.seatSamples += 1;
      bucket.minSeats = bucket.minSeats === null ? seats : Math.min(bucket.minSeats, seats);
      if (seats === 0) {
        bucket.zeroCount += 1;
      }
    } else {
      bucket.unknownCount += 1;
    }
  }

  for (const hours of Object.values(bySeqHour)) {
    for (const bucket of Object.values(hours)) {
      bucket.avgSeats = bucket.seatSamples > 0 ? Math.round((bucket.seatSum / bucket.seatSamples) * 10) / 10 : null;
      delete bucket.seatSum;
      delete bucket.seatSamples;
    }
  }

  return bySeqHour;
}

async function writeGlobalScript(fileName, globalName, payload) {
  await mkdir(outputDirectory, { recursive: true });
  const filePath = path.join(outputDirectory, fileName);
  await writeFile(filePath, `window.${globalName} = ${JSON.stringify(payload)};\n`);
  return filePath;
}

async function buildOnce(dataDirectory, targetDate) {
  const caches = await loadRouteCaches(dataDirectory);
  const generatedAt = new Date().toISOString();

  const latestRoutes = [];
  const dailyDays = {};
  for (const cache of caches) {
    const snapshotFiles = await listSnapshotFiles(dataDirectory, cache.route.name);
    latestRoutes.push(buildLatestRoute(cache, await findLatestSnapshot(snapshotFiles)));
    dailyDays[cache.route.name] = { [targetDate]: { bySeqHour: await buildDailyRoute(snapshotFiles, targetDate) } };
  }

  await writeGlobalScript('latest.js', '__LATEST__', { generatedAt, routes: latestRoutes });
  await writeGlobalScript('daily.js', '__DAILY__', { generatedAt, days: dailyDays });

  const summary = latestRoutes
    .map((entry) => `${entry.route.name} ${entry.vehicles.length}대`)
    .join(', ');
  console.log(`${new Date().toLocaleTimeString('ko-KR')} · 집계 완료 (${summary}) → data/latest.js, data/daily.js`);
}

async function main() {
  const options = readArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const dataDirectory = options.dataDirectory ?? defaultDataDirectory;
  const targetDate = options.date ?? toSeoulParts(new Date().toISOString()).date;

  await buildOnce(dataDirectory, targetDate);

  if (!options.watch) {
    return;
  }

  setInterval(async () => {
    try {
      await buildOnce(dataDirectory, options.date ?? toSeoulParts(new Date().toISOString()).date);
    } catch (error) {
      console.error(`집계 실패: ${error.message}`);
    }
  }, 60_000);
}

main().catch((error) => {
  console.error(`집계를 시작하지 못했습니다: ${error.message}`);
  process.exitCode = 1;
});
