/**
 * 敵データ定義。bunbetu.md の各章を「1データ = 1敵種」に落としたもの。
 *
 * 参照した章:
 *   1 基本ステータス  → stats
 *   2 属性・耐性      → element / weakness / resist / status
 *   3 攻撃方法        → attacks[]
 *   4 AI・行動パターン → ai
 *   5 感知能力        → senses
 *   6 移動能力        → stats.walkSpeed / runSpeed
 *   7 防御行動        → defense
 *  10 戦闘フェーズ    → phases
 *  11 集団での役割    → role
 *  12/13 生息環境・出現条件 → spawn
 *  16 ドロップ・報酬  → drops
 *  18 個体差          → variants
 *  19 見た目          → look
 *
 * ゲーム側(src/scene/enemyAi.js)はこの構造だけを読むので、
 * ここに1エントリ足せば新しい敵が増える。
 */

import { FIRE_STREAM, WEB_SWING } from './abilities.js'

/**
 * 敵の全体バランス（遊びやすさ調整）。
 * 個々の敵定義（stats/attacks）は素の設計値のまま残し、ここの倍率だけで弱体化する。
 * ボス・上位敵は bossRoleTags で緩和率を下げられる。
 */
export const ENEMY_BALANCE = {
  hpMul: 0.70,            // HP 70%
  attackMul: 0.75,        // 攻撃力 75%
  frequencyMul: 0.85,     // 攻撃頻度 85%（＝攻撃間隔 1/0.85 倍）
  windupMul: 1.18,        // 攻撃予告を少し長く
  /** 同時に積極攻撃してよい敵の数 */
  maxAggressive: 2,
  /** プレイヤーが連続でひるまされない最短間隔(s) */
  staggerImmunity: 1.5,
  /** レベルがこれ以下の敵は序盤の敵として更に弱くする */
  earlyLevel: 6,
  earlyHpMul: 0.82,
  earlyAttackMul: 0.85,
  /** ボス・上位敵は弱体化を緩める（1 = 弱体化そのまま、0 = 弱体化しない） */
  bossRoleTags: ['healer'],
  bossRelief: 0.45,
}

/** roleTag からボス扱いか判定し、弱体化の効き具合を返す */
const relief = (def) => (ENEMY_BALANCE.bossRoleTags.includes(def.roleTag) ? ENEMY_BALANCE.bossRelief : 0)
const blend = (mul, def) => 1 + (mul - 1) * (1 - relief(def))
const isEarly = (def) => (def.stats.level ?? 99) <= ENEMY_BALANCE.earlyLevel

export const enemyHpMul = (def) => blend(ENEMY_BALANCE.hpMul, def) * (isEarly(def) ? ENEMY_BALANCE.earlyHpMul : 1)
export const enemyAttackMul = (def) => blend(ENEMY_BALANCE.attackMul, def) * (isEarly(def) ? ENEMY_BALANCE.earlyAttackMul : 1)
export const enemyIntervalMul = (def) => 1 / blend(ENEMY_BALANCE.frequencyMul, def)
export const enemyWindupMul = (def) => blend(ENEMY_BALANCE.windupMul, def)

export const ELEMENTS = {
  physical: { label: '物理', color: '#d8dee9' },
  fire: { label: '火', color: '#ff8a4c' },
  water: { label: '水', color: '#4cc4ff' },
  ice: { label: '氷', color: '#a5e9ff' },
  thunder: { label: '雷', color: '#ffe14c' },
  wind: { label: '風', color: '#9ff0c4' },
  earth: { label: '土', color: '#c69c6d' },
  light: { label: '光', color: '#fff3c4' },
  dark: { label: '闇', color: '#a071e8' },
}

/** 攻撃の種類。kind ごとに enemyAi.js の実行処理が決まる。 */
export const ATTACK_KINDS = ['melee', 'heavy', 'charge', 'arrow', 'magic', 'aoe', 'heal', 'buff', 'trap']

const enemy = (def) => def

