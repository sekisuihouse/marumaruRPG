/**
 * 建物の部分破壊。
 *
 * 建物ごとの巨大な当たり判定は持たず、town.glb を小片(part)に分けた
 * 「小さな AABB コライダーの集合」として扱う。攻撃は命中位置・半径・方向で
 * 近くの小片だけを壊し、壊れた小片は破片(debris)へ切り替わる。
 *
 *   part = { id, objectPath, hp, mass, breakThreshold, materialType, debrisImpulse, chainBreakRadius }
 *
 * 描画側(Town.jsx)は setVisualSink() で「小片を隠す/戻す」関数を渡す。
 * ヘッドレステストでは sink が無いままでも成立する。
 */
import { sim } from './sim.js'
import { spawnDebris, hitDebris, clearDebris, quality } from './debris.js'
import { impact, dust, playBreakSound } from './juice.js'
import {
  cellIndexAt, cellCenter, cellSize, cellGroundY, isCellBlocked,
  forEachCellInBox, openCell, restoreNav, isNavReady,
} from './nav.js'

const GRID = 4.0
/** NavMesh 上で「体がぶつかる高さ」。build-navmesh.mjs の FOOT/BODY と合わせる。 */
const FOOT = 0.35
const BODY = 2.0

/** @type {{parts: any[], grid: Map<string, number[]>, ready: boolean}} */
export const registry = { parts: [], grid: new Map(), ready: false }

let sink = null
const breakListeners = new Set()
/** @param {{breakPart:Function, restorePart:Function}|null} s */
export const setVisualSink = (s) => { sink = s }
/** ホスト側のネットワークなど、破壊確定を購読する軽量フック。 */
export const onPartBroken = (listener) => { breakListeners.add(listener); return () => breakListeners.delete(listener) }

const key = (ix, iz) => `${ix},${iz}`

export function registerParts(parts) {
  // 同じ町を登録し直した場合（コンポーネントの再マウント等）は、
  // 壊した状態を保ったまま何もしない。作り直すと「見た目は直ったのに
  // 通行判定は開いたまま」というズレが起きる。
  if (registry.ready && registry.parts === parts) {
    applyPendingBrokenSave()
    return registry
  }
  // 新しく町を登録するときは、通行判定を必ずベイク直後の状態から始める。
  // （前回の破壊で開けたセルが残っていると buildCellMap が対応づけを取り逃す）
  restoreNav()
  registry.parts = parts
  registry.grid = new Map()
  for (const p of parts) {
    p.broken = false
    p.hp = p.maxHp
    p.collapseAt = 0
    const i0 = Math.floor((p.cx - p.hx) / GRID), i1 = Math.floor((p.cx + p.hx) / GRID)
    const j0 = Math.floor((p.cz - p.hz) / GRID), j1 = Math.floor((p.cz + p.hz) / GRID)
    for (let i = i0; i <= i1; i++) {
      for (let jj = j0; jj <= j1; jj++) {
        const k = key(i, jj)
        let list = registry.grid.get(k)
        if (!list) registry.grid.set(k, (list = []))
        list.push(p.id)
      }
    }
  }
  registry.ready = parts.length > 0
  sim.townReady = registry.ready
  sim.destructStats = { parts: parts.length, broken: 0, pending: 0, openedCells: 0 }
  sim.pendingCollapse = []
  buildCellMap()
  // セーブから復元待ちだった破壊状況をここで適用する
  applyPendingBrokenSave()
  return registry
}

/**
 * 町の登録前に読み込んだセーブの破壊状況を適用する。
 * 適用できるまで sim.pendingBrokenSave に残しておくので、
 * 登録のタイミングがずれても取りこぼさない。
 */
export function applyPendingBrokenSave() {
  const data = sim.pendingBrokenSave
  if (!data || !registry.ready) return false
  sim.pendingBrokenSave = null
  if (applyBroken(data)) return true
  return false
}

// ───────────────────────────── 当たり判定（NavMesh）との対応づけ
//
// 小片がどの NavMesh セルを塞いでいるかを事前に求めておき、
// そのセルを塞ぐ小片が全部壊れたらセルを開通させる。
// これで「壊した分だけ当たり判定も消える」。

/** セル番号 → そのセルを塞いでいる小片ID */
let cellBlockers = new Map()

