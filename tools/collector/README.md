# GBIS 좌석 수집기

대상 노선의 정류장 목록을 캐시하고 운행 차량의 위치 순번과 잔여석을 JSONL로 남긴다. 차량 번호와 원본 차량 ID는 파일에 쓰기 전에 HMAC으로 가명화한다.

## 준비

루트에서 의존성을 설치하고 수집기 환경 파일을 만든다.

```bash
npm install
cp tools/collector/.env.example tools/collector/.env
```

`tools/collector/.env`에 다음 값을 넣는다.

| 이름 | 용도 |
|---|---|
| `GYEONGGI_BUS_API_KEY` | 공공데이터포털 일반 인증키 |
| `VEHICLE_HASH_SECRET` | 차량 식별자 가명화용 비밀값. API 키와 다른 긴 임의 문자열 |
| `ROUTE_NAMES` | 쉼표로 구분한 노선 번호. 기본값 `3330,1650` |
| `COLLECTION_DURATION_HOURS` | 반복 수집 시간. 기본값 24시간 |
| `COLLECTION_INTERVAL_SECONDS` | 로컬 반복 수집 간격. 기본값 60초, 최솟값 10초 |

출력 위치를 바꾸려면 실행 환경에 `BUS_DATA_DIR`을 지정한다. 지정하지 않으면 저장소 루트의 `data/`를 쓴다.

## 실행

```bash
# 한 번만 수집
npm run collect -- --once

# 3시간 동안 60초 간격으로 수집
npm run collect -- --duration-hours=3 --interval-seconds=60

# 노선·정류장 캐시를 바로 갱신한 뒤 한 번 수집
npm run collect -- --once --refresh-routes
```

결과는 다음 두 곳에 생긴다.

- `data/routes/<노선 ID>-stops.json`: 노선과 정류장 캐시
- `data/snapshots/<노선>-<서울 날짜>.jsonl`: 시점별 차량 좌석 스냅샷

잔여석 `0`은 만석 관측이고, `-1`은 좌석 정보 미제공이다. 둘을 같은 값으로 처리하지 않는다.

## 책임 경계

수집기는 GBIS를 읽고 로컬 파일에 쓰는 데까지만 맡는다. 비공개 저장소 업로드, 당일 브랜치 보관, 재시도와 알림은 GitHub Actions가 담당한다. 공개 화면 데이터 생성은 `apps/web/scripts/build-data.ts`의 책임이다.

수집 시간표는 `src/schedule.ts` 한 곳에서 관리한다. 시간대나 간격을 바꾸면 다음 검증을 함께 실행한다.

```bash
npm test
npm run budget
```

`.env`, `data/`, 원본 JSONL은 공개 저장소에 넣지 않는다. 자동 수집의 브랜치와 시크릿 운영은 [수집 운영 문서](../../docs/operations/collector.md), 다른 모듈과의 관계는 [아키텍처 문서](../../docs/architecture.md)를 따른다.
