# bus-seat-tracker

경기도 광역버스(직행좌석)의 차량별 빈자리를 5분 간격으로 수집해서,
"지금 어디서 타면 자리가 있는지"를 노선 축 위에 보여주는 프로젝트.

직행좌석버스는 좌석이 없으면 탈 수 없다. 그래서 출근 시간의 진짜 문제는
"가장 가까운 정류장"이 아니라 "만차가 되기 전 정류장"을 찾는 것이다.
경기도 버스정보(GBIS) OpenAPI가 차량별 잔여좌석(`remainSeatCnt`)을 제공하지만
과거 이력은 제공하지 않기 때문에, 시간대별 좌석 소진 패턴은 직접 쌓아야 한다.
이 저장소가 그 수집과 시각화를 담당한다.

## 동작 구조

```
GitHub Actions (5분 크론)
  └─ bus-seat-collector/collector.mjs --once
       └─ GBIS 차량위치 API → 차량별 잔여좌석 스냅샷(JSONL)
            └─ bus-data 브랜치에 커밋 (main은 코드만 유지)

로컬
  └─ prototype-bus/build-data.mjs   JSONL → data/latest.js, data/daily.js
       └─ prototype-bus/index.html  file://로 열면 끝 (서버 없음)
```

- 수집 대상 노선은 `bus-seat-collector/.env`의 `ROUTE_NAMES`로 관리한다 (기본 3330, 1650)
- 수집 방식 비교와 선택 근거, 가동 절차, 실측 기록은 [bus-seat-collector/RUNNING.md](bus-seat-collector/RUNNING.md)
- 뷰 사용법과 화면 규칙은 [prototype-bus/README.md](prototype-bus/README.md)

## 빠른 시작

```bash
# 1회 수집 (GYEONGGI_BUS_API_KEY를 .env에 입력한 뒤)
cd bus-seat-collector && node collector.mjs --once

# 집계 후 열기
cd ../prototype-bus && node build-data.mjs && open index.html
```

## 실측 메모 (2026-07-16)

3330·1650 운행 차량 38대 전부에서 잔여좌석이 제공됐다(제공률 100%).
API 쿼터는 상세기능당 일 1,000콜이라 5분 크론 기준 노선 3개가 상한이다.
자세한 수치는 RUNNING.md의 실측 기록 참고.
