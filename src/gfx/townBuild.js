/**
 * town.glb → 「描画用のマージ済みメッシュ」＋「破壊可能な小片（parts）」を作る。
 *
 * React にも DOM にも依存しないので、ブラウザ(Town.jsx)とヘッドレステスト
 * (scripts/smoke-test.mjs)の両方から同じ結果を得られる。元GLBは書き換えない。
 *
 * 方針:
 *  - マテリアル単位でジオメトリをマージしてドローコールを抑える（従来の見た目・性能を維持）
 *  - 破壊可能なオブジェクトは、マージ前に「セル格子 × マテリアル」で小片へ分割し、
 *    マージ後のバッファ内で 1小片 = 連続した頂点範囲になるよう並べる
 *  - 小片を壊すときは、その範囲の頂点を1点へ潰すだけ（ジオメトリの作り直しをしない）
 */
import * as THREE from 'three'
import { TOWN } from '../data/world.js'
import { CHUNKING, categoryOf, BREAKABLE, partTypeOf, statsFor } from '../data/destructibles.js'

/** マージできる形(position/normal のみ・非インデックス・ワールド変換済み)に整える */
function normalize(geometry, matrixWorld) {
  let g = geometry.clone()
  g.clearGroups()
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal') g.deleteAttribute(name)
  }
  if (!g.attributes.normal) g.computeVertexNormals()
  if (g.index) {
    const flat = g.toNonIndexed()
    g.dispose()
    g = flat
  }
  g.applyMatrix4(matrixWorld)
  return g
}

/** マルチマテリアルメッシュを materialIndex ごとの部分ジオメトリへ分解 */
function splitGroups(geometry, materialIndex) {
  const ranges = geometry.groups.filter((g) => g.materialIndex === materialIndex)
  if (!ranges.length) return null
  const src = geometry.index ? geometry.toNonIndexed() : geometry
  const pos = src.attributes.position
  const nor = src.attributes.normal
  const total = ranges.reduce((a, r) => a + r.count, 0)
  const outPos = new Float32Array(total * 3)
  const outNor = nor ? new Float32Array(total * 3) : null
  let cursor = 0
  for (const r of ranges) {
    outPos.set(pos.array.subarray(r.start * 3, (r.start + r.count) * 3), cursor * 3)
    if (outNor) outNor.set(nor.array.subarray(r.start * 3, (r.start + r.count) * 3), cursor * 3)
    cursor += r.count
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(outPos, 3))
  if (outNor) g.setAttribute('normal', new THREE.BufferAttribute(outNor, 3))
  else g.computeVertexNormals()
  if (src !== geometry) src.dispose()
  return g
}

/** ジオメトリを格子セルごとの三角形グループへ分ける */
function chunkTriangles(geometry) {
  const pos = geometry.attributes.position.array
  const triCount = pos.length / 9
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let i = 0; i < pos.length; i += 3) {
    if (pos[i] < minX) minX = pos[i]
    if (pos[i] > maxX) maxX = pos[i]
    if (pos[i + 1] < minY) minY = pos[i + 1]
    if (pos[i + 1] > maxY) maxY = pos[i + 1]
    if (pos[i + 2] < minZ) minZ = pos[i + 2]
    if (pos[i + 2] > maxZ) maxZ = pos[i + 2]
  }
  const dim = Math.max(maxX - minX, maxY - minY, maxZ - minZ)
  const cell = Math.max(CHUNKING.cell, dim / CHUNKING.maxCellsPerAxis)
  /** @type {Map<string, number[]>} */
  const cells = new Map()
  for (let t = 0; t < triCount; t++) {
    const o = t * 9
    const cx = (pos[o] + pos[o + 3] + pos[o + 6]) / 3
    const cy = (pos[o + 1] + pos[o + 4] + pos[o + 7]) / 3
    const cz = (pos[o + 2] + pos[o + 5] + pos[o + 8]) / 3
    const key = `${Math.floor((cx - minX) / cell)},${Math.floor((cy - minY) / cell)},${Math.floor((cz - minZ) / cell)}`
    let list = cells.get(key)
    if (!list) cells.set(key, (list = []))
    list.push(t)
  }
  // 三角形が少なすぎるセルは一番近い大きなセルへ吸収する（極小の破片を作らない）
  const keys = [...cells.keys()].sort()
  const kept = keys.filter((k) => cells.get(k).length >= CHUNKING.minTrisPerChunk)
  if (kept.length === 0) return [{ tris: Array.from({ length: triCount }, (_, i) => i), box: { minX, minY, minZ, maxX, maxY, maxZ } }]
  const parse = (k) => k.split(',').map(Number)
  for (const k of keys) {
    if (kept.includes(k)) continue
    const [a, b, c] = parse(k)
    let best = kept[0]
    let bestD = Infinity
    for (const kk of kept) {
      const [x, y, z] = parse(kk)
      const d = (x - a) ** 2 + (y - b) ** 2 + (z - c) ** 2
      if (d < bestD) { bestD = d; best = kk }
    }
    cells.get(best).push(...cells.get(k))
    cells.delete(k)
  }
  return kept.map((k) => ({ tris: cells.get(k), box: { minX, minY, minZ, maxX, maxY, maxZ } }))
}

