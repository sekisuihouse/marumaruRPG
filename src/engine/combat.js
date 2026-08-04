/**
 * ダメージ計算。bunbetu.md 1(基本ステータス)・2(属性/耐性)・7(防御行動)に対応。
 *
 *   物理  = power * (1 + attack/100)   → 防御で減衰
 *   魔法  = power * (1 + magicAttack/100) → 魔法防御で減衰
 *   属性倍率 = 1 + weakness[el] - resist[el]
 *   背後攻撃は 1.35 倍、ガード成功でカット、ひるみ/ノックバックは耐性で減る
 */

/** 防御力による減衰。defense=120 でおよそ半減。 */
const mitigate = (raw, defense) => raw * (1 - defense / (defense + 120))

const ELEMENT_MUL = (element, weakness = {}, resist = {}) =>
  Math.max(0.05, 1 + (weakness[element] || 0) - (resist[element] || 0))

/**
 * @param {object} p
 * @param {object} p.attacker 攻撃側 {attack, magicAttack, buff}
 * @param {object} p.defender 防御側 {defense, magicDefense, weakness, resist, knockbackResist, staggerResist, blocking, blockAngle, blockReduction, yaw}
 * @param {object} p.attack   攻撃定義 {power, element, kind, knockback, unblockable}
 * @param {{x:number,z:number}} p.fromDir 攻撃が飛んできた方向(防御側→攻撃側の単位ベクトル)
 * @param {number} p.facing   防御側の向き(rad)
 */
export function resolveDamage({ attacker, defender, attack, fromDir, facing = 0, mul = 1 }) {
  const magical = attack.kind === 'magic' || attack.kind === 'aoe'
  const atkStat = magical ? (attacker.magicAttack ?? 0) : (attacker.attack ?? 0)
  const defStat = magical ? (defender.magicDefense ?? 0) : (defender.defense ?? 0)
  const buff = attacker.buff?.attack ?? 1

  let raw = attack.power * (1 + atkStat / 100) * buff * mul
  raw = mitigate(raw, defStat)
  raw *= ELEMENT_MUL(attack.element || 'physical', defender.weakness, defender.resist)

  // 背後 / 側面判定: fromDir と防御側の正面のなす角
  let angle = 0
  if (fromDir) {
    const forwardX = Math.sin(facing)
    const forwardZ = Math.cos(facing)
    const dot = Math.max(-1, Math.min(1, forwardX * fromDir.x + forwardZ * fromDir.z))
    angle = (Math.acos(dot) * 180) / Math.PI
  }
  const fromBehind = angle > 120
  if (fromBehind) raw *= 1.35

  // ガード(盾)。正面 blockAngle 内かつ unblockable でないときのみ有効
  let blocked = false
  if (defender.blocking && !attack.unblockable && angle <= (defender.blockAngle ?? 120) / 2) {
    blocked = true
    raw *= 1 - (defender.blockReduction ?? 0.7)
  }

  const damage = Math.max(1, Math.round(raw))

  // ノックバック / ひるみ
  const kbResist = defender.knockbackResist ?? 0
  let knockback = (attack.knockback ?? 0) * (1 - kbResist) * (blocked ? 0.35 : 1)
  const stagger = !blocked && Math.random() > (defender.staggerResist ?? 0)

  return { damage, blocked, knockback, stagger, fromBehind, element: attack.element || 'physical' }
}

/** 攻撃が届くか(範囲と角度) */
export function inAttackArc(ax, az, aYaw, tx, tz, range, arcDeg = 360) {
  const dx = tx - ax, dz = tz - az
  const dist = Math.hypot(dx, dz)
  if (dist > range) return false
  if (arcDeg >= 360) return true
  const forwardX = Math.sin(aYaw), forwardZ = Math.cos(aYaw)
  const dot = (dx / (dist || 1)) * forwardX + (dz / (dist || 1)) * forwardZ
  return Math.acos(Math.max(-1, Math.min(1, dot))) <= (arcDeg / 2) * (Math.PI / 180)
}

/** レベルアップ必要経験値 */
export const xpForLevel = (level) => Math.round(55 * level * (1 + level * 0.18))
