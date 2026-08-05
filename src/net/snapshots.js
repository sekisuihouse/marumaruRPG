import { sim } from '../engine/sim.js'
import { serializeBroken, applyBroken } from '../engine/destruct.js'
import { serializeBosses, applyBossSave } from '../engine/bosses.js'
import { multiplayer, notifyMultiplayer } from './multiplayerStore.js'
import { pushSample, resetSamples } from './interpolation.js'
import { netDebug } from './debug.js'
import { netStats, recordSequence, recordSnapshotAge, recordSnapshotBuild, resetSequenceStats } from './diagnostics.js'
import { hostTimeAge, resetClock } from './clock.js'

const vec = (v) => [v.x, v.y, v.z]
/**
 * 受信値の有限性検査。NaN/Infinity をそのまま Object3D へ入れると
 * そのメッシュが消えたまま戻らないため、必ずここで弾く。
 */
const finite3 = (a) => (Array.isArray(a) && a.length === 3 && a.every((n) => Number.isFinite(n)) ? a : null)
const finite = (n, fallback = 0) => (Number.isFinite(n) ? n : fallback)

let lastTownKey = ''

export function resetSnapshotState() {
  sim.net.lastSnapshot = -1
  sim.net.correction = null
  sim.net.epoch = 0
  lastTownKey = ''
  resetSequenceStats()
  resetClock()
}

/**
 * 通常の位置同期は小さく保ち、途中参加や定期的な整合性確認だけで
 * 建物・ボス進行を含める。破壊イベント自体はReliableで即時配信される。
 */
export function makeSnapshot(remote = [], { includeWorld = false } = {}) {
  const started = performance.now()
  // セッションごとに epoch を振り直す。再接続で sequence が 0 に戻っても
  // 参加者が「古いパケット」と誤判定して全更新を捨てないようにするため。
  if (!sim.net.epoch) { sim.net.epoch = Date.now() % 1e9; sim.net.sequence = 0 }
  const p = sim.player
  const snapshot = {
    type: 'snapshot',
    // 再接続で sequence が 0 に戻るため、epoch と組で新旧を判定する
    epoch: sim.net.epoch,
    sequence: ++sim.net.sequence,
    hostTime: Math.round(performance.now()),
    players: [{
      id: multiplayer.playerId,
      name: multiplayer.room?.members?.find((m) => m.id === multiplayer.playerId)?.name || 'ホスト',
      position: vec(p.pos), rotation: p.yaw, velocity: vec(p.vel),
      level: p.level, hp: p.hp, maxHp: p.maxHp, dead: p.dead, animationState: p.anim, score: p.kills,
    }, ...remote],
    enemies: sim.enemies.filter((e) => e.alive).map((e) => ({
      id: e.id, position: vec(e.pos), rotation: e.yaw, velocity: vec(e.vel),
      hp: e.hp, maxHp: e.maxHp, state: e.state, anim: e.anim, dead: e.state === 'dead',
    })),
    bosses: sim.bosses.filter((b) => b.spawned).map((b) => ({
      id: b.id, typeId: b.typeId, position: vec(b.pos), rotation: b.yaw,
      hp: b.hp, maxHp: b.maxHp, state: b.state, phase: b.phase, alive: b.alive, attack: b.attack?.def?.id || null,
    })),
    settings: multiplayer.settings,
  }
  if (includeWorld) { snapshot.town = serializeBroken(); snapshot.bossProgress = serializeBosses() }
  // 大きすぎるスナップショットは重要イベントの待ち時間を悪化させる。まず測っておく。
  recordSnapshotBuild(performance.now() - started, JSON.stringify(snapshot).length)
  return snapshot
}

