/**
 * 最終攻撃「連続火球」。ボタンを押している間、熱量を消費して高速連射する。
 * 弾はプール(sim.projectiles)を使い回し、着弾で小範囲爆発を起こして
 * 建物の小片と残骸を連続で吹き飛ばす。
 */
import { sim, addProjectile, addEffect, say, floater } from './sim.js'
import { FIRE_STREAM as FS } from '../data/abilities.js'
import { aimDirection } from './webswing.js'
import { explode } from './targets.js'
import { impact } from './juice.js'
import { groundY } from './nav.js'

export function initFireStream() {
  const p = sim.player
  p.heat = 0
  p.overheatUntil = 0
  p.fireStreamNext = 0
  p.fireStreamHold = false
}

/** ロックオン対象（正面コーン内で一番近い敵）。無ければカメラ中央。 */
function aimVector() {
  const p = sim.player
  const cam = aimDirection()
  let best = null
  for (const e of sim.enemies) {
    if (!e.alive || e.state === 'dead') continue
    const dx = e.pos.x - p.pos.x
    const dy = (e.pos.y + 1.0) - (p.pos.y + 1.3)
    const dz = e.pos.z - p.pos.z
    const d = Math.hypot(dx, dy, dz)
    if (d > FS.range) continue
    const dot = (dx / d) * cam.x + (dy / d) * cam.y + (dz / d) * cam.z
    if (dot < Math.cos((22 * Math.PI) / 180)) continue
    if (!best || d < best.d) best = { d, x: dx / d, y: dy / d, z: dz / d }
  }
  return best ? { x: best.x, y: best.y, z: best.z } : cam
}

/** 押している間の処理。step.js から毎フレーム呼ぶ。 */
export function updateFireStream(dt, held) {
  const p = sim.player
  if (p.heat === undefined) initFireStream()

  // 冷却
  if (!held || sim.time < p.overheatUntil) {
    p.heat = Math.max(0, p.heat - FS.heat.cool * dt)
  }
  p.fireStreamHold = held && sim.time >= p.overheatUntil

  if (!held || p.dead) return false
  if (!p.skills.includes(FS.id)) return false
  if (sim.time < p.overheatUntil) return false
  if (sim.time < p.fireStreamNext) return false
  if (p.mp < FS.mpPerShot) return false

  p.fireStreamNext = sim.time + FS.interval
  p.heat += FS.heat.perShot
  p.mp -= FS.mpPerShot
  if (p.heat >= FS.heat.max) {
    p.heat = FS.heat.max
    p.overheatUntil = sim.time + FS.heat.overheatCooldown
    say('火球がオーバーヒート！ 少し冷ます必要がある。', 'warn')
    floater(p.pos, 'OVERHEAT', '#ff6b4a', 1.2)
  }

  const dir = aimVector()
  const ox = p.pos.x + dir.x * 0.8
  const oy = p.pos.y + 1.3 + dir.y * 0.8
  const oz = p.pos.z + dir.z * 0.8
  addProjectile({
    kind: 'fire', owner: 'player', attack: FIRE_ATTACK, mul: 1,
    attacker: { attack: p.attack, magicAttack: p.magicAttack, buff: null },
    x: ox, y: oy, z: oz,
    dx: dir.x, dy: dir.y, dz: dir.z,
    speed: FS.speed, color: '#ff7a2c', radius: 0.3, life: FS.range / FS.speed,
    stream: true,
  })
  addEffect({ kind: 'muzzle', x: ox, y: oy, z: oz, color: '#ffb35c', radius: 0.5, life: 0.12 })
  p.anim = FS.clip
  p.tutorialActions.firestream = true
  impact(0.14)
  return true
}

/** 連続火球の攻撃定義（PLAYER_ATTACKS と同じ形） */
export const FIRE_ATTACK = {
  id: FS.id,
  label: FS.label,
  power: FS.power,
  element: FS.element,
  kind: FS.kind,
  knockback: FS.knockback,
  range: FS.range,
  speed: FS.speed,
  clip: FS.clip,
  unlockLevel: FS.unlockLevel,
  key: FS.key,
  cost: {},
  windup: 0,
  cooldown: 0,
}

/** 火球の着弾。小範囲爆発 + 破片への衝撃。 */
export function fireBlast(pr) {
  const p = sim.player
  const dist = Math.hypot(pr.x - p.pos.x, pr.z - p.pos.z)
  const tooClose = dist < FS.minSafeDistance
  const radius = tooClose ? FS.blastRadius * 0.45 : FS.blastRadius
  explode({
    x: pr.x, y: pr.y, z: pr.z,
    dirX: pr.dx, dirY: 0.45, dirZ: pr.dz,
    radius,
    attack: { ...FIRE_ATTACK, power: FS.blastPower, kind: 'aoe' },
    attacker: pr.attacker,
    mul: 1,
    structureMul: FS.structureMul,
    impulse: FS.debrisImpulse,
    juice: tooClose ? 0.05 : 0.3,
  })
  addEffect({ kind: 'burst', x: pr.x, y: pr.y, z: pr.z, color: '#ff8a3c', radius: radius * 0.9, life: 0.32 })
  addEffect({ kind: 'dust', x: pr.x, y: Math.max(pr.y, groundY(pr.x, pr.z, 0)), z: pr.z, color: '#6b5a4a', radius: radius, life: 0.6 })
}

/** HUD 用 */
export const heatRatio = () => Math.max(0, Math.min(1, (sim.player.heat ?? 0) / FS.heat.max))
export const isOverheated = () => sim.time < (sim.player.overheatUntil ?? 0)
