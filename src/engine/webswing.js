/**
 * ウェブスイング（糸移動）。
 *
 * カメラ中央から射線を飛ばし、建物の小片(destruct の part)か高い地形へ糸を張る。
 * 入力中は接続点へ引かれ、勢いを保ったまま弧を描く。離すと速度を保って飛び出す。
 *
 * 既存の地上移動は step.js のまま。ここは「空中に居る間」だけを担当する。
 */
import * as THREE from 'three'
import { sim, say, addEffect } from './sim.js'
import { WEB_SWING as W } from '../data/abilities.js'
import { groundY, isWalkable, nearestWalkable, move } from './nav.js'
import { raycastStructure, registry } from './destruct.js'

export function initWeb() {
  const p = sim.player
  p.web = {
    attached: false,
    ax: 0, ay: 0, az: 0,
    rope: 0,
    partId: -1,
    cooldownUntil: 0,
    lastDetach: 0,
    swings: 0,
    /** 離したあと接続点まで飛んでいる最中か */
    zipping: false,
    zipUntil: 0,
    zipTarget: null,
    attachedAt: -99,
  }
  p.airborne = false
  p.vy = 0
}

const web = () => sim.player.web || (initWeb(), sim.player.web)

/** カメラ中央の視線方向 */
export function aimDirection() {
  const c = sim.camera
  const cosP = Math.cos(c.pitch)
  // カメラは注視点の +(sin yaw, sin pitch, cos yaw) 側に居るので、前方はその逆
  return { x: -Math.sin(c.yaw) * cosP, y: -Math.sin(c.pitch), z: -Math.cos(c.yaw) * cosP }
}

/** カメラ方向を基準に、円錐内＋上方向へ振った探索方向を作る */
function aimSamples() {
  const base = aimDirection()
  const yaw = Math.atan2(-base.x, -base.z)      // カメラの水平向き
  const pitch = Math.asin(Math.max(-1, Math.min(1, -base.y)))
  const out = [{ x: base.x, y: base.y, z: base.z, dev: 0 }]
  const cone = (W.aimCone * Math.PI) / 180
  const up = (W.upwardBias * Math.PI) / 180
  for (let r = 1; r <= W.rings; r++) {
    const spread = (cone * r) / W.rings
    for (let a = 0; a < W.perRing; a++) {
      const ang = (a / W.perRing) * Math.PI * 2
      const dYaw = Math.cos(ang) * spread
      const dPitch = Math.sin(ang) * spread
      pushDir(out, yaw + dYaw, pitch + dPitch, spread)
    }
  }
  // 上を優先して探すための追加方向（高いビルの上部や屋根を掴みやすくする）
  for (let s = 1; s <= 3; s++) {
    pushDir(out, yaw, pitch + (up * s) / 3, (up * s) / 3)
    pushDir(out, yaw - cone * 0.5, pitch + (up * s) / 3, cone * 0.5 + (up * s) / 3)
    pushDir(out, yaw + cone * 0.5, pitch + (up * s) / 3, cone * 0.5 + (up * s) / 3)
  }
  return out
}

function pushDir(out, yaw, pitch, dev) {
  const cp = Math.cos(pitch)
  out.push({ x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp, dev })
}

/**
 * 有効な接続点を探す。壁越し・空・NPC・飛んでいる残骸には付かない。
 * 円錐内を複数方向へ走査し、「できるだけ高い場所」を優先して選ぶ。
 */
