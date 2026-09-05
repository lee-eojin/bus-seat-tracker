import { allowedRoutes, fetchLiveSnapshot, GbisError } from '../gbis-client.js';
import type { LiveResponse } from '../../../../packages/domain/src/model.js';

// GET /api/live?route=3330
//
// 캐시 TTL이 이 서비스의 실시간성 상한을 정한다. 공공데이터포털 일 한도 1,000회를
// 수집과 나눠 쓰는데, 30초 캐시는 1,560회, 60초는 780회로 둘 다 예산을 넘고 120초라야
// 390회로 들어간다. 이 값을 낮추기 전에 `npm run budget`을 돌린다
// (docs/operations/deployment.md의 호출 예산 절).
// CDN이 이 헤더를 보고 origin 호출을 눌러 주므로 동시 접속자 수와 무관하게
// 노선당 120초에 1회로 유지된다.
const cacheSeconds = 120;
const staleWhileRevalidateSeconds = 240;

// 캐시 지시를 두 갈래로 나눠 보낸다.
//
// Vercel 프록시는 `Cache-Control`의 `s-maxage`와 `stale-while-revalidate`를 자기가 먹고
// 클라이언트에 보내는 헤더에서 지운다(Vercel 문서, Cache-Control headers). 그래서 한 헤더에
// 다 적으면 브라우저에 남는 것이 `public` 하나이거나 Vercel 기본값이고, 화면은 다음 조회를
// 언제 해야 하는지 알 길이 없다. 실측으로 그 경우 폴링이 60초 또는 5초로 떨어졌다.
//
// `Vercel-CDN-Cache-Control`은 Vercel 캐시에만 적용되고 클라이언트로 전달되지 않는다.
// `Cache-Control`은 그대로 전달된다. 그래서 CDN 몫과 브라우저 몫을 갈라 적는다.
export const cdnCacheControl = `public, s-maxage=${cacheSeconds}, stale-while-revalidate=${staleWhileRevalidateSeconds}`;

// 브라우저 몫에는 `stale-while-revalidate`를 넣지 않는다. 넣으면 브라우저가 낡은 응답을
// 자기 캐시에서 계속 내주는 것을 실측으로 확인했다. 수명은 CDN과 같은 값이라, 브라우저가
// 자기 사본을 쓰는 동안에도 CDN이 줄 답과 같은 판이다.
export const browserCacheControl = `public, max-age=${cacheSeconds}`;

// 이 관측을 실시간이라 부를 수 있는 기간.
//
// 공유 캐시가 최대 cacheSeconds 만큼 묵은 응답을 정상적으로 내주므로 그만큼은 낡음이 아니다.
// 거기에 여유 1분을 더한다. 이 선을 넘긴 응답을 받으면 화면은 실시간 표시를 내리고 빌드 시점
// 스냅샷으로 돌아간다. 예전에는 브라우저가 이 값을 180초 상수로 혼자 들고 있어서, 여기 캐시
// 시간을 바꿔도 브라우저가 안 따라왔다. 선을 긋는 쪽과 캐시를 정하는 쪽이 같아야 한다.
const freshnessSeconds = cacheSeconds + 60;

/** 관측 시각에 신선도 창을 더한 낡음 판정선. 화면이 이 값을 서버 기준 시계와 견준다. */
export function staleAtFor(observedAt: string): string {
  return new Date(Date.parse(observedAt) + freshnessSeconds * 1000).toISOString();
}

interface RequestLike {
  method?: string;
  url?: string;
}

interface ResponseLike {
  status(code: number): ResponseLike;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
}

export default async function handler(request: RequestLike, response: ResponseLike): Promise<void> {
  // CDN 캐시는 GET 응답만 저장한다. HEAD를 포함한 다른 메서드는 매번 함수까지 와서
  // GBIS 원 호출이 나가므로(실측: HEAD 연속 요청이 전부 캐시 MISS) 전부 끊는다.
  // 일 한도가 수집기와 공용이라 이 문이 열리면 수집까지 죽는다.
  const method = (request.method ?? 'GET').toUpperCase();
  if (method !== 'GET') {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Allow', 'GET');
    response.status(405).json({ error: 'GET만 지원합니다.' });
    return;
  }

  // 캐시 키가 요청 URL 단위라, 같은 함수에 닿는 URL 변형 하나하나가 별개 캐시 엔트리로
  // origin 호출을 만든다. 실측으로 확인된 변형은 중복 키(route=3330&route=X는 값마다
  // 새 캐시 키)와 경로 변형(/api/live/와 /api/live.ts는 각각 독립 캐시 키)이다. 퍼센트
  // 인코딩은 플랫폼이 캐시 키와 함께 정규화해 핸들러에 오기 전에 접힌다.
  // 그래서 경로와 쿼리를 원문 문자열 정확 일치로만 통과시킨다.
  const requestUrl = request.url ?? '';
  const questionMark = requestUrl.indexOf('?');
  const rawPath = questionMark === -1 ? requestUrl : requestUrl.slice(0, questionMark);
  const rawQuery = questionMark === -1 ? '' : requestUrl.slice(questionMark + 1);
  const routeName = rawPath === '/api/live'
    ? Object.keys(allowedRoutes).find((name) => rawQuery === `route=${name}`) ?? null
    : null;
  if (routeName === null) {
    response.setHeader('Cache-Control', 'no-store');
    response.status(400).json({
      error: '지원하지 않는 요청입니다. /api/live?route=<노선> 형식만 받습니다.',
      routes: Object.keys(allowedRoutes),
    });
    return;
  }

  const apiKey = process.env.GYEONGGI_BUS_API_KEY;
  if (!apiKey) {
    // 키 부재는 설정 실패다. 화면은 마지막 스냅샷으로 폴백하므로 죽지 않는다.
    response.setHeader('Cache-Control', 'no-store');
    response.status(503).json({ error: '실시간 조회를 사용할 수 없습니다.' });
    return;
  }

  try {
    const snapshot = await fetchLiveSnapshot(routeName, apiKey);
    const body: LiveResponse = { ...snapshot, staleAt: staleAtFor(snapshot.observedAt) };
    response.setHeader('Vercel-CDN-Cache-Control', cdnCacheControl);
    response.setHeader('Cache-Control', browserCacheControl);
    response.status(200).json(body);
  } catch (error: unknown) {
    const status = error instanceof GbisError ? error.status : 502;
    const message = error instanceof GbisError ? error.message : '실시간 조회에 실패했습니다.';
    // 실패는 캐시하지 않는다. 일시 장애가 TTL 내내 굳으면 복구가 늦어진다.
    response.setHeader('Cache-Control', 'no-store');
    response.status(status).json({ error: message });
  }
}
