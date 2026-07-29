import { mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardScreen, entryScreen, screenCss, surveyScreen } from './screen.mjs';
import { boardCss, jamBoard } from './board.mjs';
import { mathCard, mathCss } from './math.mjs';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, 'out');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// 아이폰 프레임. 베젤, 다이내믹 아일랜드, 라운드, 그림자까지 CSS로만 만든다.
const frameCss = `
.phone{position:relative;width:var(--pw,320px);aspect-ratio:390/844;border-radius:calc(var(--pw,320px)*.14);
background:linear-gradient(150deg,#3a3f47,#15181d 42%,#2c3138);padding:calc(var(--pw,320px)*.028);
box-shadow:0 40px 90px rgba(20,28,45,.35),0 8px 24px rgba(20,28,45,.22),inset 0 0 0 1px rgba(255,255,255,.14)}
.phone .glass{position:relative;width:100%;height:100%;border-radius:calc(var(--pw,320px)*.115);overflow:hidden;background:#fff}
.phone .island{position:absolute;top:calc(var(--pw,320px)*.032);left:50%;transform:translateX(-50%);
width:28%;height:calc(var(--pw,320px)*.085);border-radius:999px;background:#0b0d10;z-index:3}
.phone .home{position:absolute;bottom:calc(var(--pw,320px)*.022);left:50%;transform:translateX(-50%);
width:34%;height:4px;border-radius:999px;background:rgba(20,24,32,.28);z-index:3}
.phone .shine{position:absolute;inset:0;border-radius:calc(var(--pw,320px)*.115);z-index:2;pointer-events:none;
background:linear-gradient(115deg,rgba(255,255,255,.34) 0%,rgba(255,255,255,0) 32%,rgba(255,255,255,0) 70%,rgba(255,255,255,.12) 100%)}
`;

const phone = (inner, width = 320) =>
  `<div class="phone" style="--pw:${width}px"><div class="glass">${inner}</div><div class="island"></div><div class="home"></div><div class="shine"></div></div>`;

const baseCss = `
*{box-sizing:border-box}html,body{margin:0}
body{font-family:-apple-system,"Apple SD Gothic Neo","Pretendard","Noto Sans KR",sans-serif;
-webkit-font-smoothing:antialiased;color:#111826}
.card{position:relative;overflow:hidden;display:flex;flex-direction:column}
.eyebrow{font-size:15px;font-weight:800;letter-spacing:.12em;color:#8b93a3;text-transform:uppercase}
.title{margin:14px 0 0;font-size:44px;line-height:1.28;font-weight:800;letter-spacing:-.02em}
.title .hl{color:#c62c40}
.lead{margin:16px 0 0;font-size:19px;line-height:1.65;color:#5b6472;font-weight:500}
.blob{position:absolute;border-radius:50%;filter:blur(70px);opacity:.55}
.stat{display:flex;flex-direction:column;gap:4px}
.stat b{font-size:52px;font-weight:800;letter-spacing:-.02em;line-height:1}
.stat span{font-size:16px;color:#5b6472;font-weight:600}
.foot{margin-top:auto;display:flex;align-items:center;justify-content:space-between;
font-size:15px;font-weight:700;color:#8b93a3}
${frameCss}${screenCss}${boardCss}${mathCss}`;

const page = (w, h, body) => `<!doctype html><meta charset="utf-8"><style>
${baseCss}
html,body{width:${w}px;height:${h}px}
</style>${body}`;

// ── 카드 정의 ──
const W = 1200, H = 1500;

const shell = (bg, blobs, body, foot) => `<div class="card" style="width:${W}px;height:${H}px;padding:86px 80px;background:${bg}">
  ${blobs}<div style="position:relative;display:flex;flex-direction:column;height:100%">${body}
  <div class="foot">${foot}</div></div></div>`;

const blob = (w, css, color) => `<div class="blob" style="width:${w}px;height:${w}px;background:${color};${css}"></div>`;

