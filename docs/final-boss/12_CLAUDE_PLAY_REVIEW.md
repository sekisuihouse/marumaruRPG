LATEST DECISION: PASS（最終再レビューは末尾。初回REVISEの指摘と修正履歴を保持）

DECISION: REVISE（初回レビュー）

# 実装後レビュー — 祭典終端巨人「ティウ」（再レビュー）

基準: `00_SHARED_REQUIREMENTS.md` / `05_FINAL_CONCEPT.md` / `10_IMPLEMENTATION_PLAN.md` / `11_IMPLEMENTATION_LOG.md`
対象: 未コミットの作業ツリー差分（`git diff` 14ファイル + 新規 `src/data/finalBoss.js`, `src/engine/finalBoss.js`, `src/gfx/FinalBossModel.jsx`, `src/scene/FinalBossEffects.jsx`, `scripts/build-final-boss.py`, `scripts/final-boss-test.mjs`, `public/assets/final-boss/*`）
方法: コードとデータ（`manifest.json`、`bosstiu/`、テストスクリプト）の静的精査。**コードは変更していない。** `npm test` 等の再実行はサンドボックス承認待ちで完了できなかったため、`11_IMPLEMENTATION_LOG.md` の PASS 報告はコード内容と突き合わせる形で検証した（詳細は各指摘に記載）。

このファイルには以前 `DECISION: PASS` の簡易レビューが記録されていたが、静的コード精査で `bosstiu` 素材・`manifest.json`・`finalBoss.js` の挙動を直接確認したところ、中核要件を満たさない事実（Tポーズのまま静止する、部位破壊が見た目に反映されない、巨人が一切移動しない）が判明したため、本レビューで上書きし判定を `REVISE` に変更する。

## 総評

M0〜M9相当の骨格（出現条件、5段階フェーズ、部位HP、足場追従、ウェブ接続、セーブ復元、死亡演出、モバイル入力）は実装されており、ロジックレベルの `scripts/final-boss-test.mjs` は要件のハッピーパス（出現→すね破壊→登攀→導管4本→冠→核破壊→死亡→撃破）を一通りなぞれている。既存4ボス・通常ステージへの影響は最小限に抑えられており、`updateBosses`/`arena.js` の除外条件も既存ボスの分岐を壊していない。

しかし、`05_FINAL_CONCEPT.md` および `00_SHARED_REQUIREMENTS.md` の中核要件（#4 部位が「傷つき、壊れ、欠損する」見た目、#3 巨大な身体そのものが動く実感）に対して、**実際に見える体験**が要件を満たしていない。素材（`bosstiu/`）に含まれるアニメーションを確認した結果、「idle」として使われているクリップが実際には静止Tポーズであることが `manifest.json` で確認でき、これは通常表示のかなりの時間を占める。加えて、部位破壊の視覚的な差し替え（傷/断面/破片）が実装されておらず、ボス本体は攻撃を受けても見た目が一切変化しない。これらはプレイ体験の根幹に関わるため、BlockerとしてCodexへ差し戻す。

---

## 要件適合チェック

| 要件（00_SHARED_REQUIREMENTS §1） | 状態 | 備考 |
|---|---|---|
| 1. 4ボス撃破後にのみ出現 | ✅ | `allFourDefeated()` が `sim.bosses` 全滅 + `defeatedBossCount>=4` を確認（finalBoss.js:48, 101） |
| 2. 既存ボスの約10倍の大きさ | ✅ | `displayHeight: 36`、`FinalBossModel.jsx` で高さ36mへスケール補正 |
| 3. 身体へ乗り、登り、上で戦う | ⚠️ 部分適合 | 足場自体は実装されているが、身体が静止したまま動かないため「動く身体の上で戦う」体感が成立していない（Blocker 3） |
| 4. 攻撃部位が傷つき、壊れ、欠損する | ❌ 未達 | HP/フラグ上は破壊状態を持つが、見た目の損傷・欠損表現が一切ない（Blocker 2） |
| 5. 破壊部位が攻撃・移動・姿勢・戦術に影響 | ⚠️ 部分適合 | フェーズ遷移（すね→mounted、冠→blind、導管→core）は連動するが、個々の攻撃内容の変化（腕破壊で投擲数減少、すね破壊で旋回低下等）は未実装（High 2） |
| 6. `bosstiu` の3D/アニメを使用 | ✅ | `build-final-boss.py` が7クリップすべてを使用 |
| 7. 既存4ボス戦・通常ステージ・操作・カメラ・UI・セーブ・スマホを壊さない | ⚠️ 部分適合 | 既存ボスのロジックは概ね無傷。ただしモバイルのミニマップを新規に非表示化しており、既存機能を退行させている（Medium 1） |
| 8. 実際に遊べる状態まで実装 | ⚠️ 部分適合 | ロジックは完走できるが、上記の見た目の欠落により「遊べる」水準に達していない |

