# bus-seat-tracker

경기도 직행좌석버스의 차량별 빈자리 관측치를 수집하고, 노선 축에서 좌석 상태를 보여 주는 TypeScript 프로젝트다.

가까운 정류장이 항상 좋은 선택은 아니다. 이 프로젝트는 노선 위에서 좌석이 소진되는 위치를 관찰해, 만차 전에 탈 수 있는 선택지를 이해하는 데 초점을 둔다.

## 구성

```
bus-seat-collector/collector.ts  GBIS API → 로컬 JSONL 스냅샷
prototype-bus/build-data.ts      JSONL → 브라우저용 최신·일별 데이터
prototype-bus/app.ts             노선 축 UI
shared/model.ts                  API 경계를 통과한 도메인 모델
```

공개 저장소에는 API 키, 원문 차량 번호, 수집 데이터, 빌드 산출물을 넣지 않는다. 차량 식별자는 수집 시 API 키 기반 HMAC 값으로만 저장한다.

## 시작하기

Node.js 22 이상과 npm이 필요하다.

```bash
npm install
cp bus-seat-collector/.env.example bus-seat-collector/.env
# bus-seat-collector/.env에 GYEONGGI_BUS_API_KEY 입력

npm run collect -- --once
npm run build:data
open prototype-bus/index.html
```

`npm run typecheck`은 산출물 없이 타입만 검사하고, `npm run build`는 `dist/`에 JavaScript를 만든다.

## 브랜치

- `main`: 검증된 기준선
- `dev`: TypeScript 전환과 기능 개발

`dev`에서 검증한 뒤에만 `main` 반영 여부를 결정한다.
