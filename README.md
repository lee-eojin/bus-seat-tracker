# bus-seat-tracker

경기도 직행좌석버스가 **내 정류장에 도착할 때 몇 석 남아 있을지**를 예보하고 그 좌석으로 탈 수 있을지를 판정하는 프로젝트다.

직행좌석버스는 입석이 없다. 좌석이 0이면 그 버스는 그냥 지나간다. 그래서 "지금 몇 석"이 아니라 "내 앞에 설 때 몇 석"이 필요하다. 남은 좌석보다 **내 앞에 몇 명이 서 있느냐**가 더 중요할 때가 많다.

기존 지도 앱은 현재 잔여석만 보여 준다. 이 프로젝트가 더 하는 일:

| | |
|---|---|
| **도착 시점 좌석 예보** | 상류 정류장의 승하차를 전파해 도착 시점 좌석 분포를 낸다 |
| **탑승 가능성 판정** | 예상 좌석과 그 시간대 수요, 직전 버스들의 만석 여부를 함께 보고 여유·빠듯·어려움으로 답한다 |
| **어디서 탈지** | 만차 전에 탈 수 있는 상류 정류장을 노선 축 위에서 제시한다 |

관측이 부족한 구간에서는 예측을 내지 않고 그렇다고 표시한다. 틀린 확신보다 보류가 낫다.

## 어떻게 도는가

```
GBIS API ──> collector ──> bus-seat-tracker-data (비공개, JSONL)
                                   │
                    build-data ────┤  프로파일·히스토리·최신 스냅샷을 브라우저 번들로
                                   │
        정적 화면 ─────────────────┘
             │
             └── /api/live (서버 프록시) ──> GBIS 실시간 잔여석
```

화면의 예보 계산은 브라우저에서 돈다. 서버는 GBIS 키를 감추는 프록시 하나뿐이다.

## 모델

좌석 관측은 수요가 아니라 **공급의 그림자**를 본다. 만석 버스가 지나가면 못 탄 사람은 데이터에 남지 않는다. 이 검열(censoring)을 다루는 것이 모델의 중심이다.

- **순수요 프로파일**: 구간합으로만 관측되는 승하차를 정류장 단위로 역산한다 (`shared/profile.ts`, ridge 좌표하강)
- **좌석 분포 전파**: 점추정이 아니라 분포를 상류에서 하류로 옮긴다. 좌석 상한에서 잘리는 것이 곧 검열이다
- **대기 인원 복원**: 좌석을 남기고 떠난 버스는 그 순간 줄이 비었다는 뜻이다. 이 해소 사건들 사이의 보존식으로 도착률을 식별한다 (`docs/queue-recovery.md`)

### 검증된 성과 (`docs/validation-2026-07-24.md`)

| 지표 | 이 모델 | 기준선 |
|---|---|---|
| 도착 좌석 MAE | **4.34석** | naive-persist 6.91 |
| 만석 Brier | **0.046** | 만석빈도 0.070 / naive 0.083 |
| 예측구간 포함률 | 74.9% | 목표 80% — 구간이 좁다 |

대기 인원 복원은 2026-07-24 저녁 판교역에서 좌석 데이터만으로 **36.3~55.0명** 구간을 냈다. 같은 시각 현장 실측 하한은 38명이었다. 필드 기록은 계산에 넣지 않았다.

다만 **대기 인원 예측기는 아직 서비스에 쓰지 않는다.** 도착률의 날짜 간 분산을 측정하지 못했다. 사후 재구성만 가능하다 (`docs/queue-recovery.md` §7, §11).

## 시작하기

Node.js 22 이상.

```bash
npm install
cp bus-seat-collector/.env.example bus-seat-collector/.env
# GYEONGGI_BUS_API_KEY 입력

npm run collect -- --once
npm run build:data
open prototype-bus/index.html
```

| 명령 | 하는 일 |
|---|---|
| `npm run typecheck` | 산출물 없이 타입 검사 |
| `npm test` | 수집 스케줄 경계값 테스트 |
| `npm run budget` | 호출 예산 계산. 한도를 넘으면 종료 코드 1 |
| `npm run build` | `dist/`에 JavaScript |
| `npm run backtest` | rolling-origin 백테스트 |
| `npm run score` | 발행된 라이브 예측을 나중 관측과 대조 |
| `npm run queue` | 대기 인원 복원 (`--all-stops`, `--verdict`) |
| `npm run build:site` | 배포용 정적 번들 → `site/` |

## 실시간 좌석

`GET /api/live?route=3330`

```json
{ "routeName": "3330", "routeId": "204000057", "apiQueryTime": "2026-07-28 13:30:36.426",
  "vehicles": [{ "currentStopSequence": 12, "remainingSeats": 7,
                 "crowded": 1, "status": 0 }] }
```

