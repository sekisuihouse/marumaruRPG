import { sim, publishHud } from '../engine/sim.js'
import { CHANNEL, NET_RATE } from './protocol.js'
import { multiplayer, notifyMultiplayer, setMultiplayer } from './multiplayerStore.js'
import { configureNetwork, send } from './webrtc.js'
import { makeSnapshot, applySnapshot } from './snapshots.js'
import { validateMove, validateAttack } from './validation.js'
import { breakPart, onPartBroken, registry } from '../engine/destruct.js'

const remoteInputs = new Map()
let lastFast = 0, lastSnapshot = 0, inputSequence = 0
export const isGuest = () => multiplayer.role === 'guest' && multiplayer.status === 'connected'
export const isHost = () => multiplayer.role === 'host' && multiplayer.status === 'connected'

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
      if (!isHost() || m.type !== 'input' || !m.playerId) return
      const old = remoteInputs.get(m.playerId); const position = validateMove(old?.position, m.position, (performance.now() - (old?.receivedAt || performance.now())) / 1000)
      if (!position) return
      remoteInputs.set(m.playerId, { ...m, position, receivedAt: performance.now(), sequence: m.sequence })
    },
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
    if (performance.now() - lastFast > 1000 / hz) { lastFast = performance.now(); send(CHANNEL.unreliable, { type: 'input', sequence: ++inputSequence, playerId: multiplayer.playerId, position: [p.pos.x, p.pos.y, p.pos.z], rotation: p.yaw, velocity: [p.vel.x, p.vel.y, p.vel.z], animationState: p.anim }) }
  }
  if (isHost() && performance.now() - lastSnapshot > 1000 / NET_RATE.snapshotHz) {
    lastSnapshot = performance.now()
    const remote = [...remoteInputs.entries()].map(([id, p]) => ({ id, name: multiplayer.peers.get(id)?.name || '参加者', position: p.position, rotation: p.rotation || 0, velocity: p.velocity || [0, 0, 0], level: 1, hp: 100, maxHp: 100, dead: false, animationState: p.animationState || 'idle', score: 0 }))
    send(CHANNEL.reliable, makeSnapshot(remote))
  }
  if (multiplayer.role !== 'offline') { sim.net.active = true; publishHud() }
  void dt
}
export function requestAttack(attackId, origin, direction) { if (!isGuest()) return false; send(CHANNEL.reliable, { type: 'attackRequest', sequence: ++inputSequence, playerId: multiplayer.playerId, attackId, origin, direction, clientTime: performance.now() }); return true }
