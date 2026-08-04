import { sim, publishHud } from '../engine/sim.js'
import { CHANNEL, NET_RATE } from './protocol.js'
import { multiplayer, notifyMultiplayer, setMultiplayer } from './multiplayerStore.js'
import { configureNetwork, send } from './webrtc.js'
import { makeSnapshot, applySnapshot } from './snapshots.js'
import { validateInput, validateAttack } from './validation.js'
import { breakPart, onPartBroken, registry } from '../engine/destruct.js'
import { groundY, move, nearestWalkable } from '../engine/nav.js'
import { keys, moveAxis } from '../engine/input.js'
import { netDebug } from './debug.js'

const remoteInputs = new Map()
let lastFast = 0, lastSnapshot = 0, lastWorldSnapshot = 0, inputSequence = 0
export const isGuest = () => multiplayer.role === 'guest' && multiplayer.status === 'connected'
export const isHost = () => multiplayer.role === 'host' && multiplayer.status === 'connected'

// ホスト画面でも参加者を表示する。入力位置は検証済みのものだけを使う。
function updateHostRemoteAvatar(id, input) {
  let remote = multiplayer.remotePlayers.get(id)
  const isNew = !remote
  if (!remote) {
    const slot = multiplayer.remotePlayers.size + 1
    const spawn = nearestWalkable(sim.player.pos.x + slot * 1.2, sim.player.pos.z + slot * 1.2)
    remote = { id, label: multiplayer.peers.get(id)?.name || '参加者', pos: { x: spawn.x, y: groundY(spawn.x, spawn.z), z: spawn.z }, vel: { x: 0, y: 0, z: 0 }, yaw: input.rotation || 0, alive: true, hitFlash: 0, scale: 1, samples: [] }
    multiplayer.remotePlayers.set(id, remote)
  }
  remote.label = multiplayer.peers.get(id)?.name || remote.label
  remote.yaw = input.rotation || 0; remote.alive = true
  if (isNew) notifyMultiplayer()
}

function guestWorldMove() {
  const raw = moveAxis()
  const yaw = sim.camera.yaw
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = -fz, rz = fx
  let x = fx * raw.y + rx * raw.x, z = fz * raw.y + rz * raw.x
  const len = Math.hypot(x, z)
  if (len > 0.001) { x /= len; z /= len }
  return [x, z]
}

function applyRemoteInputs(dt) {
  const now = performance.now()
  for (const [id, input] of remoteInputs) {
    const remote = multiplayer.remotePlayers.get(id)
    if (!remote) continue
    const stale = now - input.receivedAt > NET_RATE.inputTimeoutMs
    const x = stale ? 0 : input.move.x
    const z = stale ? 0 : input.move.z
    const speed = input.running && !stale ? sim.player.runSpeed : sim.player.walkSpeed
    const res = move(remote.pos.x, remote.pos.z, x * speed * dt, z * speed * dt, sim.player.hitRadius)
    remote.pos.x = res.x; remote.pos.z = res.z; remote.pos.y = groundY(res.x, res.z, remote.pos.y)
    remote.vel.x = x * speed; remote.vel.y = 0; remote.vel.z = z * speed
    remote.moveSpeed = Math.hypot(x, z) * speed
    remote.yaw = input.rotation
    remote.anim = remote.moveSpeed > sim.player.walkSpeed + 0.5 ? 'run' : remote.moveSpeed > 0.1 ? 'walk' : 'idle'
    netDebug('HOST INPUT APPLY', { playerId: id, sequence: input.sequence, input: [x, z], position: [remote.pos.x, remote.pos.y, remote.pos.z], stale })
  }
}

