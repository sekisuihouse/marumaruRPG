# 引き継ぎ資料 — まるごと祭：未来の町（破壊アクション化アップデート）

最終更新: 2026-08-04 / 対象リポジトリ: `marugotosaiRPG 2`

このドキュメントは、次の担当（Codex 等）が**大幅アップデートを安全に行う**ための地図です。
「どこに何があるか」「どう動いているか」「どこを触ると壊れるか」を優先して書いています。

---

## 0. 30秒サマリ

- Vite + React Three Fiber の三人称3DアクションRPG。**ゲームロジックは React の外**（`src/engine/`）にあり、
  React は描画と HUD だけを担当する。**毎フレーム setState しない**のが全体の設計原則。
- 直近のアップデートで **町GLBのメッシュ単位破壊 / 破片物理 / 敵ラグドール / 敵弱体化 /
  連続火球 / ウェブスイング / 爽快感演出** を追加した。
- テストは3本。`npm test`（ヘッドレス172項目）・`npm run test:browser`（実Chrome）・`npm run build`。
  **この3本が通る状態を常に維持すること。**

```bash
npm run dev              # 開発サーバ（http://localhost:5173/）
npm run build            # 本番ビルド
npm test                 # エンジンのヘッドレステスト（three は使うが描画なし）
npm run test:browser     # 実Chrome検証（別ターミナルで npm run dev が必要）
npm run build:assets     # キャラGLB + NavMesh + 破壊データ + ボスGLB を再生成（数分）
npm run build:bosses     # 配布PMX → ボスGLB だけ作り直す
npm run build:extension  # ビルドして Chrome 拡張機能フォルダへ同期
```

---

## 1. ディレクトリ構成と責務

```
src/
  data/          純データ。three にも DOM にも依存させない（ビルドスクリプトからも import する）
    world.js         TOWN変換・NAV設定・SPAWN・SAVE_KEY
    enemies.js       敵5種の定義 / ENEMY_BALANCE(弱体化倍率) / PLAYER_ATTACKS / PRESS_ATTACKS
    quests.js        NPC・クエスト・アイテム
    destructibles.js 破壊の分類規則・部位ステータス・破片品質/物理定数
    abilities.js     連続火球 / ウェブスイング / 爽快感(JUICE) の調整値
  engine/        ゲームロジック（React非依存・ヘッドレスで動く）
    sim.js           全状態の器。HUDスナップショット配信(useSyncExternalStore)
    step.js          1フレームの更新順序。入力→プレイヤー→敵→弾→効果→破壊→破片→ラグドール→クエスト
    input.js         KEYMAP（唯一のキー定義）/ keys / pressed / mouse / touch / holding
    nav.js           ベイク済みNavMeshのランタイム。移動解決・視線・**破壊による開通**
    combat.js        ダメージ計算式（属性・ガード・背後補正）
    damage.js        HP適用・死亡処理・ラグドール起動
    enemyAi.js       敵ステートマシン
    targets.js       ★全攻撃の共通入口 damageTarget() / explode()
    destruct.js      ★建物の小片レジストリ・破壊・連鎖・支持崩壊・レイキャスト・セーブ
    debris.js        破片（残骸）の固定ステップ物理
    ragdoll.js       敵ラグドール（質点＋距離拘束）
    webswing.js      糸移動（スイング＋ジップ）
    firestream.js    連続火球
    juice.js         ヒットストップ/シェイク/スロー/粉じん/破壊音
    quests.js, save.js
  gfx/           three のオブジェクト構築（React コンポーネント含む）
    townBuild.js     ★GLB→マージ済みメッシュ＋破壊小片。ブラウザとテストで共有
    townVisual.js    描画リソースの受け渡し窓口（materials/geometries/破片ジオメトリ）
    Town.jsx         townBuild を呼び、破壊の「見た目」を実装（頂点を潰す/戻す）
    CharacterModel.jsx  スケルトン共有・アニメ・**ラグドール追従**
    Gear.jsx, Nameplate.jsx, shareSkeleton.js
  scene/         R3F コンポーネント（useFrame で sim を読んで Object3D を更新）
    World.jsx        SimDriver(priority -10) とシーン全体の組み立て
    Actors.jsx, Effects.jsx, Debris.jsx, WebLine.jsx, DebugOverlay.jsx, ThirdPersonCamera.jsx
  ui/            HUD（12Hz のスナップショットだけ読む）
scripts/
  build-characters.mjs    FBX部位 → 単一スケルトンGLB
  build-navmesh.mjs       town.glb → navmesh.json（グリッド・ランドマーク・ミニマップ）
  build-destructibles.mjs town.glb → destructibles.json（分類対応表・統計。検証用）
  build-bosses.mjs        配布PMX → ボスGLB（ポーズ焼き込み・テクスチャ縮小・埋め込み）
  build-extension.mjs     dist → marugoto-tensei-extension へ同期
  smoke-test.mjs          ヘッドレステスト本体（172項目）
  browser-check.mjs       実Chrome(CDP)での検証
marugoto-tensei-extension/  Chrome拡張。manifest/content.js は手書き、game/ と assets/ は自動生成
```

