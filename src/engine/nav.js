/**
 * ベイク済み NavMesh(public/assets/navmesh.json)のランタイム側。
 * scripts/build-navmesh.mjs と同じ TOWN 変換前提なので座標系は一致する。
 *
 * 提供する機能:
 *   - groundY(x,z)      接地高さ(バイリニア補間)
 *   - isWalkable(x,z)   セル単位の通行判定
 *   - canStand(x,z,r)   半径を考慮した通行判定
 *   - move(pos,dx,dz,r) 壁ずり付きの移動解決(川・建物を通り抜けない)
 *   - hasLineOfSight()  敵AIの視線判定(遮蔽物越しの感知を防ぐ)
 *   - randomPointNear() 敵のスポーン・巡回先の抽選
 */
import { NAV } from '../data/world.js'

export const F = { WALK: 1, WATER: 2, BLOCK: 4 }

let nav = null

const decode = (b64, Type) => {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Type(bytes.buffer, 0, bin.length / (Type.BYTES_PER_ELEMENT || 1))
}

export async function loadNav(url = '/assets/navmesh.json') {
  if (nav) return nav
  const res = await fetch(url)
  if (!res.ok) throw new Error(`navmesh.json を読み込めません (${res.status})。npm run build:assets を実行してください`)
  const json = await res.json()
  nav = {
    ...json.grid,
    spawn: json.spawn,
    landmarks: json.landmarks,
    stats: json.stats,
    heights: decode(json.heights, Int16Array),
    ceils: json.ceils ? decode(json.ceils, Int16Array) : null,
    flags: decode(json.flags, Uint8Array),
    minimap: decode(json.minimap, Uint8Array),
  }
  // ベイク直後の状態を控えておく。建物を壊してセルを開けた後、町を復元するときに戻す。
  nav.baseFlags = nav.flags.slice()
  nav.baseCeils = nav.ceils ? nav.ceils.slice() : null
  return nav
}

// ───────────────────────────── 破壊による通行判定の書き換え
//
// 建物の小片を壊したら、その小片が塞いでいたセルを歩けるようにする。
// 「壊した分だけ当たり判定も消える」ようにするための最小APIをここに置く。

/** ワールド座標 → セル番号。範囲外は -1 */
export function cellIndexAt(x, z) {
  if (!nav) return -1
  const i = ci(x), j = ci(z)
  if (!inside(i, j)) return -1
  return j * nav.n + i
}

/** セル番号 → セル中心のワールド座標 */
export function cellCenter(k) {
  if (!nav) return { x: 0, z: 0 }
  const i = k % nav.n
  return { x: cx(i), z: cx((k - i) / nav.n) }
}

export const cellSize = () => (nav ? nav.cell : NAV.cell)
export const isCellBlocked = (k) => !!nav && k >= 0 && (nav.flags[k] & F.BLOCK) !== 0
export const cellGroundY = (k) => {
  if (!nav || k < 0) return null
  const h = nav.heights[k]
  return h === -32768 ? null : h / 100
}

/** 矩形に重なるセルを列挙する */
export function forEachCellInBox(minX, minZ, maxX, maxZ, fn) {
  if (!nav) return
  const i0 = Math.max(0, ci(minX)), i1 = Math.min(nav.n - 1, ci(maxX))
  const j0 = Math.max(0, ci(minZ)), j1 = Math.min(nav.n - 1, ci(maxZ))
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) fn(j * nav.n + i)
}

/**
 * セルを開通させる（壊した壁の跡を歩けるようにする）。
 * 地面の高さが取れないセル（町の外）は開けない。水面も触らない。
 * @returns {boolean} 実際に開いたか
 */
export function openCell(k) {
  if (!nav || k < 0) return false
  if (nav.flags[k] & F.WATER) return false
  if (nav.flags[k] & F.WALK) return false
  if (nav.heights[k] === -32768) return false
  nav.flags[k] = F.WALK
  // 遮蔽高さも下げる。壊れた壁でカメラが引き寄せられ続けないように。
  if (nav.ceils) nav.ceils[k] = nav.heights[k]
  return true
}

/** ベイク時の通行判定へ戻す（町の復元） */
export function restoreNav() {
  if (!nav || !nav.baseFlags) return
  nav.flags.set(nav.baseFlags)
  if (nav.ceils && nav.baseCeils) nav.ceils.set(nav.baseCeils)
}

