# Lightweight Earthquake Monitor

日本の地震情報を常時確認する軽量なWebアプリです。最新地震と履歴を左側に、都道府県境界を含む日本地図と震源を右側に表示します。

## 使用技術

- Vite
- TypeScript
- Vanilla JavaScript（UIフレームワーク不使用）
- ブラウザ標準の Fetch API / WebSocket API
- ローカルSVG地図（実行時に外部地図サービスを使いません）

## セットアップ

Node.js と pnpm を用意し、プロジェクトのルートで実行します。

```sh
pnpm install
pnpm run dev
```

表示されたローカルURLをブラウザで開いてください。

## 開発コマンド

- `pnpm run dev` — 開発サーバーを起動
- `pnpm run build` — TypeScriptの型検査と本番ビルド
- `pnpm run preview` — 本番ビルドをローカルで確認

## 地震情報API

[P2P地震情報 JSON API v2](https://www.p2pquake.net/develop/json_api_v2/) の `GET /history?codes=551&limit=10` で起動時の履歴を取得し、その後は `wss://api.p2pquake.net/v2/ws` から情報コード551（地震情報）をリアルタイム受信します。WebSocket切断時は1秒から最大30秒までの指数バックオフで自動再接続し、接続回復後にHTTPで履歴を一度取得して切断中の情報を補完します。LIVE表示は実際のWebSocket接続状態を示します。

## 日本地図データ

地図は気象庁の[予報区等GISデータ「地震情報／都道府県等」](https://www.data.jma.go.jp/developer/gis.html)を元に生成しています。配布ShapefileはJGD2011（日本測地系2011）座標系です。元データは国土地理院の数値地図等を使用して作成されたと気象庁が案内しています。

気象庁コンテンツの利用は[気象庁ホームページの利用規約](https://www.jma.go.jp/jma/kishou/info/coment.html)に従います。出典の明記と、編集・加工した旨の記載が必要です。このアプリでは、都道府県の地理データを簡略化してSVGに変換したことを画面と本READMEに表示しています。加工後の地図は気象庁作成の公式地図ではありません。

SVGは開発時に一度だけ生成した静的ファイルです。変換スクリプトはPython標準ライブラリのみを使い、本番のJavaScriptバンドルには含まれません。元データZIPを取得した後、次のように再生成できます。

```sh
python3 scripts/generate-japan-map.py /path/to/20190125_AreaInformationPrefectureEarthquake_GIS.zip
```

都道府県境界は、Douglas–Peucker簡略化（線を少ない頂点で近似する処理）で軽量化しています。許容誤差は投影後のSVG座標で約1.7単位、1ピクセル未満の小さな島・境界片は画面上で判別できないため省いています。北海道から沖縄までの都道府県ごとに `id`、`data-pref-code`、`data-pref-name` 属性を持つ個別SVG pathとして格納しています。

地図の幾何形状と震源には共通の投影設定 [`src/mapProjectionConfig.json`](src/mapProjectionConfig.json) を使います。地図データの緯度経度とAPIの震源緯度経度を、同じbounding box（経度122.93365306084013–153.98684416302774、緯度20.422746413816014–45.557243413952456）および同じ正距円筒図法（中心緯度の余弦で経度方向を縮尺調整）から800×800 SVG座標へ変換します。そのため、北海道・沖縄・離島を含め、震源と地図の相対位置が一致します。

## 実装済みの機能

- 最新地震情報（最大震度、震源地、発生時刻、マグニチュード、深さ）
- 最近の地震情報10件を縦リスト表示
- 地震履歴の選択による震源マーカーの強調
- 都道府県境界を含むローカルSVG日本地図と、直近10件の震源表示
- 起動時のHTTP履歴取得とWebSocketによるリアルタイム更新
- WebSocketの自動再接続、再接続後のHTTP履歴補完、接続状態表示
- 初回ローディング表示、通信失敗時のエラー表示と再試行
- 情報IDによる重複排除（直近256 IDを保持）
- PCでは情報パネルと大きな地図を左右に配置し、小画面では上下に配置
- GitHub Pages用Vite base pathとGitHub Actionsによるデプロイ
- ページ離脱時の通信・再接続タイマー・イベントリスナー解放

APIの `id` は個々の情報を識別しますが、複数の異なる情報IDを同一の地震イベントへ結び付ける安定したイベントIDは仕様にありません。そのため、異なるID間の訂正・続報を発生時刻などから推測して統合する処理は行わず、IDが同じ再配信のみ重複排除します。取得値が欠けている場合は `—` と表示します。
