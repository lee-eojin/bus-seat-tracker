# prototype-bus — 빨간버스 좌석 현황 (정적 앱)

수집기(JSONL)를 집계해 `index.html`을 file://로 여는 것만으로 노선 축 위의 차량별 빈자리를 보여준다.
서버 없음. 데이터는 `<script src>`로 로드하므로 로컬 파일로 바로 동작한다.

## 사용 흐름

1. 데이터 동기화 (GitHub Actions가 bus-data 브랜치에 축적 — 1회만 워크트리 생성):

   ```bash
   git worktree add ../bus-data bus-data
   git -C ../bus-data pull   # 볼 때마다 갱신
   ```

2. 집계:

   ```bash
   node build-data.mjs --data-dir=../bus-data/data --watch
   ```

   로컬에서 수집한 경우 `--data-dir` 없이 실행하면 `../bus-seat-collector/data`를 읽는다.

3. `index.html`을 브라우저로 연다. 60초마다 집계 산출물을 다시 읽는다.

## 화면 규칙

- 신선도: 10분 이내 정상 / 10~25분 경고 / 초과 시 수집 중단 배너 (Actions 수집 주기 기준)
- 차량 pill: 10석 이상 초록 / 1~9석 주황 / 0석 빨강 / 정보 없음(remainSeatCnt=-1)은 회색 + 혼잡도 폴백
- 정류장 줄 배경: 그 정류장으로 다가오는 가장 가까운 차량의 좌석 상태
- 상·하행 분리는 정류장 캐시의 회차 지점(turnYn/turnSeq) 기준 — 회차 정보가 없으면 단일 축으로 표시

## 생성물

`data/latest.js`(현재 상황), `data/daily.js`(정류장×시간대 집계, 히트맵 대비)는 build-data.mjs 산출물이다.
직접 편집하지 않는다.
