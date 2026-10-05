import './style.css';
import { fetchRecentEarthquakes } from './api';
import { projectEpicenter } from './mapProjection';
import type { Earthquake } from './types';

const japanMapUrl = new URL('./assets/japan-map.svg', import.meta.url).href;

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('アプリの表示領域が見つかりません');

app.innerHTML = `
  <div class="shell">
    <header class="topbar">
      <a class="brand" href="/" aria-label="Lightweight Earthquake Monitor ホーム">
        <span class="brand-mark" aria-hidden="true">＋</span>
        <span><strong>Lightweight Earthquake Monitor</strong><small>JAPAN SEISMIC ACTIVITY</small></span>
      </a>
      <div class="live"><span class="live-dot"></span>LIVE</div>
    </header>
    <main>
      <section class="latest-section" aria-labelledby="latest-heading">
        <div class="section-heading"><div><p class="eyebrow">LATEST UPDATE</p><h1 id="latest-heading">最新の地震</h1></div><span id="updated-at" class="updated-at">取得準備中</span></div>
        <div class="latest-dashboard">
          <section class="map-card" aria-labelledby="map-heading">
            <div class="map-card-heading"><div><p class="eyebrow">EPICENTER MAP</p><h2 id="map-heading">日本周辺</h2></div><span class="map-key"><i></i>最新の震源</span></div>
            <svg id="japan-map" class="japan-map" viewBox="0 0 440 500" role="img" aria-label="日本列島と最新の震源位置">
              <image href="${japanMapUrl}" width="440" height="500" />
              <g id="epicenter-marker" class="epicenter-marker" visibility="hidden" aria-hidden="true">
                <circle class="marker-halo" r="12" />
                <circle class="marker-core" r="5" />
                <path class="marker-star" d="M0-3.2 1-1 3.2 0 1 1 0 3.2-1 1-3.2 0-1-1Z" />
              </g>
            </svg>
            <p id="map-status" class="map-status">地震情報を取得しています</p>
          </section>
          <section id="latest-card" class="latest-card" aria-label="最新の地震情報" aria-live="polite">
            <div id="latest-loading" class="loading"><span class="spinner"></span>地震情報を取得しています</div>
            <article id="latest-details" class="latest-details" hidden>
              <div class="latest-main"><span class="latest-label">最大震度</span><strong id="latest-scale" class="scale">—</strong><span class="intensity-unit">震度</span></div>
              <div class="latest-place"><span class="latest-label">震源地</span><strong id="latest-place-name">—</strong><span id="latest-date" class="latest-date">—</span></div>
              <div class="latest-stats"><div><span>MAGNITUDE</span><strong id="latest-magnitude">—</strong></div><div><span>DEPTH</span><strong id="latest-depth">—</strong></div></div>
            </article>
          </section>
        </div>
      </section>
      <section class="recent-section" aria-labelledby="recent-heading">
        <div class="section-heading"><div><p class="eyebrow">RECENT ACTIVITY</p><h2 id="recent-heading">最近の地震</h2></div><span id="event-count" class="event-count">—</span></div>
        <div id="earthquake-list" class="earthquake-list"><div class="list-loading">情報を読み込んでいます</div></div>
      </section>
    </main>
    <footer><span>Source: P2P地震情報 JSON API v2</span><span>自動更新は30秒間隔</span></footer>
  </div>`;

const latestCard = document.querySelector<HTMLDivElement>('#latest-card')!;
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
const epicenterMarker = document.querySelector<SVGGElement>('#epicenter-marker')!;
const mapStatus = document.querySelector<HTMLParagraphElement>('#map-status')!;
let hasLoaded = false;
let inFlight = false;
let disposed = false;
let controller: AbortController | undefined;

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

