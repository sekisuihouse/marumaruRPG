/**
 * キャラクター描画。scripts/build-characters.mjs が出力した GLB を読み、
 * animations.glb の共有クリップを AnimationMixer で再生する。
 *
 * ポイント:
 *  - 全部位が1本のスケルトンに統合済みなので、1体につき Mixer 1つで全身が動く
 *    (元実装は部位ごとに別アーマチュアで、最初の1部位しかアニメしていなかった)
 *  - source() が返す状態の anim が変わった瞬間にクロスフェードする
 *  - attack/hit/death/roll は1回再生(LoopOnce)、idle/walk/run はループ
 */
import React, { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { CHAR } from '../data/world.js'
import { shareSkeleton } from './shareSkeleton.js'
import { Gear } from './Gear.jsx'
import { ragdollFor, RAGDOLL_BONES, RAGDOLL_CHILD } from '../engine/ragdoll.js'

// ラグドール適用に使う一時オブジェクト（毎フレーム確保しない）
const tmpDir = new THREE.Vector3()
const tmpRest = new THREE.Vector3()
const tmpQuat = new THREE.Quaternion()
const parentQuat = new THREE.Quaternion()

/**
 * 物理ラグドールの質点にスキンメッシュのボーンを追従させる。
 * 部位は分離させず、関節の向きだけを差し替えて脱力した姿勢を作る。
 */
function applyRagdoll(group, bones, rd, scale) {
  const hips = rd.nodes[0]
  group.position.set(hips.x, hips.y - 0.95 * scale, hips.z)
  group.rotation.y = 0
  group.updateMatrixWorld(true)

  for (let i = 0; i < RAGDOLL_BONES.length; i++) {
    const childIndex = RAGDOLL_CHILD[i]
    if (childIndex < 0) continue
    const bone = bones[RAGDOLL_BONES[i][0]]
    const childBone = bones[RAGDOLL_BONES[childIndex][0]]
    if (!bone || !childBone || !bone.parent) continue
    const rest = childBone.userData.restPos
    if (!rest || rest.lengthSq() < 1e-8) continue

    const a = rd.nodes[i]
    const b = rd.nodes[childIndex]
    tmpDir.set(b.x - a.x, b.y - a.y, b.z - a.z)
    if (tmpDir.lengthSq() < 1e-8) continue
    tmpDir.normalize()

    bone.parent.getWorldQuaternion(parentQuat)
    tmpDir.applyQuaternion(parentQuat.invert())
    tmpRest.copy(rest).normalize()
    tmpQuat.setFromUnitVectors(tmpRest, tmpDir)
    bone.quaternion.copy(tmpQuat)
    bone.updateMatrixWorld(true)
  }
}

const ANIM_URL = `${CHAR.dir}/animations.glb`
const modelUrl = (name) => `${CHAR.dir}/${name}.glb`

/** 1回だけ再生するクリップ */
const ONCE = new Set(['attack', 'punch', 'kick', 'shoot', 'hit', 'death', 'roll', 'interact', 'wave'])
/** クリップごとの既定の再生速度 */
const CLIP_SPEED = { attack: 1.35, punch: 1.3, kick: 1.2, hit: 1.3, shoot: 1.5, roll: 1.25, cast: 1, death: 1 }

export function CharacterModel({
  model,
  source,
  scale = 1,
  accent = null,
  gear = null,
  castShadow = true,
  visible = true,
}) {
  const gltf = useGLTF(modelUrl(model))
  const animGltf = useGLTF(ANIM_URL)
  const group = useRef()

  // インスタンスごとに複製(スケルトンも正しく再バインドされる)
  const scene = useMemo(() => {
    const clone = cloneSkeleton(gltf.scene)
    // 全部位を1本のスケルトンに束ねる(ボーン行列計算を1回に)
    shareSkeleton(clone)
    clone.traverse((o) => {
      if (!o.isMesh) return
      o.castShadow = castShadow
      o.receiveShadow = false
      o.frustumCulled = false
      // マテリアルは個体別に複製(被弾フラッシュと役割カラーを個別に扱うため)
      o.material = Array.isArray(o.material) ? o.material.map((m) => m.clone()) : o.material.clone()
      const mats = Array.isArray(o.material) ? o.material : [o.material]
      for (const m of mats) {
        m.emissive = new THREE.Color(0x000000)
        if (accent) {
          // 役割カラーをわずかに乗せて敵種を見分けやすくする(元デザインの色を踏襲)
          m.emissive = new THREE.Color(accent)
          m.emissiveIntensity = 0.16
        }
      }
    })
    return clone
  }, [gltf.scene, accent, castShadow])

  // ラグドール用: ボーン参照と静止時のローカル位置（＝骨の長さと向き）を控える
  const bones = useMemo(() => {
    const map = {}
    scene.traverse((o) => {
      if (!o.isBone) return
      map[o.name] = o
      if (!o.userData.restPos) o.userData.restPos = o.position.clone()
    })
    return map
  }, [scene])

  const mixer = useMemo(() => new THREE.AnimationMixer(scene), [scene])
  const actions = useMemo(() => {
    const map = {}
    for (const clip of animGltf.animations) map[clip.name] = mixer.clipAction(clip)
    return map
  }, [animGltf.animations, mixer])

  const currentName = useRef(null)
  const currentAction = useRef(null)
  const flashMats = useMemo(() => {
    const list = []
    scene.traverse((o) => {
      if (!o.isMesh) return
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) list.push(m)
    })
    return list
  }, [scene])
  const baseEmissive = useMemo(() => flashMats.map((m) => m.emissive.clone()), [flashMats])
  const baseIntensity = useMemo(() => flashMats.map((m) => m.emissiveIntensity ?? 1), [flashMats])

  const play = (name, fade = 0.2) => {
    const next = actions[name] || actions.idle
    if (!next) return
    const prev = currentAction.current
    next.reset()
    if (ONCE.has(name)) {
      next.setLoop(THREE.LoopOnce, 1)
      next.clampWhenFinished = true
    } else {
      next.setLoop(THREE.LoopRepeat, Infinity)
      next.clampWhenFinished = false
    }
    next.enabled = true
    next.setEffectiveWeight(1)
    next.play()
    if (prev && prev !== next) next.crossFadeFrom(prev, fade, true)
    currentAction.current = next
    currentName.current = name
  }

  useEffect(() => {
    play('idle', 0)
    return () => mixer.stopAllAction()
  }, [actions]) // eslint-disable-line react-hooks/exhaustive-deps

  useFrame((_, dt) => {
    const st = source()
    if (!st) return
    const g = group.current
    if (!g) return

    // 位置・向き・スケール
    g.visible = visible && st.alive !== false
    if (!g.visible) return
    const s = scale * (st.scale ?? 1)
    if (g.scale.x !== s) g.scale.setScalar(s)

    // 倒された敵は通常アニメーションを止めて物理ラグドールへ切り替える
    const rd = st.id ? ragdollFor(st.id) : null
    if (rd) {
      applyRagdoll(g, bones, rd, s)
      return
    }

    g.position.set(st.pos.x, st.pos.y, st.pos.z)
    g.rotation.y = st.yaw ?? 0

    // アニメーション切り替え
    const want = st.anim || 'idle'
    if (want !== currentName.current) play(want, want === 'death' ? 0.12 : 0.18)
    const speed = (CLIP_SPEED[want] ?? 1) * (st.animSpeed ?? 1)
    mixer.update(dt * speed)

    // 被弾フラッシュ
    const flash = st.hitFlash || 0
    for (let i = 0; i < flashMats.length; i++) {
      const m = flashMats[i]
      if (flash > 0) {
        m.emissive.setRGB(1, 0.45, 0.4)
        m.emissiveIntensity = flash * 3
      } else if (m.emissiveIntensity !== baseIntensity[i]) {
        m.emissive.copy(baseEmissive[i])
        m.emissiveIntensity = baseIntensity[i]
      }
    }
  })

  return (
    <group ref={group} dispose={null}>
      <primitive object={scene} />
      {gear && <Gear scene={scene} source={source} {...gear} />}
    </group>
  )
}

export function preloadCharacters(models) {
  useGLTF.preload(ANIM_URL)
  for (const m of models) useGLTF.preload(modelUrl(m))
}
