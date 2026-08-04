/**
 * 主人公・敵・村人の描画。sim の配列は固定長プールなので、
 * ここでのReactツリーは一度マウントしたら組み替わらない(GLBの再クローンが起きない)。
 */
import React, { useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { CharacterModel } from '../gfx/CharacterModel.jsx'
import { BossModel } from '../gfx/BossModel.jsx'
import { Nameplate } from '../gfx/Nameplate.jsx'
import { sim } from '../engine/sim.js'
import { multiplayer, subscribeMultiplayer, multiplayerSnapshot } from '../net/multiplayerStore.js'
import { interpolate } from '../net/interpolation.js'
import { netDebug } from '../net/debug.js'

/** 足元の丸影(接地感を出す軽量な代替) */
function Blob({ source, radius = 0.5, opacity = 0.32 }) {
  const ref = React.useRef()
  useFrame(() => {
    const st = source()
    const m = ref.current
    if (!m || !st) return
    const show = st.alive !== false && st.state !== 'dead'
    m.visible = show
    if (!show) return
    m.position.set(st.pos.x, st.pos.y + 0.03, st.pos.z)
  })
  return (
    <mesh ref={ref} rotation={[-Math.PI / 2, 0, 0]} renderOrder={1}>
      <circleGeometry args={[radius, 18]} />
      <meshBasicMaterial color="#0b241f" transparent opacity={opacity} depthWrite={false} />
    </mesh>
  )
}

export function PlayerActor() {
  const source = useMemo(() => () => sim.player, [])
  return (
    <>
      <Blob source={source} radius={0.55} />
      <CharacterModel
        model="Adventurer"
        source={source}
        gear={{ sword: true, shield: true }}
      />
    </>
  )
}

export function EnemyActors() {
  return (
    <>
      {sim.enemies.map((e, i) => (
        <EnemyActor key={e.id + i} index={i} />
      ))}
    </>
  )
}

export function BossActors() {
  return <>{(sim.bosses || []).map((b, i) => <BossActor key={b.id} index={i} />)}</>
}

/** 接続人数に応じて増減する参加者。join/leave時だけReactツリーを更新する。 */
export function RemotePlayers() {
  const snapshot = React.useSyncExternalStore(subscribeMultiplayer, multiplayerSnapshot, multiplayerSnapshot)
  return <>{snapshot.remotePlayers.map((p) => <RemotePlayer key={p.id} id={p.id} />)}</>
}
function RemotePlayer({ id }) {
  const source = useMemo(() => () => {
    const p = multiplayer.remotePlayers.get(id)
    if (!p) return null
    interpolate(p, performance.now() - multiplayer.interpolationDelay)
    p.pos.x = p.x ?? p.pos.x; p.pos.y = p.y ?? p.pos.y; p.pos.z = p.z ?? p.pos.z
    netDebug('GUEST RENDER APPLY', { playerId: p.id, position: [p.pos.x, p.pos.y, p.pos.z], animation: p.anim })
    return p
  }, [id])
  return <><Blob source={source} radius={0.55} /><CharacterModel model="Adventurer" source={source} /><Nameplate source={source} color="#7ee8ff" width={1.7} /></>
}

function BossActor({ index }) {
  const source = useMemo(() => () => sim.bosses?.[index], [index])
  const b = sim.bosses[index]
  const [visible, setVisible] = React.useState(() => !!b?.spawned)
  // ボスGLBは出現時だけロードする。開始直後に4モデルを待たせると、
  // 町全体がSuspense中のままになってしまうため、出現フラグの変化だけをReactへ渡す。
  useFrame(() => {
    const next = !!source()?.spawned
    if (next !== visible) setVisible(next)
  })
  if (!b || !visible) return null
  return <>
    <Blob source={source} radius={b.def.hitRadius * 1.45} opacity={0.42} />
    <BossModel source={source} />
    <Nameplate source={source} color={b.def.color} width={2.8} offsetY={3.2} />
  </>
}

function EnemyActor({ index }) {
  const enemy = sim.enemies[index]
  const source = useMemo(() => () => sim.enemies[index], [index])
  const light = React.useRef()

  // 元デザインの「敵ごとの色の灯り」を維持(数を絞って軽量化)
  useFrame(() => {
    const e = sim.enemies[index]
    const l = light.current
    if (!l) return
    const show = e.alive && e.state !== 'dead'
    l.visible = show
    if (show) l.position.set(e.pos.x, e.pos.y + 1.1, e.pos.z)
    l.intensity = e.enraged ? 3.2 : e.aware ? 1.6 : 0.7
  })

  return (
    <>
      <Blob source={source} radius={0.5 * enemy.scale} />
      <CharacterModel
        model={enemy.typeId}
        source={source}
        scale={enemy.scale}
        accent={enemy.def.look.color}
        gear={enemy.def.look.gear}
      />
      <Nameplate source={source} color={enemy.def.look.color} width={1.7} />
      <pointLight ref={light} color={enemy.def.look.color} intensity={1} distance={4.5} decay={2} />
    </>
  )
}

export function NpcActors() {
  return (
    <>
      {sim.npcs.map((npc, i) => (
        <NpcActor key={npc.id} index={i} />
      ))}
    </>
  )
}

function NpcActor({ index }) {
  const npc = sim.npcs[index]
  const source = useMemo(() => () => {
    const n = sim.npcs[index]
    return n ? { ...n, alive: true, hitFlash: 0, scale: 1 } : null
  }, [index])
  const plate = useMemo(() => () => {
    const n = sim.npcs[index]
    if (!n) return null
    const near = sim.nearestNpc?.id === n.id
    return {
      pos: n.pos, scale: 1, alive: true,
      label: near ? `${n.name}（Eキーで話す）` : `${n.name}・${n.role}`,
      hp: 1, maxHp: 1, aware: false, enraged: false,
    }
  }, [index])

  return (
    <>
      <Blob source={source} radius={0.5} opacity={0.24} />
      <CharacterModel model={npc.model} source={source} accent="#8ef0c0" />
      <NpcPlate source={plate} />
    </>
  )
}

/** 村人の名札はHPバーを出さない簡易版 */
function NpcPlate({ source }) {
  const ref = React.useRef()
  const { texture, ctx, canvas } = useMemo(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 320
    canvas.height = 40
    const ctx = canvas.getContext('2d')
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    return { texture, ctx, canvas }
  }, [])
  const last = React.useRef('')
  React.useEffect(() => () => texture.dispose(), [texture])

  useFrame(() => {
    const st = source()
    const sp = ref.current
    if (!sp || !st) return
    sp.position.set(st.pos.x, st.pos.y + 2.1, st.pos.z)
    if (st.label !== last.current) {
      last.current = st.label
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.font = 'bold 22px "Hiragino Kaku Gothic ProN", system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.lineWidth = 5
      ctx.strokeStyle = 'rgba(12,32,28,0.85)'
      ctx.strokeText(st.label, 160, 20)
      ctx.fillStyle = '#c9ffe8'
      ctx.fillText(st.label, 160, 20)
      texture.needsUpdate = true
    }
  })

  return (
    <sprite ref={ref} scale={[2.05, 0.256, 1]} renderOrder={5}>
      <spriteMaterial map={texture} transparent depthWrite={false} />
    </sprite>
  )
}
