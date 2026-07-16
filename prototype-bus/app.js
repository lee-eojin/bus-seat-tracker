let selectedRouteName = null;
let selectedDirection = 'up';

const getElement = (id) => document.getElementById(id);

function crowdedLabel(crowded) {
  if (crowded === 1) return '여유';
  if (crowded === 2) return '보통';
  if (crowded >= 3) return '혼잡';
  return null;
}

function seatState(vehicle) {
  const seats = vehicle.remainingSeats;
  if (Number.isFinite(seats) && seats >= 10) return 'ok';
  if (Number.isFinite(seats) && seats >= 1) return 'warn';
  if (seats === 0) return 'bad';
  return 'unknown';
}

function seatLabel(vehicle) {
  const seats = vehicle.remainingSeats;
  if (Number.isFinite(seats) && seats >= 0) return `${seats}석`;
  return crowdedLabel(vehicle.crowded) ?? '정보 없음';
}

function minutesSince(isoText) {
  if (!isoText) return null;
  const elapsed = Date.now() - new Date(isoText).getTime();
  return Number.isFinite(elapsed) ? Math.max(0, Math.round(elapsed / 60_000)) : null;
}

function currentRoute() {
  const routes = window.__LATEST__?.routes ?? [];
  return routes.find((entry) => entry.route.name === selectedRouteName) ?? routes[0] ?? null;
}

function readHash() {
  const [routeName, direction] = decodeURIComponent(location.hash.slice(1)).split('/');
  if (routeName) selectedRouteName = routeName;
  if (direction === 'up' || direction === 'down') selectedDirection = direction;
}

function writeHash() {
  const route = currentRoute();
  if (!route) return;
  history.replaceState(null, '', `#${route.route.name}/${selectedDirection}`);
}

function renderFreshness(route) {
  const badge = getElement('freshness');
  const banner = getElement('stale-banner');
  const minutes = minutesSince(route?.collectedAt);

  badge.className = 'freshness';
  banner.className = 'stale-banner';

  if (minutes === null) {
    badge.classList.add('bad');
    getElement('freshness-text').textContent = '스냅샷 없음';
    banner.classList.add('show');
    banner.innerHTML = '이 노선의 수집 기록이 없습니다. <code>collector.mjs</code>가 한 번이라도 성공했는지 확인하세요.';
    return;
  }

  const text = minutes === 0 ? '방금 수집됨' : `${minutes}분 전 수집`;
  getElement('freshness-text').textContent = text;

  if (minutes <= 10) {
    badge.classList.add('ok');
    return;
  }
  if (minutes <= 25) {
    badge.classList.add('warn');
    return;
  }
  badge.classList.add('bad');
  banner.classList.add('show');
  banner.innerHTML = `마지막 수집이 ${minutes}분 전입니다. 수집이 멈춘 것 같습니다 — GitHub Actions의 <code>collect-bus-seats</code> 실행 기록을 확인하세요.`;
}

function renderRouteTabs() {
  const container = getElement('route-tabs');
  container.replaceChildren();
  for (const entry of window.__LATEST__.routes) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = `route-tab${entry === currentRoute() ? ' active' : ''}`;
    tab.textContent = entry.route.name;
    tab.onclick = () => {
      selectedRouteName = entry.route.name;
      writeHash();
      render();
    };
    container.append(tab);
  }
}

function renderDirectionTabs(route) {
  const container = getElement('direction-tabs');
  container.replaceChildren();

  if (!Number.isFinite(route.turnSequence)) {
    container.style.display = 'none';
    return;
  }
  container.style.display = '';

  const firstStop = route.stops[0]?.name ?? '기점';
  const turnStop = route.stops.find((stop) => stop.isTurn)?.name ?? '회차';
  const labels = { up: `${firstStop} → ${turnStop}`, down: `${turnStop} → ${firstStop}` };

  for (const direction of ['up', 'down']) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = `direction-tab${selectedDirection === direction ? ' active' : ''}`;
    tab.textContent = labels[direction];
    tab.onclick = () => {
      selectedDirection = direction;
      writeHash();
      render();
    };
    container.append(tab);
  }
}

function nextVehicleFor(stopSequence, vehicles) {
  return vehicles
    .filter((vehicle) => Number.isFinite(vehicle.stationSeq) && vehicle.stationSeq <= stopSequence)
    .sort((left, right) => right.stationSeq - left.stationSeq)[0] ?? null;
}

function renderAxis(route) {
  const axis = getElement('axis');
  axis.replaceChildren();

  const hasDirections = Number.isFinite(route.turnSequence);
  const stops = hasDirections
    ? route.stops.filter((stop) => stop.direction === selectedDirection)
    : route.stops;
  const vehicles = hasDirections
    ? route.vehicles.filter((vehicle) => vehicle.direction === selectedDirection)
    : route.vehicles;

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

    row.append(dot, name);

    for (const vehicle of vehicles.filter((candidate) => candidate.stationSeq === stop.sequence)) {
      const pill = document.createElement('span');
      pill.className = `vehicle ${seatState(vehicle)}`;
      pill.textContent = `${vehicle.id ?? '차량'} · ${seatLabel(vehicle)}`;
      row.append(pill);
    }

    axis.append(row);
  });
}

function render() {
  const hasData = Boolean(window.__LATEST__?.routes?.length);
  getElement('setup').classList.toggle('show', !hasData);
  getElement('board').classList.toggle('show', hasData);
  if (!hasData) return;

  const route = currentRoute();
  selectedRouteName = route.route.name;

  renderFreshness(route);
  renderRouteTabs();
  renderDirectionTabs(route);

  const { startStationName, endStationName } = route.route;
  getElement('route-endpoints').textContent = startStationName && endStationName
    ? `${startStationName} ↔ ${endStationName}`
    : '';

  renderAxis(route);
}

function reloadData() {
  const script = document.createElement('script');
  script.src = `data/latest.js?v=${Date.now()}`;
  script.onload = () => {
    script.remove();
    render();
  };
  script.onerror = () => script.remove();
  document.body.append(script);
}

window.addEventListener('hashchange', () => {
  readHash();
  render();
});

readHash();
render();
setInterval(reloadData, 60_000);
setInterval(() => {
  if (window.__LATEST__?.routes?.length) renderFreshness(currentRoute());
}, 30_000);
