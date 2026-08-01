// 수식 카드. docs/04-queue-recovery.md와 docs/03-boarding-model-v2.md의 실제 식만 쓴다.
// 장식으로 만든 식은 넣지 않는다. 읽는 사람이 개발자다.

export const mathCss = `
.math{position:relative;width:100%;height:100%;background:#f2f2f0;color:#1a1a19;
font-family:"Helvetica Neue",-apple-system,"Apple SD Gothic Neo",sans-serif}
.math .wm{position:absolute;left:76px;top:56px;font-size:46px;font-weight:300;letter-spacing:-.02em;color:#8d8d8a}
.math .wm b{font-weight:600;color:#1a1a19}
.math .foot{position:absolute;left:76px;bottom:56px;display:flex;align-items:center;gap:16px;
font-size:20px;color:#6f6f6c;font-weight:300}
.math .foot .dot{width:34px;height:34px;border-radius:50%;border:1.5px solid #a8a8a5}
.fig{position:absolute}
.fig .cap{font-size:15px;line-height:1.5;color:#4a4a48;font-weight:300;max-width:250px}
.fig .eq{font-size:26px;letter-spacing:-.01em;color:#1a1a19}
.fig .eq .sub{font-size:17px;vertical-align:baseline}
.fig .lbl{font-size:15px;color:#6f6f6c;font-weight:300}
.fig .tag{font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#9a9a97;font-weight:500}
`;

const axis = (w, h) => `
<path d="M0 ${h} H ${w}" stroke="#a8a8a5" stroke-width="1.2"/>
<path d="M${w} ${h} l -7 -4 l 0 8 Z" fill="#a8a8a5"/>
<path d="M0 ${h} V 0" stroke="#a8a8a5" stroke-width="1.2"/>
<path d="M0 0 l -4 7 l 8 0 Z" fill="#a8a8a5"/>`;

/** 그림 1: 큐 해소 사이에서 λ를 식별한다 */
const figLambda = () => `
<div class="fig" style="left:76px;top:210px;width:460px">
  <p class="tag">1 · 도착률 식별</p>
  <svg width="440" height="230" style="margin-top:14px;overflow:visible">
    <g transform="translate(30,14)">
      ${axis(390, 190)}
      <text x="-18" y="4" font-size="14" fill="#6f6f6c">명</text>
      <text x="392" y="208" font-size="14" fill="#6f6f6c">t</text>
      <line x1="20" y1="190" x2="20" y2="10" stroke="#1a1a19" stroke-width="1" stroke-dasharray="4 4"/>
      <line x1="320" y1="190" x2="320" y2="10" stroke="#1a1a19" stroke-width="1" stroke-dasharray="4 4"/>
      <path d="M20 190 L320 60" stroke="#1a1a19" stroke-width="2"/>
      <path d="M20 190 h64 v-28 h68 v-32 h76 v-30 h72 v-24" stroke="#8d8d8a" stroke-width="1.6" fill="none"/>
      <circle cx="20" cy="190" r="4" fill="#1a1a19"/><circle cx="320" cy="60" r="4" fill="#1a1a19"/>
      <text x="12" y="212" font-size="15" fill="#1a1a19">t₀</text>
      <text x="312" y="212" font-size="15" fill="#1a1a19">t₁</text>
      <text x="196" y="96" font-size="15" fill="#1a1a19">도착</text>
      <text x="236" y="164" font-size="15" fill="#8d8d8a">승차</text>
    </g>
  </svg>
  <p class="eq" style="margin:16px 0 0">λ = Σ 승차(t₀, t₁] / (t₁ − t₀)</p>
  <p class="cap" style="margin-top:16px;max-width:420px">t₀와 t₁은 둘 다 큐 해소 시점이어야 한다.
    좌석을 남기고 떠난 버스만 그 순간 줄이 0이었음을 보증한다.</p>
</div>`;

/** 그림 2: 두 곡선의 세로 간격이 대기 인원 */
const figQueue = () => `
<div class="fig" style="left:600px;top:210px;width:440px">
  <p class="tag">2 · 대기 인원 복원</p>
  <svg width="400" height="230" style="margin-top:14px;overflow:visible">
    <g transform="translate(30,14)">
      ${axis(350, 190)}
      <path d="M14 190 L330 44" stroke="#1a1a19" stroke-width="2"/>
      <path d="M14 190 h64 v-30 h66 v-36 h70 v-26 h72 v-22" stroke="#8d8d8a" stroke-width="1.6" fill="none"/>
      <line x1="214" y1="98" x2="214" y2="152" stroke="#1a1a19" stroke-width="2.4"/>
      <circle cx="214" cy="98" r="3.5" fill="#1a1a19"/><circle cx="214" cy="152" r="3.5" fill="#1a1a19"/>
      <text x="226" y="130" font-size="15" fill="#1a1a19">대기(t)</text>
      <text x="200" y="212" font-size="15" fill="#1a1a19">t</text>
    </g>
  </svg>
  <p class="eq" style="margin:16px 0 0">대기(t) = λ · (t − t₀) − Σ 승차(t₀, t]</p>
  <p class="cap" style="margin-top:16px;max-width:400px">도착은 기울기 λ의 직선으로, 승차는 버스가 올 때만
    뛰는 계단으로 쌓인다. 두 곡선의 세로 간격이 그 순간 서 있는 사람 수다.</p>
</div>`;

