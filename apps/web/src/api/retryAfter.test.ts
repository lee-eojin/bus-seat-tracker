import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { retryAfterMillisFrom } from './retryAfter.js';

const now = Date.UTC(2026, 8, 2, 3, 0, 0);

describe('retryAfterMillisFrom', () => {
  it('초 단위 정수는 그대로 환산한다', () => {
    assert.equal(retryAfterMillisFrom(new Headers({ 'retry-after': '120' }), now), 120_000);
  });

  it('초 단위는 기준 시각 없이도 읽는다 (기간 값이라 시계와 무관하다)', () => {
    assert.equal(retryAfterMillisFrom(new Headers({ 'retry-after': '30' }), null), 30_000);
  });

  it('HTTP 날짜는 기준 시각과의 차이로 환산한다', () => {
    const retryAt = new Date(now + 90_000).toUTCString();
    assert.equal(retryAfterMillisFrom(new Headers({ 'retry-after': retryAt }), now), 90_000);
  });

  it('기준 시각이 없으면 날짜 형식은 해석하지 않는다 (기기 시계를 안 쓴다)', () => {
    const retryAt = new Date(now + 90_000).toUTCString();
    assert.equal(retryAfterMillisFrom(new Headers({ 'retry-after': retryAt }), null), null);
  });

  it('이미 지난 시각은 0으로 접는다', () => {
    const retryAt = new Date(now - 60_000).toUTCString();
    assert.equal(retryAfterMillisFrom(new Headers({ 'retry-after': retryAt }), now), 0);
  });

  it('헤더가 없거나 해석되지 않으면 null이다', () => {
    assert.equal(retryAfterMillisFrom(new Headers({}), now), null);
    assert.equal(retryAfterMillisFrom(new Headers({ 'retry-after': 'soon' }), now), null);
  });
});
