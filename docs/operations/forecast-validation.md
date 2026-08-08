# 예보 검증 운영 가이드

예보 검증은 서로 다른 두 질문에 답한다.

1. **모델 자체가 과거 데이터에서 기준선보다 나은가?**
2. **사용자가 실제로 본 예보가 당시 최신 데이터로 만들어졌고, 나중 관측과 맞았는가?**

첫 번째는 rolling-origin 백테스트가, 두 번째는 라이브 예측 채점이 맡는다. 백테스트만 통과하면
모델 계산은 맞아도 발행이 멈춘 문제를 놓칠 수 있다. 라이브 채점만 보면 실제 화면 경로는
검증하지만 대조할 수 있는 표본이 적다. 둘을 함께 봐야 한다.

## 검증 흐름

```text
비공개 data/routes + data/snapshots
        │
        ├─ rolling-origin 백테스트
        │    ├─ 테스트일 이전 날짜로만 학습
        │    └─ scorecard.json
        │
        └─ 실제 관측 ───────────────┐
                                     │
발행 때 기록한 predictions/*.jsonl ─┴─ 라이브 예측 채점
                                          └─ live-score.json

scorecard.json + live-score.json
        └─ Actions Step Summary, 90일 보관 아티팩트, 회귀 판정
```

자동 실행은 [`.github/workflows/verify-forecast.yml`](../../.github/workflows/verify-forecast.yml)에
있다. 매일 UTC 19:00, KST 04:00에 돌고 수동 실행도 지원한다. 이 시각은 전날 수집 브랜치가
`main`에 보관됐다는 가정으로 잡혀 있다. 예약 실행이 밀려 보관이 끝나지 않았다면 검증 입력도
비므로, 성적표가 없을 때는 데이터 날짜부터 확인한다.

## 필요한 데이터와 권한

자동 검증은 GitHub Actions Secret `BUS_DATA_REPO_TOKEN`으로 비공개 데이터 저장소를 읽는다.
마지막 단계에서 7일이 지난 예측 파일을 `predictions` 브랜치에서 지우므로 Contents 쓰기 권한도
필요하다.

| 경로 | 내용 | 공개 여부 |
|---|---|---|
| `data/routes/*.json` | 노선과 정류장 캐시 | 비공개 저장소만 |
| `data/snapshots/*.jsonl` | 가명 차량 ID와 잔여석 관측 | 비공개 저장소만 |
| `predictions/YYYY-MM-DD.jsonl` | 발행 당시 차량별 하류 1, 3, 6정류장 좌석 예보. 미정차 지점이 포함될 수 있고 최종 탑승 판정은 없음 | 비공개 `predictions` 브랜치만 |
| `scorecard.json` | 날짜별 집계와 누적 집계 지표 | Actions 아티팩트 |
| `live-score.json` | 집계 점수와 수집 공백 | Actions 아티팩트 |

원본 예측에는 가명 차량 ID가 들어가지만 `live-score.json`에는 개별 행이나 차량 ID를 싣지 않는다.
워크플로가 올리는 아티팩트도 두 집계 JSON뿐이다. 채점이 끝난 예측 파일은 7일이 지나면 지운다.

라이브 채점은 좌석 평균과 한 석 이상 남을 확률을 평가한다. 화면에서 미정차 지점을 거르는 동작과 만석 연속 수를 포함한 `여유`, `빠듯`, `어려움` 판정은 이 성적표의 검증 범위가 아니다.

## 로컬에서 검증하기

비공개 데이터 저장소를 이미 받아 둔 디렉터리를 사용한다. 토큰을 명령행에 넣지 않는다.

### rolling-origin 백테스트

```bash
npm ci
npm run backtest -- \
  --data-dir=/absolute/path/to/bus-seat-tracker-data/data \
  --json=scorecard.json
```

평일이 두 날짜 이상 있어야 폴드가 하나 생긴다. 첫 평일로 학습해 둘째 평일을 시험하고, 다음
폴드는 앞의 모든 평일로 학습해 그다음 평일을 시험한다. 테스트일 데이터는 프로파일 학습에
들어가지 않는다.

### 발행된 라이브 예측 채점

```bash
npm run score -- \
  --data-dir=/absolute/path/to/bus-seat-tracker-data/data \
  --predictions-dir=/absolute/path/to/predictions \
  --date=YYYY-MM-DD \
  --json=live-score.json
```

`--date`는 예측 파일 이름의 KST 날짜다. 생략하면 실행 시점의 KST 날짜를 쓴다. 자동 워크플로는
전날을 명시한다.

두 명령 모두 실행 전에 TypeScript를 빌드한다. 결과 파일 경로는 현재 디렉터리 기준이 아니라
절대 경로로 해석되므로, 다른 위치에 남기려면 정확한 경로를 준다.

## rolling-origin 성적표 읽기

