# 경기버스 빈자리 수집기

노선의 모든 정류장을 캐시하고, 노선 위 모든 운행 차량의 정류장 순번·빈자리를 JSONL로 기록한다.

## 준비

1. 경기도 버스정보 API의 일반 인증키를 발급받는다.
2. `.env.example`을 `.env`로 복사하고 `GYEONGGI_BUS_API_KEY`를 입력한다.
3. 루트에서 `npm install`을 실행한다.

`.env`와 `data/`는 Git에 포함되지 않는다. 차량 번호와 차량 ID는 기록 직전에 HMAC으로 가명화한다.

## 실행

```bash
# 한 번 수집
npm run collect -- --once

# 기본 24시간, 60초 간격 수집
npm run collect

# 기간과 간격 변경
npm run collect -- --duration-hours=3 --interval-seconds=60
```

`ROUTE_NAMES`로 대상 노선을 바꿀 수 있다. 빈자리 `-1`은 정보 미제공이고 `0`은 관측 시점의 만석이다. 어느 값도 실제 탑승을 보장하지 않는다.
