// 카드 안에 들어갈 앱 화면. 실제 prototype-bus 화면의 클래스와 구조를 그대로 옮겼다.
// 목업이 실물과 다르면 합류한 사람이 첫날 실망한다.

export const screenCss = `
:root{--ok:#237b55;--ok-soft:rgba(35,123,85,.12);--warn:#a85a00;--warn-soft:rgba(168,90,0,.12);
--bad:#c62c40;--bad-soft:rgba(198,44,64,.10);--unknown:#6b7280;--ink:#1c2330;--sub:#5b6472;
--line:#e3e7ec;--panel:#f6f8fa}
.scr{position:absolute;inset:0;background:#fff;color:var(--ink);overflow:hidden;
font-family:-apple-system,"Apple SD Gothic Neo","Pretendard","Noto Sans KR",sans-serif;font-size:15px;line-height:1.5}
.scr .pad{padding:52px 18px 0}
.scr h1{margin:0;font-size:21px;letter-spacing:-.5px}
.scr .subtitle{margin:4px 0 0;color:var(--sub);font-size:13px}
.scr .freshness{display:inline-flex;align-items:center;gap:7px;margin-top:14px;padding:7px 12px;
border-radius:999px;background:var(--panel);font-size:13px;font-weight:700}
.scr .freshness i{width:9px;height:9px;border-radius:50%;background:var(--ok)}
.scr .route-tabs{display:flex;gap:8px;margin-top:18px}
.scr .route-tab{flex:1;border:1px solid var(--line);border-radius:12px;background:#fff;padding:10px 8px;
font-size:15px;font-weight:800;color:var(--sub);text-align:center}
.scr .route-tab.active{border-color:var(--bad);background:var(--bad-soft);color:var(--bad)}
.scr .route-endpoints{margin:10px 2px 0;color:var(--sub);font-size:13px}
.scr .direction-tabs{display:flex;gap:6px;margin-top:14px;padding:4px;border-radius:11px;background:var(--panel)}
.scr .direction-tab{flex:1;border-radius:8px;padding:9px 6px;font-size:13.5px;font-weight:800;color:var(--sub);text-align:center}
.scr .direction-tab.active{background:#fff;color:var(--ink);box-shadow:0 1px 6px rgba(28,35,48,.12)}
.scr .reco{margin-top:14px;padding:14px 16px;border-radius:14px;background:var(--warn-soft)}
.scr .reco-title{font-size:12.5px;font-weight:800;color:var(--sub)}
.scr .reco-body{margin:6px 0 0;font-size:14.5px;font-weight:700;line-height:1.55}
.scr .axis{margin-top:12px;border:1px solid var(--line);border-radius:14px;overflow:hidden}
.scr .stop-row{display:flex;align-items:center;gap:12px;min-height:52px;padding:7px 14px}
.scr .stop-row+.stop-row{border-top:1px solid #eef1f4}
.scr .stop-row.tint-bad{background:rgba(198,44,64,.055)}
.scr .stop-row.tint-warn{background:rgba(168,90,0,.06)}
.scr .stop-row.tint-ok{background:rgba(35,123,85,.05)}
.scr .stop-row.pass-through{background:rgba(107,114,128,.10)}
.scr .stop-dot{width:10px;height:10px;flex:none;border-radius:50%;border:2px solid #aab3bf;background:#fff}
.scr .stop-row.mine .stop-dot{border-color:var(--ink);background:var(--ink)}
.scr .stop-row.pass-through .stop-dot{border-style:dashed;border-color:var(--unknown)}
.scr .stop-name{flex:1;min-width:0;font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.scr .stop-row.mine .stop-name{font-weight:800}
.scr .stop-name small{display:block;color:var(--sub);font-size:12px;font-weight:500}
.scr .verdict{flex:none;display:flex;flex-direction:column;align-items:flex-end;gap:3px}
.scr .badge{display:inline-flex;align-items:center;justify-content:center;min-width:62px;padding:4px 10px;
border-radius:999px;font-size:12.5px;font-weight:800;border:1px solid transparent;color:#fff}
.scr .badge.ok{background:var(--ok)}.scr .badge.warn{background:var(--warn)}.scr .badge.bad{background:var(--bad)}
.scr .seats{font-size:11.5px;color:var(--sub);white-space:nowrap}
.scr .seats.waiting{font-weight:800;color:var(--ink)}
.scr .statusbar{position:absolute;top:0;left:0;right:0;height:52px;display:flex;align-items:flex-end;
justify-content:space-between;padding:0 24px 7px;font-size:13.5px;font-weight:700;color:var(--ink);z-index:4}
.scr .sb-right{display:flex;align-items:center;gap:5px}
.scr .bars{display:flex;align-items:flex-end;gap:2px;height:11px}
.scr .bars i{width:3px;border-radius:1px;background:var(--ink)}
.scr .bars i:nth-child(1){height:4px}.scr .bars i:nth-child(2){height:6px}
.scr .bars i:nth-child(3){height:9px}.scr .bars i:nth-child(4){height:11px}
.scr .batt{position:relative;width:23px;height:11px;border-radius:3px;border:1.5px solid var(--ink);opacity:.9}
.scr .batt::after{content:'';position:absolute;left:1.5px;top:1.5px;bottom:1.5px;width:70%;border-radius:1.5px;background:var(--ink)}
.scr .batt::before{content:'';position:absolute;right:-3px;top:3.5px;width:2px;height:4px;border-radius:0 1px 1px 0;background:var(--ink);opacity:.6}
`;

