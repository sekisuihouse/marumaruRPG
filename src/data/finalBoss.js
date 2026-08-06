import { assetUrl } from './world.js'

export const FINAL_BOSS = Object.freeze({
  id: 'final', name: '祭典終端巨人・ティウ', modelPath: assetUrl('assets/final-boss/final-boss.glb'),
  displayHeight: 0.36, sourceRigBoundsRatio: 5.03, baseHp: 3600, color: '#ffcf70',
  rewardItems: ['prototype_core', 'stage_pass', 'boundary_seal', 'chef_medal'],
})

/**
 * 骨がまだ読み込まれていない間だけ使う仮の全高。
 * 判定は updateFinalBossTransforms が骨のワールド座標から測り直した
 * boss.visualHeight を使うので、モデルの拡大率を変えても見た目とズレない。
 */
export const FINAL_FALLBACK_HEIGHT = 0.36

/**
 * 骨名の照合キー。GLTFLoader は 'mixamorig:Hips' を 'mixamorigHips' のように
 * 書き換えるため、記号と大小文字を落としてから突き合わせる。
 * これを通さずに書き出し名で直接引くと、骨が一件も見つからず全身が仮位置のままになる。
 */
export const boneKey = (name) => String(name).toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * 「ここを攻撃しろ」の主要部位。壊れたら二度と再生しない。
 *   radius … 全高に対する比率（実寸は visualHeight を掛けて求める）
 *   at     … 骨が無いときの仮位置。全高に対する [x, y, z] の比率。
 *            骨が来たときに位置が飛ばないよう、下の FINAL_BODY_DEFS の
 *            同じ骨の座標とそろえてある。
 */
export const FINAL_PART_DEFS = Object.freeze({
  shinL: { id: 'shinL', label: '左ひざ', hp: 420, bone: 'mixamorig:LeftLeg', radius: 0.085, at: [-0.058, 0.285, 0], role: 'shin', color: '#ff8a4c' },
  shinR: { id: 'shinR', label: '右ひざ', hp: 420, bone: 'mixamorig:RightLeg', radius: 0.085, at: [0.058, 0.285, 0], role: 'shin', color: '#ff8a4c' },
  armL: { id: 'armL', label: '左前腕', hp: 360, bone: 'mixamorig:LeftForeArm', radius: 0.075, at: [-0.16, 0.58, 0], role: 'arm', color: '#ffb45c' },
  armR: { id: 'armR', label: '右前腕', hp: 360, bone: 'mixamorig:RightForeArm', radius: 0.075, at: [0.16, 0.58, 0], role: 'arm', color: '#ffb45c' },
  conduitStudent: { id: 'conduitStudent', label: '試作導管', hp: 180, bone: 'mixamorig:Spine1', radius: 0.05, at: [0, 0.645, 0], role: 'conduit', color: '#72e4ff', reward: 'prototype_core' },
  conduitStage: { id: 'conduitStage', label: '共鳴導管', hp: 180, bone: 'mixamorig:LeftShoulder', radius: 0.05, at: [-0.05, 0.79, 0], role: 'conduit', color: '#f36fff', reward: 'stage_pass' },
  conduitShrine: { id: 'conduitShrine', label: '境界導管', hp: 180, bone: 'mixamorig:RightShoulder', radius: 0.05, at: [0.05, 0.79, 0], role: 'conduit', color: '#ffd36a', reward: 'boundary_seal' },
  conduitFood: { id: 'conduitFood', label: '灼熱導管', hp: 180, bone: 'mixamorig:Spine2', radius: 0.05, at: [0, 0.715, 0], role: 'conduit', color: '#ff7b3f', reward: 'chef_medal' },
  crown: { id: 'crown', label: '視界冠', hp: 300, bone: 'mixamorig:Head', radius: 0.067, at: [0, 0.88, 0], role: 'crown', color: '#f5edff' },
  core: { id: 'core', label: '胸の祭壇', hp: 900, bone: 'mixamorig:Spine2', radius: 0.072, at: [0, 0.715, 0], role: 'core', color: '#fff1a8' },
})

