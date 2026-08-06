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
const aim = new THREE.Vector3()
/** カメラ位置の回り込み下限。ここより下は視線だけを上へ振る。 */
const ORBIT_MIN_PITCH = -0.38
/** 視線方向を作るための仮想注視点までの距離(向きだけ使うので大きめで良い) */
const AIM_REACH = 40

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
    // カメラ位置の回り込みは水平より少し下までに留める。これ以上下げると
    // 地面に潜って画角が寝るので、そこから先は「視線だけ」を上へ振る(下の aim)。
    const orbitPitch = Math.max(c.pitch, ORBIT_MIN_PITCH)
    const cosP = Math.cos(orbitPitch)
    // 注視点からカメラへ向かう単位ベクトル
    const dirX = Math.sin(c.yaw) * cosP
    const dirY = Math.sin(orbitPitch)
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
    // 見たい仰角は常に -pitch。通常域では注視点と一致し、真上付近を向いたときだけ
    // 注視点より上を見る。webswing の aimDirection() と同じ向きの定義。
    const viewPitch = -c.pitch
    const cosV = Math.cos(viewPitch)
    aim.set(px - Math.sin(c.yaw) * cosV * AIM_REACH, py + Math.sin(viewPitch) * AIM_REACH, pz - Math.cos(c.yaw) * cosV * AIM_REACH)
    camera.lookAt(aim)
  }, -5)

  return null
}
