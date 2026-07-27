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

## 2. Vercel 프로젝트 생성

1. Vercel에서 이 저장소를 Import 한다.
2. Framework Preset은 **Other**(`vercel.json`이 `framework: null`).
3. Build Command·Output Directory는 `vercel.json`이 지정하므로 대시보드에서 비워 둔다.

## 3. 환경변수 (Vercel → Settings → Environment Variables)

| 이름 | 쓰이는 곳 | 없으면 |
|---|---|---|
| `GYEONGGI_BUS_API_KEY` | `api/live.ts` 런타임 | 프록시가 503, 화면은 스냅샷으로 표시 |
| `BUS_DATA_REPO_TOKEN` | `scripts/build-site.mjs` 빌드 시 데이터 클론 | **빌드 실패** |

`BUS_DATA_REPO_TOKEN`은 `bus-seat-tracker-data`에 **읽기 권한만** 있으면 된다.
빌드는 클론만 하고 쓰지 않는다.

Production·Preview 양쪽에 등록한다. Preview에 없으면 PR 프리뷰 빌드가 깨진다.

## 4. GitHub 시크릿

| 이름 | 쓰이는 곳 |
|---|---|
| `VERCEL_DEPLOY_HOOK_URL` | `publish-pages.yml`이 30분마다 호출 |

Vercel → Settings → Git → Deploy Hooks에서 만든다.
**등록 전에는 해당 스텝이 조용히 건너뛴다** — 지금 상태로도 워크플로는 깨지지 않는다.

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

## 8. 아직 안 된 것

법적 표기는 `prototype-bus/legal.html`로 완료했다 (출처·면책·개인정보). 푸터에서 링크된다.

남은 것은 하나다. 실시간 조회 실패 시 화면이 스냅샷으로 되돌아가지만 **그 사실을 알리지 않는다.**
"실시간 연결 끊김" 표시는 S3 에러 상태 작업으로 남아 있다.