export const ENEMY_TYPES = {
  // ───────────────────────────────── 斥候 / 弓兵
  Punk: enemy({
    id: 'Punk',
    name: '疾風パンク',
    role: '斥候 / 弓兵',
    roleTag: 'archer',
    look: { color: '#f14b7c', scale: 1.0, gear: { bow: true } },
    stats: {
      maxHp: 70, attack: 14, defense: 6, magicAttack: 4, magicDefense: 5,
      walkSpeed: 2.6, runSpeed: 6.4, attackInterval: 1.5,
      staggerResist: 0.1, knockbackResist: 0.15, knockback: 1.6,
      hitRadius: 0.41, weight: 62, level: 3,
    },
    element: 'wind',
    weakness: { earth: 0.5, thunder: 0.25 },   // 土と雷に弱い
    resist: { wind: 0.6, physical: 0.05 },
    status: { poison: 0.2, paralyze: 0, bleed: 0.3 },
    senses: {
      sightRange: 26, fov: 130, hearing: 18, loseSightTime: 4.5,
      giveUpDistance: 40, alertShareRadius: 22,
    },
    ai: {
      aggression: 'sight',        // 視界に入ると攻撃
      preferredRange: [9, 15],    // 距離を取りながら戦う
      strafe: 0.9,                // 横移動で狙いを外させる
      flank: 0.7,                 // 背後を取ろうとする
      fleeAtHp: 0.22,             // HPが減ると逃げる
      enrageAtHp: 0,
      callAlliesAtHp: 0.4,        // 不利になると援軍を呼ぶ
      joinAllyFight: true,        // 仲間が攻撃されると参戦
      idleBehaviour: 'patrol',    // 巡回
    },
    defense: { blockChance: 0, dodgeChance: 0.25, guardAngle: 0 },
    attacks: [
      { id: 'arrow', kind: 'arrow', label: '速射の矢', power: 16, element: 'wind', range: [6, 20], windup: 0.45, recover: 0.35, cooldown: 1.6, knockback: 1.2, speed: 26, clip: 'shoot' },
      { id: 'pierce', kind: 'arrow', label: '貫通矢', power: 24, element: 'physical', range: [8, 22], windup: 0.8, recover: 0.5, cooldown: 5.5, knockback: 2.4, speed: 34, pierce: true, clip: 'shoot' },
      { id: 'kick', kind: 'melee', label: '蹴り払い', power: 12, element: 'physical', range: [0, 2.4], windup: 0.3, recover: 0.4, cooldown: 2.2, knockback: 3.2, clip: 'kick' },
    ],
    phases: { enrage: { attack: 1.0, speed: 1.0, interval: 1.0 } },
    drops: { xp: 26, gold: 12, items: [{ id: 'arrow_bundle', label: '矢束', chance: 0.5 }] },
    spawn: { count: 3, near: ['コンビニ', 'ガソスタ', '駐車場地面'], time: 'any', radius: 14 },
    variants: [
      { id: 'normal', label: '', weight: 7, mul: 1 },
      { id: 'elite', label: '強化', weight: 2, mul: 1.35, look: { scale: 1.06 } },
      { id: 'named', label: '疾風の頭目', weight: 1, mul: 1.8, look: { scale: 1.12 } },
    ],
  }),

  // ───────────────────────────────── タンク / 前衛
  Swat: enemy({
    id: 'Swat',
    name: '鉄壁SWAT',
    role: 'タンク / 前衛',
    roleTag: 'tank',
    look: { color: '#4b78a9', scale: 1.05, gear: { shield: true, sword: true } },
    stats: {
      maxHp: 190, attack: 22, defense: 24, magicAttack: 2, magicDefense: 14,
      walkSpeed: 1.9, runSpeed: 3.9, attackInterval: 2.2,
      staggerResist: 0.7, knockbackResist: 0.8, knockback: 4.2,
      hitRadius: 0.50, weight: 105, level: 6,
    },
    element: 'physical',
    weakness: { thunder: 0.45, dark: 0.2 },
    resist: { physical: 0.35, fire: 0.2, wind: 0.15 },
    status: { poison: 0.5, paralyze: 0.4, bleed: 0.6 },
    senses: {
      sightRange: 20, fov: 110, hearing: 14, loseSightTime: 6,
      giveUpDistance: 32, alertShareRadius: 26,
    },
    ai: {
      aggression: 'proximity',     // 一定距離まで近づくと攻撃
      preferredRange: [0, 2.6],
      strafe: 0.1,
      flank: 0,
      fleeAtHp: 0,                 // 逃げない
      enrageAtHp: 0.3,             // HPが減ると狂暴化
      callAlliesAtHp: 0,
      joinAllyFight: true,
      guardAllies: true,           // 仲間を守る(前に出る)
      idleBehaviour: 'guard',      // 拠点防衛
    },
    defense: { blockChance: 0.6, dodgeChance: 0, guardAngle: 110, blockReduction: 0.75 },
    attacks: [
      { id: 'bash', kind: 'melee', label: '盾打ち', power: 20, element: 'physical', range: [0, 2.6], windup: 0.5, recover: 0.45, cooldown: 2.0, knockback: 3.6, clip: 'attack' },
      { id: 'smash', kind: 'heavy', label: '強打', power: 38, element: 'physical', range: [0, 3.2], windup: 1.0, recover: 0.8, cooldown: 6.0, knockback: 7.0, unblockable: true, clip: 'attack' },
      { id: 'rush', kind: 'charge', label: 'シールドラッシュ', power: 26, element: 'physical', range: [4, 11], windup: 0.75, recover: 0.7, cooldown: 8.0, knockback: 6.0, chargeSpeed: 12, clip: 'run' },
    ],
    phases: { enrage: { attack: 1.3, speed: 1.35, interval: 0.7 } },
    drops: { xp: 52, gold: 26, items: [{ id: 'plate', label: '装甲板', chance: 0.35 }] },
    spawn: { count: 2, near: ['ガソスタ', '集会所'], time: 'any', radius: 12 },
    variants: [
      { id: 'normal', label: '', weight: 8, mul: 1 },
      { id: 'elite', label: '重装', weight: 3, mul: 1.3, look: { scale: 1.1 } },
    ],
  }),

  // ───────────────────────────────── 魔法使い(範囲)
  SpaceSuit: enemy({
    id: 'SpaceSuit',
    name: '星詠み',
    role: '魔法使い / 範囲攻撃',
    roleTag: 'mage',
    look: { color: '#b967e8', scale: 1.0, gear: { staff: true } },
    stats: {
      maxHp: 95, attack: 6, defense: 9, magicAttack: 30, magicDefense: 26,
      walkSpeed: 2.0, runSpeed: 4.4, attackInterval: 2.8,
      staggerResist: 0.15, knockbackResist: 0.2, knockback: 2.0,
      hitRadius: 0.46, weight: 70, level: 8,
    },
    element: 'thunder',
    weakness: { earth: 0.55, physical: 0.3 },
    resist: { thunder: 0.7, ice: 0.3, light: 0.2 },
    status: { poison: 0.3, paralyze: 0.7, bleed: 0.2 },
    senses: {
      sightRange: 30, fov: 150, hearing: 20, loseSightTime: 5,
      giveUpDistance: 44, alertShareRadius: 30,
    },
    ai: {
      aggression: 'sight',
      preferredRange: [11, 18],   // 距離を取りながら戦う
      strafe: 0.5,
      flank: 0.2,
      fleeAtHp: 0.3,
      enrageAtHp: 0.45,
      callAlliesAtHp: 0.5,
      joinAllyFight: true,
      idleBehaviour: 'stargaze',   // 天を仰ぐ(生活行動)
    },
    defense: { blockChance: 0, dodgeChance: 0.1, guardAngle: 0, barrierAtHp: 0.5 },
    attacks: [
      { id: 'bolt', kind: 'magic', label: '雷弾', power: 24, element: 'thunder', range: [7, 22], windup: 0.7, recover: 0.5, cooldown: 2.6, knockback: 1.8, speed: 20, clip: 'cast' },
      { id: 'nova', kind: 'aoe', label: '雷の範囲魔法', power: 40, element: 'thunder', range: [4, 16], windup: 1.5, recover: 0.9, cooldown: 9.0, knockback: 5.0, radius: 5.5, telegraph: true, clip: 'cast' },
      { id: 'frost', kind: 'magic', label: '氷結弾', power: 20, element: 'ice', range: [6, 18], windup: 0.9, recover: 0.5, cooldown: 6.5, knockback: 1.0, speed: 15, slow: 0.45, clip: 'cast' },
    ],
    phases: { enrage: { attack: 1.45, speed: 1.15, interval: 0.6 } },
    drops: { xp: 64, gold: 30, items: [{ id: 'star_shard', label: '星片', chance: 0.4 }] },
    spawn: { count: 2, near: ['ステージ', '鳥居'], time: 'night', radius: 16 },
    variants: [
      { id: 'normal', label: '', weight: 7, mul: 1 },
      { id: 'rare', label: '希少', weight: 2, mul: 1.4, look: { scale: 1.05 } },
    ],
  }),

  // ───────────────────────────────── 指揮官 / ヒーラー
  King: enemy({
    id: 'King',
    name: '王の号令',
    role: '指揮官 / ヒーラー',
    roleTag: 'healer',
    look: { color: '#f2c14e', scale: 1.1, gear: { staff: true, shield: false } },
    stats: {
      maxHp: 150, attack: 16, defense: 16, magicAttack: 22, magicDefense: 24,
      walkSpeed: 1.8, runSpeed: 3.6, attackInterval: 3.0,
      staggerResist: 0.5, knockbackResist: 0.6, knockback: 2.6,
      hitRadius: 0.50, weight: 92, level: 10,
    },
    element: 'light',
    weakness: { dark: 0.6, ice: 0.2 },
    resist: { light: 0.6, physical: 0.15, fire: 0.15 },
    status: { poison: 0.6, paralyze: 0.5, bleed: 0.5 },
    senses: {
      sightRange: 24, fov: 160, hearing: 22, loseSightTime: 7,
      giveUpDistance: 36, alertShareRadius: 34,   // 仲間へ警戒情報を広く共有
    },
    ai: {
      aggression: 'sight',
      preferredRange: [8, 14],
      strafe: 0.3,
      flank: 0,
      fleeAtHp: 0.18,
      enrageAtHp: 0.35,
      callAlliesAtHp: 0.7,        // 早めに援軍を呼ぶ
      joinAllyFight: true,
      commander: true,            // 周囲の敵に指示(強化)を出す
      idleBehaviour: 'patrol',
    },
    defense: { blockChance: 0.2, dodgeChance: 0.05, guardAngle: 90, blockReduction: 0.5 },
    attacks: [
      { id: 'heal', kind: 'heal', label: '回復の号令', power: 46, element: 'light', range: [0, 18], windup: 1.0, recover: 0.7, cooldown: 8.0, radius: 18, allyHpBelow: 0.75, clip: 'cast' },
      { id: 'rally', kind: 'buff', label: '仲間強化', power: 0, element: 'light', range: [0, 20], windup: 0.8, recover: 0.6, cooldown: 14.0, radius: 20, buff: { attack: 1.25, speed: 1.15, duration: 10 }, clip: 'wave' },
      { id: 'smite', kind: 'magic', label: '裁きの光', power: 30, element: 'light', range: [5, 18], windup: 0.9, recover: 0.6, cooldown: 4.0, knockback: 3.0, speed: 22, clip: 'cast' },
      { id: 'scepter', kind: 'melee', label: '王笏打ち', power: 22, element: 'physical', range: [0, 2.8], windup: 0.5, recover: 0.5, cooldown: 2.4, knockback: 3.4, clip: 'attack' },
    ],
    phases: { enrage: { attack: 1.35, speed: 1.2, interval: 0.65 } },
    drops: { xp: 90, gold: 60, items: [{ id: 'crown_piece', label: '王冠の欠片', chance: 0.25 }, { id: 'elixir', label: 'エリクサー', chance: 1 }] },
    spawn: { count: 1, near: ['社', '集会所'], time: 'any', radius: 10 },
    variants: [
      { id: 'named', label: '', weight: 1, mul: 1 },
    ],
  }),

  // ───────────────────────────────── 罠設置役
  Worker: enemy({
    id: 'Worker',
    name: '工房ガーディアン',
    role: '罠設置役 / アタッカー',
    roleTag: 'trapper',
    look: { color: '#e27d35', scale: 1.02, gear: { sword: true } },
    stats: {
      maxHp: 120, attack: 19, defense: 13, magicAttack: 8, magicDefense: 10,
      walkSpeed: 2.2, runSpeed: 5.0, attackInterval: 1.9,
      staggerResist: 0.35, knockbackResist: 0.4, knockback: 3.0,
      hitRadius: 0.46, weight: 88, level: 5,
    },
    element: 'earth',
    weakness: { water: 0.5, wind: 0.3 },
    resist: { earth: 0.5, physical: 0.1, thunder: -0.1 },
    status: { poison: 0.4, paralyze: 0.3, bleed: 0.4 },
    senses: {
      sightRange: 22, fov: 120, hearing: 24,   // 音に反応する
      loseSightTime: 5, giveUpDistance: 34, alertShareRadius: 20,
    },
    ai: {
      aggression: 'proximity',
      preferredRange: [0, 3.0],
      strafe: 0.25,
      flank: 0.3,
      fleeAtHp: 0.15,
      enrageAtHp: 0.4,
      callAlliesAtHp: 0.3,
      joinAllyFight: true,
      idleBehaviour: 'work',      // 作業(生活行動)
    },
    defense: { blockChance: 0.15, dodgeChance: 0.1, guardAngle: 70, blockReduction: 0.4 },
    attacks: [
      { id: 'wrench', kind: 'melee', label: 'レンチ連打', power: 17, element: 'physical', range: [0, 2.5], windup: 0.35, recover: 0.35, cooldown: 1.5, knockback: 2.2, combo: 2, clip: 'attack' },
      { id: 'trap', kind: 'trap', label: '地面罠', power: 26, element: 'earth', range: [3, 14], windup: 0.9, recover: 0.6, cooldown: 10.0, radius: 2.2, life: 22, knockback: 2.0, clip: 'interact' },
      { id: 'dash', kind: 'charge', label: '突進', power: 24, element: 'earth', range: [4, 12], windup: 0.6, recover: 0.6, cooldown: 7.0, knockback: 5.5, chargeSpeed: 13, clip: 'run' },
    ],
    phases: { enrage: { attack: 1.25, speed: 1.3, interval: 0.7 } },
    drops: { xp: 44, gold: 22, items: [{ id: 'gear_part', label: '歯車部品', chance: 0.45 }] },
    spawn: { count: 2, near: ['畑', '棚田', 'マルシェ'], time: 'day', radius: 14 },
    variants: [
      { id: 'normal', label: '', weight: 8, mul: 1 },
      { id: 'elite', label: '親方', weight: 2, mul: 1.35, look: { scale: 1.08 } },
    ],
  }),
}

