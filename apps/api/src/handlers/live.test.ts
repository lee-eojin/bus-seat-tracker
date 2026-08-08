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
  it('GET 외 메서드는 405와 no-store로 끊는다 (HEAD도 캐시가 안 잡아 origin 직행이므로 포함)', async () => {
    for (const method of ['POST', 'HEAD', 'PUT', 'OPTIONS']) {
      const { request, response, state } = fakeExchange(method, '/api/live?route=3330');
      await handler(request, response);
      assert.equal(state.status, 405, method);
      assert.equal(state.headers['Cache-Control'], 'no-store', method);
      assert.equal(state.headers['Allow'], 'GET', method);
    }
  });

  it('여분의 쿼리 파라미터는 400이다 (캐시 키 우회 차단)', async () => {
    const { request, response, state } = fakeExchange('GET', '/api/live?route=3330&nonce=1');
    await handler(request, response);
    assert.equal(state.status, 400);
    assert.equal(state.headers['Cache-Control'], 'no-store');
  });

  it('route 키 중복은 값이 같아도 400이다 (원문 쿼리가 캐시 키라서)', async () => {
    for (const url of ['/api/live?route=3330&route=1', '/api/live?route=3330&route=3330']) {
      const { request, response, state } = fakeExchange('GET', url);
      await handler(request, response);
      assert.equal(state.status, 400, url);
      assert.equal(state.headers['Cache-Control'], 'no-store', url);
    }
  });

  it('경로 변형은 400이다 (뒤 슬래시와 .ts 접미사가 별개 캐시 키로 실측됨)', async () => {
    for (const url of ['/api/live/?route=3330', '/api/live.ts?route=3330', '/API/live?route=3330']) {
      const { request, response, state } = fakeExchange('GET', url);
      await handler(request, response);
      assert.equal(state.status, 400, url);
      assert.equal(state.headers['Cache-Control'], 'no-store', url);
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

});

describe('/api/live 상류 오류 처리', () => {
  // 상류는 키나 한도 오류를 HTTP 200 본문에 담아 보내기도 한다. 이걸 통과시키면 차량 0대가
  // 정상 응답으로 120초 캐시되고, 화면은 "실시간"이라 말하면서 "운행 중인 차량이 없습니다"를
  // 보여준다. 사용자가 보는 답이 틀리는 경로라 캐시하지 않고 오류로 올려야 한다.
  async function callWithUpstreamBody(body: unknown, status = 200) {
    const originalFetch = globalThis.fetch;
    const originalKey = process.env.GYEONGGI_BUS_API_KEY;
    process.env.GYEONGGI_BUS_API_KEY = 'test-key';
    globalThis.fetch = (async () => new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as typeof globalThis.fetch;
    try {
      const { request, response, state } = fakeExchange('GET', '/api/live?route=3330');
      await handler(request, response);
      return state;
    } finally {
      globalThis.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.GYEONGGI_BUS_API_KEY;
      else process.env.GYEONGGI_BUS_API_KEY = originalKey;
    }
  }

  it('200에 담겨 온 한도 초과를 캐시하지 않고 오류로 올린다', async () => {
    const state = await callWithUpstreamBody({
      OpenAPI_ServiceResponse: {
        cmmMsgHeader: { returnReasonCode: '22', returnAuthMsg: '서비스 요청제한횟수 초과' },
      },
    });
    assert.equal(state.status, 502);
    assert.equal(state.headers['Cache-Control'], 'no-store');
  });

  it('초당 한도 초과는 429로 구분한다', async () => {
    const state = await callWithUpstreamBody({
      OpenAPI_ServiceResponse: { cmmMsgHeader: { returnReasonCode: '23', returnAuthMsg: '초당 허용량 초과' } },
    });
    assert.equal(state.status, 429);
    assert.equal(state.headers['Cache-Control'], 'no-store');
  });

  it('정상 응답은 캐시한다', async () => {
    const state = await callWithUpstreamBody({
      response: { msgHeader: { queryTime: '2026-08-08 21:00:00' }, msgBody: { busLocationList: [] } },
    });
    assert.equal(state.status, 200);
    assert.match(state.headers['Cache-Control'] ?? '', /public, s-maxage=/);
  });
});

describe('/api/live GBIS 결과 코드', () => {
  // 명세: 0 정상, 1 시스템 에러, 4 결과 없음. 1을 통과시키면 차량 0대가 정상 응답으로 캐시된다.
  async function callWithBody(body: unknown) {
    const originalFetch = globalThis.fetch;
    const originalKey = process.env.GYEONGGI_BUS_API_KEY;
    process.env.GYEONGGI_BUS_API_KEY = 'test-key';
    globalThis.fetch = (async () => new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof globalThis.fetch;
    try {
      const { request, response, state } = fakeExchange('GET', '/api/live?route=3330');
      await handler(request, response);
      return state;
    } finally {
      globalThis.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.GYEONGGI_BUS_API_KEY;
      else process.env.GYEONGGI_BUS_API_KEY = originalKey;
    }
  }

  it('시스템 에러를 캐시하지 않고 오류로 올린다', async () => {
    const state = await callWithBody({
      response: { msgHeader: { resultCode: 1, resultMessage: '시스템 에러가 발생하였습니다.' } },
    });
    assert.equal(state.status, 502);
    assert.equal(state.headers['Cache-Control'], 'no-store');
  });

  it('결과 없음은 정상이라 캐시한다', async () => {
    const state = await callWithBody({
      response: { msgHeader: { resultCode: 4, resultMessage: '결과가 존재하지 않습니다.' }, msgBody: {} },
    });
    assert.equal(state.status, 200);
    assert.match(state.headers['Cache-Control'] ?? '', /public, s-maxage=/);
  });
});
