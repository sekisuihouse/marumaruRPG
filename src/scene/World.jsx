/**
 * 3Dシーンの組み立て。
 * SimDriver を priority -10 で登録し、他の useFrame より必ず先に
 * 1フレーム分のシミュレーションを進める。
 */
import React, { useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Sky, Sparkles } from '@react-three/drei'
import * as THREE from 'three'
import { Town } from '../gfx/Town.jsx'
import { PlayerActor, EnemyActors, NpcActors, BossActors, RemotePlayers } from './Actors.jsx'
import { Projectiles, DebugPropProjectiles, GroundEffects, DamageNumbers } from './Effects.jsx'
import { Debris } from './Debris.jsx'
import { WebLine } from './WebLine.jsx'
import { DebugOverlay } from './DebugOverlay.jsx'
import { ArenaField } from './ArenaField.jsx'
import { FinalBossEffects } from './FinalBossEffects.jsx'
import { BossForgeCamera } from './BossForgeCamera.jsx'
import { ThirdPersonCamera } from './ThirdPersonCamera.jsx'
import { BossForgeDebug, BossForgePreviewStage, BossForgeBackdrop } from './BossForgeDebug.jsx'
import { sim, isNight } from '../engine/sim.js'
import { stepSim } from '../engine/step.js'

function SimDriver() {
  const { scene, gl, camera } = useThree()
  // デバッグ用: DevTools から __three.gl.info.render で描画統計を見られる
  if (typeof window !== 'undefined') window.__three = { scene, gl, camera }
  useFrame((_, dt) => {
    const forge = sim.bossForge
    const scale = forge?.timeScale ?? 1
    if (scale > 0) stepSim(dt * scale)
    else if (forge?.stepOnce) { stepSim(1 / 60); forge.stepOnce = false }
    if (typeof window !== 'undefined') window.__frames = (window.__frames || 0) + 1
  }, -10)
  return null
}

function ForgeGameplayLayer({ children }) {
  const ref = useRef()
  useFrame(() => {
    if (ref.current) ref.current.visible = !sim.bossForge || sim.bossForge.combat
  })
  return <group ref={ref}>{children}</group>
}

const sunDir = new THREE.Vector3()
const DAY_FOG = new THREE.Color('#cfeff8')
const NIGHT_FOG = new THREE.Color('#0d1c33')
const fogColor = new THREE.Color()

/** 時間帯で太陽・空・霧を動かす(bunbetu 13 の昼夜条件に連動) */
function DayNight() {
  const sky = useRef()
  const sun = useRef()
  const ambient = useRef()
  const { scene } = useThree()

  useFrame(() => {
    // dayTime 0.25=朝, 0.5=正午, 0.75=夕
    const a = (sim.dayTime - 0.25) * Math.PI * 2
    const elevation = Math.sin(a)
    sunDir.set(Math.cos(a) * 0.8, Math.max(-0.35, elevation), 0.35).normalize()

    if (sky.current) sky.current.material.uniforms.sunPosition.value.copy(sunDir)

    const day = THREE.MathUtils.clamp(elevation * 1.6 + 0.35, 0, 1)
    if (sun.current) {
      const p = sim.player.pos
      // 影のカメラをプレイヤー周辺に追従させる
      sun.current.position.set(p.x + sunDir.x * 40, p.y + Math.max(12, sunDir.y * 45), p.z + sunDir.z * 40)
      sun.current.target.position.set(p.x, p.y, p.z)
      sun.current.target.updateMatrixWorld()
      sun.current.intensity = 0.35 + day * 2.3
      sun.current.color.setHSL(0.11, 0.35 * (1 - day) + 0.05, 0.5 + day * 0.45)
    }
    if (ambient.current) ambient.current.intensity = 0.5 + day * 1.5

    fogColor.copy(NIGHT_FOG).lerp(DAY_FOG, day)
    if (scene.fog) scene.fog.color.copy(fogColor)
    scene.background = fogColor
  })

  return (
    <>
      <Sky ref={sky} distance={4000} turbidity={7} rayleigh={1.4} mieCoefficient={0.006} mieDirectionalG={0.85} />
      <fog attach="fog" args={['#cfeff8', 70, 260]} />
      <ambientLight ref={ambient} intensity={1.4} />
      <directionalLight
        ref={sun}
        castShadow
        intensity={2.2}
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0008}
        shadow-normalBias={0.03}
        shadow-camera-left={-34}
        shadow-camera-right={34}
        shadow-camera-top={34}
        shadow-camera-bottom={-34}
        shadow-camera-near={1}
        shadow-camera-far={140}
      />
      <hemisphereLight args={['#cbe9ff', '#4c7a49', 0.55]} />
    </>
  )
}

/** 夜だけ星を出す */
function NightSparkles() {
  const ref = useRef()
  useFrame(() => {
    if (ref.current) ref.current.visible = isNight() && !sim.settings.reducedMotion
  })
  return (
    <group ref={ref}>
      <Sparkles count={90} scale={[110, 40, 110]} position={[0, 24, 0]} size={5} speed={0.15} color="#fffbe6" />
    </group>
  )
}

export function World() {
  return (
    <>
      <SimDriver />
      <DayNight />
      <ForgeGameplayLayer>
        <NightSparkles />
        <Town />
        <PlayerActor />
        <RemotePlayers />
        <EnemyActors />
        <NpcActors />
        <Projectiles />
        {sim.debugMode && <DebugPropProjectiles />}
        <Debris />
        <WebLine />
        <ArenaField />
        <FinalBossEffects />
        <GroundEffects />
        <DamageNumbers />
        <DebugOverlay />
      </ForgeGameplayLayer>
      <BossActors />
      <BossForgePreviewStage />
      <BossForgeBackdrop />
      <BossForgeDebug />
      <ThirdPersonCamera />
      <BossForgeCamera />
    </>
  )
}
