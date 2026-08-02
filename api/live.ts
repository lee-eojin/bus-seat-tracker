import { allowedRoutes, fetchLiveSnapshot, GbisError } from '../server/gbis.js';

// GET /api/live?route=3330
//
// 캐시 TTL이 이 서비스의 실시간성 상한을 정한다. 공공데이터포털 일 한도 1,000회를
// 수집과 나눠 쓰는데, 30초 캐시는 1,560회, 60초는 780회로 둘 다 예산을 넘고 120초라야
// 390회로 들어간다. 이 값을 낮추기 전에 `npm run budget`을 돌린다 (DEPLOY.md §6).
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
  // CDN 캐시는 GET에만 적용되고 캐시 키에 쿼리 전체가 들어간다. 다른 메서드나 여분의
  // 파라미터를 허용하면 요청마다 캐시를 뚫고 GBIS 원 호출이 나가, 일 예산이 외부
  // 손에 놓인다 — 수집기와 같은 키라 수집까지 죽는다.
  const method = (request.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Allow', 'GET, HEAD');
    response.status(405).json({ error: 'GET만 지원합니다.' });
    return;
  }

  // 캐시 키는 디코딩 전의 원문 쿼리 문자열이므로 검증도 원문으로 한다. 디코딩 뒤에
  // 검증하면 중복 키(route=3330&route=X)와 퍼센트 인코딩 변형(%72oute=3330)이 전부
  // 같은 검증을 통과하면서 각각 새 캐시 키가 된다. 노선 이름이 URL 안전 문자뿐이라
  // 정확 일치 비교가 가능하다.
  const rawQuery = (request.url ?? '').split('?').slice(1).join('?');
  const routeName = Object.keys(allowedRoutes).find((name) => rawQuery === `route=${name}`) ?? null;
  if (routeName === null) {
    response.setHeader('Cache-Control', 'no-store');
    response.status(400).json({
      error: '지원하지 않는 요청입니다. route 하나만 받습니다.',
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
    // 실패는 캐시하지 않는다 — 일시 장애가 TTL 내내 굳으면 복구가 늦어진다.
    response.setHeader('Cache-Control', 'no-store');
    response.status(status).json({ error: message });
  }
}
