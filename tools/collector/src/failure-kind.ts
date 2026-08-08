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


export type FailureKind = 'transient' | 'actionable';

/** 수집기가 자가 치유되는 실패로 끝날 때 쓰는 종료 코드. 워크플로가 이 값으로 경고와 실패를 가른다. */
export const transientExitCode = 10;

/** 상류 코드가 어느 표에서 왔는지. 두 체계는 숫자가 겹치므로 섞어 읽으면 안 된다. */
export type CodeSpace = 'portal' | 'gbis';

interface UpstreamFailureOptions extends ErrorOptions {
  httpStatus?: number | null;
  upstreamCode?: string | null;
  codeSpace?: CodeSpace;
}

/** 상류(GBIS) 호출이 만든 실패. httpStatus가 null이면 응답 자체를 받지 못한 것이다. */
export class UpstreamFailure extends Error {
  readonly httpStatus: number | null;
  readonly upstreamCode: string | null;
  readonly codeSpace: CodeSpace;

  constructor(message: string, options: UpstreamFailureOptions = {}) {
    super(message, options);
    this.name = 'UpstreamFailure';
    this.httpStatus = options.httpStatus ?? null;
    this.upstreamCode = options.upstreamCode ?? null;
    this.codeSpace = options.codeSpace ?? 'portal';
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
// 01 게이트웨이 내부 오류, 05 연결 실패와 응답 대기 초과, 23 초당 호출 허용량 초과.
// 22(일일 호출 허용량)는 자정까지 안 낫고 구속 제약을 건드렸다는 설계 신호라 여기 없다.
const transientPortalCodes = new Set(['01', '05', '23']);

// GBIS 자체 코드표에서 저절로 낫는 코드. 1은 상류 내부 시스템 오류라 다음 사이클에 다시 해본다.
// 2(필수 파라미터 누락)는 우리 요청이 틀렸다는 뜻이라 사람이 봐야 한다.
const transientGbisCodes = new Set(['1']);

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

/** cause만 따라간다. AggregateError의 형제는 펼치지 않는다. */
function causeChain(error: unknown): Error[] {
  const chain: Error[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = current.cause;
  }
  return chain;
}

/**
 * 화이트리스트에 걸리는 것만 transient다. 모르는 실패는 전부 actionable로 남긴다.
 *
 * 껍데기와 형제를 다르게 본다. cause 체인의 바깥 오류는 문맥을 붙이는 껍데기라
 * ("수집할 노선을 하나도 확인하지 못했습니다") 그 자체로는 신호가 아니고, 안쪽 원인이 판정한다.
 * 반면 AggregateError의 형제는 각각 독립된 실패라 하나라도 사람이 손대야 하면 그쪽이 이긴다.
 * 노선 하나가 연결 타임아웃이고 다른 하나가 진짜 문제일 때 순서로 판정이 갈리면 안 된다.
 */
export function classifyFailure(error: unknown): FailureKind {
  let transient = false;

  for (const link of causeChain(error)) {
    if (link instanceof AggregateError && link.errors.length > 0) {
      if (link.errors.some((branch) => classifyFailure(branch) === 'actionable')) return 'actionable';
      transient = true;
      continue;
    }
    if (link instanceof UpstreamFailure) {
      // 코드는 숫자일 수 있고 사람이 읽을 문구는 메시지에 있다. 둘 다 본다.
      const haystack = `${link.upstreamCode ?? ''} ${link.message}`.toUpperCase();
      if (actionableUpstreamMarkers.some((marker) => haystack.includes(marker.toUpperCase()))) return 'actionable';
      if (link.httpStatus === 401 || link.httpStatus === 403) return 'actionable';
      const transientCodes = link.codeSpace === 'gbis' ? transientGbisCodes : transientPortalCodes;
      if (link.upstreamCode !== null && transientCodes.has(link.upstreamCode)) transient = true;
      if (link.httpStatus === 429 || (link.httpStatus !== null && link.httpStatus >= 500)) transient = true;
      continue;
    }
    const code = errorCode(link);
    if (code && transientErrorCodes.has(code)) transient = true;
    if (transientErrorNames.has(link.name)) transient = true;
  }

  return transient ? 'transient' : 'actionable';
}
