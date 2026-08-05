/**
 * 開発用の表示（公開版ではキー操作を提供しない。既定は無効）。
 *  - 破壊可能な小片のコライダー（プレイヤー周辺のみ）
 *  - 直近の命中位置
 *  - 小片の名前 / HP / 支持関係 / 物理状態 / 1フレームの破片数
 * 本番では sim.debugDraw が false のまま何も描かない。
 */
import React, { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { sim } from '../engine/sim.js'
import { queryParts, registry } from '../engine/destruct.js'

const MAX_BOXES = 120
const RANGE = 16

export function DebugOverlay() {
  const group = useRef()
  const boxes = useRef()
  const hitMark = useRef()
  const label = useRef()
  const dummy = useMemo(() => new THREE.Object3D(), [])
  const geo = useMemo(() => new THREE.BoxGeometry(1, 1, 1), [])
  const mat = useMemo(() => new THREE.MeshBasicMaterial({ color: '#54ffd0', wireframe: true, transparent: true, opacity: 0.55 }), [])
  const canvas = useMemo(() => {
    if (typeof document === 'undefined') return null
    const c = document.createElement('canvas')
    c.width = 512; c.height = 128
    return c
  }, [])
  const texture = useMemo(() => (canvas ? new THREE.CanvasTexture(canvas) : null), [canvas])
  const last = useRef('')

  useFrame(() => {
    const g = group.current
    if (!g) return
    g.visible = !!sim.debugDraw
    if (!g.visible) return

    const p = sim.player
    const inst = boxes.current
    let n = 0
    let nearest = null
    if (inst && registry.ready) {
      for (const part of queryParts(p.pos.x, p.pos.y + 1, p.pos.z, RANGE)) {
        if (n >= MAX_BOXES) break
        dummy.position.set(part.cx, part.cy, part.cz)
        dummy.rotation.set(0, 0, 0)
        dummy.scale.set(part.hx * 2, part.hy * 2, part.hz * 2)
        dummy.updateMatrix()
        inst.setMatrixAt(n, dummy.matrix)
        const d = Math.hypot(part.cx - p.pos.x, part.cz - p.pos.z)
        if (!nearest || d < nearest.d) nearest = { part, d }
        n++
      }
      inst.count = n
      inst.instanceMatrix.needsUpdate = true
    }

    // 直近の命中位置
    const hm = hitMark.current
    if (hm) {
      const h = sim.lastHitPoint
      hm.visible = !!h && sim.time - (h.at || 0) < 1.2
      if (hm.visible) hm.position.set(h.x, h.y, h.z)
    }

    // ラベル
    const sp = label.current
    if (sp && canvas && texture) {
      const part = nearest?.part
      const text = part
        ? `${part.objectPath} ${part.partType} HP${Math.max(0, Math.round(part.hp))}/${part.maxHp} 支持${part.supports.length}/${part.supportCount} ${part.broken ? 'broken' : 'static'}`
        : 'no part'
      const info = `parts ${registry.parts.length} broken ${sim.destructStats.broken} debris ${sim.debrisStats.active} +${sim.debrisStats.spawnedThisFrame}/f`
      const full = `${text}\n${info}`
      if (full !== last.current) {
        last.current = full
        const ctx = canvas.getContext('2d')
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        ctx.fillStyle = 'rgba(6,20,18,0.8)'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        ctx.font = 'bold 22px monospace'
        ctx.fillStyle = '#7dffd8'
        ctx.fillText(text.slice(0, 52), 8, 40)
        ctx.fillText(info, 8, 90)
        texture.needsUpdate = true
      }
      sp.position.set(p.pos.x, p.pos.y + 3.2, p.pos.z)
    }
  })

  return (
    <group ref={group} visible={false}>
      <instancedMesh ref={boxes} args={[geo, mat, MAX_BOXES]} frustumCulled={false} />
      <mesh ref={hitMark} visible={false}>
        <sphereGeometry args={[0.22, 8, 8]} />
        <meshBasicMaterial color="#ff4d6d" />
      </mesh>
      {texture && (
        <sprite ref={label} scale={[4, 1, 1]} renderOrder={20}>
          <spriteMaterial map={texture} transparent depthTest={false} />
        </sprite>
      )}
    </group>
  )
}
