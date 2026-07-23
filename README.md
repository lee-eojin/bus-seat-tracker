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

## 실시간 좌석 오버레이 (선택)

`prototype-bus/data/config.js`에 GBIS 인증키를 넣으면 화면이 60초마다 잔여석을 직접 조회해 스냅샷 위에 덮어쓴다. `prototype-bus/data/`는 gitignore 대상이라 키가 저장소에 올라가지 않는다.

```js
window.__CONFIG__ = { gbisApiKey: '공공데이터포털에서 발급한 인증키' };
```

키가 없으면 수집 스냅샷 표시로 동작한다. 라이브 응답의 차량번호는 표시하지도 저장하지도 않는다. 공개 배포 시에는 이 방식을 쓰면 키가 노출되므로, 그때는 프록시나 발행 주기 강화로 대체해야 한다.

## 자동 수집 재가동

`.github/workflows/collect-bus-seats.yml`은 통근 피크(평일 06:30~10:00, 17:30~20:30)는 10분 간격 루프로, 그 외 운행 시간대는 매시 1회로 수집하며 심야에는 쉰다. 스냅샷은 `bus-seat-tracker-data` 비공개 저장소에만 저장한다. 한국 날짜별 `collect/YYYY-MM-DD` 브랜치에 수집을 누적한 뒤, 다음 날 첫 수집에서 전날 브랜치를 `main`의 단일 아카이브 커밋으로 반영하고 삭제한다. 워크플로를 기본 브랜치에 반영한 뒤 다음 GitHub Actions Secrets를 설정해야 한다.

- `GYEONGGI_BUS_API_KEY`: 공공데이터포털에서 재발급한 새 인증키
- `VEHICLE_HASH_SECRET`: API 키와 무관한 임의의 긴 비밀값
- `BUS_DATA_REPO_TOKEN`: `bus-seat-tracker-data`의 Contents 읽기·쓰기만 허용한 fine-grained PAT

Secrets가 준비되면 Actions의 **Collect bus seats**를 한 번 수동 실행해 비공개 저장소의 당일 `collect/YYYY-MM-DD` 브랜치에 첫 스냅샷이 쌓이는지 확인한다. 스케줄은 기본 브랜치에서만 작동한다.

## 브랜치

- `main`: 검증된 기준선
- `dev`: TypeScript 전환과 기능 개발

`dev`에서 검증한 뒤에만 `main` 반영 여부를 결정한다.