---

## 2. 全体のデータフロー

```
useFrame(priority -10)  →  stepSim(dt)                    [src/scene/World.jsx]
   ↓
updateJuice → dt *= timeScale()   ヒットストップ/スロー
   ↓
updatePlayer → updateEnemies → updateProjectiles → updateEffects
            → updateDestruct → updateDebris → updateRagdolls → updateQuests
   ↓
publishHud()（12Hz に間引き）  →  useSyncExternalStore  →  HUD 再描画
```

**重要な不変条件**

1. `sim` はミュータブルな単一オブジェクト。描画側は `useFrame` の中で直接読む。
2. HUD は `buildSnapshot()` の戻り値しか見ない。新しい表示項目を足すときは
   `emptySnapshot()` と `buildSnapshot()` の**両方**に追加する。
3. 配列（enemies / npcs）は固定長プール。React ツリーが組み替わらないので GLB の再クローンが起きない。
   **要素を push/splice しないこと。**
4. `dt` は `1/20` で頭打ち。タブ復帰時のワープを防いでいる。

---

## 3. 破壊システム（最重要）

### 3.1 考え方

建物ごとの巨大コライダーは持たない。`town.glb`（トップレベル125オブジェクト / 527メッシュ / 195,607三角形）を
**3,143個の小片(part)** に分割し、小片単位で HP・AABB コライダー・破片を持たせる。

```js
part = {
  id, objectPath, objectName, category, partType,
  hp, maxHp, mass, breakThreshold, materialType, debrisImpulse, chainBreakRadius,
  cx, cy, cz, hx, hy, hz,        // ワールド座標のAABB
  bucket, vStart, vCount,        // マージ済みジオメトリ内の頂点範囲
  pos, nor,                      // 復元と破片生成に使う元データ
  supports: [id], supportCount,  // 支持関係
  cells: [navCellIndex],         // 塞いでいる NavMesh セル
  broken,
}
```

### 3.2 分割（`src/gfx/townBuild.js`）

1. `TOWN` 変換（scale=6）を GLB シーンに適用 → 以降すべて**ワールド座標**で扱う。
2. トップレベル名を `categoryOf()` で分類（`src/data/destructibles.js` の正規表現表）。
   実際の GLB 名だけを列挙しており、**名前を推測していない**。
   - 破壊対象: `building` / `structure` / `prop`（65オブジェクト）
   - 非対象: `ground` `water` `nature` `people` `fx`（地面・川・樹木・住民プロップ・花火）
3. 破壊対象のメッシュを「セル格子 × マテリアル」で切り分ける（`chunkTriangles`）。
   セル一辺は `CHUNKING.cell = 1.15m`、巨大メッシュは `maxCellsPerAxis` で自動的に粗くなる。
4. マテリアル単位でマージ。**1小片＝1バケット内の連続した頂点範囲**になるよう並べる。
5. 形状から部位を判定（`partTypeOf`）。名前ではなく「オブジェクト内の相対高さ・細長さ・薄さ」で
   wall / roof / pillar / window / floor / sign / prop を決める。
