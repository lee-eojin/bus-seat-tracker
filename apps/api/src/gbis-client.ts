import { asList, isRecord, readGbisResultError, readIdentifier, readNumber, readUpstreamErrorEnvelope } from '../../../packages/domain/src/model.js';

// GBIS 클라이언트 (서버 전용).
//
// 키는 `process.env`에서만 읽는다 — 클라이언트가 직접 GBIS를 부르던 경로를 대체하는 것이
// 이 파일의 존재 이유다. 응답에서 차량번호(`plateNo`)와 원본 차량 ID(`vehId`)를 모두 제거해
// 외부 API 응답에서 화면에 필요한 필드만 통과시켜 데이터 경계를 지킨다.

const apiBaseUrl = 'https://apis.data.go.kr/6410000';
const vehicleLocationPath = '/buslocationservice/v2/getBusLocationListv2';
const requestTimeoutMs = 10_000;

/** 프록시가 부를 수 있는 노선. 임의 routeId를 흘리면 남의 조회로 우리 키 쿼터가 소모된다. */
export const allowedRoutes: Record<string, string> = {
  '3330': '204000057',
  '1650': '234000050',
};

export interface LiveVehicle {
  currentStopSequence: number | null;
  remainingSeats: number | null;
  crowded: number | null;
  status: number | null;
}

export interface LiveSnapshot {
  routeName: string;
  routeId: string;
  apiQueryTime: string | null;
  vehicles: LiveVehicle[];
}

export class GbisError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'GbisError';
  }
}

function readItems(payload: unknown, keys: [string, string]): unknown[] {
  if (!isRecord(payload)) return [];
  const response = isRecord(payload.response) ? payload.response : payload;
  const body = isRecord(response.msgBody) ? response.msgBody : response;
  const container = body[keys[0]] ?? body[keys[1]];
  return asList(container);
}

function readQueryTime(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const response = isRecord(payload.response) ? payload.response : payload;
  const header = isRecord(response.msgHeader) ? response.msgHeader : null;
  return header ? readIdentifier(header.queryTime) : null;
}

// 화면이 쓰는 필드만 통과시킨다. plateNo와 vehId는 여기서 끊긴다.
function readVehicle(value: unknown): LiveVehicle | null {
  if (!isRecord(value)) return null;
  return {
    currentStopSequence: readNumber(value.stationSeq),
    remainingSeats: readNumber(value.remainSeatCnt),
    crowded: readNumber(value.crowded),
    status: readNumber(value.stateCd),
  };
}

// undici는 연결 단계 실패를 전부 `TypeError: fetch failed`로 감싸므로 name만 남기면 정보가 0이다.
// 원인 체인에서 코드와 이름만 뽑는다. 메시지에는 요청 URL이 섞일 수 있어 넣지 않는다.
function failureCodes(error: unknown): string {
  const codes: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 5; depth += 1) {
    const code = (current as { code?: unknown }).code;
    codes.push(typeof code === 'string' && code !== '' ? code : current.name);
    current = current.cause;
  }
  return codes.join(' ← ') || 'unknown';
}

export async function fetchLiveSnapshot(routeName: string, apiKey: string): Promise<LiveSnapshot> {
  const routeId = allowedRoutes[routeName];
  if (!routeId) throw new GbisError(`허용되지 않은 노선입니다: ${routeName}`, 400);

  const requestUrl = new URL(apiBaseUrl + vehicleLocationPath);
  requestUrl.search = new URLSearchParams({ serviceKey: apiKey, format: 'json', routeId }).toString();

  let response: Response;
  try {
    response = await fetch(requestUrl, { signal: AbortSignal.timeout(requestTimeoutMs) });
  } catch (error: unknown) {
    // 타임아웃·네트워크 오류를 502로 정규화한다. GBIS 원문을 그대로 흘리면 키가 섞일 수 있다.
    throw new GbisError(`GBIS 응답을 받지 못했습니다: ${failureCodes(error)}`, 502);
  }

  const responseText = await response.text();
  if (!response.ok) throw new GbisError(`GBIS 오류 (${response.status})`, response.status === 429 ? 429 : 502);

  let payload: unknown;
  try {
    payload = JSON.parse(responseText) as unknown;
  } catch {
    // 키 만료·한도 초과 시 GBIS가 XML 오류를 돌려준다. 본문을 그대로 노출하지 않는다.
    throw new GbisError('GBIS가 JSON을 반환하지 않았습니다. 키 또는 호출 한도를 확인하세요.', 502);
  }

  // 상류는 키나 한도 오류를 HTTP 200 본문에 담아 보내기도 한다. 이걸 보지 않으면 항목 목록이
  // 비어 "운행 중인 차량이 없습니다"가 정상 응답으로 120초 캐시된다. 화면은 그동안 "실시간"이라
  // 말하면서 틀린 답을 보여준다. 오류로 올려야 핸들러가 캐시하지 않는다.
  const envelope = readUpstreamErrorEnvelope(payload);
  if (envelope) {
    // 23은 초당 호출 허용량 초과라 곧 풀린다. 그 밖은 키, 권한, 한도 문제라 사람이 봐야 한다.
    throw new GbisError(`GBIS가 오류를 반환했습니다 (${envelope.code})`, envelope.code === '23' ? 429 : 502);
  }

  // GBIS 자체 결과 코드도 본다. 명세상 0이 정상, 4가 결과 없음이고 나머지는 오류다.
  // 1(시스템 에러)을 통과시키면 차량 0대가 정상 응답으로 캐시된다.
  const resultError = readGbisResultError(payload);
  if (resultError) {
    throw new GbisError(`GBIS가 결과 코드 ${resultError.code}을 반환했습니다`, 502);
  }

  const vehicles = readItems(payload, ['busLocationList', 'busLocation'])
    .map(readVehicle)
    .filter((vehicle): vehicle is LiveVehicle => vehicle !== null);

  return { routeName, routeId, apiQueryTime: readQueryTime(payload), vehicles };
}
