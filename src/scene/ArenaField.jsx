/**
 * ボス戦の封鎖壁（ATフィールド）。
 *
 * 闘技場の境界セルへ縦板を立てて、ここから先へ行けないことを見た目でも伝える。
 * 板は InstancedMesh 1つでまとめて描くので、枚数が増えてもドローコールは増えない。
 * 展開・消滅は不透明度と高さのアニメーションで見せる。
 */
import React, { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { sim } from '../engine/sim.js'
import { ARENA } from '../engine/arena.js'

const MAX_PANELS = 1400
const dummy = new THREE.Object3D()
const tmpColor = new THREE.Color()

export function ArenaField() {
  const mesh = useRef()
  const grow = useRef(0)
  const built = useRef(0)

  const geometry = useMemo(() => new THREE.PlaneGeometry(1, 1), [])
  const material = useMemo(() => new THREE.MeshBasicMaterial({
    color: '#ffffff',
    transparent: true,
    opacity: 0.5,
    side: THREE.DoubleSide,
    depthWrite: false,
    // ACESトーンマッピングを通すと沈んで見えなくなるので、素の色のまま出す。
    // 加算合成は明るい空・草地の上でほとんど見えなかったため通常合成にする。
    toneMapped: false,
    // vertexColors は付けない。InstancedMesh の setColorAt は instanceColor を使うので、
    // ここで vertexColors:true にすると three がジオメトリの color 属性を要求し、
    // 属性が無いため全面が黒になる。
  }), [])

  useFrame((_, dt) => {
    const inst = mesh.current
    if (!inst) return
    const panels = sim.arena?.panels || []
    const active = !!sim.arena?.active && panels.length > 0

    // 展開・消滅のアニメーション（一気に出さず、せり上がるように見せる）
    const target = active ? 1 : 0
    grow.current += (target - grow.current) * Math.min(1, dt * (active ? 2.6 : 4))
    if (grow.current < 0.01 && !active) {
      inst.visible = false
      built.current = 0
      return
    }
    inst.visible = true

    const count = Math.min(MAX_PANELS, panels.length)
    const h = ARENA.wallHeight * grow.current
    const pulse = 0.75 + Math.sin(sim.time * 2.4) * 0.25
    const center = sim.arena?.center
    for (let i = 0; i < count; i++) {
      const p = panels[i]
      // 板は闘技場を囲む輪なので、必ず中心を向かせる（面の法線が内側）
      const yaw = center ? Math.atan2(center.x - p.x, center.z - p.z)
        : Math.atan2(panels[Math.min(count - 1, i + 1)].x - p.x, panels[Math.min(count - 1, i + 1)].z - p.z) + Math.PI / 2
      dummy.position.set(p.x, p.y + h * 0.5, p.z)
      dummy.rotation.set(0, yaw, 0)
      // 幅はセル1つ分より少し広くして隙間を作らない
      dummy.scale.set(p.size * 2.2, h, 1)
      dummy.updateMatrix()
      inst.setMatrixAt(i, dummy.matrix)
      // 波打つ明滅。近いほど濃く見えるよう、位置で位相をずらす
      const wave = 0.55 + Math.sin(sim.time * 3 + (p.x + p.z) * 0.35) * 0.45
      // 橙〜黄の明滅。境界だと一目で分かる強さにする
      tmpColor.setRGB(1, 0.42 + wave * 0.34, 0.12 + wave * 0.22)
      inst.setColorAt(i, tmpColor)
    }
    inst.count = count
    inst.instanceMatrix.needsUpdate = true
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true
    // 向こう側（ボスや町）が見える程度に透かす。境界だと分かる濃さは残す。
    material.opacity = grow.current * (0.24 + pulse * 0.13)
    built.current = count
  })

  return (
    <instancedMesh
      ref={mesh}
      args={[geometry, material, MAX_PANELS]}
      visible={false}
      frustumCulled={false}
      renderOrder={6}
    />
  )
}
