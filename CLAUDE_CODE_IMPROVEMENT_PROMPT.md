# Claude Codeへの修正・改善プロンプト

`/Users/sekine/marugoto-degub` のReact Three Fiberゲームを改善してください。既存の町GLBと Ultimate Modular Men FBX素材を維持し、デザインを壊さず、以下を実装してください。

1. `bunbetu.md`を仕様の根拠に、Punk/Swat/SpaceSuit/King/WorkerそれぞれへHP・属性耐性・攻撃間隔・索敵距離・逃走/狂暴化・役割をデータ駆動で実装する。
2. 敵の近接、魔法、範囲魔法、弓、回復を実際に敵AIが使い、主人公のHP、盾ブロック、ノックバック、死亡とリスポーンを実装する。
3. WASD移動はカメラ相対にし、町の地面コライダーとNavMeshで川・建物を通り抜けないようにする。
4. FBX部位をGLBへ最適化した上で、idle/walk/run/attack/hit/deathアニメーションをキャラクター状態に応じてクロスフェードする。
5. クエスト、会話選択肢、localStorageセーブ、ミニマップ、アクセシビリティ対応のキーボード説明を追加する。

変更後は `npm run build` を実行し、エラーを全て直してください。各変更の理由・テスト結果・残課題を日本語で簡潔に報告してください。