function render(earthquakes: Earthquake[]): void {
  const latest = earthquakes[0];
  if (!latest) {
    latestDetails.hidden = true;
    latestLoading.hidden = false;
    latestLoading.innerHTML = '<div class="empty-state">表示できる地震情報はありません</div>';
    epicenterMarker.setAttribute('visibility', 'hidden');
    mapStatus.textContent = '表示できる地震情報はありません';
    list.innerHTML = '<div class="empty-state">最近の地震情報はありません</div>';
    eventCount.textContent = '0件';
    return;
  }

  latestLoading.hidden = true;
  latestDetails.hidden = false;
  latestScale.textContent = scaleLabel(latest.maxScale);
  latestPlace.textContent = latest.hypocenter;
  latestDate.textContent = formatTime(latest.time);
  latestMagnitude.textContent = `M ${latest.magnitude?.toFixed(1) ?? '—'}`;
  latestDepth.textContent = latest.depth === null ? '—' : latest.depth === 0 ? 'ごく浅い' : `${latest.depth} km`;

  const mapPoint = projectEpicenter(latest);
  if (mapPoint) {
    epicenterMarker.setAttribute('transform', `translate(${mapPoint.x} ${mapPoint.y})`);
    epicenterMarker.setAttribute('visibility', 'visible');
    mapStatus.textContent = `${latest.hypocenter} の震源位置`;
    japanMap.setAttribute('aria-label', `日本地図。${latest.hypocenter}の震源位置を表示`);
  } else {
    epicenterMarker.setAttribute('visibility', 'hidden');
    const hasCoordinates = latest.latitude !== null && latest.longitude !== null;
    mapStatus.textContent = hasCoordinates ? '震源は地図の表示範囲外です' : '震源座標を取得できません';
    japanMap.setAttribute('aria-label', '日本地図。最新の震源位置は表示していません');
  }

  list.innerHTML = earthquakes.map((quake, index) => `
    <article class="quake-row ${index === 0 ? 'is-latest' : ''}">
      <time datetime="${escapeHtml(quake.time)}">${formatTime(quake.time)}</time>
      <strong class="quake-place">${escapeHtml(quake.hypocenter)}</strong>
      <span class="row-scale">震度 <b>${scaleLabel(quake.maxScale)}</b></span>
      <span class="row-magnitude">M ${quake.magnitude?.toFixed(1) ?? '—'}</span>
      <span class="row-depth">${quake.depth === null ? '—' : quake.depth === 0 ? 'ごく浅い' : `${quake.depth} km`}</span>
    </article>`).join('');
  eventCount.textContent = `${earthquakes.length}件`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

async function refresh(): Promise<void> {
  if (inFlight || disposed) return;
  inFlight = true;
  controller = new AbortController();
  try {
    const earthquakes = await fetchRecentEarthquakes(controller.signal);
    if (disposed) return;
    render(earthquakes);
    hasLoaded = true;
    document.querySelector('#refresh-error')?.remove();
    updatedAt.textContent = `最終更新 ${new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date())}`;
  } catch (error) {
    if (disposed || (error instanceof DOMException && error.name === 'AbortError')) return;
    const message = error instanceof Error ? error.message : '通信に失敗しました';
    if (!hasLoaded) {
      latestLoading.innerHTML = `<div class="error-state"><strong>情報を取得できませんでした</strong><span>${escapeHtml(message)}</span><button id="retry-button" type="button">再試行</button></div>`;
      mapStatus.textContent = '地震情報を取得できませんでした';
      list.innerHTML = '<div class="empty-state">通信が回復すると地震情報を表示します</div>';
      document.querySelector<HTMLButtonElement>('#retry-button')?.addEventListener('click', () => void refresh(), { once: true });
    } else {
      updatedAt.textContent = '更新失敗 · 次回再試行します';
      let notice = document.querySelector<HTMLDivElement>('#refresh-error');
      if (!notice) {
        notice = document.createElement('div');
        notice.id = 'refresh-error';
        notice.className = 'refresh-error';
        latestCard.before(notice);
      }
      notice.textContent = `最新情報を更新できませんでした: ${message}`;
    }
  } finally {
    inFlight = false;
    controller = undefined;
  }
}

void refresh();
const refreshTimer = window.setInterval(() => void refresh(), 30_000);
window.addEventListener('pagehide', () => {
  disposed = true;
  controller?.abort();
  window.clearInterval(refreshTimer);
}, { once: true });
