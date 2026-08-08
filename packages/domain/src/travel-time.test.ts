import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  estimatedMinutesPerStop,
  estimatedTravelTimeMs,
  seoulBucketAt,
} from './travel-time.js';

describe('estimatedTravelTimeMs', () => {
  it('정류장당 2분으로 환산한다', () => {
    assert.equal(estimatedMinutesPerStop, 2);
    assert.equal(estimatedTravelTimeMs(0), 0);
    assert.equal(estimatedTravelTimeMs(3), 6 * 60_000);
  });
});

describe('seoulBucketAt', () => {
  it('서울 시각의 30분 버킷을 계산한다', () => {
    assert.deepEqual(seoulBucketAt(Date.UTC(2026, 7, 4, 21, 29)), { bucket: 12, weekend: false });
    assert.deepEqual(seoulBucketAt(Date.UTC(2026, 7, 4, 21, 30)), { bucket: 13, weekend: false });
  });

  it('UTC 날짜가 아니라 서울 날짜로 주말을 가른다', () => {
    assert.deepEqual(seoulBucketAt(Date.UTC(2026, 7, 7, 15, 0)), { bucket: 0, weekend: true });
  });
});
