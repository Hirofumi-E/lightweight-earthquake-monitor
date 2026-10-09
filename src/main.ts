import './style.css';
import { fetchRecentEarthquakes, fetchReplayHistory, parseAreaPeers, parseEarthquake, parseEew, parseEewDetection, parseShakeDetection, parseUserquake } from './api';
import { AudioNotifier, type AudioCue, type AudioNotifyResult } from './audioNotifier';
import { EarthquakeStore, type EarthquakeMergeResult } from './earthquakeStore';
import { COMPACT_MAP_VIEWBOX, MAP_VIEWBOX, projectCoordinates, projectEpicenter } from './mapProjection';
import areasData from './epspAreas.json';
import { buildReplayFrames, countReplayRecords, hasVisualReplay, isReplayEligible, type ReplayCounts, type ReplayFrame } from './replay';
import { calculateLatency, formatAge, formatClock, formatLatency, parseP2pTimestamp, type LatencyValue } from './timeUtils';
import type { Earthquake, EewArea, EewMessage, EpspArea, ShakeDetection } from './types';

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
const MEDIUM_CONFIDENCE_THRESHOLD = 0.6;
const RAW_SENSING_TTL_MS = 15_000;
const MAX_RAW_SENSING_AREAS = 32;
const MAX_RAW_SENSING_IDS = 256;
const EEW_TIMEOUT_MS = 120_000;
const EEW_CANCEL_DISPLAY_MS = 5_000;
const MAX_EEW_EVENTS = 4;
const HISTORY_SYNC_INTERVAL_MS = 15_000;
const MAX_MAP_ZOOM = 8;
const MAP_ZOOM_FACTOR = 1.35;
const EEW_SCALE_CODES = new Set([0, 10, 20, 30, 40, 45, 50, 55, 60, 70, 99]);
const queryParameters = new URLSearchParams(window.location.search);
const isTestMode = queryParameters.get('testMode') === '1';
const isEewSandbox = !isTestMode && queryParameters.get('eewSandbox') === '1';
const isLiveDebugMode = !isTestMode && !isEewSandbox && queryParameters.get('debugLive') === '1';
const websocketUrl = isEewSandbox ? 'wss://api-realtime-sandbox.p2pquake.net/v2/ws' : 'wss://api.p2pquake.net/v2/ws';

const PREFECTURE_NAMES = [
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県',
  '埼玉県', '千葉県', '東京都', '神奈川県', '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県',
  '岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県',
  '鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県',
  '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
] as const;
const PREFECTURE_CODE_BY_NAME = new Map<string, string>(PREFECTURE_NAMES.map((name, index) => [name, String(index + 1).padStart(2, '0')]));

interface MonitorSettings {
  shakeDetectionEnabled: boolean;
  autoFocusEnabled: boolean;
  eewEnabled: boolean;
  eewAutoFocusEnabled: boolean;
  realtimeIntensityEnabled: false;
  audioNotificationsEnabled: boolean;
  eewAudioEnabled: boolean;
  shakeAudioEnabled: boolean;
  earthquakeAudioEnabled: boolean;
  audioVolume: number;
}

const DEFAULT_SETTINGS: MonitorSettings = {
  shakeDetectionEnabled: true,
  autoFocusEnabled: true,
  eewEnabled: true,
  eewAutoFocusEnabled: true,
  realtimeIntensityEnabled: false,
  audioNotificationsEnabled: false,
  eewAudioEnabled: true,
  shakeAudioEnabled: true,
  earthquakeAudioEnabled: true,
  audioVolume: 50,
};

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('アプリの表示領域が見つかりません');

app.innerHTML = `
  <div class="shell${isTestMode ? ' is-test-mode' : ''}">
    <header class="topbar">
      <h1 class="brand">Lightweight Earthquake Monitor</h1>
      ${isTestMode ? '<div class="test-mode-banner" role="status"><strong>TEST MODE</strong><span>疑似データによる動作確認</span><button id="test-panel-toggle" class="test-panel-toggle" type="button" aria-expanded="false" aria-controls="test-panel">TEST PANEL</button></div>' : ''}
      ${isEewSandbox ? '<div id="sandbox-banner" class="sandbox-banner" role="status"><strong>SANDBOX</strong><span>過去の情報を再生中</span></div>' : ''}
      <div class="header-actions">
        <div id="shake-status" class="shake-status" role="status" aria-live="polite" hidden>
          <span class="shake-status-label">揺れを検出しています</span>
          <span id="shake-status-detail" class="shake-status-detail"></span>
          <small>P2P感知解析結果</small>
        </div>
        <section id="monitor-status" class="monitor-status" aria-label="受信監視">
          <span class="monitor-item monitor-last-receive"><b>最終受信</b><i id="monitor-last-receive">待機中</i></span>
          <span class="monitor-item monitor-eew"><b>EEW</b><i id="monitor-latest-eew">待機中</i></span>
          <span class="monitor-item monitor-shake"><b>揺れ検知</b><i id="monitor-shake">待機中</i></span>
          <span class="monitor-item monitor-history"><b>履歴同期</b><i id="monitor-history-sync">待機中</i></span>
          <time class="monitor-clock" id="monitor-current-time" aria-label="現在時刻">—</time>
          <span class="monitor-hidden-field"><i id="monitor-connection">OFFLINE</i><i id="monitor-latest-quake">待機中</i></span>
        </section>
        <button id="settings-toggle" class="settings-toggle" type="button" aria-expanded="false" aria-controls="settings-panel" title="動作設定">⚙ 設定</button>
        <div id="connection-status" class="live is-offline" role="status" aria-live="polite" title="WebSocket未接続"><span class="live-dot"></span><span id="connection-label">OFFLINE</span><small id="connection-description" class="live-description">WebSocket未接続</small></div>
      </div>
      <section id="settings-panel" class="settings-panel" aria-label="動作設定" hidden>
      <div class="settings-heading"><h2>動作設定</h2><span>保存済み</span></div>
      <label class="settings-row">
        <span><strong>リアルタイム揺れ検知</strong><small>P2P感知情報 561 + 9611解析結果をリアルタイム表示</small></span>
        <input id="shake-detection-toggle" class="settings-checkbox" type="checkbox" checked />
      </label>
      <label class="settings-row">
        <span><strong>揺れ検出時に対象地域へ自動フォーカス</strong><small>信頼度Aの地域へ一時移動</small></span>
        <input id="auto-focus-toggle" class="settings-checkbox" type="checkbox" checked />
      </label>
      <label class="settings-row">
        <span><strong>EEW表示</strong><small>556 緊急地震速報を表示</small></span>
        <input id="eew-toggle" class="settings-checkbox" type="checkbox" checked />
      </label>
      <label class="settings-row">
        <span><strong>EEW受信時に震源へ自動フォーカス</strong><small>新しいeventIdで一度だけ移動</small></span>
        <input id="eew-auto-focus-toggle" class="settings-checkbox" type="checkbox" checked />
      </label>
      <div class="settings-divider">音声通知</div>
      <label class="settings-row">
        <span><strong>音声通知</strong><small>ブラウザ生成の短い通知音</small></span>
        <input id="audio-notifications-toggle" class="settings-checkbox" type="checkbox" />
      </label>
      <label class="settings-row">
        <span><strong>EEW通知音</strong><small>新しいeventIdのみ</small></span>
        <input id="eew-audio-toggle" class="settings-checkbox" type="checkbox" checked />
      </label>
      <label class="settings-row">
        <span><strong>揺れ検出通知音</strong><small>非検出から検出へ変化した時</small></span>
        <input id="shake-audio-toggle" class="settings-checkbox" type="checkbox" checked />
      </label>
      <label class="settings-row">
        <span><strong>地震情報通知音</strong><small>新着WebSocket情報のみ</small></span>
        <input id="earthquake-audio-toggle" class="settings-checkbox" type="checkbox" checked />
      </label>
      <div class="settings-row settings-volume-row">
        <span><strong>音量</strong><small><span id="audio-volume-label">50%</span></small></span>
        <input id="audio-volume" class="audio-volume" type="range" min="0" max="100" step="1" value="50" aria-label="音量" />
      </div>
      <div class="audio-status-row">
        <span id="audio-status" role="status" aria-live="polite">音声：OFF</span>
        <button id="audio-enable" class="audio-enable-button" type="button" hidden>音声を有効化</button>
      </div>
      <div class="audio-test-row">
        <span>テスト再生</span>
        <div class="audio-test-buttons">
          <button id="audio-test-earthquake" type="button">地震情報</button>
          <button id="audio-test-shake" type="button">揺れ検出</button>
          <button id="audio-test-eew" type="button">EEW</button>
        </div>
      </div>
      <p class="settings-note">561はユーザーの感知速報、9611はその解析結果です。いずれも地震計による震度観測や地震発生の確定を示すものではありません。</p>
      </section>
    </header>
    <main class="workspace">
      ${isLiveDebugMode ? `<details id="live-diagnostics" class="live-diagnostics" open>
        <summary>LIVE診断</summary>
        <div class="live-diagnostics-grid">
          <span>接続</span><strong id="diag-connection">接続開始前</strong>
          <span>最終接続成功</span><b id="diag-connected-at">—</b>
          <span>最終メッセージ</span><b id="diag-message-at">—</b>
          <span>切断 / 再接続</span><b id="diag-reconnects">0 / 0</b>
          <span>受信 / JSON失敗</span><b id="diag-message-counts">0 / 0</b>
          <span>コード別 (551/554/555/556/561/9611/他)</span><b id="diag-code-counts">0 / 0 / 0 / 0 / 0 / 0 / 0</b>
          <span>解析成功 (551/554/555/556/561/9611)</span><b id="diag-parsed-counts">0 / 0 / 0 / 0 / 0 / 0</b>
          <span>UI反映 (551/554/555/556/561/9611)</span><b id="diag-rendered-counts">0 / 0 / 0 / 0 / 0 / 0</b>
          <span>HTTP同期 成功 / 失敗</span><b id="diag-http-counts">0 / 0</b>
          <span>最終HTTP同期</span><b id="diag-http-at">—</b>
        </div>
        <div class="live-diagnostics-log-heading">処理結果・遅延（個別データ本文は記録しません）</div>
        <ol id="diag-event-log" class="live-diagnostics-log"><li>WebSocket接続を待っています</li></ol>
      </details>` : ''}
      <button id="information-panel-toggle" class="information-panel-toggle" type="button" aria-expanded="true" aria-controls="information-panel" aria-label="地震情報パネルを閉じる" title="地震情報パネルを閉じる">&gt;</button>
      <div id="compact-priority-alert" class="compact-priority-alert" role="status" aria-live="assertive" hidden></div>
      <aside class="information-panel" aria-label="最新地震情報と地震履歴">
        <section id="latest-card" class="latest-panel" aria-label="最新地震情報と緊急地震速報" aria-live="polite">
          <div class="panel-section-heading"><h2 id="latest-heading">最新の地震</h2><span class="latest-indicator"><i></i><span id="latest-indicator-label">最新</span></span></div>
          <div id="latest-loading" class="loading"><span class="spinner"></span>地震情報を取得しています</div>
          <article id="latest-details" class="latest-details" hidden>
            <div class="latest-intensity-label">最大震度</div>
            <strong id="latest-scale" class="scale-badge">—</strong>
            <strong id="latest-place-name" class="latest-place">—</strong>
            <time id="latest-date" class="latest-time">—</time>
            <div class="latest-measures"><span id="latest-magnitude">M —</span><span id="latest-depth">深さ —</span></div>
          </article>
          <div id="latest-receive-metrics" class="receive-metrics" hidden>
            <span>受信 <strong id="latest-received-at">—</strong> <em id="latest-received-age">待機中</em></span>
            <span>P2P→Browser <strong id="latest-p2p-latency">—</strong></span>
            <span>発表→Browser <strong id="latest-source-latency">—</strong></span>
          </div>
          <article id="eew-details" class="eew-details" hidden>
            <div class="eew-heading-row"><strong>緊急地震速報</strong><span id="eew-test-badge" class="eew-test-badge" hidden>TEST / 訓練・試験情報</span></div>
            <strong id="eew-report" class="eew-report">第—報</strong>
            <div class="eew-place-label">震源</div>
            <strong id="eew-place-name" class="eew-place">—</strong>
            <time id="eew-origin-time" class="eew-time">—</time>
            <div class="eew-measures"><span id="eew-magnitude">M —</span><span id="eew-depth">深さ —</span></div>
            <div class="eew-forecast"><span>最大予測震度</span><strong id="eew-scale">—</strong></div>
            <div id="eew-arrival-state" class="eew-arrival-state" hidden></div>
            <div id="eew-forecast-areas" class="eew-forecast-areas" hidden></div>
            <div id="eew-receive-metrics" class="receive-metrics" hidden>
              <span>受信 <strong id="eew-received-at">—</strong> <em id="eew-received-age">待機中</em></span>
              <span>P2P→Browser <strong id="eew-p2p-latency">—</strong></span>
              <span>発表→Browser <strong id="eew-source-latency">—</strong></span>
            </div>
            <small class="eew-disclaimer">P2P地震情報経由・参考情報</small>
          </article>
          <article id="eew-cancelled" class="eew-cancelled" hidden>
            <strong>緊急地震速報は取り消されました</strong>
            <small>P2P地震情報経由・参考情報</small>
          </article>
          <div class="panel-update"><span>現在時刻</span><time id="current-time">—</time></div>
        </section>
        <section id="selected-quake-actions" class="selected-quake-actions" aria-label="選択した地震の操作" hidden>
          <div class="selected-quake-heading"><strong id="selected-quake-label">選択した地震</strong><a href="https://typhoon.yahoo.co.jp/weather/jp/earthquake/list/" target="_blank" rel="noopener noreferrer">Yahoo!の地震履歴を見る ↗</a></div>
          <button id="selected-replay-start" type="button" class="replay-start-button">過去データを再生</button>
          <p id="replay-message" class="replay-message" role="status" aria-live="polite" hidden></p>
          <div id="replay-controls" class="replay-controls" hidden>
            <div class="replay-controls-row"><span id="replay-badge" class="replay-badge">REPLAY</span><button id="replay-restart" type="button">最初から</button><button id="replay-previous" type="button" aria-label="前の記録">前へ</button><button id="replay-play-toggle" type="button">一時停止</button><button id="replay-next" type="button" aria-label="次の記録">次へ</button><button id="replay-speed-toggle" type="button">標準</button><button id="replay-live-return" type="button">LIVEに戻る</button></div>
            <div class="replay-target-row"><b id="replay-target-scale" class="replay-target-scale">—</b><strong id="replay-target-label" class="replay-target-label"></strong></div>
            <div class="replay-time-row"><time id="replay-time">—</time><span id="replay-elapsed">経過 — / —</span></div>
            <div class="replay-time-row"><span id="replay-record-kind">記録</span><span id="replay-position">—</span></div>
            <small id="replay-timeline-meta"></small>
            <small id="replay-signal-status"></small>
            <progress id="replay-progress" class="replay-progress" max="1" value="0" aria-label="再生の進行状況"></progress>
            <span id="replay-record-detail" class="replay-record-detail"></span>
            <small id="replay-record-counts"></small>
            <small>取得できた記録による再構成です。配信当時の完全再現ではありません。</small>
          </div>
        </section>
        <section class="history-panel" aria-labelledby="history-heading">
          <div class="panel-section-heading"><div><h2 id="history-heading">地震履歴</h2><p>最近の情報 最大10件</p></div><span id="event-count" class="event-count">—</span></div>
          <div id="earthquake-list" class="earthquake-list"><div class="list-loading">情報を読み込んでいます</div></div>
        </section>
      </aside>
      <section class="map-panel" aria-label="日本地図と震源">
        <svg id="japan-map" class="japan-map" viewBox="0 0 800 800" role="img" aria-label="日本の都道府県地図と最近の震源位置">
          <image href="${japanMapUrl}" width="800" height="800" />
          <g id="eew-prefecture-overlays" class="eew-prefecture-overlays" aria-label="EEW予測震度" />
          <g id="earthquake-markers" class="earthquake-markers" aria-label="最近の震源">
            <g id="raw-shake-markers" aria-label="P2P感知速報地域" />
            <g id="shake-detection-markers" class="shake-detection-markers" aria-label="揺れ検出地域" />
            <g id="selected-earthquake-marker" aria-label="選択した地震の震源" />
          </g>
          <g id="eew-marker" class="eew-marker" aria-label="EEW震源" />
          <g id="replay-map-layer" class="replay-map-layer" aria-label="過去データのリプレイ" />
        </svg>
        <div id="replay-map-banner" class="replay-map-banner" role="status" aria-live="polite" hidden><strong>REPLAY</strong><span id="replay-map-detail">過去データの再構成</span><span id="replay-map-target">—</span></div>
        <div class="map-controls" aria-label="地図操作">
          <button id="map-zoom-in" type="button" aria-label="地図を拡大" title="拡大">＋</button>
          <button id="map-zoom-out" type="button" aria-label="地図を縮小" title="縮小">−</button>
          <button id="map-reset" type="button" aria-label="日本全国を表示" title="全国">全国</button>
        </div>
        <p class="map-attribution">地図：気象庁「地震情報／都道府県等」のデータを加工して作成</p>
        ${isTestMode ? `
        <section id="test-panel" class="test-panel" aria-label="TEST PANEL" hidden>
          <div class="test-panel-heading">
            <div><strong>TEST PANEL</strong><small>固定fixtureによる疑似データ</small></div>
            <button id="test-panel-close" class="test-panel-close" type="button">閉じる</button>
          </div>
          <div class="test-controls">
            <div class="test-control-group" aria-label="地震情報テスト">
              <span class="test-control-label">地震情報</span>
              <button type="button" data-test-action="quake">通常地震を発生</button>
              <button type="button" data-test-action="history-backfill">履歴補完をシミュレート</button>
              <button type="button" data-test-action="intensity-palette">震度1〜7・不明の色を表示（状態リセット）</button>
            </div>
            <div class="test-control-group" aria-label="551同一イベント統合テスト">
              <span class="test-control-label">551同一地震</span>
              <button type="button" data-test-action="event-scale-prompt">震度速報</button>
              <button type="button" data-test-action="event-destination">震源情報</button>
              <button type="button" data-test-action="event-detail-scale">詳細情報</button>
              <button type="button" data-test-action="event-corrected-scale">震度訂正</button>
              <button type="button" data-test-action="event-old-report">古い続報</button>
              <button type="button" data-test-action="event-duplicate">同一ID再送</button>
              <button type="button" data-test-action="event-separate">別地震</button>
              <button type="button" data-test-action="event-same-time-distant">同時刻・別震源</button>
            </div>
            <div class="test-control-group" aria-label="揺れ検出テスト">
              <span class="test-control-label">揺れ検出</span>
              <button type="button" data-test-action="shake-start">揺れ検出を開始</button>
              <button type="button" data-test-action="shake-update">揺れ検出を更新</button>
              <button type="button" data-test-action="shake-end">揺れ検出を終了</button>
            </div>
            <div class="test-control-group" aria-label="561 感知速報テスト">
              <span class="test-control-label">561 感知速報</span>
              <button type="button" data-test-action="561-tokyo">東京</button>
              <button type="button" data-test-action="561-kanagawa">神奈川</button>
              <button type="button" data-test-action="561-chiba">千葉</button>
            </div>
            <div class="test-control-group" aria-label="EEWテスト">
              <span class="test-control-label">EEW</span>
              <button type="button" data-test-action="eew-1">EEW 第1報</button>
              <button type="button" data-test-action="eew-2">EEW 第2報</button>
              <button type="button" data-test-action="eew-3">EEW 第3報</button>
              <button type="button" data-test-action="eew-old">古いEEW報を送信</button>
              <button type="button" data-test-action="eew-missing">EEW震源欠損</button>
              <button type="button" data-test-action="eew-cancel">EEW取消</button>
            </div>
            <div class="test-control-group" aria-label="接続状態テスト">
              <span class="test-control-label">接続状態</span>
              <button type="button" data-test-action="connection-live">LIVE</button>
              <button type="button" data-test-action="connection-reconnecting">RECONNECTING</button>
              <button type="button" data-test-action="connection-offline">OFFLINE</button>
            </div>
            <div class="test-control-group" aria-label="WebSocket統合テスト">
              <span class="test-control-label">受信経路テスト</span>
              <button type="button" data-test-action="mock-websocket-flow">WebSocket mock統合確認</button>
            </div>
            <div class="test-control-group" aria-label="簡易リプレイテスト">
              <span class="test-control-label">過去データ再生</span>
              <button type="button" data-test-action="replay-eew">選択地震 EEW fixture</button>
              <button type="button" data-test-action="replay-shake">選択地震 揺れ解析 fixture</button>
              <button type="button" data-test-action="replay-shake-silence">揺れ解析・非検出 fixture</button>
              <button type="button" data-test-action="replay-eew-cancel">EEW取消 fixture</button>
              <button type="button" data-test-action="replay-mixed">EEW＋揺れ解析 fixture</button>
              <button type="button" data-test-action="replay-late-quake">551遅い続報 fixture</button>
              <button type="button" data-test-action="replay-unrelated">異なるイベント混在 fixture</button>
              <button type="button" data-test-action="replay-no-termination">終了記録なし fixture</button>
              <button type="button" data-test-action="replay-no-data">データなし地震を選択</button>
              <button type="button" data-test-action="replay-live-priority">再生中にLIVE EEW</button>
            </div>
            <button type="button" class="test-reset-button" data-test-action="reset">全状態リセット</button>
          </div>
          <div class="test-log" aria-label="テストイベントログ">
            <div class="test-log-heading"><strong>イベントログ</strong><span id="test-log-count">0 / 50</span></div>
            <ol id="test-log-list"><li>fixtureを読み込んでいます</li></ol>
          </div>
        </section>` : ''}
      </section>
    </div>
  </div>`;

