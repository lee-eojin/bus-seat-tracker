# 문서 안내

읽는 순서와 각 문서의 지위. 같은 상태 표기를 각 문서 상단에도 적어 둔다.

## 읽는 순서

처음이라면 이 순서가 빠르다.

1. [proposal.md](proposal.md) 기획서. 무엇을 왜 만드는가, 수요를 어떻게 검증했는가
2. [boarding-model-v2.md](boarding-model-v2.md) 현행 구현이 따르는 설계
3. [queue-recovery.md](queue-recovery.md) 대기 인원 복원 연구 기록. 상단의 현재 결론부터 읽는다
4. [validation-2026-07-24.md](validation-2026-07-24.md) 층-1 검증 보고서

모델을 만질 사람은 2~4가 본편이고, 제품과 시장이 궁금하면 1과 [market-size.md](market-size.md)로 충분하다.

## 문서 상태

| 문서 | 상태 | 역할 |
|---|---|---|
| [proposal.md](proposal.md) | 현재 기준 | 기획서. 문제 정의와 수요 검증 |
| [market-size.md](market-size.md) | 현재 기준 | 두 노선의 평일 수송 규모 실측 |
| [boarding-model-v2.md](boarding-model-v2.md) | 현재 기준 | 탑승 모델 설계. Phase 0 부분 통과, 구간합 역산은 구현 반영 |
| [validation-2026-07-24.md](validation-2026-07-24.md) | 검증 기록 | 층-1 백테스트와 첫 필드 실측 |
| [queue-recovery.md](queue-recovery.md) | 연구 기록 | 대기 인원 복원. 시간순 누적이라 중간 결론은 뒤 절에서 수정된다 |
| [boarding-model.md](boarding-model.md) | 보관 | v1 명세. v2로 대체됐고 백테스트 기준선 full-frequency의 원형으로 유지 |

상태는 넷이다. 현재 기준은 지금 구현과 판단의 근거다. 검증 기록과 연구 기록은 결과와 과정을 그 시점 그대로 보존한다. 보관은 대체됐지만 참조 때문에 남긴 문서다.

문서와 절 번호는 코드 주석(`shared/`, `backtest/`)과 CI 요약이 참조한다. 파일을 옮기거나 절 번호를 당기려면 참조를 함께 고쳐야 한다.
