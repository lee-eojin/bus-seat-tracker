import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cacheLifetimeFrom, remainingFreshSecondsFrom } from './cacheControl.js';

function headersOf(entries: Record<string, string>): Headers {
  return new Headers(entries);
}

describe('cacheLifetimeFrom', () => {
  it('max-age와 Age를 읽는다', () => {
    const lifetime = cacheLifetimeFrom(headersOf({ 'cache-control': 'public, max-age=20', age: '7' }));
    assert.deepEqual(lifetime, { noStore: false, maxAgeSeconds: 20, ageSeconds: 7 });
  });

  it('max-age가 없으면 s-maxage를 쓴다 (이 저장소의 /api/live가 그 형태다)', () => {
    const lifetime = cacheLifetimeFrom(
      headersOf({ 'cache-control': 'public, s-maxage=120, stale-while-revalidate=240', age: '30' }),
    );
    assert.equal(lifetime.maxAgeSeconds, 120);
    assert.equal(lifetime.ageSeconds, 30);
  });

  it('둘 다 있으면 max-age가 이긴다', () => {
    const lifetime = cacheLifetimeFrom(headersOf({ 'cache-control': 'max-age=15, s-maxage=120' }));
    assert.equal(lifetime.maxAgeSeconds, 15);
  });

  it('no-store를 알아본다', () => {
    assert.equal(cacheLifetimeFrom(headersOf({ 'cache-control': 'no-store' })).noStore, true);
  });

  it('헤더가 없으면 수명을 모르는 것으로 둔다', () => {
    assert.deepEqual(cacheLifetimeFrom(headersOf({})), { noStore: false, maxAgeSeconds: null, ageSeconds: 0 });
  });

  it('Age가 정수가 아니면 0으로 본다', () => {
    assert.equal(cacheLifetimeFrom(headersOf({ age: '3.5' })).ageSeconds, 0);
  });
});

describe('remainingFreshSecondsFrom', () => {
  it('남은 수명은 음수로 내려가지 않는다', () => {
    assert.equal(remainingFreshSecondsFrom(headersOf({ 'cache-control': 'max-age=20', age: '99' })), 0);
  });

  it('수명을 안 밝힌 응답은 null이다', () => {
    assert.equal(remainingFreshSecondsFrom(headersOf({ 'cache-control': 'no-store' })), null);
    assert.equal(remainingFreshSecondsFrom(headersOf({})), null);
  });
});
