import { asList, isRecord, readHistoryPayload, readLatestPayload, readNumber, type Direction, type DisplayStop, type DisplayVehicle, type HistoryBucket, type LatestPayload, type LatestRoute, type SeatState } from '../shared/model.js';

declare global {
  interface Window {
    __LATEST__?: unknown;
    __HISTORY__?: unknown;
    __CONFIG__?: unknown;
  }
}

interface Selection {
  routeName: string | null;
  direction: Direction;
}

type BoardState =
  | { kind: 'empty' }
  | { kind: 'ready'; route: LatestRoute };

interface LiveOverlay {
  routeId: string | null;
  vehicles: DisplayVehicle[];
  fetchedAt: number | null;
}

const liveApiUrl = 'https://apis.data.go.kr/6410000/buslocationservice/v2/getBusLocationListv2';
const liveFreshLimit = 180_000;

interface BoardingStop {
  routeName: string;
  direction: Direction | null;
  sequence: number;
  name: string;
}

interface BoardingRecord {
  date: string;
  recommendation: string;
  intuition: string;
  followed: string;
  result: string;
}

let selection: Selection = { routeName: null, direction: 'up' };
let destination = localStorage.getItem('bus-destination');
let destinationSkipped = false;
let expandedStopSequence: number | null = null;
let live: LiveOverlay = { routeId: null, vehicles: [], fetchedAt: null };
let boardingStop = readBoardingStop();
let recordFormOpen = false;

function readBoardingStop(): BoardingStop | null {
  try {
    const raw = localStorage.getItem('bus-boarding-stop');
    if (!raw) return null;
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value)) return null;
    const routeName = typeof value.routeName === 'string' ? value.routeName : null;
    const name = typeof value.name === 'string' ? value.name : null;
    const sequence = readNumber(value.sequence);
    if (!routeName || !name || sequence === null) return null;
    const direction = value.direction === 'up' || value.direction === 'down' ? value.direction : null;
    return { routeName, direction, sequence, name };
  } catch {
    return null;
  }
}

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`#${id} 요소가 없습니다.`);
  return element as T;
}

function latestPayload(): LatestPayload | null {
  return readLatestPayload(window.__LATEST__);
}

function crowdedLabel(crowded: number | null): string | null {
  if (crowded === 1) return '여유';
  if (crowded === 2) return '보통';
  if (crowded !== null && crowded >= 3) return '혼잡';
  return null;
}

function seatState(vehicle: DisplayVehicle): SeatState {
  const seats = vehicle.remainingSeats;
  if (seats !== null && seats >= 10) return 'ok';
  if (seats !== null && seats >= 1) return 'warn';
  if (seats === 0) return 'bad';
  return 'unknown';
}

function seatLabel(vehicle: DisplayVehicle): string {
  const seats = vehicle.remainingSeats;
  return seats !== null && seats >= 0 ? `${seats}석` : crowdedLabel(vehicle.crowded) ?? '정보 없음';
}

function minutesSince(isoText: string | null): number | null {
  if (!isoText) return null;
  const elapsed = Date.now() - new Date(isoText).getTime();
  return Number.isFinite(elapsed) ? Math.max(0, Math.round(elapsed / 60_000)) : null;
}

// 수집 워크플로의 피크 창 정의와 같은 값 (KST, 분 단위)
function expectedIntervalMinutes(): number {
  const shifted = new Date(Date.now() + 9 * 3600 * 1000);
  const day = shifted.getUTCDay();
  const minutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  const windows: Array<[number, number]> = day === 0 || day === 6 ? [[960, 1320]] : [[390, 630], [1050, 1290]];
  return windows.some(([start, end]) => minutes >= start && minutes < end) ? 10 : 60;
}

function currentRoute(payload: LatestPayload): LatestRoute | null {
  return payload.routes.find((entry) => entry.route.name === selection.routeName) ?? payload.routes[0] ?? null;
}

function boardState(): BoardState {
  const payload = latestPayload();
  const route = payload ? currentRoute(payload) : null;
  return route ? { kind: 'ready', route } : { kind: 'empty' };
}

function readHash(): void {
  const [routeName, direction] = decodeURIComponent(location.hash.slice(1)).split('/');
  if (routeName) selection.routeName = routeName;
  if (direction === 'up' || direction === 'down') selection.direction = direction;
}