function buildCellMap() {
  cellBlockers = new Map()
  for (const p of registry.parts) p.cells = []
  if (!isNavReady()) return
  const half = cellSize() / 2
  for (const p of registry.parts) {
    forEachCellInBox(p.cx - p.hx - half, p.cz - p.hz - half, p.cx + p.hx + half, p.cz + p.hz + half, (k) => {
      // 元から歩けるセルは触らない（そこは塞いでいない）
      if (!isCellBlocked(k)) return
      const gy = cellGroundY(k)
      if (gy === null) return
      // 体の高さに断面が無い小片（屋根・軒）は通行を塞いでいない
      if (p.cy + p.hy <= gy + FOOT || p.cy - p.hy >= gy + BODY) return
      let list = cellBlockers.get(k)
      if (!list) cellBlockers.set(k, (list = []))
      list.push(p.id)
      p.cells.push(k)
    })
  }
}

/** 小片を壊したあと、塞ぐものが無くなったセルを開通させる */
function openClearedCells(p) {
  if (!p.cells || !cellBlockers.size) return
  for (const k of p.cells) {
    const list = cellBlockers.get(k)
    if (!list) continue
    let stillBlocked = false
    for (const id of list) {
      if (!registry.parts[id].broken) { stillBlocked = true; break }
    }
    if (stillBlocked) continue
    if (openCell(k)) {
      sim.destructStats.openedCells++
      const c = cellCenter(k)
      sim.navDirty = { x: c.x, z: c.z, at: sim.time }
    }
  }
}

/** 位置と半径で小片を引く（ブロードフェーズ） */
export function queryParts(x, y, z, radius) {
  const out = []
  if (!registry.ready) return out
  const i0 = Math.floor((x - radius) / GRID), i1 = Math.floor((x + radius) / GRID)
  const j0 = Math.floor((z - radius) / GRID), j1 = Math.floor((z + radius) / GRID)
  const seen = new Set()
  for (let i = i0; i <= i1; i++) {
    for (let jj = j0; jj <= j1; jj++) {
      const list = registry.grid.get(key(i, jj))
      if (!list) continue
      for (const id of list) {
        if (seen.has(id)) continue
        seen.add(id)
        const p = registry.parts[id]
        if (!p || p.broken) continue
        if (distToBox(p, x, y, z) <= radius) out.push(p)
      }
    }
  }
  return out
}

/** 点と小片AABBの距離 */
function distToBox(p, x, y, z) {
  const dx = Math.max(0, Math.abs(x - p.cx) - p.hx)
  const dy = Math.max(0, Math.abs(y - p.cy) - p.hy)
  const dz = Math.max(0, Math.abs(z - p.cz) - p.hz)
  return Math.hypot(dx, dy, dz)
}

/** 世界に建物があるか（当たり判定用の点内包チェック） */
export function isInsideStructure(x, y, z) {
  for (const p of queryParts(x, y, z, 0.01)) {
    if (Math.abs(x - p.cx) <= p.hx && Math.abs(y - p.cy) <= p.hy && Math.abs(z - p.cz) <= p.hz) return p
  }
  return null
}

/**
 * すべての攻撃はここを通って建物へ届く。
 * @param {object} hit {x,y,z, radius, dirX,dirY,dirZ, damage, kind, pierce, impulse}
 * @returns {{damaged:number, broken:number, parts:any[]}}
 */
export function damageStructure(hit) {
  const res = { damaged: 0, broken: 0, parts: [] }
  if (!registry.ready) return res
  const radius = Math.max(0.35, hit.radius ?? 1.2)
  const dirX = hit.dirX ?? 0, dirY = hit.dirY ?? 0, dirZ = hit.dirZ ?? 0
  const near = queryParts(hit.x, hit.y, hit.z, radius)
  if (!near.length) return res

  for (const p of near) {
    // 攻撃の進行方向から見て「奥すぎる」小片は無視する（壁の反対側を壊さない）
    const bx = p.cx - hit.x, by = p.cy - hit.y, bz = p.cz - hit.z
    const along = bx * dirX + by * dirY + bz * dirZ
    if (along < -radius * 0.55) continue
    const d = distToBox(p, hit.x, hit.y, hit.z)
    const falloff = Math.max(0.25, 1 - d / radius)
    const dmg = hit.damage * falloff
    if (dmg < p.breakThreshold) continue
    p.hp -= dmg
    res.damaged++
    res.parts.push(p)
    if (p.hp <= 0) {
      breakPart(p, dirX, dirY, dirZ, (hit.impulse ?? 1) * (0.7 + falloff))
      res.broken++
    }
  }
  // 残骸にも必ず当たる
  hitDebris(hit.x, hit.y, hit.z, radius * 1.4, dirX, dirY, dirZ, (hit.impulse ?? 1) * 6)
  return res
}