const latestCard = document.querySelector<HTMLElement>('#latest-card')!;
const list = document.querySelector<HTMLDivElement>('#earthquake-list')!;
const selectedQuakeActions = document.querySelector<HTMLElement>('#selected-quake-actions')!;
const selectedQuakeLabel = document.querySelector<HTMLElement>('#selected-quake-label')!;
const selectedReplayStart = document.querySelector<HTMLButtonElement>('#selected-replay-start')!;
const replayMessage = document.querySelector<HTMLElement>('#replay-message')!;
const replayControls = document.querySelector<HTMLElement>('#replay-controls')!;
const replayPlayToggle = document.querySelector<HTMLButtonElement>('#replay-play-toggle')!;
const replayRestart = document.querySelector<HTMLButtonElement>('#replay-restart')!;
const replayPrevious = document.querySelector<HTMLButtonElement>('#replay-previous')!;
const replayNext = document.querySelector<HTMLButtonElement>('#replay-next')!;
const replaySpeedToggle = document.querySelector<HTMLButtonElement>('#replay-speed-toggle')!;
const replayLiveReturn = document.querySelector<HTMLButtonElement>('#replay-live-return')!;
const replayBadge = document.querySelector<HTMLElement>('#replay-badge')!;
const replayTargetLabel = document.querySelector<HTMLElement>('#replay-target-label')!;
const replayTargetScale = document.querySelector<HTMLElement>('#replay-target-scale')!;
const replayTime = document.querySelector<HTMLTimeElement>('#replay-time')!;
const replayElapsed = document.querySelector<HTMLElement>('#replay-elapsed')!;
const replayRecordKind = document.querySelector<HTMLElement>('#replay-record-kind')!;
const replayPosition = document.querySelector<HTMLElement>('#replay-position')!;
const replayTimelineMeta = document.querySelector<HTMLElement>('#replay-timeline-meta')!;
const replaySignalStatus = document.querySelector<HTMLElement>('#replay-signal-status')!;
const replayProgress = document.querySelector<HTMLProgressElement>('#replay-progress')!;
const replayRecordDetail = document.querySelector<HTMLElement>('#replay-record-detail')!;
const replayRecordCounts = document.querySelector<HTMLElement>('#replay-record-counts')!;
const replayMapLayer = document.querySelector<SVGGElement>('#replay-map-layer')!;
const replayMapBanner = document.querySelector<HTMLDivElement>('#replay-map-banner')!;
const replayMapDetail = document.querySelector<HTMLElement>('#replay-map-detail')!;
const replayMapTarget = document.querySelector<HTMLElement>('#replay-map-target')!;
const currentTime = document.querySelector<HTMLTimeElement>('#current-time')!;
const monitorCurrentTime = document.querySelector<HTMLElement>('#monitor-current-time')!;
const eventCount = document.querySelector<HTMLSpanElement>('#event-count')!;
const latestLoading = document.querySelector<HTMLDivElement>('#latest-loading')!;
const latestDetails = document.querySelector<HTMLElement>('#latest-details')!;
const latestHeading = document.querySelector<HTMLElement>('#latest-heading')!;
const latestIndicatorLabel = document.querySelector<HTMLElement>('#latest-indicator-label')!;
const latestScale = document.querySelector<HTMLElement>('#latest-scale')!;
const latestPlace = document.querySelector<HTMLElement>('#latest-place-name')!;
const latestDate = document.querySelector<HTMLElement>('#latest-date')!;
const latestMagnitude = document.querySelector<HTMLElement>('#latest-magnitude')!;
const latestDepth = document.querySelector<HTMLElement>('#latest-depth')!;
const latestReceiveMetrics = document.querySelector<HTMLElement>('#latest-receive-metrics')!;
const latestReceivedAt = document.querySelector<HTMLElement>('#latest-received-at')!;
const latestReceivedAge = document.querySelector<HTMLElement>('#latest-received-age')!;
const latestP2pLatency = document.querySelector<HTMLElement>('#latest-p2p-latency')!;
const latestSourceLatency = document.querySelector<HTMLElement>('#latest-source-latency')!;
const eewDetails = document.querySelector<HTMLElement>('#eew-details')!;
const eewTestBadge = document.querySelector<HTMLElement>('#eew-test-badge')!;
const eewReport = document.querySelector<HTMLElement>('#eew-report')!;
const eewPlaceName = document.querySelector<HTMLElement>('#eew-place-name')!;
const eewOriginTime = document.querySelector<HTMLElement>('#eew-origin-time')!;
const eewMagnitude = document.querySelector<HTMLElement>('#eew-magnitude')!;
const eewDepth = document.querySelector<HTMLElement>('#eew-depth')!;
const eewScale = document.querySelector<HTMLElement>('#eew-scale')!;
const eewArrivalState = document.querySelector<HTMLElement>('#eew-arrival-state')!;
const eewForecastAreas = document.querySelector<HTMLElement>('#eew-forecast-areas')!;
const eewReceiveMetrics = document.querySelector<HTMLElement>('#eew-receive-metrics')!;
const eewReceivedAt = document.querySelector<HTMLElement>('#eew-received-at')!;
const eewReceivedAge = document.querySelector<HTMLElement>('#eew-received-age')!;
const eewP2pLatency = document.querySelector<HTMLElement>('#eew-p2p-latency')!;
const eewSourceLatency = document.querySelector<HTMLElement>('#eew-source-latency')!;
const eewCancelled = document.querySelector<HTMLElement>('#eew-cancelled')!;
const japanMap = document.querySelector<SVGSVGElement>('#japan-map')!;
const eewPrefectureOverlays = document.querySelector<SVGGElement>('#eew-prefecture-overlays')!;
const shakeDetectionMarkers = document.querySelector<SVGGElement>('#shake-detection-markers')!;
const rawShakeMarkers = document.querySelector<SVGGElement>('#raw-shake-markers')!;
const selectedEarthquakeMarker = document.querySelector<SVGGElement>('#selected-earthquake-marker')!;
const eewMarker = document.querySelector<SVGGElement>('#eew-marker')!;
const mapZoomIn = document.querySelector<HTMLButtonElement>('#map-zoom-in')!;
const mapZoomOut = document.querySelector<HTMLButtonElement>('#map-zoom-out')!;
const mapReset = document.querySelector<HTMLButtonElement>('#map-reset')!;
const connectionStatus = document.querySelector<HTMLDivElement>('#connection-status')!;
const connectionLabel = document.querySelector<HTMLSpanElement>('#connection-label')!;
const connectionDescription = document.querySelector<HTMLElement>('#connection-description')!;
const shakeStatus = document.querySelector<HTMLDivElement>('#shake-status')!;
const shakeStatusDetail = document.querySelector<HTMLSpanElement>('#shake-status-detail')!;
const monitorConnection = document.querySelector<HTMLElement>('#monitor-connection')!;
const monitorLastReceive = document.querySelector<HTMLElement>('#monitor-last-receive')!;
const monitorLatestEew = document.querySelector<HTMLElement>('#monitor-latest-eew')!;
const monitorShake = document.querySelector<HTMLElement>('#monitor-shake')!;
const monitorLatestQuake = document.querySelector<HTMLElement>('#monitor-latest-quake')!;
const monitorHistorySync = document.querySelector<HTMLElement>('#monitor-history-sync')!;
const compactPriorityAlert = document.querySelector<HTMLDivElement>('#compact-priority-alert')!;
const informationPanelToggle = document.querySelector<HTMLButtonElement>('#information-panel-toggle')!;
const workspace = document.querySelector<HTMLElement>('.workspace')!;
const settingsToggle = document.querySelector<HTMLButtonElement>('#settings-toggle')!;
const settingsPanel = document.querySelector<HTMLElement>('#settings-panel')!;
const shakeDetectionToggle = document.querySelector<HTMLInputElement>('#shake-detection-toggle')!;
const autoFocusToggle = document.querySelector<HTMLInputElement>('#auto-focus-toggle')!;
const eewToggle = document.querySelector<HTMLInputElement>('#eew-toggle')!;
const eewAutoFocusToggle = document.querySelector<HTMLInputElement>('#eew-auto-focus-toggle')!;
const audioNotificationsToggle = document.querySelector<HTMLInputElement>('#audio-notifications-toggle')!;
const eewAudioToggle = document.querySelector<HTMLInputElement>('#eew-audio-toggle')!;
const shakeAudioToggle = document.querySelector<HTMLInputElement>('#shake-audio-toggle')!;
const earthquakeAudioToggle = document.querySelector<HTMLInputElement>('#earthquake-audio-toggle')!;
const audioVolume = document.querySelector<HTMLInputElement>('#audio-volume')!;
const audioVolumeLabel = document.querySelector<HTMLSpanElement>('#audio-volume-label')!;
const audioStatus = document.querySelector<HTMLSpanElement>('#audio-status')!;
const audioEnableButton = document.querySelector<HTMLButtonElement>('#audio-enable')!;
const audioTestEarthquake = document.querySelector<HTMLButtonElement>('#audio-test-earthquake')!;
const audioTestShake = document.querySelector<HTMLButtonElement>('#audio-test-shake')!;
const audioTestEew = document.querySelector<HTMLButtonElement>('#audio-test-eew')!;
const testPanel = document.querySelector<HTMLElement>('#test-panel');
const testPanelToggle = document.querySelector<HTMLButtonElement>('#test-panel-toggle');
const testPanelClose = document.querySelector<HTMLButtonElement>('#test-panel-close');
const testLogList = document.querySelector<HTMLOListElement>('#test-log-list');
const testLogCount = document.querySelector<HTMLSpanElement>('#test-log-count');
const diagnosticsConnection = document.querySelector<HTMLElement>('#diag-connection');
const diagnosticsConnectedAt = document.querySelector<HTMLElement>('#diag-connected-at');
const diagnosticsMessageAt = document.querySelector<HTMLElement>('#diag-message-at');
const diagnosticsReconnects = document.querySelector<HTMLElement>('#diag-reconnects');
const diagnosticsMessageCounts = document.querySelector<HTMLElement>('#diag-message-counts');
const diagnosticsCodeCounts = document.querySelector<HTMLElement>('#diag-code-counts');
const diagnosticsParsedCounts = document.querySelector<HTMLElement>('#diag-parsed-counts');
const diagnosticsRenderedCounts = document.querySelector<HTMLElement>('#diag-rendered-counts');
const diagnosticsHttpCounts = document.querySelector<HTMLElement>('#diag-http-counts');
const diagnosticsHttpAt = document.querySelector<HTMLElement>('#diag-http-at');
const diagnosticsEventLog = document.querySelector<HTMLOListElement>('#diag-event-log');
const store = new EarthquakeStore();
let hasLoaded = false;
let disposed = false;
let historyRequestInFlight = false;
let queuedHistorySync = false;
let historyController: AbortController | undefined;
let historySyncTimer: number | undefined;
let socket: WebSocket | null = null;
let reconnectTimer: number | undefined;
let reconnectAttempt = 0;
let connectionEstablished = false;
let connectionAttempted = false;
let selectedEarthquakeId: string | null = null;
interface ReplayState {
  target: Earthquake;
  frames: readonly ReplayFrame[];
  counts: ReplayCounts;
  visual: boolean;
  index: number;
  playing: boolean;
  speed: 1 | 4;
  elapsedMs: number;
  startAt: number;
  originAt: number | null;
  durationMs: number;
  lastTickAt: number | null;
  activeQuake: Extract<ReplayFrame, { kind: 'quake' }> | null;
  activeEew: Extract<ReplayFrame, { kind: 'eew' }> | null;
  activeShake: Extract<ReplayFrame, { kind: 'shake' }> | null;
  eewSeen: boolean;
  shakeSeen: boolean;
  eewCancelled: boolean;
  shakeNotDetected: boolean;
  historyMayBeTruncated: boolean;
}
let replayState: ReplayState | null = null;
let replayTimer: number | undefined;
let replayTimeoutTimer: number | undefined;
let replayController: AbortController | undefined;
let settings = readSettings();
const audioNotifier = new AudioNotifier(isEewSandbox);
let currentShakeDetection: ShakeDetection | null = null;
interface RawSensingAreaState { count: number; lastReceivedAt: number; }
const rawSensingAreas = new Map<string, RawSensingAreaState>();
const rawSensingIds = new Set<string>();
const rawSensingIdOrder: string[] = [];
interface ReceiveTiming {
  browserReceivedAt: number;
  basicTimestamp: string | null;
  sourceTimestamp: string | null;
  p2pToBrowser: LatencyValue;
  sourceToBrowser: LatencyValue;
}

const MAX_RECEIVE_TIMINGS = 256;
const earthquakeReceiveTimings = new Map<string, ReceiveTiming>();
const earthquakeReceiveTimingOrder: string[] = [];
let currentShakeReceiveTiming: ReceiveTiming | null = null;
let lastWebSocketReceivedAt: number | null = null;
let lastHistorySyncSucceededAt: number | null = null;
let receiveAgeTimer: number | undefined;
let shakeDetectionTimer: number | undefined;
let lastFocusedShakeEvent: string | null = null;
interface StoredEew extends EewMessage {
  receivedAt: number;
  receiveTiming: ReceiveTiming;
}

const eewByEventId = new Map<string, StoredEew>();
let activeEewEventId: string | null = null;
let activeEew: StoredEew | null = null;
let eewCancelledMessageVisible = false;
let eewTimer: number | undefined;
const lifecycle = new AbortController();
const DIAGNOSTIC_CODES = ['551', '554', '555', '556', '561', '9611'] as const;
const liveDiagnostics = {
  lastConnectedAt: null as number | null,
  lastMessageAt: null as number | null,
  lastHttpAt: null as number | null,
  disconnects: 0,
  reconnects: 0,
  messages: 0,
  jsonFailures: 0,
  httpSuccesses: 0,
  httpFailures: 0,
  codeCounts: new Map<string, number>([...DIAGNOSTIC_CODES.map((code) => [code, 0] as const), ['other', 0]]),
  parseSuccessCounts: new Map<string, number>(DIAGNOSTIC_CODES.map((code) => [code, 0] as const)),
  renderedCounts: new Map<string, number>(DIAGNOSTIC_CODES.map((code) => [code, 0] as const)),
  log: [] as string[],
};
interface MapViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

function diagnosticClock(timestamp: number | null): string {
  if (timestamp === null) return '—';
  return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(timestamp);
}

function addLiveDiagnostic(message: string): void {
  if (!isLiveDebugMode || !diagnosticsEventLog) return;
  const time = diagnosticClock(Date.now());
  liveDiagnostics.log.push(`${time} ${message}`);
  if (liveDiagnostics.log.length > 100) liveDiagnostics.log.splice(0, liveDiagnostics.log.length - 100);
  diagnosticsEventLog.replaceChildren(...liveDiagnostics.log.map((line) => {
    const item = document.createElement('li');
    item.textContent = line;
    return item;
  }));
}

function renderLiveDiagnostics(): void {
  if (!isLiveDebugMode || !diagnosticsConnection || !diagnosticsConnectedAt || !diagnosticsMessageAt || !diagnosticsReconnects || !diagnosticsMessageCounts || !diagnosticsCodeCounts || !diagnosticsParsedCounts || !diagnosticsRenderedCounts || !diagnosticsHttpCounts || !diagnosticsHttpAt) return;
  const socketState = socket?.readyState;
  const stateLabel = socketState === WebSocket.OPEN
    ? liveDiagnostics.messages === 0 ? 'LIVE・接続中・イベント受信待機' : 'LIVE・接続中'
    : socketState === WebSocket.CONNECTING ? connectionEstablished ? 'RECONNECTING（接続試行中）' : 'CONNECTING'
      : connectionEstablished && reconnectTimer !== undefined ? '再接続待ち'
        : 'OFFLINE';
  diagnosticsConnection.textContent = stateLabel;
  diagnosticsConnectedAt.textContent = diagnosticClock(liveDiagnostics.lastConnectedAt);
  diagnosticsMessageAt.textContent = liveDiagnostics.lastMessageAt === null ? '—' : `${diagnosticClock(liveDiagnostics.lastMessageAt)}（${formatAge(liveDiagnostics.lastMessageAt)}）`;
  diagnosticsReconnects.textContent = `${liveDiagnostics.disconnects} / ${liveDiagnostics.reconnects}`;
  diagnosticsMessageCounts.textContent = `${liveDiagnostics.messages} / ${liveDiagnostics.jsonFailures}`;
  diagnosticsCodeCounts.textContent = [...DIAGNOSTIC_CODES, 'other'].map((code) => String(liveDiagnostics.codeCounts.get(code) ?? 0)).join(' / ');
  diagnosticsParsedCounts.textContent = DIAGNOSTIC_CODES.map((code) => String(liveDiagnostics.parseSuccessCounts.get(code) ?? 0)).join(' / ');
  diagnosticsRenderedCounts.textContent = DIAGNOSTIC_CODES.map((code) => String(liveDiagnostics.renderedCounts.get(code) ?? 0)).join(' / ');
  diagnosticsHttpCounts.textContent = `${liveDiagnostics.httpSuccesses} / ${liveDiagnostics.httpFailures}`;
  diagnosticsHttpAt.textContent = diagnosticClock(liveDiagnostics.lastHttpAt);
}