const cards = [
  { name: '01-problem', html: shell(
    'linear-gradient(160deg,#fdf1f3 0%,#f7e9ee 45%,#eceff8 100%)',
    blob(560,'top:-160px;right:-130px','#f2abbb') + blob(440,'bottom:-130px;left:-150px','#c3d5f5'),
    `<p class="eyebrow">The problem</p>
     <h1 class="title">버스가 왔다. <span class="hl">0석</span>.<br>다음도, 그다음도 0석이었다.</h1>
     <p class="lead">직행좌석버스는 입석이 없습니다. 좌석이 0이면<br>그 버스는 정류장에 서지도 않고 지나갑니다.</p>
     <div style="flex:1;display:flex;align-items:center;justify-content:center;margin-top:20px">
       ${phone(boardScreen(), 400)}</div>`,
    '<span>빨간버스 좌석 현황</span><span>3330 · 1650</span>') },

  { name: '02-forecast', html: shell(
    'linear-gradient(160deg,#eef4fd 0%,#e4ecfa 50%,#f5f8fc 100%)',
    blob(600,'top:-180px;left:-140px','#a9c3ef') + blob(440,'bottom:-150px;right:-130px','#c2ded0'),
    `<p class="eyebrow">Arrival forecast</p>
     <h1 class="title">지금 몇 석이 아니라<br><span class="hl">내 앞에 설 때</span> 몇 석</h1>
     <p class="lead">상류 정류장의 승하차를 전파해 도착 시점 좌석 분포를 냅니다.<br>3주치 관측 백테스트에서 평균 오차 4.34석입니다.</p>
     <div style="flex:1;display:flex;align-items:center;justify-content:center;gap:0;margin-top:8px">
       <div style="transform:perspective(1400px) rotateY(26deg) rotateX(5deg) translateX(46px) scale(.92);z-index:1">
         ${phone(entryScreen(), 330)}</div>
       <div style="transform:perspective(1400px) rotateY(-16deg) rotateX(4deg) translateX(-30px);z-index:2">
         ${phone(boardScreen(), 360)}</div>
     </div>`,
    '<span>MAE 4.34석 · 기준선 6.91</span><span>rolling-origin backtest</span>') },

  { name: '03-queue', html: shell(
    'linear-gradient(160deg,#fff7ec 0%,#fdeedd 48%,#f2f0fa 100%)',
    blob(560,'top:-150px;right:-140px','#f5c68a') + blob(420,'bottom:-140px;left:-120px','#cdc6f0'),
    `<p class="eyebrow">Queue estimate</p>
     <h1 class="title">줄에 <span class="hl">몇 명</span> 서 있는지<br>가서 서 보기 전에</h1>
     <p class="lead">좌석을 남기고 떠난 버스는 그 순간 줄이 비었다는 뜻입니다.<br>그 사이 흐른 시간에 도착률을 곱해 지금 줄을 복원합니다.</p>
     <div style="flex:1;display:flex;align-items:center;justify-content:center;margin-top:12px">
       <div style="transform:perspective(1500px) rotateY(-14deg) rotateX(6deg)">${phone(boardScreen(), 390)}</div>
     </div>`,
    '<span>λ 2.69명/분 · 판교역 저녁</span><span>구간 44개 · 승차 2,335명</span>') },

  { name: '04-censoring', html: shell(
    'linear-gradient(155deg,#12161f 0%,#1b2230 55%,#232c3d 100%)',
    blob(600,'top:-180px;right:-160px;opacity:.32','#3f6ad8') + blob(460,'bottom:-160px;left:-140px;opacity:.28','#c62c40'),
    `<p class="eyebrow" style="color:#7f8ba3">The hard part</p>
     <h1 class="title" style="color:#f2f5fa">못 탄 사람은<br><span style="color:#ff7a90">데이터에 남지 않는다</span></h1>
     <p class="lead" style="color:#9aa6bd">만석 버스가 지나가면 API에는 잔여석 0만 남습니다.<br>몇 명이 못 탔는지는 어디에도 기록되지 않습니다.<br>이 검열을 어떻게 되살리느냐가 이 프로젝트의 기술적 중심입니다.</p>
     <div style="flex:1;display:flex;flex-direction:column;justify-content:center;gap:26px;margin-top:4px">
       <div>
         <p style="margin:0 0 14px;color:#7f8ba3;font-size:15px;font-weight:800">저녁 판교역을 지나간 3330 열 대</p>
         <div style="display:flex;gap:10px">
           ${Array.from({length:10},(_,i)=>{const full=i<4;return `<div style="flex:1;height:86px;border-radius:12px;
             background:${full?'rgba(198,44,64,.85)':'rgba(255,255,255,.09)'};
             border:1px solid ${full?'rgba(255,122,144,.6)':'rgba(255,255,255,.14)'};
             display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:800;
             color:${full?'#fff':'#7f8ba3'}">${full?'0석':''}</div>`}).join('')}
         </div>
         <p style="margin:12px 0 0;color:#9aa6bd;font-size:16px">넷은 좌석을 다 채우고 떠납니다. 그 자리에 남은 사람은 어디에도 안 남습니다.</p>
       </div>
       <div style="display:flex;gap:20px">
         <div style="flex:1;padding:24px 26px;border-radius:18px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1)">
           <p style="margin:0;color:#7f8ba3;font-size:14px;font-weight:800">API가 말하는 것</p>
           <p style="margin:8px 0 0;color:#f2f5fa;font-size:28px;font-weight:800">잔여석 0</p>
         </div>
         <div style="flex:1.6;padding:24px 26px;border-radius:18px;background:rgba(198,44,64,.16);border:1px solid rgba(255,122,144,.3)">
           <p style="margin:0;color:#ff9fb0;font-size:14px;font-weight:800">그날 실제로 있었던 일</p>
           <p style="margin:8px 0 0;color:#fff;font-size:28px;font-weight:800">38명 대기, 9명 탑승, <span style="color:#ff7a90">29명 이월</span></p>
           <p style="margin:10px 0 0;color:#9aa6bd;font-size:15px">2026-07-24 18:57 판교역, 줄에 서서 직접 셈</p>
         </div>
       </div>
     </div>`,
    '<span style="color:#6f7a91">검열 배율 하한 4.22배</span><span style="color:#6f7a91">censored demand recovery</span>') },

  { name: '05-evidence', html: shell(
    'linear-gradient(160deg,#eef7f1 0%,#e3f0ea 50%,#eef2f8 100%)',
    blob(540,'top:-150px;left:-130px','#a8d5bd') + blob(430,'bottom:-140px;right:-120px','#bcd0f0'),
    `<p class="eyebrow">Already running</p>
     <h1 class="title">비전이 아니라<br><span class="hl">이미 굴러가는 것</span></h1>
     <div style="flex:1;display:grid;grid-template-columns:1fr 1fr;gap:30px;align-content:center;margin-top:24px">
       <div class="stat"><b>51명</b><span>7월 29일 하루 실사용자</span></div>
       <div class="stat"><b>15명</b><span>정류장에서 받은 대면 설문</span></div>
       <div class="stat"><b>87%</b><span>주 2회 이상 버스를 보낸다</span></div>
       <div class="stat"><b>4.34석</b><span>도착 좌석 예보 평균 오차</span></div>
       <div class="stat"><b>3주</b><span>수집한 좌석 관측</span></div>
       <div class="stat"><b>6,428명</b><span>두 노선 평일 하루 승차</span></div>
     </div>`,
    '<span>outputs-eta-fawn.vercel.app</span><span>github.com/lee-eojin/bus-seat-tracker</span>') },

  { name: '06-flow', html: shell(
    'linear-gradient(160deg,#f7f8fb 0%,#eef1f7 100%)',
    blob(500,'top:-160px;right:-150px','#d5dcea'),
    `<p class="eyebrow">User flow</p>
     <h1 class="title">정류장에서 <span class="hl">30초</span> 안에<br>답이 나와야 합니다</h1>
     <div style="flex:1;display:flex;align-items:center;justify-content:space-between;gap:16px;margin:8px -12px 0">
       ${['QR로 진입','도착지 입력','어디서 탈지','후기 남기기'].map((label, i) =>
         `<div style="display:flex;flex-direction:column;align-items:center;gap:16px">
            ${phone([entryScreen(), entryScreen({filled:true}), boardScreen(), surveyScreen()][i], 250)}
            <span style="font-size:16px;font-weight:800;color:#5b6472">${i + 1}. ${label}</span>
          </div>`).join('')}
     </div>`,
    '<span>한 시간에 51명이 열었다</span><span>29퍼센트가 설문까지 완료</span>') },

  { name: '07-join-frontend', html: shell(
    'linear-gradient(160deg,#f2f0fd 0%,#e8e6fa 50%,#f4f6fb 100%)',
    blob(560,'top:-160px;right:-130px','#bdb4f0') + blob(430,'bottom:-140px;left:-130px','#b9d3ee'),
    `<p class="eyebrow">We are looking for</p>
     <h1 class="title">프론트엔드를<br><span class="hl">찾습니다</span></h1>
     <p class="lead">지금 화면은 바닐라 TypeScript 한 파일 1,200줄입니다.<br>사용자가 생겼으니 이제 제대로 만들 때입니다.</p>
     <div style="flex:1;display:flex;flex-direction:column;justify-content:center;gap:16px">
       ${['정류장 축 UI를 컴포넌트로 다시 세우기','예보와 대기 인원을 한 줄 결론으로 압축하기',
          '실기기에서 30초 안에 답이 나오게 만들기','알림을 붙여 매일 열 이유 만들기'].map(t =>
         `<div style="display:flex;gap:14px;align-items:flex-start">
            <span style="flex:none;width:8px;height:8px;border-radius:50%;background:#7c6cf0;margin-top:11px"></span>
            <span style="font-size:20px;font-weight:600;color:#3a4256">${t}</span></div>`).join('')}
     </div>`,
    '<span>무보수 사이드 프로젝트</span><span>주 몇 시간이든 괜찮습니다</span>') },

  { name: '08-join-backend', html: shell(
    'linear-gradient(160deg,#eef6fb 0%,#e2eff7 50%,#f2f7fa 100%)',
    blob(560,'top:-160px;left:-140px','#9fcbe4') + blob(430,'bottom:-140px;right:-120px','#bfe0d4'),
    `<p class="eyebrow">We are looking for</p>
     <h1 class="title">백엔드를<br><span class="hl">찾습니다</span></h1>
     <p class="lead">데이터가 git 저장소에 JSONL로 쌓입니다.<br>일 호출 한도 1,000회가 모든 설계를 제약합니다.</p>
     <div style="flex:1;display:flex;flex-direction:column;justify-content:center;gap:16px">
       ${['JSONL을 시계열 DB로 옮기기','호출 예산 안에서 노선을 늘리는 수집 설계',
          '예보를 서버에서 계산하고 캐싱하기','재방문과 행동 로그를 제대로 쌓기'].map(t =>
         `<div style="display:flex;gap:14px;align-items:flex-start">
            <span style="flex:none;width:8px;height:8px;border-radius:50%;background:#2b83b0;margin-top:11px"></span>
            <span style="font-size:20px;font-weight:600;color:#33414f">${t}</span></div>`).join('')}
     </div>`,
    '<span>무보수 사이드 프로젝트</span><span>일 1,000회 예산 안에서</span>') },
];


const BW = 1600, BH = 1000;
const screens = [entryScreen(), boardScreen(), surveyScreen()];
let picked = 0;
cards.push({
  name: '09-board', w: BW, h: BH,
  html: `<div class="card" style="width:${BW}px;height:${BH}px">${jamBoard({
    phone: (w) => phone(screens[picked++ % screens.length], w),
  })}</div>`,
});

const MW = 1200, MH = 1200;
cards.push({ name: '10-model', w: MW, h: MH,
  html: `<div class="card" style="width:${MW}px;height:${MH}px">${mathCard({ w: MW, h: MH })}</div>` });

await mkdir(outDir, { recursive: true });
for (const card of cards) {
  const file = path.join(outDir, `${card.name}.html`);
  await writeFile(file, page(card.w ?? W, card.h ?? H, card.html));
  await run(chrome, ['--headless', '--disable-gpu', '--hide-scrollbars',
    `--screenshot=${path.join(outDir, card.name + '.png')}`,
    `--window-size=${card.w ?? W},${card.h ?? H}`, '--force-device-scale-factor=2', `file://${file}`]);
  console.log('생성', card.name + '.png');
}
