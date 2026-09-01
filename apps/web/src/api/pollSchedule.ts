// 다음 조회를 언제 할지 응답이 정한다.
//
// 예전에는 화면이 30초 상수를 들고 있었는데 서버는 같은 응답을 120초 동안 재사용하게
// 하고 있었다. 네 번 중 세 번은 안 바뀔 값을 다시 받았고, 캐시 시간을 바꿀 때마다 브라우저
// 상수를 같이 고쳐야 했다. 남은 수명은 응답이 이미 알고 있으니 그 값을 쓴다.

import type { ApiFailure, ApiResult } from './client.js';

// 오류 응답은 no-store라 서버가 다음 시각을 알려주지 않는다. 그때만 이 값을 쓴다.
const fallbackDelayMs = 60_000;
// 서버가 max-age 0을 주더라도 연속 호출로 흐르지 않게 막는다.
const minDelayMs = 5_000;

export type PollDecision = { kind: 'again'; delayMs: number } | { kind: 'stop' };

export function nextPollFrom(result: ApiResult<unknown>): PollDecision {
  if (!result.ok) return afterFailure(result.failure);

  const { noStore, maxAgeSeconds, ageSeconds } = result.lifetime;
  if (noStore || maxAgeSeconds === null) return again(fallbackDelayMs);

  return again(Math.max(0, maxAgeSeconds - ageSeconds) * 1000);
}

function afterFailure(failure: ApiFailure): PollDecision {
  switch (failure.kind) {
    // 새 요청이 이미 자리를 물려받았다. 여기서 또 걸면 두 개가 돈다.
    case 'aborted':
      return { kind: 'stop' };
    // 4xx는 다시 불러도 같은 답이 온다. 없는 노선이거나 잘못된 주소다.
    case 'contract':
      return failure.status >= 500 ? again(failure.retryAfterMs ?? fallbackDelayMs) : { kind: 'stop' };
    case 'rateLimited':
      return again(failure.retryAfterMs ?? fallbackDelayMs);
    case 'timeout':
    case 'network':
    case 'malformed':
      return again(fallbackDelayMs);
  }
}

function again(delayMs: number): PollDecision {
  return { kind: 'again', delayMs: Math.max(minDelayMs, delayMs) };
}
