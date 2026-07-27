import { asList, isRecord, readIdentifier, readNumber } from '../shared/model.js';

// GBIS 클라이언트 (서버 전용).
//
// 키는 `process.env`에서만 읽는다 — 클라이언트가 직접 GBIS를 부르던 경로를 대체하는 것이
// 이 파일의 존재 이유다. 응답에서 차량번호(`plateNo`)를 제거해 데이터 경계를 유지한다
// (bus-seat-collector/RUNNING.md '데이터 경계').

const apiBaseUrl = 'https://apis.data.go.kr/6410000';
const vehicleLocationPath = '/buslocationservice/v2/getBusLocationListv2';
const requestTimeoutMs = 10_000;

/** 프록시가 부를 수 있는 노선. 임의 routeId를 흘리면 남의 조회로 우리 키 쿼터가 소모된다. */
export const allowedRoutes: Record<string, string> = {
  '3330': '204000057',
  '1650': '234000050',
};

export interface LiveVehicle {
  id: string | null;
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

// 화면이 쓰는 필드만 통과시킨다. plateNo는 여기서 끊긴다.
function readVehicle(value: unknown): LiveVehicle | null {
  if (!isRecord(value)) return null;
  return {
    id: readIdentifier(value.vehId),
    currentStopSequence: readNumber(value.stationSeq),
    remainingSeats: readNumber(value.remainSeatCnt),
    crowded: readNumber(value.crowded),
    status: readNumber(value.stateCd),
  };
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
    throw new GbisError(`GBIS 응답을 받지 못했습니다: ${error instanceof Error ? error.name : 'unknown'}`, 502);
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

  const vehicles = readItems(payload, ['busLocationList', 'busLocation'])
    .map(readVehicle)
    .filter((vehicle): vehicle is LiveVehicle => vehicle !== null);

  return { routeName, routeId, apiQueryTime: readQueryTime(payload), vehicles };
}
