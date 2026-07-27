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
(18:40~21:16 KST). 재발급했으면 **그 토큰을 쓰는 모든 곳을 같이 갱신**한다.

## 4. GitHub 시크릿

| 이름 | 쓰이는 곳 |
|---|---|
| `VERCEL_DEPLOY_HOOK_URL` | `publish-pages.yml`이 30분마다 호출 |

**Git 연결 뒤에는 이게 필요 없다.** 푸시가 배포를 일으키므로 훅은 중복이다.
미설정 상태에서 해당 스텝은 조용히 건너뛰고 워크플로는 깨지지 않는다 — 그대로 두면 된다.

데이터가 갱신될 때마다 화면을 다시 만들고 싶다면 그때 훅을 만들어 넣는다
(Vercel → Settings → Git → Deploy Hooks). 수집은 저장소가 달라 푸시가 이쪽에 안 잡힌다.

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

**일 한도 1,000회가 이 서비스의 구속 제약이다.** 수집이 이미 약 482회를 쓴다.

| 캐시 TTL | 출퇴근 6.5시간 | 가용분 ~518회 |
|---|---|---|
| 30초 | 1,560회 | 초과 |
| 60초 | 780회 | 초과 |
| **120초 (현재)** | **390회** | 들어감 |

`api/live.ts`의 `cacheSeconds`를 낮추기 전에 이 표를 다시 계산한다.
`busarrivalservice`(15080346)를 신청하면 +1,000회 여유가 생기며 자동승인이다.

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
