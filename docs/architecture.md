# 아키텍처

이 저장소는 한 번에 실행되는 단일 서버가 아니다. 좌석 데이터를 모으는 수집 경로, 정적 화면을 만드는 발행 경로, 사용자가 화면을 열었을 때 동작하는 요청 경로가 나뉘어 있다. 세 경로는 `packages/domain`의 자료형과 모델 규칙을 함께 쓴다.

## 전체 흐름

```text
수집·발행

GBIS API
   │
   ▼
tools/collector ──> 비공개 데이터 저장소 ──> apps/web/scripts/build-data.ts
                         JSONL                       │
                                                     ▼
                                  latest / history / profile / daily
                                                     │
                                  TypeScript 빌드 ───┤
                                                     ▼
                                                   site/

사용자 요청

브라우저 ──> 정적 파일과 빌드 시점 스냅샷
   │
   ├── GET /api/live ──> apps/api ──> GBIS API
   │
   └── POST /api/feedback ──> apps/api ──> Neon Postgres
```

수집 데이터와 실시간 응답은 쓰임이 다르다. 수집 데이터는 프로파일 학습과 과거 통계에 필요하고, 실시간 응답은 지금 운행 중인 차량의 좌석을 덮어쓰는 데 쓴다. 실시간 조회가 실패하거나 응답이 오래되면 화면은 빌드 시점 스냅샷으로 돌아간다.

## 런타임 흐름

### 1. 수집

`tools/collector/src/collector.ts`가 GBIS에서 노선 정보와 차량 위치를 읽는다.

1. `GYEONGGI_BUS_API_KEY`로 노선 ID와 정류장 목록을 조회한다.
2. 정류장 목록은 기본 24시간 동안 `data/routes/`에서 재사용한다.
3. 차량 번호나 원본 차량 ID는 `VEHICLE_HASH_SECRET`으로 HMAC 가명화한다.
4. 노선별 차량 위치와 잔여석을 `data/snapshots/<노선>-<날짜>.jsonl`에 덧붙인다.
5. GitHub Actions가 결과를 비공개 데이터 저장소의 당일 수집 브랜치에 올린다.

수집 간격은 `tools/collector/src/schedule.ts`에 있다. 수집 워크플로, 호출 예산 계산기, 라이브 예측 채점기가 이 규칙을 같이 쓴다. 워크플로 안에 같은 시간표를 다시 적지 않는 이유는 경계 시각과 호출 횟수가 서로 어긋나는 일을 막기 위해서다.

### 2. 데이터 빌드와 사이트 조립

`apps/web/scripts/build-data.ts`는 비공개 JSONL을 브라우저가 바로 읽을 수 있는 네 개의 스크립트로 바꾼다.

| 파일 | 내용 | 화면에서 읽는 시점 |
|---|---|---|
| `latest.js` | 노선·정류장과 마지막 차량 스냅샷, 생성 시점 기준 최근 90분 만석 연속 수 | 첫 화면 전에 동기 로드 |
| `history.js` | 정류장·30분 구간별 관측 수와 만석 횟수 | 첫 화면 뒤 지연 로드 |
| `profile.js` | 정류장·30분 구간별 순수요 프로파일 | 첫 화면 뒤 지연 로드 |
| `daily.js` | 날짜·정류장·시간대별 좌석 집계 | 산출은 하지만 현재 앱은 직접 읽지 않음 |

공개 파일에는 가명화한 차량 ID도 넣지 않는다. `latest.js`의 차량 ID는 항상 `null`이고, 라이브 응답에서도 차량 번호와 원본 ID를 제거한다.

사이트는 다음 순서로 만들어진다.

1. `npm run build`가 TypeScript를 `dist/`에 컴파일한다.
2. `npm run build:data`가 화면용 데이터 스크립트를 `apps/web/public/data/`에 만든다.
3. `npm run assemble:site`가 공개 HTML, 데이터 스크립트, 웹 실행 파일, 도메인 모듈을 `site/`로 복사한다.

`apps/web/src/app.ts`가 브라우저에서 `packages/domain`을 직접 가져오기 때문에 `assemble-site.mjs`는 웹 실행 파일뿐 아니라 컴파일된 도메인 모듈도 같은 상대 경로로 복사한다. 예전 `/prototype-bus` 주소는 `site/prototype-bus/`의 리디렉션 파일로 유지한다.

