# bus-seat-tracker

경기도 직행좌석버스가 **내 정류장에 도착할 때 몇 석이 남을지** 계산하고 그 좌석으로 탈 수 있을지를 `여유`, `빠듯`, `어려움`으로 보여 주는 서비스다.

지도 앱이 알려 주는 값은 버스의 현재 잔여석이다. 중간 정류장 승객에게는 그 값만으로 부족하다. 버스가 오는 동안 앞 정류장에서 사람이 더 타고 내리며 내 앞에 선 대기자도 같은 좌석을 기다리기 때문이다. 이 프로젝트는 과거 좌석 흐름과 실시간 관측을 함께 사용해 도착 시점의 상태를 계산한다.

## 지금 제공하는 것

| 화면 출력 | 계산에 쓰는 정보 | 주의할 점 |
|---|---|---|
| 도착 예상 좌석 | 현재 차량의 좌석, 정류장별 순수요 프로파일 | 행사, 사고, 임시 배차처럼 학습 범위를 벗어난 날에는 오차가 커질 수 있다 |
| 탑승 판정 | 예상 좌석, 시간대 수요, 화면 데이터 생성 시점의 최근 만석 연속 횟수 | 실시간 조회는 만석 연속을 갱신하지 않으며, 개인 성공 확률이 아니라 보수적인 구간 판정이다 |
| 대기 범위 | 마지막 대기열 해소 시각, 정류장별 고정 도착률 | 아직 실험 기능이다. 날짜 간 안정성이 충분히 검증되지 않았다 |
| 상류 정류장 추천 | 같은 시간대의 정류장별 만석 관측 비율, 현재 버스의 판정 | 조건을 만족하면 `가세요`라고 표시하지만 이동 시간과 개인 성공 확률은 계산하지 않는다 |

관측이 없으면 0으로 채우지 않는다. 화면의 점선 테두리와 `표본 적음` 표시는 각각 직전 만석 상태를 보지 못했거나 학습 자료가 얇다는 뜻이다.

## 실행 구조

```text
GBIS API
  ├─ tools/collector ──> 비공개 JSONL 저장소
  │                         │
  │                         └─ apps/web/scripts/build-data.ts
  │                                      │
  │                                      └─ 화면용 latest/history/profile
  │
  └─ /api/live ──> apps/api ──> 브라우저의 최신 좌석 덮어쓰기

브라우저 ──> packages/domain ──> 좌석 전파, 탑승 판정, 대기 범위 계산
연구 도구 ──> research/backtest ──> 같은 도메인 코드로 백테스트와 사후 분석
```

브라우저와 백테스트는 같은 `packages/domain`의 프로파일 조회와 분포 전파를 사용한다. 실행 경로가 완전히 같지는 않다. 화면과 발행 예측 로그는 정류장당 2분을 더해 각 정류장의 시간 버킷을 고르지만, 과거 rolling-origin 백테스트는 관측된 도착점 버킷 하나를 구간 전체에 쓴다. 따라서 2026-07-24 수치는 좌석 모델의 과거 재현 성능이지 화면 경로 전체의 보증값이 아니다. 대기 범위와 개인 이동 추천도 별도의 검증 과제로 남아 있다.

자세한 모듈 경계는 [아키텍처 문서](docs/architecture.md)에 정리했다.

## 저장소 구조

```text
apps/
  web/                  정적 화면, 화면 데이터 생성, 사이트 조립
  api/                  실시간 좌석과 피드백 HTTP 처리
api/                    Vercel 파일시스템 라우트 어댑터
packages/domain/        좌석, 수요, 대기열 도메인 규칙
tools/collector/        GBIS 수집기와 수집 스케줄
research/backtest/      좌석 예보 검증과 대기열 복원 분석
research/analytics/     재방문 집계
design/                 화면 시안과 소개 카드
docs/                   제품, 모델, 연구, 운영 문서
```

루트 `api/`에는 구현을 두지 않는다. Vercel이 `/api/*`를 함수로 인식하도록 진입점만 남기고 요청 처리 코드는 `apps/api`에 둔다.

## 개발 환경 준비

Node.js 22가 필요하다.

```bash
npm install
npm run typecheck
npm test
```

이 세 명령은 API 키나 수집 데이터 없이 실행할 수 있다.

### 수집기 실행

