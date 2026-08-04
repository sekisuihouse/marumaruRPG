/**
 * 弾・範囲エフェクト・罠・ダメージ数値の描画。
 * すべて固定長プールを使い回すので、戦闘中に新しい Object3D を作らない。
 */
import React, { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { sim } from '../engine/sim.js'

const PROJECTILES = 20
const RINGS = 10
const TRAPS = 5
const BURSTS = 22
const SLASHES = 6
const FLOATERS = 14
const FLOATER_WIDTH = 0.85   // ダメージ数値のワールド幅の基準(m)

const tmpColor = new THREE.Color()

/** 魔法弾・矢 */
export function Projectiles() {
  const refs = useRef([])
  useFrame(() => {
    for (let i = 0; i < PROJECTILES; i++) {
      const g = refs.current[i]
      if (!g) continue
      const pr = sim.projectiles[i]
      if (!pr) { g.visible = false; continue }
      g.visible = true
      g.position.set(pr.x, pr.y, pr.z)
      g.rotation.y = Math.atan2(pr.dx, pr.dz)
      const isArrow = pr.kind === 'arrow'
      g.scale.setScalar(isArrow ? 1 : 1.15)
      const mesh = g.children[isArrow ? 0 : 1]
      g.children[0].visible = isArrow
      g.children[1].visible = !isArrow
      if (mesh) {
        tmpColor.set(pr.color)
        mesh.material.color.copy(tmpColor)
        mesh.material.emissive.copy(tmpColor)
      }
    }
  })
  return (
    <>
      {Array.from({ length: PROJECTILES }, (_, i) => (
        <group key={i} ref={(el) => { refs.current[i] = el }} visible={false}>
          {/* 矢 */}
          <mesh rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.035, 0.035, 0.8, 6]} />
            <meshStandardMaterial color="#ffd267" emissive="#ffd267" emissiveIntensity={1.2} />
          </mesh>
          {/* 魔法弾 */}
          <mesh>
            <sphereGeometry args={[0.22, 12, 12]} />
            <meshStandardMaterial color="#ffe14c" emissive="#ffe14c" emissiveIntensity={2.2} transparent opacity={0.95} />
          </mesh>
        </group>
      ))}
    </>
  )
}

