/**
 * 町の描画リソースを engine / 他の描画コンポーネントから引くための小さな窓口。
 * Town.jsx が組み立て、Debris.jsx と DebugOverlay.jsx が読む。
 */
import * as THREE from 'three'

export const townVisual = {
  ready: false,
  /** マテリアル配列（part.bucket が添字） */
  materials: [],
  /** マージ済みジオメトリ（part.bucket が添字） */
  geometries: [],
  /** 小片ID → 破片用ジオメトリ（遅延生成してキャッシュ） */
  cache: new Map(),
  parts: [],
}

/** 小片を破片として飛ばすためのジオメトリ（中心を原点に揃える） */
export function debrisGeometry(part) {
  let g = townVisual.cache.get(part.id)
  if (g) return g
  const src = part.pos
  const pos = new Float32Array(src.length)
  for (let i = 0; i < src.length; i += 3) {
    pos[i] = src[i] - part.cx
    pos[i + 1] = src[i + 1] - part.cy
    pos[i + 2] = src[i + 2] - part.cz
  }
  g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(part.nor), 3))
  g.computeBoundingSphere()
  // 破片は上限で使い回すので、キャッシュが増えすぎたら古いものを捨てる
  if (townVisual.cache.size > 220) {
    const first = townVisual.cache.keys().next().value
    townVisual.cache.get(first)?.dispose()
    townVisual.cache.delete(first)
  }
  townVisual.cache.set(part.id, g)
  return g
}

/** 頂点範囲の更新をGPUへ最小限で伝える */
export function markRange(attr, startVert, countVert) {
  if (typeof attr.addUpdateRange === 'function') {
    attr.addUpdateRange(startVert * 3, countVert * 3)
  } else if (attr.updateRange) {
    attr.updateRange.offset = startVert * 3
    attr.updateRange.count = countVert * 3
  }
  attr.needsUpdate = true
}
