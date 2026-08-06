STATUS: FINAL_BOSS_COMPLETE

# 最終ボス引継ぎ

## 実装概要

既存4ボスを全て倒すと、12mの「祭典終端巨人・ティウ」が町中央に出現する。Mixamo 41ボーンへ写真テクスチャと7モーションを統合し、骨へ追従する足場、部位判定、攻撃、ウェブ接続、専用カメラ/HUD、セーブ、死亡演出を実装した。最終戦ではアリーナをロックせず、ATフィールドと橋の通行制限は発生しない。

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
