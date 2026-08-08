// 재방문 집계. 문제 검증 문서(docs/product/problem-validation.md)의 첫 접촉 코호트가
// 이후 날짜에 몇 명씩 다시 열었는가. 방문 기록은 화면이 남긴 무작위 visitor_id뿐이라
// 개인을 식별하지 않는다 (api/feedback.ts).
//
// 실행:
//   DATABASE_URL='postgres://...' npm run retention
//   DATABASE_URL='postgres://...' npm run retention -- --cohort=2026-07-29
//
// DATABASE_URL은 Neon 콘솔(프로젝트 → Connection Details)에서 가져온다. Vercel 환경변수는
// Sensitive라 재열람이 안 되므로 Neon 쪽이 원본이다 (docs/operations/deployment.md).
import { neon } from '@neondatabase/serverless';

const kstOffsetMs = 9 * 3600 * 1000;

export function kstDate(value) {
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return new Date(time + kstOffsetMs).toISOString().slice(0, 10);
}

function addDays(date, days) {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + days * 86400_000).toISOString().slice(0, 10);
}

function nextWeekday(date) {
  let candidate = addDays(date, 1);
  while ([0, 6].includes(new Date(`${candidate}T00:00:00Z`).getUTCDay())) candidate = addDays(candidate, 1);
  return candidate;
}

/**
 * events: { visitorId, at } 목록. 코호트 = 첫 방문일이 cohortDate인 방문자.
 * 이후 날짜별로 코호트 중 몇 명이 다시 열었는지 센다. 설문 제출도 방문이다.
 */
export function computeRetention(events, cohortDate) {
  const visitDates = new Map();
  for (const event of events) {
    if (!event.visitorId) continue;
    const date = kstDate(event.at);
    const dates = visitDates.get(event.visitorId) ?? new Set();
    dates.add(date);
    visitDates.set(event.visitorId, dates);
  }

  const cohort = [...visitDates.entries()]
    .filter(([, dates]) => [...dates].sort()[0] === cohortDate)
    .map(([visitorId]) => visitorId);

  const laterDates = [...new Set([...visitDates.values()].flatMap((dates) => [...dates]))]
    .filter((date) => date > cohortDate)
    .sort();
  const returnedByDate = laterDates.map((date) => ({
    date,
    returned: cohort.filter((visitorId) => visitDates.get(visitorId).has(date)).length,
  }));
  const returnedEver = cohort.filter((visitorId) => [...visitDates.get(visitorId)].some((date) => date > cohortDate)).length;
  // 기획서 7.3의 "1주 재방문"은 코호트일 이후 7일 안의 누적 재방문자다. 특정 날짜 하루
  // (returnedByDate)도, 기간 상한 없는 returnedEver도 아니다 — 셋을 헷갈리면 같은
  // 데이터에서 통과와 불통과가 갈린다.
  const weekEnd = addDays(cohortDate, 7);
  const returnedWithinWeek = cohort.filter((visitorId) =>
    [...visitDates.get(visitorId)].some((date) => date > cohortDate && date <= weekEnd),
  ).length;

  return { cohortSize: cohort.length, returnedByDate, returnedEver, returnedWithinWeek };
}

function selfTest() {
  const events = [
    { visitorId: 'a', at: '2026-07-29T10:00:00+09:00' },
    { visitorId: 'a', at: '2026-07-30T08:00:00+09:00' },
    { visitorId: 'a', at: '2026-08-05T08:00:00+09:00' },
    { visitorId: 'b', at: '2026-07-29T19:30:00+09:00' },
    { visitorId: 'c', at: '2026-07-30T09:00:00+09:00' },   // 코호트 밖 (첫 방문이 다음 날)
    { visitorId: 'c', at: '2026-08-05T09:00:00+09:00' },
    { visitorId: null, at: '2026-07-29T10:00:00+09:00' },  // ID 없는 기록은 제외
    { visitorId: 'd', at: '2026-07-29T23:50:00+09:00' },   // KST 자정 직전도 29일
  ];
  const result = computeRetention(events, '2026-07-29');
  const expect = (actual, wanted, label) => {
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
      throw new Error(`self-test 실패 (${label}): ${JSON.stringify(actual)} != ${JSON.stringify(wanted)}`);
    }
  };
  expect(result.cohortSize, 3, '코호트 크기');
  expect(result.returnedEver, 1, '재방문자 수');
  expect(result.returnedWithinWeek, 1, '1주 이내 재방문자 수');
  expect(result.returnedByDate, [
    { date: '2026-07-30', returned: 1 },
    { date: '2026-08-05', returned: 1 },
  ], '날짜별');
  const lateOnly = computeRetention([
    { visitorId: 'x', at: '2026-07-29T10:00:00+09:00' },
    { visitorId: 'x', at: '2026-08-10T10:00:00+09:00' },
  ], '2026-07-29');
  expect(lateOnly.returnedWithinWeek, 0, '1주 경계 밖 재방문 제외');
  expect(lateOnly.returnedEver, 1, '기간 무제한 재방문 포함');
  console.log('self-test 통과');
}

async function main() {
  const cohortArgument = process.argv.find((argument) => argument.startsWith('--cohort='));
  const cohortDate = cohortArgument ? cohortArgument.split('=')[1] : '2026-07-29';
  if (process.argv.includes('--self-test')) {
    selfTest();
    return;
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL이 필요합니다. Neon 콘솔의 Connection Details에서 가져와 환경으로 넘긴다:');
    console.error("  DATABASE_URL='postgres://...' npm run retention");
    process.exitCode = 1;
    return;
  }

  const sql = neon(process.env.DATABASE_URL);
  const rows = await sql`SELECT visitor_id, created_at FROM feedback_events WHERE visitor_id IS NOT NULL`;
  const result = computeRetention(rows.map((row) => ({ visitorId: row.visitor_id, at: row.created_at })), cohortDate);

  const markerList = [
    { date: nextWeekday(cohortDate), label: '다음 평일' },
    { date: addDays(cohortDate, 3), label: '3일 잔존' },
    { date: addDays(cohortDate, 7), label: '1주 경계' },
  ];
  const markersAt = (date) => markerList.filter((marker) => marker.date === date).map((marker) => marker.label);

  console.log('═'.repeat(56));
  console.log(`재방문 집계 · 코호트 ${cohortDate} (첫 방문 기준)`);
  console.log('═'.repeat(56));
  console.log(`코호트 크기: ${result.cohortSize}명`);
  console.log(`1주 이내(≤${addDays(cohortDate, 7)}) 재방문: ${result.returnedWithinWeek}명 · 기간 무제한 재방문: ${result.returnedEver}명`);
  console.log('\n  날짜          재방문   비율');
  for (const { date, returned } of result.returnedByDate) {
    const share = result.cohortSize > 0 ? ` ${((returned / result.cohortSize) * 100).toFixed(0).padStart(4)}%` : '';
    const labels = markersAt(date);
    console.log(`  ${date}  ${String(returned).padStart(6)}${share}${labels.length > 0 ? `   ← ${labels.join(' · ')}` : ''}`);
  }
  if (cohortDate === '2026-07-29') {
    console.log('\n기획서 7.3 기준: 1주 이내 재방문 15명 이상이면 통과 — 위의 "1주 이내" 값으로 판정한다.');
    console.log('분모 주의: 기획서의 51명(화면을 연 사람)과 이 코호트(방문 기록이 남은 방문자)는 집계');
    console.log('경로가 달라 크기가 다를 수 있다. 판정은 비율이 아니라 절대 인원(15명)으로 한다.');
  }
}

main().catch((error) => {
  console.error(`재방문 집계 실패: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
