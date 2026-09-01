// 마지막에 낸 요청만 화면에 반영한다.
//
// 노선이나 방향을 빠르게 바꾸면 요청이 겹친다. 취소하지 않으면 앞선 요청의 응답이 뒤늦게
// 도착해 방금 고른 노선의 상태를 덮는다. 티켓을 새로 발급할 때 앞 티켓을 끊고, 응답이
// 돌아왔을 때 자기가 아직 최신인지 확인하게 한다.

export interface RequestTicket {
  readonly signal: AbortSignal;
  isLatest(): boolean;
  abort(): void;
}

export interface LatestRequestGate {
  issue(): RequestTicket;
  close(): void;
}

export function createLatestRequestGate(): LatestRequestGate {
  let latest: AbortController | null = null;

  return {
    issue() {
      latest?.abort();
      const controller = new AbortController();
      latest = controller;

      return {
        signal: controller.signal,
        isLatest: () => latest === controller,
        abort: () => controller.abort(),
      };
    },
    close() {
      latest?.abort();
      latest = null;
    },
  };
}