6. `linkSupports()` が同一オブジェクト内の「下部の小片 → その上にある小片」を結ぶ。

> `buildTown()` は **ブラウザ（Town.jsx）とヘッドレステスト（smoke-test.mjs）の両方**から
> 同じ引数で呼ばれる。ここを変えると両方に効く。片方だけ変えてはいけない。

### 3.3 描画側の破壊（`src/gfx/Town.jsx`）

- 破壊 = その小片の頂点範囲を**中心1点へ潰す**（`markRange` で部分アップロード）。
- 復元 = `part.pos` を書き戻す。
- ジオメトリの作り直しをしないので、**ドローコールは21のまま**（破壊してもほぼ増えない）。
- 破片の描画用ジオメトリは `townVisual.debrisGeometry(part)` が遅延生成＋LRUキャッシュ（220件）。

### 3.4 当たり判定の消滅（新規・注意点）

`registerParts()` 時に `buildCellMap()` が「どの小片がどの NavMesh セルを塞いでいるか」を作る。
判定条件は `build-navmesh.mjs` と同じ **FOOT=0.35m / BODY=2.0m**（体の高さに断面があるか）。
小片が壊れると `openClearedCells()` が走り、**そのセルを塞ぐ小片が全部壊れたら** `openCell()` で
`F.WALK` を立て、`ceils` も地面高さまで下げる（カメラが引き寄せられ続けないように）。
`resetTown()` は `restoreNav()` でベイク直後の flags/ceils に戻す。

- ⚠️ `nav.baseFlags` / `nav.baseCeils` は `loadNav()` 時のコピー。**loadNav を複数回呼ばない**こと。
- ⚠️ NavMesh より先に `registerParts()` を呼ぶと `cells` が空になる。
  現状の順序は「`loadNav()` → 画面表示 → `Town.jsx` の `buildTown` → `registerParts`」で保証している。
- ⚠️ **見た目と当たり判定は必ず同じ寿命にする。** 過去に「`<Suspense>` で `Town` が再マウントされ、
  町のジオメトリだけ作り直されて無傷に戻り、開通済みの通行判定が残る」不具合があった。対策として
  ① `Town.jsx` が構築結果を `WeakMap` でGLBシーンごとにキャッシュして作り直さない
  ② `registerParts()` は新規登録時に必ず `restoreNav()` してから `buildCellMap()` する
  ③ 同じ parts を再登録したときは何もせず破壊状態を保つ
  ④ セーブの破壊状況は適用できるまで `sim.pendingBrokenSave` に残す（`applyPendingBrokenSave()`）
  の4点を入れてある。**このどれかを外すと同じズレが再発する。**

### 3.5 攻撃の入口（`src/engine/targets.js`）

**すべての攻撃は `damageTarget()` / `explode()` を通る。** 敵・建物の小片・残骸をここで一括処理する。

```js
damageTarget({
  x, y, z,                    // 命中位置（建物・破片はここを中心に判定）
  dirX, dirY, dirZ,           // 攻撃方向（破片が飛ぶ向き・裏側の除外に使う）
  radius,                     // 影響半径
  arc, arcRange, originX, originZ, yaw,   // 近接の扇形（敵判定のみ。原点は攻撃者の足元）
  attack, attacker, mul,
  hitEnemies, hitStructure,   // 既定 true
  structureMul, impulse, juice, slowmo,
})
```

- 「壁の反対側が壊れない」のは `damageStructure()` の
  `along = (part中心 - 命中点)・dir; if (along < -radius*0.55) continue` による。
- 新しい攻撃を足すときは **`damageTarget` を呼ぶだけ**でよい。建物用のコードを書き足す必要はない。

### 3.6 破片（`src/engine/debris.js`）

- HP を持たない。当たれば必ず飛ぶ（`hitDebris`）。
- **固定 60Hz ステップ**（最大4サブステップ）。フレームレートで挙動が変わらない。
- 上限は品質設定（high 160 / medium 90 / low 40）。超過時は**小さくて古い**ものから捨て、大型は残す。
- 70m 外・静止後はスリープ。プレイヤー/敵への接触ダメージは**上限9・プレイヤーは死なない**。
- 描画は「元ジオメトリのメッシュ最大32個」＋「細片は InstancedMesh 1個（180）」。