function countLiveDiagnosticMessage(code: string | null): void {
  if (!isLiveDebugMode) return;
  liveDiagnostics.messages += 1;
  liveDiagnostics.lastMessageAt = Date.now();
  const key = code && liveDiagnostics.codeCounts.has(code) ? code : 'other';
  liveDiagnostics.codeCounts.set(key, (liveDiagnostics.codeCounts.get(key) ?? 0) + 1);
  renderLiveDiagnostics();
}

function reportLiveProcessing(code: string, result: string, receiveAt: number, sourceTimestamp: string | null = null, sourceLatencyLabel = '発表→受信', parsed = true, rendered = false): void {
  if (!isLiveDebugMode) return;
  if (liveDiagnostics.parseSuccessCounts.has(code) && parsed) liveDiagnostics.parseSuccessCounts.set(code, (liveDiagnostics.parseSuccessCounts.get(code) ?? 0) + 1);
  if (liveDiagnostics.renderedCounts.has(code) && rendered) liveDiagnostics.renderedCounts.set(code, (liveDiagnostics.renderedCounts.get(code) ?? 0) + 1);
  const uiAt = Date.now();
  const receiveDelay = Math.max(0, uiAt - receiveAt);
  const sourceAt = parseP2pTimestamp(sourceTimestamp);
  const sourceClock = sourceAt === null ? '計測不可' : diagnosticClock(sourceAt);
  const sourceLatency = sourceAt === null ? '計測不可' : formatLatency(calculateLatency(receiveAt, sourceTimestamp));
  addLiveDiagnostic(`${code}: ${result} · 発表/更新 ${sourceClock} · 受信 ${diagnosticClock(receiveAt)} · UI ${diagnosticClock(uiAt)}（受信→UI ${receiveDelay}ms） · ${sourceLatencyLabel} ${sourceLatency}`);
  renderLiveDiagnostics();
}

interface MapDragState {
  pointerId: number;
  lastClientX: number;
  lastClientY: number;
  pendingClientX: number;
  pendingClientY: number;
  moved: boolean;
}

let mapManualOverride = false;
let suppressedEewEventId: string | null = null;
let suppressedShakeEventId: string | null = null;
let mapDragState: MapDragState | null = null;
let mapDragFrame: number | undefined;
type TestFixturesModule = typeof import('./testFixtures/fixtures');
let testFixtures: TestFixturesModule | null = null;
let testEarthquakeSequence = 0;
let testBackfillSequence = 0;
let testNoReplayTargetId: string | null = null;
const testLogs: string[] = [];

