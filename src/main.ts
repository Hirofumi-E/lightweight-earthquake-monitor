import './style.css';
import { fetchRecentEarthquakes, parseEarthquake, parseShakeDetection, parseUserquake } from './api';
import { EarthquakeStore } from './earthquakeStore';
import { MAP_VIEWBOX, projectCoordinates, projectEpicenter } from './mapProjection';
import areasData from './epspAreas.json';
import type { Earthquake, EpspArea, ShakeDetection } from './types';

const japanMapUrl = new URL('./assets/japan-map.svg', import.meta.url).href;
const epspAreas = areasData as EpspArea[];
const areaByCode = new Map<string, EpspArea>();
for (const area of epspAreas) {
  areaByCode.set(area.code, area);
  const numericCode = String(Number(area.code));
  if (numericCode !== area.code) areaByCode.set(numericCode, area);
}
const SETTINGS_STORAGE_KEY = 'lightweight-earthquake-monitor.settings';
const DETECTION_TIMEOUT_MS = 30_000;
const HIGH_CONFIDENCE_THRESHOLD = 0.8;

interface MonitorSettings {
  shakeDetectionEnabled: boolean;
  autoFocusEnabled: boolean;
  realtimeIntensityEnabled: false;
}

const DEFAULT_SETTINGS: MonitorSettings = {
  shakeDetectionEnabled: true,
  autoFocusEnabled: true,
  realtimeIntensityEnabled: false,
};

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('アプリの表示領域が見つかりません');

app.innerHTML = `
  <div class="shell">
    <header class="topbar">
      <h1 class="brand">Lightweight Earthquake Monitor</h1>
      <div class="header-actions">
        <div id="shake-status" class="shake-status" role="status" aria-live="polite" hidden>
          <span class="shake-status-label">揺れを検出しています</span>
          <span id="shake-status-detail" class="shake-status-detail"></span>
          <small>P2P感知解析結果</small>
        </div>
        <button id="settings-toggle" class="settings-toggle" type="button" aria-expanded="false" aria-controls="settings-panel" title="動作設定">⚙ 設定</button>
        <div id="connection-status" class="live is-offline" role="status" aria-live="polite"><span class="live-dot"></span><span id="connection-label">OFFLINE</span></div>
      </div>
      <section id="settings-panel" class="settings-panel" aria-label="動作設定" hidden>
      <div class="settings-heading"><h2>動作設定</h2><span>保存済み</span></div>
      <label class="settings-row">
        <span><strong>揺れ検出機能</strong><small>9611解析結果を表示</small></span>
        <input id="shake-detection-toggle" class="settings-checkbox" type="checkbox" checked />
      </label>
      <label class="settings-row">
        <span><strong>揺れ検出時に対象地域へ自動フォーカス</strong><small>信頼度Aの地域へ一時移動</small></span>
        <input id="auto-focus-toggle" class="settings-checkbox" type="checkbox" checked />
      </label>
      <div class="settings-row is-disabled">
        <span><strong>リアルタイム震度</strong><small>データソース準備中</small></span>
        <input class="settings-checkbox" type="checkbox" disabled aria-label="リアルタイム震度（データソース準備中）" />
      </div>
      <p class="settings-note">揺れ検出はP2P地震情報ユーザーの感知情報を解析した状態です。震度観測や地震発生の確定を示すものではありません。</p>
      </section>
    </header>
    <main class="workspace">
      <aside class="information-panel" aria-label="最新地震情報と地震履歴">
        <section id="latest-card" class="latest-panel" aria-label="最新の地震情報" aria-live="polite">
          <div class="panel-section-heading"><h2>最新の地震</h2><span class="latest-indicator"><i></i>最新</span></div>
          <div id="latest-loading" class="loading"><span class="spinner"></span>地震情報を取得しています</div>
          <article id="latest-details" class="latest-details" hidden>
            <div class="latest-intensity-label">最大震度</div>
            <strong id="latest-scale" class="scale-badge">—</strong>
            <strong id="latest-place-name" class="latest-place">—</strong>
            <time id="latest-date" class="latest-time">—</time>
            <div class="latest-measures"><span id="latest-magnitude">M —</span><span id="latest-depth">深さ —</span></div>
          </article>
          <div class="panel-update"><span>情報状態</span><span id="updated-at">取得準備中</span></div>
        </section>
        <section class="history-panel" aria-labelledby="history-heading">
          <div class="panel-section-heading"><div><h2 id="history-heading">地震履歴</h2><p>最近の情報 最大10件</p></div><span id="event-count" class="event-count">—</span></div>
          <div id="earthquake-list" class="earthquake-list"><div class="list-loading">情報を読み込んでいます</div></div>
        </section>
      </aside>
      <section class="map-panel" aria-label="日本地図と震源">
        <div class="map-legend" aria-label="地図の凡例"><span><i class="legend-current"></i>最新の震源</span><span><i class="legend-detection"></i>揺れ検出地域</span><span><i class="legend-past"></i>過去の震源</span></div>
        <svg id="japan-map" class="japan-map" viewBox="0 0 800 800" role="img" aria-label="日本の都道府県地図と最近の震源位置">
          <image href="${japanMapUrl}" width="800" height="800" />
          <g id="earthquake-markers" class="earthquake-markers" aria-label="最近の震源">
            <g id="historical-earthquake-markers" aria-label="過去の震源" />
            <g id="shake-detection-markers" class="shake-detection-markers" aria-label="揺れ検出地域" />
            <g id="latest-earthquake-marker" aria-label="最新の震源" />
          </g>
        </svg>
        <p class="map-attribution">地図：気象庁「地震情報／都道府県等」のデータを加工して作成</p>
        <p id="map-status" class="map-status">地震情報を取得しています</p>
      </section>
    </div>
  </div>`;