/** 三角形番号の集合から独立したジオメトリを作る */
function sliceGeometry(geometry, tris) {
  const pos = geometry.attributes.position.array
  const nor = geometry.attributes.normal?.array
  const outPos = new Float32Array(tris.length * 9)
  const outNor = new Float32Array(tris.length * 9)
  for (let i = 0; i < tris.length; i++) {
    const src = tris[i] * 9
    outPos.set(pos.subarray(src, src + 9), i * 9)
    if (nor) outNor.set(nor.subarray(src, src + 9), i * 9)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(outPos, 3))
  g.setAttribute('normal', new THREE.BufferAttribute(nor ? outNor : new Float32Array(outPos.length), 3))
  if (!nor) g.computeVertexNormals()
  return g
}

const boxOf = (arr) => {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let i = 0; i < arr.length; i += 3) {
    if (arr[i] < minX) minX = arr[i]
    if (arr[i] > maxX) maxX = arr[i]
    if (arr[i + 1] < minY) minY = arr[i + 1]
    if (arr[i + 1] > maxY) maxY = arr[i + 1]
    if (arr[i + 2] < minZ) minZ = arr[i + 2]
    if (arr[i + 2] > maxZ) maxZ = arr[i + 2]
  }
  return { minX, minY, minZ, maxX, maxY, maxZ }
}

/**
 * @param {THREE.Object3D} scene  GLTF の scene（TOWN 変換はここで適用する）
 * @param {object} opts
 * @param {boolean} opts.withGeometry  true ならマージ済みメッシュも作る（描画用）
 */
