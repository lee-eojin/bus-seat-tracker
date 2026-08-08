# 보관 문서

대체된 설계와 지난 작업 일지다. **현재 판단의 근거로 바로 쓰지 않는다.** 지금 코드가 무엇을 하는지 알고 싶으면 [문서 지도](../map.md)로 간다.

여기 남겨 두는 이유는 두 가지다. 왜 그런 결정을 했는지는 대체된 문서에만 남아 있고, v1 명세는 백테스트 비교 기준선의 원형이라 아직 현역이다.

## 대체된 설계

| 문서 | 내용 | 무엇으로 대체됐나 |
|---|---|---|
| [v1 모델 명세](boarding-model-v1.md) | 일일 배수와 균등 배분을 쓰던 첫 설계 | [좌석 예보](../model/seat-forecast.md). 백테스트 기준선 `full-frequency`의 원형으로는 아직 쓰인다 |
| [v2 명세 원문](boarding-model-v2-original-2026-07-21.md) | 2026-07-21 시점의 v2 설계 전문 | [v2 설계안](../design/boarding-model-v2.md). 그 설계에서 여전히 유효한 결정만 추린 버전이다 |
| [2026-07-28 제품 기획서](proposal-2026-07-28.md) | 초기 기획서 원문 | [제품 개요](../product/overview.md)와 [문제 검증](../product/problem-validation.md) |

## 작업 일지

서비스 출시 준비 기간의 기록이다. 당시의 계획, 진행, 발견을 시간순으로 남겼다.

- [계획](worklogs/service-launch-plan.md)
- [진행](worklogs/service-launch-progress.md)
- [발견](worklogs/service-launch-findings.md)
