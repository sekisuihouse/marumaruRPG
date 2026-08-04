/**
 * 破片（残骸）の物理。HPを持たず、当たれば必ず飛ぶ。
 *
 * 剛体エンジンは入れず、固定ステップの簡易剛体（並進＋角速度＋地面接触）で回す。
 * 描画側(src/scene/Debris.jsx)はこの配列を読んで Object3D を更新するだけ。
 */
import { sim } from './sim.js'
import { groundY } from './nav.js'
import { DEBRIS_PHYSICS, DEBRIS_QUALITY, MATERIALS } from '../data/destructibles.js'

const P = DEBRIS_PHYSICS

export const quality = () => DEBRIS_QUALITY[sim.settings.destructionQuality] || DEBRIS_QUALITY.high

let nextDebrisId = 1

function makeDebris() {
  return {
    id: 0, active: false, partId: -1,
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
    rx: 0, ry: 0, rz: 0, wx: 0, wy: 0, wz: 0,
    size: 0.4, mass: 1, radius: 0.4,
    life: 0, maxLife: 10, sleeping: false, sleepTimer: 0,
    big: false, materialType: 'wood', born: 0, lastContact: -99,
  }
}

/** 破片プール。sim.debris は描画・テストから読む。 */
export function initDebris() {
  sim.debris = []
  sim.debrisStats = { spawnedThisFrame: 0, active: 0, sleeping: 0 }
}

const pool = () => sim.debris || (initDebris(), sim.debris)

function acquire() {
  const list = pool()
  for (const d of list) if (!d.active) return d
  const q = quality()
  if (list.length < q.maxDebris) {
    const d = makeDebris()
    list.push(d)
    return d
  }
  // 上限。小さくて古いものから捨てる（大きな部品は残す）
  let victim = null
  for (const d of list) {
    if (d.big) continue
    if (!victim || d.born < victim.born) victim = d
  }
  if (!victim) for (const d of list) if (!victim || d.born < victim.born) victim = d
  return victim
}

/**
 * 破片を1つ生む。
 * @param {object} o {x,y,z, size, mass, materialType, partId, dirX,dirY,dirZ, power}
 */
export function spawnDebris(o) {
  const q = quality()
  const d = acquire()
  if (!d) return null
  d.id = nextDebrisId++
  d.active = true
  d.partId = o.partId ?? -1
  d.x = o.x; d.y = o.y; d.z = o.z
  d.size = o.size ?? 0.4
  d.radius = Math.max(0.12, d.size)
  d.mass = Math.max(0.15, o.mass ?? 1)
  d.big = (o.volume ?? d.size ** 3) > P.smallVolume
  d.materialType = o.materialType || 'wood'
  d.maxLife = d.big ? q.lifeBig : q.lifeSmall
  d.life = d.maxLife
  d.born = sim.time
  d.sleeping = false
  d.sleepTimer = 0
  d.rx = Math.random() * Math.PI
  d.ry = Math.random() * Math.PI
  d.rz = Math.random() * Math.PI
  const imp = (o.power ?? 6) / d.mass
  const spread = o.spread ?? 0.55
  d.vx = (o.dirX ?? 0) * imp + (Math.random() - 0.5) * imp * spread
  d.vy = (o.dirY ?? 0.35) * imp + Math.abs(imp) * (0.25 + Math.random() * 0.4)
  d.vz = (o.dirZ ?? 0) * imp + (Math.random() - 0.5) * imp * spread
  const spin = 4 + imp * 0.7
  d.wx = (Math.random() - 0.5) * spin
  d.wy = (Math.random() - 0.5) * spin
  d.wz = (Math.random() - 0.5) * spin
  sim.debrisStats.spawnedThisFrame++
  return d
}

/** 攻撃が残骸に当たったとき。HP判定なしで必ず吹き飛ぶ。 */
export function hitDebris(x, y, z, radius, dirX, dirY, dirZ, power) {
  const list = pool()
  let n = 0
  const r2 = radius * radius
  for (const d of list) {
    if (!d.active) continue
    const dx = d.x - x, dy = d.y - y, dz = d.z - z
    const dist2 = dx * dx + dy * dy + dz * dz
    if (dist2 > r2) continue
    const falloff = 1 - Math.sqrt(dist2) / radius
    // 残骸は「再攻撃したら豪快に飛ばす」ためのオブジェクト。従来の10倍で遠方まで飛ばす。
    const imp = (power * 10 * (0.5 + falloff)) / d.mass
    // 命中点から外向きの成分を混ぜて「押しのけられる」感じを出す
    const len = Math.sqrt(dist2) || 1
    d.vx += dirX * imp + (dx / len) * imp * 0.5
    d.vy += dirY * imp + imp * 0.5
    d.vz += dirZ * imp + (dz / len) * imp * 0.5
    const spin = 6 + imp
    d.wx += (Math.random() - 0.5) * spin
    d.wy += (Math.random() - 0.5) * spin
    d.wz += (Math.random() - 0.5) * spin
    d.sleeping = false
    d.sleepTimer = 0
    d.life = Math.max(d.life, Math.min(d.maxLife, 9))
    n++
  }
  return n
}

