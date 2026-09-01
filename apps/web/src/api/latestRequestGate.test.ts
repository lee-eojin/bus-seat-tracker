import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLatestRequestGate } from './latestRequestGate.js';

describe('createLatestRequestGate', () => {
  it('새 티켓이 앞 티켓을 끊고 최신 자리를 가져간다', () => {
    const gate = createLatestRequestGate();
    const first = gate.issue();
    assert.equal(first.isLatest(), true);

    const second = gate.issue();
    assert.equal(first.signal.aborted, true, '앞 요청이 끊겨야 한다');
    assert.equal(first.isLatest(), false, '앞 응답은 화면에 반영되면 안 된다');
    assert.equal(second.isLatest(), true);
  });

  it('닫으면 진행 중 요청이 끊기고 최신이 사라진다', () => {
    const gate = createLatestRequestGate();
    const ticket = gate.issue();
    gate.close();
    assert.equal(ticket.signal.aborted, true);
    assert.equal(ticket.isLatest(), false);
  });

  it('티켓 스스로 끊어도 최신 자리는 유지된다 (다음 예약을 이 티켓이 책임진다)', () => {
    const gate = createLatestRequestGate();
    const ticket = gate.issue();
    ticket.abort();
    assert.equal(ticket.signal.aborted, true);
    assert.equal(ticket.isLatest(), true);
  });
});
