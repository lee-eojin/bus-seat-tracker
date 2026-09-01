import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { requestJson } from './client.js';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function respondWith(body: unknown, status = 200, headers: Record<string, string> = {}): void {
  globalThis.fetch = async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

// 신호를 지키는 스텁. 이걸 안 하면 취소 시험이 영원히 매달린다.
function neverResponds(): void {
  globalThis.fetch = (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
}

describe('requestJson 성공', () => {
  it('본문과 남은 수명을 함께 돌려준다', async () => {
    respondWith({ routeName: '3330', vehicles: [] }, 200, {
      'cache-control': 'public, s-maxage=120, stale-while-revalidate=240',
      age: '30',
    });

    const result = await requestJson<{ routeName: string }>('/api/live?route=3330');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.body.routeName, '3330');
    assert.equal(result.lifetime.maxAgeSeconds, 120);
    assert.equal(result.lifetime.ageSeconds, 30);
  });

  it('Date 헤더가 있으면 서버 기준 시계를 만든다', async () => {
    respondWith({}, 200, { date: new Date(Date.UTC(2026, 8, 2, 3, 0, 0)).toUTCString(), age: '10' });

    const result = await requestJson('/api/live?route=3330');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.notEqual(result.clock, null);
    assert.equal(result.clock?.servedAt, Date.UTC(2026, 8, 2, 3, 0, 10));
  });
});

describe('requestJson 실패 구분', () => {
  it('서버가 아는 형식으로 거부하면 contract다', async () => {
    respondWith({ error: '지원하지 않는 요청입니다.' }, 400, { 'cache-control': 'no-store' });

    const result = await requestJson('/api/live?route=9999');
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failure.kind, 'contract');
    if (result.failure.kind !== 'contract') return;
    assert.equal(result.failure.status, 400);
    assert.equal(result.failure.error.error, '지원하지 않는 요청입니다.');
  });

  it('오류인데 아는 형식이 아니면 malformed다 (프록시가 낸 페이지가 그렇다)', async () => {
    respondWith({ nonsense: true }, 502);

    const result = await requestJson('/api/live?route=3330');
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failure.kind, 'malformed');
  });

  it('429는 Retry-After와 함께 rateLimited로 낸다', async () => {
    respondWith({ error: '잠시 뒤 다시' }, 429, { 'retry-after': '45' });

    const result = await requestJson('/api/live?route=3330');
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failure.kind, 'rateLimited');
    if (result.failure.kind !== 'rateLimited') return;
    assert.equal(result.failure.retryAfterMs, 45_000);
  });

  it('제 시간에 못 받으면 timeout이다', async () => {
    neverResponds();

    const result = await requestJson('/api/live?route=3330', { timeoutMs: 20 });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failure.kind, 'timeout');
  });

  it('바깥에서 끊으면 aborted다. 시간 초과와 구분한다', async () => {
    neverResponds();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);

    const result = await requestJson('/api/live?route=3330', { signal: controller.signal, timeoutMs: 5_000 });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failure.kind, 'aborted');
  });

  it('이미 끊긴 신호로 부르면 요청을 내지 않는다', async () => {
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      return new Response('{}');
    };

    const result = await requestJson('/api/live?route=3330', { signal: AbortSignal.abort() });
    assert.equal(called, false, '끊긴 요청으로 일일 호출을 쓰면 안 된다');
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failure.kind, 'aborted');
  });

  it('연결 자체가 안 되면 network다', async () => {
    globalThis.fetch = async () => {
      throw new TypeError('fetch failed');
    };

    const result = await requestJson('/api/live?route=3330');
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failure.kind, 'network');
  });
});
