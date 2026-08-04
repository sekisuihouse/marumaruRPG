/**
 * town.glb から NavMesh(歩行可能グリッド)・ランドマーク・ミニマップ画像をベイクする。
 *
 *   node scripts/build-navmesh.mjs   →  public/assets/navmesh.json
 *
 * 手順:
 *  1. 町のメッシュを「地面/水/障害物」に分類(トップレベルのオブジェクト名で判定)
 *  2. グリッド各セルの中心へ真上からレイを落とし、全交差を取得
 *  3. 一番上の地面ヒットを接地高さにする。体の高さ(0.35〜2m)に障害物ヒットがあれば壁。
 *     頭上のもの(軒・屋根・鳥居の笠木)はくぐれるので塞がない
 *  4. 川(水)は非歩行
 *  5. スポーン地点から4近傍フラッドフィルし(maxStep 超の段差は越えない)、
 *     到達できない孤島セル=建物の内部や登れない崖の上を落とす
 *  6. セルごとの色を拾ってミニマップ画像も同時に生成
 *
 * ランタイム(src/engine/nav.js)は同じ TOWN 変換を使うので座標系が一致する。
 */
import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { TOWN, NAV, SPAWN } from '../src/data/world.js'

const OUT = 'public/assets/navmesh.json'

/**
 * トップレベル名がこれらに一致するものは「地面」(この上を歩ける)。
 *
 * 注意: 接地高さは「一番上の地面ヒット」を採る。屋根や看板を持つオブジェクトを
 * ここに入れると、その天面を地面と誤認して足元に巨大な段差ができる。
 * 一方通行(信号機)・ステージ・マルシェはそれで足元が塞がっていたので障害物へ移した。
 */
const GROUND = [/^地面/, /^ふち/, /^駐車場地面/, /^ガソスタ地面/, /^土$/, /^NURBSパス/, /^棚田/, /^畑/, /^Loop$/]
/** 水面(非歩行) */
const WATER = [/^川$/]
/** 通行判定から除外(装飾・空中物) */
const IGNORE = [/^花火/]

const classify = (name) => {
  if (IGNORE.some((r) => r.test(name))) return 'ignore'
  if (WATER.some((r) => r.test(name))) return 'water'
  if (GROUND.some((r) => r.test(name))) return 'ground'
  return 'obstacle'
}

/** クエストで使うランドマーク(トップレベル名 → 表示名) */
const LANDMARKS = {
  社: '鎮守の社', 鳥居: '朱の鳥居', カフェ: '未来カフェ', 温泉: '湯けむり温泉',
  コンビニ: '夜明けコンビニ', パン屋: '窯焼きパン屋', 集会所: '集会所', ステージ: '祭ステージ',
  キャンプ: 'キャンプ広場', 棚田: '棚田', 畑: '畑', マルシェ: 'マルシェ',
  ガソスタ: '給油スタンド', ブランコ: '公園のブランコ', HOME: '未来ハウス', ROOMS: '滞在ルーム',
}

const gltf = await new Promise((res, rej) =>
  new GLTFLoader().parse(new Uint8Array(fs.readFileSync('public/assets/town.glb')).buffer, '', res, rej))

const town = gltf.scene
town.scale.setScalar(TOWN.scale)
town.position.fromArray(TOWN.position)
town.rotation.y = TOWN.rotationY
town.updateMatrixWorld(true)

// --- メッシュ分類 ---
const kindOf = new Map()
const meshes = { ground: [], water: [], obstacle: [] }
for (const top of town.children) {
  const kind = classify(top.name)
  top.traverse((o) => {
    if (!o.isMesh) return
    kindOf.set(o, kind)
    if (kind !== 'ignore') meshes[kind].push(o)
  })
}
const all = [...meshes.ground, ...meshes.water, ...meshes.obstacle]
all.forEach((m) => { m.geometry.computeBoundingBox(); m.geometry.computeBoundingSphere() })
console.log(`meshes: ground=${meshes.ground.length} water=${meshes.water.length} obstacle=${meshes.obstacle.length}`)

// --- グリッド ---
const { cell, halfExtent, maxStep, minY, maxY } = NAV
const n = Math.round((halfExtent * 2) / cell)
const origin = -halfExtent + cell / 2
const idx = (i, j) => j * n + i
const heights = new Int16Array(n * n)      // cm 単位
const ceils = new Int16Array(n * n)        // そのセルの遮蔽物の高さ(cm)。カメラの当たり判定に使う
const flags = new Uint8Array(n * n)        // 1=walkable 2=water 4=blocked
const rgb = new Uint8Array(n * n * 3)      // ミニマップ用
const F = { WALK: 1, WATER: 2, BLOCK: 4 }

