/**
 * 最終ボスの「ここを攻撃しろ」表示と、身体の損傷表現。
 *
 * 主要部位はリング・光柱・名札の3点セットで示す。大きさは data の固定値ではなく
 * 実際に描画されている巨人の全高から毎フレーム求めるので、モデルの拡大率を
 * 変えてもマーカーだけ豆粒になることがない。
 */
import React, { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { FINAL_BODY_DEFS, FINAL_PART_DEFS } from '../data/finalBoss.js'
import { sim } from '../engine/sim.js'

const LW = 256
const LH = 64
const mid = new THREE.Vector3()

/** いま倒すべき部位か。フェーズごとの目標と一致するものだけ強調する。 */
function isObjective(part, phase) {
  if (phase <= 1) return part.role === 'shin'
  if (phase === 2) return part.role === 'conduit'
  if (phase === 3) return part.role === 'crown' || part.role === 'conduit'
  if (phase === 4) return part.role === 'core'
  return false
}

/** そもそも狙える部位か（フェーズで解禁される）。 */
function isRevealed(part, boss) {
  if (!boss.alive || part.broken || boss.state === 'assembling') return false
  if (part.role === 'core') return boss.phase >= 4
  if (part.role === 'conduit' || part.role === 'crown') return boss.phase >= 2
  return true
}

function useLabelTexture() {
  return useMemo(() => {
    const canvas = document.createElement('canvas')
    canvas.width = LW
    canvas.height = LH
    const ctx = canvas.getContext('2d')
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    return { ctx, texture }
  }, [])
}

function drawLabel(ctx, texture, text, sub, color) {
  ctx.clearRect(0, 0, LW, LH)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineWidth = 6
  ctx.strokeStyle = 'rgba(10,16,26,0.9)'
  ctx.font = 'bold 27px "Hiragino Kaku Gothic ProN", system-ui, sans-serif'
  ctx.strokeText(text, LW / 2, 20)
  ctx.fillStyle = color
  ctx.fillText(text, LW / 2, 20)
  if (sub) {
    ctx.font = 'bold 21px "Hiragino Kaku Gothic ProN", system-ui, sans-serif'
    ctx.lineWidth = 5
    ctx.strokeStyle = 'rgba(10,16,26,0.9)'
    ctx.strokeText(sub, LW / 2, 47)
    ctx.fillStyle = '#ffffff'
    ctx.fillText(sub, LW / 2, 47)
  }
  texture.needsUpdate = true
}

/** 主要部位ひとつぶんの目印。 */
function PartBeacon({ id }) {
  const def = FINAL_PART_DEFS[id]
  const marker = useRef()
  const ring = useRef()
  const beam = useRef()
  const label = useRef()
  const { ctx, texture } = useLabelTexture()
  const key = useRef('')
  useEffect(() => () => texture.dispose(), [texture])

  useFrame(() => {
    const boss = sim.finalBoss
    const part = boss?.parts?.[id]
    const g = marker.current
    if (!g || !label.current) return
    const show = !!boss && isRevealed(part, boss)
    g.visible = show
    label.current.visible = show
    if (!show) return

    const objective = isObjective(part, boss.phase)
    g.position.copy(part.world)
    g.scale.setScalar(part.radius)
    const pulse = 1 + Math.sin(sim.time * (objective ? 4.4 : 2.2)) * (objective ? 0.16 : 0.07)
    if (ring.current) {
      ring.current.scale.setScalar(pulse)
      ring.current.material.opacity = objective ? 0.9 : 0.34
    }
    if (beam.current) {
      beam.current.visible = objective
      beam.current.material.opacity = 0.18 + Math.sin(sim.time * 3) * 0.06
    }

    // 名札はマーカーのスケールを継がせず、巨人の全高から読みやすい大きさを決める
    const width = THREE.MathUtils.clamp(boss.visualHeight * 0.11, 1.1, 9)
    label.current.position.set(part.world.x, part.world.y + part.radius * 2.4, part.world.z)
    label.current.scale.set(width, (width * LH) / LW, 1)
    const percent = Math.max(0, Math.ceil((part.hp / part.maxHp) * 100))
    const k = `${percent}|${objective ? 1 : 0}`
    if (k !== key.current) {
      key.current = k
      drawLabel(ctx, texture, `${objective ? '▼ ' : ''}${part.label} ${percent}%`, objective ? 'ここを攻撃！' : '', def.color || '#ffcf70')
    }
  })

  const color = def.color || '#ffcf70'
  return <>
    <group ref={marker} renderOrder={4}>
      {/* 攻撃位置のリング */}
      <mesh ref={ring} rotation={[-Math.PI / 2, 0, 0]}>
        <torusGeometry args={[1.25, 0.16, 8, 32]} />
        <meshBasicMaterial color={color} transparent opacity={0.85} depthWrite={false} depthTest={false} />
      </mesh>
      {/* 遠くからでも位置が分かる光柱 */}
      <mesh ref={beam} position={[0, 9, 0]}>
        <cylinderGeometry args={[0.55, 1.15, 18, 14, 1, true]} />
        <meshBasicMaterial color={color} transparent opacity={0.22} side={THREE.DoubleSide} depthWrite={false} depthTest={false} />
      </mesh>
      {/* 芯 */}
      <mesh>
        <sphereGeometry args={[0.62, 16, 12]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={1.8} transparent opacity={0.75} depthWrite={false} />
      </mesh>
    </group>
    <sprite ref={label} renderOrder={6}>
      <spriteMaterial map={texture} transparent depthWrite={false} depthTest={false} />
    </sprite>
  </>
}

/** 主要部位の傷／欠損。壊れたら二度と戻らないので恒久表示にする。 */
function PartDamage({ id }) {
  const wounded = useRef()
  const broken = useRef()
  const def = FINAL_PART_DEFS[id]
  useFrame(() => {
    const boss = sim.finalBoss
    const part = boss?.parts?.[id]
    if (!part) return
    const live = !!boss?.alive
    if (wounded.current) {
      wounded.current.visible = live && part.state === 'wounded'
      wounded.current.position.copy(part.world)
      wounded.current.scale.setScalar(part.radius)
      wounded.current.rotation.z = sim.time * 0.35
    }
    if (broken.current) {
      broken.current.visible = live && part.broken
      broken.current.position.copy(part.world)
      broken.current.scale.setScalar(part.radius)
      broken.current.rotation.y = sim.time * 0.18
    }
  })
  return <>
    <group ref={wounded}>
      <mesh><sphereGeometry args={[0.5, 12, 8]} /><meshStandardMaterial color="#2b0707" emissive="#e13b22" emissiveIntensity={0.7} wireframe transparent opacity={0.82} /></mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]}><torusGeometry args={[0.39, 0.06, 8, 18]} /><meshBasicMaterial color="#ff6b3d" /></mesh>
    </group>
    <group ref={broken}>
      {/* 焼損孔・断面リング・破片で「欠けた」ことを読ませる */}
      <mesh><sphereGeometry args={[0.46, 14, 10]} /><meshStandardMaterial color="#060708" roughness={1} /></mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]}><torusGeometry args={[0.5, 0.08, 8, 22]} /><meshStandardMaterial color={def.color || '#ff784d'} emissive={def.color || '#ff3d25'} emissiveIntensity={1.8} /></mesh>
      {[-1, 0, 1].map((n) => <mesh key={n} position={[n * 0.45, 0.18, (n % 2) * 0.3]} rotation={[n, n * 0.7, n * 0.3]}>
        <tetrahedronGeometry args={[0.16]} /><meshStandardMaterial color="#191919" roughness={0.9} />
      </mesh>)}
    </group>
  </>
}

