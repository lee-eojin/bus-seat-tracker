import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import handler from './live.js';

// GBIS 호출 전에 반환되는 거부 경로만 검증한다. 통과 경로는 실제 네트워크가 필요해
// 여기서 다루지 않는다.

function fakeExchange(method: string, url: string) {
  const state = { status: 0, headers: {} as Record<string, string>, body: undefined as unknown };
  const response = {
    status(code: number) {
      state.status = code;
      return response;
    },
    setHeader(name: string, value: string) {
      state.headers[name] = value;
    },
    json(body: unknown) {
      state.body = body;
    },
  };
  return { request: { method, url }, response, state };
}

describe('/api/live 거부 경로', () => {
  it('GET 외 메서드는 405와 no-store로 끊는다', async () => {
    const { request, response, state } = fakeExchange('POST', '/api/live?route=3330');
    await handler(request, response);
    assert.equal(state.status, 405);
    assert.equal(state.headers['Cache-Control'], 'no-store');
    assert.equal(state.headers['Allow'], 'GET, HEAD');
  });

  it('여분의 쿼리 파라미터는 400이다 — 캐시 키 우회 차단', async () => {
    const { request, response, state } = fakeExchange('GET', '/api/live?route=3330&nonce=1');
    await handler(request, response);
    assert.equal(state.status, 400);
    assert.equal(state.headers['Cache-Control'], 'no-store');
  });

  it('route 키 중복은 값이 같아도 400이다 — 원문 쿼리가 캐시 키라서', async () => {
    for (const url of ['/api/live?route=3330&route=1', '/api/live?route=3330&route=3330']) {
      const { request, response, state } = fakeExchange('GET', url);
      await handler(request, response);
      assert.equal(state.status, 400, url);
      assert.equal(state.headers['Cache-Control'], 'no-store', url);
    }
  });

  it('퍼센트 인코딩 변형도 400이다', async () => {
    for (const url of ['/api/live?%72oute=3330', '/api/live?route=%33330']) {
      const { request, response, state } = fakeExchange('GET', url);
      await handler(request, response);
      assert.equal(state.status, 400, url);
    }
  });

  it('정확한 원문 쿼리는 검증을 통과한다 (키 미설정 환경에서 503까지 진행)', async () => {
    const saved = process.env.GYEONGGI_BUS_API_KEY;
    delete process.env.GYEONGGI_BUS_API_KEY;
    try {
      const { request, response, state } = fakeExchange('GET', '/api/live?route=3330');
      await handler(request, response);
      assert.equal(state.status, 503);
    } finally {
      if (saved !== undefined) process.env.GYEONGGI_BUS_API_KEY = saved;
    }
  });

  it('허용 목록에 없는 노선은 400이다', async () => {
    const { request, response, state } = fakeExchange('GET', '/api/live?route=9999');
    await handler(request, response);
    assert.equal(state.status, 400);
    assert.equal(state.headers['Cache-Control'], 'no-store');
  });

  it('route 자체가 없어도 400이다', async () => {
    const { request, response, state } = fakeExchange('GET', '/api/live');
    await handler(request, response);
    assert.equal(state.status, 400);
  });

  it('HEAD는 메서드 거부 없이 파라미터 검증으로 넘어간다', async () => {
    const { request, response, state } = fakeExchange('HEAD', '/api/live?route=9999');
    await handler(request, response);
    assert.equal(state.status, 400);
  });
});
