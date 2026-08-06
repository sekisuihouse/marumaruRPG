import React, { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { useGLTF } from '@react-three/drei'
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js'
import * as THREE from 'three'
import { FINAL_BOSS, FINAL_CLIPS } from '../data/finalBoss.js'
import { sim } from '../engine/sim.js'
import { updateFinalBossTransforms } from '../engine/finalBoss.js'

const boneMatrices = {}
const worldPos = new THREE.Vector3(), worldQuat = new THREE.Quaternion(), worldScale = new THREE.Vector3(), unitScale = new THREE.Vector3(1, 1, 1)

export function FinalBossModel() {
  const host = useRef()
  const gltf = useGLTF(FINAL_BOSS.modelPath)
  const scene = useMemo(() => {
    const root = cloneSkeleton(gltf.scene)
    let baseHeight = 0, baseMinY = Infinity
    root.traverse((o) => {
      if (!o.isMesh) return
      if (!o.isSkinnedMesh || (o.geometry?.attributes?.position?.count || 0) < 1000) { o.visible = false; return }
      o.castShadow = true; o.receiveShadow = true
      o.material = o.material?.clone()
    })
    root.updateMatrixWorld(true)
    root.traverse((o) => {
      if (!o.isSkinnedMesh || !o.visible) return
      o.geometry.computeBoundingBox()
      const b = o.geometry.boundingBox, e = o.matrixWorld.elements
      const sy = Math.hypot(e[4], e[5], e[6])
      baseHeight = Math.max(baseHeight, (b.max.y - b.min.y) * sy)
      baseMinY = Math.min(baseMinY, e[13] + b.min.y * sy)
    })
    // FBXの補助リグ境界は主スキン実寸の約5.03倍。主メッシュを36mへ合わせる補正。
    const scale = FINAL_BOSS.displayHeight / Math.max(0.001, baseHeight) * FINAL_BOSS.sourceRigBoundsRatio
    root.scale.setScalar(scale)
    root.position.y = -baseMinY * scale
    return root
  }, [gltf.scene])
  const mixer = useMemo(() => new THREE.AnimationMixer(scene), [scene])
  const actions = useMemo(() => Object.fromEntries(gltf.animations.map((clip) => [clip.name, mixer.clipAction(clip)])), [gltf.animations, mixer])
  const current = useRef(null)

  useEffect(() => () => mixer.stopAllAction(), [mixer])
  useFrame((_, dt) => {
    const boss = sim.finalBoss
    const group = host.current
    if (!boss || !group) return
    group.visible = boss.spawned && (boss.alive || boss.state === 'defeated')
    if (!group.visible) return
    group.position.copy(boss.pos); group.rotation.y = boss.yaw
    const name = actions[boss.anim] ? boss.anim : 'idle'
    if (current.current !== name) {
      const old = actions[current.current], next = actions[name]
      old?.fadeOut(0.22)
      if (next) {
        const cfg = FINAL_CLIPS[name] || FINAL_CLIPS.idle
        next.reset().setLoop(cfg.loop ? THREE.LoopRepeat : THREE.LoopOnce, cfg.loop ? Infinity : 1)
        next.clampWhenFinished = !cfg.loop; next.timeScale = cfg.speed; next.fadeIn(0.22).play()
      }
      current.current = name
    }
    mixer.update(Math.min(dt, 1 / 20))
    group.updateMatrixWorld(true)
    for (const key in boneMatrices) delete boneMatrices[key]
    scene.traverse((o) => {
      if (!o.isBone) return
      o.matrixWorld.decompose(worldPos, worldQuat, worldScale)
      // 表示用の巨大化スケールは足場の座標へ持ち込まず、位置と回転だけを渡す。
      boneMatrices[o.name] = new THREE.Matrix4().compose(worldPos.clone(), worldQuat.clone(), unitScale)
    })
    boss.modelReady = Object.keys(boneMatrices).length > 0
    updateFinalBossTransforms(boneMatrices)
    scene.traverse((o) => {
      if (!o.isMesh || !o.material?.emissive) return
      o.material.emissive.set(boss.hitFlash > 0 ? '#7a2b15' : '#000000')
      o.material.emissiveIntensity = boss.hitFlash > 0 ? 0.8 : 0
    })
  })
  return <group ref={host}><primitive object={scene} /></group>
}
