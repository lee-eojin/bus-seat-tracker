import { asList, isRecord, readHistoryPayload, readIdentifier, readLatestPayload, readNumber, readProfilePayload, type Direction, type DisplayStop, type DisplayVehicle, type HistoryBucket, type LatestPayload, type LatestRoute, type ProfileCell, type SeatState } from '../shared/model.js';

declare global {
  interface Window {
    __LATEST__?: unknown;
    __HISTORY__?: unknown;
    __PROFILE__?: unknown;
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
const livePollIntervalMs = 30_000;
const phase0LogLimit = 600;

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
  waitingCount: number | null;
  alightingCount: number | null;
  userArrivedAt: string | null;
  busArrivedAt: string | null;
  fieldNote: string | null;
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

// 수집 워크플로의 창 정의와 같은 값 (KST, 분 단위): 평일 피크 06:30-10:00·17:30-20:30,
// 운행 시간대(평일 05-21시, 주말 06-23시 정시)는 시간당, 심야는 수집 휴지.
// 심야와 운행 재개 직후 2시간은 마지막 정시 스냅샷(평일 21시, 주말 23시) 이후 경과를
// 기대 주기로 삼는다 — 밤새, 그리고 아침 첫 스냅샷이 착지하기 전에 배너가 오작동하지 않게.
function expectedIntervalMinutes(): number {
  const shifted = new Date(Date.now() + 9 * 3600 * 1000);
  const day = shifted.getUTCDay();
  const minutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  const weekend = day === 0 || day === 6;
  const windows: Array<[number, number]> = weekend ? [] : [[390, 600], [1050, 1230]];
  if (windows.some(([start, end]) => minutes >= start && minutes < end)) return 10;
  const [serviceStart, serviceEnd, lastSlot] = weekend ? [360, 1380, 1380] : [300, 1320, 1260];
  if (minutes >= serviceStart + 120 && minutes < serviceEnd) return 60;
  if (minutes >= serviceEnd) return minutes - lastSlot + 60;
  const yesterday = (day + 6) % 7;
  const yesterdayLastSlot = yesterday === 0 || yesterday === 6 ? 1380 : 1260;
  return minutes + 1440 - yesterdayLastSlot + 60;
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

function readApiQueryTime(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const response = isRecord(payload.response) ? payload.response : payload;
  const header = isRecord(response.msgHeader) ? response.msgHeader : null;
  return header ? readIdentifier(header.queryTime) : null;
}

// GBIS queryTime은 KST 벽시계 문자열이다 (예: 2026-07-21 17:38:11.123)
function parseApiQueryTime(value: string | null): number | null {
  if (!value) return null;
  const time = new Date(`${value.replace(' ', 'T')}+09:00`).getTime();
  return Number.isFinite(time) ? time : null;
}

// Phase 0 관측 로그 (v2 §10.1): 수집 방식·페이지 활성·응답 지연을 관측과 함께 남긴다.
function appendPhase0Observation(route: LatestRoute, vehicles: DisplayVehicle[], apiQueryTime: string | null): void {
  try {
    const raw = localStorage.getItem('phase0-observations');
    const parsed = raw ? JSON.parse(raw) as unknown : [];
    const log = Array.isArray(parsed) ? parsed : [];
    const queryMillis = parseApiQueryTime(apiQueryTime);
    log.push({
      observedAt: new Date().toISOString(),
      apiQueryTime,
      responseAgeMs: queryMillis === null ? null : Date.now() - queryMillis,
      routeId: route.route.id,
      routeName: route.route.name,
      collectionMode: 'live-30s',
      pageActive: document.visibilityState === 'visible',
      vehicles: vehicles.map((vehicle) => ({ seq: vehicle.stationSeq, seats: vehicle.remainingSeats })),
    });
    localStorage.setItem('phase0-observations', JSON.stringify(log.slice(-phase0LogLimit)));
  } catch {
    // 로그 저장 실패가 화면 동작을 막지 않는다
  }
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
    const payload = await response.json() as unknown;
    live = {
      routeId: route.route.id,
      vehicles: readLiveVehicles(payload, route.turnSequence),
      fetchedAt: Date.now(),
    };
    appendPhase0Observation(route, live.vehicles, readApiQueryTime(payload));
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

function boardingProbability(cell: HistoryBucket): number {
  return 1 - fullRate(cell);
}

// Wilson score 95% 구간 — 표본이 적을 때 단순 비율보다 보수적으로 보여준다.
function wilsonInterval(successes: number, trials: number): { low: number; high: number } {
  if (trials === 0) return { low: 0, high: 1 };
  const z = 1.96;
  const rate = successes / trials;
  const denominator = 1 + (z * z) / trials;
  const center = (rate + (z * z) / (2 * trials)) / denominator;
  const spread = (z * Math.sqrt((rate * (1 - rate)) / trials + (z * z) / (4 * trials * trials))) / denominator;
  return { low: Math.max(0, center - spread), high: Math.min(1, center + spread) };
}

function percent(value: number): number {
  return Math.round(value * 100);
}

type Recommendation =
  | { kind: 'unset' }
  | { kind: 'elsewhere' }
  | { kind: 'insufficient'; samples: number }
  | { kind: 'stay'; cell: HistoryBucket }
  | { kind: 'move'; target: DisplayStop; hops: number; myCell: HistoryBucket; targetCell: HistoryBucket }
  | { kind: 'no-candidate'; cell: HistoryBucket };

function recommendationFor(route: LatestRoute): Recommendation {
  if (!boardingStop) return { kind: 'unset' };
  if (boardingStop.routeName !== route.route.name) return { kind: 'elsewhere' };
  const hasDirections = route.turnSequence !== null;
  const stops = hasDirections ? route.stops.filter((stop) => stop.direction === selection.direction) : route.stops;
  const myIndex = stops.findIndex((stop) => stop.sequence === boardingStop?.sequence);
  if (myIndex === -1) return { kind: 'elsewhere' };
  const myCell = historyCell(route.route.name, boardingStop.sequence);
  if (!myCell || myCell.samples < recommendationMinSamples) return { kind: 'insufficient', samples: myCell?.samples ?? 0 };
  if (fullRate(myCell) < moveThreshold) return { kind: 'stay', cell: myCell };
  for (let index = myIndex - 1; index >= 0; index -= 1) {
    const candidate = stops[index];
    if (!candidate) continue;
    const cell = historyCell(route.route.name, candidate.sequence);
    if (!cell || cell.samples < recommendationMinSamples) continue;
    if (fullRate(cell) < candidateThreshold) {
      return { kind: 'move', target: candidate, hops: myIndex - index, myCell, targetCell: cell };
    }
  }
  return { kind: 'no-candidate', cell: myCell };
}

function probabilityPhrase(cell: HistoryBucket): string {
  const interval = wilsonInterval(cell.samples - cell.zeroCount, cell.samples);
  return `탑승 확률 ${percent(boardingProbability(cell))}% (관측 ${cell.samples}회, 95% 구간 ${percent(interval.low)}~${percent(interval.high)}%)`;
}

function recommendationText(recommendation: Recommendation): string {
  switch (recommendation.kind) {
    case 'unset': return '정류장의 길찾기를 눌러 "이 정류장에서 타요"를 선택하면 추천이 시작됩니다.';
    case 'elsewhere': return '내 정류장이 이 노선·방향에 없습니다. 노선이나 방향을 바꿔보세요.';
    case 'insufficient': return `데이터 부족 — 이 시간대 관측 ${recommendation.samples}회 (기준 ${recommendationMinSamples}회). 수집이 쌓이면 자동으로 추천이 켜집니다.`;
    case 'stay': return `여기서 기다리세요. 이 시간대 ${probabilityPhrase(recommendation.cell)}.`;
    case 'move': return `${recommendation.hops}정거장 앞 ${recommendation.target.name ?? `정류장 ${recommendation.target.sequence}`}에서 타세요. 내 정류장 ${probabilityPhrase(recommendation.myCell)}, 그곳은 탑승 확률 ${percent(boardingProbability(recommendation.targetCell))}% (관측 ${recommendation.targetCell.samples}회).`;
    case 'no-candidate': return `${probabilityPhrase(recommendation.cell)}. 상류에 표본이 충분한 여유 정류장이 아직 없습니다.`;
  }
}

function readRecords(): BoardingRecord[] {
  try {
    const raw = localStorage.getItem('bus-boarding-records');
    const value = raw ? JSON.parse(raw) as unknown : [];
    if (!Array.isArray(value)) return [];
    return value
      .filter((entry): entry is BoardingRecord => isRecord(entry) && typeof entry.date === 'string' && typeof entry.result === 'string')
      .map((entry) => ({
        ...entry,
        waitingCount: readNumber(entry.waitingCount),
        alightingCount: readNumber(entry.alightingCount),
        userArrivedAt: typeof entry.userArrivedAt === 'string' && entry.userArrivedAt ? entry.userArrivedAt : null,
        busArrivedAt: typeof entry.busArrivedAt === 'string' && entry.busArrivedAt ? entry.busArrivedAt : null,
        fieldNote: typeof entry.fieldNote === 'string' && entry.fieldNote ? entry.fieldNote : null,
      }));
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
  const tierLabel = expected === 10 ? '집중 수집 시간대' : expected === 60 ? '시간당 수집 시간대' : '심야 수집 휴지';
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

function phase0ObservationCount(): number {
  try {
    const raw = localStorage.getItem('phase0-observations');
    const parsed = raw ? JSON.parse(raw) as unknown : [];
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function renderRecordList(): void {
  const list = getElement<HTMLPreElement>('record-list');
  const records = readRecords();
  getElement<HTMLSpanElement>('record-count').textContent = `${records.length}건`;
  getElement<HTMLSpanElement>('phase0-count').textContent = `${phase0ObservationCount()}건`;
  list.textContent = records.length === 0
    ? '아직 기록이 없습니다. 매일 아침 결과를 남기면 추천 vs 경험칙 판정의 채점표가 됩니다.'
    : records.slice(-3).reverse().map((entry) => {
      const counts = entry.waitingCount !== null || entry.alightingCount !== null
        ? ` · 대기 ${entry.waitingCount ?? '?'} 하차 ${entry.alightingCount ?? '?'}`
        : '';
      return `${entry.date} · ${entry.result} · 추천 ${entry.followed}${counts} · 경험칙 "${entry.intuition}"`;
    }).join('\n');
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

// ── Phase 1 좌석 전파 (v2 §4.3, §4.7) ─────────────────────────────
// 좌석 상태 공간이 0~45석 이산이라 근사 시뮬레이션 없이 정확한 DP로 전파한다.
// 만석(0석) 도달 후 하차 우세 구간에서 회복되는 경로도 분포 안에서 자연히 표현된다.
// 검증 중인 예측이며(v2 부록 A), 표본 부족 구간을 지난 값에는 * 를 붙인다.

interface SeatForecast {
  arrivalMean: number;
  boardableProbability: number;
  lowConfidence: boolean;
}

interface NetDemandEstimate {
  mean: number;
  sd: number;
  lowConfidence: boolean;
}

// 3330에는 2층버스가 다녀 잔여석 68까지 실측됨 — 일반차 44석 가정 금지 (v2 Phase 0 정원 항목)
const seatCapacity = 80;
const minutesPerStop = 2;
const demandMinWeight = 1;

function normalCdf(value: number): number {
  const scaled = value / Math.SQRT2;
  const sign = scaled < 0 ? -1 : 1;
  const t = 1 / (1 + 0.3275911 * Math.abs(scaled));
  const polynomial = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  const erf = 1 - polynomial * Math.exp(-scaled * scaled);
  return 0.5 * (1 + sign * erf);
}

function bucketAtMinutesAhead(minutesAhead: number): { bucket: number; weekend: boolean } {
  const seoulClock = new Date(Date.now() + minutesAhead * 60_000 + 9 * 3600 * 1000);
  const day = seoulClock.getUTCDay();
  return {
    bucket: seoulClock.getUTCHours() * 2 + (seoulClock.getUTCMinutes() >= 30 ? 1 : 0),
    weekend: day === 0 || day === 6,
  };
}

function profileCellAt(routeName: string, sequence: number, bucket: number, weekend: boolean): ProfileCell | null {
  const payload = readProfilePayload(window.__PROFILE__);
  const route = payload?.routes[routeName];
  if (!route) return null;
  return (weekend ? route.weekend : route.weekday)[String(sequence)]?.[String(((bucket % 48) + 48) % 48)] ?? null;
}

function netDemandAt(routeName: string, sequence: number, bucket: number, weekend: boolean): NetDemandEstimate {
  const exact = profileCellAt(routeName, sequence, bucket, weekend);
  let weight = exact?.weight ?? 0;
  let demandSum = exact?.demandSum ?? 0;
  let demandSquaredSum = exact?.demandSquaredSum ?? 0;
  let censoredWeight = exact?.censoredWeight ?? 0;
  if (weight < demandMinWeight) {
    for (const nearby of [bucket - 1, bucket + 1]) {
      const cell = profileCellAt(routeName, sequence, nearby, weekend);
      if (!cell) continue;
      weight += cell.weight;
      demandSum += cell.demandSum;
      demandSquaredSum += cell.demandSquaredSum;
      censoredWeight += cell.censoredWeight;
    }
  }
  if (weight <= 0) return { mean: 0, sd: 3, lowConfidence: true };
  const mean = demandSum / weight;
  const variance = Math.max(demandSquaredSum / weight - mean * mean, 1);
  const lowConfidence = weight < demandMinWeight || censoredWeight > weight * 0.5;
  return { mean, sd: Math.sqrt(variance) + (lowConfidence ? 1 : 0), lowConfidence };
}

function applyNetDemand(distribution: number[], estimate: NetDemandEstimate): number[] {
  const next = new Array<number>(seatCapacity + 1).fill(0);
  const lowest = Math.floor(estimate.mean - 3.5 * estimate.sd);
  const highest = Math.ceil(estimate.mean + 3.5 * estimate.sd);
  const demandProbabilities: Array<[number, number]> = [];
  let total = 0;
  for (let demand = lowest; demand <= highest; demand += 1) {
    const probability = normalCdf((demand + 0.5 - estimate.mean) / estimate.sd) - normalCdf((demand - 0.5 - estimate.mean) / estimate.sd);
    if (probability > 1e-4) {
      demandProbabilities.push([demand, probability]);
      total += probability;
    }
  }
  if (total <= 0) return distribution;
  for (let seats = 0; seats <= seatCapacity; seats += 1) {
    const mass = distribution[seats] ?? 0;
    if (mass <= 0) continue;
    for (const [demand, probability] of demandProbabilities) {
      const after = Math.min(seatCapacity, Math.max(0, seats - demand));
      next[after] = (next[after] ?? 0) + mass * (probability / total);
    }
  }
  return next;
}

function forecastVehicle(route: LatestRoute, vehicle: DisplayVehicle, stops: DisplayStop[]): Map<number, SeatForecast> {
  const forecasts = new Map<number, SeatForecast>();
  if (vehicle.stationSeq === null || vehicle.remainingSeats === null || vehicle.remainingSeats < 0) return forecasts;
  let distribution = new Array<number>(seatCapacity + 1).fill(0);
  distribution[Math.min(vehicle.remainingSeats, seatCapacity)] = 1;
  let lowConfidence = false;
  let stopsAhead = 0;
  for (const stop of stops) {
    if (stop.sequence <= vehicle.stationSeq) continue;
    stopsAhead += 1;
    let arrivalMean = 0;
    for (let seats = 1; seats <= seatCapacity; seats += 1) arrivalMean += (distribution[seats] ?? 0) * seats;
    const timeBucket = bucketAtMinutesAhead(stopsAhead * minutesPerStop);
    const estimate = netDemandAt(route.route.name, stop.sequence, timeBucket.bucket, timeBucket.weekend);
    lowConfidence = lowConfidence || estimate.lowConfidence;
    distribution = applyNetDemand(distribution, estimate);
    let boardableProbability = 0;
    for (let seats = 1; seats <= seatCapacity; seats += 1) boardableProbability += distribution[seats] ?? 0;
    forecasts.set(stop.sequence, { arrivalMean, boardableProbability, lowConfidence });
  }
  return forecasts;
}

function forecastTint(forecast: SeatForecast): string {
  if (forecast.boardableProbability >= 0.7) return 'ok';
  if (forecast.boardableProbability >= 0.3) return 'warn';
  return 'bad';
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

  const forecastsByVehicle = new Map<DisplayVehicle, Map<number, SeatForecast>>();
  for (const vehicle of vehicles) forecastsByVehicle.set(vehicle, forecastVehicle(route, vehicle, stops));

  stops.forEach((stop, index) => {
    const row = document.createElement('div');
    row.className = 'stop-row';
    if (index === 0 || index === stops.length - 1) row.classList.add('terminal');
    const approaching = nextVehicleFor(stop.sequence, vehicles);
    const forecast = approaching ? forecastsByVehicle.get(approaching)?.get(stop.sequence) : undefined;
    if (forecast) {
      row.classList.add(`tint-${forecastTint(forecast)}`);
    } else if (approaching) {
      row.classList.add(`tint-${seatState(approaching)}`);
    }

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

    if (forecast) {
      const forecastChip = document.createElement('span');
      forecastChip.className = 'stop-prob';
      forecastChip.textContent = `예상 ${Math.round(forecast.arrivalMean)}석${forecast.lowConfidence ? '*' : ''}`;
      row.append(forecastChip);
    } else {
      const probabilityCell = historyCell(route.route.name, stop.sequence);
      if (probabilityCell && probabilityCell.samples >= recommendationMinSamples) {
        const probability = document.createElement('span');
        probability.className = 'stop-prob';
        probability.textContent = `탑승 ${percent(boardingProbability(probabilityCell))}%`;
        row.append(probability);
      }
    }

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

getElement<HTMLButtonElement>('phase0-export').addEventListener('click', () => {
  let observations: unknown = [];
  let boardingRecords: unknown = [];
  try { observations = JSON.parse(localStorage.getItem('phase0-observations') ?? '[]') as unknown; } catch { /* 손상된 로그는 빈 배열로 */ }
  try { boardingRecords = JSON.parse(localStorage.getItem('bus-boarding-records') ?? '[]') as unknown; } catch { /* 동일 */ }
  const bundle = { exportedAt: new Date().toISOString(), observations, boardingRecords };
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `phase0-${new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
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
    waitingCount: readNumber(getElement<HTMLInputElement>('record-waiting').value),
    alightingCount: readNumber(getElement<HTMLInputElement>('record-alighting').value),
    userArrivedAt: getElement<HTMLInputElement>('record-user-arrived').value || null,
    busArrivedAt: getElement<HTMLInputElement>('record-bus-arrived').value || null,
    fieldNote: getElement<HTMLInputElement>('record-field-note').value.trim() || null,
  });
  localStorage.setItem('bus-boarding-records', JSON.stringify(records));
  for (const id of ['record-intuition', 'record-waiting', 'record-alighting', 'record-user-arrived', 'record-bus-arrived', 'record-field-note']) {
    getElement<HTMLInputElement>(id).value = '';
  }
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
// 라이브 폴링은 탭이 보일 때만 돈다 — 공유 API 키의 일일 쿼터 보호 (v2 §14.8)
setInterval(() => {
  if (document.visibilityState === 'visible') void refreshLiveVehicles();
}, livePollIntervalMs);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void refreshLiveVehicles();
});
setInterval(() => {
  const state = boardState();
  if (state.kind === 'ready') renderFreshness(state.route);
}, 30_000);