function readSettings(): MonitorSettings {
  try {
    const stored = JSON.parse(window.localStorage.getItem(SETTINGS_STORAGE_KEY) ?? 'null') as Partial<MonitorSettings> | null;
    const storedVolume = typeof stored?.audioVolume === 'number' && Number.isFinite(stored.audioVolume)
      ? Math.min(100, Math.max(0, stored.audioVolume))
      : DEFAULT_SETTINGS.audioVolume;
    return {
      shakeDetectionEnabled: stored?.shakeDetectionEnabled !== false,
      autoFocusEnabled: stored?.autoFocusEnabled !== false,
      eewEnabled: stored?.eewEnabled !== false,
      eewAutoFocusEnabled: stored?.eewAutoFocusEnabled !== false,
      realtimeIntensityEnabled: false,
      audioNotificationsEnabled: stored?.audioNotificationsEnabled === true,
      eewAudioEnabled: stored?.eewAudioEnabled !== false,
      shakeAudioEnabled: stored?.shakeAudioEnabled !== false,
      earthquakeAudioEnabled: stored?.earthquakeAudioEnabled !== false,
      audioVolume: storedVolume,
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

function audioStatusLabel(): string {
  switch (audioNotifier.status()) {
    case 'enabled':
      return '音声：有効';
    case 'waiting':
      return '音声：ブラウザ操作待ち';
    case 'sandbox-locked':
      return '音声：Sandbox操作待ち';
    case 'unavailable':
      return '音声：利用できません';
    default:
      return '音声：OFF';
  }
}

function updateAudioUi(): void {
  audioNotificationsToggle.checked = settings.audioNotificationsEnabled;
  eewAudioToggle.checked = settings.eewAudioEnabled;
  shakeAudioToggle.checked = settings.shakeAudioEnabled;
  earthquakeAudioToggle.checked = settings.earthquakeAudioEnabled;
  audioVolume.value = String(settings.audioVolume);
  audioVolumeLabel.textContent = `${settings.audioVolume}%`;
  audioStatus.textContent = audioStatusLabel();

  const showEnable = settings.audioNotificationsEnabled && audioNotifier.status() !== 'enabled' && audioNotifier.status() !== 'unavailable';
  audioEnableButton.hidden = !showEnable;
  audioEnableButton.textContent = isEewSandbox ? 'SANDBOX音声を有効化' : '音声を有効化';
  const testDisabled = !settings.audioNotificationsEnabled || (isEewSandbox && !audioNotifier.isSandboxUnlocked());
  audioTestEarthquake.disabled = testDisabled;
  audioTestShake.disabled = testDisabled;
  audioTestEew.disabled = testDisabled;
}

function reportTestAudio(cue: AudioCue, result: AudioNotifyResult): void {
  if (!isTestMode) return;
  const names: Record<AudioCue, string> = {
    earthquake: 'earthquake',
    shake: 'shake detection',
    eew: 'EEW',
    cancel: 'EEW cancel',
  };
  if (result === 'queued') addTestLog(`audio: ${names[cue]}`);
  else if (result === 'suppressed') addTestLog(`audio suppressed: ${names[cue]}`);
  else if (result === 'waiting') addTestLog(`audio waiting: ${names[cue]}`);
  else if (result === 'sandbox-locked') addTestLog(`audio locked: ${names[cue]}`);
  else if (result === 'disabled') addTestLog(`audio OFF: ${names[cue]}`);
  else addTestLog(`audio unavailable: ${names[cue]}`);
}

function notifyAudio(cue: AudioCue): AudioNotifyResult {
  const result = audioNotifier.notify(cue);
  reportTestAudio(cue, result);
  return result;
}

function addTestLog(message: string): void {
  if (!isTestMode || !testLogList || !testLogCount) return;
  const time = new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date());
  testLogs.push(`${time} ${message}`);
  if (testLogs.length > 50) testLogs.splice(0, testLogs.length - 50);
  testLogList.replaceChildren(...testLogs.map((entry) => {
    const item = document.createElement('li');
    item.textContent = entry;
    return item;
  }));
  testLogCount.textContent = `${testLogs.length} / 50`;
}

function clearTestLogs(): void {
  if (!isTestMode || !testLogList || !testLogCount) return;
  testLogs.length = 0;
  testLogList.replaceChildren();
  testLogCount.textContent = '0 / 50';
}

function payloadString(value: unknown, ...keys: string[]): string | null {
  let current: unknown = value;
  for (const key of keys) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' && current.length > 0 ? current : null;
}

function createReceiveTiming(payload: unknown, browserReceivedAt: number, sourceTimestamp: string | null = null): ReceiveTiming {
  const basicTimestamp = payloadString(payload, 'time');
  return {
    browserReceivedAt,
    basicTimestamp,
    sourceTimestamp,
    p2pToBrowser: calculateLatency(browserReceivedAt, basicTimestamp),
    sourceToBrowser: calculateLatency(browserReceivedAt, sourceTimestamp),
  };
}

function rememberEarthquakeReceiveTiming(id: string, timing: ReceiveTiming): void {
  if (earthquakeReceiveTimings.has(id)) {
    earthquakeReceiveTimings.set(id, timing);
    return;
  }
  earthquakeReceiveTimings.set(id, timing);
  earthquakeReceiveTimingOrder.push(id);
  if (earthquakeReceiveTimingOrder.length > MAX_RECEIVE_TIMINGS) {
    const expiredId = earthquakeReceiveTimingOrder.shift();
    if (expiredId) earthquakeReceiveTimings.delete(expiredId);
  }
}

function rememberHistoryReceiveTimings(earthquakes: readonly Earthquake[], browserReceivedAt: number): void {
  for (const earthquake of earthquakes) {
    if (earthquakeReceiveTimings.has(earthquake.reportId)) continue;
    rememberEarthquakeReceiveTiming(earthquake.reportId, {
      browserReceivedAt,
      basicTimestamp: earthquake.basicTime,
      sourceTimestamp: earthquake.issueTime,
      p2pToBrowser: calculateLatency(browserReceivedAt, earthquake.basicTime),
      sourceToBrowser: calculateLatency(browserReceivedAt, earthquake.issueTime),
    });
  }
}

function renderLatestReceiveMetrics(latest: Earthquake | undefined): void {
  const timing = latest ? earthquakeReceiveTimings.get(latest.reportId) : undefined;
  latestReceiveMetrics.hidden = !timing;
  if (!timing) return;
  latestReceivedAt.textContent = formatClock(timing.browserReceivedAt);
  latestP2pLatency.textContent = formatLatency(timing.p2pToBrowser);
  latestSourceLatency.textContent = formatLatency(timing.sourceToBrowser);
  latestReceivedAge.textContent = formatAge(timing.browserReceivedAt);
}

function renderEewReceiveMetrics(timing: ReceiveTiming | null): void {
  eewReceiveMetrics.hidden = timing === null;
  if (!timing) return;
  eewReceivedAt.textContent = formatClock(timing.browserReceivedAt);
  eewReceivedAge.textContent = formatAge(timing.browserReceivedAt);
  eewP2pLatency.textContent = formatLatency(timing.p2pToBrowser);
  eewSourceLatency.textContent = formatLatency(timing.sourceToBrowser);
}

const tokyoClockFormatter = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function updateCurrentTime(): void {
  const now = new Date();
  const clockText = tokyoClockFormatter.format(now);
  currentTime.textContent = clockText;
  monitorCurrentTime.textContent = clockText;
  currentTime.dateTime = now.toISOString();
}

function renderCompactPriorityAlert(): void {
  if (!eewDetails.hidden) {
    compactPriorityAlert.textContent = `EEW ${eewReport.textContent} · ${eewPlaceName.textContent} · 最大予測震度 ${eewScale.textContent}`;
    compactPriorityAlert.className = 'compact-priority-alert is-eew';
    compactPriorityAlert.hidden = false;
  } else if (!eewCancelled.hidden) {
    compactPriorityAlert.textContent = '緊急地震速報は取り消されました';
    compactPriorityAlert.className = 'compact-priority-alert is-cancelled';
    compactPriorityAlert.hidden = false;
  } else if (!shakeStatus.hidden) {
    compactPriorityAlert.textContent = `${shakeStatus.querySelector('.shake-status-label')?.textContent ?? '揺れを検出しています'} · ${shakeStatusDetail.textContent}`;
    compactPriorityAlert.className = 'compact-priority-alert is-shake';
    compactPriorityAlert.hidden = false;
  } else {
    compactPriorityAlert.hidden = true;
    compactPriorityAlert.textContent = '';
  }
}

let panelPreference: boolean | null = null;
const compactPanelMedia = window.matchMedia('(max-width: 450px)');
const compactMapMedia = window.matchMedia('(max-width: 700px)');

function syncInformationPanelToggle(): void {
  const isOpen = panelPreference ?? !compactPanelMedia.matches;
  workspace.classList.toggle('is-panel-open', isOpen);
  workspace.classList.toggle('is-panel-closed', !isOpen);
  informationPanelToggle.setAttribute('aria-expanded', String(isOpen));
  informationPanelToggle.setAttribute('aria-label', isOpen ? '地震情報パネルを閉じる' : '地震情報パネルを開く');
  informationPanelToggle.title = isOpen ? '地震情報パネルを閉じる' : '地震情報パネルを開く';
  informationPanelToggle.textContent = isOpen ? '<' : '>';
}

function updateReceiveAgeDisplays(): void {
  const now = Date.now();
  let expiredRawArea = false;
  for (const [code, state] of rawSensingAreas) {
    if (now - state.lastReceivedAt >= RAW_SENSING_TTL_MS) {
      rawSensingAreas.delete(code);
      expiredRawArea = true;
      const areaName = areaByCode.get(code)?.name ?? code;
      addLiveDiagnostic(`561: TTL終了・${areaName}のマーカーを解除`);
    }
  }
  if (expiredRawArea) renderRawSensingMarkers();
  const latest = store.recent[0];
  const latestTiming = latest ? earthquakeReceiveTimings.get(latest.reportId) : undefined;
  monitorLastReceive.textContent = formatAge(lastWebSocketReceivedAt);
  monitorLatestEew.textContent = activeEew ? '受信中' : eewCancelledMessageVisible ? '取消' : '待機中';
  monitorLatestEew.closest('.monitor-item')?.classList.toggle('is-active', Boolean(activeEew));
  monitorLatestEew.closest('.monitor-item')?.classList.toggle('is-cancelled', !activeEew && eewCancelledMessageVisible);
  const shakeIsActive = settings.shakeDetectionEnabled && Boolean(currentShakeDetection && currentShakeReceiveTiming);
  monitorShake.textContent = !settings.shakeDetectionEnabled ? 'OFF' : shakeIsActive ? '解析中' : '待機中';
  monitorShake.closest('.monitor-item')?.classList.toggle('is-active', shakeIsActive);
  monitorLatestQuake.textContent = latestTiming ? formatAge(latestTiming.browserReceivedAt) : '待機中';
  monitorHistorySync.textContent = lastHistorySyncSucceededAt === null ? '待機中' : formatAge(lastHistorySyncSucceededAt);
  latestReceivedAge.textContent = latestTiming ? formatAge(latestTiming.browserReceivedAt) : '待機中';
  if (activeEew) eewReceivedAge.textContent = formatAge(activeEew.receiveTiming.browserReceivedAt);
  updateCurrentTime();
  renderLiveDiagnostics();
}

function startReceiveAgeTimer(): void {
  updateReceiveAgeDisplays();
  if (receiveAgeTimer === undefined) receiveAgeTimer = window.setInterval(updateReceiveAgeDisplays, 1_000);
}

function incomingCode(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const code = (payload as Record<string, unknown>).code;
  return typeof code === 'number' && Number.isFinite(code) ? String(code) : null;
}

function addTestTimingLog(label: string, timing: ReceiveTiming, sourceLabel = 'source→Browser'): void {
  if (!isTestMode) return;
  addTestLog(`${label} received`);
  addTestLog(`P2P→Browser: ${formatLatency(timing.p2pToBrowser)}`);
  if (timing.sourceTimestamp) addTestLog(`${sourceLabel}: ${formatLatency(timing.sourceToBrowser)}`);
}

function readMapViewBox(): MapViewBox {
  const values = japanMap.getAttribute('viewBox')?.trim().split(/\s+/).map(Number) ?? [];
  if (values.length === 4 && values.every(Number.isFinite)) {
    return { x: values[0], y: values[1], width: values[2], height: values[3] };
  }
  return { ...MAP_VIEWBOX };
}

function clampMapViewBox(viewBox: MapViewBox): MapViewBox {
  const minimumWidth = MAP_VIEWBOX.width / MAX_MAP_ZOOM;
  const minimumHeight = MAP_VIEWBOX.height / MAX_MAP_ZOOM;
  const width = Math.min(MAP_VIEWBOX.width, Math.max(minimumWidth, Number.isFinite(viewBox.width) ? viewBox.width : MAP_VIEWBOX.width));
  const height = Math.min(MAP_VIEWBOX.height, Math.max(minimumHeight, Number.isFinite(viewBox.height) ? viewBox.height : MAP_VIEWBOX.height));
  const x = Math.min(
    MAP_VIEWBOX.x + MAP_VIEWBOX.width - width,
    Math.max(MAP_VIEWBOX.x, Number.isFinite(viewBox.x) ? viewBox.x : MAP_VIEWBOX.x),
  );
  const y = Math.min(
    MAP_VIEWBOX.y + MAP_VIEWBOX.height - height,
    Math.max(MAP_VIEWBOX.y, Number.isFinite(viewBox.y) ? viewBox.y : MAP_VIEWBOX.y),
  );
  return { x, y, width, height };
}

function setMapViewBox(viewBox: MapViewBox): void {
  const clamped = clampMapViewBox(viewBox);
  japanMap.setAttribute('viewBox', `${clamped.x.toFixed(2)} ${clamped.y.toFixed(2)} ${clamped.width.toFixed(2)} ${clamped.height.toFixed(2)}`);
}

function resetMapView(): void {
  setMapViewBox(compactMapMedia.matches ? COMPACT_MAP_VIEWBOX : MAP_VIEWBOX);
}

function isNationViewBox(viewBox: MapViewBox): boolean {
  return [MAP_VIEWBOX, COMPACT_MAP_VIEWBOX].some((nation) =>
    Math.abs(viewBox.x - nation.x) < 0.01 &&
    Math.abs(viewBox.y - nation.y) < 0.01 &&
    Math.abs(viewBox.width - nation.width) < 0.01 &&
    Math.abs(viewBox.height - nation.height) < 0.01,
  );
}

function markMapUserInteraction(): void {
  mapManualOverride = true;
  if (activeEewEventId) suppressedEewEventId = activeEewEventId;
  if (currentShakeDetection) suppressedShakeEventId = currentShakeDetection.startedAt;
}

function markMapAutoFocusApplied(kind: 'eew' | 'shake'): void {
  mapManualOverride = false;
  if (kind === 'eew') suppressedEewEventId = null;
  else suppressedShakeEventId = null;
}

function screenPointToMap(clientX: number, clientY: number): { x: number; y: number } | null {
  const matrix = japanMap.getScreenCTM();
  if (matrix) {
    try {
      const point = japanMap.createSVGPoint();
      point.x = clientX;
      point.y = clientY;
      const mapped = point.matrixTransform(matrix.inverse());
      if (Number.isFinite(mapped.x) && Number.isFinite(mapped.y)) return { x: mapped.x, y: mapped.y };
    } catch {
      // Use the bounding rectangle fallback below when a browser cannot invert the matrix.
    }
  }

  const rect = japanMap.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const viewBox = readMapViewBox();
  return {
    x: viewBox.x + ((clientX - rect.left) / rect.width) * viewBox.width,
    y: viewBox.y + ((clientY - rect.top) / rect.height) * viewBox.height,
  };
}

function viewBoxDeltaFromPixels(deltaX: number, deltaY: number): { x: number; y: number } {
  const rect = japanMap.getBoundingClientRect();
  const viewBox = readMapViewBox();
  if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
  return {
    x: (deltaX / rect.width) * viewBox.width,
    y: (deltaY / rect.height) * viewBox.height,
  };
}

function zoomMapAt(clientX: number | null, clientY: number | null, factor: number): void {
  const current = readMapViewBox();
  const anchor = clientX === null || clientY === null
    ? { x: current.x + current.width / 2, y: current.y + current.height / 2 }
    : screenPointToMap(clientX, clientY) ?? { x: current.x + current.width / 2, y: current.y + current.height / 2 };
  const nextWidth = current.width * factor;
  const nextHeight = current.height * factor;
  const relativeX = (anchor.x - current.x) / current.width;
  const relativeY = (anchor.y - current.y) / current.height;
  setMapViewBox({
    x: anchor.x - relativeX * nextWidth,
    y: anchor.y - relativeY * nextHeight,
    width: nextWidth,
    height: nextHeight,
  });
}

function zoomMapByFactor(factor: number, clientX: number | null = null, clientY: number | null = null): void {
  markMapUserInteraction();
  zoomMapAt(clientX, clientY, factor);
}

function resetMapToNation(): void {
  // 全国表示は現在イベントへの手動フォーカスを解除する操作です。
  // ただし、同じEEW/揺れ検出の続報で直ちに戻さないよう、現在の
  // イベントだけを抑制し、新しいイベントでは自動フォーカスを許可します。
  if (activeEewEventId) suppressedEewEventId = activeEewEventId;
  if (currentShakeDetection) suppressedShakeEventId = currentShakeDetection.startedAt;
  mapManualOverride = false;
  stopReplay();
  selectedEarthquakeId = null;
  resetMapView();
  renderMarkers(store.recent);
  renderList(store.recent);
  renderSelectedQuakeActions();
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

function confidenceAreaCategories(detection: ShakeDetection): { a: Array<{ area: EpspArea; confidence: number }>; b: Array<{ area: EpspArea; confidence: number }> } {
  const a: Array<{ area: EpspArea; confidence: number }> = [];
  const b: Array<{ area: EpspArea; confidence: number }> = [];
  for (const [code, confidence] of detection.areaConfidences) {
    const area = areaByCode.get(code);
    if (!area || confidence < MEDIUM_CONFIDENCE_THRESHOLD) continue;
    (confidence >= HIGH_CONFIDENCE_THRESHOLD ? a : b).push({ area, confidence });
  }
  return { a, b };
}

function renderRawSensingMarkers(): void {
  rawShakeMarkers.replaceChildren();
  if (!settings.shakeDetectionEnabled) return;
  const analyzedCodes = new Set<string>();
  if (currentShakeDetection) {
    for (const [code, confidence] of currentShakeDetection.areaConfidences) {
      if (confidence >= MEDIUM_CONFIDENCE_THRESHOLD) analyzedCodes.add(String(Number(code)));
    }
  }
  for (const [code, state] of rawSensingAreas) {
    if (Date.now() - state.lastReceivedAt >= RAW_SENSING_TTL_MS || analyzedCodes.has(String(Number(code)))) continue;
    const area = areaByCode.get(code);
    if (!area) continue;
    const point = projectCoordinates(area.latitude, area.longitude);
    if (!point) continue;
    const marker = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    marker.setAttribute('class', 'raw-sensing-marker');
    marker.setAttribute('transform', `translate(${point.x} ${point.y})`);
    marker.setAttribute('role', 'img');
    marker.setAttribute('aria-label', `${area.name}、P2P感知速報 ${state.count}件`);
    const ring = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    ring.setAttribute('class', 'raw-sensing-ring');
    ring.setAttribute('r', '9');
    marker.append(ring);
    const core = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    core.setAttribute('class', 'raw-sensing-core');
    core.setAttribute('r', '3.5');
    marker.append(core);
    rawShakeMarkers.append(marker);
  }
}

interface RawSensingResult { areaName: string | null; outcome: 'added' | 'duplicate' | 'disabled' | 'missing-area-code' | 'unknown-region' | 'covered-by-9611' | 'rendered'; }

function receiveRawSensing(areaCode: number | undefined, id: string): RawSensingResult {
  if (!settings.shakeDetectionEnabled) return { areaName: null, outcome: 'disabled' };
  if (areaCode === undefined) return { areaName: null, outcome: 'missing-area-code' };
  const code = String(areaCode);
  const area = areaByCode.get(code);
  if (rawSensingIds.has(id)) return { areaName: area?.name ?? null, outcome: 'duplicate' };
  rawSensingIds.add(id);
  rawSensingIdOrder.push(id);
  if (rawSensingIdOrder.length > MAX_RAW_SENSING_IDS) {
    const oldest = rawSensingIdOrder.shift();
    if (oldest) rawSensingIds.delete(oldest);
  }
  if (!area) return { areaName: null, outcome: 'unknown-region' };
  const alreadyAnalyzed = Boolean(currentShakeDetection && [...currentShakeDetection.areaConfidences].some(([areaCodeKey, confidence]) => String(Number(areaCodeKey)) === String(Number(code)) && confidence >= MEDIUM_CONFIDENCE_THRESHOLD));
  const previous = rawSensingAreas.get(code);
  rawSensingAreas.set(code, { count: Math.min(999, (previous?.count ?? 0) + 1), lastReceivedAt: Date.now() });
  if (rawSensingAreas.size > MAX_RAW_SENSING_AREAS) {
    const oldestCode = [...rawSensingAreas.entries()].sort((a, b) => a[1].lastReceivedAt - b[1].lastReceivedAt)[0]?.[0];
    if (oldestCode) rawSensingAreas.delete(oldestCode);
  }
  renderRawSensingMarkers();
  return { areaName: area.name, outcome: alreadyAnalyzed ? 'covered-by-9611' : 'rendered' };
}

function clearRawSensingState(): void {
  rawSensingAreas.clear();
  rawSensingIds.clear();
  rawSensingIdOrder.length = 0;
  renderRawSensingMarkers();
}

function focusMapOnPoints(points: Array<{ x: number; y: number }>, padding: number, minimumSize: number): boolean {
  if (points.length === 0) return false;

  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  const width = Math.min(MAP_VIEWBOX.width, Math.max(minimumSize, maxX - minX + padding * 2));
  const height = Math.min(MAP_VIEWBOX.height, Math.max(minimumSize, maxY - minY + padding * 2));
  const x = Math.max(MAP_VIEWBOX.x, Math.min(MAP_VIEWBOX.width - width, (minX + maxX - width) / 2));
  const y = Math.max(MAP_VIEWBOX.y, Math.min(MAP_VIEWBOX.height - height, (minY + maxY - height) / 2));
  setMapViewBox({ x, y, width, height });
  return true;
}

function focusMapOnAreas(areas: Array<{ area: EpspArea; confidence: number }>): boolean {
  const points = areas
    .map(({ area }) => projectCoordinates(area.latitude, area.longitude))
    .filter((point): point is { x: number; y: number } => point !== null);
  return focusMapOnPoints(points, points.length === 1 ? 135 : 80, points.length === 1 ? 220 : 180);
}

function focusMapOnEew(eew: EewMessage): boolean {
  const hypocenter = eew.earthquake?.hypocenter;
  if (!hypocenter || hypocenter.latitude === null || hypocenter.longitude === null) return false;
  const point = projectCoordinates(hypocenter.latitude, hypocenter.longitude);
  return point ? focusMapOnPoints([point], 145, 260) : false;
}

function renderShakeDetection(): void {
  shakeDetectionMarkers.replaceChildren();
  renderRawSensingMarkers();
  if (!settings.shakeDetectionEnabled || !currentShakeDetection) {
    shakeStatus.hidden = true;
    shakeStatusDetail.textContent = '';
    renderCompactPriorityAlert();
    return;
  }

  const categories = confidenceAreaCategories(currentShakeDetection);
  const areas = [...categories.a.map((item) => ({ ...item, grade: 'a' })), ...categories.b.map((item) => ({ ...item, grade: 'b' }))];
  for (const { area, confidence, grade } of areas) {
    const point = projectCoordinates(area.latitude, area.longitude);
    if (!point) continue;
    const marker = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    marker.setAttribute('class', `shake-area-marker is-grade-${grade}`);
    marker.setAttribute('transform', `translate(${point.x} ${point.y})`);
    marker.setAttribute('role', 'img');
    marker.setAttribute('aria-label', `${area.name}、信頼度${grade.toUpperCase()}（${Math.round(confidence * 100)}%）`);

    const halo = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    halo.setAttribute('class', 'shake-area-halo');
    halo.setAttribute('r', grade === 'a' ? '13' : '10');
    marker.append(halo);
    const core = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    core.setAttribute('class', 'shake-area-core');
    core.setAttribute('r', grade === 'a' ? '5' : '3.5');
    marker.append(core);
    shakeDetectionMarkers.append(marker);
  }

  shakeStatus.hidden = false;
  shakeStatusDetail.textContent = `解析済み ${currentShakeDetection.count}件 · 信頼度A ${categories.a.length}地域 / B ${categories.b.length}地域`;
  renderCompactPriorityAlert();
}

function clearShakeDetection(): void {
  if (shakeDetectionTimer !== undefined) window.clearTimeout(shakeDetectionTimer);
  shakeDetectionTimer = undefined;
  currentShakeDetection = null;
  currentShakeReceiveTiming = null;
  lastFocusedShakeEvent = null;
  renderShakeDetection();
  if (!mapManualOverride) resetMapView();
  updateReceiveAgeDisplays();
}

function scheduleShakeDetectionExpiry(): void {
  if (shakeDetectionTimer !== undefined) window.clearTimeout(shakeDetectionTimer);
  shakeDetectionTimer = window.setTimeout(() => {
    shakeDetectionTimer = undefined;
    currentShakeDetection = null;
    currentShakeReceiveTiming = null;
    lastFocusedShakeEvent = null;
    renderShakeDetection();
    if (!mapManualOverride) resetMapView();
    updateReceiveAgeDisplays();
  }, DETECTION_TIMEOUT_MS);
}

type ShakeUpdateResult = 'started' | 'updated' | 'ended' | 'ignored';

function updateShakeDetection(detection: ShakeDetection, receiveTiming: ReceiveTiming): ShakeUpdateResult {
  if (!settings.shakeDetectionEnabled || detection.count <= 0 || detection.confidence <= 0) {
    const wasActive = currentShakeDetection !== null;
    clearShakeDetection();
    return wasActive ? 'ended' : 'ignored';
  }

  const wasActive = currentShakeDetection !== null;
  const isNewDetectionEvent = currentShakeDetection?.startedAt !== detection.startedAt;
  currentShakeDetection = detection;
  currentShakeReceiveTiming = receiveTiming;
  const areas = highConfidenceAreas(detection);
  if (
    !activeEew &&
    settings.autoFocusEnabled &&
    areas.length > 0 &&
    isNewDetectionEvent &&
    lastFocusedShakeEvent !== detection.startedAt &&
    suppressedShakeEventId !== detection.startedAt
  ) {
    if (focusMapOnAreas(areas)) {
      lastFocusedShakeEvent = detection.startedAt;
      markMapAutoFocusApplied('shake');
    }
  }
  renderShakeDetection();
  scheduleShakeDetectionExpiry();
  return wasActive ? 'updated' : 'started';
}

function applySettings(): void {
  shakeDetectionToggle.checked = settings.shakeDetectionEnabled;
  autoFocusToggle.checked = settings.autoFocusEnabled;
  eewToggle.checked = settings.eewEnabled;
  eewAutoFocusToggle.checked = settings.eewAutoFocusEnabled;
  audioNotifier.setEnabled(settings.audioNotificationsEnabled);
  audioNotifier.setVolume(settings.audioVolume);
  if (!settings.shakeDetectionEnabled) {
    clearShakeDetection();
    clearRawSensingState();
  }
  else if (!settings.autoFocusEnabled) {
    lastFocusedShakeEvent = null;
    if (!mapManualOverride) resetMapView();
  }
  else if (currentShakeDetection) {
    const areas = highConfidenceAreas(currentShakeDetection);
    if (
      !activeEew &&
      areas.length > 0 &&
      lastFocusedShakeEvent !== currentShakeDetection.startedAt &&
      suppressedShakeEventId !== currentShakeDetection.startedAt &&
      focusMapOnAreas(areas)
    ) {
      lastFocusedShakeEvent = currentShakeDetection.startedAt;
      markMapAutoFocusApplied('shake');
    }
  }
  if (!settings.eewEnabled && (activeEew !== null || eewCancelledMessageVisible || eewByEventId.size > 0)) clearEewState();
  else if (!settings.eewAutoFocusEnabled) restoreSecondaryFocus();
  else if (activeEew && !mapManualOverride && suppressedEewEventId !== activeEew.issue.eventId && focusMapOnEew(activeEew)) {
    markMapAutoFocusApplied('eew');
  }
  renderShakeDetection();
  updateAudioUi();
  saveSettings();
}

interface EewPrefectureForecast {
  prefecture: string;
  scaleTo: number;
  names: string[];
}

function forecastPrefectureName(pref: string): string | null {
  const matches = PREFECTURE_NAMES.filter((name) => pref.startsWith(name));
  return matches.sort((left, right) => right.length - left.length)[0] ?? null;
}

function aggregateEewPrefectures(areas: readonly EewArea[]): EewPrefectureForecast[] {
  const forecasts = new Map<string, EewPrefectureForecast>();
  for (const area of areas) {
    if (area.scaleTo === null || !EEW_SCALE_CODES.has(area.scaleTo)) continue;
    const prefecture = forecastPrefectureName(area.pref);
    if (!prefecture) continue;
    const current = forecasts.get(prefecture);
    if (!current) {
      forecasts.set(prefecture, { prefecture, scaleTo: area.scaleTo, names: [area.name] });
    } else {
      current.scaleTo = Math.max(current.scaleTo, area.scaleTo);
      if (!current.names.includes(area.name)) current.names.push(area.name);
    }
  }
  return [...forecasts.values()].sort((left, right) => right.scaleTo - left.scaleTo || left.prefecture.localeCompare(right.prefecture, 'ja'));
}

function eewForecastClass(scale: number): string {
  if (scale >= 70) return 'eew-scale-7';
  if (scale >= 60) return 'eew-scale-6';
  if (scale >= 55) return 'eew-scale-6-weak';
  if (scale >= 50) return 'eew-scale-5-strong';
  if (scale >= 45) return 'eew-scale-5-weak';
  if (scale >= 40) return 'eew-scale-4';
  if (scale >= 30) return 'eew-scale-3';
  if (scale >= 20) return 'eew-scale-2';
  if (scale >= 10) return 'eew-scale-1';
  return 'eew-scale-0';
}

function eewForecastColor(scale: number): string {
  if (scale >= 70) return '#d46a78';
  if (scale >= 60) return '#dc7b68';
  if (scale >= 55) return '#e39962';
  if (scale >= 50) return '#e8ad67';
  if (scale >= 45) return '#d7bd71';
  if (scale >= 40) return '#b4bd7b';
  if (scale >= 30) return '#83b39a';
  if (scale >= 20) return '#6498ad';
  if (scale >= 10) return '#4d7f9e';
  return '#3b607e';
}

function renderEewPrefectureOverlays(eew: EewMessage | null): void {
  eewPrefectureOverlays.replaceChildren();
  if (!eew || !settings.eewEnabled) return;

  for (const forecast of aggregateEewPrefectures(eew.areas)) {
    const code = PREFECTURE_CODE_BY_NAME.get(forecast.prefecture);
    if (!code) continue;
    const overlay = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    const href = `${japanMapUrl}#pref-${code}`;
    overlay.setAttribute('href', href);
    overlay.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', href);
    overlay.setAttribute('x', '0');
    overlay.setAttribute('y', '0');
    overlay.setAttribute('width', String(MAP_VIEWBOX.width));
    overlay.setAttribute('height', String(MAP_VIEWBOX.height));
    overlay.setAttribute('class', `eew-prefecture ${eewForecastClass(forecast.scaleTo)}`);
    overlay.setAttribute('fill', eewForecastColor(forecast.scaleTo));
    overlay.setAttribute('fill-opacity', '.58');
    overlay.setAttribute('stroke', '#e7d39a');
    overlay.setAttribute('stroke-opacity', '.72');
    overlay.setAttribute('stroke-width', '1.3');
    overlay.setAttribute('vector-effect', 'non-scaling-stroke');
    overlay.setAttribute('aria-label', `${forecast.prefecture}、最大予測震度${scaleLabel(forecast.scaleTo)}`);
    eewPrefectureOverlays.append(overlay);
  }
}

function renderEewMarker(eew: EewMessage | null): void {
  eewMarker.replaceChildren();
  if (!eew) return;
  updateEewMapStatus(eew);
  const hypocenter = eew.earthquake?.hypocenter;
  if (!hypocenter || hypocenter.latitude === null || hypocenter.longitude === null) return;
  const point = projectCoordinates(hypocenter.latitude, hypocenter.longitude);
  if (!point) return;

  const marker = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  marker.setAttribute('class', `eew-source-marker${eew.test ? ' is-test' : ''}`);
  marker.setAttribute('transform', `translate(${point.x} ${point.y})`);
  marker.setAttribute('role', 'img');
  marker.setAttribute('aria-label', `${eew.test ? '試験' : '緊急地震速報'}の震源 ${hypocenter.reduceName ?? hypocenter.name ?? '不明'}`);

  const halo = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  halo.setAttribute('class', 'eew-marker-halo');
  halo.setAttribute('r', '18');
  marker.append(halo);
  const diamond = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  diamond.setAttribute('class', 'eew-marker-diamond');
  diamond.setAttribute('d', 'M 0 -11 L 11 0 L 0 11 L -11 0 Z');
  marker.append(diamond);
  const center = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  center.setAttribute('class', 'eew-marker-center');
  center.setAttribute('r', '2.5');
  marker.append(center);
  eewMarker.append(marker);
}

function updateEewMapStatus(eew: EewMessage): void {
  const hypocenter = eew.earthquake?.hypocenter;
  if (!hypocenter) {
    japanMap.setAttribute('aria-label', `${eew.test ? '試験' : '緊急地震速報'}を表示。震源座標なし`);
    return;
  }
  const place = hypocenter.reduceName ?? hypocenter.name ?? '震源情報不明';
  japanMap.setAttribute('aria-label', `${eew.test ? '試験' : '緊急地震速報'}の震源を表示。${place}`);
}

function eewArrivalText(areas: readonly EewArea[]): string | null {
  if (areas.some((area) => area.kindCode === '11')) return '主要動 到達済み';
  const pending = areas.filter((area) => area.kindCode === '10');
  if (pending.length > 0) {
    const arrival = pending
      .map((area) => area.arrivalTime)
      .filter((value): value is string => value !== null)
      .sort()[0];
    return arrival ? `主要動 未到達 / 到達予測 ${formatTime(arrival)}` : '主要動 未到達';
  }
  if (areas.some((area) => area.kindCode === '19')) return '到達予想なし（PLUM法）';
  return null;
}

function maxEewScale(areas: readonly EewArea[]): number | null {
  const values = areas
    .map((area) => area.scaleTo)
    .filter((value): value is number => value !== null && EEW_SCALE_CODES.has(value));
  return values.length > 0 ? Math.max(...values) : null;
}

function renderEewPanel(eew: StoredEew): void {
  latestCard.classList.add('is-eew');
  latestHeading.textContent = '緊急地震速報';
  latestIndicatorLabel.textContent = eew.test ? 'TEST' : 'EEW';
  latestLoading.hidden = true;
  latestDetails.hidden = true;
  latestReceiveMetrics.hidden = true;
  eewCancelled.hidden = true;
  eewDetails.hidden = false;
  eewTestBadge.hidden = !eew.test;
  eewReport.textContent = `第${eew.issue.serial}報`;

  const hypocenter = eew.earthquake?.hypocenter;
  eewPlaceName.textContent = hypocenter?.reduceName ?? hypocenter?.name ?? '震源情報不明';
  eewOriginTime.textContent = `発生 ${formatTime(eew.earthquake?.originTime ?? eew.time)}`;
  eewMagnitude.textContent = `M ${hypocenter?.magnitude === null || hypocenter?.magnitude === undefined ? '—' : hypocenter.magnitude.toFixed(1)}`;
  eewDepth.textContent = hypocenter?.depth === null || hypocenter?.depth === undefined ? '深さ —' : hypocenter.depth === 0 ? 'ごく浅い' : `深さ ${hypocenter.depth} km`;
  const predictedScale = maxEewScale(eew.areas);
  eewScale.textContent = predictedScale === null ? '不明' : scaleLabel(predictedScale);

  const arrivalText = eewArrivalText(eew.areas);
  eewArrivalState.hidden = arrivalText === null;
  eewArrivalState.textContent = arrivalText ?? '';

  const forecasts = aggregateEewPrefectures(eew.areas);
  eewForecastAreas.hidden = forecasts.length === 0;
  eewForecastAreas.textContent = forecasts.length > 0
    ? `府県集約予測：${forecasts.slice(0, 5).map((forecast) => `${forecast.prefecture} ${scaleLabel(forecast.scaleTo)}`).join('、')}${forecasts.length > 5 ? ' ほか' : ''}`
    : '';
  renderEewReceiveMetrics(eew.receiveTiming);
  renderCompactPriorityAlert();
}

function renderEewCancelled(): void {
  latestCard.classList.add('is-eew');
  latestHeading.textContent = '緊急地震速報';
  latestIndicatorLabel.textContent = '取消';
  latestLoading.hidden = true;
  latestDetails.hidden = true;
  eewDetails.hidden = true;
  eewCancelled.hidden = false;
  latestReceiveMetrics.hidden = true;
  renderEewReceiveMetrics(null);
  renderCompactPriorityAlert();
}

function compareEewSerial(left: string, right: string): number {
  const leftNumeric = left.match(/^\d+$/)?.[0].replace(/^0+(?=\d)/, '');
  const rightNumeric = right.match(/^\d+$/)?.[0].replace(/^0+(?=\d)/, '');
  if (leftNumeric && rightNumeric) {
    if (leftNumeric.length !== rightNumeric.length) return leftNumeric.length - rightNumeric.length;
    return leftNumeric.localeCompare(rightNumeric);
  }
  return left.localeCompare(right, 'en', { numeric: true, sensitivity: 'base' });
}

function clearEewTimer(): void {
  if (eewTimer !== undefined) window.clearTimeout(eewTimer);
  eewTimer = undefined;
}

function scheduleEewExpiry(eventId: string, serial: string): void {
  clearEewTimer();
  eewTimer = window.setTimeout(() => {
    eewTimer = undefined;
    const current = eewByEventId.get(eventId);
    if (activeEewEventId !== eventId || !current || current.issue.serial !== serial) return;
    eewByEventId.delete(eventId);
    activeEewEventId = null;
    activeEew = null;
    renderEewPrefectureOverlays(null);
    renderEewMarker(null);
    restoreSecondaryFocus();
    renderLatest(store.recent[0]);
    renderMarkers(store.recent);
  }, EEW_TIMEOUT_MS);
}

function scheduleEewCancellationClear(): void {
  clearEewTimer();
  eewTimer = window.setTimeout(() => {
    eewTimer = undefined;
    if (!eewCancelledMessageVisible || activeEew) return;
    eewCancelledMessageVisible = false;
    renderLatest(store.recent[0]);
    renderMarkers(store.recent);
  }, EEW_CANCEL_DISPLAY_MS);
}

function pruneEewEvents(): void {
  while (eewByEventId.size > MAX_EEW_EVENTS) {
    const oldest = [...eewByEventId.values()]
      .filter((event) => event.issue.eventId !== activeEewEventId)
      .sort((left, right) => left.receivedAt - right.receivedAt)[0];
    if (!oldest) return;
    eewByEventId.delete(oldest.issue.eventId);
  }
}

function restoreSecondaryFocus(): void {
  if (mapManualOverride) return;
  if (currentShakeDetection && settings.shakeDetectionEnabled && settings.autoFocusEnabled) {
    const areas = highConfidenceAreas(currentShakeDetection);
    if (areas.length > 0 && suppressedShakeEventId !== currentShakeDetection.startedAt && focusMapOnAreas(areas)) {
      lastFocusedShakeEvent = currentShakeDetection.startedAt;
      markMapAutoFocusApplied('shake');
      return;
    }
  }
  resetMapView();
}

function clearEewState(): void {
  clearEewTimer();
  eewByEventId.clear();
  activeEewEventId = null;
  activeEew = null;
  eewCancelledMessageVisible = false;
  renderEewPrefectureOverlays(null);
  renderEewMarker(null);
  restoreSecondaryFocus();
  renderLatest(store.recent[0]);
  if (hasLoaded) renderMarkers(store.recent);
}

type EewUpdateResult = 'disabled' | 'ignored-old' | 'duplicate' | 'ignored-cancelled' | 'cancelled' | 'new' | 'updated';

function updateEew(eew: EewMessage, receiveTiming: ReceiveTiming): EewUpdateResult {
  if (!settings.eewEnabled) return 'disabled';
  const existing = eewByEventId.get(eew.issue.eventId);
  const isNewEvent = existing === undefined;
  if (existing) {
    const serialOrder = compareEewSerial(eew.issue.serial, existing.issue.serial);
    if (serialOrder < 0) return 'ignored-old';
    // A serial identifies the report revision for an event.  Treat a
    // repeated serial as a duplicate even when the transport id differs.
    if (serialOrder === 0) return 'duplicate';
  }

  const record: StoredEew = { ...eew, receivedAt: Date.now(), receiveTiming };
  eewByEventId.set(eew.issue.eventId, record);
  pruneEewEvents();

  if (eew.cancelled) {
    if (activeEewEventId !== eew.issue.eventId) return 'ignored-cancelled';
    activeEewEventId = null;
    activeEew = null;
    eewCancelledMessageVisible = true;
    renderEewPrefectureOverlays(null);
    renderEewMarker(null);
    renderEewCancelled();
    restoreSecondaryFocus();
    renderMarkers(store.recent);
    scheduleEewCancellationClear();
    return 'cancelled';
  }

  activeEewEventId = eew.issue.eventId;
  activeEew = record;
  eewCancelledMessageVisible = false;
  if (
    isNewEvent &&
    settings.eewAutoFocusEnabled &&
    suppressedEewEventId !== eew.issue.eventId &&
    focusMapOnEew(eew)
  ) {
    markMapAutoFocusApplied('eew');
  }
  renderEewPrefectureOverlays(eew);
  renderEewMarker(eew);
  renderEewPanel(record);
  scheduleEewExpiry(eew.issue.eventId, eew.issue.serial);
  return isNewEvent ? 'new' : 'updated';
}

function formatTime(value: string): string {
  const timestamp = parseP2pTimestamp(value);
  if (timestamp === null) return '時刻不明';
  const date = new Date(timestamp);
  return new Intl.DateTimeFormat('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

function scaleLabel(scale: number | null): string {
  if (scale === null) return '不明';
  const labels: Record<number, string> = { '-1': '不明', 0: '0', 10: '1', 20: '2', 30: '3', 40: '4', 45: '5弱', 50: '5強', 55: '6弱', 60: '6強', 70: '7', 99: '～程度以上' };
  return labels[scale] ?? '不明';
}

/** Use the displayed JMA intensity label as the single source for UI colors. */
function intensityToneClass(label: string): string {
  const classes: Record<string, string> = {
    '0': 'intensity-0', '1': 'intensity-1', '2': 'intensity-2',
    '3': 'intensity-3', '4': 'intensity-4', '5弱': 'intensity-5-weak',
    '5強': 'intensity-5-strong', '6弱': 'intensity-6-weak',
    '6強': 'intensity-6-strong', '7': 'intensity-7',
  };
  return classes[label] ?? 'intensity-unknown';
}

function renderLatest(latest: Earthquake | undefined): void {
  if (activeEew) {
    renderEewPanel(activeEew);
    return;
  }
  if (eewCancelledMessageVisible) {
    renderEewCancelled();
    return;
  }

  latestCard.classList.remove('is-eew');
  latestHeading.textContent = '最新の地震';
  latestIndicatorLabel.textContent = '最新';
  eewDetails.hidden = true;
  eewCancelled.hidden = true;
  renderCompactPriorityAlert();
  renderEewReceiveMetrics(null);
  if (!latest) {
    latestScale.className = `scale-badge ${intensityToneClass('不明')}`;
    latestDetails.hidden = true;
    latestReceiveMetrics.hidden = true;
    latestLoading.hidden = false;
    latestLoading.innerHTML = '<div class="empty-state">表示できる地震情報はありません</div>';
    return;
  }

  latestLoading.hidden = true;
  latestDetails.hidden = false;
  const intensity = scaleLabel(latest.maxScale);
  latestScale.textContent = intensity;
  latestScale.className = `scale-badge ${intensityToneClass(intensity)}`;
  latestPlace.textContent = latest.hypocenter ?? '震源未判明';
  latestDate.textContent = formatTime(latest.time);
  latestMagnitude.textContent = `M ${latest.magnitude?.toFixed(1) ?? '—'}`;
  latestDepth.textContent = latest.depth === null ? '深さ —' : latest.depth === 0 ? 'ごく浅い' : `深さ ${latest.depth} km`;
  renderLatestReceiveMetrics(latest);

}

function renderList(earthquakes: readonly Earthquake[]): void {
  if (earthquakes.length === 0) {
    list.innerHTML = '<div class="empty-state">最近の地震情報はありません</div>';
    eventCount.textContent = '0件';
    return;
  }

  list.innerHTML = earthquakes.map((quake, index) => `
    <button class="quake-row ${intensityToneClass(scaleLabel(quake.maxScale))} ${index === 0 ? 'is-latest' : ''} ${selectedEarthquakeId === quake.id ? 'is-selected' : ''}" type="button" data-earthquake-id="${escapeHtml(quake.id)}" aria-pressed="${selectedEarthquakeId === quake.id}">
      <time datetime="${escapeHtml(quake.time)}">${formatTime(quake.time)}</time>
      <strong class="quake-place">${escapeHtml(quake.hypocenter ?? '震源未判明')}</strong>
      <span class="row-scale">震度 <b>${scaleLabel(quake.maxScale)}</b></span>
      <span class="row-measure">M ${quake.magnitude?.toFixed(1) ?? '—'}<small>${quake.depth === null ? '深さ —' : quake.depth === 0 ? 'ごく浅い' : `深さ ${quake.depth} km`}</small></span>
    </button>`).join('');
  eventCount.textContent = `${earthquakes.length}件`;
}

function renderSelectedQuakeActions(): void {
  const selected = store.recent.find((quake) => quake.id === selectedEarthquakeId);
  selectedQuakeActions.hidden = !selected;
  if (!selected) {
    selectedReplayStart.disabled = false;
    replayMessage.hidden = true;
    return;
  }
  selectedQuakeLabel.textContent = `${selected.hypocenter ?? '震源未判明'} · ${formatTime(selected.time)}`;
  selectedReplayStart.disabled = !isReplayEligible(selected) || replayController !== undefined;
  selectedReplayStart.title = isReplayEligible(selected) ? '取得可能な過去データを検索して再生します' : '過去3時間以内の地震が対象です';
  if (!isReplayEligible(selected) && !replayState && replayController === undefined) {
    replayMessage.hidden = false;
    replayMessage.textContent = 'リプレイ対象は発生から3時間以内の地震です';
  }
  renderReplayControls();
}

function replayIssueLabel(type: string): string {
  const labels: Record<string, string> = {
    ScalePrompt: '震度速報', Destination: '震源に関する情報',
    ScaleAndDestination: '震度・震源に関する情報', DetailScale: '各地の震度に関する情報',
    Foreign: '遠地地震に関する情報', Other: '地震情報',
  };
  return labels[type] ?? '地震情報';
}

const replayClockFormatter = new Intl.DateTimeFormat('ja-JP', {
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Tokyo',
});

function formatReplayDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function formatReplayTimestamp(timestamp: number | null): string {
  return timestamp === null ? '不明' : replayClockFormatter.format(new Date(timestamp));
}

function replayEndReason(replay: ReplayState): string {
  const confirmed: string[] = [];
  const unknown: string[] = [];
  if (replay.shakeSeen) (replay.shakeNotDetected ? confirmed : unknown).push('揺れ解析');
  if (replay.eewSeen) (replay.eewCancelled ? confirmed : unknown).push('EEW');
  const details = confirmed.map((kind) => `${kind}：${kind === 'EEW' ? '取消' : '非検出'}`);
  if (replay.historyMayBeTruncated) {
    const observed = details.length ? details.join(' / ') : '終了記録なし';
    return `取得上限の可能性があるため終了時刻は未確定です（取得範囲内：${observed}）`;
  }
  if (unknown.length > 0) return `${details.length ? `${details.join(' / ')} · ` : ''}記録終了（${unknown.join(' / ')}の終了時刻は不明）`;
  return details.length > 0 ? `記録された状態終了：${details.join(' / ')}` : '記録終了（揺れの終了時刻は不明）';
}

function renderReplayClock(replay: ReplayState): void {
  const clock = replayClockFormatter.format(new Date(replay.frames[0]!.at + replay.elapsedMs));
  replayTime.textContent = `${replay.visual ? 'REPLAY ' : '記録 '}${clock}`;
  replayElapsed.textContent = `経過 ${formatReplayDuration(replay.elapsedMs)} / ${formatReplayDuration(replay.durationMs)}`;
  replayProgress.max = Math.max(1, replay.durationMs);
  replayProgress.value = replay.elapsedMs;
  replayMapBanner.querySelector('strong')!.textContent = `${replay.visual ? 'REPLAY' : '記録'} ${clock}`;
}

function renderReplayControls(): void {
  const replay = replayState;
  replayControls.hidden = !replay;
  replayMapBanner.hidden = !replay;
  japanMap.classList.toggle('is-replaying', !!replay);
  if (!replay) {
    replayMapLayer.replaceChildren();
    return;
  }
  const frame = replay.frames[replay.index];
  const location = replay.target.hypocenter ?? '震源未判明';
  const targetIntensity = scaleLabel(replay.target.maxScale);
  const targetTone = intensityToneClass(targetIntensity);
  replayTargetScale.textContent = targetIntensity;
  replayTargetScale.className = `replay-target-scale ${targetTone}`;
  replayTargetLabel.textContent = `${location} · ${formatTime(replay.target.time)}`;
  replayMapTarget.textContent = `${location} · ${formatTime(replay.target.time)}`;
  replayMapTarget.className = targetTone;
  const replayLabel = replay.visual ? 'REPLAY' : replay.frames.some((item) => item.kind !== 'quake') ? '記録表示' : '発表履歴';
  replayBadge.textContent = replayLabel;
  replayPlayToggle.hidden = !replay.visual;
  replayRestart.hidden = !replay.visual;
  replaySpeedToggle.hidden = !replay.visual;
  replayPlayToggle.textContent = replay.playing ? '一時停止' : '再生';
  replaySpeedToggle.textContent = replay.speed === 1 ? '標準' : '高速';
  replayPrevious.disabled = replay.index === 0;
  replayNext.disabled = replay.index >= replay.frames.length - 1;
  replayPosition.textContent = `現在 第${replay.index + 1}記録（${replay.index + 1}/${replay.frames.length}）`;
  replayRecordCounts.textContent = `551発表履歴 ${replay.counts.quake}件（監視再生の終了時刻には不使用） · 556 ${replay.counts.eew}件 / 9611 ${replay.counts.shake}件 · 対象記録 ${replay.frames.length}件`;
  const endAt = replay.frames[replay.frames.length - 1]?.at ?? replay.startAt;
  replayTimelineMeta.textContent = `開始 ${formatReplayTimestamp(replay.startAt)} · 地震発生 ${formatReplayTimestamp(replay.originAt)} · 再生終端 ${formatReplayTimestamp(endAt)}`;
  replaySignalStatus.textContent = `EEW：${replay.eewCancelled ? '取消' : replay.activeEew ? '予測中' : '待機中'} · 揺れ解析：${replay.shakeNotDetected ? '非検出' : replay.activeShake ? '解析中' : '待機中'}`;
  if (frame) {
    const kind = frame.kind === 'eew' ? `EEW 第${frame.eew.issue.serial}報`
      : frame.kind === 'eew-cancelled' ? 'EEW取消'
        : frame.kind === 'shake' ? '揺れ感知解析'
          : frame.kind === 'shake-none' ? '揺れ解析：非検出' : '地震情報の発表';
    replayRecordKind.textContent = kind;
    const mapKind = frame.kind === 'eew'
      ? `EEW 第${frame.eew.issue.serial}報 震度${scaleLabel(Math.max(-1, ...frame.eew.areas.map((area) => area.scaleTo ?? -1)))}`
      : frame.kind === 'eew-cancelled'
        ? 'EEW取消 · 予測表示を解除'
      : frame.kind === 'shake'
        ? `揺れ解析 ${frame.detection.count}件 ${Math.round(frame.detection.confidence * 100)}%`
        : frame.kind === 'shake-none'
          ? `揺れ解析 非検出 · 件数 ${frame.detection.count} · 信頼度 ${Math.round(frame.detection.confidence * 100)}%`
        : '地震情報';
    replayMapDetail.textContent = `${mapKind} · 記録 ${replayClockFormatter.format(new Date(frame.at))} · ${replay.index + 1}/${replay.frames.length}`;
    replayRecordDetail.textContent = frame.kind === 'eew'
      ? `最大予測震度 ${scaleLabel(Math.max(-1, ...frame.eew.areas.map((area) => area.scaleTo ?? -1)))} · ${aggregateEewPrefectures(frame.eew.areas).length}府県（府県単位に集約）`
      : frame.kind === 'shake'
        ? `感知 ${frame.detection.count}件 · 解析信頼度 ${Math.round(frame.detection.confidence * 100)}% · A ${frame.areas.filter(({ confidence }) => confidence >= .8).length}地域 / B ${frame.areas.filter(({ confidence }) => confidence >= .6 && confidence < .8).length}地域`
        : frame.kind === 'shake-none' ? '揺れ解析は非検出状態です（地震の揺れ終了を示すものではありません）'
          : frame.kind === 'eew-cancelled' ? `EEW eventId ${frame.eventId} の取消記録です`
            : `${replayIssueLabel(frame.earthquake.issueType)} · 最大震度 ${scaleLabel(frame.earthquake.maxScale)}`;
  }
  renderReplayClock(replay);
  selectedReplayStart.disabled = true;
}

function renderReplayFrame(frame: ReplayFrame, replay = replayState): void {
  if (!replay) return;
  updateReplayStateFromFrame(frame, replay);
  renderReplayMapState(replay, frame);
}

function updateReplayStateFromFrame(frame: ReplayFrame, replay: ReplayState): void {
  switch (frame.kind) {
    case 'quake': replay.activeQuake = frame; break;
    case 'eew':
      replay.activeEew = frame;
      replay.eewSeen = true;
      replay.eewCancelled = false;
      break;
    case 'eew-cancelled':
      replay.activeEew = null;
      replay.eewSeen = true;
      replay.eewCancelled = true;
      break;
    case 'shake':
      replay.activeShake = frame;
      replay.shakeSeen = true;
      replay.shakeNotDetected = false;
      break;
    case 'shake-none':
      replay.activeShake = null;
      replay.shakeSeen = true;
      replay.shakeNotDetected = true;
      break;
  }
}

function rebuildReplayState(replay: ReplayState, throughIndex: number): void {
  replay.activeQuake = null;
  replay.activeEew = null;
  replay.activeShake = null;
  replay.eewSeen = false;
  replay.shakeSeen = false;
  replay.eewCancelled = false;
  replay.shakeNotDetected = false;
  for (let index = 0; index <= throughIndex; index += 1) {
    const frame = replay.frames[index];
    if (frame) updateReplayStateFromFrame(frame, replay);
  }
  const current = replay.frames[throughIndex];
  if (current) renderReplayMapState(replay, current);
}

function renderReplayMapState(replay: ReplayState, lastFrame: ReplayFrame): void {
  replayMapLayer.replaceChildren();
  const svgNamespace = 'http://www.w3.org/2000/svg';
  if (replay.activeQuake) {
    const point = projectEpicenter(replay.activeQuake.earthquake);
    if (point) {
      const marker = document.createElementNS(svgNamespace, 'g');
      marker.setAttribute('class', 'replay-quake-marker');
      marker.setAttribute('transform', `translate(${point.x} ${point.y})`);
      const circle = document.createElementNS(svgNamespace, 'circle');
      circle.setAttribute('r', '8');
      marker.append(circle);
      const center = document.createElementNS(svgNamespace, 'circle');
      center.setAttribute('r', '2.5');
      center.setAttribute('class', 'replay-marker-center');
      marker.append(center);
      replayMapLayer.append(marker);
    }
  }
  if (replay.activeEew) {
    for (const forecast of aggregateEewPrefectures(replay.activeEew.eew.areas)) {
      const code = PREFECTURE_CODE_BY_NAME.get(forecast.prefecture);
      if (!code) continue;
      const overlay = document.createElementNS(svgNamespace, 'use');
      const href = `${japanMapUrl}#pref-${code}`;
      overlay.setAttribute('href', href);
      overlay.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', href);
      overlay.setAttribute('width', String(MAP_VIEWBOX.width));
      overlay.setAttribute('height', String(MAP_VIEWBOX.height));
      overlay.setAttribute('class', `replay-forecast ${eewForecastClass(forecast.scaleTo)}`);
      overlay.setAttribute('fill', eewForecastColor(forecast.scaleTo));
      overlay.setAttribute('aria-label', `${forecast.prefecture}、最大予測震度${scaleLabel(forecast.scaleTo)}`);
      replayMapLayer.append(overlay);
    }
    const hypocenter = replay.activeEew.eew.earthquake?.hypocenter;
    const point = hypocenter?.latitude !== null && hypocenter?.latitude !== undefined && hypocenter.longitude !== null && hypocenter.longitude !== undefined
      ? projectCoordinates(hypocenter.latitude, hypocenter.longitude)
      : null;
    if (point) {
      const marker = document.createElementNS(svgNamespace, 'g');
      marker.setAttribute('class', 'replay-eew-marker');
      marker.setAttribute('transform', `translate(${point.x} ${point.y})`);
      const diamond = document.createElementNS(svgNamespace, 'path');
      diamond.setAttribute('d', 'M 0 -10 L 10 0 L 0 10 L -10 0 Z');
      marker.append(diamond);
      replayMapLayer.append(marker);
    }
  }
  if (replay.activeShake) {
    for (const { area, confidence } of replay.activeShake.areas) {
      const point = projectCoordinates(area.latitude, area.longitude);
      if (!point) continue;
      const marker = document.createElementNS(svgNamespace, 'g');
      marker.setAttribute('class', `replay-shake-area ${confidence >= .8 ? 'is-grade-a' : confidence >= .6 ? 'is-grade-b' : 'is-grade-c'}`);
      marker.setAttribute('transform', `translate(${point.x} ${point.y})`);
      marker.setAttribute('aria-label', `${area.name}、信頼度${Math.round(confidence * 100)}%`);
      const ring = document.createElementNS(svgNamespace, 'circle');
      ring.setAttribute('r', confidence >= .8 ? '10' : '7');
      const core = document.createElementNS(svgNamespace, 'circle');
      core.setAttribute('r', confidence >= .8 ? '4' : '3');
      marker.append(ring, core);
      replayMapLayer.append(marker);
    }
  }
  const description = lastFrame.kind === 'quake' ? '地震情報の発表' : lastFrame.kind === 'eew' ? `EEW 第${lastFrame.eew.issue.serial}報`
    : lastFrame.kind === 'eew-cancelled' ? 'EEW取消'
      : lastFrame.kind === 'shake-none' ? '揺れ解析：非検出' : `揺れ解析 ${lastFrame.areas.length}地域`;
  replayMapBanner.dataset.frame = description;
  replayMapBanner.setAttribute('aria-label', `${replayState?.visual ? 'REPLAY' : '過去の記録'} ${description}`);
}

function clearReplayTimers(): void {
  if (replayTimer !== undefined) window.clearTimeout(replayTimer);
  replayTimer = undefined;
  if (replayTimeoutTimer !== undefined) window.clearTimeout(replayTimeoutTimer);
  replayTimeoutTimer = undefined;
}

function stopReplay(message?: string): void {
  replayController?.abort();
  replayController = undefined;
  clearReplayTimers();
  replayState = null;
  renderReplayControls();
  if (!mapManualOverride && !activeEew && !currentShakeDetection) resetMapView();
  selectedReplayStart.disabled = !store.recent.some((quake) => quake.id === selectedEarthquakeId && isReplayEligible(quake));
  if (message) {
    replayMessage.hidden = false;
    replayMessage.textContent = message;
  }
}

function clearReplayTick(): void {
  if (replayTimer !== undefined) window.clearTimeout(replayTimer);
  replayTimer = undefined;
}

/** Advance the virtual clock from a monotonic browser clock, then change the map only at recorded timestamps. */
function advanceReplayClock(replay: ReplayState): void {
  if (!replay.playing || replay.lastTickAt === null) return;
  const now = performance.now();
  replay.elapsedMs = Math.min(replay.durationMs, replay.elapsedMs + Math.max(0, now - replay.lastTickAt) * replay.speed);
  replay.lastTickAt = now;
  let nextIndex = replay.index;
  while (nextIndex + 1 < replay.frames.length && replay.frames[nextIndex + 1]!.at - replay.frames[0]!.at <= replay.elapsedMs) nextIndex++;
  if (nextIndex !== replay.index) {
    const previousIndex = replay.index;
    replay.index = nextIndex;
    for (let index = previousIndex + 1; index <= nextIndex; index += 1) {
      const frame = replay.frames[index];
      if (frame) updateReplayStateFromFrame(frame, replay);
    }
    renderReplayMapState(replay, replay.frames[nextIndex]!);
    renderReplayControls();
  } else {
    renderReplayClock(replay);
  }
  if (replay.elapsedMs >= replay.durationMs) {
    replay.playing = false;
    replay.lastTickAt = null;
    renderReplayControls();
    replayMessage.hidden = false;
    replayMessage.textContent = replayEndReason(replay);
  }
}

function scheduleReplayTick(): void {
  const replay = replayState;
  if (!replay?.playing || replayTimer !== undefined) return;
  const nextFrameAt = replay.frames[replay.index + 1]?.at;
  const nextFrameElapsed = nextFrameAt === undefined ? replay.durationMs : nextFrameAt - replay.frames[0]!.at;
  const nextSecondElapsed = (Math.floor(replay.elapsedMs / 1_000) + 1) * 1_000;
  const nextElapsed = Math.min(replay.durationMs, nextFrameElapsed, nextSecondElapsed);
  const delay = Math.max(1, (nextElapsed - replay.elapsedMs) / replay.speed);
  replayTimer = window.setTimeout(() => {
    replayTimer = undefined;
    if (replayState !== replay || !replay.playing) return;
    advanceReplayClock(replay);
    scheduleReplayTick();
  }, delay);
}

async function startReplayForSelected(testKind?: 'eew' | 'shake' | 'none' | 'shake-silence' | 'eew-cancel' | 'mixed' | 'late-quake' | 'unrelated'): Promise<void> {
  if (replayController || replayState) return;
  const target = store.recent.find((quake) => quake.id === selectedEarthquakeId);
  if (!target) {
    replayMessage.hidden = false;
    replayMessage.textContent = '先に地震履歴から地震を選択してください';
    return;
  }
  if (!isReplayEligible(target)) {
    replayMessage.hidden = false;
    replayMessage.textContent = 'この地震は発生から3時間を超えているため再生できません';
    return;
  }
  replayMessage.hidden = true;
  selectedReplayStart.disabled = true;
  let payloads: unknown[];
  let historyMayBeTruncated = false;

  if (isTestMode) {
    if (!testFixtures) payloads = [];
    else if (testKind === 'none' || target.id === testNoReplayTargetId) payloads = [testFixtures.createTestReplayQuake(target)];
    else if (testKind === 'eew') payloads = testFixtures.createTestReplayEewReports(target);
    else if (testKind === 'shake') payloads = testFixtures.createTestReplayShakeReports(target, nearestAreaCodes(target));
    else if (testKind === 'shake-silence') payloads = testFixtures.createTestReplayShakeSilenceReports(target, nearestAreaCodes(target));
    else if (testKind === 'eew-cancel') payloads = testFixtures.createTestReplayEewWithCancellation(target);
    else if (testKind === 'mixed') payloads = testFixtures.createTestReplayMixedReports(target, nearestAreaCodes(target));
    else if (testKind === 'late-quake') payloads = [...testFixtures.createTestReplayShakeReports(target, nearestAreaCodes(target)), testFixtures.createTestReplayQuake(target)];
    else if (testKind === 'unrelated') payloads = testFixtures.createTestReplayUnrelatedEvents(target, nearestAreaCodes(target));
    else payloads = [
      testFixtures.createTestReplayQuake(target),
      ...testFixtures.createTestReplayEewReports(target),
      ...testFixtures.createTestReplayShakeReports(target, nearestAreaCodes(target)),
    ];
  } else {
    const controller = new AbortController();
    replayController = controller;
    replayTimeoutTimer = window.setTimeout(() => controller.abort(new DOMException('Replay request timed out', 'TimeoutError')), 12_000);
    liveDiagnostics.lastHttpAt = Date.now();
    renderLiveDiagnostics();
    try {
      const history = await fetchReplayHistory(controller.signal);
      liveDiagnostics.httpSuccesses += 1;
      liveDiagnostics.lastHttpAt = Date.now();
      addLiveDiagnostic(`HTTP再生履歴: 成功・${history.records.length}件${history.mayBeTruncated ? '・上限到達の可能性' : ''}`);
      payloads = history.records;
      historyMayBeTruncated = history.mayBeTruncated;
    } catch (error) {
      liveDiagnostics.httpFailures += 1;
      liveDiagnostics.lastHttpAt = Date.now();
      addLiveDiagnostic(`HTTP再生履歴: 失敗・${error instanceof Error ? error.message : '通信エラー'}`);
      if (controller.signal.aborted && replayController !== controller) return;
      if (controller.signal.aborted && disposed) return;
      const message = error instanceof Error ? error.message : '通信に失敗しました';
      replayMessage.hidden = false;
      replayMessage.textContent = controller.signal.aborted ? '過去データの取得がタイムアウトしました' : `${message}。リプレイを中断しました`;
      selectedReplayStart.disabled = false;
      return;
    } finally {
      renderLiveDiagnostics();
      if (replayTimeoutTimer !== undefined) window.clearTimeout(replayTimeoutTimer);
      replayTimeoutTimer = undefined;
      if (replayController === controller) replayController = undefined;
    }
  }

  if (disposed) return;
  const counts = countReplayRecords(payloads);
  const frames = buildReplayFrames(payloads, target, epspAreas);
  if (frames.length === 0) {
    replayMessage.hidden = false;
    replayMessage.textContent = 'この地震の再生データはありません';
    selectedReplayStart.disabled = false;
    if (isTestMode) addTestLog('replay: matching fixture records not found');
    return;
  }

  const visual = hasVisualReplay(frames);
  const startAt = frames[0]!.at;
  replayState = { target, frames, counts, visual, index: 0, playing: visual, speed: 1,
    elapsedMs: 0, startAt, originAt: parseP2pTimestamp(target.time),
    durationMs: Math.max(0, frames[frames.length - 1]!.at - startAt), lastTickAt: visual ? performance.now() : null,
    activeQuake: null, activeEew: null, activeShake: null, eewSeen: false, shakeSeen: false,
    eewCancelled: false, shakeNotDetected: false, historyMayBeTruncated };
  const points = [projectEpicenter(target), ...frames.flatMap((frame) => frame.kind === 'shake'
    ? frame.areas.map(({ area }) => projectCoordinates(area.latitude, area.longitude))
    : frame.kind === 'eew' && frame.eew.earthquake?.hypocenter.latitude != null && frame.eew.earthquake.hypocenter.longitude != null
      ? [projectCoordinates(frame.eew.earthquake.hypocenter.latitude, frame.eew.earthquake.hypocenter.longitude)]
      : [])].filter((point): point is { x: number; y: number } => point !== null);
  if (points.length > 0) focusMapOnPoints(points, 75, 210);
  renderReplayFrame(frames[0]!);
  renderReplayControls();
  replayMessage.hidden = visual;
  if (!visual) replayMessage.textContent = frames.some((item) => item.kind !== 'quake')
    ? '視覚的な変化を示す複数の記録がないため、取得できた記録を静的に表示します。'
    : 'この地震は発表情報のみ確認できます。揺れの変化を再生するための記録はありません。';
  if (isTestMode) addTestLog(`${visual ? 'visual replay' : 'static publications'}: 551 ${counts.quake}, 556 ${counts.eew}, 9611 ${counts.shake}, drawable ${frames.length}`);
  if (visual) scheduleReplayTick();
}

function nearestAreaCodes(target: Earthquake): string[] {
  if (target.latitude === null || target.longitude === null) return ['240', '241', '205'];
  return [...epspAreas].sort((left, right) => {
    const distance = (area: EpspArea): number => Math.hypot(
      target.latitude! - area.latitude,
      (target.longitude! - area.longitude) * Math.cos(target.latitude! * Math.PI / 180),
    );
    return distance(left) - distance(right);
  }).slice(0, 3).map((area) => area.code);
}

function intensityClass(scale: number | null): string {
  if (scale !== null && scale >= 55) return 'intensity-severe';
  if (scale !== null && scale >= 40) return 'intensity-strong';
  if (scale !== null && scale >= 30) return 'intensity-moderate';
  return 'intensity-light';
}

function renderMarkers(earthquakes: readonly Earthquake[], _animateLatest = false): void {
  if (selectedEarthquakeId && !earthquakes.some((quake) => quake.id === selectedEarthquakeId)) selectedEarthquakeId = null;
  const keepEewPriority = (): void => {
    if (activeEew) updateEewMapStatus(activeEew);
  };
  selectedEarthquakeMarker.replaceChildren();
  const selected = earthquakes.find((quake) => quake.id === selectedEarthquakeId);
  if (!selected) {
    japanMap.setAttribute('aria-label', '日本地図。履歴から地震を選択すると震源位置を表示します');
    keepEewPriority();
    return;
  }

  const selectedPoint = projectEpicenter(selected);
  if (!selectedPoint) {
    const hasCoordinates = selected.latitude !== null && selected.longitude !== null;
    japanMap.setAttribute('aria-label', hasCoordinates
      ? `日本地図。選択中の${selected.hypocenter}は表示範囲外です`
      : `日本地図。選択中の${selected.hypocenter}の震源座標を取得できません`);
    keepEewPriority();
    return;
  }
  const marker = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  marker.setAttribute('class', `epicenter-marker ${intensityClass(selected.maxScale)} is-selected`);
  marker.setAttribute('transform', `translate(${selectedPoint.x} ${selectedPoint.y})`);
  marker.setAttribute('role', 'img');
  marker.setAttribute('aria-label', `${selected.hypocenter}、震度${scaleLabel(selected.maxScale)}、選択中`);

  const radius = 5 + Math.min(7, (selected.maxScale ?? 10) / 10) * 0.35;
  const halo = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  halo.setAttribute('class', 'marker-halo');
  halo.setAttribute('r', String(radius + 6));
  marker.append(halo);
  const ring = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  ring.setAttribute('class', 'marker-ring');
  ring.setAttribute('r', String(radius + 3));
  marker.append(ring);
  const core = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  core.setAttribute('class', 'marker-core');
  core.setAttribute('r', String(radius));
  marker.append(core);
  const center = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  center.setAttribute('class', 'marker-center');
  center.setAttribute('r', '1.7');
  marker.append(center);
  selectedEarthquakeMarker.append(marker);
  japanMap.setAttribute('aria-label', `日本地図。${selected.hypocenter}の震源を選択表示中`);
  keepEewPriority();
}

function renderAll(animateLatest = false): void {
  renderLatest(store.recent[0]);
  renderMarkers(store.recent, animateLatest);
  renderList(store.recent);
  renderSelectedQuakeActions();
  hasLoaded = true;
  document.querySelector('#refresh-error')?.remove();
}

function mergeEarthquakeHistory(earthquakes: readonly Earthquake[], browserReceivedAt: number, animateLatest = false): EarthquakeMergeResult {
  rememberHistoryReceiveTimings(earthquakes, browserReceivedAt);
  const result = store.merge(earthquakes);
  if (result.changed || !hasLoaded) renderAll(animateLatest);
  hasLoaded = true;
  updateReceiveAgeDisplays();
  return result;
}

function setConnectionState(state: 'live' | 'reconnecting' | 'offline'): void {
  connectionStatus.classList.remove('is-live', 'is-reconnecting', 'is-offline');
  connectionStatus.classList.add(`is-${state}`);
  connectionLabel.textContent = state === 'live' ? 'LIVE' : state === 'reconnecting' ? 'RECONNECTING' : 'OFFLINE';
  const description = state === 'live' ? 'WebSocket接続中' : state === 'reconnecting' ? 'WebSocket再接続中' : 'WebSocket未接続';
  connectionDescription.textContent = description;
  connectionStatus.title = description;
  monitorConnection.textContent = state === 'live' ? 'LIVE' : state === 'reconnecting' ? 'RECONNECTING' : 'OFFLINE';
  renderLiveDiagnostics();
}

function flushMapDrag(): void {
  if (!mapDragState) return;
  const delta = viewBoxDeltaFromPixels(mapDragState.pendingClientX, mapDragState.pendingClientY);
  mapDragState.pendingClientX = 0;
  mapDragState.pendingClientY = 0;
  if (delta.x === 0 && delta.y === 0) return;
  const current = readMapViewBox();
  setMapViewBox({ x: current.x - delta.x, y: current.y - delta.y, width: current.width, height: current.height });
}

function scheduleMapDragFrame(): void {
  if (mapDragFrame !== undefined) return;
  mapDragFrame = window.requestAnimationFrame(() => {
    mapDragFrame = undefined;
    flushMapDrag();
  });
}

function finishMapDrag(event?: PointerEvent): void {
  const state = mapDragState;
  if (!state || (event && event.pointerId !== state.pointerId)) return;
  if (mapDragFrame !== undefined) {
    window.cancelAnimationFrame(mapDragFrame);
    mapDragFrame = undefined;
  }
  flushMapDrag();
  try {
    if (japanMap.hasPointerCapture(state.pointerId)) japanMap.releasePointerCapture(state.pointerId);
  } catch {
    // Pointer capture can already be released by the browser on cancellation.
  }
  mapDragState = null;
  japanMap.classList.remove('is-dragging');
}

function handleMapPointerDown(event: PointerEvent): void {
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  if (mapDragState) return;
  mapDragState = {
    pointerId: event.pointerId,
    lastClientX: event.clientX,
    lastClientY: event.clientY,
    pendingClientX: 0,
    pendingClientY: 0,
    moved: false,
  };
  japanMap.classList.add('is-dragging');
  event.preventDefault();
  try {
    japanMap.setPointerCapture(event.pointerId);
  } catch {
    // Pointer capture is optional; pointer events still work without it.
  }
}

function handleMapPointerMove(event: PointerEvent): void {
  const state = mapDragState;
  if (!state || event.pointerId !== state.pointerId) return;
  const deltaX = event.clientX - state.lastClientX;
  const deltaY = event.clientY - state.lastClientY;
  state.lastClientX = event.clientX;
  state.lastClientY = event.clientY;
  state.pendingClientX += deltaX;
  state.pendingClientY += deltaY;
  if (!state.moved && Math.hypot(state.pendingClientX, state.pendingClientY) >= 2) {
    state.moved = true;
    markMapUserInteraction();
  }
  if (!state.moved) return;
  event.preventDefault();
  scheduleMapDragFrame();
}

mapZoomIn.addEventListener('click', () => zoomMapByFactor(1 / MAP_ZOOM_FACTOR), { signal: lifecycle.signal });
mapZoomOut.addEventListener('click', () => zoomMapByFactor(MAP_ZOOM_FACTOR), { signal: lifecycle.signal });
mapReset.addEventListener('click', resetMapToNation, { signal: lifecycle.signal });
informationPanelToggle.addEventListener('click', () => {
  panelPreference = informationPanelToggle.getAttribute('aria-expanded') !== 'true';
  syncInformationPanelToggle();
}, { signal: lifecycle.signal });
compactPanelMedia.addEventListener('change', () => {
  if (panelPreference === null) syncInformationPanelToggle();
}, { signal: lifecycle.signal });
compactMapMedia.addEventListener('change', () => {
  if (mapManualOverride || activeEew || currentShakeDetection || selectedEarthquakeId) return;
  if (isNationViewBox(readMapViewBox())) resetMapView();
}, { signal: lifecycle.signal });
japanMap.addEventListener('pointerdown', handleMapPointerDown, { signal: lifecycle.signal });
japanMap.addEventListener('pointermove', handleMapPointerMove, { signal: lifecycle.signal });
japanMap.addEventListener('pointerup', finishMapDrag, { signal: lifecycle.signal });
japanMap.addEventListener('pointercancel', finishMapDrag, { signal: lifecycle.signal });
japanMap.addEventListener('wheel', (event) => {
  event.preventDefault();
  zoomMapByFactor(event.deltaY < 0 ? 1 / MAP_ZOOM_FACTOR : MAP_ZOOM_FACTOR, event.clientX, event.clientY);
}, { passive: false, signal: lifecycle.signal });

async function enableAudioFromGesture(allowSandbox = false): Promise<boolean> {
  const ready = await audioNotifier.activateFromGesture(allowSandbox);
  updateAudioUi();
  return ready;
}

function requestTestAudio(cue: AudioCue): void {
  void audioNotifier.playTestCue(cue)
    .then((result) => {
      updateAudioUi();
      reportTestAudio(cue, result);
    })
    .catch(() => {
      updateAudioUi();
      reportTestAudio(cue, 'unavailable');
    });
}

applySettings();
syncInformationPanelToggle();
resetMapView();

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

eewToggle.addEventListener('change', () => {
  settings = { ...settings, eewEnabled: eewToggle.checked };
  applySettings();
}, { signal: lifecycle.signal });

eewAutoFocusToggle.addEventListener('change', () => {
  settings = { ...settings, eewAutoFocusEnabled: eewAutoFocusToggle.checked };
  applySettings();
}, { signal: lifecycle.signal });

audioNotificationsToggle.addEventListener('change', () => {
  settings = { ...settings, audioNotificationsEnabled: audioNotificationsToggle.checked };
  applySettings();
  if (audioNotificationsToggle.checked && !isEewSandbox) void enableAudioFromGesture();
}, { signal: lifecycle.signal });

eewAudioToggle.addEventListener('change', () => {
  settings = { ...settings, eewAudioEnabled: eewAudioToggle.checked };
  applySettings();
}, { signal: lifecycle.signal });

shakeAudioToggle.addEventListener('change', () => {
  settings = { ...settings, shakeAudioEnabled: shakeAudioToggle.checked };
  applySettings();
}, { signal: lifecycle.signal });

earthquakeAudioToggle.addEventListener('change', () => {
  settings = { ...settings, earthquakeAudioEnabled: earthquakeAudioToggle.checked };
  applySettings();
}, { signal: lifecycle.signal });

audioVolume.addEventListener('input', () => {
  const value = Number(audioVolume.value);
  settings = { ...settings, audioVolume: Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : DEFAULT_SETTINGS.audioVolume };
  applySettings();
}, { signal: lifecycle.signal });

audioEnableButton.addEventListener('click', () => {
  void enableAudioFromGesture(isEewSandbox);
}, { signal: lifecycle.signal });

audioTestEarthquake.addEventListener('click', () => requestTestAudio('earthquake'), { signal: lifecycle.signal });
audioTestShake.addEventListener('click', () => requestTestAudio('shake'), { signal: lifecycle.signal });
audioTestEew.addEventListener('click', () => requestTestAudio('eew'), { signal: lifecycle.signal });

function setTestPanelOpen(open: boolean): void {
  if (!testPanel || !testPanelToggle) return;
  testPanel.hidden = !open;
  testPanelToggle.setAttribute('aria-expanded', String(open));
  testPanelToggle.textContent = open ? 'TEST PANELを閉じる' : 'TEST PANEL';
  if (open) testPanelClose?.focus();
}

testPanelToggle?.addEventListener('click', () => {
  setTestPanelOpen(testPanel?.hidden ?? true);
}, { signal: lifecycle.signal });

testPanelClose?.addEventListener('click', () => {
  setTestPanelOpen(false);
  testPanelToggle?.focus();
}, { signal: lifecycle.signal });

testPanel?.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    setTestPanelOpen(false);
    testPanelToggle?.focus();
  }
}, { signal: lifecycle.signal });

const testConnectionAdapter = {
  setState(state: 'live' | 'reconnecting' | 'offline'): void {
    setConnectionState(state);
    addTestLog(`connection state: ${state.toUpperCase()}`);
  },
};

function setTestControlsEnabled(enabled: boolean): void {
  testPanel?.querySelectorAll<HTMLButtonElement>('[data-test-action]').forEach((button) => {
    button.disabled = !enabled;
  });
}

function resetTestState(): void {
  stopReplay();
  testEarthquakeSequence = 0;
  testBackfillSequence = 0;
  testNoReplayTargetId = null;
  audioNotifier.clearPending();
  earthquakeReceiveTimings.clear();
  earthquakeReceiveTimingOrder.length = 0;
  lastWebSocketReceivedAt = null;
  selectedEarthquakeId = null;
  replayMessage.hidden = true;
  connectionEstablished = false;
  reconnectAttempt = 0;
  mapManualOverride = false;
  suppressedEewEventId = null;
  suppressedShakeEventId = null;
  store.clear();
  clearShakeDetection();
  clearEewState();
  resetMapView();
  renderAll();
  setConnectionState('offline');
  clearTestLogs();
  addTestLog('全状態リセット');
}

function runTestAction(action: string): void {
  if (!isTestMode || !testFixtures) return;

  switch (action) {
    case 'mock-websocket-flow': {
      const mockSocket = new MockWebSocketAdapter();
      mockSocket.onmessage = (event) => processWebSocketFrame(event.data, 'test', Date.now());
      const mockFrames = [
        testFixtures.createTestEarthquake(++testEarthquakeSequence),
        testFixtures.createTestAreaPeers(),
        testFixtures.createTestUserquake(250),
        testFixtures.createTestShakeStart(),
        testFixtures.createTestEewReport1(),
      ];
      for (const frame of mockFrames) mockSocket.emit(frame);
      addTestLog(`WebSocket mock統合確認: 551 event ${store.recent.length}件 / 561 raw map ${rawShakeMarkers.childElementCount} / 9611 A/B map ${shakeDetectionMarkers.childElementCount} / 556 ${eewDetails.hidden ? '未表示' : '表示'}`);
      break;
    }
    case 'quake':
      testEarthquakeSequence += 1;
      handleIncomingPayload(testFixtures.createTestEarthquake(testEarthquakeSequence), 'test');
      break;
    case 'intensity-palette':
      resetTestState();
      for (const fixture of testFixtures.createTestIntensityPalette()) handleIncomingPayload(fixture, 'test');
      addTestLog('震度1〜7・不明の配色fixtureを表示');
      break;
    case 'history-backfill': {
      testBackfillSequence += 1;
      const earthquake = parseEarthquake(testFixtures.createTestHistoryBackfill(testBackfillSequence));
      if (earthquake) {
        const result = mergeEarthquakeHistory([earthquake], Date.now());
        addTestLog(result.changed
          ? `HTTP history fixture merged: ${earthquake.reportId}`
          : `HTTP history fixture duplicate: ${earthquake.reportId}`);
      }
      break;
    }
    case 'event-scale-prompt':
      handleIncomingPayload(testFixtures.createTestEventScalePrompt(), 'test');
      break;
    case 'event-destination':
      handleIncomingPayload(testFixtures.createTestEventDestination(), 'test');
      break;
    case 'event-detail-scale':
      handleIncomingPayload(testFixtures.createTestEventDetailScale(), 'test');
      break;
    case 'event-corrected-scale':
      handleIncomingPayload(testFixtures.createTestEventCorrectedScale(), 'test');
      break;
    case 'event-old-report':
      handleIncomingPayload(testFixtures.createTestEventOldScalePrompt(), 'test');
      break;
    case 'event-duplicate':
      handleIncomingPayload(testFixtures.createTestEventDuplicateScalePrompt(), 'test');
      break;
    case 'event-separate':
      handleIncomingPayload(testFixtures.createTestSeparateEarthquake(), 'test');
      break;
    case 'event-same-time-distant':
      // First give the existing event a concrete epicenter, then inject the
      // same origin time with a far-away source to exercise the split guard.
      handleIncomingPayload(testFixtures.createTestEventDestination(), 'test');
      handleIncomingPayload(testFixtures.createTestSameTimeDifferentSource(), 'test');
      break;
    case 'shake-start':
      handleIncomingPayload(testFixtures.createTestShakeStart(), 'test');
      break;
    case 'shake-update':
      handleIncomingPayload(testFixtures.createTestShakeUpdate(), 'test');
      break;
    case 'shake-end':
      handleIncomingPayload(testFixtures.createTestShakeEnd(), 'test');
      break;
    case '561-tokyo':
      handleIncomingPayload(testFixtures.createTestUserquake(250), 'test');
      break;
    case '561-kanagawa':
      handleIncomingPayload(testFixtures.createTestUserquake(270), 'test');
      break;
    case '561-chiba':
      handleIncomingPayload(testFixtures.createTestUserquake(241), 'test');
      break;
    case 'eew-1':
      handleIncomingPayload(testFixtures.createTestEewReport1(), 'test');
      break;
    case 'eew-2':
      handleIncomingPayload(testFixtures.createTestEewReport2(), 'test');
      break;
    case 'eew-3':
      handleIncomingPayload(testFixtures.createTestEewReport3(), 'test');
      break;
    case 'eew-old':
      handleIncomingPayload(testFixtures.createTestEewOldReport1(), 'test');
      break;
    case 'eew-missing':
      handleIncomingPayload(testFixtures.createTestEewMissingEarthquake(), 'test');
      break;
    case 'eew-cancel':
      handleIncomingPayload(testFixtures.createTestEewCancelled(), 'test');
      break;
    case 'replay-eew':
      void startReplayForSelected('eew');
      break;
    case 'replay-shake':
      void startReplayForSelected('shake');
      break;
    case 'replay-shake-silence':
      void startReplayForSelected('shake-silence');
      break;
    case 'replay-eew-cancel':
      void startReplayForSelected('eew-cancel');
      break;
    case 'replay-mixed':
      void startReplayForSelected('mixed');
      break;
    case 'replay-late-quake':
      void startReplayForSelected('late-quake');
      break;
    case 'replay-unrelated':
      void startReplayForSelected('unrelated');
      break;
    case 'replay-no-termination':
      void startReplayForSelected('shake');
      break;
    case 'replay-no-data': {
      handleIncomingPayload(testFixtures.createTestNoReplayEarthquake(), 'test');
      const latest = store.recent[0];
      if (latest) {
        testNoReplayTargetId = latest.id;
        selectEarthquakeById(latest.id);
      }
      addTestLog('selected synthetic quake with no replay records');
      break;
    }
    case 'replay-live-priority': {
      if (!replayState && !replayController) void startReplayForSelected('eew');
      handleIncomingPayload(testFixtures.createTestEewReport1(), 'test-priority');
      addTestLog('live EEW fixture preempted replay');
      break;
    }
    case 'connection-live':
      testConnectionAdapter.setState('live');
      break;
    case 'connection-reconnecting':
      testConnectionAdapter.setState('reconnecting');
      break;
    case 'connection-offline':
      testConnectionAdapter.setState('offline');
      break;
    case 'reset':
      resetTestState();
      break;
    default:
      break;
  }
}

testPanel?.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest<HTMLButtonElement>('[data-test-action]');
  if (button?.dataset.testAction) runTestAction(button.dataset.testAction);
}, { signal: lifecycle.signal });

