// 응답의 남은 수명을 읽는다.
//
// 서버는 `Cache-Control`에 이 응답을 얼마나 오래 써도 되는지 적고, 중간 캐시는 `Age`에
// 그 응답이 캐시에서 보낸 시간을 적는다. 둘의 차이가 지금부터 남은 수명이다. 이 값이
// 있으면 화면이 다음 호출 시각을 스스로 정하지 않아도 된다 (pollSchedule.ts).
//
// s-maxage는 보지 않는다. 그것은 공유 캐시 몫이고, 애초에 브라우저까지 오지도 않는다.
// Vercel 프록시가 그 지시를 자기가 먹고 클라이언트 응답에서 지운다. 서버는 브라우저 몫을
// `Cache-Control`에, CDN 몫을 `Vercel-CDN-Cache-Control`에 나눠 적는다
// (apps/api/src/handlers/live.ts).

const maxAgeDirective = /^max-age="?(\d+)"?$/i;
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
    maxAgeSeconds: maxAgeSecondsIn(directives),
    // Age가 없거나 정수가 아니면 0으로 본다. 캐시를 안 거친 응답이 그렇다.
    ageSeconds: age !== null && wholeSeconds.test(age) ? Number(age) : 0,
  };
}

function maxAgeSecondsIn(directives: string[]): number | null {
  for (const directive of directives) {
    const seconds = maxAgeDirective.exec(directive)?.[1];
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
