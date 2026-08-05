/**
 * 三人称カメラ。プレイヤーの背後を追従し、
 * トラックパッド / マウス移動で旋回、2本指スクロール / ホイールで距離を変える。
 * 移動入力(step.js の cameraRelative)はこのカメラの yaw を基準にするので、
 * 「カメラの向きが前」になる。
 */
import React, { useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { sim } from '../engine/sim.js'
import { groundY, cameraDistance } from '../engine/nav.js'

const want = new THREE.Vector3()

export function ThirdPersonCamera() {
  const { camera } = useThree()
  const shake = useRef(0)
  const lastHp = useRef(null)
  const current = useRef(9)

  useFrame((_, dt) => {
    // BOSS FORGE の編集プレビューは専用カメラ(BossForgeCamera)が担当する。
    // プレイヤー座標・NavMeshの遮蔽距離・地面の下限を持ち込まない。
    if (sim.bossForge && !sim.bossForge.combat) return
    const p = sim.player
    const c = sim.camera

    // 注視点はプレイヤーの胸あたり。死亡時は少し引いて見下ろす
    const headY = p.pos.y + (p.dead ? 0.6 : 1.45)
    want.set(p.pos.x, headY, p.pos.z)
    const follow = 1 - Math.pow(0.0015, dt)
    c.target.lerp(want, follow)

    const wanted = p.dead ? c.dist * 1.25 : c.dist
    const cosP = Math.cos(c.pitch)
    // 注視点からカメラへ向かう単位ベクトル
    const dirX = Math.sin(c.yaw) * cosP
    const dirY = Math.sin(c.pitch)
    const dirZ = Math.cos(c.yaw) * cosP
    // 建物・地形にめり込む手前までしか離れない(ベイク済みの遮蔽高さを利用)
    const safe = cameraDistance(c.target.x, c.target.y, c.target.z, dirX, dirY, dirZ, wanted, 1.8)
    // 引き寄せは即座に、引き戻しはゆっくり(カクつき防止)
    current.current = safe < current.current ? safe : current.current + (safe - current.current) * Math.min(1, dt * 3)
    const dist = current.current

    let px = c.target.x + dirX * dist
    let pz = c.target.z + dirZ * dist
    let py = c.target.y + dirY * dist

    // 被弾時の軽い揺れ(reducedMotion では無効)
    if (lastHp.current !== null && p.hp < lastHp.current && !sim.settings.reducedMotion) shake.current = 0.28
    lastHp.current = p.hp
    if (shake.current > 0) {
      shake.current = Math.max(0, shake.current - dt)
      const s = shake.current * 0.5 * (sim.settings.shakeAmount ?? 1)
      px += (Math.random() - 0.5) * s
      py += (Math.random() - 0.5) * s
    }
    // 破壊のカメラシェイク（規模に応じて engine/juice.js が積む）
    const j = sim.juice?.shake || 0
    if (j > 0.001) {
      const s = Math.min(1.4, j) * 0.55
      px += (Math.random() - 0.5) * s
      py += (Math.random() - 0.5) * s
      pz += (Math.random() - 0.5) * s
    }

    // 地面や川床にカメラが潜らないよう下限を設ける。
    // ⚠️ 必ず揺れの後に掛ける。先に掛けると、ボス戦の破壊シェイク（最大±0.7m）が
    // そのまま下方向へ乗って、カメラが地面へ沈む。
    const floor = Math.max(groundY(px, pz, p.pos.y), p.pos.y - 2) + 0.7
    if (py < floor) py = floor

    camera.position.set(px, py, pz)
    camera.lookAt(c.target)
  }, -5)

  return null
}