export function buildTown(scene, { withGeometry = true } = {}) {
  scene.scale.setScalar(TOWN.scale)
  scene.position.fromArray(TOWN.position)
  scene.rotation.y = TOWN.rotationY
  scene.updateMatrixWorld(true)

  /** @type {Map<any, {geoms: THREE.BufferGeometry[], index: number}>} */
  const buckets = new Map()
  const bucketOrder = []
  /** 破壊可能な小片。マージ後に vStart を埋める。 */
  const parts = []
  let sourceMeshes = 0
  let tris = 0

  const bucketFor = (mat) => {
    let b = buckets.get(mat)
    if (!b) {
      b = { material: mat, geoms: [], index: bucketOrder.length, entries: [] }
      buckets.set(mat, b)
      bucketOrder.push(b)
    }
    return b
  }

  const objBoxes = new Map()

  for (const top of scene.children) {
    const category = categoryOf(top.name)
    const breakable = BREAKABLE.has(category)
    const meshes = []
    top.traverse((o) => { if (o.isMesh && o.geometry?.attributes?.position) meshes.push(o) })
    if (!meshes.length) continue

    for (const mesh of meshes) {
      sourceMeshes++
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      const objectPath = `${top.name}/${mesh.name || 'mesh'}`

      for (let mi = 0; mi < mats.length; mi++) {
        let g
        if (mats.length === 1) g = normalize(mesh.geometry, mesh.matrixWorld)
        else {
          const part = splitGroups(mesh.geometry, mi)
          if (!part) continue
          g = normalize(part, mesh.matrixWorld)
          part.dispose()
        }
        tris += g.attributes.position.count / 3
        const bucket = bucketFor(mats[mi])

        if (!breakable) {
          bucket.geoms.push(g)
          bucket.entries.push({ count: g.attributes.position.count, part: null })
          continue
        }

        // 破壊可能: セルごとに切り出して独立した小片にする
        const groups = chunkTriangles(g)
        const ob = objBoxes.get(top.name)
        const gb = boxOf(g.attributes.position.array)
        objBoxes.set(top.name, ob ? {
          minX: Math.min(ob.minX, gb.minX), minY: Math.min(ob.minY, gb.minY), minZ: Math.min(ob.minZ, gb.minZ),
          maxX: Math.max(ob.maxX, gb.maxX), maxY: Math.max(ob.maxY, gb.maxY), maxZ: Math.max(ob.maxZ, gb.maxZ),
        } : gb)

        for (const grp of groups) {
          const sub = sliceGeometry(g, grp.tris)
          const p = sub.attributes.position.array
          const b = boxOf(p)
          const part = {
            id: parts.length,
            objectPath,
            objectName: top.name,
            category,
            bucket: bucket.index,
            cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, cz: (b.minZ + b.maxZ) / 2,
            hx: Math.max(0.02, (b.maxX - b.minX) / 2),
            hy: Math.max(0.02, (b.maxY - b.minY) / 2),
            hz: Math.max(0.02, (b.maxZ - b.minZ) / 2),
            triCount: grp.tris.length,
            pos: p,
            nor: sub.attributes.normal.array,
            vStart: 0,
            vCount: p.length / 3,
          }
          parts.push(part)
          bucket.geoms.push(sub)
          bucket.entries.push({ count: part.vCount, part })
        }
        g.dispose()
      }
    }
  }

  // マージして頂点範囲を確定させる
  const merged = []
  for (const bucket of bucketOrder) {
    let cursor = 0
    for (const e of bucket.entries) {
      if (e.part) e.part.vStart = cursor
      cursor += e.count
    }
    if (!withGeometry) {
      bucket.geoms.forEach((x) => x.dispose())
      merged.push({ material: bucket.material, geometry: null, vertexCount: cursor })
      continue
    }
    const g = bucket.geoms.length > 1 ? mergeSimple(bucket.geoms) : bucket.geoms[0]
    bucket.geoms.forEach((x) => { if (x !== g) x.dispose() })
    g.computeBoundingSphere()
    g.computeBoundingBox()
    merged.push({ material: bucket.material, geometry: g, vertexCount: cursor })
  }

  // 部位判定とステータス、支持関係
  for (const part of parts) {
    const objBox = objBoxes.get(part.objectName) || { minY: part.cy - part.hy, maxY: part.cy + part.hy }
    part.partType = partTypeOf(part.category, part, objBox)
    part.objMinY = objBox.minY
    part.objMaxY = objBox.maxY
    const volume = part.hx * part.hy * part.hz * 8
    part.volume = volume
    Object.assign(part, statsFor(part.category, part.partType, volume))
    part.maxHp = part.hp
  }
  linkSupports(parts)

  return { merged, parts, stats: { sourceMeshes, triangles: Math.round(tris), buckets: merged.length, parts: parts.length } }
}

/** position/normal だけの単純マージ（BufferGeometryUtils を使わず依存を減らす） */
function mergeSimple(geoms) {
  let total = 0
  for (const g of geoms) total += g.attributes.position.count
  const pos = new Float32Array(total * 3)
  const nor = new Float32Array(total * 3)
  let cursor = 0
  for (const g of geoms) {
    pos.set(g.attributes.position.array, cursor * 3)
    nor.set(g.attributes.normal.array, cursor * 3)
    cursor += g.attributes.position.count
  }
  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3))
  return out
}

/**
 * 支持関係を作る。同じオブジェクト内で「自分より上にあり、水平に近い」小片を
 * supports に入れる。下の柱・壁を壊すと、それらが遅れて崩れる。
 */
function linkSupports(parts) {
  const byObject = new Map()
  for (const p of parts) {
    let list = byObject.get(p.objectName)
    if (!list) byObject.set(p.objectName, (list = []))
    list.push(p)
    p.supports = []
    p.supportCount = 0
  }
  for (const list of byObject.values()) {
    for (const a of list) {
      const rel = (a.cy - a.objMinY) / Math.max(0.001, a.objMaxY - a.objMinY)
      // 下部の小片だけが「支え」になる
      if (rel > 0.45) continue
      const r = a.chainBreakRadius * 1.5
      for (const b of list) {
        if (b === a) continue
        if (b.cy <= a.cy + a.hy * 0.5) continue
        if (Math.abs(b.cx - a.cx) > r || Math.abs(b.cz - a.cz) > r) continue
        a.supports.push(b.id)
        b.supportCount++
      }
    }
  }
}