Vercel에서는 `npm run build:site`가 위 세 단계를 묶어 실행한다. `BUS_DATA_DIR`가 있으면 로컬 데이터를 쓰고, 없으면 `BUS_DATA_REPO_TOKEN`으로 비공개 저장소를 임시 디렉터리에 받는다. 당일 수집 브랜치가 있으면 그 브랜치를, 아직 없으면 `main`을 사용한다. 권한이나 네트워크 오류가 났을 때는 낡은 데이터로 조용히 배포하지 않고 빌드를 실패시킨다.

### 3. 브라우저

브라우저는 `apps/web/public/index.html`에서 `latest.js`를 먼저 읽고 `dist/apps/web/src/app.js`를 실행한다.

1. 마지막 스냅샷만으로 노선 축을 먼저 그린다.
2. `history.js`와 `profile.js`를 뒤에서 받아 예보와 정류장 추천을 계산한다.
3. 탭이 보이는 동안 30초마다 `/api/live?route=<노선>`을 호출한다.
4. 실시간 응답이 180초 안쪽이면 화면의 차량 좌석을 덮어쓴다.
5. 응답이 오래됐거나 요청에 실패하면 마지막 정적 스냅샷을 계속 보여 준다.

좌석 예보는 브라우저에서 계산한다. `packages/domain/src/forecast.ts`가 현재 차량의 잔여석 분포에 정류장별 순수요를 차례로 적용하고, 예상 도착 좌석과 시간대 수요, 화면 데이터 생성 시점에 계산한 만석 연속 수를 `boardingVerdict`에 넘긴다. `/api/live`는 차량 위치와 좌석만 덮어쓰며 만석 연속 수를 다시 계산하지 않는다.

화면과 정적 예측 로그는 같은 `forecastVehicleStops`를 호출한다. 둘 다 `travel-time.ts`의 정류장당 2분 가정으로 시간 버킷을 고른다. rolling-origin 백테스트는 `profile.ts`와 `boarding.ts`의 하위 규칙을 공유하지만 실제 도착 관측의 30분 버킷 하나를 구간 전체에 사용한다. 과거 백테스트와 실제 발행 예측 채점을 따로 운영하는 이유다.

공유 함수를 호출한다고 최종 출력까지 같은 것은 아니다. 발행 로그는 `generatedAt`을 기준으로 미정차 지점을 포함한 하류 1·3·6정류장의 좌석 값과 저신뢰 여부만 남긴다. 화면은 열어 본 시각을 기준으로 다시 계산하고 미정차 지점은 배지에서 제외하며, `latest.js`의 만석 연속 수를 더해 탑승 판정을 보여 준다. 따라서 발행 로그 채점은 좌석 예보 파이프라인을 검증하지만 화면의 최종 판정 전체를 검증하지는 않는다.

승차 정류장 추천의 표본·만석률 임계값과 상류 후보 선택은 `recommendation.ts`에 있다. 대기열의 해소 시각 추론과 60분 제한은 `queue.ts`가 맡는다. `app.ts`에는 선택값, 현재 시각, 세션 동안 추적한 해소 시각을 도메인 함수에 넘기고 결과를 화면 문구로 바꾸는 역할만 남긴다.

목적지, 승차 정류장, 현장 기록, 무작위 방문자 ID는 브라우저의 `localStorage`에 저장한다. 현재 위치는 네이버지도 링크를 만들 때만 사용하며 서비스 서버로 보내지 않는다.

### 4. 서버리스 API

`apps/api/src/handlers/live.ts`는 허용된 노선만 GBIS로 전달한다. 요청 경로와 쿼리 문자열을 정확히 제한해 CDN 캐시 키를 늘리는 변형 요청을 막고, 성공 응답은 120초 동안 공유 캐시한다. 이 시간은 화면 새로고침 속도가 아니라 공공 API의 일일 호출 한도에서 정한 값이다.

`apps/api/src/handlers/feedback.ts`는 익명 방문과 설문을 Neon Postgres에 저장한다. 화면 기능과 계측은 분리되어 있어서 DB가 없거나 저장에 실패해도 좌석 화면은 계속 동작한다.

## 디렉터리 책임

