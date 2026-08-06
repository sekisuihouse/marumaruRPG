/**
 * すべての攻撃の共通入口。
 *
 * 近接・強攻撃・突進・範囲・弓・魔法・爆発・連続火球は、最終的に必ず
 * damageTarget() を通る。ここで「敵」「建物の小片」「残骸」へ処理を振り分けるので、
 * 攻撃を1つ足しても建物への当たり判定を書き足す必要がない。
 */
import { sim } from './sim.js'
import { inAttackArc } from './combat.js'
import { damageEnemy } from './damage.js'
import { damageStructure } from './destruct.js'
import { hitDebris } from './debris.js'
import { impact } from './juice.js'
import { damageBoss } from './bosses.js'
import { damageFinalBossAt } from './finalBoss.js'

/** 建物に与える物理ダメージ量。敵の防御は関係しないので単純化する。 */
function structureDamage(attack, attacker, mul, structureMul) {
  const magical = attack.kind === 'magic' || attack.kind === 'aoe'
  const stat = magical ? (attacker?.magicAttack ?? 0) : (attacker?.attack ?? 0)
  return attack.power * (1 + stat / 100) * mul * structureMul
}

/**
 * @param {object} spec
 *  x,y,z          命中位置
 *  dirX,dirY,dirZ 攻撃方向（破片が飛ぶ向き・貫通判定に使う）
 *  radius         影響半径
 *  arc            指定すると yaw を中心とした扇形で敵を判定する（近接用）
 *  yaw            扇形の中心角
 *  attack         攻撃定義 {power, element, kind, knockback, pierce}
 *  attacker       {attack, magicAttack, buff}
 *  mul            倍率（コンボ等）
 *  hitEnemies     既定 true
 *  hitStructure   既定 true
 *  structureMul   建物へのダメージ倍率（既定 1）
 *  impulse        破片へ与える衝撃の倍率（既定 1）
 *  juice          演出規模 0..1（既定は radius から推定）
 */
export function damageTarget(spec) {
  const out = { enemies: [], damaged: 0, broken: 0, debris: 0 }
  const radius = spec.radius ?? 1.2
  sim.lastHitPoint = { x: spec.x, y: spec.y, z: spec.z, at: sim.time }
  const mul = spec.mul ?? 1
  const attack = spec.attack
  const dirX = spec.dirX ?? 0, dirY = spec.dirY ?? 0, dirZ = spec.dirZ ?? 0

  // ── 敵
  if (spec.hitEnemies !== false) {
    for (const e of sim.enemies) {
      if (!e.alive || e.state === 'dead') continue
      const reach = radius + e.def.stats.hitRadius
      if (spec.arc != null) {
        // 扇形の原点は攻撃者の足元（命中位置は建物・破片用に前方へずらしてある）
        const ax = spec.originX ?? spec.x
        const az = spec.originZ ?? spec.z
        if (!inAttackArc(ax, az, spec.yaw ?? 0, e.pos.x, e.pos.z, (spec.arcRange ?? radius) + e.def.stats.hitRadius, spec.arc)) continue
      } else {
        if (Math.hypot(e.pos.x - spec.x, e.pos.z - spec.z) > reach) continue
        if (spec.checkHeight !== false && Math.abs((e.pos.y + 1.0) - spec.y) > reach + 1.2) continue
      }
      const r = damageEnemy(e, spec.attacker, attack, { x: spec.x, z: spec.z }, mul)
      if (r) out.enemies.push({ enemy: e, result: r })
      if (!attack.pierce && spec.singleTarget) break
    }
  }

  // ── 建物連動ボス（通常敵とは別プール。全プレイヤー攻撃を同じ入口で受ける）
  if (spec.hitBosses !== false) {
    for (const b of sim.bosses || []) {
      if (!b.alive || b.state === 'dead') continue
      const reach = radius + b.def.hitRadius
      if (Math.hypot(b.pos.x - spec.x, b.pos.z - spec.z) > reach) continue
      const r = damageBoss(b, spec.attacker, attack, { x: spec.x, y: spec.y, z: spec.z }, mul)
      if (r) out.enemies.push({ enemy: b, result: r })
    }
    const r = damageFinalBossAt({ x: spec.x, y: spec.y, z: spec.z }, spec.attacker, { ...attack, range: radius }, mul)
    if (r) out.enemies.push({ enemy: sim.finalBoss, result: r })
  }

  // ── ボス戦の反撃用オブジェクト（結界核・暴走ドローン・落下鍋）
  if (spec.hitBossObjects !== false) {
    for (const o of sim.bossObjects || []) {
      if (!o.alive || Math.hypot(o.x - spec.x, o.z - spec.z) > radius + (o.radius || 0.6)) continue
      const amount = Math.max(1, Math.round(attack.power * mul))
      o.hp -= amount
      if (o.hp > 0) continue
      o.alive = false
      if (o.onBreak) o.onBreak(spec)
      out.enemies.push({ enemy: o, result: { damage: amount, weak: true } })
    }
  }

  // ── 建物（小片単位）
  if (spec.hitStructure !== false) {
    const r = damageStructure({
      x: spec.x, y: spec.y, z: spec.z,
      radius,
      dirX, dirY, dirZ,
      damage: structureDamage(attack, spec.attacker, mul, spec.structureMul ?? 1),
      kind: attack.kind,
      pierce: !!attack.pierce,
      impulse: spec.impulse ?? 1,
    })
    out.damaged = r.damaged
    out.broken = r.broken
  }

  // ── 残骸（HP判定なしで必ず飛ぶ）
  // hitDebris 側の10倍補正と合わせて、通常の再攻撃より約10倍遠くまで飛ぶ。
  out.debris = hitDebris(spec.x, spec.y, spec.z, radius * 1.5, dirX, dirY, dirZ, (spec.impulse ?? 1) * 7)

  // ── 演出。破壊した数が多いほど強く揺れる
  const base = spec.juice ?? Math.min(0.5, radius * 0.12)
  const scale = Math.min(1, base + out.broken * 0.09)
  if (out.enemies.length || out.damaged || out.debris) {
    impact(scale, { slowmo: spec.slowmo ?? scale > 0.6 })
  }
  return out
}

/** 爆発（球状）。火球の着弾・大技で使う。 */
export function explode(spec) {
  return damageTarget({
    ...spec,
    dirY: spec.dirY ?? 0.45,
    impulse: (spec.impulse ?? 1) * 1.6,
    slowmo: spec.slowmo ?? false,
  })
}