const ray = new THREE.Raycaster()
ray.firstHitOnly = false
const down = new THREE.Vector3(0, -1, 0)
const from = new THREE.Vector3()
const RAY_TOP = 400
const BODY = 2.0        // 体の高さ(m)。この範囲に障害物があれば通れない
const FOOT = 0.35       // 段差として乗り越えられる高さ

const WATER_COLOR = [0x4a, 0xb8, 0xe0]
const BLOCK_TINT = 0.55
const started = Date.now()

for (let j = 0; j < n; j++) {
  for (let i = 0; i < n; i++) {
    const x = origin + i * cell
    const z = origin + j * cell
    from.set(x, RAY_TOP, z)
    ray.set(from, down)
    ray.near = 0
    ray.far = RAY_TOP * 2
    const hits = ray.intersectObjects(all, false)
    const k = idx(i, j)

    let groundHit = null
    let waterY = -Infinity
    for (const h of hits) {
      const kind = kindOf.get(h.object)
      if (kind === 'ground' && (!groundHit || h.point.y > groundHit.point.y)) groundHit = h
      if (kind === 'water') waterY = Math.max(waterY, h.point.y)
    }

    // 遮蔽物の最高点(カメラを引き寄せる判定に使う)
    let topY = -Infinity
    for (const h of hits) if (kindOf.get(h.object) !== 'water') topY = Math.max(topY, h.point.y)
    ceils[k] = topY > -Infinity ? Math.round(THREE.MathUtils.clamp(topY, -320, 320) * 100) : -32768

    if (!groundHit) {
      // 地面が無い = 町の外、または川に抜けた穴
      if (waterY > -Infinity) {
        flags[k] = F.WATER
        heights[k] = Math.round(waterY * 100)
        rgb.set(WATER_COLOR, k * 3)
      } else {
        flags[k] = F.BLOCK
        heights[k] = -32768
        rgb.set([0x25, 0x33, 0x3a], k * 3)
      }
      continue
    }

    const gy = groundHit.point.y
    heights[k] = Math.round(THREE.MathUtils.clamp(gy, -320, 320) * 100)

    // 水面が地面より上にある → 川底なので水
    if (waterY > gy - 0.05) {
      flags[k] = F.WATER
      heights[k] = Math.round(waterY * 100)
      rgb.set(WATER_COLOR, k * 3)
      continue
    }

    // 体の高さ(FOOT〜BODY)に障害物があるセルだけを壁にする。
    // 頭上 BODY 以上のもの(軒・ガソスタの屋根・鳥居の笠木・信号機のアーム・木の枝)は
    // くぐれるので塞がない。建物の内部は壁で囲まれているため、
    // 後段のスポーンからのフラッドフィルが孤島として自動的に落としてくれる。
    let blocked = false
    for (const h of hits) {
      if (kindOf.get(h.object) !== 'obstacle') continue
      const dy = h.point.y - gy
      if (dy > FOOT && dy < BODY) { blocked = true; break }
    }

    const c = groundHit.object.material?.color
    const base = c ? [Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255)] : [0x7b, 0xcf, 0x5f]
    if (blocked || gy < minY || gy > maxY) {
      flags[k] = F.BLOCK
      // 障害物の色をミニマップに反映
      const ob = hits.find((h) => kindOf.get(h.object) === 'obstacle')
      const oc = ob?.object.material?.color
      rgb.set(oc
        ? [Math.round(oc.r * 255 * 0.9), Math.round(oc.g * 255 * 0.9), Math.round(oc.b * 255 * 0.9)]
        : base.map((v) => Math.round(v * BLOCK_TINT)), k * 3)
    } else {
      flags[k] = F.WALK
      rgb.set(base, k * 3)
    }
  }
  if (j % 40 === 0) process.stdout.write(`  row ${j}/${n}\r`)
}
console.log(`raycast grid ${n}x${n} in ${((Date.now() - started) / 1000).toFixed(1)}s`)

