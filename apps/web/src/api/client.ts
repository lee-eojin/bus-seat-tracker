// JSON 조회 한 번의 결과를 판별 유니온으로 돌려준다.
//
// 예전에는 실패가 전부 하나의 catch로 들어와 console.warn 한 줄로 끝났다. 타임아웃과
// 네트워크 끊김과 서버 거부와 형식 깨짐이 같은 처리를 받으니 다음 호출을 언제 해야 할지도
// (pollSchedule.ts), 화면에 무엇을 말해야 할지도 정할 수 없었다. 실패를 갈라 두는 것이
// 이 파일의 존재 이유다.

import { cacheLifetimeFrom, type CacheLifetime } from './cacheControl.js';
import { referenceClockFrom, type ReferenceClock } from './referenceClock.js';
import { retryAfterMillisFrom } from './retryAfter.js';

const requestTimeoutMs = 10_000;
const timeoutReason = 'timeout';

/** 이 저장소의 서버 오류 본문. apps/api/src/handlers/ 가 내는 모양이다. */
export interface ErrorBody {
  error: string;
}

export interface ApiSuccess<T> {
  ok: true;
  body: T;
  status: number;
  /** 서버 기준 시계. Date 헤더가 없으면 null이다. */
  clock: ReferenceClock | null;
  /** 이 응답의 남은 수명. 다음 호출 시각의 근거다. */
  lifetime: CacheLifetime;
}

export type ApiFailure =
  // 서버가 자기 형식으로 거부했다. 상태 코드와 사유가 있다.
  | { kind: 'contract'; error: ErrorBody; status: number; retryAfterMs: number | null }
  | { kind: 'rateLimited'; retryAfterMs: number | null }
  // 응답은 왔는데 우리가 아는 모양이 아니다. 프록시가 낸 HTML 오류 페이지가 흔하다.
  | { kind: 'malformed'; status: number }
  | { kind: 'timeout' }
  // 새 요청이 이 요청을 끊었다. 실패로 세지 않는다.
  | { kind: 'aborted' }
  | { kind: 'network'; cause: unknown };

export interface ApiError {
  ok: false;
  failure: ApiFailure;
}

export type ApiResult<T> = ApiSuccess<T> | ApiError;

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function requestJson<T>(url: string | URL, options: RequestOptions = {}): Promise<ApiResult<T>> {
  if (options.signal?.aborted) return failed({ kind: 'aborted' });

  // 바깥 신호와 시간 초과를 하나의 컨트롤러로 모은다. 중단 사유를 보고 둘을 가른다.
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', forwardAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(timeoutReason), options.timeoutMs ?? requestTimeoutMs);

  let response: Response | null = null;
  try {
    response = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    const clock = referenceClockFrom(response.headers);
    if (response.status === 429) {
      return failed({ kind: 'rateLimited', retryAfterMs: retryAfterMsOf(response, clock) });
    }

    const body: unknown = await response.json();
    return interpret<T>(response, body, clock);
  } catch (cause) {
    if (controller.signal.aborted) {
      return failed(controller.signal.reason === timeoutReason ? { kind: 'timeout' } : { kind: 'aborted' });
    }
    // 응답 헤더까지는 왔는데 본문 해석에서 깨진 경우다. 연결 실패와 구분한다.
    if (response !== null) return failed({ kind: 'malformed', status: response.status });
    return failed({ kind: 'network', cause });
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', forwardAbort);
  }
}

function interpret<T>(response: Response, body: unknown, clock: ReferenceClock | null): ApiResult<T> {
  if (response.ok) {
    return {
      ok: true,
      body: body as T,
      status: response.status,
      clock,
      lifetime: cacheLifetimeFrom(response.headers),
    };
  }

  if (isErrorBody(body)) {
    return failed({
      kind: 'contract',
      error: body,
      status: response.status,
      retryAfterMs: retryAfterMsOf(response, clock),
    });
  }

  return failed({ kind: 'malformed', status: response.status });
}

function isErrorBody(value: unknown): value is ErrorBody {
  return typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>).error === 'string';
}

function retryAfterMsOf(response: Response, clock: ReferenceClock | null): number | null {
  return retryAfterMillisFrom(response.headers, clock === null ? null : clock.now());
}

function failed(failure: ApiFailure): ApiError {
  return { ok: false, failure };
}
