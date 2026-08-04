# まるごと祭：未来の町 — 引き継ぎ

Vite + React Three Fiber の三人称オープンワールド。町GLBと Ultimate Modular Men を使用。

## コマンド

```bash
npm install
npm run dev            # 開発サーバ (http://localhost:5173)
npm run build          # 本番ビルド
npm run preview        # 本番ビルドの確認

npm run build:assets   # FBX→GLB 変換 と NavMesh ベイク（アセットを差し替えたときだけ）
npm run verify:assets  # 変換したGLBが元FBXと同じスキニングになるか検証
npm test               # エンジンのヘッドレステスト（88項目）
npm run test:browser   # 実ブラウザ（ヘッドレスChrome）での描画・例外チェック
```

`public/assets/characters/glb/*.glb` と `public/assets/navmesh.json` は
`npm run build:assets` の生成物。生成済みなので通常は再実行不要。

## 構成

```
scripts/            オフライン処理（ビルド時のみ。ブラウザでは動かない）
  build-characters  部位別FBX → 単一スケルトンGLB + 共有 animations.glb
  build-navmesh     town.glb → 歩行グリッド・ランドマーク・ミニマップ画像
  verify-characters 変換の正しさをボーン行列レベルで検証
  smoke-test        stepSim を数千フレーム回すエンジンテスト
  browser-check     CDPでChromeを操作し、例外・描画統計・スクショを取得

src/data/           データ定義（ここを編集すればバランス調整できる）
  world.js          町の配置・NavMesh設定（scripts と src で共有）
  enemies.js        敵5種の全パラメータ（bunbetu.md の章立てに対応）
  quests.js         クエスト・NPC・会話ノード・アイテム

src/engine/         描画を含まないゲームロジック（Nodeでテスト可能）
  sim.js            全状態 + HUDへの配信（useSyncExternalStore）
  step.js           1フレームの更新順序、プレイヤー操作、弾、罠
  enemyAi.js        敵の状態機械（感知→追跡→攻撃→逃走/狂暴化）
  damage.js         ダメージ適用、盾ブロック、ノックバック、死亡
  combat.js         ダメージ計算式（属性・耐性・背後・ガード）
  nav.js            NavMesh参照、壁ずり移動、視線判定、カメラ遮蔽
  quests.js         クエスト進行と会話分岐
  save.js           localStorage セーブ
  input.js          キー定義（KEYMAP がヘルプ画面と共通）

src/gfx/, src/scene/, src/ui/   React Three Fiber の描画と HUD
```

## 設計のポイント

- **シミュレーションと描画の分離**: 状態は `sim`（ミュータブル）に集約し、
  `<SimDriver/>` が `useFrame(..., -10)` で最優先に1回だけ進める。
  描画側は `sim` を読んで Object3D を更新するだけなので、毎フレームの React 再描画が無い。
  HUD だけ 12Hz のスナップショットで更新する。
- **敵・NPCは固定長プール**: リスポーンで React ツリーが組み替わらないので、
  GLBの再クローンが起きない。
- **1体1スケルトン**: GLTFExporter は SkinnedMesh ごとに skin を書き出すため、
  読み込み後に `shareSkeleton()` で1本に束ねている（`src/gfx/shareSkeleton.js`）。
- **NavMesh はオフラインベイク**: ランタイムのレイキャストが不要。
  `scripts/build-navmesh.mjs` と `src/engine/nav.js` は `src/data/world.js` の
  `TOWN` を共有するので、町の配置を変えたら **必ず build:assets を再実行**すること。
- **装備のスケール**: 手のボーンのワールドスケールは 1.0（ルート0.01 × アーマチュア100）。
  `src/gfx/Gear.jsx` は寸法をそのままメートルで書く。ここを100倍にすると盾が34mになる。

## デバッグ

ブラウザのコンソールから状態を直接触れる。

```js
__sim.player.hp = 999
__sim.enemies[0].hp = 1          // 目の前の敵を瀕死にする
__sim.dayTime = 0.9              // 夜にして SpaceSuit を出す
__three.gl.info.render.calls     // ドローコール数
```

## 既知の制限 / 次にやると良いこと

1. 音（bunbetu.md 20章）は未実装。アセットが無いため。
2. 状態異常（毒・麻痺・出血）は耐性値だけ定義済みで効果は未実装。
   氷結の移動低下（`attack.slow`）のみ動く。
3. 部位破壊（8章）・第二形態（10章）は未実装。
4. 経路探索は直進＋壁ずりのみ。A* を入れると建物の裏へ回り込めるようになる。
5. Adventurer は色数が多く1体13ドローコール。色をまとめると軽くなる。
6. モバイルは HUD のみ対応。仮想スティックは未実装。

## 注意

モデルのライセンスは `Ultimate Modular Men- Feb 2022/License.txt` を確認し、
公開・配布時の条件を守ること。
