import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readUpstreamErrorEnvelope } from '../../../packages/domain/src/model.js';
import {
  classifyFailure,
  describeFailure,
  failureChain,
  readResultNotice,
  toSingleCause,
  UpstreamFailure,
} from './failure-kind.js';

function withCode(message: string, code: string): Error {
  const error = new Error(message);
  (error as Error & { code?: string }).code = code;
  return error;
}

describe('원인 체인 펼치기', () => {
  it('cause를 따라 바깥에서 안쪽 순서로 모은다', () => {
    const inner = withCode('Connect Timeout Error', 'UND_ERR_CONNECT_TIMEOUT');
    const outer = new TypeError('fetch failed', { cause: inner });
    assert.deepEqual(failureChain(outer).map((link) => link.message), ['fetch failed', 'Connect Timeout Error']);
  });

  it('AggregateError가 안고 있는 오류도 따라간다', () => {
    const aggregate = new AggregateError([withCode('첫째', 'ECONNRESET'), new Error('둘째')], '모두 실패');
    assert.deepEqual(failureChain(aggregate).map((link) => link.message), ['모두 실패', '첫째', '둘째']);
  });

  it('순환 참조에서 멈춘다', () => {
    const first = new Error('첫째');
    const second = new Error('둘째', { cause: first });
    (first as Error & { cause?: unknown }).cause = second;
    assert.equal(failureChain(first).length, 2);
  });

  it('Error가 아니면 빈 체인이다', () => {
    assert.deepEqual(failureChain('그냥 문자열'), []);
  });
});

describe('실패 설명', () => {
  it('감춰진 원인을 코드와 함께 한 줄로 남긴다', () => {
    const inner = withCode('Connect Timeout Error', 'UND_ERR_CONNECT_TIMEOUT');
    const outer = new TypeError('fetch failed', { cause: inner });
    assert.equal(
      describeFailure(outer),
      'fetch failed ← Connect Timeout Error (UND_ERR_CONNECT_TIMEOUT)',
    );
  });

  it('상류 코드도 괄호로 붙인다', () => {
    const failure = new UpstreamFailure('상류가 오류를 반환했습니다', { upstreamCode: 'SERVICE_KEY_IS_NOT_REGISTERED_ERROR' });
    assert.match(describeFailure(failure), /SERVICE_KEY_IS_NOT_REGISTERED_ERROR/);
  });

  it('Error가 아니어도 문자열은 낸다', () => {
    assert.equal(describeFailure('그냥 문자열'), '그냥 문자열');
  });
});

describe('실패 분류', () => {
  it('연결 타임아웃은 저절로 낫는다', () => {
    const outer = new TypeError('fetch failed', { cause: withCode('Connect Timeout Error', 'UND_ERR_CONNECT_TIMEOUT') });
    assert.equal(classifyFailure(outer), 'transient');
  });

  it('소켓 끊김도 저절로 낫는다', () => {
    assert.equal(classifyFailure(new TypeError('fetch failed', { cause: withCode('socket hang up', 'ECONNRESET') })), 'transient');
  });

  it('요청 예산 초과는 저절로 낫는다', () => {
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    assert.equal(classifyFailure(timeout), 'transient');
  });

  it('상류 5xx와 429는 저절로 낫는다', () => {
    assert.equal(classifyFailure(new UpstreamFailure('오류', { httpStatus: 503 })), 'transient');
    assert.equal(classifyFailure(new UpstreamFailure('오류', { httpStatus: 429 })), 'transient');
  });

  it('키가 등록되지 않았으면 사람이 손대야 한다', () => {
    const failure = new UpstreamFailure('오류', { upstreamCode: 'SERVICE_KEY_IS_NOT_REGISTERED_ERROR' });
    assert.equal(classifyFailure(failure), 'actionable');
  });

  it('한도 소진은 사람이 손대야 한다', () => {
    const failure = new UpstreamFailure('오류', { upstreamCode: 'LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR' });
    assert.equal(classifyFailure(failure), 'actionable');
  });

  it('401·403은 사람이 손대야 한다', () => {
    assert.equal(classifyFailure(new UpstreamFailure('오류', { httpStatus: 403 })), 'actionable');
  });

  it('모르는 실패는 사람이 손대야 하는 쪽으로 남긴다', () => {
    assert.equal(classifyFailure(new Error('처음 보는 오류')), 'actionable');
    assert.equal(classifyFailure(new UpstreamFailure('오류', { upstreamCode: '99' })), 'actionable');
  });

  it('자가 치유 신호와 조치 신호가 섞이면 조치 쪽이 이긴다', () => {
    const network = withCode('Connect Timeout Error', 'UND_ERR_CONNECT_TIMEOUT');
    const key = new UpstreamFailure('키 문제', { upstreamCode: 'SERVICE_KEY_IS_NOT_REGISTERED_ERROR', cause: network });
    assert.equal(classifyFailure(key), 'actionable');
  });
});