현재 배포 조합은 `research/backtest/src/backtest.ts`의 `shippedModel`로 정한다. 구현상 값은
`deconv-arrival`이고 기준선 `baselineModel`은 `naive-persist`다. 모델을 바꿀 때는 이 상수만
고쳐서는 안 된다. 정적 번들을 만드는 `apps/web/scripts/build-data.ts`가 같은 프로파일과 귀속
규칙을 쓰는지 함께 확인해야 한다.

`scorecard.json`의 주요 필드는 아래 표에서 확인한다.

| 필드 | 뜻 |
|---|---|
| `generatedAt` | 성적표 생성 시각 |
| `shippedModel` | 현재 화면에 배포한다고 선언한 조합 |
| `baselineModel` | 회귀 판정의 비교 기준 |
| `pooled` | 모든 폴드를 합친 지표 |
| `folds[].testDate` | 해당 폴드의 테스트 날짜 |
| `folds[].trainDates` | 그 폴드 학습에 사용한 이전 날짜 |
| `pairs` | 같은 차량 운행에서 시작과 하류 관측을 대조한 수 |
| `fullCount` | 실제 도착 잔여석이 0인 관측쌍 수 |
| `models.*.mae` | 도착 좌석 절대오차 평균. 낮을수록 좋음 |
| `models.*.brier` | 만석 확률의 제곱오차 평균. 낮을수록 좋음 |
| `models.*.coverage` | 10~90% 예측구간 안에 실제값이 든 비율. 목표 80% |

MAE는 점추정이 있는 관측쌍만, coverage는 예측구간이 있는 관측쌍만 센다. 후보 중
`full-frequency`와 `conservative`는 좌석 점추정을 만들지 않으므로 MAE가 `null`일 수 있다.

### 자동 판정

| 조건 | 결과 | 이유 |
|---|---|---|
| 누적 배포 모델 MAE가 누적 기준선 이상 | 실패 | 좌석 점추정이 “그대로 유지”보다 낫지 않음 |
| 누적 배포 모델 Brier가 누적 기준선 이상 | 실패 | 만석 확률이 기준선보다 낫지 않음 |
| 최신 폴드 MAE와 Brier가 기준선 이상 | 경고 | 하루 표본은 작아 누적 판정을 바로 뒤집지 않음 |
| 누적 예측구간 포함률이 60% 미만 | 경고 | 목표 80%에서 크게 벗어남 |
| 평일 데이터가 두 날짜 미만 | 경고 후 종료 | 폴드를 만들 수 없음 |

최신 하루가 나빴다는 이유만으로 모델을 되돌리거나 임계값을 바꾸지 않는다. 같은 방향이 여러
폴드에서 이어지는지, 표본 수와 만석 수가 충분한지, 수집 공백이 있었는지 먼저 본다. 반대로 누적
지표 실패를 초록으로 만들려고 기준선 이름이나 비교 연산을 바꾸지 않는다.

## 라이브 예측 채점 읽기

발행 워크플로는 화면용 데이터를 만들 때 그 순간의 예측도 함께 기록한다. 기록 지평은 1, 3, 6
정류장이다. 다음 날 채점기는 같은 가명 차량이 예측 대상 정류장에 도착한 첫 관측을 찾는다.

- 예측 뒤 90분 안의 관측만 본다.
- 차량이 대상 정류장을 건너뛴 뒤에 다시 나타나면 대조하지 않는다.
- 정확히 대상 정류장에서 관측돼야 `scored`에 들어간다.
- 대조하지 못한 행은 `unmatched`로 남긴다.

`live-score.json`은 아래 값을 남긴다.

| 필드 | 뜻 |
|---|---|
| `predictions` | 발행 때 기록한 예측 행 수 |
| `scored` | 실제 도착 좌석과 대조한 수 |
| `matchRate` | `scored / predictions` |
| `staleBasis` | 더 새 관측이 있었는데도 30분 넘게 뒤처진 근거로 만든 예측 수 |
| `unknownBasis` | 예측의 출발 정류장과 좌석에 맞는 근거 관측을 찾지 못한 수 |
| `collectionGaps` | 시간대별 기대 간격을 넘긴 수집 공백 |
| `overall.mae` | 실제 발행 예보의 좌석 MAE |
| `overall.bias` | `예측 좌석 - 실제 좌석` 평균. 양수면 낙관 쪽 |
| `overall.boardableBrier` | 한 석 이상 남을 확률의 Brier 점수 |
| `byHorizon` | 1, 3, 6정류장별 같은 지표 |

`staleBasis`는 “예측 근거가 발행 시각에서 몇 분 전인가”를 그대로 세지 않는다. 발행 시점까지
도착해 있던 최신 관측과 실제로 쓴 근거를 비교한다. 그 차이가 30분을 넘을 때만 발행 파이프라인
문제로 판정한다. 새 관측 자체가 없었다면 발행이 고를 수 없었으므로 수집 공백으로 따로 센다.
운행 시간 밖의 발행도 신선도 판정에서 뺀다.

### 라이브 자동 판정