```bash
cp tools/collector/.env.example tools/collector/.env
# tools/collector/.env에 GYEONGGI_BUS_API_KEY와 VEHICLE_HASH_SECRET 입력
npm run collect -- --once
```

기본 데이터 경로는 저장소 루트의 `data/`다. 운영에서는 `BUS_DATA_DIR`로 비공개 데이터 저장소의 `data/`를 명시한다. 실제 API 호출은 일일 한도를 사용하므로 구조 확인 목적으로 반복 실행하지 않는다.

### 웹 사이트 생성

이미 받아 둔 수집 데이터가 있다면 다음처럼 만든다.

```bash
BUS_DATA_DIR=/absolute/path/to/data npm run build:site
python3 -m http.server 8000 --directory site
```

브라우저에서 `http://localhost:8000`을 연다. 기존 공개 주소인 `/prototype-bus/`도 루트 화면으로 이동하도록 호환 페이지를 생성한다.

## 주요 명령

| 명령 | 하는 일 | 외부 입력 |
|---|---|---|
| `npm run typecheck` | JavaScript를 만들지 않고 타입 검사 | 없음 |
| `npm test` | API 거부 경로, 수집 스케줄, 예측 신선도 테스트 | 없음 |
| `npm run budget` | 현재 수집 창과 API 캐시를 기준으로 일 호출량 계산 | 없음 |
| `npm run collect -- --once` | 두 노선 좌석을 한 번 수집 | GBIS 키 |
| `npm run build:data` | 원천 JSONL을 화면용 데이터로 변환 | `data/` 또는 `--data-dir` |
| `npm run build:site` | 데이터 생성부터 `site/` 조립까지 실행 | `BUS_DATA_DIR` 또는 저장소 토큰 |
| `npm run backtest` | 날짜 순서 좌석 예보 백테스트 | 수집 데이터 |
| `npm run queue` | 대기열 사후 복원과 날짜별 λ 분석 | 수집 데이터 |
| `npm run score` | 발행 당시 예보를 이후 관측과 대조 | 수집과 예측 로그 |
| `npm run retention` | 익명 방문 이벤트의 재방문 집계 | Neon 연결 문자열 |

## 검증 결과를 읽는 법

2026-07-20~24 자료로 만든 4개 rolling-origin 폴드에서 구간합 역산 모델은 다음 결과를 냈다.

| 지표 | 역산 모델 | 좌석 유지 기준선 |
|---|---:|---:|
| 도착 좌석 MAE | 4.19석 | 7.04석 |
| 만석 Brier | 0.0462 | 0.0824 |
| 예측구간 포함률 | 74.9% | 해당 없음 |

이 표는 [2026-07-24 좌석 예보 검증 기록](docs/research/2026-07-24-seat-forecast-validation.md)의 고정된 결과다. 이후 자동 검증의 표본과 모델 조합은 달라질 수 있으므로 숫자를 섞어 최신 성능처럼 쓰지 않는다. 현재 모델 설명은 [좌석 예보](docs/model/seat-forecast.md)에서 확인할 수 있다.

## 데이터 경계

- API 키, 원문 차량번호, 수집 JSONL, 현장 기록은 공개 저장소에 넣지 않는다.
- 수집기는 차량 ID를 별도 비밀값으로 HMAC 가명화한다.
- `/api/live`는 필요한 좌석 필드만 통과시키며 차량번호와 원본 차량 ID를 내보내지 않는다.
- 화면의 방문 계측은 무작위 방문자 ID와 시각을 사용한다. 개인정보 처리 범위는 `apps/web/public/legal.html`에 적혀 있다.

## 문서

[문서 안내](docs/README.md)는 목적에 따라 읽을 순서를 나눈다.

- 제품 문제와 검증: [제품 개요](docs/product/overview.md), [문제 검증](docs/product/problem-validation.md)
- 현재 모델: [수학 입문서](docs/model/mathematical-primer.md), [개념 안내](docs/model/concepts.md), [좌석 예보](docs/model/seat-forecast.md), [탑승 판정](docs/model/boarding-verdict.md), [대기 범위](docs/model/queue-estimation.md)
- 구조와 운영: [아키텍처](docs/architecture.md), [배포](docs/operations/deployment.md), [수집기 운영](docs/operations/collector.md)
- 실험 근거: [연구 기록](docs/research/)

폐기된 설계와 이전 작업 일지는 `docs/archive/`에 보관한다. 현재 동작을 확인할 때는 보관 문서를 근거로 쓰지 않는다.
