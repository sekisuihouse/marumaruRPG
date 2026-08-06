STATUS: FINAL_BOSS_COMPLETE

# 最終ボス引継ぎ

## 実装概要

既存4ボスを全て倒すと、実測 約35.6m の「祭典終端巨人・ティウ」が町中央に出現する。Mixamo 41ボーンへ写真テクスチャと7モーションを統合し、骨に追従する身体そのものの当たり判定、部位判定、攻撃、ウェブ接続、専用カメラ/HUD、セーブ、死亡演出を実装した。最終戦ではアリーナをロックせず、ATフィールドと橋の通行制限は発生しない。

判定の寸法は data の固定値ではなく、毎フレーム骨のワールド座標から測り直した `boss.visualHeight` に対する比率で決まる（`FINAL_PART_DEFS.radius` / `FINAL_BODY_DEFS.radius`）。モデルの拡大率を変えても、見えている身体と判定がズレない。

### 身体そのものが足場であり、破壊対象

- 専用の足場オブジェクトは持たない。骨と骨をつないだ19本のカプセル（`FINAL_BODY_DEFS`）が身体の当たり判定で、その上に直接立てる。
- 「ここを攻撃しろ」の主要部位（ひざ・前腕・導管・視界冠・祭壇）は一度壊れたら再生しない。
- 胸の祭壇を壊すと PHASE 5 に入り、身体の再生が完全に止まる。残った身体を削り切ると崩れ落ちて撃破。

### 身体は町の建物とまったく同じ壊れ方をする

`src/gfx/finalBossChunks.js` が読み込み時にスキンメッシュを **約257個の小片** へ分割する（骨 × 骨ローカルの格子。実測で半径の中央値 1.67m）。

- 頂点属性 `aChunk` に小片番号を焼き、壊れた番号をマスクテクスチャへ立てて **フラグメントシェーダで discard** する。つまり身体そのものが欠けて穴が空く。
- 壊れた位置から `spawnDebris` / `dust` / `playBreakSound` を呼ぶ。破片・粉塵・破壊音は建物(`destruct.js`)と同じ入口・同じ見た目。
- 隣の小片へ衝撃が伝わる連鎖破壊あり（`FINAL_CHUNK.chainRatio` / `chainDamage`、1発で全身が消えないよう波及数を6に制限）。
- 壊れた小片はフェーズが進むほど遅く塞がる（`FINAL_BODY_RESPAWN` = 5 / 5 / 7.5 / 10 / 14 秒）。
- ひとつのカプセルの小片が `FINAL_CHUNK.collapseRatio`（60%）壊れると、その部位は**足場としても抜ける**（乗っていると落ちる）。

このモデルは行列が悪条件で、`applyBoneTransform` によるCPU側のスキニング再現は数値が発散する（代表頂点で4700万mまで飛ぶ）。そのため小片の位置は
**骨のワールド行列 × 骨ローカル重心 × （実測全高 / バインド全高 × バインド倍率）** で求めている。この倍率計算を変えると小片が身体から外れるので注意。

## 操作方法

- 移動: WASD / スマホ左下ジョイスティック
- 近接: F
- 技選択: 1–4、使用: R
- ガード: V
- 回避: Space
- ウェブ: Q長押し。巨人の上半身にも接続可能

## ボス戦の流れ

1. 6秒の組み上がり演出後、歩行・旋回する巨人の左右どちらかのすねを破壊。
2. 地面へ下がった前腕から身体へ登る。骨追従足場とウェブを利用する。
3. 4本の祭導管と視界冠を破壊。対応する既存4ボスの戦利品が反撃後の安全時間を作る。
4. 胸の祭核を破壊。脈動攻撃をガード/回避しながら攻撃する。
5. 0.4倍速のdeath clipによる12秒の降下を経て撃破。落下時は安全足場へ復帰する。

すね、腕、導管、冠、祭核は個別HPを持つ。腕破壊で虫払い攻撃が制限され、冠破壊で盲目的な振り落としへ変化し、導管全破壊で祭核が露出する。

## 主な変更ファイル

- データ/ロジック: `src/data/finalBoss.js`, `src/engine/finalBoss.js`
- 描画: `src/gfx/FinalBossModel.jsx`, `src/scene/FinalBossEffects.jsx`, `src/scene/Actors.jsx`, `src/scene/World.jsx`
- 統合: `src/engine/step.js`, `targets.js`, `webswing.js`, `save.js`, `sim.js`, `arena.js`, `bosses.js`, `src/main.jsx`
- UI: `src/ui/Hud.jsx`, `src/style.css`
- ビルド/テスト: `scripts/build-final-boss.py`, `scripts/final-boss-test.mjs`, `scripts/browser-check.mjs`, `package.json`
- 設計/レビュー: `docs/final-boss/`

## 使用素材

- `bosstiu/T-Pose.fbx`: 本体スキン
- `output/boss_textured.glb`, `output/textures/boss_basecolor.png`: 写真テクスチャ
- `bosstiu/Walking.fbx`, `Swagger Walk.fbx`, `Stomp.fbx`, `Throw Object.fbx`, `Swatting Bugs.fbx`, `Two Handed Sword Death.fbx`
- 出力: `public/assets/final-boss/final-boss.glb`（約15MB）と `manifest.json`

## アニメーション対応

| ゲーム名 | 素材 | 再生 |
|---|---|---|
| idle | Walking | loop 0.16x（非Tポーズの重心移動） |
| walk | Walking | loop 1.0x |
| swagger | Swagger Walk | once 1.0x |
| stomp | Stomp | once 1.0x |
| throw | Throw Object | once 1.35x |
| swat | Swatting Bugs | once 1.5x |
| death | Two Handed Sword Death | once 0.4x（約12秒） |

## 調整可能なパラメータ

- `src/data/finalBoss.js`: 全高、HP、部位半径/HP、足場サイズ、攻撃威力/予告/後隙、clip速度
- `src/engine/finalBoss.js`: 出現演出、歩行/旋回速度、搭乗距離、落下復帰先、フェーズ条件、報酬
- `src/engine/step.js`: final用カメラ距離プロファイル

## 既知の制限

- 最終ボスGLBは約15MB。初回出現時にのみ遅延ロードするが、低速回線では短い読込待ちが起こり得る。
- 最終戦の進行はオフライン/ホスト側で成立する。既存マルチプレイの通常要素は回帰済みだが、最終ボス部位状態のゲスト同期は今回の範囲外。
- 本作に独立したジャンプ操作はなく、身体上では移動・回避・ウェブを使用する。

## テスト結果

`14_TEST_REPORT.md` の全項目を通過。Claude Round 6はPASS、Blocker/Highは0件。production buildも成功。

## 今後の改善候補

- GLBのmeshopt/Draco圧縮とテクスチャKTX2化
- 最終ボス部位/足場状態のマルチプレイ同期
- 実端末での長時間プレイ結果に基づくHP・予告時間の微調整