/** 範囲攻撃の予告円・着弾・回復の輪 */
export function GroundEffects() {
  const rings = useRef([])
  const traps = useRef([])
  const bursts = useRef([])
  const slashes = useRef([])

  useFrame(() => {
    const ringLike = sim.effects.filter((f) => f.kind === 'telegraph' || f.kind === 'aoe' || f.kind === 'ring' || f.kind === 'bossHazard')
    for (let i = 0; i < RINGS; i++) {
      const m = rings.current[i]
      if (!m) continue
      const f = ringLike[i]
      if (!f) { m.visible = false; continue }
      m.visible = true
      m.position.set(f.x, f.y + 0.02, f.z)
      const t = 1 - f.life / f.max
      const r = f.kind === 'telegraph' ? f.radius : f.radius * (0.35 + t * 0.75)
      m.scale.set(r, r, 1)
      m.material.color.set(f.color)
      m.material.opacity = f.kind === 'telegraph'
        ? 0.25 + Math.abs(Math.sin(t * Math.PI * 4)) * 0.4
        : f.kind === 'bossHazard' ? 0.18 + Math.abs(Math.sin(sim.time * 5)) * 0.22
        : Math.max(0, 0.75 * (1 - t))
    }

    const trapList = sim.effects.filter((f) => f.kind === 'trap')
    for (let i = 0; i < TRAPS; i++) {
      const m = traps.current[i]
      if (!m) continue
      const f = trapList[i]
      if (!f) { m.visible = false; continue }
      m.visible = true
      m.position.set(f.x, f.y, f.z)
      m.scale.set(f.radius, f.radius, 1)
      m.material.opacity = 0.45 + Math.sin(sim.time * 6) * 0.2
    }

    // 粉じん(dust)・火花(spark)・発射炎(muzzle)も同じ球プールで描く
    const burstList = sim.effects.filter((f) => (
      f.kind === 'burst' || f.kind === 'impact' || f.kind === 'dust' || f.kind === 'spark' || f.kind === 'muzzle'
    ))
    for (let i = 0; i < BURSTS; i++) {
      const m = bursts.current[i]
      if (!m) continue
      const f = burstList[i]
      if (!f) { m.visible = false; continue }
      m.visible = true
      const t = 1 - f.life / f.max
      // 粉じんはゆっくり上へ広がる
      const rise = f.kind === 'dust' ? t * 1.2 : 0
      m.position.set(f.x, f.y + rise, f.z)
      // 広がりすぎると画面を覆う半透明の球になるので、拡大とα両方を抑える
      const grow = f.kind === 'dust' ? 0.3 + t * 1.5 : 0.35 + t * 0.7
      m.scale.setScalar(Math.max(0.01, f.radius * grow))
      m.material.color.set(f.color)
      const peak = f.kind === 'dust' ? 0.42 : f.kind === 'spark' ? 0.9 : 0.5
      m.material.opacity = Math.max(0, peak * (1 - t) * (1 - t))
    }

    // 斬撃は弧を描く板で表現する(球だと大きな泡に見えてしまう)
    const slashList = sim.effects.filter((f) => f.kind === 'slash')
    for (let i = 0; i < SLASHES; i++) {
      const m = slashes.current[i]
      if (!m) continue
      const f = slashList[i]
      if (!f) { m.visible = false; continue }
      m.visible = true
      m.position.set(f.x, f.y, f.z)
      const t = 1 - f.life / f.max
      m.rotation.set(-Math.PI / 2 + 0.5, (f.yaw ?? 0) + t * 0.7 - 0.35, 0)
      m.scale.setScalar(f.radius * (0.85 + t * 0.5))
      m.material.color.set(f.color)
      m.material.opacity = Math.max(0, 0.9 * (1 - t))
    }
  })

  return (
    <>
      {Array.from({ length: RINGS }, (_, i) => (
        <mesh key={`r${i}`} ref={(el) => { rings.current[i] = el }} rotation={[-Math.PI / 2, 0, 0]} visible={false} renderOrder={2}>
          <ringGeometry args={[0.82, 1, 32]} />
          <meshBasicMaterial transparent opacity={0.5} side={THREE.DoubleSide} depthWrite={false} />
        </mesh>
      ))}
      {Array.from({ length: TRAPS }, (_, i) => (
        <mesh key={`t${i}`} ref={(el) => { traps.current[i] = el }} rotation={[-Math.PI / 2, 0, 0]} visible={false} renderOrder={2}>
          <ringGeometry args={[0.55, 1, 6]} />
          <meshBasicMaterial color="#e27d35" transparent opacity={0.5} side={THREE.DoubleSide} depthWrite={false} />
        </mesh>
      ))}
      {Array.from({ length: BURSTS }, (_, i) => (
        <mesh key={`b${i}`} ref={(el) => { bursts.current[i] = el }} visible={false} renderOrder={3}>
          <sphereGeometry args={[1, 10, 10]} />
          <meshBasicMaterial transparent opacity={0.8} depthWrite={false} />
        </mesh>
      ))}
      {Array.from({ length: SLASHES }, (_, i) => (
        <mesh key={`s${i}`} ref={(el) => { slashes.current[i] = el }} visible={false} renderOrder={4}>
          <torusGeometry args={[0.85, 0.07, 4, 14, 2.2]} />
          <meshBasicMaterial transparent opacity={0.9} side={THREE.DoubleSide} depthWrite={false} />
        </mesh>
      ))}
    </>
  )
}

/** ダメージ数値。Canvas を焼いた Sprite プール。 */
export function DamageNumbers() {
  const slots = useMemo(() => Array.from({ length: FLOATERS }, () => {
    const canvas = document.createElement('canvas')
    canvas.width = 256
    canvas.height = 64
    const ctx = canvas.getContext('2d')
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    return { canvas, ctx, texture, id: null }
  }), [])
  const refs = useRef([])

  React.useEffect(() => () => slots.forEach((s) => s.texture.dispose()), [slots])

  useFrame(() => {
    for (let i = 0; i < FLOATERS; i++) {
      const sp = refs.current[i]
      const slot = slots[i]
      if (!sp) continue
      const f = sim.floaters[i]
      if (!f) { sp.visible = false; slot.id = null; continue }
      sp.visible = true
      sp.position.set(f.x, f.y, f.z)
      const t = 1 - f.life / f.max
      sp.material.opacity = Math.max(0, 1 - t * t)
      // キャンバスが 256x64 なので 4:1 を保つ。近距離でも画面を覆わない大きさにする
      const s = (0.9 + f.size * 0.5) * (1 + t * 0.3) * FLOATER_WIDTH
      sp.scale.set(s, s / 4, 1)
      if (slot.id !== f.id) {
        slot.id = f.id
        const { ctx, canvas, texture } = slot
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        ctx.font = `bold ${Math.round(34 * f.size)}px "Hiragino Kaku Gothic ProN", system-ui, sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.lineWidth = 7
        ctx.strokeStyle = 'rgba(10,26,24,0.9)'
        ctx.strokeText(f.text, 128, 32)
        ctx.fillStyle = f.color
        ctx.fillText(f.text, 128, 32)
        texture.needsUpdate = true
      }
    }
  })

  return (
    <>
      {slots.map((slot, i) => (
        <sprite key={i} ref={(el) => { refs.current[i] = el }} visible={false} renderOrder={8}>
          <spriteMaterial map={slot.texture} transparent depthWrite={false} depthTest={false} />
        </sprite>
      ))}
    </>
  )
}
