import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { readRouteCache, readSnapshot, type RouteCache, type Snapshot } from '../../../packages/domain/src/model.js';

// 수집 저장소(data/routes, data/snapshots)를 읽는 공통 입구.
// 분석 도구가 늘 때마다 같은 로더를 다시 쓰지 않도록 여기 한 곳에 둔다.

export function parseSnapshots(fileText: string): Snapshot[] {
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

export async function loadRouteCaches(dataDirectory: string): Promise<RouteCache[]> {
  const routesDirectory = path.join(dataDirectory, 'routes');
  const fileNames = await readdir(routesDirectory);
  const caches: RouteCache[] = [];
  for (const fileName of fileNames.filter((name) => name.endsWith('-stops.json'))) {
    const cache = readRouteCache(JSON.parse(await readFile(path.join(routesDirectory, fileName), 'utf8')) as unknown);
    if (cache) caches.push(cache);
  }
  return caches;
}

export async function loadSnapshots(dataDirectory: string, routeName: string): Promise<Snapshot[]> {
  const snapshotsDirectory = path.join(dataDirectory, 'snapshots');
  const fileNames = (await readdir(snapshotsDirectory))
    .filter((name) => name.startsWith(`${routeName}-`) && name.endsWith('.jsonl'))
    .sort();
  const snapshots: Snapshot[] = [];
  for (const fileName of fileNames) {
    for (const snapshot of parseSnapshots(await readFile(path.join(snapshotsDirectory, fileName), 'utf8'))) {
      snapshots.push(snapshot);
    }
  }
  return snapshots;
}