function selectEarthquakeById(id: string): void {
  const selected = store.recent.find((quake) => quake.id === id);
  if (!selected) return;
  if (selectedEarthquakeId !== id) stopReplay();
  replayMessage.hidden = true;
  selectedEarthquakeId = id;
  renderMarkers(store.recent);
  renderList(store.recent);
  renderSelectedQuakeActions();
  const point = projectEpicenter(selected);
  if (point) {
    markMapUserInteraction();
    focusMapOnPoints([point], 145, 260);
  }
}

list.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const row = target.closest<HTMLButtonElement>('[data-earthquake-id]');
  const id = row?.dataset.earthquakeId;
  if (id) selectEarthquakeById(id);
}, { signal: lifecycle.signal });

selectedReplayStart.addEventListener('click', () => void startReplayForSelected(), { signal: lifecycle.signal });
replayPlayToggle.addEventListener('click', () => {
  if (!replayState?.visual) return;
  const replay = replayState;
  if (replay.playing) {
    advanceReplayClock(replay);
    replay.playing = false;
    replay.lastTickAt = null;
    clearReplayTick();
  } else {
    if (replay.elapsedMs >= replay.durationMs) {
      replay.index = 0;
      replay.elapsedMs = 0;
      rebuildReplayState(replay, 0);
    }
    replay.playing = true;
    replay.lastTickAt = performance.now();
    replayMessage.hidden = true;
  }
  renderReplayControls();
  scheduleReplayTick();
}, { signal: lifecycle.signal });
replayRestart.addEventListener('click', () => {
  if (!replayState?.visual) return;
  clearReplayTick();
  replayState.index = 0;
  replayState.elapsedMs = 0;
  replayState.playing = true;
  replayState.lastTickAt = performance.now();
  replayMessage.hidden = true;
  rebuildReplayState(replayState, 0);
  renderReplayControls();
  scheduleReplayTick();
}, { signal: lifecycle.signal });
function stepReplay(direction: -1 | 1): void {
  if (!replayState) return;
  clearReplayTick();
  replayState.playing = false;
  replayState.lastTickAt = null;
  replayState.index = Math.max(0, Math.min(replayState.frames.length - 1, replayState.index + direction));
  replayState.elapsedMs = replayState.frames[replayState.index]!.at - replayState.frames[0]!.at;
  replayMessage.hidden = true;
  rebuildReplayState(replayState, replayState.index);
  renderReplayControls();
}
replayPrevious.addEventListener('click', () => stepReplay(-1), { signal: lifecycle.signal });
replayNext.addEventListener('click', () => stepReplay(1), { signal: lifecycle.signal });
replaySpeedToggle.addEventListener('click', () => {
  if (!replayState?.visual) return;
  advanceReplayClock(replayState);
  replayState.speed = replayState.speed === 1 ? 4 : 1;
  clearReplayTick();
  renderReplayControls();
  scheduleReplayTick();
}, { signal: lifecycle.signal });
replayLiveReturn.addEventListener('click', () => {
  stopReplay('LIVE監視へ戻りました');
  renderSelectedQuakeActions();
}, { signal: lifecycle.signal });

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