| 경로 | 책임 | 두지 않는 것 |
|---|---|---|
| `api/` | Vercel이 찾는 함수 진입점 | 요청 검증, 외부 API 호출, 도메인 규칙 |
| `apps/api/` | 실시간 조회와 피드백 서버리스 핸들러 | 브라우저 UI, 배치 수집 |
| `apps/web/public/` | HTML, 법적 고지, 빌드된 화면 데이터 | 원본 JSONL, 비밀값 |
| `apps/web/src/` | 브라우저 상태, 렌더링, 폴링, 길찾기 연결 | 모델 학습 로직, GBIS 인증키 |
| `apps/web/scripts/` | 데이터 변환과 배포용 정적 사이트 조립 | 사용자 요청 처리 |
| `packages/domain/` | 공용 자료형, 입력 검증, 프로파일, 좌석 예보, 탑승 판정, 정류장 추천, 대기 인원 계산 | 파일 I/O, 환경변수, HTTP 핸들러, DOM |
| `tools/collector/` | GBIS 배치 수집, 수집 시간표, 호출 예산 | 공개 사이트 생성, 연구 보고서 |
| `research/` | 백테스트, 라이브 예측 채점, 대기 인원 복원, 재방문 분석 | 서비스 런타임 진입점 |
| `.github/workflows/` | 수집·발행·검증 작업의 실행 순서와 외부 저장소 연동 | 모델 공식의 별도 구현 |
| `docs/` | 현재 설계, 연구 근거, 운영 절차, 보관 기록 | 빌드 산출물과 원본 데이터 |
| `design/` | 화면·브랜드 시안과 카드 생성 도구 | 서비스 런타임 코드 |

`data/`, `dist/`, `apps/web/public/data/`, `site/`는 다시 만들 수 있는 로컬 산출물이거나 비공개 데이터이므로 저장소에 포함하지 않는다.

## 의존 방향

```text
api/* ───────────────> apps/api/handlers
                           │
apps/web ─────────────┐    │
tools/collector ──────┼────┼──> packages/domain
research/backtest ────┘    │
                           └──> 외부 서비스(GBIS, Neon)

packages/domain ──> 같은 패키지 안의 모듈만
```

의존 관계는 바깥 진입점에서 안쪽 규칙으로 향한다.

- `packages/domain`은 앱, 수집기, 연구 도구를 알지 못한다.
- 웹과 백테스트는 서로를 가져오지 않고 같은 도메인 함수를 각각 호출한다.
- 서버 핸들러는 DOM이나 정적 빌드 코드를 가져오지 않는다.
- 연구 도구는 수집 자료를 읽을 수 있지만 서비스 런타임의 진입점이 되지 않는다.
- `score-predictions.ts`가 `tools/collector/src/schedule.ts`를 가져오는 것은 수집 공백을 같은 시간표로 판정하기 위한 예외다. 새로운 공용 정책이 늘어나면 `packages`로 옮길지 먼저 검토한다.

### Vercel 루트 `api/`가 필요한 이유

Vercel은 프로젝트 루트의 `api/`를 서버리스 함수 위치로 찾는다. 구현을 `apps/api/`로 옮기기만 하면 `/api/live`와 `/api/feedback`이 배포되지 않는다. 그래서 루트 파일은 기본 내보내기만 다시 내보낸다.

```ts
export { default } from '../apps/api/src/handlers/live.js';
```

이 파일은 플랫폼 규칙과 저장소 구조를 잇는 어댑터다. 로직을 넣지 않아야 로컬 테스트가 실제 핸들러를 바로 검증할 수 있고, 다른 호스팅 환경으로 옮길 때도 어댑터만 바꿀 수 있다. 새 API를 추가할 때는 `apps/api/src/handlers/`에 구현하고 루트 `api/`에는 같은 이름의 한 줄 어댑터를 둔다.

## 데이터 경계

### 수집 데이터

```text
GBIS 원본 차량 식별자
  └─ HMAC 가명화
       └─ 비공개 JSONL
            ├─ 프로파일·백테스트 입력
            └─ 공개 빌드 시 식별자 제거
```