export const getNav = () => nav
export const isNavReady = () => !!nav
export const landmarks = () => nav?.landmarks ?? []
export const findLandmark = (id) => nav?.landmarks.find((l) => l.id === id)
export const spawnPoint = () => nav?.spawn ?? { x: 0, y: 0, z: 0 }

const ci = (x) => Math.round((x - nav.origin) / nav.cell)
const cx = (i) => nav.origin + i * nav.cell
const inside = (i, j) => i >= 0 && j >= 0 && i < nav.n && j < nav.n

export function flagsAt(x, z) {
  if (!nav) return F.WALK
  const i = ci(x), j = ci(z)
  if (!inside(i, j)) return F.BLOCK
  return nav.flags[j * nav.n + i]
}

export const isWalkable = (x, z) => (flagsAt(x, z) & F.WALK) !== 0
export const isWater = (x, z) => (flagsAt(x, z) & F.WATER) !== 0

/** セルの高さ(m)。歩けないセルは null */
function cellY(i, j) {
  if (!inside(i, j)) return null
  const k = j * nav.n + i
  if (!(nav.flags[k] & F.WALK)) return null
  const h = nav.heights[k]
  return h === -32768 ? null : h / 100
}

/** 接地高さ。歩行セルの高さをバイリニア補間して段差のガタつきを抑える */
export function groundY(x, z, fallback = 0) {
  if (!nav) return fallback
  const fi = (x - nav.origin) / nav.cell
  const fj = (z - nav.origin) / nav.cell
  const i0 = Math.floor(fi), j0 = Math.floor(fj)
  const tx = fi - i0, tz = fj - j0
  let sum = 0, weight = 0
  for (let dj = 0; dj <= 1; dj++) {
    for (let di = 0; di <= 1; di++) {
      const y = cellY(i0 + di, j0 + dj)
      if (y === null) continue
      const w = (di ? tx : 1 - tx) * (dj ? tz : 1 - tz)
      sum += y * w
      weight += w
    }
  }
  if (weight > 0.001) return sum / weight
  // 周囲に歩行セルが無ければ最寄りセルの生値を使う
  const k = ci(z) * nav.n + ci(x)
  const h = inside(ci(x), ci(z)) ? nav.heights[k] : -32768
  return h === -32768 ? fallback : h / 100
}

/** 半径 r の円が収まるか(前後左右4点+中心をチェック) */
export function canStand(x, z, r = NAV.agentRadius) {
  if (!nav) return true
  if (!isWalkable(x, z)) return false
  return isWalkable(x + r, z) && isWalkable(x - r, z) && isWalkable(x, z + r) && isWalkable(x, z - r)
}

/**
 * 移動解決。行けない方向を1軸ずつ落として壁ずりさせる。
 *
 * 段差はここで見る。NavMesh のベイク側で段差セルを潰すと段差の両側が削れて
 * 橋や縁石の通路が痩せてしまうので、「またぐ瞬間の高低差」だけを制限する。
 *
 * @returns {{x:number,z:number,hit:boolean}}
 */
export function move(x, z, dx, dz, r = NAV.agentRadius) {
  if (!nav) return { x: x + dx, z: z + dz, hit: false }
  const y0 = groundY(x, z)
  const ok = (nx, nz) => canStand(nx, nz, r) && Math.abs(groundY(nx, nz, y0) - y0) <= NAV.maxStep
  if (ok(x + dx, z + dz)) return { x: x + dx, z: z + dz, hit: false }
  // X だけ / Z だけ動かす(壁に沿って滑る)
  if (Math.abs(dx) > 1e-5 && ok(x + dx, z)) return { x: x + dx, z, hit: true }
  if (Math.abs(dz) > 1e-5 && ok(x, z + dz)) return { x, z: z + dz, hit: true }
  // 半歩だけ試す(狭い通路の引っかかり対策)
  if (ok(x + dx * 0.4, z + dz * 0.4)) return { x: x + dx * 0.4, z: z + dz * 0.4, hit: true }
  return { x, z, hit: true }
}