type HistorySyncReason = 'startup' | 'retry' | 'reconnect' | 'periodic' | 'resume' | 'online';

async function loadHistory(reason: HistorySyncReason): Promise<void> {
  // TEST MODE is completely offline. Keep this guard at the HTTP boundary so
  // future callers cannot accidentally fetch production history.
  if (isTestMode || disposed) return;
  if (historyRequestInFlight) {
    // Timer ticks are intentionally dropped while any request is in flight.
    // Lifecycle/reconnect triggers are coalesced into one follow-up request.
    if (reason !== 'periodic') queuedHistorySync = true;
    return;
  }

  historyRequestInFlight = true;
  liveDiagnostics.lastHttpAt = Date.now();
  renderLiveDiagnostics();
  const controller = new AbortController();
  historyController = controller;
  try {
    do {
      queuedHistorySync = false;
      try {
        const earthquakes = await fetchRecentEarthquakes(controller.signal);
        const browserReceivedAt = Date.now();
        if (disposed) return;
        liveDiagnostics.httpSuccesses += 1;
        liveDiagnostics.lastHttpAt = browserReceivedAt;
        addLiveDiagnostic(`HTTP履歴 ${reason}: 成功・551 ${earthquakes.length}発表を解析`);
        mergeEarthquakeHistory(earthquakes, browserReceivedAt);
        lastHistorySyncSucceededAt = browserReceivedAt;
        updateReceiveAgeDisplays();
        document.querySelector('#refresh-error')?.remove();
      } catch (error) {
        if (disposed || (error instanceof DOMException && error.name === 'AbortError')) return;
        const message = error instanceof Error ? error.message : '通信に失敗しました';
        liveDiagnostics.httpFailures += 1;
        liveDiagnostics.lastHttpAt = Date.now();
        addLiveDiagnostic(`HTTP履歴 ${reason}: 失敗・${message}`);
        if (!hasLoaded && reason !== 'periodic') {
          latestLoading.hidden = false;
          latestLoading.innerHTML = `<div class="error-state"><strong>情報を取得できませんでした</strong><span>${escapeHtml(message)}</span><button id="retry-button" class="retry-button" type="button">再試行</button></div>`;
          list.innerHTML = '<div class="empty-state">通信が回復すると地震情報を表示します</div>';
          document.querySelector<HTMLButtonElement>('#retry-button')?.addEventListener('click', () => void loadHistory('retry'), { once: true, signal: lifecycle.signal });
        } else if (hasLoaded && reason !== 'periodic') {
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
      renderLiveDiagnostics();
    } while (queuedHistorySync && !disposed);
  } finally {
    historyRequestInFlight = false;
    historyController = undefined;
  }
}

function startHistorySyncTimer(): void {
  if (isTestMode || disposed || historySyncTimer !== undefined) return;
  historySyncTimer = window.setInterval(() => void loadHistory('periodic'), HISTORY_SYNC_INTERVAL_MS);
}

function requestHistoryOnResume(): void {
  if (isTestMode || disposed || document.visibilityState !== 'visible') return;
  void loadHistory('resume');
}

document.addEventListener('visibilitychange', () => {
  requestHistoryOnResume();
  if (document.visibilityState === 'visible') ensureProductionSocket();
}, { signal: lifecycle.signal });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden || !replayState?.playing) return;
  advanceReplayClock(replayState);
  replayState.playing = false;
  replayState.lastTickAt = null;
  clearReplayTick();
  renderReplayControls();
}, { signal: lifecycle.signal });
window.addEventListener('online', () => {
  if (!isTestMode && !disposed) {
    void loadHistory('online');
    ensureProductionSocket();
  }
}, { signal: lifecycle.signal });