/** 破片をすべて消す（リスポーン・町の復元時） */
export function clearDebris() {
  for (const d of pool()) d.active = false
}

export function activeDebrisCount() {
  let n = 0
  for (const d of pool()) if (d.active) n++
  return n
}

const contactDamage = (d) => {
  const speed = Math.hypot(d.vx, d.vy, d.vz)
  return Math.min(P.maxContactDamage, Math.round(speed * d.mass * 0.22))
}

/** 物理は固定ステップで回す（フレームレートで挙動が変わらないように） */
const FIXED = 1 / 60
let accumulator = 0

export function updateDebris(dt, onContact) {
  accumulator += dt
  let steps = 0
  while (accumulator >= FIXED && steps < 4) {
    accumulator -= FIXED
    steps++
    stepDebris(FIXED, onContact)
  }
  if (steps === 0) return
  if (accumulator > FIXED * 4) accumulator = 0   // タブ復帰時に溜め込まない
}

function stepDebris(dt, onContact) {
  const list = pool()
  const px = sim.player.pos.x, py = sim.player.pos.y, pz = sim.player.pos.z
  let active = 0, sleeping = 0
  sim.debrisStats.spawnedThisFrame = 0

  for (const d of list) {
    if (!d.active) continue
    active++
    d.life -= dt
    if (d.life <= 0) { d.active = false; continue }

    // 遠い破片は物理を止める（性能）
    const far = Math.hypot(d.x - px, d.z - pz) > P.simRadius
    if (d.sleeping || far) { sleeping++; continue }

    d.vy -= P.gravity * dt
    d.x += d.vx * dt
    d.y += d.vy * dt
    d.z += d.vz * dt
    d.rx += d.wx * dt
    d.ry += d.wy * dt
    d.rz += d.wz * dt
    d.wx *= 1 - P.angularDamp * dt
    d.wy *= 1 - P.angularDamp * dt
    d.wz *= 1 - P.angularDamp * dt

    const gy = groundY(d.x, d.z, 0) + d.radius * 0.5
    if (d.y <= gy) {
      d.y = gy
      if (d.vy < 0) d.vy = -d.vy * P.restitution
      d.vx *= P.friction
      d.vz *= P.friction
      d.wx *= 0.7; d.wy *= 0.7; d.wz *= 0.7
      if (Math.abs(d.vy) < 1.2) d.vy = 0
    }

    // プレイヤー/敵への接触。上限を設けて即死しないようにする
    if (onContact && sim.time - d.lastContact > P.contactCooldown) {
      const speed = Math.hypot(d.vx, d.vy, d.vz)
      if (speed > 4) {
        if (!sim.player.dead && Math.hypot(d.x - px, d.z - pz) < d.radius + sim.player.hitRadius + 0.25 && Math.abs(d.y - (py + 0.9)) < 1.2) {
          d.lastContact = sim.time
          onContact('player', null, contactDamage(d), d)
          // プレイヤーに引っ掛からないよう跳ね返して逃がす
          d.vx = (d.x - px) * 3 + d.vx * 0.2
          d.vz = (d.z - pz) * 3 + d.vz * 0.2
          d.vy = Math.max(d.vy, 2)
        } else {
          for (const e of sim.enemies) {
            if (!e.alive || e.state === 'dead') continue
            if (Math.hypot(d.x - e.pos.x, d.z - e.pos.z) > d.radius + e.def.stats.hitRadius + 0.25) continue
            if (Math.abs(d.y - (e.pos.y + 0.9)) > 1.2) continue
            d.lastContact = sim.time
            onContact('enemy', e, contactDamage(d), d)
            break
          }
        }
      }
    }

    // 静止したら眠らせる（再攻撃で起きる）
    const sp = Math.hypot(d.vx, d.vy, d.vz)
    if (sp < P.sleepSpeed && d.y <= gy + 0.05) {
      d.sleepTimer += dt
      if (d.sleepTimer > P.sleepTime) { d.sleeping = true; d.vx = d.vy = d.vz = 0; d.wx = d.wy = d.wz = 0 }
    } else d.sleepTimer = 0
  }
  sim.debrisStats.active = active
  sim.debrisStats.sleeping = sleeping
}

export const dustColor = (materialType) => (MATERIALS[materialType] || MATERIALS.wood).dust