---

## 個別確認（プロトコル8.2 評価項目）

- **登場が弱くないか**: `assembling` 状態で8秒の演出、`say()` によるテキスト、burstエフェクトはあるが、専用カメラ以外の視覚的な「組み上がる」演出（パーツが集まる、光が収束するモデル変化）はテキストとエフェクトのみで、モデル自体は最初から完成形が突然フェードインする形（`group.visible = boss.spawned`、FinalBossModel.jsx:49）。演出としては弱い。
- **巨大さが伝わるか**: スケール自体は36mで確保されているが、後述のTポーズ問題で静止時の説得力が大きく損なわれる。
- **身体上での移動が楽しいか**: `updateMountedPlayer` の足場追従・クランプ処理自体は妥当（前後行列差分を先に適用してから入力を解決しており、`8.1`の必須事項に沿っている）。ただし土台となる巨人が静止しているため「動く足場」感が乏しい。
- **攻撃が見えるか**: 予兆エフェクト（`telegraph`）とタイマーは全攻撃で共通実装されており、これ自体は良好。
- **落下が理不尽でないか**: `tryMountNearby` の「地面からの腕ランプ」救済（finalBoss.js:198-203）は常時判定されており、落下しても比較的簡単に復帰できる。理不尽さは低い。
- **部位破壊が気持ちよいか**: ❌ 気持ちよさ以前に見た目の変化がない（Blocker 2）。
- **各フェーズが別物に感じるか**: ❌ Phase2（mounted）とPhase3（blind）で使用する攻撃セットが同一で、企画上の`blind_charge`が存在しない（High 1）。
- **カメラが壊れていないか**: プロファイル別の距離レンジ（`step.js:136`）は実装されているが、身体との衝突回避（`cameraDistance`関数の再利用）が巨大ボスのカプセル形状に対応しているかは確認できたが、肩・首等の「狭所」専用の追加ロジックは見当たらない（Low参照）。
- **プレイヤーが次に何をすべきか分かるか**: `say()` とHUDの `objective` 文言は各フェーズ切替時に出ており良好。
- **死亡がラスボスにふさわしいか**: 12秒の降下演出、手のひらへの着地、報酬・save反映は実装済みで妥当。ただし「死亡中にプレイヤー死亡」のケースにテレポート競合がある（Medium 2）。
- **既存4ボスからの集大成になっているか**: 導管の報酬アイテム連携（`breakPart`内の`sim.player.items[part.reward]`）は良い着想だが、実際にはダメージを与えないため効果を実感しにくい（High 3）。

---

## Blocker

### Blocker 1: 待機モーションが実質「Tポーズ静止」
- 対象箇所: `scripts/build-final-boss.py:18,122-125`、`public/assets/final-boss/manifest.json`（`idle` クリップ）、`src/engine/finalBoss.js:123`（`boss.anim = ... : 'idle'`）
- 問題: `bosstiu/` には `T-Pose.fbx, Walking.fbx, Swagger Walk.fbx, Stomp.fbx, Throw Object.fbx, Swatting Bugs.fbx, Two Handed Sword Death.fbx` の7ファイルしかなく、専用の待機モーションは存在しない。ビルドスクリプトは `T-Pose.fbx` を読み込んだ際のBlenderデフォルトアクションをそのまま `"idle"` と命名しており、`manifest.json` にも `"idle": {"source": "T-Pose.fbx", "duration": 0.067, "loop": true}` と記録されている。T-Poseは腕を真横に伸ばしたリギング用の基準姿勢であり、意味のある待機アニメーションではない。
- 体験への影響: `updateFinalBoss` は Phase2（mounted）・Phase3（blind）・Phase4（core）で攻撃待機中は常に `boss.anim = 'idle'` を使う（Phase1のみ`walk`）。つまり登攀〜核破壊までの大半の時間、36mの巨人が両腕を真横に広げて静止した「バグって見える」姿で立ち続ける。これは巨大感・敵としての説得力を根本から損なう。
- 再現手順: 1) `npm run build:final-boss` でGLBを生成済みの状態から、2) ゲーム内で4ボス撃破→最終ボス出現→すね破壊でPhase2へ移行、3) 攻撃と攻撃の間（`nextAttackAt`まで）の巨人の姿勢を確認する。`manifest.json`の`idle.duration:0.067`をブラウザで再生しても同じ結果になる。
- 修正案: `Walking.fbx`や`Swagger Walk.fbx`の先頭付近フレームを低速ループさせる、あるいはBlender側で簡易な呼吸ループを作成し、「idle」を実際の待機ポーズに差し替える。恒久対応が間に合わない場合でも、最低限Tポーズではない何らかの構え（例: `swagger`の最終フレームをholdする）へフォールバックすべき。
- 簡略版: `FINAL_CLIPS.idle` を `walk` の低速版（`timeScale`を0.15程度に落として微movementさせる）に差し替えるだけでも、静止Tポーズよりはるかに許容範囲になる。

