/**
 * ウェブスイングの糸と接続点の描画。
 * 糸は細い円柱を1本使い回し、接続点は光る小球で示す。
 */
import React, { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { sim } from '../engine/sim.js'
import { findAnchor } from '../engine/webswing.js'

const from = new THREE.Vector3()
const to = new THREE.Vector3()
const mid = new THREE.Vector3()
const dir = new THREE.Vector3()
const up = new THREE.Vector3(0, 1, 0)
const quat = new THREE.Quaternion()

export function WebLine() {
  const rope = useRef()
  const anchor = useRef()
  const anchorRing = useRef()
  const preview = useRef()
  const scan = useRef(0)
  const cached = useRef(null)

  useFrame((_, dt) => {
    const p = sim.player
    const w = p.web
    const r = rope.current
    const a = anchor.current
    const ar = anchorRing.current
    const pv = preview.current
    if (!r || !a || !ar || !pv) return

    // 接続中もジップ中（離して接続点へ飛んでいる最中）も糸を描く
    if (w?.attached || w?.zipping) {
      from.set(p.pos.x, p.pos.y + 1.35, p.pos.z)
      to.set(w.ax, w.ay, w.az)
      dir.subVectors(to, from)
      const len = dir.length() || 0.001
      mid.addVectors(from, to).multiplyScalar(0.5)
      r.visible = true
      r.position.copy(mid)
      quat.setFromUnitVectors(up, dir.normalize())
      r.quaternion.copy(quat)
      r.scale.set(1, len, 1)
      a.visible = true
      a.position.copy(to)
      ar.visible = true
      ar.position.copy(to)
      ar.rotation.z += dt * 3
      ar.scale.setScalar(0.9 + Math.sin(sim.time * 8) * 0.12)
      pv.visible = false
      return
    }

    r.visible = false
    a.visible = false
    ar.visible = false

    // 接続候補の表示。毎フレーム走査すると重いので 10Hz に間引く
    scan.current -= dt
    if (scan.current <= 0) {
      scan.current = 0.1
      cached.current = p.skills.includes('webswing') && !p.dead ? findAnchor() : null
    }
    const hit = cached.current
    if (hit) {
      pv.visible = true
      pv.position.set(hit.x, hit.y, hit.z)
      const s = 0.35 + Math.sin(sim.time * 6) * 0.06
      pv.scale.setScalar(s)
    } else pv.visible = false
  })

  return (
    <>
      <mesh ref={rope} visible={false} renderOrder={3}>
        <cylinderGeometry args={[0.035, 0.035, 1, 5, 1, true]} />
        <meshBasicMaterial color="#eaffff" transparent opacity={0.92} />
      </mesh>
      <mesh ref={anchor} visible={false} renderOrder={3}>
        <sphereGeometry args={[0.28, 10, 10]} />
        <meshBasicMaterial color="#bff2ff" transparent opacity={0.85} depthWrite={false} />
      </mesh>
      <mesh ref={anchorRing} visible={false} renderOrder={3}>
        <torusGeometry args={[0.52, 0.045, 6, 18]} />
        <meshBasicMaterial color="#ffffff" transparent opacity={0.92} depthWrite={false} />
      </mesh>
      <mesh ref={preview} visible={false} renderOrder={3}>
        <sphereGeometry args={[1, 10, 10]} />
        <meshBasicMaterial color="#9fe8ff" transparent opacity={0.4} depthWrite={false} />
      </mesh>
    </>
  )
}
