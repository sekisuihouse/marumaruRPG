# MARUGOTO FUTURE QUEST

React Three Fiber / Vite 製の三人称3DアクションRPGです。町の局所破壊、通常敵、建物連動の4ボス、火球・糸移動に加え、WebRTC DataChannelを使うホスト権威型のマルチプレイ基盤を備えます。

## ローカル起動

```bash
npm ci
cp .env.example .env.local
npm run dev
```

マルチプレイをローカルで試す場合は、別ターミナルで次を起動します。

```bash
npm run signal
# またはクライアントと同時起動
npm run dev:all
```

タイトルの「マルチプレイ」からホストがルームを作成し、表示されたコードを参加者へ渡します。参加側はコード・パスワード・名前を入力して参加し、ホストは参加者の準備状態を確認して開始します。PCの既存キーボード・マウス操作とスマホのHUDボタンはそのまま使えます。

開発用にレベル8から始めるには `.env.local` で `VITE_DEBUG_START_LEVEL=8` として `npm run dev:debug` を実行します。

## WebRTC構成

接続はホスト中心のスター型です。参加者同士は接続せず、すべてホストを経由します。

```text
参加者 ← WebRTC DataChannel → ホスト ← WebRTC DataChannel → 参加者
                    ↑
             WebSocket（シグナリングのみ）
```

- Reliable channel: ルーム、攻撃要求、スナップショット、破壊、死亡などの重要イベント
- Unreliable channel: 入力・位置・回転・速度・アニメーション
- ホスト: 敵・ボスAI、建物破壊、状態スナップショットを決定
- 参加者: 入力を即時表示し、ホストの状態へ滑らかに補正

`VITE_SIGNAL_URL` は公開シグナリングサーバー、`VITE_ICE_SERVERS_JSON` はSTUN/TURN設定です。TURNの長期認証情報はクライアントやGitへ固定記載しないでください。正式公開では短期TURN認証情報を返す認証済みAPIを追加できるよう、ICE設定は環境変数から分離しています。

## Renderへのシグナリング配置

`render.yaml` はNode.js Web Service用です。Renderで本リポジトリを接続し、環境変数を設定します。

- `ALLOWED_ORIGINS=https://<Pagesまたは公開URL>`
- `PORT` はRenderが自動設定（サーバーは `process.env.PORT` と `0.0.0.0` を使用）
- `/health` をヘルスチェックに使用

サーバーはルームコード、offer/answer/ICE、入退室、再接続トークンだけを短時間メモリ保持し、ゲーム状態は保存しません。空ルームは自動削除されます。Render無料プランでは未使用時にスリープするため、初回接続は遅くなることがあります。

## GitHub Pages

Pages向けには `VITE_BASE_PATH=/marumaruRPG/ npm run build` を使います。PagesだけではWebSocketシグナリングサーバーを常時稼働できないため、マルチプレイ公開には上記Render等の別サービスを必ず設定してください。`VITE_SIGNAL_URL` 未設定の公開ビルドではローカルホストへ接続しようとするため、公開用途には必ず設定が必要です。

## 推奨人数・制限

人数は固定ではなく可変です。推奨は2〜4人、ルームの設定上限は16人です。実際の上限はホスト端末性能、回線、TURN帯域に依存します。人数増加時は低頻度の状態同期と補間を使います。

現在の実装はローカル・同一ネットワークでの基盤検証を対象としています。NAT越えにはTURNが必要な場合があります。ホスト移行は実装しておらず、ホスト切断時にルームは終了します。

## アセットとライセンス

`Ultimate Modular Men- Feb 2022` は同梱のCC0ライセンスに従います。一方、町GLBの権利と、`bos 3Dmoderu` のPMX由来ボスGLBの再配布可否は確認が必要です。特にボスモデルは配布元の再配布禁止条件に抵触しうるため、公開リポジトリから除外しています。

ローカルで完全版を動かすには、権利を確認済みの `public/assets/town.glb`、`public/assets/navmesh.json`、`public/assets/destructibles.json`、および `public/assets/bosses/glb/*.glb` を別途用意してください。これらが無い公開チェックアウトでは完全ゲーム起動・アセット依存スモークテストは実行できません。

## 検証

```bash
npm run build
npm test                 # ローカルの完全アセットがある場合
npm run test:browser     # npm run dev 起動中に実行
npm run test:multiplayer # シグナリングの結合テスト
```

GitHub Actionsは公開可能なソースだけで `build` と `test:multiplayer` を実行します。