const latestCard = document.querySelector<HTMLElement>('#latest-card')!;
const list = document.querySelector<HTMLDivElement>('#earthquake-list')!;
const updatedAt = document.querySelector<HTMLSpanElement>('#updated-at')!;
const eventCount = document.querySelector<HTMLSpanElement>('#event-count')!;
const latestLoading = document.querySelector<HTMLDivElement>('#latest-loading')!;
const latestDetails = document.querySelector<HTMLElement>('#latest-details')!;
const latestScale = document.querySelector<HTMLElement>('#latest-scale')!;
const latestPlace = document.querySelector<HTMLElement>('#latest-place-name')!;
const latestDate = document.querySelector<HTMLElement>('#latest-date')!;
const latestMagnitude = document.querySelector<HTMLElement>('#latest-magnitude')!;
const latestDepth = document.querySelector<HTMLElement>('#latest-depth')!;
const japanMap = document.querySelector<SVGSVGElement>('#japan-map')!;
const shakeDetectionMarkers = document.querySelector<SVGGElement>('#shake-detection-markers')!;
const historicalEarthquakeMarkers = document.querySelector<SVGGElement>('#historical-earthquake-markers')!;
const latestEarthquakeMarker = document.querySelector<SVGGElement>('#latest-earthquake-marker')!;
const mapStatus = document.querySelector<HTMLParagraphElement>('#map-status')!;
const connectionStatus = document.querySelector<HTMLDivElement>('#connection-status')!;
const connectionLabel = document.querySelector<HTMLSpanElement>('#connection-label')!;
const shakeStatus = document.querySelector<HTMLDivElement>('#shake-status')!;
const shakeStatusDetail = document.querySelector<HTMLSpanElement>('#shake-status-detail')!;
const settingsToggle = document.querySelector<HTMLButtonElement>('#settings-toggle')!;
const settingsPanel = document.querySelector<HTMLElement>('#settings-panel')!;
const shakeDetectionToggle = document.querySelector<HTMLInputElement>('#shake-detection-toggle')!;
const autoFocusToggle = document.querySelector<HTMLInputElement>('#auto-focus-toggle')!;
const store = new EarthquakeStore();
let hasLoaded = false;
let disposed = false;
let historyRequestInFlight = false;
let queuedHistorySync = false;
let historyController: AbortController | undefined;
let socket: WebSocket | null = null;
let reconnectTimer: number | undefined;
let reconnectAttempt = 0;
let connectionEstablished = false;
let selectedEarthquakeId: string | null = null;
let settings = readSettings();
let currentShakeDetection: ShakeDetection | null = null;
let shakeDetectionTimer: number | undefined;
let lastFocusedShakeEvent: string | null = null;
const lifecycle = new AbortController();

