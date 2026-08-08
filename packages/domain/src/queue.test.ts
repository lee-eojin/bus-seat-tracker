import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  detectLiveClearing,
  estimateQueueAt,
  inferQueueClearing,
  selectQueueClearing,
  type QueueVehicle,
} from './queue.js';

const minute = 60_000;
const nowMs = Date.UTC(2026, 7, 5, 10, 0);

describe('detectLiveClearing', () => {
  it('바로 다음 정류장에 좌석을 남긴 차량이 있으면 현재 시각을 돌려준다', () => {
    const vehicles: QueueVehicle[] = [
      { stationSeq: 21, remainingSeats: 0 },
      { stationSeq: 21, remainingSeats: 1 },
    ];
    assert.equal(detectLiveClearing(vehicles, 20, nowMs), nowMs);
  });

  it('두 정류장 뒤 차량은 라이브 해소로 보지 않는다', () => {
    assert.equal(detectLiveClearing([{ stationSeq: 22, remainingSeats: 4 }], 20, nowMs), null);
  });
});

describe('inferQueueClearing', () => {
  it('2정류장 안 좌석은 해소 증거지만 3정류장 뒤 좌석은 하한 근거다', () => {
    assert.deepEqual(
      inferQueueClearing([{ stationSeq: 22, remainingSeats: 1 }], 20, nowMs),
      { at: nowMs - 4 * minute, lowerBound: false },
    );
    assert.deepEqual(
      inferQueueClearing([{ stationSeq: 23, remainingSeats: 1 }], 20, nowMs),
      { at: nowMs - 6 * minute, lowerBound: true },
    );
  });

  it('가까운 해소가 없으면 10정류장 안 가장 먼 차량으로 하한을 잡고 11정류장은 버린다', () => {
    assert.deepEqual(
      inferQueueClearing([
        { stationSeq: 24, remainingSeats: 0 },
        { stationSeq: 30, remainingSeats: null },
      ], 20, nowMs),
      { at: nowMs - 20 * minute, lowerBound: true },
    );
    assert.equal(inferQueueClearing([{ stationSeq: 31, remainingSeats: 8 }], 20, nowMs), null);
  });

  it('입력 순서와 배열 내용을 바꾸지 않고 가장 가까운 해소 증거를 고른다', () => {
    const vehicles: QueueVehicle[] = [
      { stationSeq: 22, remainingSeats: 6 },
      { stationSeq: 18, remainingSeats: 4 },
      { stationSeq: 21, remainingSeats: 2 },
    ];
    const before = structuredClone(vehicles);

    assert.deepEqual(
      inferQueueClearing(vehicles, 20, nowMs),
      { at: nowMs - 2 * minute, lowerBound: false },
    );
    assert.deepEqual(vehicles, before);
  });
});

describe('selectQueueClearing', () => {
  const inferred = { at: nowMs - 5 * minute, lowerBound: true };

  it('tracked가 더 최근이면 직접 관측을 쓴다', () => {
    assert.deepEqual(
      selectQueueClearing(nowMs - 3 * minute, inferred),
      { at: nowMs - 3 * minute, lowerBound: false },
    );
  });

  it('inferred가 더 최근이거나 동률이면 기존 화면처럼 inferred를 쓴다', () => {
    assert.equal(selectQueueClearing(nowMs - 7 * minute, inferred), inferred);
    assert.equal(selectQueueClearing(inferred.at, inferred), inferred);
  });
});

describe('estimateQueueAt', () => {
  it('경과 60분까지 추정하고 60분을 넘으면 추정하지 않는다', () => {
    assert.deepEqual(
      estimateQueueAt(1, nowMs, nowMs - 60 * minute, null, 0),
      { people: 60, elapsedMinutes: 60, rate: 1, lowerBound: false },
    );
    assert.equal(estimateQueueAt(1, nowMs, nowMs - 60 * minute - 1, null, 0), null);
  });

  it('호출자가 넘긴 해소 이후 탑승 인원을 뺀다', () => {
    assert.deepEqual(
      estimateQueueAt(2, nowMs, nowMs - 10 * minute, null, 7),
      { people: 13, elapsedMinutes: 10, rate: 2, lowerBound: false },
    );
  });
});
