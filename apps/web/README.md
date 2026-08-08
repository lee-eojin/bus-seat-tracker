# 웹 앱

경기 직행좌석버스의 현재 좌석과 정류장 도착 시점 예보를 보여 주는 정적 웹 앱이다. 브라우저가 `packages/domain`의 좌석 전파와 탑승 판정을 실행하고, `/api/live` 응답이 없으면 마지막 수집 스냅샷으로 표시한다.

## 실행

Node.js 22와 `routes/`, `snapshots/`가 들어 있는 비공개 데이터 디렉터리가 필요하다.

```bash
npm install
BUS_DATA_DIR=/absolute/path/to/data npm run build:site
python3 -m http.server 4173 --directory site
```

브라우저에서 `http://localhost:4173`을 연다. 이 방식은 정적 화면 확인용이라 `/api/live`와 `/api/feedback`은 404가 난다. 화면은 정적 스냅샷으로 계속 동작한다. 두 API까지 확인하려면 환경변수를 설정한 Vercel 개발 환경이나 프리뷰 배포를 사용한다.

데이터만 다시 만들 때는 다음 명령을 쓴다.

```bash
npm run build:data -- --data-dir=/absolute/path/to/data
npm run build
npm run assemble:site
```

## 책임 경계

| 경로 | 맡는 일 |
|---|---|
| `public/` | HTML, 이용 안내, 빌드된 데이터 스크립트 |
| `src/app.ts` | 화면 상태, 렌더링, 실시간 폴링, 길찾기와 설문 연결 |
| `scripts/build-data.ts` | 비공개 JSONL을 공개 가능한 화면 데이터로 변환 |
| `scripts/assemble-site.mjs` | `public/`과 컴파일 결과를 `site/`로 조립 |
| `scripts/build-site.mjs` | 데이터 준비부터 사이트 조립까지 배포 빌드를 실행 |

모델 계산과 판정 규칙은 `packages/domain/`에서 고친다. 웹 코드에 같은 공식을 다시 만들지 않는다. GBIS 인증키나 원본 JSONL도 웹 디렉터리에 두지 않는다.

전체 데이터 흐름과 배포 구조는 [아키텍처 문서](../../docs/architecture.md), 환경변수와 운영 절차는 [배포 문서](../../docs/operations/deployment.md)에 있다.
