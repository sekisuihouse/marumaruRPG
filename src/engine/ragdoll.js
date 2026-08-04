/**
 * 敵の死亡時ラグドール（ふにゃふにゃ化）。
 *
 * 剛体エンジンを入れずに、部位ごとの質点＋距離拘束（Verlet）で表現する。
 *  - 頭 / 胴(腹・胸) / 上腕 / 前腕 / 太もも / すね を質点として持つ
 *  - 親子を距離拘束で繋ぐ（＝関節）。死亡時は拘束をかなり緩めて脱力させる
 *  - 「伸びきり」防止に、1つ飛ばしの距離にも上下限を入れる（関節が無制限に回らない）
 *  - 最後に受けた攻撃の位置・方向・威力を各部位へ配分する
 *
 * 部位は分離しない。関節が外れかけたように力が抜けるだけ。
 * 描画側(CharacterModel.jsx)がこの質点にボーンを追従させる。
 */
import { sim } from './sim.js'
import { groundY, isWalkable, nearestWalkable } from './nav.js'

/** [名前, 親index, 親からの静止オフセット(m)] 身長1.7m基準 */
const BONES = [
  ['Hips', -1, [0, 0.95, 0]],
  ['Abdomen', 0, [0, 0.14, 0]],
  ['Chest', 1, [0, 0.20, 0]],
  ['Neck', 2, [0, 0.16, 0]],
  ['Head', 3, [0, 0.14, 0]],
  ['UpperArmL', 2, [0.19, 0.08, 0]],
  ['LowerArmL', 5, [0.26, -0.02, 0]],
  ['WristL', 6, [0.24, -0.02, 0]],
  ['UpperArmR', 2, [-0.19, 0.08, 0]],
  ['LowerArmR', 8, [-0.26, -0.02, 0]],
  ['WristR', 9, [-0.24, -0.02, 0]],
  ['UpperLegL', 0, [0.10, -0.06, 0]],
  ['LowerLegL', 11, [0, -0.42, 0]],
  ['FootL', 12, [0, -0.40, 0]],
  ['UpperLegR', 0, [-0.10, -0.06, 0]],
  ['LowerLegR', 14, [0, -0.42, 0]],
  ['FootR', 15, [0, -0.40, 0]],
]

/** 描画側がボーンを対応づけるために公開する */
export const RAGDOLL_BONES = BONES
/** 各ノードの最初の子（この向きにボーンを回す） */
export const RAGDOLL_CHILD = BONES.map((_, i) => BONES.findIndex(([, parent]) => parent === i))

export const RAGDOLL = {
  max: 6,
  gravity: 17,
  damping: 0.985,
  /** 関節の緩さ。1に近いほど硬い。死亡時は緩くしてふにゃふにゃにする */
  stiffness: 0.34,
  iterations: 5,
  /** 1つ飛ばしの距離の上下限（伸びきり・めり込み防止） */
  spanMax: 0.94,
  spanMin: 0.22,
  sleepSpeed: 0.12,
  sleepTime: 1.4,
  /** 破片や壁から押し戻す距離 */
  skin: 0.16,
  maxImpulse: 26,
}

export function initRagdolls() {
  sim.ragdolls = []
}

const list = () => sim.ragdolls || (initRagdolls(), sim.ragdolls)

/**
 * 敵を倒した瞬間に呼ぶ。
 * @param {object} e 敵
 * @param {object} hit {x,y,z, dirX,dirY,dirZ, power, explosion}
 */
export function spawnRagdoll(e, hit = null) {
  const all = list()
  // 死体数の上限。古いものから消す
  while (all.length >= RAGDOLL.max) all.shift()

  const scale = e.scale || 1
  const cos = Math.cos(e.yaw), sin = Math.sin(e.yaw)
  const baseY = e.pos.y
  const nodes = BONES.map(([name, parent, off]) => {
    const ox = off[0] * scale, oy = off[1] * scale, oz = off[2] * scale
    return { name, parent, ox, oy, oz, x: 0, y: 0, z: 0, px: 0, py: 0, pz: 0, len: 0 }
  })
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    const p = n.parent >= 0 ? nodes[n.parent] : null
    // 親からの相対を yaw で回してワールドへ
    const lx = n.ox, ly = n.oy, lz = n.oz
    const wx = lx * cos + lz * sin
    const wz = -lx * sin + lz * cos
    n.x = (p ? p.x : e.pos.x) + wx
    n.y = (p ? p.y : baseY) + ly
    n.z = (p ? p.z : e.pos.z) + wz
    n.px = n.x; n.py = n.y; n.pz = n.z
    if (p) n.len = Math.hypot(n.x - p.x, n.y - p.y, n.z - p.z)
  }

  const rd = {
    id: e.id,
    enemyId: e.id,
    typeId: e.typeId,
    scale,
    yaw: e.yaw,
    nodes,
    born: sim.time,
    sleeping: false,
    sleepTimer: 0,
    active: true,
  }
  all.push(rd)
  if (hit) applyRagdollImpulse(rd, hit)
  return rd
}

