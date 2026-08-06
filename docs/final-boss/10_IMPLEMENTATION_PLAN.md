# ラスボス実装計画

基準: `05_FINAL_CONCEPT.md`

## 変更対象

- 新規: `src/data/finalBoss.js`, `src/engine/finalBoss.js`, `src/gfx/FinalBossModel.jsx`, `src/scene/FinalBossEffects.jsx`, `src/ui/VirtualJoystick.jsx`, `scripts/build-final-boss.py`。
- 変更: `package.json`, `src/engine/sim.js`, `step.js`, `targets.js`, `webswing.js`, `save.js`, `src/scene/World.jsx`, `Actors.jsx`, `ThirdPersonCamera.jsx`, `src/ui/Hud.jsx`, `src/style.css`, `scripts/smoke-test.mjs`。
- 生成: `public/assets/final-boss/final-boss.glb`, `manifest.json`。

## 再利用

- 既存4ボスの `bossProgress`、撃破報酬、arenaロック、BGM、HUD snapshot。
- `CharacterModel.jsx` のAnimationMixer/clipAction/クロスフェード方式。
- `targets.js` の共通攻撃入口と既存player damage。
- `webswing.js` の空中物理、`save.js` の安全な復元、Effectsの既存予兆表現。

## 状態・データ

- `sim.finalBoss`: spawned/alive/defeated/state/phase/hp/maxHp/pos/yaw/action/checkpoint/parts/platforms/anchors/deathTime。
- partsはHP/state/brokenAt、platformsは前後Matrix・OBB・安全点、anchorsはboneローカル点。
- 状態機械は locked→assembling→ground→kneeling→mounted→blind→core→death→defeated。

## 素材とアニメーション

- BlenderでT-Poseの41ボーンスキンへ既存BossUVと2K画像を移植。
- 6アニメFBXを同名骨格へActionとして統合。Hips水平root motion除去。
- manifestに論理名、実clip名、尺、loop、speed、イベント正規化時間を保存。
- ランタイム巨大化はルートscaleで身長36mへ。骨格自体は変更しない。

## 足場・Collider・攻撃

- 6系統/最大9 OBBを主要ボーンへ追従。前後行列差を接地プレイヤーへ先に適用。
- 部位は球/カプセル最大9。近接点/弾線分を最寄り部位へ割り当てる。
- 外装欠損はサブメッシュまたは発光傷/断面の段階表示。破片は既存上限へ加算。
- 攻撃発生はclip正規化時間と独立ロジックtimerの両方を持ち、clip欠損でも成立。

## UI・音・カメラ・スマホ

- 全体HP、部位ゲージ、目的、部位マーカーを既存HUDへ追加。
- BGMは既存bossChase、演出差は音量/フィルタで行い、欠損停止を避ける。
- camera profileを追加し、静的cameraDistance + 動的部位カプセル遮蔽を合成。
- `VirtualJoystick` が既存 `touch.move` をpointer入力で駆動。pointercancel/非表示/resize時に必ず解除。

## セーブ・ネット・ロールバック

- finalBossのphase checkpoint・parts・撃破/初回演出を保存。旧セーブは既定値へ。
- host snapshotには粗いstate/part HPを追加できる形にするが、単体完成を先行。
- 新規モジュールは初期化しなければ既存挙動へ影響しない。モデル失敗時は手続きシルエットへフォールバック。

## マイルストーン

- M0 素材と既存構造の検証: Blender統合GLB、manifest、モデル検証テスト。
- M1 読み込み/待機: 独立data/state/model、デバッグ強制出現。
- M2 出現: 4ボス撃破条件、assembling、arena/BGM。
- M3 アニメ/移動: Mixer、clip mapping、歩行/踏みつけ/投擲。
- M4 足場: bone追従OBB、接地差分、落下安全復帰。
- M5 基本攻撃: 予兆、damage、回避窓。
- M6 部位damage: 3D hit、HP、HUD。
- M7 部位破壊: 傷/断面/破片、攻撃変化。
- M8 phase: 導管、冠、核、各状態遷移。
- M9 死亡/撃破: 0.4倍死亡、身体降下、save/replay。
- M10 演出/UI/音: 目的、部位表示、色/粉塵/BGM。
- M11 スマホ/性能: 仮想ジョイスティック、low設定、上限検証。
- M12 回帰: smoke/browser/build、全フェーズ、高火力、reload、resize、連続再戦。

各Mでコード変更、関連自動テスト、build、実行確認を行い `11_IMPLEMENTATION_LOG.md` に記録する。