---

## 3.7 ボスの3Dモデル（配布PMX → GLB）

4体のボスは miHoYo が公開している MMD 用モデル(PMX)を使う。
**配布物そのものは `bos 3Dmoderu/` に置き、`public/` には入れない**（＝配信物に含めない）。
ランタイムが読むのは変換後の GLB だけ。

```
bos 3Dmoderu/<dir>/*.pmx + Texture/*      ← 配布物。触らない・public に置かない
        ↓  npm run build:bosses  (scripts/build-bosses.mjs)
public/assets/bosses/glb/<ボスID>.glb      ← ゲームが読むのはこれだけ（計4.9MB）
public/assets/bosses/glb/manifest.json     ← 変換結果の記録（検証用）
```

| ボスID | 変換元フォルダ | displayHeight | GLB |
|---|---|---|---|
| student | gakuseitaiken | 3.4m | 0.34MB / 7,094三角形 / 材質4 |
| stage | stage | 3.6m | 2.06MB / 51,190三角形 / 材質11 |
| shrine | shrain | 4.0m | 1.77MB / 45,317三角形 / 材質12 |
| food | food | 3.0m | 0.77MB / 13,798三角形 / 材質8 |

**変換でやっていること**（`scripts/build-bosses.mjs`）

1. `three-stdlib` の MMD パーサで PMX を読む（`new MMDLoader()._getParser()`）。
   左右系の変換は自前で行うため `parsePmx(buffer, false)` で呼ぶ。
2. **立ち姿の焼き込み**: 配布モデルは編集用のAポーズ（腕が水平から約38°）なので、
   `左腕`/`右腕` ボーンを回して66°まで下ろし、線形ブレンドスキニングで頂点に焼く。
   モーションデータは配布物に無いので、ゲーム中もこの姿勢のまま使う。
3. MMD(左手系) → glTF(右手系) へ変換（zを反転＋面の巻き順を入れ替え）。
4. 高さ1.0・足元 y=0・中心を原点へ正規化 → ランタイムは `displayHeight` を掛けるだけ。
5. baseColor テクスチャだけを最大1024pxへ縮小して GLB に埋め込む
   （不透明ならJPEG、アルファがあればPNG）。toon.png / スフィアマップ mc3.png は使わない。
6. ボーン・剛体・モーフ・物理は捨てる（静的メッシュ）。

**ハマりどころ**

- ⚠️ **PMX 内のテクスチャ名は簡体字**（`脸` `头发` `衣服` `披风`）だが、配布フォルダのファイルは
  日本語にリネームされている（`顔` `髪` `服` `マント`）。`NAME_ALIASES` の対応表で吸収している。
  テクスチャが真っ白になったらまずここを疑う。
- ⚠️ **macOS のファイル名は NFD 正規化**。日本語のファイル名をコードに直接書かないこと
  （`.pmx` は拡張子で探し、テクスチャは NFC 正規化して比較している）。
- ⚠️ ボスは**出現した個体だけ**を非同期で読む（`src/gfx/BossModel.jsx`）。
  未出現の3体は通信もメモリも使わない。読み込んだシーンは URL 単位でキャッシュし、
  マテリアルだけ個体別に複製する（被弾フラッシュのため）。
- ボーンが無いので、呼吸・移動の上下動・予備動作の前傾・のけぞり・崩れ落ちは
  `BossModel.jsx` が姿勢（position.y / rotation）で表現している。

**ライセンス上の注意**: 配布元 readme（GB18030エンコード）に
「再配布禁止 / 営利目的の使用禁止 / ボーン修正・最適化・UVリメイクは許可 /
著作権は miHoYo に帰属」とある。変換後のGLBを含むビルド成果物を公開・配布する場合は
この条件に触れるため、配布形態は要確認。

---

## 4. その他の新規システム

