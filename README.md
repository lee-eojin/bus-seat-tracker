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

공개 저장소에는 API 키, 원문 차량 번호, 수집 데이터, 빌드 산출물을 넣지 않는다. 차량별 원본 스냅샷은 `bus-seat-tracker-data` 비공개 저장소에만 저장하고, 가명화에는 API 키와 분리한 HMAC 시크릿을 쓴다.

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

## 자동 수집 재가동

`.github/workflows/collect-bus-seats.yml`은 공개 저장소에서 5분마다 실행하고, `bus-seat-tracker-data` 비공개 저장소에만 스냅샷을 저장한다. 워크플로를 기본 브랜치에 반영한 뒤 다음 GitHub Actions Secrets를 설정해야 한다.

- `GYEONGGI_BUS_API_KEY`: 공공데이터포털에서 재발급한 새 인증키
- `VEHICLE_HASH_SECRET`: API 키와 무관한 임의의 긴 비밀값
- `BUS_DATA_REPO_TOKEN`: `bus-seat-tracker-data`의 Contents 읽기·쓰기만 허용한 fine-grained PAT

Secrets가 준비되면 Actions의 **Collect bus seats**를 한 번 수동 실행해 비공개 저장소에 첫 스냅샷이 쌓이는지 확인한다. 스케줄은 기본 브랜치에서만 작동한다.

## 브랜치

- `main`: 검증된 기준선
- `dev`: TypeScript 전환과 기능 개발

`dev`에서 검증한 뒤에만 `main` 반영 여부를 결정한다.
