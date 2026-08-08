# 배포 운영 가이드

이 서비스는 정적 화면과 서버 함수를 함께 배포한다. 정적 화면에는 수집 데이터를 집계한
`latest.js`, `history.js`, `profile.js`가 들어가고, 실시간 좌석은 Vercel 함수
`/api/live`가 GBIS를 대신 호출한다.

코드 배포와 데이터 갱신은 서로 다른 경로다. 저장소에 새 코드가 반영되면 Vercel의 Git 연동이
배포를 시작할 수 있지만, 비공개 데이터 저장소에 새 스냅샷이 생긴 것만으로는 이 저장소에 변경이
생기지 않는다. 정적 데이터는 `Publish seat board` 워크플로가 Vercel Deploy Hook을 호출해야
갱신된다. 이 둘을 같은 배포로 생각하면 화면의 프로파일만 오래된 채 실시간 좌석은 정상인 상황을
놓치기 쉽다.

## 배포 구조

```text
코드 변경 ────────────────> Vercel Git 연동 ───────> Preview / Production

비공개 스냅샷 저장소 ──> Publish seat board (매시 17분과 47분, UTC)
                              ├─ build:data
                              ├─ GitHub Pages 배포
                              ├─ 라이브 예측 로그 저장
                              └─ Vercel Deploy Hook ──> Vercel 재빌드

Vercel 빌드
  └─ npm run build:site
       ├─ 비공개 저장소의 당일 collect/YYYY-MM-DD 또는 main 읽기
       ├─ apps/web/public/data 갱신
       └─ site/ 조립

브라우저 ──> /api/live?route=3330 ──> Vercel 함수 ──> GBIS
```

배포 계약은 [`vercel.json`](../../vercel.json)에 있다.

| 항목 | 값 | 근거 |
|---|---|---|
| Node.js | 22.x | `package.json`의 `engines` |
| 빌드 명령 | `npm run build:site` | `vercel.json` |
| 정적 출력 | `site/` | `vercel.json`의 `outputDirectory` |
| 서버 함수 진입점 | `api/live.ts`, `api/feedback.ts` | Vercel 파일 기반 라우팅 |
| 실시간 함수 제한 | 15초 | `vercel.json`의 `maxDuration` |

`apps/api/`에는 실제 핸들러가 있고 루트 `api/`는 Vercel이 찾는 얇은 진입점이다. 루트 파일을
없애거나 `apps/api/`만 배포하면 함수 경로가 사라진다.

## 배포 전에 준비할 값

### Vercel 환경변수

값이 등록돼 있다고 가정하지 않는다. Vercel 대시보드의 **Settings → Environment Variables**에서
배포 대상 환경별로 이름이 있는지 확인한다. 값을 추가하거나 바꿨다면 그 뒤에 시작한 배포로
검증해야 한다. 이미 끝난 배포에는 새 값이 소급 적용되지 않는다.

| 이름 | 적용 시점 | 최소 권한과 용도 | 없을 때 보이는 증상 |
|---|---|---|---|
| `BUS_DATA_REPO_TOKEN` | 빌드 | `bus-seat-tracker-data` Contents 읽기 | `BUS_DATA_DIR 또는 BUS_DATA_REPO_TOKEN 중 하나가 필요합니다`와 함께 빌드 실패 |
| `GYEONGGI_BUS_API_KEY` | 함수 실행 | GBIS 조회 키 | `/api/live`가 503, 화면은 마지막 스냅샷으로 강등 |
| `DATABASE_URL` | 함수 실행 | Neon의 `feedback_events` 쓰기 | `/api/feedback`이 503, 방문과 설문 저장 실패 |

Preview와 Production을 모두 쓴다면 각 환경에 따로 등록한다. `DATABASE_URL`을 Neon 연동이
주입하더라도 연결 대상과 적용 환경은 대시보드에서 다시 확인한다. Vercel에서 Sensitive로 저장한
값은 다시 읽을 수 없으므로 `DATABASE_URL`의 원본은 Neon 연결 정보에서 관리한다.

### GitHub Actions Secrets