/** 詰まったときに一番近い歩行セルへ押し戻す */
export function nearestWalkable(x, z, maxRings = 24) {
  if (!nav) return { x, z }
  if (canStand(x, z)) return { x, z }
  const i0 = ci(x), j0 = ci(z)
  for (let r = 1; r <= maxRings; r++) {
    let best = null
    for (let dj = -r; dj <= r; dj++) {
      for (let di = -r; di <= r; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue
        const i = i0 + di, j = j0 + dj
        if (!inside(i, j) || !(nav.flags[j * nav.n + i] & F.WALK)) continue
        const px = cx(i), pz = cx(j)
        if (!canStand(px, pz)) continue
        const d = (px - x) ** 2 + (pz - z) ** 2
        if (!best || d < best.d) best = { x: px, z: pz, d }
      }
    }
    if (best) return { x: best.x, z: best.z }
  }
  return { x: nav.spawn.x, z: nav.spawn.z }
}

/** そのセルの遮蔽物の最高点(m)。何も無ければ接地高さ。 */
export function ceilY(x, z, fallback = 0) {
  if (!nav?.ceils) return fallback
  const i = ci(x), j = ci(z)
  if (!inside(i, j)) return fallback
  const v = nav.ceils[j * nav.n + i]
  return v === -32768 ? fallback : v / 100
}

/**
 * 三人称カメラが建物や地形にめり込まないよう、注視点から離せる距離を返す。
 * 注視点→希望位置の線分をたどり、遮蔽物より下を通る手前で止める。
 */
export function cameraDistance(tx, ty, tz, dirX, dirY, dirZ, wanted, minDist = 2.2) {
  if (!nav) return wanted
  const steps = Math.max(4, Math.ceil(wanted / (nav.cell * 0.8)))
  // 注視点のすぐ近くは調べない。プレイヤーが屋根の下に立っているだけで
  // カメラが最短距離まで寄ってしまうのを防ぐ。
  const first = Math.max(1, Math.ceil((minDist / wanted) * steps))
  for (let s = first; s <= steps; s++) {
    const d = (wanted * s) / steps
    const x = tx + dirX * d
    const y = ty + dirY * d
    const z = tz + dirZ * d
    const top = Math.max(ceilY(x, z, -999), groundY(x, z, -999))
    if (y < top + 0.25) {
      // 1ステップ手前まで戻す
      return Math.max(minDist, (wanted * (s - 1)) / steps)
    }
  }
  return wanted
}

/** 2点間が歩行セルだけで繋がっているか(視線・射線判定) */
export function hasLineOfSight(x0, z0, x1, z1) {
  if (!nav) return true
  const dx = x1 - x0, dz = z1 - z0
  const dist = Math.hypot(dx, dz)
  const steps = Math.ceil(dist / (nav.cell * 0.75))
  for (let s = 1; s < steps; s++) {
    const t = s / steps
    if (!isWalkable(x0 + dx * t, z0 + dz * t)) return false
  }
  return true
}

/** 中心から半径内のランダムな歩行地点(スポーン・巡回用) */
export function randomPointNear(x, z, radius, tries = 40, rng = Math.random) {
  if (!nav) return { x, z }
  for (let i = 0; i < tries; i++) {
    const a = rng() * Math.PI * 2
    const d = Math.sqrt(rng()) * radius
    const px = x + Math.cos(a) * d
    const pz = z + Math.sin(a) * d
    if (canStand(px, pz, NAV.agentRadius * 1.5)) return { x: px, z: pz }
  }
  const n = nearestWalkable(x, z)
  return n
}

/** ミニマップ用の RGBA バイト列を作る */
export function minimapImage() {
  if (!nav) return null
  const { n, minimap, flags } = nav
  const out = new Uint8ClampedArray(n * n * 4)
  for (let k = 0; k < n * n; k++) {
    out[k * 4] = minimap[k * 3]
    out[k * 4 + 1] = minimap[k * 3 + 1]
    out[k * 4 + 2] = minimap[k * 3 + 2]
    out[k * 4 + 3] = flags[k] & F.BLOCK ? 190 : 255
  }
  return { data: out, n }
}

/** ワールド座標 → ミニマップのピクセル座標(0..n) */
export function worldToMap(x, z) {
  if (!nav) return { u: 0, v: 0 }
  return { u: (x - nav.origin) / nav.cell, v: (z - nav.origin) / nav.cell }
}
