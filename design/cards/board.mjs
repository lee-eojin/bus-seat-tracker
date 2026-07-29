// 협업 보드 카드. 실제로 열려 있는 과제를 스티키로 붙이고 빈 자리를 드러낸다.
// 없는 팀원 이름을 박지 않는다. 지금은 혼자이고 그게 모집하는 이유다.

export const boardCss = `
.jam{position:relative;width:100%;height:100%;background:#f4f5f7;overflow:hidden;
background-image:radial-gradient(rgba(28,35,48,.11) 1.5px,transparent 1.5px);background-size:26px 26px}
.jam .topbar{position:absolute;top:0;left:0;right:0;height:64px;background:#fff;border-bottom:1px solid #e4e6ec;
display:flex;align-items:center;padding:0 24px;gap:18px;z-index:6}
.jam .brand{font-size:19px;font-weight:800;letter-spacing:-.02em;color:#1c2330}
.jam .crumb{font-size:16px;font-weight:700;color:#5b6472}
.jam .avatars{margin-left:auto;display:flex;align-items:center}
.jam .av{width:32px;height:32px;border-radius:50%;border:2px solid #fff;margin-left:-8px;
display:grid;place-items:center;font-size:13px;font-weight:800;color:#fff}
.jam .av.open{background:#fff;border:2px dashed #b6bdc9;color:#8b93a3}
.jam .side{position:absolute;top:64px;left:0;bottom:0;width:56px;background:#fff;border-right:1px solid #e4e6ec;
display:flex;flex-direction:column;align-items:center;gap:20px;padding-top:20px;z-index:6}
.jam .tool{width:24px;height:24px;border-radius:6px;background:#dfe3ea}
.jam .tool.on{background:#1c2330}
.jam .canvas{position:absolute;top:64px;left:56px;right:0;bottom:0}
.sticky{position:absolute;padding:14px 15px;border-radius:4px;font-size:15px;line-height:1.45;font-weight:600;
color:#2a3140;box-shadow:0 6px 16px rgba(28,35,48,.14);width:190px}
.sticky b{display:block;font-size:12.5px;font-weight:800;opacity:.55;margin-bottom:5px;letter-spacing:.04em}
.note-title{position:absolute;padding:20px 22px;border-radius:8px;background:#7b8cff;color:#fff;
font-size:23px;font-weight:800;line-height:1.35;box-shadow:0 10px 26px rgba(90,110,255,.34);width:250px}
.cursor{position:absolute;display:flex;align-items:flex-start;gap:0;z-index:5}
.cursor svg{filter:drop-shadow(0 2px 4px rgba(0,0,0,.25))}
.cursor span{margin:14px 0 0 -2px;padding:4px 10px;border-radius:6px;font-size:13.5px;font-weight:800;color:#fff;white-space:nowrap}
.chip{position:absolute;padding:9px 14px;border-radius:999px;background:#fff;border:1px solid #e0e3ea;
font-size:14px;font-weight:700;color:#3a4256;box-shadow:0 4px 12px rgba(28,35,48,.1)}
`;

const cursor = (x, y, color, label) => `
<div class="cursor" style="left:${x}px;top:${y}px">
  <svg width="20" height="22" viewBox="0 0 20 22"><path d="M2 1 L2 17 L6.5 13 L9.5 20 L12.5 18.5 L9.5 12 L16 12 Z"
    fill="${color}" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>
  <span style="background:${color}">${label}</span></div>`;

const sticky = (x, y, rot, bg, tag, text) =>
  `<div class="sticky" style="left:${x}px;top:${y}px;transform:rotate(${rot}deg);background:${bg}">
    ${tag ? `<b>${tag}</b>` : ''}${text}</div>`;

export function jamBoard({ phone }) {
  return `
<div class="jam">
  <div class="topbar">
    <span class="brand">빨간버스</span><span class="crumb">/ 다음 4주에 풀 것</span>
    <span class="avatars">
      <span class="av" style="background:#c62c40">나</span>
      <span class="av open">?</span><span class="av open">?</span>
    </span>
  </div>
  <div class="side">
    <div class="tool on"></div><div class="tool"></div><div class="tool"></div>
    <div class="tool"></div><div class="tool"></div><div class="tool"></div>
  </div>
  <div class="canvas">
    <svg style="position:absolute;inset:0;width:100%;height:100%" fill="none">
      <path d="M300 250 C 372 250, 400 200, 466 200" stroke="#1c2330" stroke-width="2.4" stroke-linecap="round"/>
      <path d="M700 200 C 760 200, 776 200, 836 200" stroke="#1c2330" stroke-width="2.4" stroke-linecap="round"/>
      <path d="M1070 200 C 1130 200, 1146 200, 1206 200" stroke="#1c2330" stroke-width="2.4" stroke-linecap="round"/>
      <path d="M566 630 C 566 692, 700 692, 700 736" stroke="#c62c40" stroke-width="2.4" stroke-dasharray="7 7"/>
      <path d="M150 470 C 210 470, 220 552, 152 588" stroke="#8b93a3" stroke-width="2" stroke-dasharray="5 6"/>
    </svg>

    <div class="note-title" style="left:40px;top:44px">직행좌석버스는<br>입석이 없다</div>
    ${sticky(40, 196, -1.5, '#ffe27a', '확인된 사실', '저녁 판교역 통과 버스의 41%가 좌석 0으로 떠난다')}
    ${sticky(40, 340, 1.2, '#ffd0d8', '7/24 실측', '38명 대기, 9명 탑승, 29명 이월. 줄에 서서 직접 셌다')}

    <div style="position:absolute;left:466px;top:34px">${phone(224)}</div>
    <div style="position:absolute;left:836px;top:34px">${phone(224)}</div>
    <div style="position:absolute;left:1206px;top:34px">${phone(224)}</div>

    ${sticky(470, 560, 1.8, '#b8f0d2', '열림', 'λ가 저녁 4시간 평균이라 피크가 눌린다. 시간대별로 나눠야 함')}
    ${sticky(700, 736, -1.2, '#ffe27a', '열림', '낮 버킷 μ가 0이라 판정이 무조건 여유로 나감')}
    ${sticky(950, 520, 1.4, '#cfe0ff', '백엔드', 'git JSONL을 시계열 DB로. 지금은 커밋으로 쌓는다')}
    ${sticky(1240, 566, -1.8, '#cfe0ff', '백엔드', '노선 3개 추가하면 일 1,000회 예산을 넘는다')}
    ${sticky(950, 744, -1, '#e6d9ff', '프론트', '첫 화면이 한 줄로 답해야 한다. 지금은 축부터 보인다')}
    ${sticky(1240, 792, 1.6, '#e6d9ff', '프론트', '알림을 붙이면 매일 열 이유가 생긴다')}
    ${sticky(40, 588, -1.6, '#ffd0d8', '8/5 판정', '재방문율. 51명 중 15명이 다시 열면 계속한다')}
    ${sticky(250, 762, 1.1, '#b8f0d2', '열림', '하차가 몰리는 구간을 찾으면 제로섬이 아니게 된다')}

    <div class="chip" style="left:40px;top:498px">지금 여기까지 혼자 왔습니다</div>

    ${cursor(300, 236, '#c62c40', '나')}
    ${cursor(1180, 692, '#7b8cff', '프론트엔드 · 모집 중')}
    ${cursor(890, 452, '#2b9e6b', '백엔드 · 모집 중')}
    ${cursor(1140, 505, '#2b9e6b', '백엔드 · 모집 중')}
  </div>
</div>`;
}
