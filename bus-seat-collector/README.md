# 경기버스 빈자리 수집기

3330·1650번의 모든 정류장 목록을 저장하고, 노선 위 모든 운행 차량의 현재 정류장 순번과 빈자리를 일정 간격으로 기록한다.

## 준비

1. [경기도 버스정보 API](https://www.gbis.go.kr/gbis2014/publicService.action?cmd=mBusLocation) 활용 신청 후 일반 인증키를 발급받는다.
2. `.env.example`을 복사해 `.env` 파일을 만든다.
3. `GYEONGGI_BUS_API_KEY`에 인증키를 넣는다. `.env`와 수집 데이터는 저장소에서 제외된다.

## 실행

한 번만 수집한다.

```sh
node collector.mjs --once
```

24시간 동안 60초마다 수집한다.

```sh
node collector.mjs
```

수집 시간을 바꿀 수 있다.

```sh
node collector.mjs --duration-hours=3 --interval-seconds=60
```

## 저장 형식

- `data/routes/<routeId>-stops.json`: 노선별 전 정류장 목록과 순번
- `data/snapshots/<routeName>-YYYY-MM-DD.jsonl`: 시점별 차량의 위치·빈자리 기록

빈자리 `-1`은 정보 미제공이며, `0`은 만석이다. 이 값은 순간적인 관측치이므로 실제 탑승을 보장하는 문구로 사용하면 안 된다.