### Blocker 2: 部位破壊の視覚的な差し替えが存在しない
- 対象箇所: `src/engine/finalBoss.js:278-288`（`breakPart`）、`src/gfx/FinalBossModel.jsx`（全体）、`src/scene/FinalBossEffects.jsx:6-23`（`PartMarker`）
- 問題: `05_FINAL_CONCEPT.md`は「各部位は `intact → wounded(50%) → broken(0%)`。オフラインでボーンウェイト別の外装サブメッシュを生成し、破壊時は外装を隠して断面・傷・最大4破片へ差し替える」ことを明記し、`00_SHARED_REQUIREMENTS.md #4`も「攻撃した場所に応じて、その部位が傷つき、壊れ、欠損する」ことを変更禁止の中核要件としている。しかし実装では `breakPart` が行うのは (a) 汎用の`burst`パーティクル1回、(b) `say()`のテキスト、(c) 導管の場合のみ`hazards`配列への追加、の3つだけで、本体メッシュ（`FinalBossModel.jsx`）に損傷を反映する処理は一切ない。`FinalBossEffects.jsx`の`PartMarker`も、破壊されると単に発光球を非表示にするだけの「弱点マーカーUI」であり、部位破壊の見た目そのものではない。事前生成されたwounded/broken用サブメッシュや断面・破片モデルも `build-final-boss.py`・`public/assets/final-boss/`のいずれにも存在しない（該当キーワード検索で0件）。
- 体験への影響: プレイヤーがすね・前腕・導管・冠・核をどれだけ攻撃しても、巨人の外見は最初から最後まで無傷のまま。部位のHPゲージとHUD上のマーカー消失でしか破壊を確認できず、「攻撃した場所に応じて壊れ、欠損する」という企画の核心的な快感が成立していない。
- 再現手順: 1) Phase2でいずれかの導管を攻撃してHPを0にする、2) `say()`テキストとburstエフェクトは出るが、モデルの該当箇所（肩・胸など）を見ても穴・断面・欠損などの変化が全くないことを目視確認できる。
- 修正案: `build-final-boss.py`で部位ボーンごとに外装サブメッシュを分離し、`wounded`/`broken`段階のメッシュ（または単純な傷デカール+断面リング）を生成してGLBに含める。ランタイム側は`breakPart`内で該当サブメッシュの`visible`切り替えと簡易破片（既存debrisプールへの追加）を行う。
- 簡略版: フル差し替えメッシュが間に合わなければ、`05_FINAL_CONCEPT.md`の「外装分離失敗」フォールバック（本体を残し傷・煙・断面リングで欠損表示）を先に実装する。少なくとも該当部位のマテリアルを暗色化する、持続的な煙パーティクルを追加する等、**恒久的に見た目へ残る**変化が最低限必要。

