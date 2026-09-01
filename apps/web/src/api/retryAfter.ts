// `Retry-After` 헤더를 밀리초로 바꾼다.
//
// 이 헤더는 두 형식을 갖는다. 초 단위 정수이거나 HTTP 날짜다. 초 단위는 기간이라 시계와
// 무관하지만 날짜 형식은 어느 시계로 재느냐에 따라 답이 달라진다. 기기 시계를 쓰면 몇 분
// 어긋난 기기가 재시도를 영영 미루거나 곧바로 다시 부른다. 그래서 기준 시각을 밖에서
// 받고, 그 값이 없으면 날짜 형식을 해석하지 않는다 (referenceClock.ts).

const wholeSeconds = /^\d+$/;

export function retryAfterMillisFrom(headers: Headers, now: number | null): number | null {
  const retryAfter = headers.get('retry-after');
  if (retryAfter === null) return null;

  if (wholeSeconds.test(retryAfter)) return Number(retryAfter) * 1000;

  if (now === null) return null;

  const retryAt = Date.parse(retryAfter);
  if (Number.isNaN(retryAt)) return null;

  return Math.max(0, retryAt - now);
}