function writeHash(route: LatestRoute): void {
  history.replaceState(null, '', `#${route.route.name}/${selection.direction}`);
}

function setBanner(message: string | null): void {
  const banner = getElement<HTMLDivElement>('stale-banner');
  banner.replaceChildren();
  banner.classList.toggle('show', message !== null);
  if (message) banner.textContent = message;
}

function liveApiKey(): string | null {
  const config = window.__CONFIG__;
  if (!isRecord(config)) return null;
  return typeof config.gbisApiKey === 'string' && config.gbisApiKey.length > 0 ? config.gbisApiKey : null;
}

function liveIsFresh(route: LatestRoute): boolean {
  return live.routeId === route.route.id && live.fetchedAt !== null && Date.now() - live.fetchedAt < liveFreshLimit;
}

function directionOf(sequence: number | null, turnSequence: number | null): Direction | null {
  if (sequence === null || turnSequence === null) return null;
  return sequence <= turnSequence ? 'up' : 'down';
}

// 라이브 응답의 차량번호(plateNo)는 읽지도 저장하지도 않는다 — 공개 정책과 동일 기준.
function readLiveVehicles(payload: unknown, turnSequence: number | null): DisplayVehicle[] {
  if (!isRecord(payload)) return [];
  const response = isRecord(payload.response) ? payload.response : payload;
  const body = isRecord(response.msgBody) ? response.msgBody : null;
  return asList(body ? body.busLocationList : undefined).flatMap((value) => {
    if (!isRecord(value)) return [];
    const stationSeq = readNumber(value.stationSeq);
    return [{
      id: null,
      stationSeq,
      remainingSeats: readNumber(value.remainSeatCnt),
      crowded: readNumber(value.crowded),
      status: readNumber(value.stateCd),
      direction: directionOf(stationSeq, turnSequence),
    }];
  });
}

