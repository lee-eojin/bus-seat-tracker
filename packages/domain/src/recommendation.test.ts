import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Direction, DisplayStop, HistoryBucket, HistoryRoute, LatestRoute } from './model.js';
import {
  historyBucketAt,
  nonFullObservationRate,
  recommendBoardingStop,
  wilson95Interval,
  type RecommendationRequest,
} from './recommendation.js';

const currentBucket = 16;

function stop(sequence: number, name: string, direction: Direction = 'up'): DisplayStop {
  return {
    sequence,
    name,
    direction,
    isTurn: false,
    latitude: null,
    longitude: null,
  };
}

function latestRoute(stops: DisplayStop[]): LatestRoute {
  return {
    route: {
      id: 'route-1',
      name: 'G5100',
      type: null,
      startStationName: null,
      endStationName: null,
    },
    collectedAt: null,
    turnSequence: 50,
    stops,
    vehicles: [],
    fullDepartureStreaks: {},
  };
}

function historyRoute(
  weekday: Array<[sequence: number, cell: HistoryBucket]>,
  weekend: Array<[sequence: number, cell: HistoryBucket]> = [],
): HistoryRoute {
  return {
    weekday: Object.fromEntries(weekday.map(([sequence, cell]) => [String(sequence), { [currentBucket]: cell }])),
    weekend: Object.fromEntries(weekend.map(([sequence, cell]) => [String(sequence), { [currentBucket]: cell }])),
  };
}

function request(history: HistoryRoute | null, stops = [stop(1, '첫 정류장'), stop(2, '둘째 정류장'), stop(3, '내 정류장')]): RecommendationRequest {
  return {
    route: latestRoute(stops),
    history,
    selectedStop: { routeName: 'G5100', sequence: 3 },
    direction: 'up',
    bucket: currentBucket,
    weekend: false,
  };
}

describe('관측 비율', () => {
  it('만석이 아닌 관측 비율을 확률처럼 부풀리지 않고 그대로 계산한다', () => {
    assert.equal(nonFullObservationRate({ samples: 10, zeroCount: 2 }), 0.8);
  });

  it('Wilson 95% 구간을 계산한다', () => {
    const interval = wilson95Interval(5, 10);
    assert.ok(Math.abs(interval.low - 0.2366) < 0.0001);
    assert.ok(Math.abs(interval.high - 0.7634) < 0.0001);
    assert.deepEqual(wilson95Interval(0, 0), { low: 0, high: 1 });
  });

  it('호출자가 고른 평일/주말과 30분 버킷을 사용한다', () => {
    const weekdayCell = { samples: 10, zeroCount: 1 };
    const weekendCell = { samples: 20, zeroCount: 8 };
    const history = historyRoute([[3, weekdayCell]], [[3, weekendCell]]);

    assert.equal(historyBucketAt(history, 3, currentBucket, false), weekdayCell);
    assert.equal(historyBucketAt(history, 3, currentBucket, true), weekendCell);
    assert.equal(historyBucketAt(history, 3, currentBucket + 1, false), null);
  });
});

describe('승차 정류장 추천', () => {
  it('선택 전에는 unset, 다른 노선이나 방향의 선택은 elsewhere다', () => {
    const base = request(null);
    assert.deepEqual(recommendBoardingStop({ ...base, selectedStop: null }), { kind: 'unset' });
    assert.deepEqual(
      recommendBoardingStop({ ...base, selectedStop: { routeName: 'M5107', sequence: 3 } }),
      { kind: 'elsewhere' },
    );
    assert.deepEqual(recommendBoardingStop({ ...base, direction: 'down' }), { kind: 'elsewhere' });
  });

  it('표본 9개는 부족하고 10개부터 판단한다', () => {
    const nineSamples = historyRoute([[3, { samples: 9, zeroCount: 0 }]]);
    assert.deepEqual(recommendBoardingStop(request(nineSamples)), { kind: 'insufficient', samples: 9 });

    const tenSamples = historyRoute([[3, { samples: 10, zeroCount: 0 }]]);
    assert.deepEqual(recommendBoardingStop(request(tenSamples)), {
      kind: 'stay',
      cell: { samples: 10, zeroCount: 0 },
    });
  });

  it('내 정류장 만석 비율 0.5부터 이동 후보를 찾는다', () => {
    const history = historyRoute([
      [2, { samples: 10, zeroCount: 2 }],
      [3, { samples: 10, zeroCount: 5 }],
    ]);

    const recommendation = recommendBoardingStop(request(history));
    assert.equal(recommendation.kind, 'move');
    if (recommendation.kind !== 'move') return;
    assert.equal(recommendation.target.sequence, 2);
  });

  it('후보 만석 비율 0.25는 제외한다', () => {
    const history = historyRoute([
      [1, { samples: 10, zeroCount: 2 }],
      [2, { samples: 20, zeroCount: 5 }],
      [3, { samples: 10, zeroCount: 5 }],
    ]);

    const recommendation = recommendBoardingStop(request(history));
    assert.equal(recommendation.kind, 'move');
    if (recommendation.kind !== 'move') return;
    assert.equal(recommendation.target.sequence, 1);
    assert.equal(recommendation.hops, 2);
  });

  it('미정차 정류장은 조건을 만족해도 건너뛴다', () => {
    const stops = [stop(1, '첫 정류장'), stop(2, '고속도로(미정차)'), stop(3, '내 정류장')];
    const history = historyRoute([
      [1, { samples: 10, zeroCount: 1 }],
      [2, { samples: 10, zeroCount: 0 }],
      [3, { samples: 10, zeroCount: 6 }],
    ]);

    const recommendation = recommendBoardingStop(request(history, stops));
    assert.equal(recommendation.kind, 'move');
    if (recommendation.kind !== 'move') return;
    assert.equal(recommendation.target.sequence, 1);
  });

  it('조건을 만족하는 같은 방향의 가장 가까운 상류 정류장을 고른다', () => {
    const stops = [
      stop(1, '먼 정류장'),
      stop(2, '반대 방향 정류장', 'down'),
      stop(3, '가까운 정류장'),
      stop(4, '내 정류장'),
    ];
    const history = historyRoute([
      [1, { samples: 10, zeroCount: 0 }],
      [2, { samples: 10, zeroCount: 0 }],
      [3, { samples: 10, zeroCount: 2 }],
      [4, { samples: 10, zeroCount: 7 }],
    ]);
    const recommendation = recommendBoardingStop({
      ...request(history, stops),
      selectedStop: { routeName: 'G5100', sequence: 4 },
    });

    assert.equal(recommendation.kind, 'move');
    if (recommendation.kind !== 'move') return;
    assert.equal(recommendation.target.sequence, 3);
    assert.equal(recommendation.hops, 1);
  });

  it('충분한 이동 후보가 없으면 no-candidate다', () => {
    const history = historyRoute([
      [1, { samples: 10, zeroCount: 3 }],
      [2, { samples: 9, zeroCount: 0 }],
      [3, { samples: 10, zeroCount: 8 }],
    ]);

    assert.deepEqual(recommendBoardingStop(request(history)), {
      kind: 'no-candidate',
      cell: { samples: 10, zeroCount: 8 },
    });
  });
});
