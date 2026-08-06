/**
 * 最終ボスの身体を「建物の小片」と同じ粒度へ分割する。
 *
 * 町の破壊(destruct.js)は town.glb を小さなAABBの集合として持ち、壊した小片を
 * 見た目から消して破片(debris)へ差し替える。ボスはアニメーションするスキンメッシュなので
 * オブジェクトを分割できない。そこで
 *
 *   1. 頂点ごとに「支配的な骨 + 骨ローカルの格子セル」でチャンク番号を振り、頂点属性へ焼く
 *   2. 壊れたチャンクの番号をマスクテクスチャへ立て、フラグメントシェーダで discard する
 *
 * ことで、身体そのものから小片が欠ける。判定と破片の生成はエンジン側(finalBoss.js)が持つ。
 */
import * as THREE from 'three'
import { boneKey } from '../data/finalBoss.js'

/** 指・つま先は独立して壊れても分かりにくいので、手・足へまとめる。 */
const MERGE_INTO = [
  [/hand(thumb|index|middle|ring|pinky)/i, /hand$/i],
  [/toe/i, /foot$/i],
]

/**
 * バインドポーズの骨配置から、骨ローカル座標をワールド実寸へ直すための2値を測る。
 *
 *   height … バインド姿勢での全高（バインドワールド単位）
 *   scale  … 骨ローカル → バインドワールド の倍率（逆バインド行列に入っている拡大の逆数）
 *
 * 実行時の倍率は  visualHeight / height * scale  になる。
 * このモデルは行列が悪条件で、CPUでスキニングを再現すると数値が発散する
 * （代表頂点で4700万mまで飛ぶ）ため、骨のワールド行列とこの倍率で小片を置く。
 */
function measureBindPose(skeleton) {
  const m = new THREE.Matrix4()
  const s = new THREE.Vector3()
  let min = Infinity, max = -Infinity, scale = 1
  skeleton.boneInverses.forEach((inverse, i) => {
    m.copy(inverse).invert()
    const y = m.elements[13]
    if (Number.isFinite(y)) { min = Math.min(min, y); max = Math.max(max, y) }
    if (i === 0) {
      s.setFromMatrixScale(m)
      const avg = (s.x + s.y + s.z) / 3
      if (Number.isFinite(avg) && avg > 0) scale = avg
    }
  })
  return { height: max > min ? max - min : 0, scale }
}

/** 骨 index → まとめ先の骨 index */
function buildBoneGroups(bones) {
  const map = new Array(bones.length)
  for (let i = 0; i < bones.length; i++) {
    map[i] = i
    const name = bones[i].name
    for (const [child, parent] of MERGE_INTO) {
      if (!child.test(name)) continue
      const side = /left/i.test(name) ? 'left' : /right/i.test(name) ? 'right' : ''
      const target = bones.findIndex((b) => parent.test(b.name) && (!side || new RegExp(side, 'i').test(b.name)))
      if (target >= 0) map[i] = target
      break
    }
  }
  return map
}

/**
 * スキンメッシュをチャンクへ分割し、頂点属性とマスクを仕込む。
 * @returns {{chunks: Array, setBroken: Function, dispose: Function}|null}
 */
