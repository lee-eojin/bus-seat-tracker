import { allowedRoutes, fetchLiveSnapshot, GbisError } from '../server/gbis.js';

// GET /api/live?route=3330
//
// 캐시 TTL이 이 서비스의 실시간성 상한을 정한다. 공공데이터포털 일 한도가 1,000회인데
// 수집이 이미 약 482회를 쓰므로 웹 가용분은 약 518회다. 출퇴근 6.5시간 기준으로
// 30초 캐시는 1,560회, 60초는 780회로 둘 다 예산을 넘고 120초라야 390회로 들어간다
// (docs/../findings.md §0). CDN이 이 헤더를 보고 origin 호출을 눌러 주므로
// 동시 접속자 수와 무관하게 노선당 120초에 1회로 유지된다.
const cacheSeconds = 120;
const staleWhileRevalidateSeconds = 240;

interface RequestLike {
  url?: string;
}

interface ResponseLike {
  status(code: number): ResponseLike;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
}

export default async function handler(request: RequestLike, response: ResponseLike): Promise<void> {
  const routeName = new URL(request.url ?? '/', 'http://localhost').searchParams.get('route') ?? '';

  if (!Object.prototype.hasOwnProperty.call(allowedRoutes, routeName)) {
    response.setHeader('Cache-Control', 'no-store');
    response.status(400).json({ error: '지원하지 않는 노선입니다.', routes: Object.keys(allowedRoutes) });
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
