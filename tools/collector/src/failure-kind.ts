// 수집 실패를 "저절로 낫는 것"과 "사람이 손대야 하는 것"으로 가른다.
//
// 2026-08-08까지 워크플로는 이 둘을 구분하지 않았다. setFailed가 걸리는 조건 하나에
// 러너 송신 경로 문제로 생기는 연결 타임아웃과 API 키 폐기가 함께 들어가 있었고,
// 알림 문구는 `Command failed: node .../collector.js --once`로 끝나 어느 쪽인지 알 수 없었다.
// 원인이 안 보였던 것은 오류 메시지만 읽고 error.cause 체인을 버렸기 때문이다.
// undici는 연결 실패를 전부 `TypeError: fetch failed`로 감싸고 진짜 원인은 cause에 넣는다.
//
// 분류는 화이트리스트다. 자가 치유가 확실한 갈래만 transient로 내리고 나머지는 전부
// actionable로 둔다. 모르는 실패를 조용히 만들면 키가 죽은 날 아무도 모른다.

import { isRecord, readIdentifier } from '../../../packages/domain/src/model.js';

export type FailureKind = 'transient' | 'actionable';

/** 수집기가 자가 치유되는 실패로 끝날 때 쓰는 종료 코드. 워크플로가 이 값으로 경고와 실패를 가른다. */
export const transientExitCode = 10;

interface UpstreamFailureOptions extends ErrorOptions {
  httpStatus?: number | null;
  upstreamCode?: string | null;
}

/** 상류(GBIS) 호출이 만든 실패. httpStatus가 null이면 응답 자체를 받지 못한 것이다. */
export class UpstreamFailure extends Error {
  readonly httpStatus: number | null;
  readonly upstreamCode: string | null;

  constructor(message: string, options: UpstreamFailureOptions = {}) {
    super(message, options);
    this.name = 'UpstreamFailure';
    this.httpStatus = options.httpStatus ?? null;
    this.upstreamCode = options.upstreamCode ?? null;
  }
}

// undici와 Node가 연결 단계 실패에 붙이는 코드. 러너의 송신 경로 문제이거나 순간적인
// 네트워크 흔들림이라, 상류가 살아 있어도 특정 러너에서만 난다.
const transientErrorCodes = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EPIPE',
]);

// AbortSignal.timeout이 끊었을 때의 이름. 요청이 예산을 넘긴 것이라 다음 사이클에 다시 해본다.
const transientErrorNames = new Set(['TimeoutError', 'AbortError']);

// 공공데이터포털이 키·권한·한도 문제에 붙이는 문구. 사람이 포털에서 조치해야 풀린다.
// 영문과 국문이 모두 관측된다(실측: "등록되지 않은 서비스키"). 모르는 상류 오류도 기본이
// actionable이라 이 목록은 분류를 바꾸기보다 의도를 드러내는 쪽에 가깝다.
const actionableUpstreamMarkers = [
  'SERVICE_KEY_IS_NOT_REGISTERED',
  'LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS',
  'SERVICE_ACCESS_DENIED',
  'DEADLINE_HAS_EXPIRED',
  'UNREGISTERED_IP',
  'TEMPORARILY_DISABLE_THE_SERVICEKEY',
  '등록되지 않은 서비스키',
  '기한만료된 서비스키',
  '서비스 요청제한횟수 초과',
];

// 공공데이터포털 공통 오류표에서 저절로 낫는 코드.
// 01 게이트웨이 내부 오류, 05 연결 실패·응답 대기 초과, 23 초당 호출 허용량 초과.
// 22(일일 호출 허용량)는 자정까지 안 낫고 구속 제약을 건드렸다는 설계 신호라 여기 없다.
const transientUpstreamCodes = new Set(['01', '05', '23']);

function errorCode(error: Error): string | null {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code !== '' ? code : null;
}

/**
 * 여러 실패를 하나의 cause로 묶는다. 하나면 그대로, 여럿이면 AggregateError로 싼다.
 * 분류와 설명이 모든 실패를 볼 수 있어야 조치가 필요한 실패가 묻히지 않는다.
 */