| 이름 | 쓰는 워크플로 | 필요한 권한 |
|---|---|---|
| `BUS_DATA_REPO_TOKEN` | 수집, 발행, 예보 검증 | 비공개 데이터 저장소 Contents 읽기와 쓰기 |
| `GYEONGGI_BUS_API_KEY` | 수집 | GBIS 조회 |
| `VEHICLE_HASH_SECRET` | 수집 | 차량 식별자 HMAC 가명화 |
| `VERCEL_DEPLOY_HOOK_URL` | 발행 | Vercel의 `main` Deploy Hook 호출 |

Vercel과 GitHub Actions에서 같은 이름을 쓰더라도 같은 토큰을 재사용할 필요는 없다. Vercel은
데이터를 읽기만 하므로 읽기 전용 토큰을 따로 발급한다. Actions 토큰은 당일 수집 브랜치와
`predictions` 브랜치에 쓰고, 날짜가 지난 수집 브랜치를 `main`에 보관하므로 쓰기 권한이 필요하다.

Deploy Hook의 등록 여부는 Secrets 목록만 보고 끝내지 않는다. `Publish seat board`를 수동 실행한
뒤 다음 두 증거를 확인한다.

1. `Trigger Vercel deploy` 단계에 미설정 경고가 없다.
2. 그 실행 이후 시작된 Vercel 배포가 있고, 빌드 로그의 데이터 시각이 바뀌었다.

워크플로는 Hook이 없어도 경고만 남기고 성공으로 끝난다. 초록색 체크는 Vercel 데이터 갱신의
증거가 아니다.

## 첫 배포와 변경 배포

### 1. 로컬에서 같은 빌드를 만든다

비공개 데이터를 이미 받아 둔 경로를 사용하면 토큰을 셸 기록에 넣지 않고 배포 빌드를 확인할 수
있다.

```bash
npm ci
npm test
npm run typecheck
BUS_DATA_DIR=/absolute/path/to/bus-seat-tracker-data/data npm run build:site
```

성공하면 마지막에 `완료: .../site`가 출력되고 `site/index.html`, `site/legal.html`,
`site/data/latest.js`가 있어야 한다. `build-site.mjs`는 당일 수집 브랜치가 있으면 그 브랜치를,
없으면 `main`을 읽는다. 브랜치 조회가 권한이나 네트워크 문제로 실패하면 낡은 `main`으로 조용히
넘어가지 않고 빌드를 실패시킨다.

### 2. Vercel 프로젝트 설정을 맞춘다

- 프로젝트 루트는 저장소 루트(`.`)다.
- Framework Preset은 별도 프레임워크를 고르지 않는다.
- Build Command와 Output Directory는 대시보드에서 중복 정의하지 않고 `vercel.json`을 따른다.
- 공개 서비스라면 Deployment Protection이 실제 공개 주소를 막고 있지 않은지 확인한다.

Git 연결, 환경변수, Protection은 저장소만 읽어서는 현재 상태를 알 수 없다. 대시보드와 실제
응답을 기준으로 판단한다.

### 3. 배포를 시작한다

코드 변경은 팀의 평소 Vercel Git 연동 절차로 배포한다. 데이터만 갱신할 때는 Actions에서
**Publish seat board**를 실행한다. 이 워크플로는 Pages를 먼저 배포하고 마지막에 Deploy Hook을
호출한다. 두 호스팅 경로가 모두 코드에 남아 있으므로 하나를 제거하려면 다른 쪽의 정적 화면,
실시간 함수, 데이터 갱신을 먼저 모두 확인해야 한다.

## 배포 확인

아래 확인은 배포 상태 배지보다 강한 증거를 남긴다. 명령의 URL에는 확인할 Preview 또는
Production 주소를 넣는다.

```bash
DEPLOYMENT_URL=https://example.vercel.app
```

### 1. 정적 화면과 데이터 시각

```bash
curl -fsSI "$DEPLOYMENT_URL/"
curl -fsS "$DEPLOYMENT_URL/data/latest.js" |
  node -e "let source=''; process.stdin.on('data', chunk => source += chunk).on('end', () => { const payload = JSON.parse(source.replace(/^window.__LATEST__ = /, '').replace(/;\s*$/, '')); console.log({ generatedAt: payload.generatedAt, routes: payload.routes.map(route => ({ route: route.route.name, collectedAt: route.collectedAt })) }); });"
```

