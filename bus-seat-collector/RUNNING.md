# 수집 운영 기록

## 데이터 경계

- 공개 `bus-seat-tracker`: 수집기 코드와 워크플로만 보관한다.
- 비공개 `bus-seat-tracker-data`: `data/routes`, `data/snapshots`만 보관한다. 당일 수집은 `collect/YYYY-MM-DD` 브랜치에 누적하고, 다음 날 첫 수집에서 날짜당 한 커밋으로 `main`에 반영한다.
- 공개 화면에는 차량 번호, HMAC 차량 ID, 원본 스냅샷을 전달하지 않는다.

## 시작 전 설정

GitHub Actions Secrets에 다음 값을 등록한다.

| 이름 | 역할 |
|---|---|
| `GYEONGGI_BUS_API_KEY` | 공공데이터포털 일반 인증키 |
| `VEHICLE_HASH_SECRET` | 차량 식별자 가명화를 위한 고정 비밀값 |
| `BUS_DATA_REPO_TOKEN` | `bus-seat-tracker-data`에만 Contents 읽기·쓰기가 가능한 fine-grained PAT |

`VEHICLE_HASH_SECRET`은 API 키와 별개로 유지한다. API 키를 재발급해도 같은 차량의 가명 ID가 유지되고, API 키 유출이 과거 가명 ID 대조로 이어지는 일을 막는다.

## 가동 절차

1. `main`에 `collect-bus-seats.yml`을 반영한다.
2. Actions에서 **Collect bus seats**를 수동 실행한다.
3. 비공개 저장소의 당일 `collect/YYYY-MM-DD` 브랜치 `data/snapshots`에 3330·1650 JSONL이 생겼는지 확인한다.
4. 이후 5분 스케줄을 관찰한다. GitHub Actions 스케줄은 지연될 수 있으므로, 화면에는 관측 시각을 항상 표시한다.

## 보관 원칙

원본 JSONL은 비공개 저장소에만 둔다. 공개 배포를 시작할 때는 차량 식별자를 제거한 정류장·시간대 집계만 별도 API로 제공한다.
