// `/api/live` 응답 계약을 컴파일 시점에 고정한다.
//
// 서버(apps/api)와 브라우저(apps/web)가 같은 응답 모양을 각자 알고 있었고 둘을 잇는 시험이
// 없었다. 서버가 필드 이름을 바꾸거나 null 허용 범위를 넓혀도 아무 데서도 안 걸렸고, 런타임에
// 브라우저의 readNumber가 조용히 null을 돌려주면 화면에 정보 없음이 떴다.
//
// 아래 함수들은 일부러 틀리게 쓴 코드다. 타입이 제대로면 각 줄에서 오류가 나고 @ts-expect-error가
// 그걸 삼킨다. 누가 타입을 느슨하게 고쳐 오류가 사라지면 @ts-expect-error가 거꾸로 오류를 내서
// `npm run typecheck`에서 걸린다. 실행되지 않고 컴파일에만 참여하므로 비용이 없다.
// 파일 이름이 `.test.ts`가 아니라 `.typeTest.ts`인 것은 `npm test`가 이걸 실행 대상으로
// 잡지 않게 하려는 것이다.

import { fetchLiveSnapshot } from './gbis-client.js';
import { staleAtFor } from './handlers/live.js';
import type { LiveResponse, LiveSnapshot, LiveVehicle } from '../../../packages/domain/src/model.js';

// ── 데이터 경계 ──
// 차량번호와 원본 차량 ID는 계약에 없다. 읽으려는 코드가 타입 단계에서 막혀야 한다.
// 이 둘이 통과하기 시작하면 CLAUDE.md의 데이터 경계가 깨진 것이다.

function rejectsPlateNumber(vehicle: LiveVehicle): unknown {
  // @ts-expect-error plateNo는 공개 계약에 없다. 화면과 공개 저장소로 나가면 안 된다
  return vehicle.plateNo;
}

function rejectsUpstreamVehicleId(vehicle: LiveVehicle): unknown {
  // @ts-expect-error vehId(원본 차량 ID)도 계약에 없다. 수집기는 HMAC 가명화해서만 쓴다
  return vehicle.vehId;
}

// ── null 확인 강제 ──
// 상류가 좌석이나 위치를 안 줄 때가 있다. 확인 없이 쓰면 화면에 NaN이 흐른다.

function rejectsUncheckedSeats(vehicle: LiveVehicle): number {
  // @ts-expect-error remainingSeats는 null일 수 있어서 확인 없이 계산하면 막혀야 한다
  return vehicle.remainingSeats + 1;
}

function rejectsUncheckedStopSequence(vehicle: LiveVehicle): number {
  // @ts-expect-error currentStopSequence도 null일 수 있다
  const sequence: number = vehicle.currentStopSequence;
  return sequence;
}

function rejectsUncheckedQueryTime(snapshot: LiveSnapshot): string {
  // @ts-expect-error apiQueryTime은 상류가 안 줄 수 있어서 null 확인이 필요하다
  return snapshot.apiQueryTime.slice(0, 10);
}

// ── 계층 경계 ──
// staleAt은 서빙 정책이라 상류에서 읽어 온 판에는 없다. 핸들러가 붙인다.

function rejectsStaleAtOnSnapshot(snapshot: LiveSnapshot): unknown {
  // @ts-expect-error staleAt은 LiveResponse에만 있다. 상류 클라이언트가 정할 값이 아니다
  return snapshot.staleAt;
}

function rejectsSnapshotAsResponse(snapshot: LiveSnapshot): LiveResponse {
  // @ts-expect-error 낡음 선을 안 붙인 판을 그대로 응답으로 내보내면 막혀야 한다
  return snapshot;
}

// ── 여기서부터는 정상 코드다. 계약이 실제로 쓸 만한지 확인한다 ──

function upstreamSnapshotMatchesContract(): Promise<LiveSnapshot> {
  return fetchLiveSnapshot('3330', 'key-placeholder');
}

function handlerBuildsResponse(snapshot: LiveSnapshot): LiveResponse {
  return { ...snapshot, staleAt: staleAtFor(snapshot.observedAt) };
}

function narrowsSeatsBeforeUse(vehicle: LiveVehicle): number {
  return vehicle.remainingSeats === null ? 0 : vehicle.remainingSeats;
}

// 참조를 한 번씩 남겨 둔다. 검사기가 아니라 사람이 목록을 읽을 때 쓰라고 두는 것이다.
export const liveContractChecks = [
  rejectsPlateNumber,
  rejectsUpstreamVehicleId,
  rejectsUncheckedSeats,
  rejectsUncheckedStopSequence,
  rejectsUncheckedQueryTime,
  rejectsStaleAtOnSnapshot,
  rejectsSnapshotAsResponse,
  upstreamSnapshotMatchesContract,
  handlerBuildsResponse,
  narrowsSeatsBeforeUse,
] as const;