`generatedAt`은 정적 번들을 만든 시각이고, 노선별 `collectedAt`은 번들이 사용한 마지막 관측
시각이다. `generatedAt`만 새롭고 `collectedAt`이 오래됐다면 배포보다 수집을 먼저 확인한다.
심야에는 수집을 쉬므로 단순한 벽시계 나이만으로 장애를 판정하지 말고
[`collector.md`](collector.md)의 시간표와 대조한다.

기존 `/prototype-bus/` 주소를 계속 지원하는 동안에는 이 경로가 루트로 이동시키는지도 확인한다.

```bash
curl -fsS "$DEPLOYMENT_URL/prototype-bus/"
```

반환 HTML의 `meta refresh`가 `../`를 가리켜야 한다.

### 2. 실시간 함수

```bash
curl -i "$DEPLOYMENT_URL/api/live?route=3330"
curl -i "$DEPLOYMENT_URL/api/live?route=9999"
curl -i -X POST "$DEPLOYMENT_URL/api/live?route=3330"
```

응답은 아래 계약을 따라야 한다.

| 요청 | 기대 결과 |
|---|---|
| 정확한 GET `route=3330` 또는 `route=1650` | 200, `Cache-Control: public, s-maxage=120, stale-while-revalidate=240` |
| 허용하지 않은 노선이나 쿼리, 경로 변형 | 400, `Cache-Control: no-store` |
| GET 이외의 메서드 | 405, `Allow: GET`, `Cache-Control: no-store` |
| 키가 없는 배포 | 503, `Cache-Control: no-store` |

성공 응답에는 `plateNo`, `vehId`, 차량 `id`가 없어야 한다.

```bash
curl -fsS "$DEPLOYMENT_URL/api/live?route=3330" |
  jq 'any(.vehicles[]?; has("plateNo") or has("vehId") or has("id"))'
```

결과가 `false`여야 한다. 브라우저 개발자 도구의 Network 탭에서도 `apis.data.go.kr` 요청이
없어야 한다. GBIS 도메인이나 `serviceKey`가 보이면 클라이언트가 서버 프록시를 우회하고 있다.

### 3. 캐시가 실제로 동작하는지 확인한다

같은 URL을 여러 번 요청해 `Age`, `X-Vercel-Cache` 같은 플랫폼 헤더가 어떻게 변하는지 본다.
헤더 이름과 값은 플랫폼 설정에 따라 달라질 수 있으므로 특정 문자열 하나만 성공 조건으로 삼지
않는다. 같은 노선의 정확히 같은 URL을 반복해도 120초 동안 원본 GBIS 호출이 매번 생기지 않아야
한다. 공공데이터포털 사용량 화면에서도 배포 전후 호출 증가량을 대조한다.

`HEAD`는 지원하지 않는다. 실시간 함수 상태를 확인한다며 `curl -I`를 반복하면 CDN의 GET 캐시와
다른 경로로 들어올 수 있다. 함수 확인에는 GET을 사용한다.

### 4. 공개 접근 범위를 확인한다

로그아웃 상태나 시크릿 창에서 실제 주소를 연다. 로그인 화면으로 302 이동한다면 Deployment
Protection이 켜진 상태다. 공개 서비스가 목표라면 Vercel 대시보드에서 대상 환경의 Protection을
조정한 뒤 다시 확인한다. 이 설정의 현재값은 문서에 적어 두지 않는다.

## 토큰 교체 절차

토큰을 평상시 교체할 때는 새 값 검증이 끝나기 전에 이전 값을 폐기하지 않는다.

1. 소비자를 적는다. Actions의 `BUS_DATA_REPO_TOKEN`은 수집, 발행, 예보 검증 세 곳이 함께 쓴다.
   Vercel의 같은 이름은 빌드만 쓴다.
