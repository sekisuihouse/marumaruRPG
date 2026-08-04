/**
 * 装備品(剣・弓・杖・六角盾)。元実装と同じ Three.js プリミティブで作り、
 * 見た目のデザインを維持したまま「手のボーンに追従する」ようにした。
 *
 * ■スケール
 * GLBのルートは 0.01 倍だが、その下の CharacterArmature が FBX由来の 100 倍を
 * 持つため、手のボーンのワールドスケールは 1.0 になる。つまり寸法はそのまま
 * メートルで書けばよい（ここを100倍にすると盾が34mの壁になって画面を覆う）。
 * キャラごとのスケール倍率は親から自然に継承される。
 *
 * ■手のボーンのローカル軸（実測値。左右でミラーになっている）
 *   +Y … 前腕に沿って指先方向（腕を下ろした待機姿勢では真下）
 *   +Z … 体から外向き（左手なら左、右手なら右）
 *   +X … おおむね前後
 * この規約に合わせて、剣は +Y に伸ばし、盾は面の法線を +Z に向ける。
 */
import React, { useMemo, useRef } from 'react'
import { createPortal, useFrame } from '@react-three/fiber'
import * as THREE from 'three'

/** 円柱・箱の長軸(ローカルY)を +Z へ向ける回転 = 盾の面を体の外側へ */
const FACE_OUT = [Math.PI / 2, 0, 0]

function ShieldMesh() {
  return <>
    <mesh castShadow>
      <cylinderGeometry args={[0.26, 0.26, 0.05, 6]} />
      <meshStandardMaterial color="#30568d" metalness={0.45} roughness={0.45} />
    </mesh>
    <mesh position={[0, 0.035, 0]}>
      <cylinderGeometry args={[0.1, 0.1, 0.055, 6]} />
      <meshStandardMaterial color="#e8c46a" metalness={0.6} roughness={0.35} />
    </mesh>
  </>
}

/** 構え中は手盾を隠し、主人公の正面へ盾を滑らかに展開する。 */
function GuardShield({ source }) {
  const ref = useRef()
  const amount = useRef(0)
  const hidden = useRef(false)
  useFrame((_, dt) => {
    const group = ref.current
    if (!group) return
    const blocking = !!source?.()?.blocking
    amount.current = THREE.MathUtils.damp(amount.current, blocking ? 1 : 0, 14, dt)
    group.visible = amount.current > 0.02
    group.position.set(0, 1.12, 0.18 + amount.current * 0.72)
    group.rotation.set(Math.PI / 2, 0, 0)
    group.rotation.y = Math.sin(performance.now() * 0.004) * 0.025 * amount.current
    hidden.current = blocking
  })
  return <group ref={ref}><ShieldMesh /></group>
}

function HandShield({ source }) {
  const ref = useRef()
  useFrame(() => { if (ref.current) ref.current.visible = !source?.()?.blocking })
  return <group ref={ref} position={[0, 0.1, 0.07]} rotation={FACE_OUT}><ShieldMesh /></group>
}

export function Gear({ scene, source, sword = false, shield = false, bow = false, staff = false }) {
  const { right, left } = useMemo(() => ({
    right: scene.getObjectByName('WristR'),
    left: scene.getObjectByName('WristL'),
  }), [scene])

  const rightHand = (sword || bow || staff) && right ? createPortal(
    <group>
      {staff && (
        // 杖: 前腕の延長線上に握る。宝珠は上（-Y）側
        <group position={[0, 0.12, 0.02]}>
          <mesh castShadow>
            <cylinderGeometry args={[0.018, 0.023, 1.05, 8]} />
            <meshStandardMaterial color="#7e4d27" roughness={0.7} />
          </mesh>
          <mesh position={[0, -0.56, 0]}>
            <icosahedronGeometry args={[0.085, 0]} />
            <meshStandardMaterial color="#b7f0ff" emissive="#5ec7e8" emissiveIntensity={1.6} roughness={0.25} />
          </mesh>
        </group>
      )}
      {sword && (
        // 剣: 柄を手のひらに、刃を前腕の先（+Y）へ
        <group position={[0, 0.06, 0.015]}>
          <mesh castShadow position={[0, 0.36, 0]}>
            <boxGeometry args={[0.055, 0.62, 0.022]} />
            <meshStandardMaterial color="#dfe6f2" metalness={0.75} roughness={0.28} />
          </mesh>
          <mesh position={[0, 0.03, 0]}>
            <boxGeometry args={[0.17, 0.035, 0.045]} />
            <meshStandardMaterial color="#c8a35a" metalness={0.6} roughness={0.4} />
          </mesh>
          <mesh position={[0, -0.06, 0]}>
            <cylinderGeometry args={[0.022, 0.022, 0.15, 8]} />
            <meshStandardMaterial color="#5a3a22" roughness={0.8} />
          </mesh>
        </group>
      )}
      {bow && (
        // 弓: 弦の面を体の外側へ立てる（トーラスの軸は既定で +Z）
        <group position={[0, 0.07, 0.02]}>
          <mesh castShadow rotation={[0, 0, -0.5]}>
            <torusGeometry args={[0.28, 0.018, 6, 20, 3.4]} />
            <meshStandardMaterial color="#a86d3d" roughness={0.65} />
          </mesh>
          <mesh rotation={[0, 0, 0.05]}>
            <boxGeometry args={[0.006, 0.53, 0.006]} />
            <meshStandardMaterial color="#f3ead4" />
          </mesh>
        </group>
      )}
    </group>,
    right,
  ) : null

  const leftHand = shield && left ? createPortal(
    // 通常時は手に持ち、構え中だけ主人公の正面へ展開する。
    <HandShield source={source} />,
    left,
  ) : null

  return <>{rightHand}{leftHand}{shield && <GuardShield source={source} />}</>
}