/** 攻撃の位置・方向・威力を各部位へ配る */
export function applyRagdollImpulse(rd, hit) {
  const power = Math.min(RAGDOLL.maxImpulse, (hit.power ?? 10) * 0.16)
  const dx = hit.dirX ?? 0, dy = hit.dirY ?? 0.3, dz = hit.dirZ ?? 0
  for (const n of rd.nodes) {
    let w = 1
    if (hit.x != null) {
      const d = Math.hypot(n.x - hit.x, n.y - (hit.y ?? n.y), n.z - hit.z)
      // 爆発は全身が大きく飛ぶ。それ以外は当たった部位ほど強く飛ぶ
      w = hit.explosion ? 1 : Math.max(0.25, 1 - d / 1.6)
    }
    const s = power * w
    n.px -= dx * s * 0.016
    n.py -= (dy + (hit.explosion ? 0.9 : 0.35)) * s * 0.016
    n.pz -= dz * s * 0.016
  }
  rd.sleeping = false
  rd.sleepTimer = 0
}

/** 特定の敵のラグドールを引く */
export const ragdollFor = (id) => (sim.ragdolls || []).find((r) => r.enemyId === id && r.active)

export function removeRagdoll(id) {
  const all = list()
  const i = all.findIndex((r) => r.enemyId === id)
  if (i >= 0) all.splice(i, 1)
}

export function updateRagdolls(dt) {
  const all = list()
  const g = RAGDOLL.gravity
  for (let ri = all.length - 1; ri >= 0; ri--) {
    const rd = all[ri]
    if (!rd.active) { all.splice(ri, 1); continue }
    if (sim.time - rd.born > 22) { all.splice(ri, 1); continue }
    if (rd.sleeping) continue

    let maxMove = 0
    for (const n of rd.nodes) {
      const vx = (n.x - n.px) * RAGDOLL.damping
      const vy = (n.y - n.py) * RAGDOLL.damping
      const vz = (n.z - n.pz) * RAGDOLL.damping
      n.px = n.x; n.py = n.y; n.pz = n.z
      n.x += vx
      n.y += vy - g * dt * dt
      n.z += vz
      maxMove = Math.max(maxMove, Math.abs(vx) + Math.abs(vy) + Math.abs(vz))
    }

    for (let it = 0; it < RAGDOLL.iterations; it++) {
      // 親子の距離拘束（関節）
      for (const n of rd.nodes) {
        if (n.parent < 0) continue
        const p = rd.nodes[n.parent]
        let dx = n.x - p.x, dy = n.y - p.y, dz = n.z - p.z
        const d = Math.hypot(dx, dy, dz) || 1e-6
        const diff = ((d - n.len) / d) * RAGDOLL.stiffness
        dx *= diff; dy *= diff; dz *= diff
        // 親のほうが重い扱い（胴が振り回されすぎない）
        p.x += dx * 0.35; p.y += dy * 0.35; p.z += dz * 0.35
        n.x -= dx * 0.65; n.y -= dy * 0.65; n.z -= dz * 0.65
      }
      // 1つ飛ばしの距離制限（関節が無制限に回って伸びきらないように）
      for (const n of rd.nodes) {
        if (n.parent < 0) continue
        const p = rd.nodes[n.parent]
        if (p.parent < 0) continue
        const gp = rd.nodes[p.parent]
        const span = n.len + p.len
        let dx = n.x - gp.x, dy = n.y - gp.y, dz = n.z - gp.z
        const d = Math.hypot(dx, dy, dz) || 1e-6
        const hi = span * RAGDOLL.spanMax
        const lo = span * RAGDOLL.spanMin
        let target = null
        if (d > hi) target = hi
        else if (d < lo) target = lo
        if (target === null) continue
        const diff = ((d - target) / d) * 0.5
        n.x -= dx * diff; n.y -= dy * diff; n.z -= dz * diff
      }
      // 地面と壁
      for (const n of rd.nodes) {
        const gy = groundY(n.x, n.z, 0) + RAGDOLL.skin
        if (n.y < gy) {
          n.y = gy
          // 摩擦（滑りすぎない）
          n.px += (n.x - n.px) * 0.4
          n.pz += (n.z - n.pz) * 0.4
        }
        if (!isWalkable(n.x, n.z)) {
          const w = nearestWalkable(n.x, n.z)
          n.x += (w.x - n.x) * 0.35
          n.z += (w.z - n.z) * 0.35
        }
      }
    }

    if (maxMove < RAGDOLL.sleepSpeed * dt) {
      rd.sleepTimer += dt
      if (rd.sleepTimer > RAGDOLL.sleepTime) rd.sleeping = true
    } else rd.sleepTimer = 0
  }
}