export function findAnchor() {
  const p = sim.player
  const ox = p.pos.x, oy = p.pos.y + 1.4, oz = p.pos.z
  const dirs = aimSamples()
  let best = null

  if (registry.ready) {
    for (const d of dirs) {
      const hit = raycastStructure(ox, oy, oz, d.x, d.y, d.z, W.maxDistance)
      if (!hit || hit.dist < W.minDistance) continue
      const height = hit.y - p.pos.y
      if (height < W.minHeight) continue
      // 高さを最優先し、カメラ中央からのズレをわずかに減点する
      const score = height - d.dev * 6 - hit.dist * 0.02
      if (!best || score > best.score) {
        best = { x: hit.x, y: hit.y, z: hit.z, partId: hit.part.id, kind: 'structure', height, score }
      }
    }
    // 十分高い場所が見つかったらそれを使う
    if (best && best.height >= W.preferHeight) return best
  }

  // 地形（崖・屋根の上の地形など）。射線を刻んで最初に地面へ潜る点を探す
  const base = dirs[0]
  const step = 0.8
  for (let t = W.minDistance; t <= W.maxDistance; t += step) {
    const x = ox + base.x * t, y = oy + base.y * t, z = oz + base.z * t
    const gy = groundY(x, z, -999)
    if (gy > -900 && y <= gy) {
      const height = gy - p.pos.y
      if (height < W.minHeight) break
      const score = height - t * 0.02
      if (!best || score > best.score) best = { x, y: gy + 0.2, z, partId: -1, kind: 'terrain', height, score }
      break
    }
  }
  return best
}

/** 糸を撃つ */
export function tryWebAttach() {
  const p = sim.player
  const w = web()
  if (p.dead) return false
  if (!p.skills.includes('webswing')) return false
  if (sim.time < w.cooldownUntil) return false
  const a = findAnchor()
  if (!a) {
    if (sim.time - (w.lastFailSay || 0) > 1.2) { w.lastFailSay = sim.time; say('糸を張れる場所が無い。建物や柱を狙おう。', 'warn') }
    return false
  }
  w.attached = true
  w.zipping = false            // ジップ中に撃ち直したら、そのまま次の糸へ繋ぐ
  w.ax = a.x; w.ay = a.y; w.az = a.z
  w.partId = a.partId
  w.rope = Math.max(W.minRope, Math.hypot(a.x - p.pos.x, a.y - (p.pos.y + 1.4), a.z - p.pos.z))
  w.swings++
  p.airborne = true
  if (p.vy === undefined) p.vy = 0
  // 地上から撃ったときに引きずられないよう、糸を張った瞬間に軽く跳ね上がる
  p.vy = Math.max(p.vy, W.launchLift)
  w.attachedAt = sim.time
  addEffect({ kind: 'ring', x: a.x, y: a.y, z: a.z, radius: 0.9, color: '#dff6ff', life: 0.35 })
  p.tutorialActions.webswing = true
  return true
}

/**
 * 糸を離す。
 * 既定では「糸を張った場所まで一気に飛んでいく」(ジップ)。
 * @param {boolean} zip false なら飛ばずに切るだけ（接続先が壊れたとき等）
 */
export function webRelease(zip = true) {
  const p = sim.player
  const w = web()
  if (!w.attached) return
  w.attached = false
  w.lastDetach = sim.time
  w.cooldownUntil = sim.time + W.cooldown
  if (zip) {
    // 接続点を目標にして飛ぶ。糸はまだ見えたままにしておく。
    w.zipping = true
    w.zipUntil = sim.time + W.zip.timeout
    w.zipTarget = { x: w.ax, y: w.ay, z: w.az }
    p.airborne = true
    p.vy = Math.max(p.vy, 0) + W.releaseLift * 0.4
  } else {
    w.zipping = false
    w.partId = -1
  }
}

/** ジップを打ち切る（到着・衝突・対象消失） */
function endZip(arrived) {
  const p = sim.player
  const w = web()
  if (!w.zipping) return
  w.zipping = false
  w.partId = -1
  if (arrived) {
    // 到着した勢いを残しつつ上へ跳ね上げ、屋根の上へ飛び出せるようにする
    p.vel.x *= W.zip.exitKeep * W.releaseBoost
    p.vel.z *= W.zip.exitKeep * W.releaseBoost
    p.vy = Math.max(p.vy, 0) + W.zip.exitLift
    addEffect({ kind: 'ring', x: p.pos.x, y: p.pos.y + 1.2, z: p.pos.z, radius: 1.4, color: '#dff6ff', life: 0.3 })
  }
}

export const isSwinging = () => !!sim.player.web?.attached
export const isZipping = () => !!sim.player.web?.zipping
/** 糸が伸びている状態（描画用）: 接続中またはジップ中 */
export const webLineActive = () => !!(sim.player.web?.attached || sim.player.web?.zipping)
export const webState = () => web()