### 4.1 敵ラグドール（`src/engine/ragdoll.js`）
17部位の質点＋距離拘束（Verlet）。剛体エンジンは使っていない。
`RAGDOLL_BONES` の名前は Ultimate Modular Men のボーン名と一致させてある（Hips/Chest/UpperArmL…）。
`CharacterModel.jsx` が「親→子の方向」からボーンのクォータニオンを解いてスキンメッシュを追従させる。
1つ飛ばしの距離に上下限（`spanMax/spanMin`）を入れて伸びきりを防いでいる。死体上限6・22秒で消滅。
`killEnemy()` の**報酬処理が終わったあと**に `spawnRagdoll()` を呼ぶ順序を崩さないこと。

### 4.2 敵弱体化（`src/data/enemies.js` の `ENEMY_BALANCE`）
敵定義そのものは素の設計値のまま。倍率だけで調整する。

| 項目 | 値 | 適用箇所 |
|---|---|---|
| HP | 70% | `sim.js makeEnemy` / `unlockEnemyChallenge` |
| 攻撃力 | 75% | `enemyAi.js attackerStateOf` |
| 攻撃頻度 | 85%（間隔 1/0.85） | `combatBehaviour` / `beginAttack` |
| 予備動作 | 1.18倍 | `beginAttack` |
| 同時攻撃 | 最大2体 | `aggressiveCount()` |
| 連続ひるみ | 1.5秒間免疫 | `damage.js damagePlayer` |
| 序盤（Lv≤6） | HP×0.82 / 攻撃×0.85 | `isEarly()` |
| ボス（roleTag=healer） | 弱体化の効きを45%緩和 | `relief()` |

### 4.3 連続火球（`src/engine/firestream.js`・Lv.8・**C 長押し**）
熱量制（100 / 1発5.5 / 毎秒26冷却 / オーバーヒート2.6秒）。着弾で小範囲爆発（`fireBlast`）。
`FIRE_STREAM.minSafeDistance` 未満では爆発半径と演出を落として自爆的な操作不能を防ぐ。

### 4.4 ウェブスイング（`src/engine/webswing.js`・Lv.6・**Q / 右クリック長押し**）

**操作の意味（2026-08-04 に仕様変更）**

| 操作 | 挙動 |
|---|---|
| 押した瞬間 | カメラ中央の円錐内を走査して**できるだけ高い場所**へ糸を張る |
| 押している間 | 振り子スイング（W巻取り / S伸ばし / 横入力でスイング補助） |
| **離した瞬間** | **糸を張った場所まで一気に飛んでいく（ジップ）** → 到着時に上へ跳ね上がり屋根に乗れる |
| ジップ中に再度押す | そのまま次の糸へ繋げる（連続移動） |

- 接続点探索 `findAnchor()` は円錐内 3リング×8方向＋上方向バイアス（約34方向）をレイキャストし、
  **高さを最優先**にスコアリングする。`preferHeight=6m` 以上が見つかればそれを採用。
- レイキャスト `raycastStructure()` は 4m 格子の **DDA 走査**。62m でも軽い。
- 「最初に当たった面」に付くので**壁越し接続は起きない**。空・NPC・飛んでいる破片には付かない。
- 接続先の小片が壊れたら安全に解除（スイング中もジップ中も）。
- 速度上限（スイング30 / ジップ42）、低空では壁に当たる、NavMesh 外へ落ちたら復帰。

### 4.5 爽快感（`src/engine/juice.js`）
`impact(scale 0..1)` 1本で「ヒットストップ / シェイク / スロー / 衝撃波」を制御する。
`JUICE.shakeFloor = 0.28` 未満は揺れないので、**通常攻撃では揺れず大破壊だけ揺れる**。
設定（`sim.settings`）で `shakeAmount` `reducedFlash` `reducedMotion` `debrisAmount` `dustAmount`
`destructionQuality` `muteSfx` を変更でき、HUD のヘルプ画面から操作できる。

---

## 5. 操作一覧（`src/engine/input.js` の `KEYMAP` が唯一の定義）

キーを追加・変更したら `KEYMAP` を直せばヘルプ画面とタイトル画面が自動で追随する。