/**
 * モデル読込前だけ使う、カプセル単位の破壊表示。
 * 小片が登録されたあとは身体メッシュ自体が欠けるので、この代用は出さない。
 */
function BodyBreak({ index }) {
  const hole = useRef()
  useFrame(() => {
    const seg = sim.finalBoss?.body?.[index]
    const g = hole.current
    if (!g) return
    const show = !!sim.finalBoss?.alive && !!seg?.broken && !sim.finalBoss.chunks.length
    g.visible = show
    if (!show) return
    mid.copy(seg.p0).lerp(seg.p1, 0.5)
    g.position.copy(mid)
    g.scale.setScalar(seg.radius)
    g.rotation.y = sim.time * 0.4
    // 再生が近いほど断面が明るく脈打つ。再生しない最終局面では脈打たない。
    const remain = seg.restoreAt - sim.time
    const near = Number.isFinite(remain) ? THREE.MathUtils.clamp(1 - remain / 5, 0, 1) : 0
    g.children[1].material.emissiveIntensity = 0.6 + near * 2.4
  })
  return <group ref={hole}>
    <mesh><sphereGeometry args={[1.02, 14, 10]} /><meshStandardMaterial color="#07080a" roughness={1} /></mesh>
    <mesh rotation={[Math.PI / 2, 0, 0]}><torusGeometry args={[1.05, 0.14, 8, 20]} /><meshStandardMaterial color="#ff9a5c" emissive="#ff5a22" emissiveIntensity={1.2} /></mesh>
  </group>
}

export function FinalBossEffects() {
  return <group>
    {Object.keys(FINAL_PART_DEFS).map((id) => <React.Fragment key={id}>
      <PartBeacon id={id} />
      <PartDamage id={id} />
    </React.Fragment>)}
    {FINAL_BODY_DEFS.map((def, index) => <BodyBreak key={def.id} index={index} />)}
  </group>
}