/**
 * ボスの身体そのものの当たり判定。骨と骨をつないだカプセルで、
 * 「専用の足場」ではなく見えている身体の上に直接立てるようにする。
 * 建物と同じく破壊でき、壊した穴はフェーズに応じた時間で塞がる。
 *
 *   a, b   … カプセルの両端の骨
 *   from/to … 骨が無いときの仮位置。全高に対する [x, y, z] の比率
 *   radius … 全高に対する太さの比率
 */
export const FINAL_BODY_DEFS = Object.freeze([
  { id: 'hips', label: '腰', a: 'mixamorig:Hips', b: 'mixamorig:Spine', from: [0, 0.53, 0], to: [0, 0.58, 0], radius: 0.1, hp: 320 },
  { id: 'waist', label: '胴', a: 'mixamorig:Spine', b: 'mixamorig:Spine1', from: [0, 0.58, 0], to: [0, 0.645, 0], radius: 0.095, hp: 300 },
  { id: 'chest', label: '胸郭', a: 'mixamorig:Spine1', b: 'mixamorig:Spine2', from: [0, 0.645, 0], to: [0, 0.715, 0], radius: 0.098, hp: 320 },
  { id: 'neck', label: '首', a: 'mixamorig:Spine2', b: 'mixamorig:Neck', from: [0, 0.715, 0], to: [0, 0.82, 0], radius: 0.06, hp: 220 },
  { id: 'skull', label: '頭部', a: 'mixamorig:Neck', b: 'mixamorig:Head', from: [0, 0.82, 0], to: [0, 0.88, 0], radius: 0.075, hp: 260 },
  { id: 'shoulderL', label: '左肩', a: 'mixamorig:LeftShoulder', b: 'mixamorig:LeftArm', from: [-0.05, 0.79, 0], to: [-0.13, 0.775, 0], radius: 0.07, hp: 260 },
  { id: 'shoulderR', label: '右肩', a: 'mixamorig:RightShoulder', b: 'mixamorig:RightArm', from: [0.05, 0.79, 0], to: [0.13, 0.775, 0], radius: 0.07, hp: 260 },
  { id: 'upperArmL', label: '左上腕', a: 'mixamorig:LeftArm', b: 'mixamorig:LeftForeArm', from: [-0.13, 0.775, 0], to: [-0.16, 0.58, 0], radius: 0.062, hp: 250 },
  { id: 'upperArmR', label: '右上腕', a: 'mixamorig:RightArm', b: 'mixamorig:RightForeArm', from: [0.13, 0.775, 0], to: [0.16, 0.58, 0], radius: 0.062, hp: 250 },
  { id: 'foreArmL', label: '左腕', a: 'mixamorig:LeftForeArm', b: 'mixamorig:LeftHand', from: [-0.16, 0.58, 0], to: [-0.17, 0.41, 0], radius: 0.055, hp: 230 },
  { id: 'foreArmR', label: '右腕', a: 'mixamorig:RightForeArm', b: 'mixamorig:RightHand', from: [0.16, 0.58, 0], to: [0.17, 0.41, 0], radius: 0.055, hp: 230 },
  { id: 'handL', label: '左手', a: 'mixamorig:LeftHand', b: 'mixamorig:LeftHandIndex1', from: [-0.17, 0.41, 0], to: [-0.17, 0.355, 0.01], radius: 0.052, hp: 200 },
  { id: 'handR', label: '右手', a: 'mixamorig:RightHand', b: 'mixamorig:RightHandIndex1', from: [0.17, 0.41, 0], to: [0.17, 0.355, 0.01], radius: 0.052, hp: 200 },
  { id: 'thighL', label: '左もも', a: 'mixamorig:LeftUpLeg', b: 'mixamorig:LeftLeg', from: [-0.055, 0.52, 0], to: [-0.058, 0.285, 0], radius: 0.078, hp: 320 },
  { id: 'thighR', label: '右もも', a: 'mixamorig:RightUpLeg', b: 'mixamorig:RightLeg', from: [0.055, 0.52, 0], to: [0.058, 0.285, 0], radius: 0.078, hp: 320 },
  { id: 'calfL', label: '左すね', a: 'mixamorig:LeftLeg', b: 'mixamorig:LeftFoot', from: [-0.058, 0.285, 0], to: [-0.06, 0.045, 0], radius: 0.064, hp: 300 },
  { id: 'calfR', label: '右すね', a: 'mixamorig:RightLeg', b: 'mixamorig:RightFoot', from: [0.058, 0.285, 0], to: [0.06, 0.045, 0], radius: 0.064, hp: 300 },
  { id: 'footL', label: '左足', a: 'mixamorig:LeftFoot', b: 'mixamorig:LeftToeBase', from: [-0.06, 0.045, 0], to: [-0.06, 0.012, 0.07], radius: 0.058, hp: 260 },
  { id: 'footR', label: '右足', a: 'mixamorig:RightFoot', b: 'mixamorig:RightToeBase', from: [0.06, 0.045, 0], to: [0.06, 0.012, 0.07], radius: 0.058, hp: 260 },
])