| 操作 | PC | スマホ | 解放 |
|---|---|---|---|
| 移動 / 走る / 回避 / 盾 | WASD・矢印 / Shift / Space / Ctrl | HUDボタン | — |
| 近接・火球・範囲・弓・回復 | F / R / L / U / E（左クリック=近接） | スキルバー | Lv1〜4 |
| ウェブスイング | **Q** または右クリック長押し | 専用ボタン長押し | Lv.6 |
| 連続火球 | **C** 長押し | 専用ボタン長押し | Lv.8 |
| 会話 / マップ / クエスト / ヘルプ / セーブ | G / M / T / H・F1 / F5 | — | — |
| 開発用の当たり判定表示 | **F9** | `__marugoto.toggleDebug()` | — |

スマホの長押しは `input.js` の `touch` オブジェクト経由（`holding.*()` がキー・マウス・タッチを統合）。
カメラ操作と同時に押せるよう、キー入力とは独立した状態にしてある。

---

## 6. デバッグの入口

```js
__sim                       // sim 本体（player.hp などその場で書き換えられる）
__marugoto.destruct         // registry / breakPart / resetTown / damageStructure / raycastStructure
__marugoto.toggleDebug()    // F9 と同じ。コライダー・小片名・HP・支持関係・物理状態・破片数を表示
__three                     // { scene, gl, camera }。__three.gl.info.render で描画統計
__townDraws / __townParts   // 町のドローコール数 / 小片数
```

全技を即解放する例:
```js
__sim.player.level = 12
__sim.player.skills = ['melee','magic','area','arrow','heal','webswing','firestream']
```

---

## 7. テスト

### `npm test` — `scripts/smoke-test.mjs`（172項目 / 約40秒）
ブラウザを立ち上げず、実際に数万フレーム `stepSim()` を回す。three は使うが描画はしない。
`localStorage` と `fetch` を最小スタブで置き換えている。

| 節 | 内容 |
|---|---|
| [0] | GLB/アニメクリップの整合性・スケルトン統合 |
| [1]〜[12] | 既存: 移動・敵AI・盾・属性・逃走/狂暴化・死亡/リスポーン・攻撃・クエスト・セーブ |
| **[13][13b]** | 建物の小片生成・命中部品だけの損傷・除外設定・全攻撃の建物ダメージ |
| **[14]** | 破片の物理・残骸への再攻撃・上限 |
| **[14b]** | **破壊した分だけ当たり判定が消える / 復元で戻る** |
| **[15]** | 支持関係と連鎖崩壊 |
| **[16]** | ラグドール切替・関節の伸びきり防止・報酬維持・死体上限 |
| **[17]** | 火球のレベル解放・連射・オーバーヒート・冷却 |
| **[18]** | ウェブ接続（高所優先・壁越し禁止）・維持・ジップ到達・安全解除 |
| **[19]** | 町の破壊状況のセーブ/ロード |
| **[20]** | 18,000フレームの耐久（例外・リーク・NaN） |

### `npm run test:browser` — `scripts/browser-check.mjs`
実 Chrome を CDP で操作。描画・HUD・入力・**ブラウザ上での破壊と復元**・コンソールエラー0 を確認。
`npm run dev` を別ターミナルで起動しておくこと。スクリーンショットが `screenshot*.png` に出る。

> ⚠️ **ヘッドレスは SwiftShader なので約2fps しか出ない。**
> ブラウザ側で「攻撃したのに壊れない」ように見えたら、まず待ち時間不足を疑うこと
> （近接の予備動作0.18秒＝約4フレーム＝実時間2秒）。
> また `npm run dev` 起動後にソースを編集すると、動的 `import()` した同じモジュールが
> HMR の `?t=` 付き URL で**別インスタンス**になる。入力系を触るテストでは dev サーバを再起動すること。

---

## 8. Chrome 拡張機能

`marugoto-tensei-extension/` は「まるごと祭2026のページの3D円盤をクリック → 転生 → iframe でゲーム起動」。

