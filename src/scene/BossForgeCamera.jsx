/**
 * BOSS FORGE 編集モード専用のプレビューカメラ。
 *
 * 通常の ThirdPersonCamera はプレイヤー座標・NavMeshの遮蔽距離・建物衝突を使うため、
 * 編集画面ではボスが小さく写ったり、見えない壁でカメラが引き寄せられたりする。
 * ここではそれらを一切使わず、選択中ボスのバウンディングボックスだけを見て
 * 「全身が必ず画面に収まる」位置へ置く。
 *
 * 回転・ズームの入力は既存の input.js → step.js の updateCamera が
 * sim.camera.{yaw,pitch,dist} へ入れてくれるので、それをそのまま軌道パラメータとして使う。
 * （編集モードではポインターロックを使わないので、ドラッグとホイールだけが効く）
 */
import { useEffect } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { sim } from '../engine/sim.js'

const target = new THREE.Vector3()
const desired = new THREE.Vector3()

/** ボスの正面から見て、やや右斜め上の標準視点（ボスの向きに対する相対角） */
export const FORGE_DEFAULT_VIEW = { yawOffset: 0.55, pitch: 0.14 }

export const isForgePreview = () => Boolean(sim.bossForge && !sim.bossForge.combat)

const forgeBoss = () => (sim.bosses || []).find((b) => b.def.id === sim.bossForge?.bossId && b.alive)

/** 選択中ボスへカメラを合わせ直す（ボス切替・モデル読込後・リセット操作） */
export function frameForgeBoss(camera) {
  const forge = sim.bossForge
  const b = forgeBoss()
  if (!forge || !b) return false
  const bounds = b.forgeBounds
  const height = bounds ? bounds.size[1] : (b.forgeModelHeight || b.def.displayHeight || 3.5)
  const radius = bounds ? bounds.radius : height * 0.6
  // 注視点はモデルの中心よりわずかに下。画面下の操作パネルに足元が隠れないようにする。
  const centerY = (bounds ? bounds.center[1] : height * 0.5) - height * 0.1
  forge.view = { x: b.pos.x, y: b.pos.y + centerY, z: b.pos.z }

  // 縦横どちらでも収まる距離を求める。1.5倍の余白を持たせる。
  const fov = ((camera?.fov || 52) * Math.PI) / 180
  const aspect = camera?.aspect || 1.6
  const fitV = radius / Math.tan(fov / 2)
  const fitH = radius / Math.tan(Math.atan(Math.tan(fov / 2) * aspect))
  sim.camera.dist = Math.max(3, Math.min(80, Math.max(fitV, fitH) * 1.6))
  // ボスの向き(+Z が正面)を基準にした相対角。背中側に回り込まない。
  sim.camera.yaw = (b.yaw || 0) + FORGE_DEFAULT_VIEW.yawOffset
  sim.camera.pitch = FORGE_DEFAULT_VIEW.pitch
  forge.needsFrame = false
  forge.framedFor = `${b.def.id}:${bounds ? 'model' : 'guess'}`
  return true
}

export function BossForgeCamera() {
  const { camera } = useThree()

  // 「視点リセット」はUIからイベントで受ける（UIとカメラを直接結ばない）
  useEffect(() => {
    const onReset = () => { if (sim.bossForge) sim.bossForge.needsFrame = true }
    window.addEventListener('marugoto:forge-reset-view', onReset)
    return () => window.removeEventListener('marugoto:forge-reset-view', onReset)
  }, [])

  useFrame(() => {
    if (!isForgePreview()) return
    const forge = sim.bossForge
    const b = forgeBoss()
    if (!b) return

    // モデル読込完了・ボス切替で自動フレーミング
    if (forge.needsFrame || forge.framedFor !== `${b.def.id}:${b.forgeBounds ? 'model' : 'guess'}`) {
      frameForgeBoss(camera)
    }

    // 注視点はボスへ追従（攻撃で動いても画面外へ出さない）
    const bounds = b.forgeBounds
    const height = bounds ? bounds.size[1] : (b.forgeModelHeight || 3.5)
    const centerY = (bounds ? bounds.center[1] : height * 0.5) - height * 0.1
    target.set(b.pos.x, b.pos.y + centerY, b.pos.z)
    if (!forge.view) forge.view = { x: target.x, y: target.y, z: target.z }
    forge.view.x += (target.x - forge.view.x) * 0.18
    forge.view.y += (target.y - forge.view.y) * 0.18
    forge.view.z += (target.z - forge.view.z) * 0.18

    const c = sim.camera
    const cosP = Math.cos(c.pitch)
    desired.set(
      forge.view.x + Math.sin(c.yaw) * cosP * c.dist,
      forge.view.y + Math.sin(c.pitch) * c.dist,
      forge.view.z + Math.cos(c.yaw) * cosP * c.dist,
    )
    // NavMeshの遮蔽判定も地面のめり込み判定も使わない。編集台には何も無い。
    camera.position.copy(desired)
    camera.lookAt(forge.view.x, forge.view.y, forge.view.z)
    // 通常カメラと状態を共有しないよう、target も編集用の値で持っておく
    c.target.set(forge.view.x, forge.view.y, forge.view.z)
  }, -6)

  return null
}
