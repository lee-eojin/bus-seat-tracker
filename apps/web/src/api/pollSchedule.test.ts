import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CacheLifetime } from './cacheControl.js';
import type { ApiFailure, ApiResult } from './client.js';
import { nextPollFrom } from './pollSchedule.js';

function success(lifetime: Partial<CacheLifetime>): ApiResult<unknown> {
  return {
    ok: true,
    body: null,
    status: 200,
    clock: null,
    lifetime: { noStore: false, maxAgeSeconds: null, ageSeconds: 0, ...lifetime },
  };
}

function failed(failure: ApiFailure): ApiResult<unknown> {
  return { ok: false, failure };
}

describe('nextPollFrom 성공', () => {
  it('남은 수명만큼 기다린다', () => {
    assert.deepEqual(nextPollFrom(success({ maxAgeSeconds: 120, ageSeconds: 30 })), {
      kind: 'again',
      delayMs: 90_000,
    });
  });

  it('이미 낡은 응답이어도 5초 아래로는 안 내려간다', () => {
    assert.deepEqual(nextPollFrom(success({ maxAgeSeconds: 120, ageSeconds: 200 })), {
      kind: 'again',
      delayMs: 5_000,
    });
  });

  it('수명을 안 밝힌 응답은 60초 뒤에 다시 부른다', () => {
    assert.deepEqual(nextPollFrom(success({})), { kind: 'again', delayMs: 60_000 });
    assert.deepEqual(nextPollFrom(success({ noStore: true, maxAgeSeconds: 20 })), {
      kind: 'again',
      delayMs: 60_000,
    });
  });
});

describe('nextPollFrom 실패', () => {
  it('취소된 요청은 다음을 예약하지 않는다 (우리를 밀어낸 요청이 잡는다)', () => {
    assert.deepEqual(nextPollFrom(failed({ kind: 'aborted' })), { kind: 'stop' });
  });

  it('4xx는 다시 불러도 같은 답이라 멈춘다', () => {
    const failure: ApiFailure = { kind: 'contract', error: { error: '지원하지 않는 요청입니다.' }, status: 400, retryAfterMs: null };
    assert.deepEqual(nextPollFrom(failed(failure)), { kind: 'stop' });
  });

  it('5xx는 다시 부른다. Retry-After가 있으면 그 값을 쓴다', () => {
    const withHint: ApiFailure = { kind: 'contract', error: { error: '실시간 조회를 사용할 수 없습니다.' }, status: 503, retryAfterMs: 300_000 };
    assert.deepEqual(nextPollFrom(failed(withHint)), { kind: 'again', delayMs: 300_000 });

    const withoutHint: ApiFailure = { kind: 'contract', error: { error: '실시간 조회에 실패했습니다.' }, status: 502, retryAfterMs: null };
    assert.deepEqual(nextPollFrom(failed(withoutHint)), { kind: 'again', delayMs: 60_000 });
  });

  it('429는 서버가 말한 시각까지 기다린다', () => {
    assert.deepEqual(nextPollFrom(failed({ kind: 'rateLimited', retryAfterMs: 45_000 })), {
      kind: 'again',
      delayMs: 45_000,
    });
  });

  it('타임아웃, 연결 실패, 형식 깨짐은 60초 뒤에 다시 부른다', () => {
    for (const failure of [
      { kind: 'timeout' } as const,
      { kind: 'network', cause: new Error('offline') } as const,
      { kind: 'malformed', status: 502 } as const,
    ]) {
      assert.deepEqual(nextPollFrom(failed(failure)), { kind: 'again', delayMs: 60_000 }, failure.kind);
    }
  });
});
