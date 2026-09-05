import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import handler, { browserCacheControl, cdnCacheControl, staleAtFor } from './live.js';

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
    // CDN 몫과 브라우저 몫을 따로 낸다. 한 헤더에 다 적으면 Vercel이 s-maxage를 지워
    // 브라우저가 다음 조회 시각을 못 만든다.
    assert.match(state.headers['Vercel-CDN-Cache-Control'] ?? '', /s-maxage=/);
    assert.match(state.headers['Cache-Control'] ?? '', /max-age=/);
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
    // CDN 몫과 브라우저 몫을 따로 낸다. 한 헤더에 다 적으면 Vercel이 s-maxage를 지워
    // 브라우저가 다음 조회 시각을 못 만든다.
    assert.match(state.headers['Vercel-CDN-Cache-Control'] ?? '', /s-maxage=/);
    assert.match(state.headers['Cache-Control'] ?? '', /max-age=/);
  });
});

describe('staleAtFor', () => {
  it('관측 시각에 신선도 창(캐시 120초 + 여유 60초)을 더한다', () => {
    assert.equal(staleAtFor('2026-09-02T03:00:00.000Z'), '2026-09-02T03:03:00.000Z');
  });

  it('오프셋이 붙은 시각도 UTC로 정규화해서 낸다 (화면이 파싱해 비교하는 값이라 형식이 하나여야 한다)', () => {
    assert.equal(staleAtFor('2026-09-02T12:00:00+09:00'), '2026-09-02T03:03:00.000Z');
  });

  it('낡음 선은 언제나 관측 시각보다 뒤다', () => {
    const observedAt = '2026-09-02T03:00:00.000Z';
    assert.ok(Date.parse(staleAtFor(observedAt)) > Date.parse(observedAt));
  });
});

describe('캐시 지시를 CDN 몫과 브라우저 몫으로 가른다', () => {
  it('CDN 몫에만 s-maxage와 stale-while-revalidate가 있다', () => {
    assert.match(cdnCacheControl, /s-maxage=120/);
    assert.match(cdnCacheControl, /stale-while-revalidate=240/);
  });

  it('브라우저 몫에는 stale-while-revalidate를 넣지 않는다', () => {
    // 넣으면 브라우저가 낡은 응답을 자기 캐시에서 계속 내준다 (실측 확인).
    assert.doesNotMatch(browserCacheControl, /stale-while-revalidate/);
  });

  it('브라우저 몫이 수명을 숫자로 밝힌다 (화면이 다음 조회 시각을 여기서 만든다)', () => {
    // 이 값이 없으면 pollSchedule이 대체값 60초나 하한 5초로 흐른다.
    assert.match(browserCacheControl, /max-age=120/);
  });

  it('브라우저가 자기 사본을 쓰는 동안에도 낡음 선을 안 넘는다', () => {
    const maxAge = Number(/max-age=(\d+)/.exec(browserCacheControl)?.[1]);
    const observedAt = '2026-09-05T03:00:00.000Z';
    const window = (Date.parse(staleAtFor(observedAt)) - Date.parse(observedAt)) / 1000;
    assert.ok(maxAge <= window, `브라우저 수명 ${maxAge}초가 신선도 창 ${window}초를 넘으면 안 된다`);
  });
});