### Blocker 3: 巨人が出現後まったく移動・旋回しない
- 対象箇所: `src/engine/finalBoss.js:83-84`（`spawn()`内で`boss.pos`/`boss.yaw`を設定した後、他に代入箇所なし）、`updateFinalBoss`全体
- 問題: `boss.pos`と`boss.yaw`への代入は`spawn()`時の1回のみで、以降のフレームで一切更新されない（コード全体を検索して確認済み）。一方で`boss.anim`はPhase1で`'walk'`ループに設定される。つまり巨人は同じ場所に立ったまま「歩行モーションだけが空回りする」状態になり、脚が動いているのに位置が変わらないという明確な視覚破綻が起きる。
- 体験への影響: 企画の「ステージ: 6系統の足場が実ボーンへ追従し…」「敵: 予兆付き攻撃、追尾…を行う」という前提が崩れる。プレイヤーがどこへ移動しても巨人は振り向きも追跡もせず、`14_TEST_REPORT.md`で要求される「ボス歩行中」「ボス急旋回中」のテストケース自体が意味を持たない（歩行も旋回も発生しないため）。
- 再現手順: 1) 最終ボスを出現させ、Phase1のまま巨人の周囲を大きく回り込む、2) `walk`アニメーションが再生され続けるにもかかわらず巨人の位置・向きが一切変わらないことを確認する。
- 修正案: 最低限、プレイヤー方向への低速な旋回（`boss.yaw`をlerp）と、Phase1限定の小刻みな前後ステップ実装が必要。すでに`fallbackMatrix`や`syncFallbackParts`は`boss.yaw`変化に追従する設計になっているため、`boss.yaw`を毎フレーム更新する変更の影響範囲は比較的小さいはず。
- 簡略版: 旋回のみを実装し（並進移動は据え置き）、`walk`使用時だけごく短い足踏み風の位置揺れ（正弦波オフセット）を加えるだけでも「歩行モーションなのに静止」という破綻は緩和できる。

---

## High

### High 1: Phase3（盲目の巨人）専用攻撃 `blind_charge` が未実装
- 対象箇所: `src/engine/finalBoss.js:142-151`（`beginAttack`）
- 問題: `beginAttack`は`boss.phase === 1`と`boss.phase === 4`のみ専用分岐を持ち、それ以外（Phase2/3相当）はすべて`swat`/`shake`のどちらかを抽選する共通ロジックに落ちる。`05_FINAL_CONCEPT.md`のP3は「追尾攻撃が止まる代わりに`blind_charge`を使う」と明記しているが、対応する攻撃定義もロジックも`FINAL_ATTACKS`/`beginAttack`のどこにも存在しない。
- 体験への影響: 冠を破壊してPhase3に入っても、プレイヤー体験上はPhase2と全く同じ攻撃が続くだけで「フェーズが別物に感じるか」の評価軸を満たさない。
- 修正案: `FINAL_ATTACKS.blindCharge`を追加し、`beginAttack`に`boss.phase === 3`分岐を実装する（直線予兆→建物誘導可能なダッシュ、程度の簡易版でも可）。

### High 2: 部位破壊による攻撃・移動パラメータの変化が未実装
- 対象箇所: `src/data/finalBoss.js:32-38`（`FINAL_ATTACKS`）、`src/engine/finalBoss.js:169-180`（`executeAttack`）
- 問題: `05_FINAL_CONCEPT.md`の部位テーブルは「右前腕破壊: 投擲3→1」「左前腕破壊: 左払い半幅」「すね破壊: 旋回/歩行低下、膝つき延長」を明記しているが、`executeAttack`のいずれの分岐も`boss.parts.armR.broken`等を参照していない。腕・すねが壊れても、`updatePhase`によるフェーズ遷移（登攀許可）以外に攻撃・移動側の変化は一切起きない。
- 体験への影響: 「壊した部位によって、ラスボスの攻撃・移動・姿勢・戦術が変化する」という中核要件（#5）が、フェーズゲートのみで個別攻撃の変化としては未達成。
- 修正案: 少なくとも1〜2個（例: `armR.broken`のとき`throw`のダメージ回数/範囲を縮小）を実装し、以降は段階的に追加する。

