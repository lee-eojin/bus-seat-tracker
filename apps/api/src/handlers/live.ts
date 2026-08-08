import { allowedRoutes, fetchLiveSnapshot, GbisError } from '../gbis-client.js';

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
    response.setHeader('Cache-Control', `public, s-maxage=${cacheSeconds}, stale-while-revalidate=${staleWhileRevalidateSeconds}`);
    response.status(200).json(snapshot);
  } catch (error: unknown) {
    const status = error instanceof GbisError ? error.status : 502;
    const message = error instanceof GbisError ? error.message : '실시간 조회에 실패했습니다.';
    // 실패는 캐시하지 않는다. 일시 장애가 TTL 내내 굳으면 복구가 늦어진다.
    response.setHeader('Cache-Control', 'no-store');
    response.status(status).json({ error: message });
  }
}