async function refreshLiveVehicles(): Promise<void> {
  const apiKey = liveApiKey();
  const state = boardState();
  if (!apiKey || state.kind !== 'ready') return;
  const route = state.route;
  const requestUrl = new URL(liveApiUrl);
  requestUrl.search = new URLSearchParams({ serviceKey: apiKey, format: 'json', routeId: route.route.id }).toString();
  try {
    const response = await fetch(requestUrl, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`상태 ${response.status}`);
    live = {
      routeId: route.route.id,
      vehicles: readLiveVehicles(await response.json() as unknown, route.turnSequence),
      fetchedAt: Date.now(),
    };
    render();
  } catch (error: unknown) {
    console.warn(`실시간 좌석 조회 실패, 스냅샷으로 표시합니다: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// 추천 결정 규칙 초기값 — 근거는 설계 문서, 0단계 감사 후 조정 대상.
const recommendationMinSamples = 10;
const moveThreshold = 0.5;
const candidateThreshold = 0.25;

function currentSeoulBucket(): { bucket: number; weekend: boolean } {
  const seoulClock = new Date(Date.now() + 9 * 3600 * 1000);
  const day = seoulClock.getUTCDay();
  return {
    bucket: seoulClock.getUTCHours() * 2 + (seoulClock.getUTCMinutes() >= 30 ? 1 : 0),
    weekend: day === 0 || day === 6,
  };
}

function bucketLabel(bucket: number): string {
  return `${String(Math.floor(bucket / 2)).padStart(2, '0')}:${bucket % 2 === 0 ? '00' : '30'}`;
}

function historyCell(routeName: string, sequence: number): HistoryBucket | null {
  const payload = readHistoryPayload(window.__HISTORY__);
  if (!payload) return null;
  const route = payload.routes[routeName];
  if (!route) return null;
  const { bucket, weekend } = currentSeoulBucket();
  return (weekend ? route.weekend : route.weekday)[String(sequence)]?.[String(bucket)] ?? null;
}

function fullRate(cell: HistoryBucket): number {
  return cell.samples > 0 ? cell.zeroCount / cell.samples : 0;
}

type Recommendation =
  | { kind: 'unset' }
  | { kind: 'elsewhere' }
  | { kind: 'insufficient'; samples: number }
  | { kind: 'stay'; rate: number; samples: number }
  | { kind: 'move'; target: DisplayStop; hops: number; myRate: number; targetRate: number }
  | { kind: 'no-candidate'; rate: number };

function recommendationFor(route: LatestRoute): Recommendation {
  if (!boardingStop) return { kind: 'unset' };
  if (boardingStop.routeName !== route.route.name) return { kind: 'elsewhere' };
  const hasDirections = route.turnSequence !== null;
  const stops = hasDirections ? route.stops.filter((stop) => stop.direction === selection.direction) : route.stops;
  const myIndex = stops.findIndex((stop) => stop.sequence === boardingStop?.sequence);
  if (myIndex === -1) return { kind: 'elsewhere' };
  const myCell = historyCell(route.route.name, boardingStop.sequence);
  if (!myCell || myCell.samples < recommendationMinSamples) return { kind: 'insufficient', samples: myCell?.samples ?? 0 };
  const myRate = fullRate(myCell);
  if (myRate < moveThreshold) return { kind: 'stay', rate: myRate, samples: myCell.samples };
  for (let index = myIndex - 1; index >= 0; index -= 1) {
    const candidate = stops[index];
    if (!candidate) continue;
    const cell = historyCell(route.route.name, candidate.sequence);
    if (!cell || cell.samples < recommendationMinSamples) continue;
    if (fullRate(cell) < candidateThreshold) {
      return { kind: 'move', target: candidate, hops: myIndex - index, myRate, targetRate: fullRate(cell) };
    }
  }
  return { kind: 'no-candidate', rate: myRate };
}

function recommendationText(recommendation: Recommendation): string {
  switch (recommendation.kind) {
    case 'unset': return '정류장의 길찾기를 눌러 "이 정류장에서 타요"를 선택하면 추천이 시작됩니다.';
    case 'elsewhere': return '내 정류장이 이 노선·방향에 없습니다. 노선이나 방향을 바꿔보세요.';
    case 'insufficient': return `데이터 부족 — 이 시간대 관측 ${recommendation.samples}회 (기준 ${recommendationMinSamples}회). 수집이 쌓이면 자동으로 추천이 켜집니다.`;
    case 'stay': return `여기서 기다리세요 — 이 시간대 만석 빈도 ${Math.round(recommendation.rate * 100)}% (관측 ${recommendation.samples}회).`;
    case 'move': return `${recommendation.hops}정거장 앞 ${recommendation.target.name ?? `정류장 ${recommendation.target.sequence}`}에서 타세요 — 내 정류장 만석 ${Math.round(recommendation.myRate * 100)}%, 그곳은 ${Math.round(recommendation.targetRate * 100)}%.`;
    case 'no-candidate': return `만석 빈도 ${Math.round(recommendation.rate * 100)}% — 상류에 표본이 충분한 여유 정류장이 아직 없습니다.`;
  }
}

function readRecords(): BoardingRecord[] {
  try {
    const raw = localStorage.getItem('bus-boarding-records');
    const value = raw ? JSON.parse(raw) as unknown : [];
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is BoardingRecord => isRecord(entry) && typeof entry.date === 'string' && typeof entry.result === 'string');
  } catch {
    return [];
  }
}

// 카카오맵 오픈 API에는 대중교통 길찾기가 없어 링크로 위임한다.
// 스킴 브리지는 앱·모바일웹·데스크톱 모두에서 by=publictransit을 유지한다.
// map.kakao.com/link/* 웹 링크는 교통수단 파라미터가 없어 자가용으로 열리므로 쓰지 않는다.
function kakaoRouteHref(stop: DisplayStop): string | null {
  if (stop.latitude === null || stop.longitude === null) return null;
  return `https://m.map.kakao.com/scheme/route?ep=${stop.latitude},${stop.longitude}&by=publictransit`;
}

function normalizeStopName(name: string): string {
  return name.replace(/\s/g, '');
}

// 도착지가 수집 노선의 정류장과 이름이 겹치면 좌표를 얻어 정확한 경로 링크를 만든다.
function findDestinationStop(): DisplayStop | null {
  if (!destination) return null;
  const payload = latestPayload();
  if (!payload) return null;
  const target = normalizeStopName(destination);
  if (target.length === 0) return null;
  for (const entry of payload.routes) {
    const found = entry.stops.find((stop) => stop.name !== null && stop.latitude !== null && normalizeStopName(stop.name).includes(target));
    if (found) return found;
  }
  return null;
}

function destinationLegHref(stop: DisplayStop): string | null {
  if (!destination || stop.latitude === null || stop.longitude === null) return null;
  const target = findDestinationStop();
  if (!target || target.latitude === null || target.longitude === null) {
    return `https://map.kakao.com/link/search/${encodeURIComponent(destination)}`;
  }
  return `https://m.map.kakao.com/scheme/route?sp=${stop.latitude},${stop.longitude}&ep=${target.latitude},${target.longitude}&by=publictransit`;
}

function renderFreshness(route: LatestRoute): void {
  const badge = getElement<HTMLDivElement>('freshness');
  const label = getElement<HTMLSpanElement>('freshness-text');
  badge.className = 'freshness';
  if (liveIsFresh(route) && live.fetchedAt !== null) {
    const seconds = Math.round((Date.now() - live.fetchedAt) / 1000);
    badge.classList.add('ok');
    label.textContent = `실시간 · ${seconds < 5 ? '방금' : `${seconds}초 전`} 조회`;
    setBanner(null);
    return;
  }
  const minutes = minutesSince(route.collectedAt);
  if (minutes === null) {
    badge.classList.add('bad');
    label.textContent = '스냅샷 없음';
    setBanner('이 노선의 수집 기록이 없습니다. 수집기가 한 번이라도 성공했는지 확인하세요.');
    return;
  }

  const expected = expectedIntervalMinutes();
  const tierLabel = expected === 10 ? '집중 수집 시간대' : '시간당 수집 시간대';
  label.textContent = `${minutes === 0 ? '방금 수집됨' : `${minutes}분 전 수집`} · ${tierLabel}`;
  if (minutes <= expected * 2) {
    badge.classList.add('ok');
    setBanner(null);
    return;
  }
  if (minutes <= expected * 4) {
    badge.classList.add('warn');
    setBanner(null);
    return;
  }
  badge.classList.add('bad');
  setBanner(`마지막 수집이 ${minutes}분 전입니다. 이 시간대 기대 주기(${expected}분)를 크게 벗어났습니다.`);
}

function renderRouteTabs(payload: LatestPayload, route: LatestRoute): void {
  const container = getElement<HTMLDivElement>('route-tabs');
  container.replaceChildren(...payload.routes.map((entry) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = `route-tab${entry.route.name === route.route.name ? ' active' : ''}`;
    tab.textContent = entry.route.name;
    tab.addEventListener('click', () => {
      selection.routeName = entry.route.name;
      expandedStopSequence = null;
      render();
      void refreshLiveVehicles();
    });
    return tab;
  }));
}

function renderDirectionTabs(route: LatestRoute): void {
  const container = getElement<HTMLDivElement>('direction-tabs');
  if (route.turnSequence === null) {
    container.style.display = 'none';
    return;
  }
  container.style.display = '';
  const firstStop = route.stops[0]?.name ?? '기점';
  const turnStop = route.stops.find((stop) => stop.isTurn)?.name ?? '회차';
  const labels: Record<Direction, string> = { up: `${firstStop} → ${turnStop}`, down: `${turnStop} → ${firstStop}` };
  container.replaceChildren(...(['up', 'down'] as const).map((direction) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = `direction-tab${selection.direction === direction ? ' active' : ''}`;
    tab.textContent = labels[direction];
    tab.addEventListener('click', () => {
      selection.direction = direction;
      expandedStopSequence = null;
      writeHash(route);
      render();
    });
    return tab;
  }));
}

