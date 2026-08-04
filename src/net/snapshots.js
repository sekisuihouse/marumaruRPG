import { sim } from '../engine/sim.js'
import { serializeBroken, applyBroken } from '../engine/destruct.js'
import { serializeBosses, applyBossSave } from '../engine/bosses.js'
import { multiplayer, notifyMultiplayer } from './multiplayerStore.js'
import { pushSample } from './interpolation.js'

const vec = (v) => [v.x, v.y, v.z]
let lastTownKey = ''
export function makeSnapshot(remote = []) {
  const p = sim.player
  return {
    type: 'snapshot', sequence: ++sim.net.sequence, hostTime: Math.round(performance.now()),
    players: [{ id: multiplayer.playerId, name: multiplayer.room?.members?.find((m) => m.id === multiplayer.playerId)?.name || 'ホスト', position: vec(p.pos), rotation: p.yaw, velocity: vec(p.vel), level: p.level, hp: p.hp, maxHp: p.maxHp, dead: p.dead, animationState: p.anim, score: p.kills } , ...remote],
    enemies: sim.enemies.filter((e) => e.alive).map((e) => ({ id: e.id, position: vec(e.pos), rotation: e.yaw, velocity: vec(e.vel), hp: e.hp, maxHp: e.maxHp, state: e.state, anim: e.anim, dead: e.state === 'dead' })),
    bosses: sim.bosses.filter((b) => b.spawned).map((b) => ({ id: b.id, typeId: b.typeId, position: vec(b.pos), rotation: b.yaw, hp: b.hp, maxHp: b.maxHp, state: b.state, phase: b.phase, alive: b.alive, attack: b.attack?.def?.id || null })),
    town: serializeBroken(), bossProgress: serializeBosses(), settings: multiplayer.settings,
  }
}
export function applySnapshot(s) {
  if (!s || s.sequence <= (sim.net.lastSnapshot || -1)) return false
  sim.net.lastSnapshot = s.sequence
  multiplayer.settings = s.settings || multiplayer.settings
  for (const p of s.players || []) {
    if (p.id === multiplayer.playerId) {
      // 自己操作は維持しつつ、ホスト位置へ滑らかに寄せる。
      sim.net.correction = p.position
      continue
    }
    let remote = multiplayer.remotePlayers.get(p.id)
    if (!remote) { remote = { id: p.id, label: p.name, pos: { x: p.position[0], y: p.position[1], z: p.position[2] }, yaw: p.rotation, alive: !p.dead, hitFlash: 0, scale: 1, samples: [] }; multiplayer.remotePlayers.set(p.id, remote) }
    remote.label = p.name; remote.alive = !p.dead; remote.level = p.level; remote.hp = p.hp; remote.maxHp = p.maxHp; remote.dead = p.dead
    pushSample(remote, { sequence: s.sequence, hostTime: s.hostTime, position: p.position, rotation: p.rotation, animationState: p.animationState })
  }
  for (const state of s.enemies || []) {
    const e = sim.enemies.find((x) => x.id === state.id); if (!e) continue
    e.alive = !state.dead; e.pos.fromArray(state.position); e.vel.fromArray(state.velocity || [0, 0, 0]); e.yaw = state.rotation; e.hp = state.hp; e.maxHp = state.maxHp; e.state = state.state; e.anim = state.anim
  }
  for (const state of s.bosses || []) {
    const b = sim.bosses.find((x) => x.id === state.id); if (!b) continue
    b.spawned = true; b.alive = state.alive; b.pos.fromArray(state.position); b.yaw = state.rotation; b.hp = state.hp; b.maxHp = state.maxHp; b.state = state.state; b.phase = state.phase
  }
  // 破壊済み部品はイベント主体で、スナップショットでは変化時だけ復元する。
  // 毎回resetTownを呼ぶと、補間中に建物がちらつくため避ける。
  if (s.town) {
    const townKey = JSON.stringify(s.town)
    if (townKey !== lastTownKey) { lastTownKey = townKey; applyBroken(s.town) }
  }
  if (s.bossProgress) applyBossSave(s.bossProgress)
  notifyMultiplayer(); return true
}
