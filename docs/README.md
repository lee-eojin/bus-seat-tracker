# 문서 안내

이 저장소의 문서는 번호순으로 읽지 않는다. 제품을 이해하려는 사람, 모델을 고치려는 사람, 배포를 맡은 사람이 필요한 문서가 서로 다르기 때문이다.

## 처음 읽는다면

제품이 왜 필요한지 알고 싶다면 다음 순서가 가장 짧다.

1. [제품 개요](product/overview.md)
2. [문제 검증](product/problem-validation.md)
3. [2026-07-27 시장 규모 측정](research/2026-07-27-market-size.md)

코드를 고치려면 다음 순서로 읽는다.

1. [아키텍처](architecture.md)
2. [모델 개념](model/concepts.md)
3. 기호부터 수식과 숫자 예시까지 한 흐름으로 볼 때는 [수학 입문서](model/mathematical-primer.md)
4. 변경하려는 기능의 기준 문서
   - [좌석 예보](model/seat-forecast.md)
   - [탑승 판정](model/boarding-verdict.md)
   - [대기 범위](model/queue-estimation.md)
5. 해당 디렉터리의 README와 테스트

배포와 수집을 맡았다면 [배포 절차](operations/deployment.md)와 [수집기 운영](operations/collector.md)부터 본다.

## 디렉터리별 역할

| 디렉터리 | 담는 내용 | 시간 기준 |
|---|---|---|
| `product/` | 사용자 문제, 제품 범위, 검증 상태 | 현재 판단 |
| `model/` | 지금 코드가 실행하는 계산과 공통 개념 | 현재 구현 |
| `design/` | 채택했거나 검토 중이지만 전부 구현되지는 않은 설계 | 목표 상태 |
| `research/` | 특정 날짜, 표본, 명령으로 얻은 결과 | 당시 스냅샷 |
| `operations/` | 배포, 수집, 자동 검증 절차 | 현재 절차 |
| `archive/` | 대체된 설계와 작업 일지 | 참고용 |

## 문서 상태

- **현재 구현**: 코드와 함께 바뀌어야 하는 기준 문서다.
- **설계안**: 방향은 채택했더라도 미구현 항목이 있을 수 있다. 구현 여부 표를 먼저 확인한다.
- **연구 기록**: 날짜와 표본이 고정되어 있다. 여기의 `현행`은 기록 당시를 뜻한다.
- **운영 절차**: 외부 서비스의 현재 상태를 단정하지 않고 확인 경로와 판정 방법을 적는다.
- **보관**: 현재 의사결정의 근거로 바로 사용하지 않는다.

## 문서 지도

### 제품

- [제품 개요](product/overview.md): 사용자가 보는 출력과 현재 범위
- [문제 검증](product/problem-validation.md): 현장 계수, 관측 자료, 인터뷰, 설문을 분리해 정리한 증거

### 모델

- [수학 입문서](model/mathematical-primer.md): 기호, 통계 용어, 모델 수식, 숫자 대입 예시를 한곳에 모은 참고서
- [개념 안내](model/concepts.md): 검열, 식별, 구간합, 확률 점수
- [좌석 예보](model/seat-forecast.md): 현재 잔여석에서 목적 정류장 도착 좌석까지
- [탑승 판정](model/boarding-verdict.md): `여유`, `빠듯`, `어려움` 규칙
- [대기 범위](model/queue-estimation.md): 고정 λ를 쓰는 현재 실험 기능과 한계

### 설계와 연구

- [v2 설계안](design/boarding-model-v2.md): 상태공간과 계층 효과, 공동 의사결정까지 포함한 목표 설계
- [2026-07-24 좌석 예보 검증](research/2026-07-24-seat-forecast-validation.md)
- [2026-07-27 시장 규모 측정](research/2026-07-27-market-size.md)
- [2026-07-26~08-02 대기열 복원 연구](research/2026-07-26-to-2026-08-02-queue-recovery.md)

### 구조와 운영

- [아키텍처](architecture.md)
- [배포 절차](operations/deployment.md)
- [수집기 운영](operations/collector.md)
- [예보 자동 검증](operations/forecast-validation.md)
- [운영 사고 기록](operations/incidents/)

### 보관

- [v1 모델 명세](archive/boarding-model-v1.md)
- [2026-07-28 제품 기획서 원문](archive/proposal-2026-07-28.md)
- [이전 작업 기록](archive/worklogs/)

## 링크를 바꿀 때

코드 주석, GitHub Actions 요약, 디자인 카드에도 문서 경로가 들어 있다. 파일을 옮기거나 제목을 바꾼 뒤에는 Markdown 링크만 보지 말고 저장소 전체에서 이전 경로를 검색한다. 행 번호는 쉽게 낡으므로 문서에서는 파일과 절 제목을 사용한다.