| 조건 | 결과 |
|---|---|
| `staleBasis > 0` | 실패 |
| 수집 공백 존재 | 경고 |
| 평일 `matchRate < 2%` | 경고 |
| 주말 `matchRate < 2%` | 안내만 표시 |
| 예측 브랜치나 대상일 기록 없음 | 라이브 채점 생략, 백테스트는 계속 |

낮은 대조율은 예측이 틀렸다는 뜻과 다르다. 관측 간격이 길어 버스가 대상 정류장을 지나친 경우가
많다는 뜻이다. 조밀 구간인데도 평일 대조율이 계속 낮다면 수집 간격과 차량 ID 연속성을 확인한다.

## 수집 공백과 발행 신선도

수집 공백은 관측 사이의 벽시계 시간이 아니라 **운행 시간에 포함되는 시간**만 센다. 심야 휴지
구간을 장애로 잘못 잡지 않기 위해서다. 허용치는 해당 구간에서 가장 성긴 기대 수집 간격의 두
배에 15분을 더한다.

```text
공백 허용치 = 가장 성긴 기대 간격 × 2 + 15분
```

현재 테스트가 고정한 대표값은 아래와 같다.

| 구간 | 기대 간격 | 공백 경고 기준 |
|---|---:|---:|
| 1분 조밀 구간 | 1분 | 17분 초과 |
| 20분 낮 창 | 20분 | 55분 초과 |
| 매시 단발과 주말 | 60분 | 135분 초과 |

경계를 가로지르면 그 구간에 포함된 가장 성긴 기대 간격을 쓴다. 예를 들어 조밀 구간에서 일반
구간으로 넘어가는 정상 관측을 1분 기준으로 오탐하지 않는다. 이 판정은
`tools/collector/src/schedule.ts`를 직접 불러오므로 수집 창과 같은 정의를 쓴다.

## 실패했을 때 보는 순서

### 누적 MAE 또는 Brier 실패

1. Step Summary에서 배포 모델과 기준선 이름이 예상과 같은지 본다.
2. `folds`의 날짜별 표본 수와 만석 수를 확인한다.
3. 같은 날짜의 `collectionGaps`와 수집 장애를 확인한다.
4. 프로파일과 귀속 규칙을 바꿨다면 화면 빌드와 백테스트가 같은 구현을 쓰는지 확인한다.
5. 원인을 설명할 수 있을 때만 모델 변경이나 되돌리기를 결정한다.

### `staleBasis` 실패

1. 해당 날짜 `predictions` 파일의 `at`과 공개 `latest.js`의 `generatedAt`을 비교한다.
2. 같은 시각 비공개 스냅샷에 더 새 `collectedAt`이 있었는지 본다.
3. `Publish seat board`가 당일 `collect/YYYY-MM-DD` 브랜치를 실제로 체크아웃했는지 로그에서 본다.
4. Pages와 Vercel 중 한쪽만 오래됐다면 Deploy Hook 경로를 확인한다.

### 수집 공백 경고

1. 경고의 `route`, `from`, `to`, `serviceMinutes`를 확인한다.
2. 그 시간대가 1분, 10분, 20분, 매시 중 어디인지 [수집 시간표](collector.md#자동-수집-시간표)와 대조한다.
3. **Collect bus seats** 실행이 늦었는지, 실패했는지, 한 노선만 빠졌는지 본다.
4. 이미 놓친 관측은 합성하지 않는다. 원인을 고친 뒤 다음 관측부터 정상화한다.

### 성적표가 없거나 라이브 채점이 생략됨

- `scorecard.json`이 없으면 평일 데이터가 두 날짜 이상인지와 `data/routes` 존재 여부를 본다.
- `live-score.json`만 없으면 `predictions` 브랜치와 전날 파일을 확인한다.
- 예측 브랜치 체크아웃 실패는 `continue-on-error`라 백테스트를 막지 않는다. 워크플로 전체가
  성공했더라도 라이브 검증이 수행됐다는 뜻은 아니다.

## 모델 변경 전 확인표

- [ ] `npm test`가 스케줄과 신선도 경계값을 통과한다.
- [ ] `npm run backtest -- --json=scorecard.json`에서 누적 MAE와 Brier가 기준선보다 낮다.
- [ ] 예측구간 포함률과 날짜별 표본 수를 함께 확인했다.
- [ ] `shippedModel`과 `build-data.ts`의 실제 배포 프로파일이 같은 조합이다.
- [ ] `npm run score`에서 `staleBasis`가 0이다.
- [ ] 수집 공백과 낮은 대조율을 모델 오차로 잘못 해석하지 않았다.
- [ ] 성적표의 수치를 문서에 옮길 때 생성일과 데이터 범위를 함께 적었다.

최근 성능 수치는 문서에 “현재값”으로 고정하지 않는다. Actions의 최신 `scorecard` 아티팩트와
Step Summary를 읽어 판단한다. 모델의 설계와 과거 검증 결과는
[`../design/boarding-model-v2.md`](../design/boarding-model-v2.md)와
[`../research/2026-07-24-seat-forecast-validation.md`](../research/2026-07-24-seat-forecast-validation.md)에서
확인할 수 있다.
