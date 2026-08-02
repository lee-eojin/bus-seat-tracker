# 배포 절차

Vercel 단일 프로젝트에 정적 화면과 `/api/live` 프록시를 함께 올린다.
수집(GitHub Actions)은 그대로 두고 건드리지 않는다 — 하루 끊기면 백테스트 표본에 구멍이 난다.

## 1. 사전 확인

| 항목 | 값 |
|---|---|
| Node | 22 (로컬 검증 v22.22.3) |
| 빌드 | `npm run build:site` → `site/` |
| 함수 | `api/live.ts` (esbuild 번들 확인 완료, 외부 의존 0) |
| 출력 | `site/` (`vercel.json`의 `outputDirectory`) |

## 2. Vercel 프로젝트

프로젝트는 이미 있다 — 이름은 `outputs`, 루트 `.`, Framework Preset은 **Other**.
CLI(`vercel`)로 먼저 만들어졌기 때문에 저장소명과 이름이 다르다.

Build Command·Output Directory는 대시보드에서 비워 둔다. `vercel.json`이 지정한다.

Git은 2026-07-27에 연결했다. 연결하려면 Vercel 계정에 GitHub **로그인 연결**이 먼저 있어야 하며,
없으면 `vercel git connect`가 400으로 막힌다(`You need to add a Login Connection`).
연결 뒤에는 작업 브랜치 푸시 → Preview, `main` 병합 → Production이 자동이다.

`vercel project inspect`는 Git 연결 여부를 **출력하지 않는다.** 연결 상태는 `vercel git connect`가
`already connected`를 내는지로 확인한다.

## 3. 환경변수 (Vercel → Settings → Environment Variables)

| 이름 | 쓰이는 곳 | 없으면 |
|---|---|---|
| `GYEONGGI_BUS_API_KEY` | `api/live.ts` 런타임 | 프록시가 503, 화면은 스냅샷으로 표시 |
| `BUS_DATA_REPO_TOKEN` | `scripts/build-site.mjs` 빌드 시 데이터 클론 | **빌드 실패** |
| `DATABASE_URL` | `api/feedback.ts` 런타임 (Neon 연동이 자동 주입) | 설문·방문 기록이 503 |