export const ENEMY_LIST = Object.values(ENEMY_TYPES)

/** 個体差(bunbetu 18)を重み付き抽選する */
export function pickVariant(def, rng = Math.random) {
  const total = def.variants.reduce((a, v) => a + v.weight, 0)
  let r = rng() * total
  for (const v of def.variants) {
    r -= v.weight
    if (r <= 0) return v
  }
  return def.variants[0]
}

/** 主人公が使える攻撃。レベルで解禁される(既存デザインを踏襲) */
export const PLAYER_ATTACKS = {
  melee: { id: 'melee', label: '⚔ 近接', power: 30, element: 'physical', range: 2.8, arc: 110, cost: { stamina: 12 }, windup: 0.18, cooldown: 0.5, knockback: 3.0, clip: 'attack', unlockLevel: 1, key: 'F' },
  magic: { id: 'magic', label: '✦ 火球', power: 38, element: 'fire', range: 22, cost: { mp: 12 }, windup: 0.3, cooldown: 1.1, knockback: 2.4, speed: 24, clip: 'cast', unlockLevel: 2, key: 'R' },
  area: { id: 'area', label: '◎ 範囲魔法', power: 34, element: 'thunder', range: 14, radius: 5, cost: { mp: 24 }, windup: 0.55, cooldown: 4.5, knockback: 4.0, clip: 'cast', unlockLevel: 4, key: 'L' },
  arrow: { id: 'arrow', label: '➹ 弓矢', power: 26, element: 'wind', range: 28, cost: { stamina: 8 }, windup: 0.25, cooldown: 0.85, knockback: 1.6, speed: 34, clip: 'shoot', unlockLevel: 3, key: 'U' },
  heal: { id: 'heal', label: '✚ 回復', power: 55, element: 'light', range: 0, cost: { mp: 30 }, windup: 0.4, cooldown: 7.0, clip: 'cast', unlockLevel: 1, key: 'E' },
  // ── 押している間だけ働く長押し技（tryAttack ではなく毎フレーム処理される）
  webswing: {
    id: WEB_SWING.id, label: WEB_SWING.label, mode: 'hold', power: 0, element: 'physical',
    range: WEB_SWING.maxDistance, cost: {}, windup: 0, cooldown: 0, clip: 'roll',
    unlockLevel: WEB_SWING.unlockLevel, key: WEB_SWING.key,
  },
  firestream: {
    id: FIRE_STREAM.id, label: FIRE_STREAM.label, mode: 'hold', power: FIRE_STREAM.power,
    element: FIRE_STREAM.element, kind: FIRE_STREAM.kind, range: FIRE_STREAM.range,
    cost: {}, windup: 0, cooldown: 0, knockback: FIRE_STREAM.knockback, speed: FIRE_STREAM.speed,
    clip: FIRE_STREAM.clip, unlockLevel: FIRE_STREAM.unlockLevel, key: FIRE_STREAM.key,
  },
}

/** 攻撃ボタンとして押して発動する技だけ（長押し技を除く） */
export const PRESS_ATTACKS = Object.values(PLAYER_ATTACKS).filter((a) => a.mode !== 'hold')

export const PLAYER_BASE = {
  maxHp: 140, maxMp: 70, maxStamina: 100,
  attack: 20, defense: 12, magicAttack: 18, magicDefense: 12,
  walkSpeed: 2.9, runSpeed: 6.2, hitRadius: 0.38,
  staggerResist: 0.35, knockbackResist: 0.45,
  weakness: {}, resist: { physical: 0.05 },
  /** 盾: 正面 blockAngle 度以内のダメージを blockReduction 分カットする */
  blockAngle: 120, blockReduction: 0.72, blockStaminaPerHit: 18,
  dodgeInvuln: 0.42, dodgeCost: 22, dodgeSpeed: 11,
}
