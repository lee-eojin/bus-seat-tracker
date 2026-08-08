import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ProfileCell, ProfileRoute } from './model.js';
import { forecastVehicleStops } from './forecast.js';

function cell(mean: number, weight = 20): ProfileCell {
  return {
    weight,
    demandSum: mean * weight,
    demandSquaredSum: (mean * mean + 1) * weight,
    censoredWeight: 0,
  };
}

function profile(entries: Array<[sequence: number, bucket: number, mean: number]>): ProfileRoute {
  const weekday: ProfileRoute['weekday'] = {};
  for (const [sequence, bucket, mean] of entries) {
    const byBucket = weekday[String(sequence)] ?? {};
    byBucket[String(bucket)] = cell(mean);
    weekday[String(sequence)] = byBucket;
  }
  return { weekday, weekend: {}, depletion: { weekday: {}, weekend: {} } };
}

describe('forecastVehicleStops', () => {
  const forecastAt = Date.UTC(2026, 7, 4, 23, 29); // KST 08:29

  it('현재 정류장 수요부터 반영하고 정류장당 2분 뒤 버킷을 사용한다', () => {
    const forecasts = forecastVehicleStops({
      routeName: '3330',
      currentSequence: 1,
      remainingSeats: 50,
      stops: [
        { sequence: 1, name: '현재 정류장' },
        { sequence: 2, name: '첫 하류 정류장' },
        { sequence: 3, name: '둘째 하류 정류장' },
      ],
      profile: profile([
        [1, 16, 5],
        [2, 16, 0],
        [2, 17, 10],
        [3, 17, 0],
      ]),
      fullDepartureStreaks: {},
      forecastAt,
    });

    assert.equal(forecasts.length, 2);
    assert.ok(Math.abs(forecasts[0]!.arrivalMean - 45) < 0.1);
    assert.ok(Math.abs(forecasts[1]!.arrivalMean - 35) < 0.2);
    assert.deepEqual(forecasts.map((forecast) => forecast.horizon), [1, 2]);
  });

  it('미정차 지점도 수요는 전파하지만 승차 가능한 출력으로 표시하지 않는다', () => {
    const forecasts = forecastVehicleStops({
      routeName: '3330',
      currentSequence: 1,
      remainingSeats: 20,
      stops: [
        { sequence: 2, name: '고속도로(미정차)' },
        { sequence: 3, name: '승차 정류장' },
      ],
      profile: profile([
        [1, 16, 0],
        [2, 17, 4],
        [3, 17, 0],
      ]),
      fullDepartureStreaks: {},
      forecastAt,
    });

    assert.equal(forecasts[0]!.boardingAllowed, false);
    assert.equal(forecasts[1]!.boardingAllowed, true);
    assert.ok(forecasts[1]!.arrivalMean < forecasts[0]!.arrivalMean);
  });

  it('만석 연속의 알려짐 여부와 판정을 함께 돌려준다', () => {
    const forecasts = forecastVehicleStops({
      routeName: '3330',
      currentSequence: 1,
      remainingSeats: 40,
      stops: [{ sequence: 2, name: '정류장' }],
      profile: profile([[1, 16, 0], [2, 17, 0]]),
      fullDepartureStreaks: { 2: 1 },
      forecastAt,
    });

    assert.equal(forecasts[0]!.streakKnown, true);
    assert.equal(forecasts[0]!.verdict, 'tight');
    assert.ok(forecasts[0]!.seatAvailableProbability > 0.99);
  });

  it('음수 좌석 입력은 예보하지 않는다', () => {
    assert.deepEqual(forecastVehicleStops({
      routeName: '3330',
      currentSequence: 1,
      remainingSeats: -1,
      stops: [{ sequence: 2, name: '정류장' }],
      profile: profile([]),
      fullDepartureStreaks: {},
      forecastAt,
    }), []);
  });
});