/**
 * 空中（スイング中・飛行中）のプレイヤー更新。
 * @param {{x:number,z:number,len:number}} axis カメラ相対の移動入力
 * @param {{forward:number, back:number}} hold 巻き取り／繰り出し
 * @returns {boolean} 空中処理を行ったか
 */
export function updateWeb(dt, axis, hold) {
  const p = sim.player
  const w = web()
  if (!p.airborne) return false
  if (p.dead) { w.attached = false; w.zipping = false; p.airborne = false; return false }

  // 接続先が壊れたら安全に解除する（ジップ中も含む）
  if ((w.attached || w.zipping) && w.partId >= 0) {
    const part = registry.parts[w.partId]
    if (!part || part.broken) {
      say('糸をかけた場所が崩れた！', 'warn')
      if (w.attached) webRelease(false)
      else endZip(false)
    }
  }

  // ── ジップ: 糸を張った場所まで一気に飛んでいく
  if (w.zipping) {
    const t = w.zipTarget
    let dx = t.x - p.pos.x, dy = t.y - (p.pos.y + 1.2), dz = t.z - p.pos.z
    const dist = Math.hypot(dx, dy, dz) || 1e-5
    if (dist <= W.zip.arriveRadius || sim.time > w.zipUntil) {
      endZip(dist <= W.zip.arriveRadius)
    } else {
      dx /= dist; dy /= dist; dz /= dist
      const speed = Math.hypot(p.vel.x, p.vy, p.vel.z)
      const want = Math.min(W.zip.speed, speed + W.zip.accel * dt)
      // 目標方向へ向きを揃えながら加速する（曲がりすぎず、まっすぐ飛ぶ）
      const blend = Math.min(1, dt * 9)
      p.vel.x += (dx * want - p.vel.x) * blend
      p.vy += (dy * want - p.vy) * blend - W.zip.gravity * dt
      p.vel.z += (dz * want - p.vel.z) * blend
      const moved = moveAirborne(dt, true)
      if (moved.crashed) endZip(false)
      p.yaw = Math.atan2(p.vel.x, p.vel.z)
      p.anim = 'roll'
      p.moveSpeed = Math.hypot(p.vel.x, p.vel.z)
      followCamera(dt)
      return true
    }
  }

  let ax = 0, ay = -W.gravity, az = 0

  if (w.attached) {
    const hx = p.pos.x, hy = p.pos.y + 1.4, hz = p.pos.z
    let dx = w.ax - hx, dy = w.ay - hy, dz = w.az - hz
    const dist = Math.hypot(dx, dy, dz) || 1e-5
    dx /= dist; dy /= dist; dz /= dist

    // 巻き取り / 繰り出し
    if (hold.forward) w.rope = Math.max(W.minRope, w.rope - W.reelIn * dt)
    if (hold.back) w.rope = Math.min(W.maxDistance, w.rope + W.reelOut * dt)

    const pull = dist < W.shortRange ? W.shortPull : W.pull
    ax += dx * pull
    ay += dy * pull
    az += dz * pull

    // 横入力でスイング方向を補助（糸に対して垂直な水平方向へ）
    if (axis.len > 0.01) {
      const sx = -dz, sz = dx
      const l = Math.hypot(sx, sz) || 1
      const side = (axis.x * (sx / l) + axis.z * (sz / l))
      ax += (sx / l) * side * W.lateral
      az += (sz / l) * side * W.lateral
    }
  }

  p.vel.x += ax * dt
  p.vy += ay * dt
  p.vel.z += az * dt

  // 空気抵抗
  const drag = 1 - W.drag * dt
  p.vel.x *= drag
  p.vy *= drag
  p.vel.z *= drag

  // 糸の長さを超えないよう引き戻し、接線方向の速度だけ残す（振り子）
  if (w.attached) {
    const hx = p.pos.x, hy = p.pos.y + 1.4, hz = p.pos.z
    let dx = hx - w.ax, dy = hy - w.ay, dz = hz - w.az
    const dist = Math.hypot(dx, dy, dz) || 1e-5
    if (dist > w.rope) {
      const nx = dx / dist, ny = dy / dist, nz = dz / dist
      const over = dist - w.rope
      p.pos.x -= nx * over
      p.pos.y -= ny * over
      p.pos.z -= nz * over
      const radial = p.vel.x * nx + p.vy * ny + p.vel.z * nz
      if (radial > 0) {
        p.vel.x -= nx * radial
        p.vy -= ny * radial
        p.vel.z -= nz * radial
      }
    }
  }

  moveAirborne(dt, false)

  const hs = Math.hypot(p.vel.x, p.vel.z)
  followCamera(dt)
  p.yaw = Math.atan2(p.vel.x, p.vel.z)
  p.anim = w.attached ? 'roll' : 'run'
  p.moveSpeed = hs
  return true
}