function renderDestinationChip(): void {
  const chip = getElement<HTMLButtonElement>('destination-chip');
  if (destination) {
    chip.hidden = false;
    chip.textContent = `도착지 ${destination} ✕`;
  } else {
    chip.hidden = true;
  }
}

function renderRecordList(): void {
  const list = getElement<HTMLPreElement>('record-list');
  const records = readRecords();
  getElement<HTMLSpanElement>('record-count').textContent = `${records.length}건`;
  list.textContent = records.length === 0
    ? '아직 기록이 없습니다. 매일 아침 결과를 남기면 추천 vs 경험칙 판정의 채점표가 됩니다.'
    : records.slice(-3).reverse().map((entry) => `${entry.date} · ${entry.result} · 추천 ${entry.followed} · 경험칙 "${entry.intuition}"`).join('\n');
}

function renderRecommendation(route: LatestRoute): void {
  const card = getElement<HTMLDivElement>('recommendation');
  card.replaceChildren();
  const recommendation = recommendationFor(route);
  card.className = `reco ${recommendation.kind}`;
  const title = document.createElement('div');
  title.className = 'reco-title';
  title.textContent = `탑승 추천 · ${bucketLabel(currentSeoulBucket().bucket)} 시간대`;
  const body = document.createElement('p');
  body.className = 'reco-body';
  body.textContent = recommendationText(recommendation);
  card.append(title, body);

  const actions = document.createElement('div');
  actions.className = 'reco-actions';
  if (boardingStop) {
    const stopChip = document.createElement('button');
    stopChip.type = 'button';
    stopChip.className = 'reco-stop';
    stopChip.textContent = `내 정류장 ${boardingStop.name} ✕`;
    stopChip.addEventListener('click', () => {
      boardingStop = null;
      localStorage.removeItem('bus-boarding-stop');
      render();
    });
    actions.append(stopChip);
  }
  const recordToggle = document.createElement('button');
  recordToggle.type = 'button';
  recordToggle.className = 'reco-record-toggle';
  recordToggle.textContent = recordFormOpen ? '기록 닫기' : '오늘 아침 기록';
  recordToggle.addEventListener('click', () => {
    recordFormOpen = !recordFormOpen;
    render();
  });
  actions.append(recordToggle);
  card.append(actions);

  getElement<HTMLDivElement>('record-section').classList.toggle('show', recordFormOpen);
  if (recordFormOpen) renderRecordList();
}