2. Actions에는 읽기와 쓰기 토큰을, Vercel에는 읽기 전용 토큰을 각각 만든다.
3. GitHub Secret을 바꾼 뒤 **Collect bus seats**, **Publish seat board**, **Verify forecast**를
   수동 실행해 비공개 저장소 읽기와 쓰기를 모두 확인한다.
4. Vercel 환경변수를 바꾸고 새 배포를 시작한다. 빌드 로그에서 당일 브랜치 또는 `main`을
   읽고 `site/` 조립까지 끝났는지 확인한다.
5. 새 값으로 모든 소비자가 동작한 뒤 이전 토큰을 폐기한다.

유출이 의심되면 순서를 바꾼다. 이전 값을 즉시 폐기하고 중단을 감수한 뒤 새 값을 넣는다. 토큰을
문서, 이슈, 채팅, 명령 인자, 원격 URL에 붙여 넣지 않는다. Vercel 빌드 스크립트는 토큰이 URL과
프로세스 목록에 남지 않도록 `http.extraheader`를 환경변수로 전달한다.

2026-07-27에는 토큰 재발급으로 Actions의 기존 값이 먼저 무효화돼 수집과 발행이 함께 멈췄다.
자세한 경위는 [토큰 만료 장애 기록](incidents/2026-07-27-token-expiry.md)에 있다.

## GBIS 호출 예산

현재 코드의 예산 계산기는 `buslocationservice` 일 한도를 1,000회로 두고 수집과 실시간 함수를
합산한다. 실제 계정 한도는 바뀔 수 있으므로 공공데이터포털 마이페이지의 남은 호출 수와 함께
본다.

```bash
npm run budget
```

현재 스케줄 상수로 계산하면 가장 큰 날은 수요일이다. 수집 534회와 실시간 390회를 더해 924회,
이론상 여유는 76회다. 실시간 390회는 두 노선을 출퇴근 6.5시간 동안 120초 캐시로 조회한다고
잡은 값이다.

```text
6.5시간 × 3,600초 ÷ 120초 × 2노선 = 390회
```

이 숫자는 재시도와 수동 이벤트 수집을 포함하지 않는다. `cacheSeconds`, 노선 수, 수집 창,
이벤트 간격을 바꾸기 전에 반드시 계산기를 다시 실행하고 포털의 실제 한도를 확인한다. Vercel
정적 빌드는 비공개 저장소만 읽으며 GBIS를 호출하지 않으므로 이 예산을 쓰지 않는다. 자세한
이벤트 예산 계산은 [`collector.md`](collector.md#수동-이벤트-수집)에 있다.

## 증상별 확인 순서

| 증상 | 먼저 볼 곳 | 판단 |
|---|---|---|
| Vercel 빌드가 데이터 인증 오류로 실패 | Vercel의 `BUS_DATA_REPO_TOKEN`과 적용 환경 | 읽기 권한, 만료, 재배포 시점 확인 |
| 화면 데이터만 오래되고 `/api/live`는 정상 | `Publish seat board`의 Hook 단계와 `latest.js`의 `generatedAt` | 코드 배포와 데이터 배포가 갈라진 상태 |
| `/api/live`가 503 | Vercel의 `GYEONGGI_BUS_API_KEY` | 환경변수 누락 또는 적용 전 배포 |
| `/api/live`가 502 | 함수 로그와 공공데이터포털 사용량 | GBIS 타임아웃, 한도 소진, 키 오류 가능 |
| `/api/live`가 400 | 경로와 쿼리 원문 | `/api/live?route=3330` 또는 `1650`만 허용 |
| `/api/feedback`이 503 | `DATABASE_URL`과 Neon 연결 상태 | 방문과 설문 저장소 미연결 |
| 공개 주소가 로그인 화면으로 이동 | Deployment Protection | 공개 범위 설정 확인 |
| Pages는 최신인데 Vercel만 오래됨 | `VERCEL_DEPLOY_HOOK_URL`과 Vercel 배포 목록 | Hook 누락이나 실패 가능 |

데이터 갱신이 오래 멈췄던 사례와 재발 확인법은
[정적 데이터 지연 장애 기록](incidents/2026-07-29-stale-deployment.md)에 정리했다.
