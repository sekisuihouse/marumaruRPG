import React, { useRef } from 'react'
import { Html } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { sim } from '../engine/sim.js'

/** BOSS FORGEだけで描く、判定・弱点・注釈の軽量な3Dオーバーレイ。 */
export function BossForgeDebug() {
  const forge = sim.bossForge
  const boss = (sim.bosses || []).find((b) => b.def.id === forge?.bossId && b.alive)
  if (!forge || !boss) return null
  const attack = boss.attack?.def || boss.def.abilities.find((a) => a.id === forge.actionId)
  const radius = attack?.breakRadius || attack?.range || 2
  const addPointer = (targetType, event) => {
    event.stopPropagation()
    const p = event.point
    forge.annotations.push({
      id: `forge:${Date.now()}`, bossId: boss.def.id, actionId: attack?.id || '', phase: boss.phase,
      time: sim.time, targetType, targetName: targetType, hierarchyPath: '',
      worldPosition: [p.x, p.y, p.z], localPosition: [p.x - boss.pos.x, p.y - boss.pos.y, p.z - boss.pos.z],
      note: '', category: '動き', severity: '中程度',
    })
  }
  return <group>
    {forge.showHitboxes && <mesh position={[boss.pos.x, boss.pos.y + 0.7, boss.pos.z]} onPointerDown={(e) => addPointer('攻撃判定', e)}>
      <sphereGeometry args={[radius, 20, 12]} /><meshBasicMaterial color="#ff4d70" transparent opacity={0.16} wireframe />
    </mesh>}
    {forge.showWeakpoint && <mesh position={[boss.pos.x, boss.pos.y + 2.1, boss.pos.z]} onPointerDown={(e) => addPointer('弱点', e)}>
      <sphereGeometry args={[0.28, 14, 10]} /><meshBasicMaterial color="#fff36a" />
    </mesh>}
    {forge.showGround && <gridHelper args={[18, 18, '#6298ba', '#1c3b54']} position={[boss.pos.x, boss.pos.y + 0.02, boss.pos.z]} />}
    {forge.annotations.map((a, index) => <group key={a.id} position={a.worldPosition}>
      <mesh><sphereGeometry args={[0.15, 10, 8]} /><meshBasicMaterial color="#ffcf66" /></mesh>
      <Html center distanceFactor={10}><span className="forge-marker">{index + 1}</span></Html>
    </group>)}
  </group>
}

/**
 * 編集中だけ表示する検証台。
 *
 * カメラとボスの間に入る物は一切置かない（以前は背面の壁と左右の柱があり、
 * 視点を回すと必ずどれかがボスを隠していた）。床・グリッド・接地リングだけにする。
 * 床はボスの足元へ追従し、常にボスより下にしか無い。
 */
export function BossForgePreviewStage() {
  const ref = useRef()
  const floor = useRef()
  useFrame(() => {
    const forge = sim.bossForge
    const boss = (sim.bosses || []).find((b) => b.def.id === forge?.bossId && b.alive)
    const g = ref.current
    if (!g) return
    g.visible = Boolean(forge && !forge.combat && boss)
    if (!g.visible || !boss) return
    // 足元へ置く。モデルの底面が分かっていればそこへ合わせる。
    const footY = boss.forgeBounds ? boss.pos.y + boss.forgeBounds.min[1] : boss.pos.y
    g.position.set(boss.pos.x, footY, boss.pos.z)
    // 大きいボスでも床から出ないよう、床の広さをモデルに合わせる
    const radius = Math.max(9, (boss.forgeBounds?.radius || 3) * 3)
    if (floor.current) floor.current.scale.setScalar(radius / 9)
  })
  return <group ref={ref} name="BossForgePreviewStage" visible={false}>
    {/* 床。カメラとボスの間には決して入らない位置（常にボスの足元より下） */}
    <mesh ref={floor} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <circleGeometry args={[9, 64]} />
      <meshStandardMaterial color="#1b2836" roughness={0.9} metalness={0.04} />
    </mesh>
    <gridHelper args={[36, 36, '#7fb2c8', '#2b4c60']} position={[0, 0.02, 0]} />
    {/* 接地リング。足がどこに着いているか一目で分かる */}
    <mesh position={[0, 0.04, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      <ringGeometry args={[1.05, 1.16, 56]} />
      <meshBasicMaterial color="#ffcf66" transparent opacity={0.9} side={THREE.DoubleSide} toneMapped={false} />
    </mesh>
    {/* 尺度の目安（1m刻みの薄い輪）。遮蔽にならないよう床に貼る */}
    {[3, 6, 9].map((r) => (
      <mesh key={r} position={[0, 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[r, r + 0.04, 64]} />
        <meshBasicMaterial color="#5f93ad" transparent opacity={0.45} side={THREE.DoubleSide} toneMapped={false} />
      </mesh>
    ))}
  </group>
}

/**
 * 編集中だけ背景を無地へ差し替える。
 * 通常の空・霧のままだと町を隠してもモデルの輪郭が読みにくい。
 */
export function BossForgeBackdrop() {
  const { scene } = useThree()
  const saved = useRef(null)
  useFrame(() => {
    const preview = Boolean(sim.bossForge && !sim.bossForge.combat)
    if (preview) {
      if (!saved.current) saved.current = { background: scene.background, fog: scene.fog }
      scene.background = BACKDROP
      scene.fog = null
    } else if (saved.current) {
      scene.background = saved.current.background
      scene.fog = saved.current.fog
      saved.current = null
    }
  }, -9)
  return null
}

const BACKDROP = new THREE.Color('#0e1a24')