describe('상류 오류 봉투 읽기', () => {
  it('정상 응답은 null이다', () => {
    const payload = { response: { msgHeader: { resultCode: 0, resultMessage: '정상' }, msgBody: {} } };
    assert.equal(readUpstreamErrorEnvelope(payload), null);
  });

  it('GBIS 자체 결과 코드는 봉투가 아니므로 판정하지 않는다', () => {
    // 이 코드 체계는 포털 공통 코드표와 별개다. 명세상 4가 결과 없음이라 오류로 단정하면
    // 정상적인 무데이터 응답에서 수집이 죽는다.
    assert.equal(readUpstreamErrorEnvelope({ response: { msgHeader: { resultCode: 4, resultMessage: '결과가 없습니다.' } } }), null);
  });

  it('포털 오류 봉투에서 언어에 안 흔들리는 숫자 코드를 고른다', () => {
    // 실측 응답이다. returnAuthMsg가 국문으로 오므로 코드로 쓰면 분류가 언어에 묶인다.
    const payload = {
      OpenAPI_ServiceResponse: {
        cmmMsgHeader: { returnAuthMsg: '등록되지 않은 서비스키', returnReasonCode: '30', errMsg: 'SERVICE ERROR' },
      },
    };
    assert.deepEqual(readUpstreamErrorEnvelope(payload), { code: '30', message: '등록되지 않은 서비스키 SERVICE ERROR' });
  });

  it('국문 문구로 온 키 오류도 사람이 손대야 하는 쪽으로 분류된다', () => {
    const status = readUpstreamErrorEnvelope({
      OpenAPI_ServiceResponse: { cmmMsgHeader: { returnAuthMsg: '등록되지 않은 서비스키', returnReasonCode: '30' } },
    });
    const failure = new UpstreamFailure(`상류가 오류를 반환했습니다: ${status?.message}`, {
      httpStatus: 200,
      upstreamCode: status?.code ?? null,
    });
    assert.equal(classifyFailure(failure), 'actionable');
  });

  it('운행 차량이 없다는 응답은 오류가 아니다', () => {
    assert.equal(readUpstreamErrorEnvelope({ OpenAPI_ServiceResponse: { cmmMsgHeader: { returnAuthMsg: 'NODATA_ERROR' } } }), null);
    assert.equal(readUpstreamErrorEnvelope({ OpenAPI_ServiceResponse: { cmmMsgHeader: { returnReasonCode: '03', returnAuthMsg: '' } } }), null);
  });

  it('무데이터 판정을 부분 문자열로 넓게 잡지 않는다', () => {
    // '데이터'와 '없'을 포함한다는 이유로 진짜 오류를 삼키면, 막으려던 실패 형태가 그대로 남는다.
    const envelope = readUpstreamErrorEnvelope({
      OpenAPI_ServiceResponse: { cmmMsgHeader: { returnReasonCode: '22', returnAuthMsg: '요청한 데이터가 없습니다' } },
    });
    assert.equal(envelope?.code, '22');
  });

  it('봉투가 없으면 판단하지 않는다', () => {
    assert.equal(readUpstreamErrorEnvelope({ response: { msgBody: {} } }), null);
    assert.equal(readUpstreamErrorEnvelope(null), null);
  });
});

describe('포털 공통 오류 코드 분류', () => {
  const failureFor = (code: string) => new UpstreamFailure('상류가 오류를 반환했습니다', { httpStatus: 200, upstreamCode: code });

  it('01, 05, 23은 저절로 낫는다', () => {
    // 공식 오류표: 01 게이트웨이 내부 오류, 05 연결 실패와 응답 대기 초과, 23 초당 허용량 초과.
    for (const code of ['01', '05', '23']) {
      assert.equal(classifyFailure(failureFor(code)), 'transient', code);
    }
  });

  it('20, 22, 30, 31은 사람이 손대야 한다', () => {
    // 20 접근 권한 거부, 22 일일 허용량 초과, 30 미등록 키, 31 기한 만료.
    for (const code of ['20', '22', '30', '31']) {
      assert.equal(classifyFailure(failureFor(code)), 'actionable', code);
    }
  });
});

describe('여러 실패 묶기', () => {
  it('하나면 그대로 둔다', () => {
    const only = new Error('하나');
    assert.equal(toSingleCause([only], '요약'), only);
  });

  it('없으면 undefined다', () => {
    assert.equal(toSingleCause([], '요약'), undefined);
  });

  it('노선별 실패가 섞이면 조치 쪽이 이긴다', () => {
    // 첫 실패만 매달면 노선 순서 하나로 키 폐기가 경고로 강등된다.
    const network = new TypeError('fetch failed', { cause: withCode('Connect Timeout Error', 'UND_ERR_CONNECT_TIMEOUT') });
    const key = new UpstreamFailure('키 문제', { httpStatus: 403 });
    assert.equal(classifyFailure(toSingleCause([network, key], '노선 2개 수집 실패')), 'actionable');
    assert.equal(classifyFailure(toSingleCause([key, network], '노선 2개 수집 실패')), 'actionable');
  });

  it('묶은 실패의 설명에 모든 원인이 남는다', () => {
    const description = describeFailure(toSingleCause([new Error('3330 실패'), new Error('1650 실패')], '노선 2개 수집 실패'));
    assert.match(description, /3330 실패/);
    assert.match(description, /1650 실패/);
  });
});

describe('GBIS 결과 코드 기록', () => {
  it('0이 아닌 결과 코드를 기록용으로 돌려준다', () => {
    assert.deepEqual(
      readResultNotice({ response: { msgHeader: { resultCode: 4, resultMessage: '결과가 없습니다.' } } }),
      { code: '4', message: '결과가 없습니다.' },
    );
  });

  it('정상 코드와 헤더 없음은 null이다', () => {
    assert.equal(readResultNotice({ response: { msgHeader: { resultCode: 0 } } }), null);
    assert.equal(readResultNotice({ response: { msgHeader: { resultCode: '0' } } }), null);
    assert.equal(readResultNotice({ response: { msgBody: {} } }), null);
  });
});