GBIS 인증키는 서버 환경변수에만 있고 브라우저로 내려가지 않는다. 응답에서 차량번호(`plateNo`)와 원본 차량 ID(`vehId`)는 제거된다. 조회 가능한 노선은 `server/gbis.ts`의 화이트리스트뿐이고 그 밖은 400이다. 프록시가 실패하면 화면은 수집 스냅샷으로 되돌아간다.

캐시는 `s-maxage=120`이다. **일 호출 한도 1,000회가 이 서비스의 구속 제약**이라 노선당 2분에 1회가 상한이다 (`DEPLOY.md` §6). 이 값을 낮추기 전에 예산부터 다시 계산한다.

## 수집

`.github/workflows/collect-bus-seats.yml` — 평일 통근 피크(06:30~10:00, 17:30~20:30)는 10분 간격 루프에 절정 구간만 1분, 낮(10:00~16:00)은 20분 간격, 그 밖의 운행 시간대는 매시 1회, 심야에는 쉰다. 낮이 창인 이유는 60분 간격 관측이 순수요 학습의 운행 분할 기준(45분)에 전부 걸려 관측쌍을 하나도 만들지 못했기 때문이다. 수요일 13:00~13:30만 2분 간격으로 찍어 구간합 역산의 정답을 만든다 — 낮은 만석이 없어 좌석 차이가 곧 순수요다. 스냅샷은 `bus-seat-tracker-data` 비공개 저장소의 `collect/YYYY-MM-DD` 브랜치에 쌓는다. 다음 날 첫 수집이 전날 브랜치를 `main`의 단일 아카이브 커밋으로 넘긴 뒤 지운다.

필요한 GitHub Actions Secrets:

| 이름 | 용도 |
|---|---|
| `GYEONGGI_BUS_API_KEY` | 공공데이터포털 인증키 |
| `VEHICLE_HASH_SECRET` | 차량 가명화용. API 키와 분리한 임의의 긴 값 |
| `BUS_DATA_REPO_TOKEN` | `bus-seat-tracker-data` Contents **읽기·쓰기** PAT |

`BUS_DATA_REPO_TOKEN`은 Vercel에도 같은 이름으로 들어가지만 그쪽은 **읽기 권한만** 있으면 된다. PAT를 재발급하면 옛 값이 즉시 죽으니 쓰는 곳을 모두 갱신한다 (`DEPLOY.md` §3).

## 구성

```
bus-seat-collector/collector.ts   GBIS 수집기. 차량 ID는 HMAC 가명화
bus-seat-collector/schedule.ts    수집 창과 간격. 워크플로와 예산 계산기가 같이 쓴다
shared/model.ts                   도메인 모델. 승차 불가 지점 판정
shared/profile.ts                 순수요 프로파일, 구간합 역산, 좌석 분포 전파
shared/boarding.ts                탑승 가능성 판정. 화면과 백테스트가 같은 규칙을 쓴다
prototype-bus/build-data.ts       JSONL을 브라우저 데이터 번들로
prototype-bus/app.ts              노선 축 UI, 추천, 길찾기
backtest/backtest.ts              rolling-origin 백테스트
backtest/queue-recovery.ts        대기 인원 복원
backtest/score-predictions.ts     라이브 예측 채점
backtest/data-source.ts           스냅샷과 노선 캐시 로더
server/gbis.ts                    GBIS 클라이언트 (서버 전용)
api/live.ts                       Vercel 함수
scripts/build-site.mjs            배포용 번들 조립
scripts/call-budget.mjs           호출 예산 계산기
```

예보 모델은 `shared/profile.ts` 한 곳에만 있다. 화면과 백테스트와 정적 예측이 모두 이 구현을
거치므로 백테스트가 잰 오차가 사용자가 보는 예보를 그대로 보증한다.

### 승차할 수 없는 정류장

GBIS는 톨게이트·분기점처럼 노선이 지나가기만 하는 지점을 정류장 목록에 함께 내려주고 이름 끝 표기로만 구분한다. **이 표기는 바뀐다** — 2026-07 중 `(경유)` → `(미정차)`로 관측됐다. 한쪽만 보던 코드는 조용히 아무것도 걸러 내지 못했다.

판정은 `shared/model.ts`의 `isNonBoardingStop` 한 곳에서만 한다. 표기가 또 바뀌면 수집기가 경고한다.

## 데이터 경계

공개 저장소에는 API 키, 원문 차량 번호, 수집 데이터, 빌드 산출물을 넣지 않는다. 원본 스냅샷은 `bus-seat-tracker-data`에만 두고 화면에도 차량 번호와 가명화 ID를 내보내지 않는다.

## 문서

배포와 운영은 `DEPLOY.md`에 있다. 나머지 문서는 `docs/`에 모여 있고 읽는 순서와 각 문서의 지위는 [docs/README.md](docs/README.md)가 안내한다.

## 브랜치

`main`이 검증된 기준선이고 수집 워크플로 스케줄은 여기서만 작동한다. 작업은 `feature/*`에서 하고 PR로 `main`에 되돌아온다.