- `manifest.json` / `content.js` / `content.css` … 手書き。**自動生成では上書きされない**
- `game/index.html` と `assets/` … `npm run build:extension` が `dist/` から同期する（毎回作り直し）

### 直近で直したエラー
| 症状 | 原因 | 対処 |
|---|---|---|
| `Unrecognized feature: 'pointer-lock'` | iframe の `allow="pointer-lock"` は Chrome の Permissions Policy に無い | `allow="fullscreen; autoplay"` に変更 |
| `CompileError: WebAssembly.instantiate() … violates CSP` | drei の `useGLTF` が MeshoptDecoder(wasm) を読む。MV3 既定 CSP が wasm を禁止 | manifest に `"content_security_policy": { "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" }` |
| `NotAllowedError: A user gesture is required to request Pointer Lock` | `?autostart=1` 起動はクリックを伴わないのに `requestPointerLock()` していた | autostart 時は要求しない。最初の画面クリックで `input.js` が取得する |
| `PCFSoftShadowMap has been deprecated` | three r18x で非推奨 | `THREE.PCFShadowMap` に変更 |
| `THREE.Clock: This module has been deprecated` | **@react-three/fiber の内部**。自コードには無い | 未対処。r3f 更新待ち（動作に影響なし） |

---

## 9. 触るときの注意（ハマりどころ）

1. **`src/data/` は three / DOM に依存させない。** ビルドスクリプト（node）からも import される。
2. **`townBuild.js` を変えると小片IDの並びが変わる。** セーブの `town.ids` は ID の配列なので、
   小片数が変わったセーブは `applyBroken()` が `total` 不一致で自動的に無視する（安全側）。
   分割ロジックを変えたら `npm run build:destructibles` で対応表も更新すること。
3. **`buildTown()` は約 300ms・メモリ数十MB**（`part.pos/nor` の保持分）。
   小片数を増やす場合は `CHUNKING.cell` とメモリのトレードオフを測ること。
4. **敵配列に要素を足さない。** `initEnemies()` の固定プール前提で React ツリーが組まれている。
5. **HUD へ項目を足すときは `emptySnapshot()` と `buildSnapshot()` の両方**を更新する。
6. **`sim.settings` に項目を足したら** `save.js` は `Object.assign` で丸ごと復元するので、
   既存セーブに無いキーは既定値のままになる（`?? ` でフォールバックすること）。
7. **NavMesh の再ベイク（`build-navmesh.mjs`）をしたら、破壊のセル対応も自動で作り直される**が、
   `FOOT/BODY` の値を変えたときは `destruct.js` 側の同名定数も合わせること。
8. 攻撃を追加するときは `PLAYER_ATTACKS` に足す。`mode: 'hold'` を付けると
   `tryAttack()` は無視し、`PRESS_ATTACKS` からも除外され、HUD は `HoldButton` で描く。

---

## 10. 既知の未完了・改善候補

| 項目 | 状況 | 提案 |
|---|---|---|
| 破片同士の衝突 | 未実装（地面・プレイヤー・敵のみ） | 瓦礫の山を作るなら簡易な球体同士の押し出しから |
| ラグドールと建物の衝突 | NavMesh セル基準の押し戻しのみ | `isInsideStructure()` を使った AABB 押し出しへ |
| コライダー形状 | AABB 近似（斜め屋根で数十cmずれる） | 凸包 or 複数OBBへ。`part` に形状フィールドを足す設計余地あり |
| `destructibles.json` | 検証・調整用の資料。ランタイム未使用 | HP調整をデータ駆動にするならここを読ませる |
| 破壊音 | Web Audio のノイズ合成 | 音源素材の差し替え口は `juice.js playBreakSound()` |
| バンドルサイズ | 1.3MB（gzip 370KB）の単一チャンク | three / drei を動的 import で分割する余地 |
| 敵の攻撃は建物を壊さない | 仕様どおり（プレイヤーの攻撃のみ） | 壊させるなら `enemyAi.executeAttack` を `damageTarget` 経由に寄せる |
| `THREE.Clock` 非推奨警告 | r3f 内部 | ライブラリ更新で解消 |