### High 3: `conduit_backlash` が実際にはダメージを与えない
- 対象箇所: `src/engine/finalBoss.js:182-186`（`updateHazards`）、`278-288`（`breakPart`内のhazards追加）
- 問題: `breakPart`は導管破壊時に`boss.hazards`へエントリを追加するが、`updateHazards`はライフタイムを減算して配列から削除するだけで、`sim.player`との距離判定・ダメージ処理を一切行っていない。`05_FINAL_CONCEPT.md`が定義する`conduit_backlash: 1.2秒予兆、一度だけ36damage、安全帯へ回避`は、ダメージ源としては存在しない。
- 体験への影響: 対応する報酬アイテムを持っているかどうかで有利不利がつくはずの「4ボス撃破との接続」演出（企画上の目玉の一つ）が、実際には見た目とテキストだけの空撃ちになっている。
- 修正案: `updateHazards`内で`sim.player.finalBossPlatform`の有無や距離を見て、期限内に安全帯へ移動できていなければ1回だけ`hitPlayer`相当のダメージを与える処理を追加する。

### High 4: モバイル仮想ジョイスティックが `visibilitychange` で入力を戻さない
- 対象箇所: `src/ui/Hud.jsx:150-167`（`VirtualJoystick`）
- 問題: `05_FINAL_CONCEPT.md`は仮想ジョイスティックについて「pointerId捕捉、円形クランプ、pointerup/cancel/visibilitychangeで確実に0へ戻す」ことを明記しているが、実装は`onPointerUp`/`onPointerCancel`のみを処理しており、`document`の`visibilitychange`イベントを購読していない。`touch.move`はこの実装で新規に追加された唯一の書き込み元であり（既存コードには他の設定箇所なし）、`src/engine/input.js`側の既存`onVisibilityChange`は`clearKeys()`のみでキーボード入力しかリセットしない。
- 体験への影響: スマートフォンでスティックに指を置いたまま通知・アプリ切替・画面ロック等でタブが非表示になった場合（`pointercancel`が発火しない代表的なケース）、`touch.move`の値が残り続け、復帰後もプレイヤーが勝手に移動し続ける。既存ボス戦・通常ステージを含む全モバイル操作に影響する退行的リスク。
- 再現手順: 1) モバイル幅（`<760px`）でスティックを押しっぱなしにする、2) タブを非表示にする（`document.hidden`をトリガーする操作、またはdevtoolsで`visibilitychange`を手動発火）、3) 戻ってきても指を離すまで`touch.move`が非ゼロのままである、または指を離しても既にイベントが発火せず0に戻らない挙動をコードから確認できる。
- 修正案: `VirtualJoystick`の`useEffect`で`document.addEventListener('visibilitychange', up)`を追加し、アンマウント時に解除する。

---

## Medium

### Medium 1: モバイルのミニマップを丸ごと非表示化（既存機能の退行）
- 対象箇所: `src/style.css`（`@media(max-width:760px)`ブロック、`.minimap{display:none}`への変更）
- 問題: 変更前は`.minimap{left:12px;bottom:12px}`でモバイルでも表示されていたが、本差分で`.minimap{display:none}`に置き換わっている。仮想ジョイスティック（`left:18px;bottom:172px`）との重なりを避けるためと推測されるが、最終ボスと無関係な通常プレイのモバイル体験からミニマップという既存機能を削っている。
- 体験への影響: `00_SHARED_REQUIREMENTS.md §2.2`「既存機能を消して解決しない」および完成条件「既存ボスと通常ゲームが壊れていない」に抵触するモバイル回帰。
- 修正案: ミニマップを縮小・移動する（例: 右下や右上へ寄せる）ことでジョイスティックとの共存を図る。

### Medium 2: 死亡演出中にプレイヤーが死亡すると位置がバッティングする
- 対象箇所: `src/engine/finalBoss.js:112-116`（`updateFinalBoss`の`state === 'death'`分岐）、`247-249`（`landPlayerOnHand`）、`src/engine/step.js:152-162`（プレイヤー死亡/リスポーン処理）
- 問題: `death`状態のとき`updateFinalBoss`は`sim.player.dead`を確認せず、`stateTime>=8`で無条件に`landPlayerOnHand`（`mountPlayer`で位置を強制上書き）を呼ぶ。仮にこのタイミングでプレイヤーが別要因（落下ダメージ等）で死亡していた場合、死亡中の演出中に位置だけ手のひらへ移動し、その後`step.js`側の`resetPlayer(true)`（respawnTimer満了時）が町の初期地点へ再度テレポートする、という二重の強制移動が同一の死亡シーケンス中に起こり得る。
- 体験への影響: `14_TEST_REPORT.md`が要求する「死亡中にプレイヤー死亡」ケースで見た目のテレポート競合が発生し、演出の余韻を壊す可能性がある。
- 修正案: `landPlayerOnHand`呼び出し前に`!sim.player.dead`を条件に加える、またはプレイヤー死亡中は死亡シーケンスの`finishFinalBoss`だけ進めてプレイヤー位置操作をスキップする。