type IncomingPayloadSource = 'websocket' | 'test' | 'test-priority';

class MockWebSocketAdapter {
  onmessage: ((event: { data: string }) => void) | null = null;

  emit(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

function processWebSocketFrame(data: unknown, source: IncomingPayloadSource, browserReceivedAt: number): void {
  if (typeof data !== 'string') {
    if (source === 'websocket') {
      liveDiagnostics.messages += 1;
      liveDiagnostics.lastMessageAt = browserReceivedAt;
      liveDiagnostics.jsonFailures += 1;
      addLiveDiagnostic('JSON解析失敗: テキスト以外のWebSocketフレーム');
      renderLiveDiagnostics();
    }
    return;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    if (source === 'websocket') {
      countLiveDiagnosticMessage(null);
      liveDiagnostics.jsonFailures += 1;
      addLiveDiagnostic('JSON解析失敗: 内容は記録していません');
      renderLiveDiagnostics();
    }
    return;
  }
  if (source === 'websocket') countLiveDiagnosticMessage(incomingCode(payload));
  handleIncomingPayload(payload, source, browserReceivedAt);
}

function handleIncomingPayload(payload: unknown, source: IncomingPayloadSource = 'websocket', browserReceivedAt = Date.now()): void {
  lastWebSocketReceivedAt = browserReceivedAt;
  const code = incomingCode(payload) ?? 'other';
  const parsedEew = parseEew(payload);
  if (parsedEew) {
    if (replayState || replayController) {
      stopReplay('LIVEのEEW情報を優先して過去データの再生を終了しました');
    }
    const receiveTiming = createReceiveTiming(payload, browserReceivedAt, parsedEew.issue.time);
    const result = updateEew(parsedEew, receiveTiming);
    reportLiveProcessing('556', `${result}${result === 'new' || result === 'updated' ? `・画面反映、serial ${parsedEew.issue.serial}` : result === 'cancelled' ? '・取消を画面反映' : '・表示状態変更なし'}`, browserReceivedAt, parsedEew.issue.time, '発表→受信', true, result === 'new' || result === 'updated' || result === 'cancelled');
    if (result === 'new' && settings.eewAudioEnabled) notifyAudio('eew');
    if (result === 'cancelled' && settings.eewAudioEnabled) notifyAudio('cancel');
    if (source === 'test') {
      if (result !== 'disabled') addTestTimingLog(`556 serial ${parsedEew.issue.serial}`, receiveTiming);
      if (result === 'ignored-old') addTestLog(`ignored old serial ${parsedEew.issue.serial} (eventId ${parsedEew.issue.eventId})`);
      else if (result === 'duplicate') {
        addTestLog(`duplicate EEW id ${parsedEew.id}`);
        addTestLog('audio suppressed: duplicate/update');
      }
      else if (result === 'cancelled') addTestLog(`EEW cancelled (eventId ${parsedEew.issue.eventId})`);
      else if (result === 'ignored-cancelled') addTestLog(`ignored cancelled EEW (eventId ${parsedEew.issue.eventId})`);
      else if (result === 'disabled') addTestLog('EEW display is OFF; payload ignored');
      else if (result === 'updated') {
        addTestLog(`EEW eventId ${parsedEew.issue.eventId} serial ${parsedEew.issue.serial}`);
        addTestLog('audio suppressed: EEW update');
      }
      else addTestLog(`EEW eventId ${parsedEew.issue.eventId} serial ${parsedEew.issue.serial}`);
    }
    updateReceiveAgeDisplays();
    return;
  }

  // 554 only signals that an EEW publication was detected. It is not an EEW payload.
  const parsedEewDetection = parseEewDetection(payload);
  if (parsedEewDetection) {
    reportLiveProcessing('554', '解析成功・発表検出のみ（EEW表示なし）', browserReceivedAt, parsedEewDetection.time, 'P2P受信時刻→Browser');
    if (source === 'test') addTestLog('554 EEW publication detected (display not started)');
    updateReceiveAgeDisplays();
    return;
  }

  const parsedAreaPeers = parseAreaPeers(payload);
  if (parsedAreaPeers) {
    const matchedAreas = parsedAreaPeers.areas.filter(({ id }) => areaByCode.has(String(id))).length;
    reportLiveProcessing('555', `解析成功・接続ピア地域 ${parsedAreaPeers.areas.length}件、地域コード照合 ${matchedAreas}/${parsedAreaPeers.areas.length}・地震監視画面の対象外`, browserReceivedAt, parsedAreaPeers.time, 'P2P受信時刻→Browser');
    if (source === 'test') addTestLog(`555 peer distribution parsed: ${matchedAreas}/${parsedAreaPeers.areas.length} area codes matched; no earthquake map layer`);
    return;
  }

  const parsedShakeDetection = parseShakeDetection(payload);
  if (parsedShakeDetection) {
    if ((parsedShakeDetection.count > 0 && parsedShakeDetection.confidence > 0) && (replayState || replayController)) {
      stopReplay('LIVEの揺れ解析情報を優先して過去データの再生を終了しました');
    }
    const receiveTiming = createReceiveTiming(payload, browserReceivedAt, parsedShakeDetection.updatedAt);
    const shakeResult = updateShakeDetection(parsedShakeDetection, receiveTiming);
    const categories = confidenceAreaCategories(parsedShakeDetection);
    const matchedCodes = [...parsedShakeDetection.areaConfidences.keys()].filter((areaCode) => areaByCode.has(areaCode) || areaByCode.has(String(Number(areaCode)))).length;
    const eligibleCodes = [...parsedShakeDetection.areaConfidences].filter(([, confidence]) => confidence >= MEDIUM_CONFIDENCE_THRESHOLD);
    const adoptedMarkers = shakeDetectionMarkers.childElementCount;
    const zeroReason = adoptedMarkers > 0 ? '' : !settings.shakeDetectionEnabled ? '・設定OFF' : parsedShakeDetection.count <= 0 || parsedShakeDetection.confidence <= 0 ? '・非検出値' : eligibleCodes.length === 0 ? '・信頼度B未満' : matchedCodes === 0 ? '・地域コード未照合' : '・描画対象なし';
    const validity = parsedShakeDetection.count >= 0 && parsedShakeDetection.confidence >= 0 && parsedShakeDetection.confidence <= 1 ? 'count/confidence有効' : 'count/confidence範囲外';
    reportLiveProcessing('9611', `${shakeResult}・${validity}・count ${parsedShakeDetection.count} / confidence ${parsedShakeDetection.confidence.toFixed(2)} / A${categories.a.length} B${categories.b.length} / 地域コード照合 ${matchedCodes}/${parsedShakeDetection.areaConfidences.size} / 地図採用 ${adoptedMarkers}${zeroReason}`, browserReceivedAt, parsedShakeDetection.updatedAt, '解析更新→受信', true, shakeResult === 'started' || shakeResult === 'updated' || shakeResult === 'ended');
    if (shakeResult === 'started' && settings.shakeAudioEnabled) notifyAudio('shake');
    if (source === 'test') {
      addTestTimingLog('9611', receiveTiming, '解析更新→受信');
      const categories = confidenceAreaCategories(parsedShakeDetection);
      addTestLog(`9611 ${shakeResult}: count ${parsedShakeDetection.count}, confidence ${parsedShakeDetection.confidence.toFixed(2)}, A${categories.a.length}/B${categories.b.length}`);
      if (shakeResult === 'updated') addTestLog('audio suppressed: shake update');
    }
    updateReceiveAgeDisplays();
    return;
  }

  // 561は受信地域ごとの短時間速報として表示しますが、単独では
  // 警告・通知音・自動フォーカスのトリガーにしません。
  const parsedUserquake = parseUserquake(payload);
  if (parsedUserquake) {
    const sensingResult = receiveRawSensing(parsedUserquake.area, parsedUserquake.id ?? '');
    const rawOutcome = !settings.shakeDetectionEnabled ? '設定OFFで表示抑制' : parsedUserquake.area === undefined ? '地域コードなし' : sensingResult.outcome === 'unknown-region' ? `地域コード${parsedUserquake.area}が未登録` : sensingResult.outcome === 'duplicate' ? '重複排除' : sensingResult.outcome === 'covered-by-9611' ? `${sensingResult.areaName}（9611表示と重複するためマーカー抑制）` : `${sensingResult.areaName ?? '地域不明'}にマーカー追加`;
    reportLiveProcessing('561', `解析成功・${rawOutcome}${!settings.shakeDetectionEnabled ? '' : sensingResult.outcome === 'rendered' ? `・表示中 ${rawSensingAreas.size}地域` : ''}`, browserReceivedAt, parsedUserquake.time ?? null, 'P2P受信時刻→Browser', true, sensingResult.outcome === 'rendered');
    if (source === 'test') {
      addTestLog(`561 ${sensingResult.areaName ?? `area ${parsedUserquake.area ?? 'unknown'}`} received; raw regions ${rawSensingAreas.size}`);
    }
    updateReceiveAgeDisplays();
    return;
  }

  const earthquake = parseEarthquake(payload);
  if (!earthquake) {
    const rawCode = code === 'other' ? 'unknown' : code;
    reportLiveProcessing(rawCode, '受信したが対応パーサーで解析できず（内容非保存）', browserReceivedAt, null, '発表→受信', false);
    return;
  }
  const receiveTiming = createReceiveTiming(payload, browserReceivedAt, payloadString(payload, 'issue', 'time'));
  rememberEarthquakeReceiveTiming(earthquake.reportId, receiveTiming);
  const mergeResult = mergeEarthquakeHistory([earthquake], browserReceivedAt, true);
  const reportDuplicate = mergeResult.duplicateReportIds.includes(earthquake.reportId);
  reportLiveProcessing('551', `${reportDuplicate ? 'raw ID重複排除' : mergeResult.newEventIds.length > 0 ? '新規イベント・履歴/画面へ反映' : mergeResult.updatedEventIds.length > 0 ? '同一地震の続報・履歴/画面更新' : '新しい発表だが既存表示に変更なし'}`, browserReceivedAt, earthquake.issueTime, '発表→受信', true, mergeResult.changed);
  if (!mergeResult.changed) {
    if (source === 'test') {
      const duplicate = mergeResult.duplicateReportIds.includes(earthquake.reportId);
      addTestLog(duplicate
        ? `551 duplicate report ignored: ${earthquake.reportId}`
        : `551 older/no-change report ignored: ${earthquake.reportId}`);
      addTestLog('audio suppressed: same event or duplicate');
    }
    return;
  }
  if (mergeResult.newEventIds.length > 0 && settings.earthquakeAudioEnabled) notifyAudio('earthquake');
  if (source === 'test') {
    addTestTimingLog('551', receiveTiming);
    addTestLog(mergeResult.newEventIds.length > 0
      ? `551 new earthquake event ${mergeResult.newEventIds[0]}`
      : `551 event updated ${mergeResult.updatedEventIds[0] ?? earthquake.time}`);
    if (mergeResult.newEventIds.length === 0) addTestLog('audio suppressed: event continuation');
  }
  updateReceiveAgeDisplays();
}

function scheduleReconnect(): void {
  // A test session must never schedule production reconnect work.
  if (isTestMode || disposed || reconnectTimer !== undefined) return;
  setConnectionState(connectionEstablished ? 'reconnecting' : 'offline');
  const delay = Math.min(1_000 * 2 ** reconnectAttempt, 30_000);
  reconnectAttempt += 1;
  addLiveDiagnostic(`WebSocket再接続を${Math.round(delay / 1000)}秒後に予約`);
  renderLiveDiagnostics();
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = undefined;
    connectWebSocket();
  }, delay);
}