function nextVehicleFor(stopSequence: number, vehicles: DisplayVehicle[]): DisplayVehicle | null {
  return vehicles
    .filter((vehicle) => vehicle.stationSeq !== null && vehicle.stationSeq <= stopSequence)
    .sort((left, right) => (right.stationSeq ?? -1) - (left.stationSeq ?? -1))[0] ?? null;
}

function renderAxis(route: LatestRoute): void {
  const axis = getElement<HTMLDivElement>('axis');
  axis.replaceChildren();
  const hasDirections = route.turnSequence !== null;
  const stops = hasDirections ? route.stops.filter((stop) => stop.direction === selection.direction) : route.stops;
  const routeVehicles = liveIsFresh(route) ? live.vehicles : route.vehicles;
  const vehicles = hasDirections ? routeVehicles.filter((vehicle) => vehicle.direction === selection.direction) : routeVehicles;
  if (vehicles.length === 0) {
    const note = document.createElement('div');
    note.className = 'empty-note';
    note.textContent = '이 방향에 운행 중인 차량이 없습니다.';
    axis.append(note);
  }

  stops.forEach((stop, index) => {
    const row = document.createElement('div');
    row.className = 'stop-row';
    if (index === 0 || index === stops.length - 1) row.classList.add('terminal');
    const approaching = nextVehicleFor(stop.sequence, vehicles);
    if (approaching) row.classList.add(`tint-${seatState(approaching)}`);

    const dot = document.createElement('i');
    dot.className = 'stop-dot';
    const name = document.createElement('div');
    name.className = 'stop-name';
    name.textContent = stop.name ?? `정류장 ${stop.sequence}`;
    if (stop.isTurn) {
      const marker = document.createElement('small');
      marker.textContent = '회차 지점';
      name.append(marker);
    }
    if (boardingStop && boardingStop.routeName === route.route.name && boardingStop.sequence === stop.sequence) {
      row.classList.add('mine');
      const marker = document.createElement('small');
      marker.textContent = '내 정류장';
      name.append(marker);
    }
    row.append(dot, name);

    for (const vehicle of vehicles.filter((candidate) => candidate.stationSeq === stop.sequence)) {
      const pill = document.createElement('span');
      pill.className = `vehicle ${seatState(vehicle)}`;
      pill.textContent = seatLabel(vehicle);
      row.append(pill);
    }
    const routeHref = kakaoRouteHref(stop);
    if (routeHref) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'stop-route-link';
      toggle.textContent = '길찾기';
      toggle.setAttribute('aria-expanded', String(expandedStopSequence === stop.sequence));
      toggle.addEventListener('click', () => {
        expandedStopSequence = expandedStopSequence === stop.sequence ? null : stop.sequence;
        render();
      });
      row.append(toggle);
    }
    axis.append(row);

    if (routeHref && expandedStopSequence === stop.sequence) {
      const panel = document.createElement('div');
      panel.className = 'route-panel';
      const firstLeg = document.createElement('a');
      firstLeg.href = routeHref;
      firstLeg.target = '_blank';
      firstLeg.rel = 'noreferrer';
      firstLeg.textContent = '이 정류장까지';
      panel.append(firstLeg);
      const secondHref = destinationLegHref(stop);
      if (secondHref) {
        const secondLeg = document.createElement('a');
        secondLeg.href = secondHref;
        secondLeg.target = '_blank';
        secondLeg.rel = 'noreferrer';
        secondLeg.textContent = `여기서 ${destination}까지`;
        panel.append(secondLeg);
      }
      const boardHere = document.createElement('button');
      boardHere.type = 'button';
      boardHere.className = 'panel-board-here';
      boardHere.textContent = '이 정류장에서 타요 (추천 기준)';
      boardHere.addEventListener('click', () => {
        boardingStop = { routeName: route.route.name, direction: stop.direction, sequence: stop.sequence, name: stop.name ?? `정류장 ${stop.sequence}` };
        localStorage.setItem('bus-boarding-stop', JSON.stringify(boardingStop));
        expandedStopSequence = null;
        render();
      });
      panel.append(boardHere);
      axis.append(panel);
    }
  });
}

