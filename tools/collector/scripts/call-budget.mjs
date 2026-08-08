// 호출 예산 계산기. `npm run budget`
//
// 일 한도 1,000회가 이 서비스의 구속 제약이다(CLAUDE.md). 예산 표를 손으로 세다가
// 실제와 어긋난 적이 있어 스케줄 정의에서 직접 계산한다. 수집 창을 바꾸면 이걸 돌려
// docs/operations/deployment.md의 호출 예산 표를 갱신한다.
//
// 사이클 수는 창을 끝까지 돈다고 본 이론 최대치다. 남은 스냅샷으로 역산하면 적게
// 나오는데, 사이클이 GBIS를 먼저 때리고 그다음 업로드하므로 업로드가 실패해도 호출은
// 이미 나간 뒤다. 예산은 남은 데이터가 아니라 이 이론값으로 잡는다.

import { activeWindow, scheduledIntervalSeconds, withinServiceHours } from '../../../dist/tools/collector/src/schedule.js';

const routeCount = 2;
const dailyLimit = 1000;

// api/live.ts의 캐시 TTL과 출퇴근 노출 시간
const liveCacheSeconds = 120;
const liveExposureHours = 6.5;

// 워크플로 크론 (KST 분). 매시 시동에 아침과 저녁 시동을 더한다.
const hourlyCronMinutes = Array.from({ length: 24 }, (_, hour) => hour * 60);
const weekdayStartupCronMinutes = [390, 1050];

// concurrency group이 하나고 cancel-in-progress가 false다. 실행 중이면 새 실행은
// 대기하고, 대기 자리는 하나뿐이라 뒤에 온 것이 앞의 대기를 밀어낸다.
function simulateDay(dayStartMs, isWeekday) {
  const cronMinutes = [...hourlyCronMinutes, ...(isWeekday ? weekdayStartupCronMinutes : [])].sort((a, b) => a - b);
  const runs = [];
  let busyUntilMinute = -1;
  let pendingMinute = null;

  function run(atMinute) {
    const atMs = dayStartMs + atMinute * 60_000;
    const window = activeWindow(atMs);
    if (!window) {
      busyUntilMinute = atMinute;
      if (!withinServiceHours(atMs)) return;
      runs.push({ atMinute, label: '스냅샷', cycles: 1 });
      return;
    }
    const startMinute = (window.startMs - dayStartMs) / 60_000;
    const endMinute = (window.endMs - dayStartMs) / 60_000;
    let cycles = 0;
    let minute = atMinute;
    // do-while이 수집을 먼저 하고 그다음 창 시작까지 잠든다. 창을 미리 인수한 실행은
    // 창 밖에서 한 번 더 태운다.
    if (minute < startMinute) {
      cycles += 1;
      minute = startMinute;
    }
    while (minute < endMinute) {
      cycles += 1;
      const step = scheduledIntervalSeconds(dayStartMs + minute * 60_000) / 60;
      if (minute + step >= endMinute) break;
      minute += step;
    }
    runs.push({ atMinute, label: `창 ${startMinute}-${endMinute}`, cycles });
    busyUntilMinute = endMinute;
  }

  for (const cronMinute of cronMinutes) {
    if (pendingMinute !== null && busyUntilMinute <= cronMinute) {
      const released = Math.max(pendingMinute, busyUntilMinute);
      pendingMinute = null;
      run(released);
    }
    if (cronMinute <= busyUntilMinute) {
      pendingMinute = cronMinute;
      continue;
    }
    run(cronMinute);
  }
  if (pendingMinute !== null) run(Math.max(pendingMinute, busyUntilMinute));

  const cycles = runs.reduce((sum, entry) => sum + entry.cycles, 0);
  return { runs, cycles, calls: cycles * routeCount };
}

// KST 자정을 UTC ms로. 2026-07-27이 월요일이라 여기서 요일을 센다.
const mondayUtcMs = Date.UTC(2026, 6, 27) - 9 * 3600 * 1000;
const dayNames = ['월요일', '화요일', '수요일', '목요일', '금요일', '토요일', '일요일'];

const days = dayNames.map((name, offset) => ({
  name,
  isWeekday: offset < 5,
  ...simulateDay(mondayUtcMs + offset * 24 * 3600 * 1000, offset < 5),
}));

const liveCalls = Math.round((liveExposureHours * 3600) / liveCacheSeconds) * routeCount;

console.log(`노선 ${routeCount}개, 일 한도 ${dailyLimit.toLocaleString()}회\n`);
console.log('| 요일 | 사이클 | 수집 호출 | /api/live | 합계 | 여유 |');
console.log('|---|---|---|---|---|---|');
for (const day of days) {
  const total = day.calls + liveCalls;
  console.log(`| ${day.name} | ${day.cycles} | ${day.calls} | ${liveCalls} | ${total} | ${dailyLimit - total} |`);
}

const worst = days.reduce((a, b) => (a.calls > b.calls ? a : b));
console.log(`\n최대 사용일은 ${worst.name}, 합계 ${worst.calls + liveCalls}회로 여유 ${dailyLimit - worst.calls - liveCalls}회.`);
if (worst.calls + liveCalls > dailyLimit) {
  console.error('\n한도를 넘는다. 창이나 캐시 TTL을 되돌려야 한다.');
  process.exitCode = 1;
}

if (process.argv.includes('--detail')) {
  for (const day of days) {
    console.log(`\n${day.name}`);
    for (const entry of day.runs) {
      const hour = String(Math.floor(entry.atMinute / 60)).padStart(2, '0');
      const minute = String(Math.round(entry.atMinute % 60)).padStart(2, '0');
      console.log(`  ${hour}:${minute}  ${entry.label.padEnd(16)} ${entry.cycles}사이클`);
    }
  }
}