/** 그림 3: 좌석이 0에서 잘린다 = 검열 */
const figCensor = () => `
<div class="fig" style="left:76px;top:660px;width:460px">
  <p class="tag">3 · 만석에서 잘리는 관측</p>
  <svg width="430" height="210" style="margin-top:14px;overflow:visible">
    <g transform="translate(34,10)">
      ${axis(360, 168)}
      <line x1="0" y1="20" x2="360" y2="20" stroke="#a8a8a5" stroke-width="1" stroke-dasharray="4 4"/>
      <text x="-28" y="24" font-size="14" fill="#6f6f6c">C</text>
      <text x="-26" y="172" font-size="14" fill="#6f6f6c">0</text>
      <text x="330" y="192" font-size="14" fill="#6f6f6c">정류장</text>
      <rect x="196" y="20" width="112" height="148" fill="#1a1a19" opacity="0.05"/>
      <path d="M10 34 C 84 60, 142 118, 196 168 L 308 168" stroke="#1a1a19" stroke-width="2" fill="none"/>
      <path d="M196 168 C 226 168, 250 168, 308 168" stroke="#1a1a19" stroke-width="6" opacity="0.12" fill="none"/>
      <circle cx="196" cy="168" r="4.5" fill="#1a1a19"/>
      <line x1="196" y1="168" x2="196" y2="20" stroke="#1a1a19" stroke-width="1" stroke-dasharray="4 4"/>
      <text x="204" y="52" font-size="15" fill="#6f6f6c">여기부터 관측이 멈춘다</text>
      <text x="204" y="76" font-size="15" fill="#8d8d8a">실제 수요는 계속 늘어난다</text>
    </g>
  </svg>
  <p class="eq" style="margin:14px 0 0">S⁺ = 0 → N ≥ S⁻</p>
  <p class="cap" style="margin-top:16px;max-width:420px">잔여석이 0이 되는 순간 관측은 우측검열된다.
    실제 수요는 그 아래로 계속 내려가지만 API는 0에서 멈춘다.</p>
</div>`;

/** 그림 4: 좌석 분포 전파 */
const figPropagate = () => `
<div class="fig" style="left:600px;top:660px;width:440px">
  <p class="tag">4 · 좌석 분포 전파</p>
  <svg width="400" height="200" style="margin-top:14px;overflow:visible">
    <g transform="translate(20,16)">
      ${[0, 1, 2].map((i) => `
        <g transform="translate(${i * 130},0)">
          ${[0, 1, 2, 3, 4].map((k) => {
            const h = [12, 30, 46, 30, 14][k] * (1 - i * 0.12) + i * 8;
            return `<rect x="${k * 15}" y="${150 - h}" width="11" height="${h}" fill="#1a1a19" opacity="${0.16 + k * 0.13}"/>`;
          }).join('')}
          <path d="M0 158 H 78" stroke="#a8a8a5" stroke-width="1.2"/>
          <text x="24" y="180" font-size="14" fill="#6f6f6c">k${i > 0 ? `+${i}` : ''}</text>
        </g>`).join('')}
      <path d="M92 96 H 118" stroke="#1a1a19" stroke-width="1.4"/>
      <path d="M118 96 l -6 -4 l 0 8 Z" fill="#1a1a19"/>
      <path d="M222 96 H 248" stroke="#1a1a19" stroke-width="1.4"/>
      <path d="M248 96 l -6 -4 l 0 8 Z" fill="#1a1a19"/>
    </g>
  </svg>
  <p class="eq" style="margin:14px 0 0">S⁺<span class="sub">r,k</span> = S⁻<span class="sub">r,k</span> + A<span class="sub">r,k</span> − B<span class="sub">r,k</span></p>
  <p class="cap" style="margin-top:16px;max-width:400px">점추정이 아니라 분포를 옮긴다. 정류장마다 순수요만큼
    왼쪽으로 밀리고, 0에서 잘리는 질량이 곧 만석 확률이다.</p>
</div>`;

export function mathCard({ w, h }) {
  return `
<div class="math" style="width:${w}px;height:${h}px">
  <p class="wm">빨간버스 <b>좌석 예보 모델</b></p>
  ${figLambda()}${figQueue()}${figCensor()}${figPropagate()}
  <div class="foot"><span class="dot"></span>
    <span>docs/04-queue-recovery.md · docs/03-boarding-model-v2.md</span></div>
</div>`;
}