// --- 障害物の三角形をグリッドへ直接ラスタライズ ---
// セル中心のレイだけでは、信号機のポールや鳥居の柱のようにセル(0.375m)より
// 細いものを丸ごと取りこぼす。実ジオメトリの断面をそのまま塗ることで、
// 当たり判定を GLB の見た目のシルエットに一致させる。
{
  const t0 = Date.now()
  const half = cell / 2
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), nrm = new THREE.Vector3()
  let painted = 0

  /** 三角形(XZ投影)とセルの正方形が重なるか。分離軸判定。 */
  const overlaps = (ax, az, bx, bz, cx2, cz2, ox, oz) => {
    // 正方形の軸(X,Z)
    if (Math.min(ax, bx, cx2) > ox + half || Math.max(ax, bx, cx2) < ox - half) return false
    if (Math.min(az, bz, cz2) > oz + half || Math.max(az, bz, cz2) < oz - half) return false
    // 三角形の各辺の法線
    const vx = [ax, bx, cx2], vz = [az, bz, cz2]
    for (let e = 0; e < 3; e++) {
      const ex = vx[(e + 1) % 3] - vx[e], ez = vz[(e + 1) % 3] - vz[e]
      const nx = -ez, nz = ex
      const r = half * (Math.abs(nx) + Math.abs(nz))
      const centre = nx * (ox - vx[e]) + nz * (oz - vz[e])
      let lo = 0, hi = 0
      for (let k2 = 0; k2 < 3; k2++) {
        const d = nx * (vx[k2] - vx[e]) + nz * (vz[k2] - vz[e])
        lo = Math.min(lo, d); hi = Math.max(hi, d)
      }
      if (centre - r > hi || centre + r < lo) return false
    }
    return true
  }

  for (const mesh of meshes.obstacle) {
    const geo = mesh.geometry
    const pos = geo.attributes.position
    const index = geo.index
    const triCount = (index ? index.count : pos.count) / 3
    for (let f = 0; f < triCount; f++) {
      const i0 = index ? index.getX(f * 3) : f * 3
      const i1 = index ? index.getX(f * 3 + 1) : f * 3 + 1
      const i2 = index ? index.getX(f * 3 + 2) : f * 3 + 2
      a.fromBufferAttribute(pos, i0).applyMatrix4(mesh.matrixWorld)
      b.fromBufferAttribute(pos, i1).applyMatrix4(mesh.matrixWorld)
      c.fromBufferAttribute(pos, i2).applyMatrix4(mesh.matrixWorld)

      const triLoY = Math.min(a.y, b.y, c.y), triHiY = Math.max(a.y, b.y, c.y)
      const minX = Math.min(a.x, b.x, c.x), maxX = Math.max(a.x, b.x, c.x)
      const minZ = Math.min(a.z, b.z, c.z), maxZ = Math.max(a.z, b.z, c.z)
      const iLo = Math.max(0, Math.ceil((minX - half - origin) / cell))
      const iHi = Math.min(n - 1, Math.floor((maxX + half - origin) / cell))
      const jLo = Math.max(0, Math.ceil((minZ - half - origin) / cell))
      const jHi = Math.min(n - 1, Math.floor((maxZ + half - origin) / cell))
      if (iLo > iHi || jLo > jHi) continue

      // 屋根のような傾いた面は、セルの位置での実際の高さを平面から求める。
      // 三角形全体の y 範囲で判定すると、軒先が低いだけで屋根全体が壁になる。
      ab.subVectors(b, a); ac.subVectors(c, a); nrm.crossVectors(ab, ac)
      const sloped = Math.abs(nrm.y) > 1e-6 && Math.abs(nrm.y) > 0.1 * nrm.length()
      const planeD = nrm.x * a.x + nrm.y * a.y + nrm.z * a.z

      for (let j = jLo; j <= jHi; j++) {
        const oz = origin + j * cell
        for (let i = iLo; i <= iHi; i++) {
          const k = idx(i, j)
          if (!(flags[k] & F.WALK)) continue
          if (!overlaps(a.x, a.z, b.x, b.z, c.x, c.z, origin + i * cell, oz)) continue
          const gy = heights[k] / 100
          let loY = triLoY, hiY = triHiY
          if (sloped) {
            const ox = origin + i * cell
            let mn = Infinity, mx = -Infinity
            for (const [sx, sz] of [[-half, -half], [half, -half], [-half, half], [half, half]]) {
              const y = (planeD - nrm.x * (ox + sx) - nrm.z * (oz + sz)) / nrm.y
              mn = Math.min(mn, y); mx = Math.max(mx, y)
            }
            loY = Math.max(triLoY, mn); hiY = Math.min(triHiY, mx)
          }
          // 体の高さ(足元+FOOT 〜 +BODY)に断面があるときだけ壁にする
          if (hiY <= gy + FOOT || loY >= gy + BODY) continue
          flags[k] = F.BLOCK
          painted++
          for (let ch = 0; ch < 3; ch++) rgb[k * 3 + ch] = Math.round(rgb[k * 3 + ch] * BLOCK_TINT)
        }
      }
    }
  }
  console.log(`triangle raster blocked ${painted} extra cells in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
}

// 段差はセルを塞がず、ランタイムの move() が「隣へ移る瞬間の高低差」で判定する。
// 以前はここで maxStep 超のセルを潰していたが、段差の"両側"が消えるため
// 縁石や橋のたもとが一周ぶん削れて、橋が渡れない幅まで痩せていた。
const heightAt = (i, j) => heights[idx(i, j)] / 100
const walkable = (i, j) => i >= 0 && j >= 0 && i < n && j < n && (flags[idx(i, j)] & F.WALK)

// --- スポーンから到達できる領域だけを残す(段差を越えられない経路は通らない) ---
const toCell = (x, z) => [Math.round((x - origin) / cell), Math.round((z - origin) / cell)]
let [si, sj] = toCell(SPAWN.x, SPAWN.z)
if (!walkable(si, sj)) {
  // 近傍で歩けるセルを探す
  let best = null
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    if (!walkable(i, j)) continue
    const d = (i - si) ** 2 + (j - sj) ** 2
    if (!best || d < best.d) best = { i, j, d }
  }
  if (!best) throw new Error('no walkable cell at all')
  console.warn(`spawn (${SPAWN.x},${SPAWN.z}) not walkable → moved to cell ${best.i},${best.j}`)
  si = best.i; sj = best.j
}
const seen = new Uint8Array(n * n)
const queue = [idx(si, sj)]
seen[idx(si, sj)] = 1
let reach = 0
while (queue.length) {
  const k = queue.pop()
  reach++
  const i = k % n, j = (k - i) / n
  for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const ni = i + di, nj = j + dj
    if (!walkable(ni, nj)) continue
    // ランタイムの move() と同じ段差制限。登れない崖の上は到達不能として落とす。
    if (Math.abs(heightAt(ni, nj) - heightAt(i, j)) > maxStep) continue
    const nk = idx(ni, nj)
    if (seen[nk]) continue
    seen[nk] = 1
    queue.push(nk)
  }
}
let isolated = 0
for (let k = 0; k < n * n; k++) if ((flags[k] & F.WALK) && !seen[k]) { flags[k] = F.BLOCK; isolated++ }
console.log(`flood fill: reachable ${reach}, isolated ${isolated} cells dropped`)

const walkCount = flags.reduce((a, f) => a + (f & F.WALK ? 1 : 0), 0)
const waterCount = flags.reduce((a, f) => a + (f & F.WATER ? 1 : 0), 0)
console.log(`walkable ${walkCount}/${n * n} (${((walkCount / (n * n)) * 100).toFixed(1)}%)  water ${waterCount}`)

// --- ランドマーク座標 ---
const landmarks = []
for (const [name, label] of Object.entries(LANDMARKS)) {
  const o = town.getObjectByName(name)
  if (!o) { console.warn(`  ! landmark missing: ${name}`); continue }
  const box = new THREE.Box3().setFromObject(o)
  const c = box.getCenter(new THREE.Vector3())
  const size = box.getSize(new THREE.Vector3())
  // 建物の中心は歩けないので、周囲で一番近い歩行セルを入口として記録
  let entry = null
  const [ci, cj] = toCell(c.x, c.z)
  const maxR = Math.ceil(Math.max(size.x, size.z) / cell) + 6
  for (let r = 1; r <= maxR && !entry; r++) {
    for (let dj = -r; dj <= r && !entry; dj++) {
      for (let di = -r; di <= r && !entry; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue
        const i = ci + di, j = cj + dj
        if (walkable(i, j) && seen[idx(i, j)]) entry = { x: +(origin + i * cell).toFixed(2), z: +(origin + j * cell).toFixed(2), y: +heightAt(i, j).toFixed(2) }
      }
    }
  }
  landmarks.push({
    id: name, label,
    center: [+c.x.toFixed(2), +box.max.y.toFixed(2), +c.z.toFixed(2)],
    radius: +(Math.max(size.x, size.z) / 2).toFixed(2),
    entry: entry || { x: +c.x.toFixed(2), y: +c.y.toFixed(2), z: +c.z.toFixed(2) },
  })
}
console.log(`landmarks: ${landmarks.length}`)

const b64 = (typed) => Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength).toString('base64')
const spawnPoint = { x: +(origin + si * cell).toFixed(2), y: +heightAt(si, sj).toFixed(2), z: +(origin + sj * cell).toFixed(2) }
const json = {
  generatedAt: new Date().toISOString(),
  source: 'public/assets/town.glb',
  town: TOWN,
  grid: { n, cell, origin, halfExtent },
  spawn: spawnPoint,
  stats: { walkable: walkCount, water: waterCount, total: n * n },
  landmarks,
  heights: b64(heights),
  ceils: b64(ceils),
  flags: b64(flags),
  minimap: b64(rgb),
}
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(json))
console.log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)}KB), spawn=`, spawnPoint)

// --- 目視確認用のASCIIプレビュー ---
const step = Math.ceil(n / 60)
let art = ''
for (let j = 0; j < n; j += step) {
  for (let i = 0; i < n; i += step) {
    const f = flags[idx(i, j)]
    art += (i === si - (si % step) && j === sj - (sj % step)) ? '@' : f & F.WALK ? '.' : f & F.WATER ? '~' : '#'
  }
  art += '\n'
}
console.log(art)