/**
 * 空中の位置更新（壁・地面との衝突、着地、場外復帰）。
 * スイング中もジップ中も同じ処理を通す。
 * @returns {{crashed:boolean, landed:boolean}}
 */
function moveAirborne(dt, zipping) {
  const p = sim.player
  const w = web()
  const out = { crashed: false, landed: false }

  // 速度上限（高速衝突で操作不能にならないように）
  const cap = zipping ? W.zip.speed : W.maxSpeed
  const speed = Math.hypot(p.vel.x, p.vy, p.vel.z)
  if (speed > cap) {
    const k = cap / speed
    p.vel.x *= k; p.vy *= k; p.vel.z *= k
  }

  const nx = p.pos.x + p.vel.x * dt
  const nz = p.pos.z + p.vel.z * dt
  const ny = p.pos.y + p.vy * dt
  const gy = groundY(nx, nz, p.pos.y)

  // 低空では壁に当たる（建物をすり抜けない）。ジップ中は少しだけ余裕を持たせる
  const clearance = zipping ? 1.2 : 2.2
  if (ny < gy + clearance) {
    const res = move(p.pos.x, p.pos.z, p.vel.x * dt, p.vel.z * dt, p.hitRadius)
    p.pos.x = res.x
    p.pos.z = res.z
    if (res.hit) {
      p.vel.x *= W.crashKeep
      p.vel.z *= W.crashKeep
      out.crashed = true
    }
  } else {
    p.pos.x = nx
    p.pos.z = nz
  }
  p.pos.y = ny

  // 着地。糸を張った直後は少しだけ猶予を持たせる（地上から撃っても離陸できる）
  const landY = groundY(p.pos.x, p.pos.z, p.pos.y)
  const justAttached = w.attached && sim.time - (w.attachedAt ?? -99) < W.launchGrace
  if (p.pos.y <= landY && justAttached) {
    p.pos.y = landY + 0.02
  } else if (p.pos.y <= landY) {
    p.pos.y = landY
    p.vy = 0
    p.airborne = false
    out.landed = true
    if (w.attached) webRelease(false)
    w.zipping = false
    if (!isWalkable(p.pos.x, p.pos.z)) {
      const n = nearestWalkable(p.pos.x, p.pos.z)
      p.pos.x = n.x
      p.pos.z = n.z
      p.pos.y = groundY(n.x, n.z, p.pos.y)
    }
    // 着地の勢いは残すが、操作不能な暴走はさせない
    p.knockback.x += THREE.MathUtils.clamp(p.vel.x * 0.35, -6, 6)
    p.knockback.z += THREE.MathUtils.clamp(p.vel.z * 0.35, -6, 6)
    p.vel.set(0, 0, 0)
  }

  // 落下しすぎたら復帰（NavMesh外へ落ちた場合）
  if (p.pos.y < -25) {
    const n = nearestWalkable(p.pos.x, p.pos.z)
    p.pos.set(n.x, groundY(n.x, n.z, 0), n.z)
    p.vel.set(0, 0, 0)
    p.vy = 0
    p.airborne = false
    w.attached = false
    w.zipping = false
    out.landed = true
  }
  return out
}

/** カメラを速度方向へ滑らかに向ける */
function followCamera(dt) {
  const p = sim.player
  const hs = Math.hypot(p.vel.x, p.vel.z)
  if (hs > 4 && !sim.settings.reducedMotion) {
    const want = Math.atan2(-p.vel.x, -p.vel.z)
    let diff = want - sim.camera.yaw
    diff = Math.atan2(Math.sin(diff), Math.cos(diff))
    sim.camera.yaw += diff * Math.min(1, dt * 1.6)
  }
}
