/**
 * 破片の描画。
 *  - 建物から剥がれた「大きな小片」は元のジオメトリ＋元のマテリアルで描く（最大32個）
 *  - 細かい破片は InstancedMesh 1つでまとめて描く（ドローコールを増やさない）
 * どちらも固定プールで、戦闘中に Object3D を作らない。
 */
import React, { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { sim } from '../engine/sim.js'
import { townVisual, debrisGeometry } from '../gfx/townVisual.js'
import { dustColor } from '../engine/debris.js'

const BIG_SLOTS = 32
const CHIP_SLOTS = 180

const dummy = new THREE.Object3D()
const tmpColor = new THREE.Color()

export function Debris() {
  const bigRefs = useRef([])
  const chips = useRef()
  const chipGeo = useMemo(() => new THREE.BoxGeometry(1, 1, 1), [])
  const chipMat = useMemo(() => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.05 }), [])

  useFrame(() => {
    const list = sim.debris || []
    let bigIndex = 0
    let chipIndex = 0
    const inst = chips.current

    for (const d of list) {
      if (!d.active) continue
      if (d.partId >= 0 && townVisual.ready && bigIndex < BIG_SLOTS) {
        const mesh = bigRefs.current[bigIndex]
        const part = townVisual.parts[d.partId]
        if (mesh && part) {
          const geo = debrisGeometry(part)
          if (mesh.geometry !== geo) mesh.geometry = geo
          const mat = townVisual.materials[part.bucket]
          if (mat && mesh.material !== mat) mesh.material = mat
          mesh.visible = true
          mesh.position.set(d.x, d.y, d.z)
          mesh.rotation.set(d.rx, d.ry, d.rz)
          const fade = Math.min(1, d.life / 1.2)
          mesh.scale.setScalar(fade < 1 ? Math.max(0.01, fade) : 1)
          bigIndex++
        }
        continue
      }
      if (inst && chipIndex < CHIP_SLOTS) {
        const s = Math.max(0.05, d.size) * Math.min(1, d.life / 0.8 + 0.15)
        dummy.position.set(d.x, d.y, d.z)
        dummy.rotation.set(d.rx, d.ry, d.rz)
        dummy.scale.set(s, s * 0.7, s)
        dummy.updateMatrix()
        inst.setMatrixAt(chipIndex, dummy.matrix)
        tmpColor.set(dustColor(d.materialType))
        inst.setColorAt(chipIndex, tmpColor)
        chipIndex++
      }
    }

    for (let i = bigIndex; i < BIG_SLOTS; i++) {
      const mesh = bigRefs.current[i]
      if (mesh) mesh.visible = false
    }
    if (inst) {
      inst.count = chipIndex
      inst.instanceMatrix.needsUpdate = true
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true
      inst.visible = chipIndex > 0
    }
  })

  return (
    <>
      {Array.from({ length: BIG_SLOTS }, (_, i) => (
        <mesh
          key={i}
          ref={(el) => { bigRefs.current[i] = el }}
          visible={false}
          castShadow
          frustumCulled={false}
        >
          <boxGeometry args={[0.1, 0.1, 0.1]} />
          <meshStandardMaterial color="#8b7355" />
        </mesh>
      ))}
      <instancedMesh
        ref={chips}
        args={[chipGeo, chipMat, CHIP_SLOTS]}
        frustumCulled={false}
        castShadow
      />
    </>
  )
}
