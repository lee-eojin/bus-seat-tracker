import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  activeWindow,
  calibrationIntervalSeconds,
  daytimeIntervalSeconds,
  denseIntervalSeconds,
  expectedSnapshotGapSeconds,
  offWindowSnapshotGapSeconds,
  peakIntervalSeconds,
  scheduledIntervalSeconds,
  serviceElapsedMs,
  weekdayWindows,
  windowHandoverMinutes,
  windowsFor,
  withinServiceHours,
} from './schedule.js';

// 2026-07-27이 월요일이다. KST 기준 시각을 UTC ms로 바꿔 넣는다.
const kstOffsetMs = 9 * 3600 * 1000;
const dayOffsets = { 월: 0, 화: 1, 수: 2, 목: 3, 금: 4, 토: 5, 일: 6 } as const;

function kst(day: keyof typeof dayOffsets, hour: number, minute = 0): number {
  return Date.UTC(2026, 6, 27 + dayOffsets[day], hour, minute) - kstOffsetMs;
}

describe('창 정의', () => {
  it('start 오름차순이고 창끼리 겹치지 않는다', () => {
    for (let index = 1; index < weekdayWindows.length; index += 1) {
      const previous = weekdayWindows[index - 1]!;
      const current = weekdayWindows[index]!;
      assert.ok(previous.start < current.start, `${index}번 창의 start가 앞 창보다 앞선다`);
      assert.ok(previous.end <= current.start, `${index}번 창이 앞 창과 겹친다`);
    }
  });

  it('조밀 구간은 자기 창 안에 있다', () => {
    for (const window of weekdayWindows) {
      if (window.denseStart === undefined) continue;
      assert.ok(window.denseStart >= window.start);
      assert.ok(window.denseEnd! <= window.end);
      assert.ok(window.denseInterval! < window.interval, '조밀 구간이 기본 간격보다 촘촘해야 한다');
    }
  });

  it('주말에는 창이 없다', () => {
    assert.deepEqual(windowsFor(kst('토', 8)), []);
    assert.deepEqual(windowsFor(kst('일', 18)), []);
  });
});

describe('activeWindow 인수 경계', () => {
  it('창 시작 60분 전부터 인수한다', () => {
    const morningStart = weekdayWindows[0]!.start;
    const justBefore = kst('화', 0, morningStart - windowHandoverMinutes - 1);
    const atHandover = kst('화', 0, morningStart - windowHandoverMinutes);
    assert.equal(activeWindow(justBefore), null);
    assert.notEqual(activeWindow(atHandover), null);
  });

  it('창 끝나는 분에는 그 창을 잡지 않는다', () => {
    // 아침 창 끝(600)과 낮 창 시작(600)이 맞닿아 있어 낮 창으로 넘어간다
    const handed = activeWindow(kst('화', 10, 0));
    assert.notEqual(handed, null);
    assert.equal((handed!.endMs - handed!.startMs) / 60_000, weekdayWindows[1]!.end - weekdayWindows[1]!.start);
  });

  it('창 밖 시각은 null이다', () => {
    assert.equal(activeWindow(kst('화', 4)), null);
    assert.equal(activeWindow(kst('화', 23)), null);
  });

  it('경계가 맞닿으면 앞 창이 먼저 잡힌다', () => {
    // 09:00은 아침 창(390~600) 안이면서 낮 창(600~960)의 인수 범위(540~)에도 든다
    const window = activeWindow(kst('화', 9));
    assert.equal((window!.startMs - kst('화', 0)) / 60_000, weekdayWindows[0]!.start);
  });
});

describe('scheduledIntervalSeconds', () => {
  it('창 밖에서는 기본 피크 간격을 돌려준다', () => {
    assert.equal(scheduledIntervalSeconds(kst('화', 3)), peakIntervalSeconds);
    assert.equal(scheduledIntervalSeconds(kst('토', 12)), peakIntervalSeconds);
  });

  it('아침 조밀 구간은 60초, 그 밖은 600초', () => {
    assert.equal(scheduledIntervalSeconds(kst('화', 6, 45)), 600);
    assert.equal(scheduledIntervalSeconds(kst('화', 7, 0)), 60);
    assert.equal(scheduledIntervalSeconds(kst('화', 8, 59)), 60);
    assert.equal(scheduledIntervalSeconds(kst('화', 9, 0)), 600);
  });

  it('낮 창은 20분', () => {
    assert.equal(scheduledIntervalSeconds(kst('화', 11)), 1200);
  });

  it('낮 보정 구간은 수요일에만 2분이다', () => {
    assert.equal(scheduledIntervalSeconds(kst('수', 13, 0)), 120);
    assert.equal(scheduledIntervalSeconds(kst('수', 13, 29)), 120);
    assert.equal(scheduledIntervalSeconds(kst('수', 13, 30)), 1200);
    for (const day of ['월', '화', '목', '금'] as const) {
      assert.equal(scheduledIntervalSeconds(kst(day, 13, 10)), 1200, `${day}요일에는 보정 구간이 없어야 한다`);
    }
  });

  it('저녁 조밀 구간 경계', () => {
    assert.equal(scheduledIntervalSeconds(kst('화', 17, 59)), 600);
    assert.equal(scheduledIntervalSeconds(kst('화', 18, 0)), 60);
    assert.equal(scheduledIntervalSeconds(kst('화', 19, 29)), 60);
    assert.equal(scheduledIntervalSeconds(kst('화', 19, 30)), 600);
  });
});

