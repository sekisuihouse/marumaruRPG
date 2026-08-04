/**
 * 町の描画。public/assets/town.glb はそのまま使い(差し替えない)、
 * 読み込み後にマテリアル単位でジオメトリをマージしてドローコールを削減する。
 *
 * さらに、破壊可能なオブジェクト(建物・柱・小物)はマージ前に小片へ分割してあり、
 * 1小片＝マージ済みバッファ内の連続した頂点範囲になっている。壊すときは
 * その範囲を1点へ潰すだけなので、ジオメトリを作り直さずに部分破壊できる。
 * 分割ロジックは townBuild.js に置き、ヘッドレステストと共有する。
 */
import React, { useMemo } from 'react'
import { useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import { TOWN } from '../data/world.js'
import { buildTown } from './townBuild.js'
import { townVisual, markRange } from './townVisual.js'
import { registerParts, setVisualSink } from '../engine/destruct.js'

/**
 * 構築済みの町をGLBシーンごとに覚えておく。
 * <Suspense> で再マウントされても作り直さない。作り直すと
 * 「ジオメトリは無傷に戻ったのに通行判定は壊したまま」というズレが起きる。
 */
const builtTowns = new WeakMap()

export function Town() {
  const { scene } = useGLTF(TOWN.url)

  const meshes = useMemo(() => {
    const cached = builtTowns.get(scene)
    if (cached) {
      // 破壊状況ごとそのまま再利用する（登録し直しても壊れた状態は保たれる）
      registerParts(cached.parts)
      return cached.meshes
    }
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0
    const { merged, parts, stats } = buildTown(scene, { withGeometry: true })

    const out = []
    townVisual.materials = []
    townVisual.geometries = []
    townVisual.cache.forEach((g) => g.dispose())
    townVisual.cache.clear()

    merged.forEach((m, i) => {
      const mesh = new THREE.Mesh(m.geometry, m.material)
      mesh.name = `town_${m.material?.name || 'mat'}_${i}`
      mesh.castShadow = true
      mesh.receiveShadow = true
      out.push(mesh)
      townVisual.materials[i] = m.material
      townVisual.geometries[i] = m.geometry
    })
    townVisual.parts = parts
    townVisual.ready = true

    // 破壊/復元の実体。小片の頂点を中心へ潰す＝消える、書き戻す＝元通り
    setVisualSink({
      breakPart(part) {
        const geom = townVisual.geometries[part.bucket]
        if (!geom) return
        const attr = geom.attributes.position
        const arr = attr.array
        const start = part.vStart * 3
        for (let i = 0; i < part.vCount; i++) {
          arr[start + i * 3] = part.cx
          arr[start + i * 3 + 1] = part.cy
          arr[start + i * 3 + 2] = part.cz
        }
        markRange(attr, part.vStart, part.vCount)
      },
      restorePart(part) {
        const geom = townVisual.geometries[part.bucket]
        if (!geom) return
        const attr = geom.attributes.position
        attr.array.set(part.pos, part.vStart * 3)
        markRange(attr, part.vStart, part.vCount)
      },
    })
    // 登録の中でセーブの破壊状況（あれば）も適用される
    registerParts(parts)
    builtTowns.set(scene, { meshes: out, parts })

    const ms = typeof performance !== 'undefined' ? Math.round(performance.now() - t0) : 0
    console.info(`[Town] ${stats.sourceMeshes} メッシュ / ${stats.triangles} 三角形 → ${out.length} ドローコール、破壊可能な小片 ${stats.parts} 個 (${ms}ms)`)
    if (typeof window !== 'undefined') {
      window.__townDraws = out.length
      window.__townParts = stats.parts
    }
    return out
  }, [scene])

  return <group>{meshes.map((m) => <primitive key={m.name} object={m} />)}</group>
}

useGLTF.preload(TOWN.url)
