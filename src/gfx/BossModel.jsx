/**
 * ボスのPMX由来モデル描画。
 *
 * ボスGLBは元PMXのskin/bind poseを保持する。配布物にはVMD/AnimationClipが
 * 無いため、各インスタンスで基準Quaternionから手続き姿勢を作る。これにより
 * T/Aポーズのまま移動することはなく、AI状態と攻撃の見た目も同期する。
 */
import React, { useEffect, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { sim } from '../engine/sim.js'

const loader = new GLTFLoader()
const cache = new Map()
const pending = new Map()
const AXIS_X = new THREE.Vector3(1, 0, 0)
const AXIS_Y = new THREE.Vector3(0, 1, 0)
const AXIS_Z = new THREE.Vector3(0, 0, 1)
const tmpQ = new THREE.Quaternion()
const tmpQ2 = new THREE.Quaternion()
const tmpColor = new THREE.Color()

const BONE_ALIASES = {
  hips: ['腰', 'センター', 'Hips', 'mixamorigHips', 'pelvis', 'root'],
  spine: ['上半身', 'Spine', 'mixamorigSpine'],
  chest: ['上半身2', 'Chest', 'mixamorigSpine1'],
  head: ['頭', 'Head', 'mixamorigHead'],
  leftArm: ['左腕', 'LeftArm', 'upperarm_l', 'mixamorigLeftArm'],
  rightArm: ['右腕', 'RightArm', 'upperarm_r', 'mixamorigRightArm'],
  leftForeArm: ['左ひじ', 'LeftForeArm', 'lowerarm_l', 'mixamorigLeftForeArm'],
  rightForeArm: ['右ひじ', 'RightForeArm', 'lowerarm_r', 'mixamorigRightForeArm'],
  leftLeg: ['左足', 'LeftUpLeg', 'thigh_l', 'mixamorigLeftUpLeg'],
  rightLeg: ['右足', 'RightUpLeg', 'thigh_r', 'mixamorigRightUpLeg'],
  leftKnee: ['左ひざ', 'LeftLeg', 'calf_l', 'mixamorigLeftLeg'],
  rightKnee: ['右ひざ', 'RightLeg', 'calf_r', 'mixamorigRightLeg'],
}

// モデルごとの初期姿勢。全モデルは同じMMD骨格だが、重さの印象だけ変える。
const POSE = {
  student: { shoulderDown: 0.7, elbowBend: 0.26, kneeBend: 0.12, torsoLean: 0.09, legSpread: 0.04 },
  stage: { shoulderDown: 0.63, elbowBend: 0.2, kneeBend: 0.1, torsoLean: 0.04, legSpread: 0.03 },
  shrine: { shoulderDown: 0.58, elbowBend: 0.3, kneeBend: 0.16, torsoLean: 0.12, legSpread: 0.05 },
  food: { shoulderDown: 0.68, elbowBend: 0.28, kneeBend: 0.14, torsoLean: 0.08, legSpread: 0.05 },
}

function loadBossModel(url) {
  if (cache.has(url)) return Promise.resolve(cache.get(url))
  if (pending.has(url)) return pending.get(url)
  const p = new Promise((resolve, reject) => loader.load(url, (gltf) => {
    cache.set(url, gltf); pending.delete(url); resolve(gltf)
  }, undefined, (err) => { pending.delete(url); reject(err) }))
  pending.set(url, p)
  return p
}

function boneFor(all, aliases) {
  for (const name of aliases) {
    const exact = all.find((b) => b.name === name)
    if (exact) return exact
  }
  const lower = aliases.map((x) => x.toLowerCase())
  return all.find((b) => lower.some((x) => b.name.toLowerCase().includes(x))) || null
}

function qAxis(axis, angle) { return new THREE.Quaternion().setFromAxisAngle(axis, angle) }

function setupRig(scene, typeId) {
  const all = []
  scene.traverse((o) => { if (o.isBone) all.push(o) })
  if (!all.length) return null
  const map = {}
  for (const [key, aliases] of Object.entries(BONE_ALIASES)) map[key] = boneFor(all, aliases)
  const rest = new Map(all.map((b) => [b, { q: b.quaternion.clone(), p: b.position.clone() }]))
  const target = new Map(all.map((b) => [b, { q: b.quaternion.clone(), p: b.position.clone() }]))
  return { all, map, rest, target, pose: POSE[typeId] || POSE.student }
}

function resetTargets(rig) {
  for (const b of rig.all) {
    const r = rig.rest.get(b), t = rig.target.get(b)
    t.q.copy(r.q); t.p.copy(r.p)
  }
}

function addRot(rig, key, axis, angle) {
  const b = rig.map[key]
  if (!b || !angle) return
  rig.target.get(b).q.multiply(qAxis(axis, angle))
}

function addPos(rig, key, x, y, z) {
  const b = rig.map[key]
  if (b) rig.target.get(b).p.add({ x, y, z })
}

function applyProcedural(rig, st, dt) {
  resetTargets(rig)
  const p = rig.pose
  const t = sim.time
  const moving = st.anim === 'run' || st.state === 'approach' || st.state === 'reposition'
  const running = moving && st.def.id === 'student'
  const cycle = t * (running ? 10 : moving ? 6.4 : 2.2)
  const step = moving ? Math.sin(cycle) * (running ? 0.76 : 0.48) : 0
  const breathe = Math.sin(cycle) * 0.025

  // 基本姿勢: 肩を下ろし、肘/膝を曲げ、Tポーズを必ず崩す。
  addRot(rig, 'leftArm', AXIS_Z, -p.shoulderDown)
  addRot(rig, 'rightArm', AXIS_Z, p.shoulderDown)
  addRot(rig, 'leftForeArm', AXIS_Z, -p.elbowBend)
  addRot(rig, 'rightForeArm', AXIS_Z, p.elbowBend)
  addRot(rig, 'spine', AXIS_X, p.torsoLean + breathe)
  addRot(rig, 'leftKnee', AXIS_X, p.kneeBend)
  addRot(rig, 'rightKnee', AXIS_X, p.kneeBend)
  addRot(rig, 'leftLeg', AXIS_Z, -p.legSpread)
  addRot(rig, 'rightLeg', AXIS_Z, p.legSpread)
  addPos(rig, 'hips', 0, moving ? Math.abs(Math.sin(cycle)) * 0.008 : Math.sin(cycle) * 0.004, 0)

  if (moving) {
    addRot(rig, 'leftLeg', AXIS_X, step)
    addRot(rig, 'rightLeg', AXIS_X, -step)
    addRot(rig, 'leftArm', AXIS_X, -step * 0.65)
    addRot(rig, 'rightArm', AXIS_X, step * 0.65)
    addRot(rig, 'chest', AXIS_X, running ? 0.19 : 0.09)
  } else {
    addRot(rig, 'head', AXIS_Y, Math.sin(t * 0.75) * 0.09)
    addRot(rig, 'leftArm', AXIS_X, Math.sin(t * 1.7) * 0.045)
    addRot(rig, 'rightArm', AXIS_X, -Math.sin(t * 1.7) * 0.045)
  }

  const attack = st.attack?.def?.id
  const windup = st.attack?.phase === 'windup'
  const progress = windup ? Math.min(1, 1 - (st.attack.timer || 0) / Math.max(0.1, st.attack.def.windup || 0.7)) : 1
  if (st.state === 'entrance') {
    addRot(rig, 'chest', AXIS_X, -0.18 + Math.min(1, st.stateTime) * 0.32)
    addRot(rig, 'leftArm', AXIS_Y, -0.25); addRot(rig, 'rightArm', AXIS_Y, 0.25)
  } else if (st.state === 'stagger') {
    addRot(rig, 'chest', AXIS_X, -0.5); addRot(rig, 'head', AXIS_X, 0.24)
    addRot(rig, 'leftKnee', AXIS_X, 0.3); addRot(rig, 'rightKnee', AXIS_X, 0.3)
  } else if (st.phase === 2 && st.stateTime < 1.2) {
    addRot(rig, 'chest', AXIS_X, -0.34); addRot(rig, 'leftArm', AXIS_Y, -0.38); addRot(rig, 'rightArm', AXIS_Y, 0.38)
  } else if (attack) {
    // 攻撃別に異なる重心と腕の軌道。エフェクトだけの静止攻撃にしない。
    const swing = Math.sin(Math.min(1, progress) * Math.PI)
    if (st.def.id === 'student') {
      if (attack === 'mimic') { addRot(rig, 'chest', AXIS_Y, -0.55 + progress * 1.1); addRot(rig, 'rightArm', AXIS_X, -1.1 * swing); addRot(rig, 'rightForeArm', AXIS_X, -0.55 * swing) }
      else if (attack === 'spring' || attack === 'runaway') { addRot(rig, 'leftLeg', AXIS_X, 0.5 * (1 - progress)); addRot(rig, 'rightLeg', AXIS_X, 0.5 * (1 - progress)); addRot(rig, 'chest', AXIS_X, 0.34 * (1 - progress)) }
      else { addRot(rig, 'leftArm', AXIS_X, -0.55 * swing); addRot(rig, 'rightArm', AXIS_X, -0.55 * swing) }
    } else if (st.def.id === 'stage') {
      if (attack === 'speaker' || attack === 'beat') { addRot(rig, 'chest', AXIS_X, -0.22); addRot(rig, 'rightArm', AXIS_X, -0.9 * progress) }
      else if (attack === 'spotlight' || attack === 'encore') { addRot(rig, 'leftArm', AXIS_Y, -0.75 * swing); addRot(rig, 'rightArm', AXIS_Y, 0.75 * swing); addRot(rig, 'chest', AXIS_X, -0.18) }
    } else if (st.def.id === 'shrine') {
      if (attack === 'quake') { addRot(rig, 'leftArm', AXIS_X, -1.05 * (1 - progress)); addRot(rig, 'rightArm', AXIS_X, -1.05 * (1 - progress)); addRot(rig, 'chest', AXIS_X, 0.32 * progress) }
      else if (attack === 'sweep' || attack === 'gate') { addRot(rig, 'chest', AXIS_Y, -0.65 + progress * 1.3); addRot(rig, 'rightArm', AXIS_X, -0.8 * swing) }
      else { addRot(rig, 'leftArm', AXIS_Y, -0.35); addRot(rig, 'rightArm', AXIS_Y, 0.35) }
    } else {
      if (attack === 'flame') { addRot(rig, 'chest', AXIS_X, -0.32 * progress); addRot(rig, 'rightArm', AXIS_X, -0.85 * progress) }
      else if (attack === 'oil' || attack === 'cook') { addRot(rig, 'leftArm', AXIS_X, Math.sin(t * 10) * 0.35); addRot(rig, 'rightArm', AXIS_X, -Math.sin(t * 10) * 0.35); addRot(rig, 'chest', AXIS_X, 0.16) }
      else { addRot(rig, 'chest', AXIS_Y, -0.45 + progress * 0.9); addRot(rig, 'rightArm', AXIS_X, -1.0 * swing) }
    }
  }
  if (st.hitFlash > 0) addRot(rig, 'chest', AXIS_X, -st.hitFlash * 0.65)

  const ease = 1 - Math.exp(-13 * dt)
  for (const b of rig.all) {
    const target = rig.target.get(b)
    b.quaternion.slerp(target.q, ease)
    b.position.lerp(target.p, ease)
  }
}

/** 出現したボスだけをロードし、個体ごとに骨格と材質を複製する。 */
export function BossModel({ source }) {
  const host = useRef()
  const model = useRef(null)
  const mats = useRef([])
  const rig = useRef(null)
  const loading = useRef(false)

  const load = (st) => {
    if (loading.current || model.current) return
    loading.current = true
    loadBossModel(st.def.modelPath).then((gltf) => {
      loading.current = false
      if (!host.current) return
      const mesh = cloneSkeleton(gltf.scene)
      const materials = []
      mesh.traverse((node) => {
        if (!node.isMesh) return
        node.castShadow = true; node.receiveShadow = true; node.frustumCulled = false
        node.material = Array.isArray(node.material) ? node.material.map((m) => m.clone()) : node.material.clone()
        for (const m of Array.isArray(node.material) ? node.material : [node.material]) { m.emissive = new THREE.Color(0); m.emissiveIntensity = 0; materials.push(m) }
      })
      mesh.scale.setScalar(st.def.displayHeight || 3.5)
      mesh.userData.bossModelPath = st.def.modelPath
      host.current.add(mesh); model.current = mesh; mats.current = materials
      rig.current = setupRig(mesh, st.def.id)
      // 読み込み直後の1フレームもTポーズを見せない。
      if (rig.current) applyProcedural(rig.current, st, 1 / 60)
      if (import.meta.env.DEV) (window.__bossModelLoads ||= []).push({ path: st.def.modelPath, bones: rig.current?.all.length || 0, clips: gltf.animations.length })
    }).catch((err) => {
      loading.current = false
      if (import.meta.env.DEV) (window.__bossModelErrors ||= []).push({ path: st.def.modelPath, message: String(err?.message || err) })
      console.error(`ボスモデルを読み込めませんでした: ${st.def.modelPath}`, err)
    })
  }

  useEffect(() => () => {
    const mesh = model.current
    if (mesh) mesh.parent?.remove(mesh)
    for (const m of mats.current) m.dispose?.()
    mats.current = []; model.current = null; rig.current = null
  }, [])

  useFrame((_, dt) => {
    const st = source(), group = host.current
    if (!st || !group) return
    group.visible = st.alive
    if (!st.alive) return
    load(st)
    group.position.set(st.pos.x, st.pos.y, st.pos.z); group.rotation.set(0, st.yaw, 0)
    const mesh = model.current
    if (!mesh) return
    if (st.state === 'dead') { mesh.rotation.x = Math.min(1.4, (st.ragdollTime || 0) * 1.4); return }
    mesh.rotation.set(0, 0, 0)
    if (rig.current) applyProcedural(rig.current, st, dt)
    else mesh.position.y = Math.sin(sim.time * 2) * 0.02 // 読み込み失敗時でも完全静止にしない

    const flash = st.hitFlash || 0
    const telegraph = sim.time < (st.telegraphUntil || 0)
    for (const m of mats.current) {
      if (flash > 0) { tmpColor.setRGB(1, 0.4, 0.35); m.emissive.copy(tmpColor); m.emissiveIntensity = flash * 2.6 }
      else if (telegraph) { tmpColor.set(st.telegraphColor || st.def.color); m.emissive.copy(tmpColor); m.emissiveIntensity = 0.42 + Math.abs(Math.sin(sim.time * 12)) * 0.5 }
      else if (m.emissiveIntensity !== 0) { m.emissive.setRGB(0, 0, 0); m.emissiveIntensity = 0 }
    }
  })
  return <group ref={host} />
}

export const preloadBoss = (url) => loadBossModel(url).catch(() => {})
