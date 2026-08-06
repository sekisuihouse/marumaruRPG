import React, { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { FINAL_PART_DEFS } from '../data/finalBoss.js'
import { sim } from '../engine/sim.js'

function PartMarker({ id }) {
  const ref = useRef()
  const def = FINAL_PART_DEFS[id]
  useFrame(() => {
    const boss = sim.finalBoss, part = boss?.parts?.[id], mesh = ref.current
    if (!mesh) return
    mesh.visible = !!boss?.alive && !!part && !part.broken && boss.state !== 'assembling' &&
      (part.role === 'shin' || !!sim.player.finalBossPlatform || part.role === 'arm') && (part.role !== 'core' || boss.phase >= 4)
    if (!mesh.visible) return
    mesh.position.copy(part.world)
    const pulse = 1 + Math.sin(sim.time * 5 + id.length) * 0.12
    mesh.scale.setScalar(pulse)
  })
  return <mesh ref={ref} renderOrder={3}>
    <sphereGeometry args={[Math.max(0.35, def.radius * 0.36), 14, 10]} />
    <meshStandardMaterial color={def.color || '#ffcf70'} emissive={def.color || '#ffcf70'} emissiveIntensity={1.5} transparent opacity={0.72} depthWrite={false} />
  </mesh>
}

function PartDamageVisual({ id }) {
  const wounded = useRef(), broken = useRef(), smoke = useRef()
  const def = FINAL_PART_DEFS[id]
  useFrame(() => {
    const part = sim.finalBoss?.parts?.[id]
    if (!part) return
    if (wounded.current) {
      wounded.current.visible = !!sim.finalBoss?.alive && part.state === 'wounded'
      wounded.current.position.copy(part.world)
      wounded.current.rotation.z = sim.time * 0.35
    }
    if (broken.current) {
      broken.current.visible = !!sim.finalBoss?.alive && part.broken
      broken.current.position.copy(part.world)
      broken.current.rotation.y = sim.time * 0.18
    }
    if (smoke.current) {
      smoke.current.position.y = Math.sin(sim.time * 1.8 + id.length) * 0.3
      smoke.current.rotation.y = sim.time * 0.4
    }
  })
  const size = Math.max(0.5, def.radius * 0.48)
  return <>
    <group ref={wounded} name={`final-wound-${id}`}>
      <mesh><sphereGeometry args={[size, 12, 8]} /><meshStandardMaterial color="#2b0707" emissive="#e13b22" emissiveIntensity={0.7} wireframe transparent opacity={0.82} /></mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]}><torusGeometry args={[size * 0.78, size * 0.12, 8, 18]} /><meshBasicMaterial color="#ff6b3d" /></mesh>
    </group>
    <group ref={broken} name={`final-break-${id}`}>
      {/* 外装分離に失敗しても、黒い焼損孔・断面リング・煙を恒久表示して欠損を読ませる。 */}
      <mesh><sphereGeometry args={[size * 0.92, 14, 10]} /><meshStandardMaterial color="#060708" roughness={1} /></mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]}><torusGeometry args={[size, size * 0.16, 8, 22]} /><meshStandardMaterial color={def.color || '#ff784d'} emissive={def.color || '#ff3d25'} emissiveIntensity={1.8} /></mesh>
      <group ref={smoke}>
        {[0, 1, 2].map((n) => <mesh key={n} position={[(n - 1) * size * 0.45, size * (1.1 + n * 0.25), 0]} scale={1 + n * 0.22}>
          <sphereGeometry args={[size * 0.28, 8, 6]} /><meshBasicMaterial color="#1b2024" transparent opacity={0.38 - n * 0.07} depthWrite={false} />
        </mesh>)}
      </group>
      {[-1, 0, 1].map((n) => <mesh key={`shard:${n}`} position={[n * size * 0.9, size * 0.35, (n % 2) * size * 0.6]} rotation={[n, n * 0.7, n * 0.3]}>
        <tetrahedronGeometry args={[size * 0.32]} /><meshStandardMaterial color="#191919" roughness={0.9} />
      </mesh>)}
    </group>
  </>
}

export function FinalBossEffects() {
  return <group>{Object.keys(FINAL_PART_DEFS).map((id) => <React.Fragment key={id}><PartMarker id={id} /><PartDamageVisual id={id} /></React.Fragment>)}</group>
}
