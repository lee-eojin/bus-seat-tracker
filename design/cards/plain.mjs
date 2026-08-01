// 담백한 버전. 우테코 크루처럼 데모인 걸 아는 독자용이다.
// 아이폰 프레임, 그라데이션, 원근을 쓰지 않는다. 화면은 스크린샷처럼 그대로 붙인다.

export const plainCss = `
.pl{position:relative;width:100%;height:100%;background:#fff;color:#16181d;
font-family:-apple-system,"Apple SD Gothic Neo","Pretendard",sans-serif;padding:64px 68px;display:flex;flex-direction:column}
.pl .kicker{font-size:14px;font-weight:700;letter-spacing:.1em;color:#8b93a3;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.pl h2{margin:12px 0 0;font-size:36px;line-height:1.32;font-weight:800;letter-spacing:-.02em}
.pl .sub{margin:12px 0 0;font-size:17px;line-height:1.65;color:#5b6472}
.pl .rule{height:1px;background:#e6e9ee;margin:26px 0}
.pl .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:15px;color:#3a4256}
.pl .shot{border:1px solid #dfe3ea;border-radius:10px;overflow:hidden;background:#fff;position:relative}
.pl .shotcap{margin-top:10px;font-size:14px;color:#8b93a3;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.pl table{border-collapse:collapse;width:100%;font-size:17px}
.pl th{text-align:left;font-size:13px;letter-spacing:.08em;color:#8b93a3;font-weight:700;
padding:0 0 10px;border-bottom:1px solid #e6e9ee;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.pl td{padding:13px 0;border-bottom:1px solid #f0f2f6;color:#2a3140}
.pl td.num{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:700;text-align:right;white-space:nowrap}
.pl .foot{margin-top:auto;padding-top:22px;border-top:1px solid #e6e9ee;display:flex;justify-content:space-between;
font-size:14px;color:#8b93a3;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.pl ul{margin:6px 0 0;padding:0;list-style:none}
.pl li{padding:11px 0;border-bottom:1px solid #f0f2f6;font-size:18px;color:#2a3140;display:flex;gap:14px}
.pl li i{flex:none;font-style:normal;color:#8b93a3;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:15px;padding-top:2px}
`;

/** 프레임 없이 화면만. 스크린샷을 문서에 붙인 모양. */
const shot = (screen, w) =>
  `<div class="shot" style="width:${w}px;aspect-ratio:390/844">${screen}</div>`;

export function plainShots({ screens, w, h }) {
  return `
<div class="pl" style="width:${w}px;height:${h}px">
  <p class="kicker">SCREENS</p>
  <h2>지금 배포되어 있는 화면</h2>
  <p class="sub">outputs-eta-fawn.vercel.app 에서 그대로 볼 수 있습니다.<br>
    아래는 목업이 아니라 실제 화면 구성입니다.</p>
  <div class="rule"></div>
  <div style="flex:1;display:flex;gap:26px;align-items:flex-start">
    ${screens.map(([s, cap]) => `<div style="flex:1">${shot(s, 300)}<p class="shotcap">${cap}</p></div>`).join('')}
  </div>
  <div class="foot"><span>bus-seat-tracker</span><span>TypeScript · 번들러 없음 · Vercel</span></div>
</div>`;
}

export function plainNumbers({ w, h }) {
  const rows = [
    ['수집 기간', '3주', '평일 하루 506회 호출, 일 한도 1,000회'],
    ['관측 규모', '6,428명/일', '3330과 1650 두 노선 평일 승차 하한'],
    ['만석 통과', '41%', '저녁 판교역, 관측 68대 중 28대가 좌석 0으로 출발'],
    ['좌석 예보 오차', '4.34석', 'rolling-origin 백테스트, 기준선 naive 6.91'],
    ['만석 확률 Brier', '0.046', '만석빈도 0.070, naive 0.083'],
    ['실사용자', '51명', '2026-07-29 판교역 QR 배포, 한 시간'],
    ['대면 설문', '15명', '응답률 29%, 이 중 9명이 배포 알림 요청'],
    ['못 타는 빈도', '87%', '설문 응답자 중 주 2회 이상 버스를 보낸다'],
  ];
  return `
<div class="pl" style="width:${w}px;height:${h}px">
  <p class="kicker">NUMBERS</p>
  <h2>지금까지 나온 수치</h2>
  <p class="sub">전부 직접 수집하고 계산한 값입니다. 산출 과정은 저장소 docs에 있습니다.</p>
  <div class="rule"></div>
  <table>
    <tr><th>항목</th><th style="text-align:right">값</th><th style="padding-left:24px">근거</th></tr>
    ${rows.map(([k, v, note]) => `<tr><td style="width:220px">${k}</td>
      <td class="num" style="width:130px">${v}</td>
      <td style="padding-left:24px;color:#5b6472;font-size:15px">${note}</td></tr>`).join('')}
  </table>
  <div class="foot"><span>github.com/lee-eojin/bus-seat-tracker</span><span>docs/02-market-size.md · docs/05-validation-2026-07-24.md</span></div>
</div>`;
}

export function plainOpen({ w, h }) {
  const front = ['정류장 축 UI를 컴포넌트로 다시 세우기',
    '첫 화면이 한 줄로 답하게 만들기. 지금은 축부터 보인다',
    '알림을 붙여 매일 열 이유 만들기'];
  const back = ['git JSONL을 시계열 DB로. 지금은 커밋으로 쌓는다',
    '호출 예산 안에서 노선 늘리기. 3개 추가하면 1,000회를 넘는다',
    '예보를 서버에서 계산하고 캐싱하기'];
  const model = ['λ가 저녁 4시간 평균이라 피크가 눌린다. 시간대별로 나눠야 한다',
    '낮 버킷 μ가 0이라 판정이 무조건 여유로 나간다',
    '하차가 몰리는 구간을 찾으면 제로섬이 아니게 된다'];
  const col = (title, items, i) => `<div style="flex:1">
    <p class="kicker" style="color:#16181d">${title}</p>
    <ul>${items.map((t, k) => `<li><i>${String(i)}.${k + 1}</i><span>${t}</span></li>`).join('')}</ul></div>`;
  return `
<div class="pl" style="width:${w}px;height:${h}px">
  <p class="kicker">OPEN</p>
  <h2>지금 열려 있는 것</h2>
  <p class="sub">혼자 여기까지 왔고 이제 막힙니다. 아래는 지어낸 로드맵이 아니라
    지금 실제로 걸려 있는 문제입니다.</p>
  <div class="rule"></div>
  <div style="flex:1;display:flex;gap:44px">
    ${col('FRONTEND', front, 1)}${col('BACKEND', back, 2)}${col('MODEL', model, 3)}
  </div>
  <div class="foot"><span>무보수 사이드 프로젝트, 지분 없음</span><span>주 몇 시간이든 괜찮습니다</span></div>
</div>`;
}
