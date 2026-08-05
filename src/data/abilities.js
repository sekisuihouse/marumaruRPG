/**
 * 後半で解放される特殊アクションの設定。
 * 数値はすべてここに集約し、engine 側にはハードコードしない。
 */

/** 連続火球（最終攻撃）。ボタンを押している間、熱量を消費して連射する。 */
export const FIRE_STREAM = {
  id: 'firestream',
  label: '☄ 連続火球',
  key: '4 → R長押し',
  unlockLevel: 8,
  /** 発射間隔(s) */
  interval: 0.12,
  power: 22,
  element: 'fire',
  kind: 'magic',
  knockback: 2.2,
  speed: 42,
  range: 46,
  /** 着弾時の小範囲爆発 */
  blastRadius: 2.6,
  blastPower: 16,
  /** 建物への倍率（部品を連続で吹き飛ばせるように少し高め） */
  structureMul: 1.6,
  /** 破片へ与える衝撃 */
  debrisImpulse: 1.5,
  /** 熱量。1発ごとに heatPerShot 増え、毎秒 cool 減る。max を超えるとオーバーヒート。 */
  heat: { max: 100, perShot: 5.5, cool: 26, overheatCooldown: 2.6 },
  /** MPも少しだけ食う（無限連射の防止） */
  mpPerShot: 0.6,
  /** 自分の足元で爆発して操作不能にならないための最低安全距離(m) */
  minSafeDistance: 3.2,
  /** 弾のプール上限 */
  poolSize: 48,
  clip: 'cast',
}

/** ウェブスイング（糸移動） */
export const WEB_SWING = {
  id: 'webswing',
  label: '🕸 ウェブスイング',
  key: 'Q長押し',
  unlockLevel: 6,
  /** 接続可能な最大距離(m) */
  maxDistance: 62,
  minDistance: 3.5,
  /** カメラ中心からの探索角(度)。この円錐内から接続先を選ぶ。 */
  aimCone: 30,
  /**
   * 高所優先。円錐内を複数方向へ走査し、プレイヤーより
   * preferHeight(m) 以上高い接続点があればそちらを優先する。
   */
  preferHeight: 6,
  /** これ未満の高さしかない場所には付かない（足元の壁に貼り付かない） */
  minHeight: 1.8,
  /** 上方向へどれだけ余分に探すか(度) */
  upwardBias: 34,
  /** 走査するリング数と1リングあたりの方向数（多いほど当てやすいが重い） */
  rings: 3,
  perRing: 8,

  // ── 離した瞬間に接続点まで飛んでいく（ジップ）
  zip: {
    /** 到達速度(m/s) */
    speed: 42,
    /** 到達速度までの加速(m/s^2) */
    accel: 130,
    /** この距離まで近づいたら到着とみなす(m) */
    arriveRadius: 2.6,
    /** 接続点を越えたあとに残す勢い（1で等速） */
    exitKeep: 0.85,
    /** 到着時の跳ね上がり(m/s)。屋根の上へ飛び出せる。 */
    exitLift: 7.5,
    /** 保険のタイムアウト(s) */
    timeout: 2.6,
    /** ジップ中の重力（0で完全な直進） */
    gravity: 3.0,
  },
  /** 糸が引く力（加速度 m/s^2）。落下より接続点への牽引を優先する。 */
  pull: 58,
  /** 接続中の重力。通常落下よりかなり弱くし、糸でまっすぐ飛びやすくする。 */
  attachedGravity: 5.5,
  /** Qを押している間の自動巻き取り速度(m/s)。 */
  autoReelSpeed: 24,
  /** 接続直後に確保する前進速度と、接続点へ向けた速度補正。 */
  attachMinSpeed: 15,
  attachAccel: 82,
  attachSteer: 7.5,
  /** 前後入力での巻き取り／繰り出し速度(m/s) */
  reelIn: 9,
  reelOut: 7,
  minRope: 3.0,
  /** 横入力のスイング補助 */
  lateral: 12,
  /** 速度上限(m/s)。壁への高速衝突で操作不能にならないよう抑える。 */
  maxSpeed: 34,
  /** 糸を張った瞬間の跳ね上がり（地上から撃っても引きずられない） */
  launchLift: 9,
  /** 発射直後に着地判定を無視する時間(s) */
  launchGrace: 0.8,
  /** 解除時に上乗せする跳び出し */
  releaseBoost: 1.18,
  releaseLift: 3.4,
  /** 空気抵抗 */
  drag: 0.12,
  gravity: 20,
  /** 着地後に再度撃てるまで */
  cooldown: 0.25,
  /** 短距離では振り子ではなく軽い引き寄せにする距離 */
  shortRange: 7,
  shortPull: 46,
  /** 地面・壁への衝突時に残す速度の割合 */
  crashKeep: 0.35,
}

/** 爽快感（ヒットストップ・カメラシェイク・スロー）の基準値 */
export const JUICE = {
  /** 規模 0..1 に対する各演出の最大値 */
  hitstopMax: 0.09,
  shakeMax: 0.9,
  slowmoMax: 0.35,
  slowmoScale: 0.35,
  /** 通常攻撃は揺らさない。これ未満の規模はシェイクしない。 */
  shakeFloor: 0.28,
  /** 画面中央から広がる衝撃波を出す規模 */
  shockwaveFloor: 0.55,
  dustPerScale: 6,
}