- `GYEONGGI_BUS_API_KEY`와 `VEHICLE_HASH_SECRET`은 수집 환경에만 둔다.
- 원본 차량 번호와 차량 ID는 파일에 쓰기 전에 가명화한다.
- 가명 ID가 남는 원본 스냅샷과 라이브 예측 로그는 비공개 저장소 밖으로 내보내지 않는다.
- 공개 데이터에는 노선 식별자, 정류장 이름·순번·좌표, 마지막 스냅샷의 차량 위치·잔여석·혼잡도·상태, 시각 구간별 좌석 집계와 프로파일을 넣는다. 차량 식별자는 제거한다.

### 실시간 데이터

브라우저는 노선 번호만 `/api/live`로 보낸다. 서버가 환경변수의 키로 GBIS를 호출한 뒤 화면에 필요한 위치 순번, 잔여석, 혼잡도, 상태만 돌려준다. 차량 번호와 원본 ID는 `apps/api/src/gbis-client.ts`에서 읽지 않고 버린다.

### 피드백 데이터

브라우저가 만든 무작위 `visitorId`와 사용자가 직접 입력한 설문만 `/api/feedback`으로 보낸다. 핸들러는 필드 길이를 제한하고 `DATABASE_URL`로 Neon에 저장한다. 방문·설문 저장 실패는 화면 렌더링이나 실시간 조회에 영향을 주지 않는다.

## 변경할 때 확인할 곳

| 바꾸려는 것 | 함께 확인할 파일·명령 |
|---|---|
| 순수요 추정이나 좌석 전파 | `packages/domain/src/profile.ts`, `forecast.ts`, `travel-time.ts`, `apps/web/scripts/build-data.ts`, `research/backtest/src/backtest.ts`; `npm test`와 `npm run backtest`로 배포 조합과 기준선 비교 |
| 여유·빠듯·어려움 판정 | `packages/domain/src/boarding.ts`, 화면 문구, 대기 복원 검증; `npm test`와 필요하면 `npm run queue -- --verdict` |
| 승차 정류장 추천 | `packages/domain/src/recommendation.ts`, `apps/web/src/app.ts`의 문구와 선택 상태; `npm test` |
| 대기 인원이나 해소 시각 | `packages/domain/src/queue.ts`, `travel-time.ts`, `apps/web/src/app.ts`의 세션 상태; `npm test`와 필요하면 `npm run queue` |
| 공개 데이터 형식 | `packages/domain/src/model.ts`의 자료형·리더, `build-data.ts`, `apps/web/src/app.ts`; 새 데이터로 `npm run build:site` |
| 수집 시간대나 간격 | `tools/collector/src/schedule.ts`, `.github/workflows/collect-bus-seats.yml`, `apps/web/src/app.ts`의 신선도 구간; `npm test`, `npm run budget` |
| 실시간 캐시 시간 | `apps/api/src/handlers/live.ts`, `tools/collector/scripts/call-budget.mjs`, 운영 문서; `npm run budget` |
| 지원 노선 | `apps/api/src/gbis-client.ts`의 `allowedRoutes`, 수집기의 `ROUTE_NAMES`, 예산 계산기의 `routeCount`, 화면용 데이터; 허용·거부 API 테스트 |
| API 경로나 핸들러 | `apps/api/src/handlers/`, 루트 `api/` 어댑터, `vercel.json`, 브라우저 호출 경로; `npm test` |
| 디렉터리 이동 | `tsconfig.json`, `package.json` 스크립트, `assemble-site.mjs`, `build-site.mjs`, 워크플로, HTML의 모듈 경로, Vercel 어댑터 |
| 공개 범위나 식별자 | 수집기의 가명화, `buildLatestRoute`, `readLiveVehicles`, `gbis-client.ts`, `legal.html`; 생성된 `site/`에 키·차량 ID가 없는지 확인 |
| 배포 방식 | `vercel.json`, `apps/web/scripts/build-site.mjs`, `assemble-site.mjs`, `.github/workflows/publish-pages.yml`; 두 배포가 같은 `site/` 구성을 쓰는지 확인 |

구조를 바꾼 뒤 최소 확인 순서는 다음과 같다.

```bash
npm run typecheck
npm test
npm run budget
BUS_DATA_DIR=/absolute/path/to/data npm run build:site
```

`build:site`까지 통과해야 컴파일 성공뿐 아니라 비공개 데이터 입력, 브라우저 데이터 생성, 정적 파일 조립까지 확인한 것이다. 모델을 바꿨다면 여기에 `npm run backtest -- --data-dir=/absolute/path/to/data`를 더한다.