export function applySnapshot(s) {
  if (!s) return false
  // ── 再接続やホスト交代で番号が戻る。epoch が変わったら受信状態を作り直す。
  if (s.epoch !== undefined && s.epoch !== sim.net.epoch) {
    sim.net.epoch = s.epoch
    sim.net.lastSnapshot = -1
    sim.net.correction = null
    lastTownKey = ''
    resetSequenceStats()
    for (const remote of multiplayer.remotePlayers.values()) resetSamples(remote)
  }
  // Unordered チャネルでは古い到着が普通に起きる。権威状態は最新だけを採る。
  recordSequence('snapshot', s.epoch ?? 0, s.sequence)
  if (s.sequence <= (sim.net.lastSnapshot ?? -1)) return false
  sim.net.lastSnapshot = s.sequence
  multiplayer.settings = s.settings || multiplayer.settings

  const receivedAt = performance.now()
  // 端末間で時計の起点が違うので、推定オフセットを通してから鮮度を測る
  const age = hostTimeAge(s.hostTime, receivedAt)
  if (age !== null) recordSnapshotAge(Math.max(0, age))
  netDebug('GUEST SNAPSHOT RECEIVE', { sequence: s.sequence, players: (s.players || []).map((p) => ({ id: p.id, position: p.position })) })

  for (const p of s.players || []) {
    const position = finite3(p.position)
    if (!position) continue
    if (p.id === multiplayer.playerId) {
      // 自己操作は維持しつつ、ホスト位置へ寄せる（補正の強さは hostAuthority 側で決める）
      sim.net.correction = position
      continue
    }
    let remote = multiplayer.remotePlayers.get(p.id)
    if (!remote) {
      remote = {
        id: p.id, label: p.name,
        pos: { x: position[0], y: position[1], z: position[2] },
        yaw: finite(p.rotation), alive: !p.dead, hitFlash: 0, scale: 1, samples: [],
      }
      multiplayer.remotePlayers.set(p.id, remote)
      netDebug('GUEST PLAYER LOOKUP', { playerId: p.id, found: false })
    }
    remote.label = p.name
    remote.alive = !p.dead
    remote.level = p.level
    remote.hp = p.hp
    remote.maxHp = p.maxHp
    remote.dead = p.dead
    pushSample(remote, {
      sequence: s.sequence, hostTime: s.hostTime, receivedAt,
      position, rotation: finite(p.rotation),
      velocity: finite3(p.velocity) || [0, 0, 0],
      animationState: p.animationState,
    })
  }
  let depth = 0
  for (const r of multiplayer.remotePlayers.values()) depth = Math.max(depth, r.samples?.length || 0)
  netStats.bufferDepth = depth

  for (const state of s.enemies || []) {
    const e = sim.enemies.find((x) => x.id === state.id)
    const position = finite3(state.position)
    if (!e || !position) continue
    e.alive = !state.dead
    e.pos.fromArray(position)
    e.vel.fromArray(finite3(state.velocity) || [0, 0, 0])
    e.yaw = finite(state.rotation)
    e.hp = finite(state.hp, e.hp)
    e.maxHp = finite(state.maxHp, e.maxHp)
    e.state = state.state
    e.anim = state.anim
  }
  for (const state of s.bosses || []) {
    const b = sim.bosses.find((x) => x.id === state.id)
    const position = finite3(state.position)
    if (!b || !position) continue
    b.spawned = true
    b.alive = state.alive
    b.pos.fromArray(position)
    b.yaw = finite(state.rotation)
    b.hp = finite(state.hp, b.hp)
    b.maxHp = finite(state.maxHp, b.maxHp)
    b.state = state.state
    b.phase = state.phase
  }
  // 破壊済み部品はイベント主体で、スナップショットでは変化時だけ復元する。
  // 毎回resetTownを呼ぶと、補間中に建物がちらつくため避ける。
  if (s.town) {
    const townKey = JSON.stringify(s.town)
    if (townKey !== lastTownKey) { lastTownKey = townKey; applyBroken(s.town) }
  }
  if (s.bossProgress) applyBossSave(s.bossProgress)
  notifyMultiplayer()
  return true
}
