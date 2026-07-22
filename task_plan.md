# Task Plan: 좌석 모델 학습 상태 점검 (2026-07-22 완료)

## 목표
v2 boarding model이 수집 관측치로 제대로 학습(추정·수렴)되고 있는지 진단하고 보고

## 단계
1. [x] 모델 설계 파악 — docs/boarding-model-v2.md, docs/boarding-model.md
2. [x] 학습 코드 확인 — prototype-bus/build-data.ts, shared/model.ts
3. [x] 데이터 파이프라인 상태 — 수집 워크플로 가동 여부, 데이터 신선도
4. [x] 학습 산출물 점검 — profile.js / history.js / daily.js 분석
5. [x] phase 0 관측 로그·검증 도구 상태 확인 (7/21 커밋, 실측 축적 시작 단계)
6. [x] 종합 진단 보고

## 발견 사항
- 수집 정상: collect-bus-seats가 main에서 스케줄 가동. 오늘(7/22) 아침 피크 창
  06:09~10:25 KST 루프 커버, 최근 수집 15:27 KST. cancelled 2건은 concurrency
  중복 시동 정리로 오류 아님. 일별 아카이브(7/20, 7/21) + 브랜치 삭제 자동화 작동.
- 데이터 증가 추세: 일자별 JSONL 20KB(7/19) → 60KB(7/20) → 152~162KB(7/21),
  오늘 진행분 83~88KB. 티어드 스케줄 개편 효과 확인.
- 집계 로직 건전성: 음수 순수요 유효셀 52~54%(v2 부록 A.2와 일치), 검열률
  아침피크 11~18% > 저녁 6~9% > 그외 0%. 만석 도달 운행 3330=53, 1650=35.
- 표본은 학습 초기: 실질 평일 2일 + 일요일 1일. history 셀당 평균 ~1.4표본,
  표본 10회 이상 셀 0개(v1 확률 출력 기준 미달). 주말 프로파일 사실상 공백.
- 미가동 발견: publish-pages.yml(30분 주기 재집계+Pages 배포)이
  feature/kakao-route-link에만 있고 main에 없음 → 재집계 자동화 아직 안 돎.
  마지막 학습 산출물은 7/21 17:38 KST 로컬 빌드(오늘 데이터 미반영).
- 로컬 기본 데이터 경로(bus-seat-collector/data/) 비어 있음 — 로컬 재집계는
  비공개 저장소 클론 + --data-dir 필요.