export function toSingleCause(reasons: readonly unknown[], summary: string): unknown {
  if (reasons.length === 0) return undefined;
  if (reasons.length === 1) return reasons[0];
  return new AggregateError(reasons, summary);
}

/** 원인 체인을 바깥에서 안쪽 순서로 펼친다. AggregateError가 안고 있는 오류도 따라간다. */
export function failureChain(error: unknown): Error[] {
  const chain: Error[] = [];
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!(current instanceof Error) || seen.has(current)) continue;
    seen.add(current);
    chain.push(current);
    if (current.cause !== undefined) queue.push(current.cause);
    if (current instanceof AggregateError) queue.push(...current.errors);
  }
  return chain;
}

/** 체인 전체를 한 줄로 적는다. 코드가 있으면 괄호로 붙인다. */
export function describeFailure(error: unknown): string {
  const chain = failureChain(error);
  if (chain.length === 0) return String(error);
  return chain
    .map((link) => {
      const code = errorCode(link);
      const status = link instanceof UpstreamFailure ? link.upstreamCode : null;
      const marker = code ?? status;
      return marker ? `${link.message} (${marker})` : link.message;
    })
    .join(' ← ');
}

/**
 * 화이트리스트에 걸리는 것만 transient다. 모르는 실패는 전부 actionable로 남긴다.
 * 사람이 손대야 하는 신호가 하나라도 있으면 그쪽이 이긴다.
 */
export function classifyFailure(error: unknown): FailureKind {
  const chain = failureChain(error);
  let transient = false;

  for (const link of chain) {
    if (link instanceof UpstreamFailure) {
      // 코드는 숫자일 수 있고 사람이 읽을 문구는 메시지에 있다. 둘 다 본다.
      const haystack = `${link.upstreamCode ?? ''} ${link.message}`.toUpperCase();
      if (actionableUpstreamMarkers.some((marker) => haystack.includes(marker.toUpperCase()))) return 'actionable';
      if (link.httpStatus === 401 || link.httpStatus === 403) return 'actionable';
      if (link.upstreamCode !== null && transientUpstreamCodes.has(link.upstreamCode)) transient = true;
      if (link.httpStatus === 429 || (link.httpStatus !== null && link.httpStatus >= 500)) transient = true;
      continue;
    }
    const code = errorCode(link);
    if (code && transientErrorCodes.has(code)) transient = true;
    if (transientErrorNames.has(link.name)) transient = true;
  }

  return transient ? 'transient' : 'actionable';
}

export interface UpstreamStatus {
  code: string;
  message: string;
}

/**
 * GBIS 자체 헤더가 0이 아닌 결과 코드를 냈을 때 그 값을 돌려준다.
 *
 * 이 코드 체계는 포털 공통 코드표와 별개이고 실측 픽스처가 없다. 오류로 단정하면 정상적인
 * 무데이터 응답(명세상 4가 "결과 없음")에서 수집이 죽고, 무시하면 200에 담긴 오류를 놓친다.
 * 그래서 판정하지 않고 기록만 남긴다. 실제 값이 로그에 찍히면 그때 판정으로 올린다.
 * 키·한도 오류는 포털 오류 봉투로 오므로 이 경로가 아니어도 잡힌다.
 */
export function readResultNotice(payload: unknown): UpstreamStatus | null {
  if (!isRecord(payload)) return null;
  const response = isRecord(payload.response) ? payload.response : null;
  const header = response && isRecord(response.msgHeader)
    ? response.msgHeader
    : isRecord(payload.msgHeader)
      ? payload.msgHeader
      : null;
  if (!header) return null;

  const rawCode = header.resultCode;
  if (rawCode === undefined || rawCode === null) return null;
  const code = String(rawCode).trim();
  if (code === '' || Number(code) === 0) return null;

  return { code, message: readIdentifier(header.resultMessage) ?? readIdentifier(header.resultMsg) ?? '' };
}