`DATABASE_URL`은 2026-07-29 Neon 연동이 Production·Preview에 자동 등록했다 (아래 "Preview에만
있다" 문장은 위의 두 변수 얘기다). Vercel에서는 Sensitive라 재열람이 안 되므로 원본은 Neon
콘솔(프로젝트 → Connection Details)이다. 재방문 집계(`npm run retention`)를 로컬에서 돌릴 때
여기서 가져온다.

Production·Preview 양쪽에 등록한다. Preview에 없으면 브랜치 프리뷰 빌드가 깨진다.
2026-07-27 기준 **Preview에만 있고 Production에는 없다.**

### `BUS_DATA_REPO_TOKEN`은 두 곳에서 필요 권한이 다르다

같은 이름이지만 값은 서로 달라도 된다. 헷갈리기 쉬우니 분리해서 관리한다.

| 넣는 곳 | 필요 권한 | 이유 |
|---|---|---|
| Vercel 환경변수 | Contents **read** | 빌드는 클론만 한다 |
| GitHub Actions Secrets | Contents **read + write** | 수집기가 스냅샷을 커밋한다 |

Vercel용에 write를 주지 않는다. 빌드가 데이터 저장소를 건드릴 이유가 없다.

**PAT를 재발급하면 이전 값이 즉시 죽는다.** 2026-07-27에 이 사고가 있었다 — Vercel에 넣으려고
재발급했더니 GitHub Secrets에 남아 있던 옛 값이 죽어 수집이 2시간 36분 멈췄다
(18:40\~21:16 KST). 재발급했으면 **그 토큰을 쓰는 모든 곳을 같이 갱신**한다.

## 4. GitHub 시크릿

| 이름 | 쓰이는 곳 |
|---|---|
| `VERCEL_DEPLOY_HOOK_URL` | `publish-pages.yml`이 30분마다 호출 |

**필수다.** 한때 이 문서는 Git 연결이 있으면 훅이 중복이라고 적고 있었다. 틀렸다.
푸시가 배포를 일으키는 건 맞지만 그건 코드 얘기다. 화면이 쓰는 데이터는 비공개 저장소에
30분마다 쌓이고 이 저장소에는 아무 푸시도 일어나지 않는다. 훅이 없으면 코드를 밀 때만
데이터가 갱신된다.

2026-07-29에 실제로 그렇게 됐다. 하루 종일 코드 푸시가 없어 배포본 데이터가 13.6시간
낡았고, 화면은 실시간 좌석만 살아 있고 프로파일과 스냅샷은 전날 저녁에 멈춰 있었다.
신선도 배너가 중단으로 뜬다.

만드는 법은 Vercel → Settings → Git → Deploy Hooks에서 `main` 브랜치 훅을 생성하고
그 URL을 이 이름으로 GitHub Actions Secrets에 넣는다. 미설정이면 해당 스텝은 조용히
건너뛰므로 워크플로는 초록으로 뜬다. 초록이라고 갱신되고 있다는 뜻이 아니다.

30분마다 빌드가 도는데 빌드는 데이터 저장소를 클론할 뿐 GBIS를 부르지 않으므로
§6의 호출 예산에는 영향이 없다.

## 5. 확인 순서

```
① 프리뷰 배포가 성공하는가            빌드 로그에 "완료: .../site"
② /api/live?route=3330 이 200인가     Cache-Control: public, s-maxage=120, ...
③ /api/live?route=9999 가 400인가     화이트리스트 동작
④ 브라우저 네트워크 탭에 data.go.kr 이 없는가   ← S1의 완료 기준
⑤ 좌석이 실제로 갱신되는가            120초 주기
```

④가 이 배포의 핵심이다. GBIS 도메인이 보이면 키가 아직 클라이언트에 있다는 뜻이다.

## 6. 호출 예산 — 배포 후 반드시 확인

**일 한도 1,000회가 이 서비스의 구속 제약이다.** 수집과 `/api/live`가 같은
`buslocationservice` 한도를 나눠 쓴다. `busrouteservice`는 캐싱 덕에 일 4회라 무관하다.

**이 절의 숫자는 손으로 세지 않는다.** `npm run budget`이 `bus-seat-collector/schedule.ts`의
창 정의에서 직접 계산한다. 예전에 손계산이 실제와 4사이클 어긋난 적이 있어 계산기를 만들었다.
창이나 캐시 TTL을 바꾸면 그 명령을 돌려 아래 표를 갱신한다.

```
$ npm run budget

| 요일 | 사이클 | 수집 호출 | /api/live | 합계 | 여유 |
|---|---|---|---|---|---|
| 월~화, 목~금 | 253 | 506 | 390 | 896 | 104 |
| 수요일 | 267 | 534 | 390 | 924 | 76 |
| 토~일 | 18 | 36 | 390 | 426 | 574 |
```

수요일이 최대 사용일이고 여유가 76회다. 낮 보정 구간(13:00\~13:30, 2분)이 그날만 돌기 때문이다.

캐시 TTL을 바꿨을 때의 `/api/live` 몫은 이렇다 (출퇴근 6.5시간, 2노선 기준).

| 캐시 TTL | /api/live | 수요일 합계 |
|---|---|---|
| 30초 | 1,560회 | 초과 |
| 60초 | 780회 | 초과 |
| **120초 (현재)** | **390회** | 924회, 들어감 |

`api/live.ts`의 `cacheSeconds`를 낮추거나 창을 넓히기 전에 `npm run budget`을 돌린다.
한도를 넘으면 종료 코드 1로 끝난다. `busarrivalservice`(15080346)를 신청하면 +1,000회
여유가 생기며 자동승인이다.

사이클 수는 창을 끝까지 돈다고 본 이론 최대치다. 남은 스냅샷 수로 역산하면
적게 나오는데, 그건 호출이 덜 나갔다는 뜻이 아니다. 사이클은 GBIS를 먼저 때리고
그다음 저장소에 올리므로 업로드가 실패해도 호출은 이미 나간 뒤다. 2026-07-27
저녁에 `BUS_DATA_REPO_TOKEN`이 만료돼 51사이클이 연속 401로 실패했고, 노선까지
세면 102회를 쓰고도 데이터는 한 건도 남지 않았다. 예산은 남은 데이터가 아니라
이 이론값으로 잡는다.

계산기는 창을 인수한 실행이 창 시작 전에 한 번 더 수집하는 것과, 창이 끝날 때
대기 중이던 정시 실행이 풀려 스냅샷을 남기는 것까지 센다. 손계산이 빠뜨렸던 자리가
그 둘이다. 대기열 해소 시점은 GitHub 스케줄러에 따라 흔들려 한두 사이클 오차가 있다.

그 사고 뒤로 인증 실패는 첫 사이클에서, 그 밖의 실패는 연속 3회에서 루프를 끊고
실행을 실패로 남긴다. 수집 워크플로가 실패로 뜨면 토큰부터 확인한다 (§3).

## 7. Pages 발행 정리

`publish-pages.yml`은 지금 **GitHub Pages 발행과 Vercel 훅을 함께** 돌린다.
Vercel 배포가 확인된 뒤에 Pages 스텝(`configure-pages` / `upload-pages-artifact` / `deploy-pages`)을 지운다.
먼저 지우면 되돌릴 곳이 없다.

## 8. 남은 것 (2026-07-27 기준)

| | 상태 |
|---|---|
| 법적 표기 `legal.html` | 완료 — 출처·면책·개인정보, 푸터에서 링크 |
| Git 연결 | 완료 |
| Preview 빌드 | 완료 — 데이터 클론·집계·번들 조립까지 확인 |
| Production 환경변수 | **없음.** 지금 프로덕션 배포를 걸면 빌드가 실패한다 |
| Deployment Protection | **켜짐.** Preview·Production 모두 302 → SSO |
| 실시간 끊김 표시 | 미구현 |

Protection은 Settings → Deployment Protection → Vercel Authentication → Disabled로 끈다.
공개 서비스라면 꺼야 하고, 켜져 있는 동안은 §5의 확인 절차를 진행할 수 없다.

실시간 조회가 실패하면 화면이 스냅샷으로 되돌아가지만 **그 사실을 알리지 않는다.**
"실시간 연결 끊김" 표시는 S3 에러 상태 작업으로 남아 있다.