### Medium 3: `npm run test:final-boss` 等の再実行による裏取りができていない
- 対象箇所: `11_IMPLEMENTATION_LOG.md`の「Claude実機レビュー前の検証」節
- 問題: 本レビューではサンドボックスの承認待ちで`npm test` / `npm run test:final-boss` / `npm run build` / `npm run test:browser`を再実行できず、ログに記載されたPASS報告をコードリーディングでのみ裏取りした（ロジック面は`scripts/final-boss-test.mjs`の内容から妥当と判断できたが、実ブラウザでの描画・カメラ・入力は未確認）。
- 修正案: Codex側で再度上記4コマンドを実行し、結果（特に`npm run test:browser`のfinalBoss関連チェックの実出力）を`13_CODEX_FIX_REPORT.md`または本ログに残す。

---

## Low

- T-Poseフォールバックの根本原因はbosstiu素材に専用idleが存在しないこと（Blocker 1参照）。今後同種のモデルを追加する際は、企画確定前に「idleに使えるクリップがあるか」を`01_CODEX_CONCEPT.md`の調査項目に明示的に加えるとよい。
- カメラの「肩・首周辺の狭所」専用の衝突回避（`05_FINAL_CONCEPT.md §10.2`）が、既存`cameraDistance`の汎用線分交差以外に見当たらない。現状の巨人が静止している間は大きな問題になりにくいが、Blocker 3を修正して巨人が動き出すと露呈する可能性がある。
- リポジトリ直下に本ラウンド作業に無関係と思われる未追跡ファイル（`T ポーズ.png`, `tiutiu.png`, `haimen.png`, `white_mesh.glb`, `scripts/__pycache__/`, `scripts/texture_boss.py`）が残っている。完成条件の「一時的なダミー実装を最終成果物として残さない」に沿って、最終コミット前に要不要を仕分けることを推奨する。

---

## Blocker/Highの有無

Blocker 3件、High 4件が残っている。プロトコル8.3の規定どおり、**この状態を完成扱いにしない**。特にBlocker 1・2は素材とデータ（`manifest.json`、`bosstiu/`、`FinalBossModel.jsx`/`FinalBossEffects.jsx`のロジック）から直接確認できる事実であり、演出・企画意図（05_FINAL_CONCEPT.mdの「気持ちよさ」「巨大感」）を裏切る根本的なギャップである。

## Codexへの宿題（優先順）

1. Blocker 1: idleクリップの差し替え（最低限、Tポーズでない構えへ）
2. Blocker 3: `boss.yaw`のプレイヤー追従・簡易歩行揺れの追加
3. Blocker 2: 部位破壊の視覚的差し替え（フル実装が間に合わなければ`05_FINAL_CONCEPT.md`のフォールバック仕様＝傷・煙・断面リング表示で暫定対応）
4. High 4: `VirtualJoystick`への`visibilitychange`リスナー追加（実装コストが最も低く、モバイル回帰リスクが高いため優先度を上げて先に潰すことを推奨）
5. High 1〜3: フェーズ・部位破壊の攻撃側フィードバックの実装
6. Medium 1・2の反映

---

# Claude 最終再レビュー

## DECISION: PASS

前回のBlocker 3件・High 4件はすべて解消済み。

- Tポーズ待機は `Walking.fbx` の0.16倍・1.9秒ループへ置換。
- `PartDamageVisual` が wounded/broken の傷、焼損孔、断面リング、煙、破片を骨座標へ恒久表示。
- `updateLocomotion` がPhase 1の追跡歩行と全登攀フェーズの旋回を実行。すね破壊で速度低下。
- Phase 3固有の `blindCharge` を実装・テスト。
- 右腕、両腕、冠、すね破壊が攻撃選択・隙・移動へ影響。
- 導管backlashは範囲内へ36 damageを与え、テストでHP減少を確認。
- 仮想ジョイスティックは `visibilitychange` で0へ戻る。
- ミニマップはモバイルでも位置を移して維持。
- 死亡中プレイヤーを手のひらへ移動しない条件を追加。

### 残存Blocker / High / Medium

ゼロ件。
