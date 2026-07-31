# 문서 안내

읽는 순서와 각 문서의 지위. 상태 표기는 각 문서 상단에도 같은 형식으로 있다.

## 읽는 순서

1. [proposal.md](proposal.md) 기획서. 무엇을 왜 만드는가, 수요 검증
2. [boarding-model-v2.md](boarding-model-v2.md) 현행 구현이 따르는 설계
3. [queue-recovery.md](queue-recovery.md) 대기 인원 복원 연구 기록. 상단 현재 결론부터
4. [validation-2026-07-24.md](validation-2026-07-24.md) 층-1 검증 보고서

모델 작업은 2~4가 본편. 제품과 시장만 보려면 1과 [market-size.md](market-size.md).

## 문서 상태

| 문서 | 상태 | 역할 |
|---|---|---|
| [proposal.md](proposal.md) | 현재 기준 | 기획서. 문제 정의와 수요 검증 |
| [market-size.md](market-size.md) | 현재 기준 | 두 노선의 평일 수송 규모 실측 |
| [boarding-model-v2.md](boarding-model-v2.md) | 현재 기준 | 탑승 모델 설계. Phase 0 부분 통과, 구간합 역산은 구현 반영 |
| [validation-2026-07-24.md](validation-2026-07-24.md) | 검증 기록 | 층-1 백테스트와 첫 필드 실측 |
| [queue-recovery.md](queue-recovery.md) | 연구 기록 | 대기 인원 복원. 시간순 누적이라 중간 결론은 뒤 절에서 수정된다 |
| [boarding-model.md](boarding-model.md) | 보관 | v1 명세. v2로 대체됐고 백테스트 기준선 full-frequency의 원형으로 유지 |

상태 표기: 현재 기준(지금 구현과 판단의 근거), 검증 기록·연구 기록(그 시점의 결과와 과정을 보존), 보관(대체됐지만 참조용으로 유지).

문서 경로와 절 번호는 코드 주석(`shared/`, `backtest/`)과 CI 요약이 참조한다. 옮기거나 당기려면 참조도 같이 고쳐야 한다.