function readSettings(): MonitorSettings {
  try {
    const stored = JSON.parse(window.localStorage.getItem(SETTINGS_STORAGE_KEY) ?? 'null') as Partial<MonitorSettings> | null;
    return {
      shakeDetectionEnabled: stored?.shakeDetectionEnabled !== false,
      autoFocusEnabled: stored?.autoFocusEnabled !== false,
      realtimeIntensityEnabled: false,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(): void {
  try {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // 設定を保存できない環境でも、現在のページ内では機能を継続します。
  }
}

function resetMapView(): void {
  japanMap.setAttribute('viewBox', `${MAP_VIEWBOX.x} ${MAP_VIEWBOX.y} ${MAP_VIEWBOX.width} ${MAP_VIEWBOX.height}`);
}

function highConfidenceAreas(detection: ShakeDetection | null): Array<{ area: EpspArea; confidence: number }> {
  if (!detection) return [];
  const result: Array<{ area: EpspArea; confidence: number }> = [];
  for (const [code, confidence] of detection.areaConfidences) {
    const area = areaByCode.get(code);
    if (area && confidence >= HIGH_CONFIDENCE_THRESHOLD) result.push({ area, confidence });
  }
  return result;
}

function focusMapOnAreas(areas: Array<{ area: EpspArea; confidence: number }>): boolean {
  const points = areas
    .map(({ area }) => projectCoordinates(area.latitude, area.longitude))
    .filter((point): point is { x: number; y: number } => point !== null);
  if (points.length === 0) return false;

  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  const padding = points.length === 1 ? 135 : 80;
  const width = Math.min(MAP_VIEWBOX.width, Math.max(points.length === 1 ? 220 : 180, maxX - minX + padding * 2));
  const height = Math.min(MAP_VIEWBOX.height, Math.max(points.length === 1 ? 220 : 180, maxY - minY + padding * 2));
  const x = Math.max(MAP_VIEWBOX.x, Math.min(MAP_VIEWBOX.width - width, (minX + maxX - width) / 2));
  const y = Math.max(MAP_VIEWBOX.y, Math.min(MAP_VIEWBOX.height - height, (minY + maxY - height) / 2));
  japanMap.setAttribute('viewBox', `${x.toFixed(2)} ${y.toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)}`);
  return true;
}

function renderShakeDetection(): void {
  shakeDetectionMarkers.replaceChildren();
  if (!settings.shakeDetectionEnabled || !currentShakeDetection) {
    shakeStatus.hidden = true;
    shakeStatusDetail.textContent = '';
    return;
  }

  const areas = highConfidenceAreas(currentShakeDetection);
  for (const { area, confidence } of areas) {
    const point = projectCoordinates(area.latitude, area.longitude);
    if (!point) continue;
    const marker = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    marker.setAttribute('class', 'shake-area-marker');
    marker.setAttribute('transform', `translate(${point.x} ${point.y})`);
    marker.setAttribute('role', 'img');
    marker.setAttribute('aria-label', `${area.name}、信頼度A（${Math.round(confidence * 100)}%）`);

    const halo = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    halo.setAttribute('class', 'shake-area-halo');
    halo.setAttribute('r', '13');
    marker.append(halo);
    const core = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    core.setAttribute('class', 'shake-area-core');
    core.setAttribute('r', '5');
    marker.append(core);
    shakeDetectionMarkers.append(marker);
  }

  shakeStatus.hidden = false;
  shakeStatusDetail.textContent = areas.length > 0
    ? `${areaSummary(areas)} ${areas.length}地域`
    : '信頼度Aの地域なし';
}

function areaSummary(areas: Array<{ area: EpspArea; confidence: number }>): string {
  const regions = [...new Set(areas.map(({ area }) => area.region))];
  return regions.slice(0, 2).join('・') + (regions.length > 2 ? 'ほか' : '');
}

function clearShakeDetection(): void {
  if (shakeDetectionTimer !== undefined) window.clearTimeout(shakeDetectionTimer);
  shakeDetectionTimer = undefined;
  currentShakeDetection = null;
  lastFocusedShakeEvent = null;
  resetMapView();
  renderShakeDetection();
}

function scheduleShakeDetectionExpiry(): void {
  if (shakeDetectionTimer !== undefined) window.clearTimeout(shakeDetectionTimer);
  shakeDetectionTimer = window.setTimeout(() => {
    shakeDetectionTimer = undefined;
    currentShakeDetection = null;
    lastFocusedShakeEvent = null;
    resetMapView();
    renderShakeDetection();
  }, DETECTION_TIMEOUT_MS);
}

function updateShakeDetection(detection: ShakeDetection): void {
  if (!settings.shakeDetectionEnabled || detection.count <= 0 || detection.confidence <= 0) {
    clearShakeDetection();
    return;
  }

  currentShakeDetection = detection;
  const areas = highConfidenceAreas(detection);
  if (settings.autoFocusEnabled && areas.length > 0 && lastFocusedShakeEvent !== detection.startedAt) {
    if (focusMapOnAreas(areas)) lastFocusedShakeEvent = detection.startedAt;
  }
  renderShakeDetection();
  scheduleShakeDetectionExpiry();
}

function applySettings(): void {
  shakeDetectionToggle.checked = settings.shakeDetectionEnabled;
  autoFocusToggle.checked = settings.autoFocusEnabled;
  if (!settings.shakeDetectionEnabled) clearShakeDetection();
  else if (!settings.autoFocusEnabled) {
    lastFocusedShakeEvent = null;
    resetMapView();
  }
  else if (currentShakeDetection) {
    const areas = highConfidenceAreas(currentShakeDetection);
    if (areas.length > 0 && lastFocusedShakeEvent !== currentShakeDetection.startedAt && focusMapOnAreas(areas)) {
      lastFocusedShakeEvent = currentShakeDetection.startedAt;
    }
  }
  renderShakeDetection();
  saveSettings();
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '時刻不明';
  return new Intl.DateTimeFormat('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

function scaleLabel(scale: number | null): string {
  if (scale === null) return '不明';
  const labels: Record<number, string> = { 10: '1', 20: '2', 30: '3', 40: '4', 45: '5弱', 50: '5強', 55: '6弱', 60: '6強', 70: '7' };
  return labels[scale] ?? '不明';
}

function renderLatest(latest: Earthquake | undefined): void {
  if (!latest) {
    latestDetails.hidden = true;
    latestLoading.hidden = false;
    latestLoading.innerHTML = '<div class="empty-state">表示できる地震情報はありません</div>';
    mapStatus.textContent = '表示できる地震情報はありません';
    return;
  }

  latestLoading.hidden = true;
  latestDetails.hidden = false;
  latestScale.textContent = scaleLabel(latest.maxScale);
  latestPlace.textContent = latest.hypocenter;
  latestDate.textContent = formatTime(latest.time);
  latestMagnitude.textContent = `M ${latest.magnitude?.toFixed(1) ?? '—'}`;
  latestDepth.textContent = latest.depth === null ? '深さ —' : latest.depth === 0 ? 'ごく浅い' : `深さ ${latest.depth} km`;

}

function renderList(earthquakes: readonly Earthquake[]): void {
  if (earthquakes.length === 0) {
    list.innerHTML = '<div class="empty-state">最近の地震情報はありません</div>';
    eventCount.textContent = '0件';
    return;
  }

  list.innerHTML = earthquakes.map((quake, index) => `
    <button class="quake-row ${index === 0 ? 'is-latest' : ''} ${selectedEarthquakeId === quake.id ? 'is-selected' : ''}" type="button" data-earthquake-id="${escapeHtml(quake.id)}" aria-pressed="${selectedEarthquakeId === quake.id}">
      <time datetime="${escapeHtml(quake.time)}">${formatTime(quake.time)}</time>
      <strong class="quake-place">${escapeHtml(quake.hypocenter)}</strong>
      <span class="row-scale">震度 <b>${scaleLabel(quake.maxScale)}</b></span>
      <span class="row-measure">M ${quake.magnitude?.toFixed(1) ?? '—'}<small>${quake.depth === null ? '深さ —' : quake.depth === 0 ? 'ごく浅い' : `深さ ${quake.depth} km`}</small></span>
    </button>`).join('');
  eventCount.textContent = `${earthquakes.length}件`;
}

function intensityClass(scale: number | null): string {
  if (scale !== null && scale >= 55) return 'intensity-severe';
  if (scale !== null && scale >= 40) return 'intensity-strong';
  if (scale !== null && scale >= 30) return 'intensity-moderate';
  return 'intensity-light';
}

function renderMarkers(earthquakes: readonly Earthquake[], animateLatest = false): void {
  if (selectedEarthquakeId && !earthquakes.some((quake) => quake.id === selectedEarthquakeId)) selectedEarthquakeId = null;
  const latest = earthquakes[0];
  const historicalMarkerNodes: SVGGElement[] = [];
  const latestMarkerNodes: SVGGElement[] = [];
  let mappableCount = 0;
  const drawable = [...earthquakes].reverse();

  for (let index = 0; index < drawable.length; index += 1) {
    const quake = drawable[index];
    const point = projectEpicenter(quake);
    if (!point) continue;
    mappableCount += 1;
    const isLatest = quake.id === latest?.id;
    const isSelected = quake.id === (selectedEarthquakeId ?? latest?.id);
    const marker = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    const originalIndex = earthquakes.findIndex((item) => item.id === quake.id);
    const classes = ['epicenter-marker', intensityClass(quake.maxScale)];
    if (isLatest) classes.push('is-latest');
    if (isSelected) classes.push('is-selected');
    if (animateLatest && isLatest) classes.push('is-new');
    marker.setAttribute('class', classes.join(' '));
    marker.setAttribute('transform', `translate(${point.x} ${point.y})`);
    marker.setAttribute('role', 'img');
    marker.setAttribute('aria-label', `${quake.hypocenter}、震度${scaleLabel(quake.maxScale)}${isLatest ? '、最新' : ''}`);
    marker.style.opacity = isLatest || isSelected ? '1' : String(Math.max(0.3, 0.82 - originalIndex * 0.055));

    const radius = (isLatest ? 5 : 3.2) + Math.min(7, (quake.maxScale ?? 10) / 10) * 0.35;
    const halo = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    halo.setAttribute('class', 'marker-halo');
    halo.setAttribute('r', String(radius + (isLatest || isSelected ? 6 : 2)));
    marker.append(halo);

    if (isLatest || isSelected) {
      const ring = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      ring.setAttribute('class', 'marker-ring');
      ring.setAttribute('r', String(radius + 3));
      marker.append(ring);
    }

    const core = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    core.setAttribute('class', 'marker-core');
    core.setAttribute('r', String(radius));
    marker.append(core);

    if (isLatest || isSelected) {
      const center = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      center.setAttribute('class', 'marker-center');
      center.setAttribute('r', '1.7');
      marker.append(center);
    }

    if (animateLatest && isLatest) {
      const pulse = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      pulse.setAttribute('class', 'marker-pulse');
      pulse.setAttribute('r', String(radius + 7));
      marker.prepend(pulse);
    }
    if (isLatest) latestMarkerNodes.push(marker);
    else historicalMarkerNodes.push(marker);
  }

  historicalEarthquakeMarkers.replaceChildren(...historicalMarkerNodes);
  latestEarthquakeMarker.replaceChildren(...latestMarkerNodes);
  if (!latest) {
    mapStatus.textContent = '表示できる地震情報はありません';
    japanMap.setAttribute('aria-label', '日本地図。表示できる地震情報はありません');
    return;
  }

  const selected = earthquakes.find((quake) => quake.id === selectedEarthquakeId) ?? latest;
  const selectedPoint = projectEpicenter(selected);
  if (!selectedPoint) {
    const hasCoordinates = selected.latitude !== null && selected.longitude !== null;
    mapStatus.textContent = hasCoordinates ? '震源は地図の表示範囲外です' : '震源座標を取得できません';
    japanMap.setAttribute('aria-label', '日本地図。震源位置を表示できません');
    return;
  }
  const prefix = selected.id === latest.id ? '最新' : '選択中';
  mapStatus.textContent = `${prefix}：${selected.hypocenter} / 地図上 ${mappableCount}件`;
  japanMap.setAttribute('aria-label', `日本地図。最近の震源${mappableCount}件を表示。${selected.hypocenter}を強調中`);
}

function renderAll(animateLatest = false): void {
  renderLatest(store.recent[0]);
  renderMarkers(store.recent, animateLatest);
  renderList(store.recent);
  hasLoaded = true;
  document.querySelector('#refresh-error')?.remove();
}

function setConnectionState(state: 'live' | 'reconnecting' | 'offline'): void {
  connectionStatus.classList.remove('is-live', 'is-reconnecting', 'is-offline');
  connectionStatus.classList.add(`is-${state}`);
  connectionLabel.textContent = state === 'live' ? 'LIVE' : state === 'reconnecting' ? 'RECONNECTING' : 'OFFLINE';
}

function updateTimestamp(prefix = '最終更新'): void {
  updatedAt.textContent = `${prefix} ${new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date())}`;
}

applySettings();

settingsToggle.addEventListener('click', () => {
  const shouldOpen = settingsPanel.hidden;
  settingsPanel.hidden = !shouldOpen;
  settingsToggle.setAttribute('aria-expanded', String(shouldOpen));
}, { signal: lifecycle.signal });

shakeDetectionToggle.addEventListener('change', () => {
  settings = { ...settings, shakeDetectionEnabled: shakeDetectionToggle.checked };
  applySettings();
}, { signal: lifecycle.signal });

autoFocusToggle.addEventListener('change', () => {
  settings = { ...settings, autoFocusEnabled: autoFocusToggle.checked };
  applySettings();
}, { signal: lifecycle.signal });

list.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const row = target.closest<HTMLButtonElement>('[data-earthquake-id]');
  const id = row?.dataset.earthquakeId;
  if (!id || !store.recent.some((quake) => quake.id === id)) return;
  selectedEarthquakeId = id;
  renderMarkers(store.recent);
  renderList(store.recent);
}, { signal: lifecycle.signal });

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

async function loadHistory(reason: 'startup' | 'retry' | 'reconnect'): Promise<void> {
  if (disposed) return;
  if (historyRequestInFlight) {
    if (reason === 'reconnect') queuedHistorySync = true;
    return;
  }

  historyRequestInFlight = true;
  const controller = new AbortController();
  historyController = controller;
  let currentReason = reason;
  try {
    do {
      queuedHistorySync = false;
      currentReason = reason === 'startup' ? 'startup' : reason;
      try {
        const earthquakes = await fetchRecentEarthquakes(controller.signal);
        if (disposed) return;
        if (store.merge(earthquakes) || !hasLoaded) renderAll();
        hasLoaded = true;
        document.querySelector('#refresh-error')?.remove();
        updateTimestamp(currentReason === 'reconnect' ? '再接続後に同期' : '最終更新');
      } catch (error) {
        if (disposed || (error instanceof DOMException && error.name === 'AbortError')) return;
        const message = error instanceof Error ? error.message : '通信に失敗しました';
        if (!hasLoaded) {
          latestLoading.hidden = false;
          latestLoading.innerHTML = `<div class="error-state"><strong>情報を取得できませんでした</strong><span>${escapeHtml(message)}</span><button id="retry-button" class="retry-button" type="button">再試行</button></div>`;
          mapStatus.textContent = '地震情報を取得できませんでした';
          list.innerHTML = '<div class="empty-state">通信が回復すると地震情報を表示します</div>';
          document.querySelector<HTMLButtonElement>('#retry-button')?.addEventListener('click', () => void loadHistory('retry'), { once: true, signal: lifecycle.signal });
        } else {
          updatedAt.textContent = currentReason === 'reconnect' ? '切断中の履歴を取得できませんでした' : '履歴取得に失敗しました';
          let notice = document.querySelector<HTMLDivElement>('#refresh-error');
          if (!notice) {
            notice = document.createElement('div');
            notice.id = 'refresh-error';
            notice.className = 'refresh-error';
            latestCard.before(notice);
          }
          notice.textContent = `地震情報を取得できませんでした: ${message}`;
        }
      }
    } while (queuedHistorySync && !disposed);
  } finally {
    historyRequestInFlight = false;
    historyController = undefined;
  }
}

function scheduleReconnect(): void {
  if (disposed || reconnectTimer !== undefined) return;
  setConnectionState(connectionEstablished ? 'reconnecting' : 'offline');
  const delay = Math.min(1_000 * 2 ** reconnectAttempt, 30_000);
  reconnectAttempt += 1;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = undefined;
    connectWebSocket();
  }, delay);
}

function connectWebSocket(): void {
  if (disposed || (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN))) return;
  setConnectionState(connectionEstablished ? 'reconnecting' : 'offline');
  let connection: WebSocket;
  try {
    connection = new WebSocket('wss://api.p2pquake.net/v2/ws');
  } catch {
    scheduleReconnect();
    return;
  }
  socket = connection;

  connection.onopen = () => {
    if (disposed || socket !== connection) return;
    const shouldSyncHistory = connectionEstablished || reconnectAttempt > 0;
    connectionEstablished = true;
    reconnectAttempt = 0;
    setConnectionState('live');
    if (shouldSyncHistory) void loadHistory('reconnect');
  };

  connection.onmessage = (event: MessageEvent) => {
    if (disposed || socket !== connection || typeof event.data !== 'string') return;
    let payload: unknown;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }

    const parsedShakeDetection = parseShakeDetection(payload);
    if (parsedShakeDetection) {
      updateShakeDetection(parsedShakeDetection);
      return;
    }

    // 561 is an individual user sensing message. It is parsed for protocol
    // compatibility, but never becomes a detection trigger by itself.
    if (parseUserquake(payload)) return;

    const earthquake = parseEarthquake(payload);
    if (!earthquake || !store.merge([earthquake])) return;
    renderAll(true);
    updateTimestamp('最終受信');
  };

  connection.onerror = () => {
    if (socket === connection) connection.close();
  };

  connection.onclose = () => {
    if (socket !== connection) return;
    socket = null;
    if (disposed) {
      setConnectionState('offline');
      return;
    }
    scheduleReconnect();
  };
}

window.addEventListener('pagehide', () => {
  disposed = true;
  lifecycle.abort();
  historyController?.abort();
  if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  if (shakeDetectionTimer !== undefined) window.clearTimeout(shakeDetectionTimer);
  shakeDetectionTimer = undefined;
  if (socket) {
    const oldSocket = socket;
    socket = null;
    oldSocket.onopen = null;
    oldSocket.onmessage = null;
    oldSocket.onerror = null;
    oldSocket.onclose = null;
    oldSocket.close();
  }
  setConnectionState('offline');
}, { once: true, signal: lifecycle.signal });

void loadHistory('startup').finally(() => {
  if (!disposed) connectWebSocket();
});
