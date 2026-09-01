// 응답의 남은 수명을 읽는다.
//
// 서버는 `Cache-Control`에 이 응답을 얼마나 오래 써도 되는지 적고, 중간 캐시는 `Age`에
// 그 응답이 캐시에서 보낸 시간을 적는다. 둘의 차이가 지금부터 남은 수명이다. 이 값이
// 있으면 화면이 다음 호출 시각을 스스로 정하지 않아도 된다 (pollSchedule.ts).
//
// max-age가 없으면 s-maxage를 본다. 이 저장소의 `/api/live`는 브라우저 캐시를 켜지 않고
// 공유 캐시 수명만 선언한다(`public, s-maxage=120, stale-while-revalidate=240`).
// 우리가 알고 싶은 것은 그 공유 캐시에 새 답이 언제 생기느냐이므로 s-maxage가 바로
// 그 값이다. 표준 우선순위대로 max-age가 있으면 그쪽이 이긴다.

const maxAgeDirective = /^max-age="?(\d+)"?$/i;
const sharedMaxAgeDirective = /^s-maxage="?(\d+)"?$/i;
const wholeSeconds = /^\d+$/;

export interface CacheLifetime {
  noStore: boolean;
  maxAgeSeconds: number | null;
  ageSeconds: number;
}

export function cacheLifetimeFrom(headers: Headers): CacheLifetime {
  const directives = (headers.get('cache-control') ?? '').split(',').map((directive) => directive.trim());
  const age = headers.get('age');

  return {
    noStore: directives.some((directive) => directive.toLowerCase() === 'no-store'),
    maxAgeSeconds: secondsIn(directives, maxAgeDirective) ?? secondsIn(directives, sharedMaxAgeDirective),
    // Age가 없거나 정수가 아니면 0으로 본다. 캐시를 안 거친 응답이 그렇다.
    ageSeconds: age !== null && wholeSeconds.test(age) ? Number(age) : 0,
  };
}

function secondsIn(directives: string[], pattern: RegExp): number | null {
  for (const directive of directives) {
    const seconds = pattern.exec(directive)?.[1];
    if (seconds !== undefined) return Number(seconds);
  }
  return null;
}

/** 지금부터 남은 신선 시간(초). 저장하지 말라거나 수명을 안 밝힌 응답은 null이다. */
export function remainingFreshSecondsFrom(headers: Headers): number | null {
  const { noStore, maxAgeSeconds, ageSeconds } = cacheLifetimeFrom(headers);
  if (noStore || maxAgeSeconds === null) return null;
  return Math.max(0, maxAgeSeconds - ageSeconds);
}