/** 小片を壊して破片に変える */
export function breakPart(p, dirX = 0, dirY = 0.4, dirZ = 0, impulseMul = 1, depth = 0) {
  if (!p || p.broken) return
  p.broken = true
  p.hp = 0
  sim.destructStats.broken++
  sink?.breakPart(p)
  for (const listener of breakListeners) listener(p, { dirX, dirY, dirZ, impulseMul })
  // 見た目だけでなく通行判定も同時に消す
  openClearedCells(p)

  const q = quality()
  const power = 7 * p.debrisImpulse * impulseMul
  spawnDebris({
    x: p.cx, y: p.cy, z: p.cz,
    size: Math.max(p.hx, p.hy, p.hz),
    volume: p.volume,
    mass: p.mass,
    materialType: p.materialType,
    partId: p.id,
    dirX, dirY: Math.max(0.15, dirY), dirZ,
    power,
  })
  // 追加の小片（規模に応じて派手に飛ばす）
  const extra = Math.min(q.perHit, Math.round(p.volume * 1.2 * (sim.settings.debrisAmount ?? 1) * impulseMul))
  for (let i = 0; i < extra; i++) {
    spawnDebris({
      x: p.cx + (Math.random() - 0.5) * p.hx * 2,
      y: p.cy + (Math.random() - 0.5) * p.hy * 2,
      z: p.cz + (Math.random() - 0.5) * p.hz * 2,
      size: 0.12 + Math.random() * 0.22,
      volume: 0.02,
      mass: 0.3,
      materialType: p.materialType,
      partId: -1,
      dirX, dirY: 0.5, dirZ,
      power: power * 1.4,
      spread: 1.1,
    })
  }

  const scale = Math.min(1, 0.18 + p.volume * 0.1 + impulseMul * 0.12)
  dust(p.cx, p.cy, p.cz, p.materialType, scale)
  playBreakSound(p.materialType, scale)
  impact(scale, { slowmo: false })

  if (depth < 2) {
    // 連鎖: すぐ隣の小片に衝撃が伝わる
    for (const n of queryParts(p.cx, p.cy, p.cz, p.chainBreakRadius)) {
      if (n === p || n.broken) continue
      n.hp -= p.mass * 3.2 * impulseMul
      if (n.hp <= 0) breakPart(n, dirX, dirY, dirZ, impulseMul * 0.7, depth + 1)
    }
  }

  // 支えていた上部を遅れて崩す
  if (p.supports?.length) {
    for (const id of p.supports) {
      const up = registry.parts[id]
      if (!up || up.broken) continue
      up.supportCount = Math.max(0, (up.supportCount || 0) - 1)
      if (up.supportCount === 0) {
        sim.pendingCollapse.push({ id, at: sim.time + 0.18 + Math.random() * 0.5 })
      }
    }
    sim.destructStats.pending = sim.pendingCollapse.length
  }
}

/** 遅延崩壊の処理 */
export function updateDestruct(dt) {
  const list = sim.pendingCollapse
  if (!list || !list.length) return
  for (let i = list.length - 1; i >= 0; i--) {
    if (sim.time < list[i].at) continue
    const p = registry.parts[list[i].id]
    list.splice(i, 1)
    if (p && !p.broken) breakPart(p, 0, -0.15, 0, 0.6, 1)
  }
  sim.destructStats.pending = list.length
  void dt
}

/**
 * レイと小片AABBの交差（ウェブスイングの接続点・弾の建物ヒット判定）。
 * @returns {{part:any, dist:number, x:number, y:number, z:number}|null}
 */