describe('withinServiceHours', () => {
  it('평일은 05:00부터 22:00 직전까지', () => {
    assert.equal(withinServiceHours(kst('화', 4, 59)), false);
    assert.equal(withinServiceHours(kst('화', 5, 0)), true);
    assert.equal(withinServiceHours(kst('화', 21, 59)), true);
    assert.equal(withinServiceHours(kst('화', 22, 0)), false);
  });

  it('주말은 06:00부터 자정까지', () => {
    assert.equal(withinServiceHours(kst('토', 5, 59)), false);
    assert.equal(withinServiceHours(kst('토', 6, 0)), true);
    assert.equal(withinServiceHours(kst('일', 23, 59)), true);
  });
});

describe('KST 변환', () => {
  it('UTC 자정을 넘는 시각도 같은 KST 날짜로 센다', () => {
    // KST 화요일 06:30은 UTC 월요일 21:30이다. 요일을 UTC로 재면 창을 놓친다.
    const startup = kst('화', 6, 30);
    assert.equal(new Date(startup).getUTCDay(), 1, '전제 확인: UTC로는 월요일');
    assert.notEqual(activeWindow(startup), null);
  });

  it('일요일 심야는 주말로 센다', () => {
    assert.deepEqual(windowsFor(kst('일', 23, 30)), []);
  });
});

describe('expectedSnapshotGapSeconds', () => {
  it('창 안에서는 그 구간의 수집 간격이다', () => {
    assert.equal(expectedSnapshotGapSeconds(kst('월', 7, 30)), denseIntervalSeconds);
    assert.equal(expectedSnapshotGapSeconds(kst('월', 6, 40)), peakIntervalSeconds);
    assert.equal(expectedSnapshotGapSeconds(kst('월', 11, 0)), daytimeIntervalSeconds);
    assert.equal(expectedSnapshotGapSeconds(kst('월', 18, 30)), denseIntervalSeconds);
  });

  it('창 밖 운행 시간대는 매시 1회 간격이다', () => {
    assert.equal(expectedSnapshotGapSeconds(kst('월', 5, 30)), offWindowSnapshotGapSeconds);
    assert.equal(expectedSnapshotGapSeconds(kst('월', 21, 0)), offWindowSnapshotGapSeconds);
    assert.equal(expectedSnapshotGapSeconds(kst('토', 12, 0)), offWindowSnapshotGapSeconds);
  });

  it('운행 시간 밖은 null이다 — 수집이 없어 신선도를 따질 수 없다', () => {
    assert.equal(expectedSnapshotGapSeconds(kst('월', 4, 59)), null);
    assert.equal(expectedSnapshotGapSeconds(kst('월', 22, 0)), null);
    assert.equal(expectedSnapshotGapSeconds(kst('토', 5, 59)), null);
  });

  it('scheduledIntervalSeconds와 달리 창 밖에서 피크 간격으로 좁히지 않는다', () => {
    const offWindow = kst('월', 21, 0);
    assert.equal(scheduledIntervalSeconds(offWindow), peakIntervalSeconds);
    assert.equal(expectedSnapshotGapSeconds(offWindow), offWindowSnapshotGapSeconds);
  });

  it('수요일 낮 보정 구간은 2분, 다른 요일 같은 시각은 20분이다', () => {
    assert.equal(expectedSnapshotGapSeconds(kst('수', 13, 10)), calibrationIntervalSeconds);
    assert.equal(expectedSnapshotGapSeconds(kst('목', 13, 10)), daytimeIntervalSeconds);
  });
});

describe('serviceElapsedMs', () => {
  it('운행 시간 안에서는 벽시계 경과와 같다', () => {
    assert.equal(serviceElapsedMs(kst('월', 8, 0), kst('월', 8, 40)), 40 * 60_000);
  });

  it('평일 심야 공백은 세지 않는다 — 전날 21:04 근거의 새벽 05:19 발행은 75분이다', () => {
    assert.equal(serviceElapsedMs(kst('월', 21, 4), kst('화', 5, 19)), 75 * 60_000);
  });

  it('금요일 저녁에서 토요일 아침으로 넘어가면 주말 운행 시작(06:00)부터 다시 센다', () => {
    assert.equal(serviceElapsedMs(kst('금', 21, 0), kst('토', 6, 30)), 90 * 60_000);
  });

  it('전 구간이 운행 시간 밖이면 0이다', () => {
    assert.equal(serviceElapsedMs(kst('월', 23, 0), kst('화', 4, 0)), 0);
  });

  it('역전된 구간은 0이다', () => {
    assert.equal(serviceElapsedMs(kst('월', 9, 0), kst('월', 8, 0)), 0);
  });
});