function connectWebSocket(): void {
  // Keep the mode check inside the connection boundary as well as in the
  // startup branch. This prevents accidental calls from timers or listeners.
  if (isTestMode || disposed || (socket && socket.readyState !== WebSocket.CLOSED)) return;
  setConnectionState(connectionEstablished ? 'reconnecting' : 'offline');
  let connection: WebSocket;
  const isReconnectAttempt = connectionAttempted;
  connectionAttempted = true;
  if (isReconnectAttempt) {
    liveDiagnostics.reconnects += 1;
    addLiveDiagnostic('WebSocket再接続を開始');
    renderLiveDiagnostics();
  }
  try {
    connection = new WebSocket(websocketUrl);
  } catch {
    scheduleReconnect();
    return;
  }
  socket = connection;

  connection.onopen = () => {
    if (disposed || socket !== connection) return;
    const shouldSyncHistory = connectionEstablished || reconnectAttempt > 0;
    connectionEstablished = true;
    liveDiagnostics.lastConnectedAt = Date.now();
    reconnectAttempt = 0;
    setConnectionState('live');
    addLiveDiagnostic(`WebSocket接続成功${liveDiagnostics.messages === 0 ? '・イベント受信待機' : ''}`);
    if (shouldSyncHistory) void loadHistory('reconnect');
  };

  connection.onmessage = (event: MessageEvent) => {
    const browserReceivedAt = Date.now();
    lastWebSocketReceivedAt = browserReceivedAt;
    updateReceiveAgeDisplays();
    if (disposed || socket !== connection) return;
    processWebSocketFrame(event.data, 'websocket', browserReceivedAt);
  };

  connection.onerror = () => {
    if (socket === connection) connection.close();
  };

  connection.onclose = () => {
    if (socket !== connection) return;
    socket = null;
    if (connectionEstablished) liveDiagnostics.disconnects += 1;
    addLiveDiagnostic(`WebSocket close${connectionEstablished ? '（切断）' : '（接続未確立）'}`);
    renderLiveDiagnostics();
    if (disposed) {
      setConnectionState('offline');
      return;
    }
    scheduleReconnect();
  };
}

function ensureProductionSocket(): void {
  if (isTestMode || disposed || document.visibilityState !== 'visible') return;
  if (socket && socket.readyState !== WebSocket.CLOSED) return;
  if (reconnectTimer !== undefined) return;
  connectWebSocket();
}

async function initializeTestMode(): Promise<void> {
  if (!isTestMode || disposed) return;
  setConnectionState('offline');
  renderAll();
  setTestControlsEnabled(false);
  try {
    testFixtures = await import('./testFixtures/fixtures');
    if (disposed) return;
    setTestControlsEnabled(true);
    clearTestLogs();
    addTestLog('TEST MODE ready: 疑似データのみ');
  } catch {
    addTestLog('fixtureの読み込みに失敗しました');
  }
}

function initializeProductionMode(): void {
  if (isTestMode || disposed) return;
  startHistorySyncTimer();
  void loadHistory('startup');
  // Start the live stream independently so a slow HTTP history response cannot delay it.
  connectWebSocket();
}

window.addEventListener('pagehide', (event: PageTransitionEvent) => {
  if (event.persisted) {
    if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    if (socket) {
      const oldSocket = socket;
      socket = null;
      oldSocket.onopen = null;
      oldSocket.onmessage = null;
      oldSocket.onerror = null;
      oldSocket.onclose = null;
      oldSocket.close();
    }
    return;
  }
  disposed = true;
  lifecycle.abort();
  replayController?.abort();
  replayController = undefined;
  clearReplayTimers();
  replayState = null;
  historyController?.abort();
  if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  if (historySyncTimer !== undefined) window.clearInterval(historySyncTimer);
  historySyncTimer = undefined;
  if (receiveAgeTimer !== undefined) window.clearInterval(receiveAgeTimer);
  receiveAgeTimer = undefined;
  if (shakeDetectionTimer !== undefined) window.clearTimeout(shakeDetectionTimer);
  shakeDetectionTimer = undefined;
  if (mapDragFrame !== undefined) window.cancelAnimationFrame(mapDragFrame);
  mapDragFrame = undefined;
  mapDragState = null;
  japanMap.classList.remove('is-dragging');
  clearEewTimer();
  eewByEventId.clear();
  earthquakeReceiveTimings.clear();
  earthquakeReceiveTimingOrder.length = 0;
  clearRawSensingState();
  activeEew = null;
  activeEewEventId = null;
  audioNotifier.dispose();
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
}, { signal: lifecycle.signal });

window.addEventListener('pageshow', (event: PageTransitionEvent) => {
  if (!event.persisted || isTestMode || disposed) return;
  ensureProductionSocket();
  requestHistoryOnResume();
}, { signal: lifecycle.signal });

startReceiveAgeTimer();

if (isTestMode) {
  void initializeTestMode();
} else {
  initializeProductionMode();
}