export function buildFinalBossChunks(meshes, targetChunks = 320) {
  const usable = meshes.filter((m) => m.isSkinnedMesh && m.geometry?.attributes?.skinIndex)
  if (!usable.length) return null

  const skeleton = usable[0].skeleton
  const groups = buildBoneGroups(skeleton.bones)

  // 骨ローカル座標をまとめて求め、格子の大きさを決める
  const perMesh = usable.map((mesh) => {
    const g = mesh.geometry
    const pos = g.attributes.position
    const si = g.attributes.skinIndex
    const sw = g.attributes.skinWeight
    const count = pos.count
    const bone = new Int32Array(count)
    const local = new Float32Array(count * 3)
    const v = new THREE.Vector3()
    const m = new THREE.Matrix4()
    for (let i = 0; i < count; i++) {
      let best = 0, bestW = -1
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(i, k)
        if (w > bestW) { bestW = w; best = si.getComponent(i, k) }
      }
      const group = groups[best] ?? best
      bone[i] = group
      // 骨ローカル = boneInverse * bindMatrix * 頂点
      m.multiplyMatrices(skeleton.boneInverses[group], mesh.bindMatrix)
      v.fromBufferAttribute(pos, i).applyMatrix4(m)
      local[i * 3] = v.x; local[i * 3 + 1] = v.y; local[i * 3 + 2] = v.z
    }
    return { mesh, bone, local, count }
  })

  let extent = 0
  for (const { local, count } of perMesh) {
    for (let i = 0; i < count; i++) extent = Math.max(extent, Math.abs(local[i * 3]), Math.abs(local[i * 3 + 1]), Math.abs(local[i * 3 + 2]))
  }
  if (!(extent > 0)) return null

  // 目標チャンク数に収まるまで格子を粗くする
  let cell = extent / 6
  let chunkIndex = new Map()
  for (let attempt = 0; attempt < 8; attempt++) {
    chunkIndex = new Map()
    for (const { bone, local, count } of perMesh) {
      for (let i = 0; i < count; i++) {
        const key = `${bone[i]}:${Math.floor(local[i * 3] / cell)}:${Math.floor(local[i * 3 + 1] / cell)}:${Math.floor(local[i * 3 + 2] / cell)}`
        if (!chunkIndex.has(key)) chunkIndex.set(key, chunkIndex.size)
      }
    }
    if (chunkIndex.size <= targetChunks) break
    cell *= 1.35
  }

  // チャンクの代表頂点（重心に一番近い頂点）と半径を求める
  const acc = Array.from({ length: chunkIndex.size }, () => ({ n: 0, x: 0, y: 0, z: 0, bone: 0, mesh: 0, best: -1, bestD: Infinity, r: 0 }))
  const assign = perMesh.map(({ count }) => new Float32Array(count))
  perMesh.forEach(({ bone, local, count }, mi) => {
    for (let i = 0; i < count; i++) {
      const key = `${bone[i]}:${Math.floor(local[i * 3] / cell)}:${Math.floor(local[i * 3 + 1] / cell)}:${Math.floor(local[i * 3 + 2] / cell)}`
      const id = chunkIndex.get(key)
      assign[mi][i] = id
      const a = acc[id]
      a.n++; a.x += local[i * 3]; a.y += local[i * 3 + 1]; a.z += local[i * 3 + 2]
      a.bone = bone[i]; a.mesh = mi
    }
  })
  for (const a of acc) { if (a.n) { a.x /= a.n; a.y /= a.n; a.z /= a.n } }
  perMesh.forEach(({ local, count }, mi) => {
    for (let i = 0; i < count; i++) {
      const id = assign[mi][i]
      const a = acc[id]
      if (a.mesh !== mi) continue
      const d = (local[i * 3] - a.x) ** 2 + (local[i * 3 + 1] - a.y) ** 2 + (local[i * 3 + 2] - a.z) ** 2
      a.r = Math.max(a.r, Math.sqrt(d))
      if (d < a.bestD) { a.bestD = d; a.best = i }
    }
  })

  // 頂点属性とマスクテクスチャ
  perMesh.forEach(({ mesh }, mi) => {
    mesh.geometry.setAttribute('aChunk', new THREE.BufferAttribute(assign[mi], 1))
  })
  const side = Math.max(1, Math.ceil(Math.sqrt(chunkIndex.size)))
  const data = new Uint8Array(side * side)
  const mask = new THREE.DataTexture(data, side, side, THREE.RedFormat, THREE.UnsignedByteType)
  mask.minFilter = mask.magFilter = THREE.NearestFilter
  mask.needsUpdate = true

  for (const { mesh } of perMesh) injectMask(mesh.material, mask, side)

  const chunks = acc.map((a, id) => ({
    id,
    boneIndex: a.bone,
    boneName: boneKey(skeleton.bones[a.bone]?.name || ''),
    meshIndex: a.mesh,
    // 骨ローカルの重心。実行時に骨のワールド行列へ載せて位置を出す。
    localX: a.x, localY: a.y, localZ: a.z,
    localRadius: a.r || cell * 0.5,
    vertices: a.n,
  }))

  const bind = measureBindPose(skeleton)
  return {
    chunks,
    bindHeight: bind.height,
    bindScale: bind.scale,
    meshes: perMesh.map((p) => p.mesh),
    /** 壊れた／戻ったをGPUのマスクへ反映する。 */
    setBroken(id, broken) {
      if (id < 0 || id >= data.length) return
      const next = broken ? 255 : 0
      if (data[id] === next) return
      data[id] = next
      mask.needsUpdate = true
    },
    reset() { data.fill(0); mask.needsUpdate = true },
    dispose() { mask.dispose() },
  }
}

/** 既存マテリアルへ「壊れたチャンクを描かない」だけを差し込む。 */
function injectMask(material, mask, side) {
  if (!material || material.userData.finalBossChunkMask) return
  material.userData.finalBossChunkMask = true
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uChunkMask = { value: mask }
    shader.uniforms.uChunkSide = { value: side }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aChunk;\nvarying float vChunk;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvChunk = aChunk;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uChunkMask;\nuniform float uChunkSide;\nvarying float vChunk;')
      .replace('#include <clipping_planes_fragment>', `
        vec2 chunkUv = vec2(mod(vChunk, uChunkSide) + 0.5, floor(vChunk / uChunkSide) + 0.5) / uChunkSide;
        if (texture2D(uChunkMask, chunkUv).r > 0.5) discard;
        #include <clipping_planes_fragment>`)
  }
  material.customProgramCacheKey = () => 'finalBossChunkMask'
  material.needsUpdate = true
}
