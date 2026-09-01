// 서버 기준 시계.
//
// 기기 시계는 믿을 수 없다. 몇 분 어긋난 기기에서 신선도 판정이 통째로 뒤집힌다. 응답의
// `Date` 헤더에 `Age`를 더하면 이 응답이 실제로 만들어진 시각이 나오고, 그 뒤의 경과는
// 벽시계가 아니라 단조 증가하는 performance.now()로 잰다. 사용자가 시계를 바꿔도 여기서
// 나온 값은 안 흔들린다.

import { cacheLifetimeFrom } from './cacheControl.js';

export interface ReferenceClock {
  readonly servedAt: number;
  now(): number;
}

export function referenceClockFrom(
  headers: Headers,
  elapsedNow: () => number = () => performance.now(),
): ReferenceClock | null {
  const date = headers.get('date');
  if (date === null) return null;

  const originAt = Date.parse(date);
  if (Number.isNaN(originAt)) return null;

  const servedAt = originAt + cacheLifetimeFrom(headers).ageSeconds * 1000;
  const receivedAt = elapsedNow();

  return { servedAt, now: () => servedAt + (elapsedNow() - receivedAt) };
}