const stop = (name, sub, cls, verdict, seats, waiting) => `
<div class="stop-row ${cls}">
  <span class="stop-dot"></span>
  <span class="stop-name">${name}${sub ? `<small>${sub}</small>` : ''}</span>
  ${verdict ? `<span class="verdict"><span class="badge ${verdict[0]}">${verdict[1]}</span>
    <span class="seats">${seats}</span>${waiting ? `<span class="seats waiting">${waiting}</span>` : ''}</span>` : ''}
</div>`;

/** 저녁 판교역 화면. 실제 관측에 맞춘 값이다. */
export function boardScreen({ reco = true } = {}) {
  return `
<div class="scr">
  <div class="statusbar"><span>18:57</span>
    <span class="sb-right"><span class="bars"><i></i><i></i><i></i><i></i></span><span class="batt"></span></span></div>
  <div class="pad">
    <h1>빨간버스 좌석 현황</h1>
    <p class="subtitle">내 정류장에 올 때 몇 석일지 예보합니다</p>
    <span class="freshness"><i></i>1분 전 수집</span>
    <div class="route-tabs">
      <div class="route-tab active">3330</div><div class="route-tab">1650</div>
    </div>
    <p class="route-endpoints">도촌동9단지앞 ↔ 안양역</p>
    <div class="direction-tabs">
      <div class="direction-tab active">판교 → 안양</div><div class="direction-tab">안양 → 판교</div>
    </div>
    ${reco ? `<div class="reco"><p class="reco-title">추천</p>
      <p class="reco-body">여기서는 어렵습니다. 백현마을1단지로 한 정류장 올라가면 탈 확률이 높아요.</p></div>` : ''}
    <div class="axis">
      ${stop('이매촌한신.서현역.AK프라자', null, 'tint-ok', ['ok', '여유'], '38석 예상', '줄 3~8명')}
      ${stop('성남역.백현마을2단지', null, 'tint-warn', ['warn', '빠듯'], '12석 예상', '줄 9명 이상')}
      ${stop('백현마을1단지', null, 'tint-warn', ['warn', '빠듯'], '9석 예상', '줄 16명 이상')}
      ${stop('판교역.낙생육교.현대백화점', '내 정류장', 'tint-bad mine', ['bad', '어려움'], '0석 예상', '줄 43명 이상')}
      ${stop('판교TG', '미정차', 'pass-through', null)}
    </div>
  </div>
</div>`;
}

/** 목적지 입력 (QR로 처음 들어왔을 때) */
export function entryScreen({ filled = false } = {}) {
  return `
<div class="scr">
  <div class="statusbar"><span>18:44</span>
    <span class="sb-right"><span class="bars"><i></i><i></i><i></i><i></i></span><span class="batt"></span></span></div>
  <div class="pad">
    <h1>빨간버스 좌석 현황</h1>
    <p class="subtitle">내 정류장에 올 때 몇 석일지 예보합니다</p>
    <div style="margin-top:22px;padding:14px 16px;border-radius:12px;background:var(--warn-soft);color:#7a4100;font-size:13px;line-height:1.6">
      저녁 판교역은 통과 버스의 41퍼센트가 만석입니다. 백현마을1단지는 35퍼센트, 이매촌한신은 4퍼센트예요.
    </div>
    <div style="margin-top:22px;padding:24px 20px;border-radius:14px;background:var(--panel)">
      <b style="font-size:17px">판교역에서 기다리는 게 최선일까요?</b>
      <p style="margin:8px 0 16px;color:var(--sub);font-size:13.5px;line-height:1.6">
        도착지를 알려주시면 어디서 타는 게 나은지 보여드려요.</p>
      <div style="display:flex;gap:8px">
        <div style="flex:1;min-height:48px;border:1px solid ${filled ? 'var(--ink)' : 'var(--line)'};border-radius:12px;background:#fff;
          display:flex;align-items:center;padding:0 14px;color:${filled ? 'var(--ink)' : '#9aa2ae'};font-size:15px;font-weight:${filled ? 700 : 400}">${filled ? '안양역' : '예: 안양역'}</div>
        <div style="min-height:48px;border-radius:12px;background:var(--ink);color:#fff;padding:0 18px;
          display:flex;align-items:center;font-size:15px;font-weight:800">시작</div>
      </div>
    </div>
  </div>
</div>`;
}

/** 설문 배너가 보이는 화면 */
export function surveyScreen() {
  return `
<div class="scr">
  <div class="statusbar"><span>19:02</span>
    <span class="sb-right"><span class="bars"><i></i><i></i><i></i><i></i></span><span class="batt"></span></span></div>
  <div class="pad">
    <h1>빨간버스 좌석 현황</h1>
    <p class="subtitle">내 정류장에 올 때 몇 석일지 예보합니다</p>
    <span class="freshness"><i></i>2분 전 수집</span>
    <div style="margin-top:16px;padding:16px 18px;border-radius:14px;background:#a85a00;color:#fff;
      box-shadow:0 2px 10px rgba(168,90,0,.35);display:flex;align-items:center;gap:12px">
      <span style="flex:1">
        <b style="display:block;font-size:15px">후기 남겨주시는 분께 커피를 드립니다</b>
        <span style="display:block;margin-top:4px;font-size:12.5px;line-height:1.5;color:rgba(255,255,255,.9)">
          오늘 몇 대 보내셨는지 알려주시면 대기 인원 예측이 정확해집니다. 30초면 끝나요.</span>
        <span style="display:inline-block;margin-top:8px;padding:4px 10px;border-radius:999px;
          background:rgba(255,255,255,.22);font-size:12px;font-weight:800">이 버튼 클릭!</span>
      </span>
      <span style="font-size:22px;opacity:.9">›</span>
    </div>
    <div class="route-tabs"><div class="route-tab active">3330</div><div class="route-tab">1650</div></div>
    <p class="route-endpoints">도촌동9단지앞 ↔ 안양역</p>
  </div>
</div>`;
}
