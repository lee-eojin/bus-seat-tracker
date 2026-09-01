import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { referenceClockFrom } from './referenceClock.js';

const servedAt = Date.UTC(2026, 8, 2, 3, 0, 0);

describe('referenceClockFrom', () => {
  it('Date 헤더를 기준 시각으로 삼는다', () => {
    const clock = referenceClockFrom(new Headers({ date: new Date(servedAt).toUTCString() }), () => 0);
    assert.equal(clock?.servedAt, servedAt);
  });

  it('캐시를 거친 응답은 Age만큼 뒤가 진짜 지금이다', () => {
    const headers = new Headers({ date: new Date(servedAt).toUTCString(), age: '90' });
    const clock = referenceClockFrom(headers, () => 0);
    assert.equal(clock?.servedAt, servedAt + 90_000);
  });

  it('경과는 벽시계가 아니라 단조 시계로 잰다 (기기 시계를 바꿔도 안 흔들린다)', () => {
    let elapsed = 0;
    const clock = referenceClockFrom(new Headers({ date: new Date(servedAt).toUTCString() }), () => elapsed);
    assert.equal(clock?.now(), servedAt);

    elapsed = 5_000;
    assert.equal(clock?.now(), servedAt + 5_000, '5초가 지나면 기준 시각도 5초 뒤다');

    elapsed = 305_000;
    assert.equal(clock?.now(), servedAt + 305_000);
  });

  it('Date가 없거나 해석되지 않으면 시계를 안 만든다', () => {
    assert.equal(referenceClockFrom(new Headers({})), null);
    assert.equal(referenceClockFrom(new Headers({ date: 'not-a-date' })), null);
  });
});