export function raycastStructure(ox, oy, oz, dx, dy, dz, maxDist) {
  if (!registry.ready) return null
  // ブロードフェーズ格子を XZ 平面で DDA 走査する。
  // 長距離(ウェブスイング)でも訪れるセルだけを調べるので軽い。
  let ix = Math.floor(ox / GRID)
  let iz = Math.floor(oz / GRID)
  const stepX = dx > 0 ? 1 : -1
  const stepZ = dz > 0 ? 1 : -1
  const invX = dx !== 0 ? 1 / dx : Infinity
  const invZ = dz !== 0 ? 1 / dz : Infinity
  let tMaxX = dx !== 0 ? ((ix + (dx > 0 ? 1 : 0)) * GRID - ox) * invX : Infinity
  let tMaxZ = dz !== 0 ? ((iz + (dz > 0 ? 1 : 0)) * GRID - oz) * invZ : Infinity
  const tDeltaX = dx !== 0 ? Math.abs(GRID * invX) : Infinity
  const tDeltaZ = dz !== 0 ? Math.abs(GRID * invZ) : Infinity

  const seen = new Set()
  let best = null
  let travelled = 0
  for (let guard = 0; guard < 400 && travelled <= maxDist; guard++) {
    const list = registry.grid.get(key(ix, iz))
    if (list) {
      for (const id of list) {
        if (seen.has(id)) continue
        seen.add(id)
        const p = registry.parts[id]
        if (!p || p.broken) continue
        const hit = rayBox(ox, oy, oz, dx, dy, dz, p, maxDist)
        if (hit !== null && (!best || hit < best.dist)) {
          best = { part: p, dist: hit, x: ox + dx * hit, y: oy + dy * hit, z: oz + dz * hit }
        }
      }
    }
    // このセルを抜けるまでに当たっていれば確定
    const exit = Math.min(tMaxX, tMaxZ)
    if (best && best.dist <= exit) break
    travelled = exit
    if (tMaxX < tMaxZ) { ix += stepX; tMaxX += tDeltaX } else { iz += stepZ; tMaxZ += tDeltaZ }
  }
  return best
}

function rayBox(ox, oy, oz, dx, dy, dz, p, maxDist) {
  let tmin = 0, tmax = maxDist
  const slab = (o, d, c, h) => {
    const lo = c - h, hi = c + h
    if (Math.abs(d) < 1e-8) return o >= lo && o <= hi
    let t1 = (lo - o) / d, t2 = (hi - o) / d
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp }
    if (t1 > tmin) tmin = t1
    if (t2 < tmax) tmax = t2
    return tmax >= tmin
  }
  if (!slab(ox, dx, p.cx, p.hx)) return null
  if (!slab(oy, dy, p.cy, p.hy)) return null
  if (!slab(oz, dz, p.cz, p.hz)) return null
  return tmin
}

// ───────────────────────────── 復元とセーブ

export function resetTown() {
  for (const p of registry.parts) {
    if (p.broken) sink?.restorePart(p)
    p.broken = false
    p.hp = p.maxHp
  }
  // supportCount を作り直す
  for (const p of registry.parts) p.supportCount = 0
  for (const p of registry.parts) for (const id of p.supports || []) {
    const up = registry.parts[id]
    if (up) up.supportCount++
  }
  sim.pendingCollapse = []
  sim.destructStats = { parts: registry.parts.length, broken: 0, pending: 0, openedCells: 0 }
  restoreNav()          // 開通させたセルもベイク時の状態へ戻す
  clearDebris()
}

export function serializeBroken() {
  const ids = []
  for (const p of registry.parts) if (p.broken) ids.push(p.id)
  return { total: registry.parts.length, ids }
}

export function applyBroken(data) {
  if (!data || !Array.isArray(data.ids)) return false
  if (!registry.ready) { sim.pendingBrokenSave = data; return false }
  // 小片の個数が違うセーブ（GLB差し替え等）は無視する
  if (data.total !== registry.parts.length) return false
  resetTown()
  for (const id of data.ids) {
    const p = registry.parts[id]
    if (!p || p.broken) continue
    p.broken = true
    p.hp = 0
    sim.destructStats.broken++
    sink?.breakPart(p)
  }
  // 通行判定はまとめて開け直す（1個ずつだと開通条件を満たさない順序がある）
  for (const p of registry.parts) if (p.broken) openClearedCells(p)
  sim.pendingCollapse = []
  return true
}

/** 破壊状況のデバッグ情報 */
export function destructDebug() {
  return {
    parts: registry.parts.length,
    broken: sim.destructStats?.broken ?? 0,
    pending: sim.pendingCollapse?.length ?? 0,
  }
}

/** 名前付きGLBオブジェクトごとの破壊率。ボス出現はこの小片集計だけを根拠にする。 */
export function buildingDestroyRatio(objectName) {
  const parts = registry.parts.filter((p) => p.objectName === objectName)
  if (!parts.length) return { total: 0, destroyed: 0, ratio: 0, center: { x: 0, z: 0 } }
  let destroyed = 0, x = 0, z = 0
  for (const p of parts) { if (p.broken) destroyed++; x += p.cx; z += p.cz }
  return { total: parts.length, destroyed, ratio: destroyed / parts.length, center: { x: x / parts.length, z: z / parts.length } }
}