/**
 * 壊した身体が塞がるまでの秒数。添字がフェーズで、進むほど再生が遅くなる。
 * PHASE5（祭壇破壊後）は再生しない。
 */
export const FINAL_BODY_RESPAWN = Object.freeze([5, 5, 7.5, 10, 14])

/**
 * 身体の小片ひとつぶんの設定。町の建物(destructibles)と同じ壊れ方をさせる。
 *   hp             … 小片の耐久
 *   chainRatio     … 連鎖破壊が届く距離（小片半径に対する倍率）
 *   chainDamage    … 連鎖で隣へ渡すダメージの割合
 *   material       … 破片・粉塵・破壊音の材質（MATERIALS のキー）
 *   collapseRatio  … カプセルの小片がこの割合壊れると、足場としても抜け落ちる
 *   deathRatio     … PHASE5 で身体がこの割合まで削れたら崩れ落ちる
 */
export const FINAL_CHUNK = Object.freeze({
  hp: 45, chainRatio: 2.1, chainDamage: 0.55, material: 'stone',
  collapseRatio: 0.6, deathRatio: 0.92,
})

/** フェーズごとの「いま何をすればいいか」。画面中央に数秒表示する。 */
export const FINAL_PHASE_OBJECTIVES = Object.freeze({
  1: '左右どちらかの「ひざ」を破壊しろ',
  2: '身体をよじ登り、4本の祭導管を破壊しろ',
  3: '視界冠と残る祭導管を破壊しろ',
  4: '胸の祭壇を破壊しろ',
  5: '再生は止まった。身体を残らず破壊しろ',
})

export const FINAL_ATTACKS = Object.freeze({
  stomp: { id: 'stomp', label: '町割り踏み', windup: 1.25, recover: 2.8, radius: 0.12, damage: 42, anim: 'stomp' },
  throw: { id: 'throw', label: '祭具投擲', windup: 1.6, recover: 1.7, radius: 0.08, damage: 34, anim: 'throw' },
  swat: { id: 'swat', label: '虫払い', windup: 0.9, recover: 1.8, damage: 30, anim: 'swat' },
  shake: { id: 'shake', label: '振り落とし', windup: 0.8, recover: 1.4, damage: 0, anim: 'swat' },
  pulse: { id: 'pulse', label: '祭壇鼓動', windup: 1.1, recover: 1.4, damage: 38, anim: 'idle' },
  blindCharge: { id: 'blindCharge', label: '盲進崩し', windup: 1.45, recover: 2.4, radius: 0.09, damage: 40, anim: 'swagger' },
})

export const FINAL_CLIPS = Object.freeze({
  idle: { loop: true, speed: 0.16 }, walk: { loop: true, speed: 1 }, swagger: { loop: false, speed: 1 },
  stomp: { loop: false, speed: 1 }, throw: { loop: false, speed: 1.35 }, swat: { loop: false, speed: 1.5 }, death: { loop: false, speed: 0.4 },
})
