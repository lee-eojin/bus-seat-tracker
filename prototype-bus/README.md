# prototype-bus

수집기 JSONL을 집계해 정류장 축 위에 차량별 빈자리를 표시하는 정적 화면이다.

## 실행

```bash
npm run build:data
open prototype-bus/index.html
```

기본적으로 `bus-seat-collector/data`를 읽는다. 별도 비공개 데이터 폴더를 읽으려면 다음처럼 실행한다.

```bash
npm run build:data -- --data-dir=/absolute/path/to/data --watch
```

집계 산출물인 `prototype-bus/data/latest.js`, `daily.js`와 컴파일 산출물 `dist/`는 로컬에서만 만든다.

## 화면 규칙

- 10분 이내: 정상, 10~25분: 주의, 그 이후: 수집 중단 경고
- 차량 pill: 10석 이상 초록 / 1~9석 주황 / 0석 빨강 / 정보 없음 회색
- 정류장 배경: 그 정류장으로 다가오는 가장 가까운 차량의 좌석 상태
- 상·하행: 정류장 캐시의 회차 정보가 있을 때만 분리