function render(): void {
  const state = boardState();
  const needsDestination = state.kind === 'ready' && destination === null && !destinationSkipped;
  getElement<HTMLDivElement>('setup').classList.toggle('show', state.kind === 'empty');
  getElement<HTMLDivElement>('destination-screen').classList.toggle('show', needsDestination);
  getElement<HTMLDivElement>('board').classList.toggle('show', state.kind === 'ready' && !needsDestination);
  renderDestinationChip();
  if (state.kind === 'empty' || needsDestination) return;

  const payload = latestPayload();
  if (!payload) return;
  selection.routeName = state.route.route.name;
  renderFreshness(state.route);
  renderRouteTabs(payload, state.route);
  renderDirectionTabs(state.route);
  renderRecommendation(state.route);
  getElement<HTMLParagraphElement>('route-endpoints').textContent = state.route.route.startStationName && state.route.route.endStationName
    ? `${state.route.route.startStationName} ↔ ${state.route.route.endStationName}`
    : '';
  renderAxis(state.route);
}

function reloadData(): void {
  const script = document.createElement('script');
  script.src = `data/latest.js?v=${Date.now()}`;
  script.addEventListener('load', () => {
    script.remove();
    render();
  });
  script.addEventListener('error', () => script.remove());
  document.body.append(script);
}

function loadLiveConfig(): void {
  const script = document.createElement('script');
  script.src = `data/config.js?v=${Date.now()}`;
  script.addEventListener('load', () => {
    script.remove();
    void refreshLiveVehicles();
  });
  script.addEventListener('error', () => script.remove());
  document.body.append(script);
}

getElement<HTMLFormElement>('destination-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = getElement<HTMLInputElement>('destination-input');
  const value = input.value.trim();
  if (!value) return;
  destination = value;
  localStorage.setItem('bus-destination', value);
  render();
});

getElement<HTMLButtonElement>('destination-skip').addEventListener('click', () => {
  destinationSkipped = true;
  render();
});

getElement<HTMLFormElement>('record-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const state = boardState();
  if (state.kind !== 'ready') return;
  const records = readRecords();
  records.push({
    date: new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10),
    recommendation: recommendationText(recommendationFor(state.route)),
    intuition: getElement<HTMLInputElement>('record-intuition').value.trim(),
    followed: getElement<HTMLSelectElement>('record-followed').value,
    result: getElement<HTMLSelectElement>('record-result').value,
  });
  localStorage.setItem('bus-boarding-records', JSON.stringify(records));
  getElement<HTMLInputElement>('record-intuition').value = '';
  renderRecordList();
});

getElement<HTMLButtonElement>('destination-chip').addEventListener('click', () => {
  destination = null;
  destinationSkipped = false;
  localStorage.removeItem('bus-destination');
  render();
});

window.addEventListener('hashchange', () => {
  readHash();
  render();
});

readHash();
render();
loadLiveConfig();
setInterval(reloadData, 60_000);
setInterval(() => void refreshLiveVehicles(), 60_000);
setInterval(() => {
  const state = boardState();
  if (state.kind === 'ready') renderFreshness(state.route);
}, 30_000);