export function initMultiplayerAuthority() {
  onPartBroken((part, impulse) => {
    if (!isHost()) return
    send(CHANNEL.reliable, {
      type: 'destroyPart', sequence: ++sim.net.sequence, sourceId: multiplayer.playerId,
      sourceType: 'host', objectPath: part.objectPath, partId: part.id,
      hitPoint: [part.cx, part.cy, part.cz], impulse, seed: sim.net.sequence,
    })
  })
  configureNetwork({
    onFast: (m) => {
      if (m.type === 'snapshot' && isGuest()) { applySnapshot(m); return }
      if (!isHost() || m.type !== 'input' || !m.playerId) return
      const old = remoteInputs.get(m.playerId)
      if (old && m.sequence <= old.sequence) return
      const inputState = validateInput(m)
      if (!inputState) return
      const input = { ...m, ...inputState, move: inputState, receivedAt: performance.now(), sequence: m.sequence }
      remoteInputs.set(m.playerId, input)
      updateHostRemoteAvatar(m.playerId, input)
      netDebug('HOST INPUT RECEIVE', { playerId: m.playerId, peerId: m.playerId, channel: CHANNEL.unreliable, sequence: m.sequence, move: [input.move.x, input.move.z], readyState: 'open' })
    },
    onPeerLeft: (id) => { remoteInputs.delete(id); netDebug('HOST PLAYER REMOVE', { playerId: id }) },
    onReliable: (m) => {
      if (m.type === 'snapshot' && isGuest()) applySnapshot(m)
      if (m.type === 'gameStart' && isGuest()) setMultiplayer({ gameStarted: true, settings: m.settings || multiplayer.settings })
      if (m.type === 'destroyPart' && isGuest()) {
        const part = registry.parts[m.partId]
        if (part && !part.broken) breakPart(part, m.impulse?.dirX || 0, m.impulse?.dirY || 0.4, m.impulse?.dirZ || 0, m.impulse?.impulseMul || 1)
      }
      if (m.type === 'attackRequest' && isHost()) {
        const remote = remoteInputs.get(m.playerId)
        if (!remote || !validateAttack(m, { dead: false, skills: ['melee', 'magic', 'area', 'arrow', 'heal', 'firestream', 'webswing'], lastAttackAt: remote.lastAttackAt || {} }, performance.now())) return
        remote.lastAttackAt ||= {}; remote.lastAttackAt[m.attackId] = performance.now()
        // 命中判定はホストのゲーム処理へ渡す余地を残し、まず全員へ確定イベントを送る。
        send(CHANNEL.reliable, { type: 'attackAccepted', ...m, hostTime: performance.now() })
      }
      if (m.type === 'attackAccepted' && isGuest()) sim.net.remoteAttack = m
    },
  })
}
export function tickMultiplayer(dt) {
  if (isGuest()) {
    const p = sim.player
    if (sim.net.correction) { p.pos.x += (sim.net.correction[0] - p.pos.x) * Math.min(1, dt * 8); p.pos.y += (sim.net.correction[1] - p.pos.y) * Math.min(1, dt * 8); p.pos.z += (sim.net.correction[2] - p.pos.z) * Math.min(1, dt * 8) }
    const hz = p.moveSpeed > 0.1 ? NET_RATE.movingHz : NET_RATE.idleHz
    if (performance.now() - lastFast > 1000 / hz) {
      lastFast = performance.now()
      const move = guestWorldMove()
      const message = { type: 'input', sequence: ++inputSequence, playerId: multiplayer.playerId, move, rotation: p.yaw, running: !!keys.shift, jump: false, attack: p.action?.def?.id || null }
      netDebug('GUEST INPUT CAPTURE', { playerId: multiplayer.playerId, sequence: message.sequence, move, position: [p.pos.x, p.pos.y, p.pos.z] })
      send(CHANNEL.unreliable, message)
    }
  }
  if (isHost()) applyRemoteInputs(dt)
  if (isHost() && performance.now() - lastSnapshot > 1000 / NET_RATE.snapshotHz) {
    lastSnapshot = performance.now()
    const remote = [...multiplayer.remotePlayers.values()].map((p) => ({ id: p.id, name: p.label, position: [p.pos.x, p.pos.y, p.pos.z], rotation: p.yaw, velocity: [p.vel.x, p.vel.y, p.vel.z], level: 1, hp: 100, maxHp: 100, dead: false, animationState: p.anim || 'idle', score: 0 }))
    const snapshot = makeSnapshot(remote)
    netDebug('HOST SNAPSHOT SEND', { sequence: snapshot.sequence, players: snapshot.players.map((p) => ({ id: p.id, position: p.position })) })
    // 座標スナップショットは落ちても次フレームで回復するため低遅延チャネルへ送る。
    send(CHANNEL.unreliable, snapshot)
    // 新規参加者にも、接続確立後まもなく破壊・ボス進行を復元させる。
    if (performance.now() - lastWorldSnapshot > 1000) {
      lastWorldSnapshot = performance.now()
      send(CHANNEL.reliable, makeSnapshot(remote, { includeWorld: true }))
    }
  }
  if (multiplayer.role !== 'offline') { sim.net.active = true; publishHud() }
  void dt
}
export function requestAttack(attackId, origin, direction) { if (!isGuest()) return false; send(CHANNEL.reliable, { type: 'attackRequest', sequence: ++inputSequence, playerId: multiplayer.playerId, attackId, origin, direction, clientTime: performance.now() }); return true }
