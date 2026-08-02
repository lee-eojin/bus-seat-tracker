import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  gapToleranceMs,
  latestObservationAt,
  publishFreshnessAllowanceMs,
  staleBasisAt,
} from './score-predictions.js';

// 2026-07-27이 월요일이다. KST 기준 시각을 UTC ms로 바꿔 넣는다.
const kstOffsetMs = 9 * 3600 * 1000;
const dayOffsets = { 월: 0, 화: 1, 수: 2, 목: 3, 금: 4, 토: 5, 일: 6 } as const;

function kst(day: keyof typeof dayOffsets, hour: number, minute = 0): number {
  return Date.UTC(2026, 6, 27 + dayOffsets[day], hour, minute) - kstOffsetMs;
}

const MINUTE = 60_000;

describe('latestObservationAt', () => {
  const times = [kst('월', 7, 0), kst('월', 7, 10), kst('월', 7, 20)];

  it('빈 배열이면 null이다', () => {
    assert.equal(latestObservationAt([], kst('월', 12)), null);
  });

  it('전부 미래 관측이면 null이다', () => {
    assert.equal(latestObservationAt(times, kst('월', 6, 59)), null);
  });

  it('기준 시각과 같은 관측은 포함한다', () => {
    assert.equal(latestObservationAt(times, kst('월', 7, 10)), kst('월', 7, 10));
  });

  it('사이 시각이면 직전 관측을 준다', () => {
    assert.equal(latestObservationAt(times, kst('월', 7, 15)), kst('월', 7, 10));
  });

  it('전부 과거면 마지막 관측을 준다', () => {
    assert.equal(latestObservationAt(times, kst('월', 23, 0)), kst('월', 7, 20));
  });
});

describe('gapToleranceMs', () => {
  it('조밀 창 안 구간은 간격 60초 기준으로 17분이다', () => {
    assert.equal(gapToleranceMs(kst('월', 7, 10), kst('월', 7, 20)), 17 * MINUTE);
  });

  it('낮 창 구간은 간격 20분 기준으로 55분이다', () => {
    assert.equal(gapToleranceMs(kst('월', 12, 50), kst('월', 13, 30)), 55 * MINUTE);
  });

  it('심야를 가로지르는 구간은 낀 매시 1회 시대가 기준이 되어 135분이다', () => {
    assert.equal(gapToleranceMs(kst('월', 21, 4), kst('화', 5, 19)), 135 * MINUTE);
  });

  it('전 구간이 운행 시간 밖이면 null이다', () => {
    assert.equal(gapToleranceMs(kst('월', 23, 0), kst('화', 4, 0)), null);
  });

  it('주말은 매시 1회 기준으로 135분이다', () => {
    assert.equal(gapToleranceMs(kst('토', 12, 0), kst('토', 13, 0)), 135 * MINUTE);
  });
});

describe('staleBasisAt', () => {
  it('운행 시간 밖 발행은 묻지 않는다', () => {
    const basis = kst('월', 20, 21);
    assert.equal(staleBasisAt(kst('화', 1, 0), basis, basis + 3 * 3600 * 1000), false);
  });

  it('최신 관측이 근거와 같으면 정상이다', () => {
    const basis = kst('월', 10, 0);
    assert.equal(staleBasisAt(kst('월', 10, 17), basis, basis), false);
  });

  it('허용치 경계까지는 정상, 넘으면 낡은 근거다', () => {
    const basis = kst('월', 10, 0);
    const published = kst('월', 10, 47);
    assert.equal(staleBasisAt(published, basis, basis + publishFreshnessAllowanceMs), false);
    assert.equal(staleBasisAt(published, basis, basis + publishFreshnessAllowanceMs + MINUTE), true);
  });

  it('최신 관측을 모르면 판정하지 않는다', () => {
    assert.equal(staleBasisAt(kst('월', 10, 17), kst('월', 9, 0), null), false);
  });
});
