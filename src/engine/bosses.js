import * as THREE from 'three'
import { BOSS_LIST, BOSS_TYPES, BOSS_SCALING } from '../data/bosses.js'
import { sim, addEffect, addProjectile, floater, say, gainXp, uid } from './sim.js'
import { nearestWalkable, groundY, move, isNavReady } from './nav.js'
import { buildingDestroyRatio, restoreObject } from './destruct.js'
import { initArena, lockArena, unlockArena, isArenaLocked, resumeEnemies } from './arena.js'
import { damagePlayer } from './damage.js'
import { damageTarget } from './targets.js'
import { hitDebris } from './debris.js'
import { spawnRagdoll } from './ragdoll.js'
import { multiplayer } from '../net/multiplayerStore.js'

const setState = (b, state) => { if (b.state !== state) { b.state = state; b.stateTime = 0 } }

function clearBossObjects(ownerId) {
  sim.bossObjects = (sim.bossObjects || []).filter((o) => o.ownerId !== ownerId)
}

/** 反撃できるボス小物。モデル内に骨・分離小物が無いため、実体は共通物理/攻撃系で表す。 */
function addBossObject(o) {
  const obj = { id: `boss-object:${uid()}`, alive: true, radius: 0.55, hp: 45, life: 4, ...o }
  sim.bossObjects.push(obj)
  obj.fx = addEffect({ kind: 'bossObject', x: obj.x, y: obj.y ?? groundY(obj.x, obj.z) + 0.7, z: obj.z, radius: obj.radius, color: obj.color || '#ffffff', life: obj.life })
  return obj
}

function exposeBoss(b, seconds, text) {
  b.barrier = false
  b.coreActive = false
  b.attack = null
  b.vulnerableUntil = sim.time + seconds
  setState(b, 'stagger')
  say(text, 'boss')
}

function makeBoss(def) {
  return {
    id: `boss:${def.id}`, typeId: def.id, def, label: def.name, alive: false, spawned: false, defeated: false,
    hp: def.baseHp, maxHp: def.baseHp, pos: new THREE.Vector3(), vel: new THREE.Vector3(), yaw: 0,
    scale: def.scale, state: 'hidden', stateTime: 0, anim: 'idle', hitFlash: 0, attack: null, lastAttackId: null,
    cooldowns: {}, phase: 1, invulnUntil: 0, vulnerableUntil: 0, specialHits: 0, nextSpecialAt: 0,
    strength: { defeatedBefore: 0, hp: 1, damage: 1, speed: 1, rate: 1, destruction: 1 },
  }
}

export function initBosses() {
  initArena()
  sim.bosses = BOSS_LIST.map(makeBoss)
  sim.bossProgress = { defeatedBossCount: 0, order: [], rewards: {}, buildingRatios: {} }
  sim.bossArmedAt = Infinity
}

/**
 * マップ初期化用。ボスの進行・出現中の本体・専用小物・攻撃を消し、
 * 次回は建物が再び壊れた時だけ新規出現する状態へ戻す。
 */
export function resetBossProgress() {
  for (const b of sim.bosses || []) {
    b.alive = false
    b.spawned = false
    b.defeated = false
    b.hp = b.maxHp = b.def.baseHp
    b.state = 'hidden'
    b.stateTime = 0
    b.attack = null
    b.phase = 1
    b.barrier = false
    b.coreActive = false
    b.cooking = false
    b.vulnerableUntil = 0
    b.invulnUntil = 0
    b.specialHits = 0
    b.lastAttackId = null
  }
  for (const b of sim.bosses || []) delete sim.player.items[b.def.reward.item]
  sim.bossObjects = []
  sim.projectiles = sim.projectiles.filter((p) => !String(p.ownerId || '').startsWith('boss:'))
  sim.effects = sim.effects.filter((f) => !String(f.ownerId || '').startsWith('boss:') && f.kind !== 'bossHazard' && f.kind !== 'delayedBossCircle' && f.kind !== 'bossObject')
  sim.ragdolls = sim.ragdolls.filter((r) => !String(r.id || '').startsWith('boss:'))
  sim.bossProgress = { defeatedBossCount: 0, order: [], rewards: {}, buildingRatios: {} }
  if (isArenaLocked()) { unlockArena('abort'); resumeEnemies(0) }
  // resetTown() の直後に誤出現しないよう、通常の開始と同じ短い猶予を置く。
  sim.bossArmedAt = sim.time + 1.2
}

/** タイトル操作後にだけ出現判定を解放する。 */
export function armBossSystem(delay = 1.2) {
  sim.bossArmedAt = sim.time + delay
}

export function buildingRatios() {
  const out = {}
  for (const d of BOSS_LIST) out[d.id] = buildingDestroyRatio(d.objectName)
  return out
}

function scaleFor(b) {
  const n = sim.bossProgress.defeatedBossCount
  b.strength = { defeatedBefore: n, hp: BOSS_SCALING.hpMultiplier(n), damage: BOSS_SCALING.damageMultiplier(n), speed: BOSS_SCALING.speedMultiplier(n), rate: BOSS_SCALING.attackRateMultiplier(n), destruction: BOSS_SCALING.destructionMultiplier(n) }
  // マルチプレイは人数でHPだけを穏やかに上げる。攻撃力は撃破順の既存補正のまま。
  const playerCount = multiplayer.role === 'host' ? 1 + [...multiplayer.peers.values()].filter((p) => p.connected).length : 1
  const partyHp = 1 + Math.max(0, playerCount - 1) * 0.45
  const roomStrength = multiplayer.role === 'host' ? (Number(multiplayer.settings.bossStrength) || 1) : 1
  b.maxHp = Math.round(b.def.baseHp * b.strength.hp * partyHp * roomStrength)
  b.hp = b.maxHp
}

function spawnBoss(b, force = false) {
  const area = buildingDestroyRatio(b.def.objectName)
  // 通常の出現は「対応する建物が規定割合まで壊れたとき」だけ。
  if (!force && (!area.total || area.ratio < b.def.spawnDestroyRatio)) return false
  // 強制出現(BOSS FORGE)は町の破壊データが未構築でも成立させる。
  // 編集画面は町・NavMeshに依存させないため、無ければ原点へ置く。
  const base = area.total ? area.center : { x: 0, z: 0 }
  const p = isNavReady() ? nearestWalkable(base.x, base.z) : base
  b.pos.set(p.x, isNavReady() ? groundY(p.x, p.z) : 0, p.z)
  b.home = { x: p.x, z: p.z }
  b.spawned = b.alive = true
  b.defeated = false
  b.phase = 1
  b.cooked = false
  b.overheatUses = 0
  clearBossObjects(b.id)
  b.attack = null
  b.invulnUntil = sim.time + 1.45
  b.vulnerableUntil = 0
  b.specialHits = 0
  b.nextSpecialAt = sim.time + 8
  // 編集プレビューは常に +Z（カメラ既定位置）を向かせて、正面から確認できるようにする
  b.yaw = sim.bossForge && !sim.bossForge.combat ? 0 : Math.atan2(sim.player.pos.x - p.x, sim.player.pos.z - p.z)
  scaleFor(b)
  setState(b, 'entrance')
  hitDebris(p.x, p.y + 0.6, p.z, 4.8, 0, 0.8, 0, 18)
  addEffect({ kind: 'burst', x: p.x, y: p.y + 1, z: p.z, color: b.def.color, radius: 3.2, life: 1.2 })
  say(`${b.label} が出現！ 建物の崩壊から現れた。`, 'boss')
  // 橋を封鎖し、川へATフィールドを張り、通常の敵を止めてBGMを切り替える。
  // BOSS FORGE の編集プレビューでは戦場化しない（BGMも通行止めも出さない）。
  if (!sim.bossForge || sim.bossForge.combat) lockArena(b)
  return true
}

/** 開発時のモデル確認用。建物の破壊状態を変更せずに安全地点へ出現させる。 */
export function debugSpawnBoss(id) {
  const b = bossById(id)
  return b && !b.defeated ? spawnBoss(b, true) : false
}

/** BOSS FORGE用。AI抽選を待たず、既存の攻撃実行経路へ流す。 */
export function debugForceBossAttack(id, actionId) {
  const b = bossById(id)
  const action = b?.def.abilities.find((a) => a.id === actionId)
  if (!b?.alive || !action) return false
  // 直前のポーズ再生や死亡表示を解除してから、通常の攻撃実行経路へ流す
  b.forgePose = null
  if (b.state === 'dead') { b.state = 'observe'; b.ragdollTime = 0; b.hp = Math.max(1, b.hp) }
  b.attack = null
  b.hitFlash = 0
  setState(b, 'observe')
  beginAttack(b, 0, action)
  return true
}

/**
 * BOSS FORGE用。攻撃以外の状態（待機・歩き・被弾・ダウン等）を単体再生する。
 * AnimationClip が無いモデルでも、手続き姿勢へ明確な再生状態を渡す。
 */
export const FORGE_POSES = [
  { id: 'idle', label: '待機', seconds: 0 },
  { id: 'walk', label: '歩き', seconds: 0 },
  { id: 'run', label: '走り', seconds: 0 },
  { id: 'hit', label: '被弾', seconds: 0.45 },
  { id: 'stagger', label: 'よろけ', seconds: 1.1 },
  { id: 'down', label: 'ダウン', seconds: 1.6 },
  { id: 'recover', label: '起き上がり', seconds: 1.2 },
  { id: 'phaseChange', label: 'フェーズ移行', seconds: 1.4 },
  { id: 'death', label: '死亡', seconds: 2.4 },
]

export function debugPlayBossPose(id, poseId) {
  const b = bossById(id)
  const pose = FORGE_POSES.find((p) => p.id === poseId)
  if (!b || !pose) return false
  b.attack = null
  b.forgePose = { id: pose.id, startedAt: sim.time, seconds: pose.seconds }
  // 見た目のためだけの状態遷移。AIは編集中に動かないので副作用は無い。
  if (pose.id === 'idle') { setState(b, 'observe'); b.anim = 'idle'; b.hitFlash = 0 }
  else if (pose.id === 'walk') { setState(b, 'approach'); b.anim = 'walk' }
  else if (pose.id === 'run') { setState(b, 'reposition'); b.anim = 'run' }
  else if (pose.id === 'hit') { b.hitFlash = 0.45; b.anim = 'hit' }
  else if (pose.id === 'stagger') { setState(b, 'stagger'); b.vulnerableUntil = sim.time + pose.seconds; b.anim = 'hit' }
  else if (pose.id === 'phaseChange') { b.phase = b.phase === 2 ? 1 : 2; setState(b, 'observe'); b.stateTime = 0 }
  else if (pose.id === 'death') { b.state = 'dead'; b.stateTime = 0; b.ragdollTime = 0; b.anim = 'death' }
  else { setState(b, 'observe'); b.anim = 'idle' }
  return true
}

/** 再生中の単体ポーズを止めて待機へ戻す */
export function debugStopBossPose(id) {
  const b = bossById(id)
  if (!b) return false
  b.forgePose = null
  b.attack = null
  b.hitFlash = 0
  b.ragdollTime = 0
  if (b.state === 'dead') { b.alive = true; b.hp = Math.max(1, b.hp) }
  setState(b, 'observe')
  b.anim = 'idle'
  return true
}

export function debugSetBossPhase(id, phase = 1) {
  const b = bossById(id)
  if (!b) return false
  b.phase = Number(phase) >= 2 ? 2 : 1
  b.hp = b.phase === 2 ? Math.min(b.hp, Math.floor(b.maxHp * b.def.phaseThreshold)) : Math.max(b.hp, Math.ceil(b.maxHp * b.def.phaseThreshold + 1))
  return true
}

export function debugSetBossAi(id, enabled) {
  const b = bossById(id)
  if (!b) return false
  b.debugAi = !!enabled
  return true
}

export function updateBosses(dt) {
  if (!sim.bosses) initBosses()
  // 戦闘中にプレイヤーが倒れたら、そこで仕切り直す。
  // updatePlayer が同じフレームで復活させることがあるので、死亡時刻でも判定する。
  const diedInFight = (sim.player.diedAt ?? -1) > (sim.arena?.since ?? 0)
  if (isArenaLocked() && (sim.player.dead || diedInFight)) { abortBossFight('playerDown'); return }
  if (sim.mode !== 'play') return
  // BOSS FORGE は町の破壊による出現判定を行わない。ただし選択中のボスは必ず更新する。
  // ここを通さないと runAttack が回らず、攻撃を再生しても静止したまま見える。
  if (sim.bossForge) {
    updateBossObjects(dt)
    for (const b of sim.bosses) if (b.alive) updateBoss(b, dt)
    return
  }
  if (!sim.townReady || sim.time < sim.bossArmedAt) return
  sim.bossProgress.buildingRatios = buildingRatios()
  updateBossObjects(dt)
  for (const b of sim.bosses) {
    // 封鎖中は次のボスを出さない。閉じた戦場は1体ぶんしか作れないので、
    // 2体目が場外に湧いて手が出せなくなるのを防ぐ（建物は壊れたままなので戦闘後に出る）。
    if (!b.spawned && !b.defeated) { if (!isArenaLocked()) spawnBoss(b); continue }
    if (!b.alive) continue
    updateBoss(b, dt)
  }
}

function updateBossObjects(dt) {
  for (let i = sim.bossObjects.length - 1; i >= 0; i--) {
    const o = sim.bossObjects[i]
    o.life -= dt
    if (o.kind === 'drone' && o.alive) {
      const b = bossById(o.ownerId)
      if (!b?.alive) o.alive = false
      else {
        const a = sim.time * 4.6 + o.orbit
        o.x = b.pos.x + Math.sin(a) * 2.1; o.z = b.pos.z + Math.cos(a) * 2.1; o.y = b.pos.y + 1.5 + Math.sin(a * 2) * 0.25
        if (o.fx) { o.fx.x = o.x; o.fx.y = o.y; o.fx.z = o.z }
        if (o.life < 1.05 && !o.fired) { o.fired = true; fireBolt(b, o.attack, 1, 0) }
      }
    }
    if (!o.alive || o.life <= 0) { if (o.fx) o.fx.life = 0; sim.bossObjects.splice(i, 1) }
  }
}

function updateBoss(b, dt) {
  b.stateTime += dt
  b.hitFlash = Math.max(0, b.hitFlash - dt)
  if (b.state === 'dead') {
    b.ragdollTime = (b.ragdollTime || 0) + dt
    if (b.ragdollTime > 7) b.alive = false
    return
  }
  if (b.state === 'entrance') {
    b.anim = 'idle'
    if (b.stateTime > 1.2) { setState(b, 'observe'); say(`${b.label}：第1フェーズ`, 'boss') }
    return
  }
  const p = sim.player
  if (p.dead) return
  const dx = p.pos.x - b.pos.x, dz = p.pos.z - b.pos.z
  const d = Math.hypot(dx, dz) || 1
  // 編集プレビューはプレイヤーとほぼ同座標なので、向きが毎フレーム暴れる。向きは固定する。
  if (!sim.bossForge || sim.bossForge.combat) b.yaw = Math.atan2(dx, dz)
  if (b.hp / b.maxHp <= b.def.phaseThreshold && b.phase === 1) {
    b.phase = 2
    b.vulnerableUntil = sim.time + 0.8
    addEffect({ kind: 'burst', x: b.pos.x, y: b.pos.y + 1, z: b.pos.z, color: b.def.color, radius: 3.6, life: 1 })
    say(`${b.label} が第2フェーズへ！`, 'boss')
  }
  if (b.cooking && sim.time >= b.cookFinishAt) {
    b.cooking = false; b.cooked = true; b.nextCookAt = sim.time + 20
    b.hp = Math.min(b.maxHp, b.hp + Math.round(b.maxHp * 0.1))
    say('料理長は料理で体力を回復した。', 'boss')
  }
  if (b.state === 'stagger' && sim.time >= b.vulnerableUntil) setState(b, 'observe')
  if (b.state === 'stagger') return
  if (b.attack) return runAttack(b, dt, dx, dz, d)
  if (b.debugAi === false) { b.anim = 'idle'; return }
  if (b.def.id === 'food' && !b.cooked && b.hp / b.maxHp < 0.36 && sim.time >= (b.nextCookAt || 0)) {
    beginAttack(b, d, b.def.abilities.find((a) => a.id === 'cook'))
    return
  }
  moveByStyle(b, dx, dz, d, dt)
  setState(b, d > 8 ? 'approach' : (b.def.id === 'student' || b.def.id === 'food') ? 'reposition' : 'observe')
  if (sim.time >= (b.nextAttackAt || 0)) beginAttack(b, d)
}

/** ボスごとの間合い・移動個性。 */
function moveByStyle(b, dx, dz, d, dt) {
  const speed = b.def.moveSpeed * b.strength.speed * (b.phase === 2 ? 1.15 : 1)
  let mx = 0, mz = 0
  if (b.def.id === 'student') {
    // 試作機は近づきすぎず、常に横へ逃げながら道具を切り替える。
    const side = Math.sin(sim.time * 2.6 + b.id.length) > 0 ? 1 : -1
    if (d > 8) { mx = dx / d; mz = dz / d } else { mx = -dz / d * side + dx / d * 0.18; mz = dx / d * side + dz / d * 0.18 }
  } else if (b.def.id === 'stage') {
    // ステージは中心を守り、離れすぎた相手だけを追う。
    if (d > 11) { mx = dx / d; mz = dz / d }
  } else if (b.def.id === 'shrine') {
    // 守護者は遅く一直線に迫る重戦車。
    if (d > 3.6) { mx = dx / d; mz = dz / d }
  } else {
    // 料理長は調理場のようにプレイヤーの周囲を回り込む。
    const side = Math.sin(sim.time * 1.4) > 0 ? 1 : -1
    if (d > 7) { mx = dx / d; mz = dz / d } else { mx = -dz / d * side; mz = dx / d * side }
  }
  if (mx || mz) {
    const r = move(b.pos.x, b.pos.z, mx * speed * dt, mz * speed * dt, b.def.hitRadius)
    b.pos.set(r.x, groundY(r.x, r.z, b.pos.y), r.z)
    b.anim = 'run'
  } else b.anim = 'idle'
}

function beginAttack(b, d, forced = null) {
  const a = forced || chooseBossAttack(b, d)
  b.attack = { def: a, timer: a.windup / b.strength.rate, phase: 'windup', x: sim.player.pos.x, z: sim.player.pos.z }
  b.lastAttackId = a.id
  b.nextAttackAt = sim.time + (2.6 / b.strength.rate)
  b.anim = a.kind === 'charge' ? 'run' : 'attack'
  // 大技は地面形状＋本体の発光/前傾の二重予告。画面外に即時判定を作らない。
  b.telegraphUntil = sim.time + b.attack.timer
  b.telegraphColor = a.color
  if (a.kind === 'aoe' || a.id === 'cook') addEffect({ kind: 'telegraph', x: b.attack.x, y: groundY(b.attack.x, b.attack.z) + 0.06, z: b.attack.z, radius: Math.max(1.4, a.breakRadius), color: a.color, life: b.attack.timer })
  else if (a.kind === 'arc') addEffect({ kind: 'telegraph', x: b.pos.x + Math.sin(b.yaw) * 2, y: b.pos.y + 0.06, z: b.pos.z + Math.cos(b.yaw) * 2, radius: a.range, color: a.color, life: b.attack.timer })
  if ((b.def.id === 'stage' || b.def.id === 'food') && (a.id === 'spotlight' || a.id === 'boil')) b.vulnerableUntil = sim.time + b.attack.timer
  if (b.def.id === 'shrine' && sim.time >= b.nextSpecialAt) spawnBarrierCores(b)
  void d
}

function chooseBossAttack(b, d) {
  const a = Object.fromEntries(b.def.abilities.map((x) => [x.id, x]))
  const next = (ids) => {
    b.attackIndex = ((b.attackIndex ?? -1) + 1) % ids.length
    // 大技の連続使用を禁止する。候補列の次の技まで送る。
    if (a[ids[b.attackIndex]]?.id === b.lastAttackId) b.attackIndex = (b.attackIndex + 1) % ids.length
    return a[ids[b.attackIndex]]
  }
  if (b.def.id === 'student') return d > 9 ? a.drone : next(b.phase === 2 ? ['spring', 'mimic', 'drone', 'runaway'] : ['mimic', 'drone', 'spring'])
  if (b.def.id === 'stage') return next(b.phase === 2 ? ['beat', 'speaker', 'spotlight', 'encore'] : ['speaker', 'beat', 'encore', 'beat'])
  if (b.def.id === 'shrine') return d > 10 ? a.ofuda : next(b.phase === 2 ? ['gate', 'quake', 'sweep', 'ofuda'] : ['sweep', 'ofuda', 'quake'])
  return d > 9 ? a.flame : next(b.phase === 2 ? ['flame', 'oil', 'pan', 'boil'] : ['pan', 'flame', 'oil'])
}

function runAttack(b, dt, dx, dz, d) {
  const a = b.attack
  a.timer -= dt
  if (a.phase === 'windup') {
    if (a.timer > 0) return
    if (b.def.id === 'shrine' && a.def.id === 'gate') {
      const p = sim.player.pos
      const side = Math.sin(sim.time * 3) > 0 ? 1 : -1
      const spot = nearestWalkable(p.x + Math.cos(b.yaw) * 3 * side, p.z - Math.sin(b.yaw) * 3 * side)
      addEffect({ kind: 'burst', x: b.pos.x, y: b.pos.y + 1, z: b.pos.z, color: '#b58cff', radius: 1.5, life: 0.35 })
      b.pos.set(spot.x, groundY(spot.x, spot.z), spot.z)
      b.yaw = Math.atan2(p.x - b.pos.x, p.z - b.pos.z)
      execute(b, a.def, b.pos.x, b.pos.z)
      a.phase = 'recover'; a.timer = a.def.recover
      return
    }
    if (a.def.kind === 'charge') { a.phase = 'charge'; a.timer = 0.65; return }
    execute(b, a.def, a.x, a.z)
    a.phase = 'recover'; a.timer = a.def.recover
    return
  }
  if (a.phase === 'charge') {
    const r = move(b.pos.x, b.pos.z, Math.sin(b.yaw) * b.def.moveSpeed * 2.5 * dt, Math.cos(b.yaw) * b.def.moveSpeed * 2.5 * dt, b.def.hitRadius)
    b.pos.set(r.x, groundY(r.x, r.z), r.z)
    structureStrike(b, a.def, b.pos.x, b.pos.z, 0.9, false)
    if (!a.hit && d < b.def.hitRadius + sim.player.hitRadius + 1.2) { a.hit = true; execute(b, a.def, b.pos.x, b.pos.z) }
    if (a.timer <= 0) { a.phase = 'recover'; a.timer = a.def.recover }
    return
  }
  if (a.timer <= 0) { b.attack = null; setState(b, 'observe') }
}

function spawnBarrierCores(b) {
  b.barrier = true; b.coreActive = true; b.coresLeft = sim.bossProgress.defeatedBossCount >= 2 ? 4 : 3
  b.nextSpecialAt = sim.time + 13
  for (let i = 0; i < b.coresLeft; i++) {
    const angle = (Math.PI * 2 * i) / b.coresLeft + b.yaw
    addBossObject({ ownerId: b.id, kind: 'core', x: b.pos.x + Math.sin(angle) * 4, z: b.pos.z + Math.cos(angle) * 4, y: b.pos.y + 1.1, radius: 0.72, hp: 55, life: 10, color: '#ffd36a', onBreak: () => {
      b.coresLeft--
      if (b.coresLeft <= 0 && b.alive) exposeBoss(b, b.def.staggerRules.vulnerable, '結界の核が砕けた！弱点露出。')
    } })
  }
  say('結界の核を壊して守護者をひるませよう！', 'boss')
}

const attackState = (b) => ({ attack: b.def.baseDamage * b.strength.damage, magicAttack: b.def.baseDamage * b.strength.damage })
const elementOf = (b) => (b.def.id === 'food' ? 'fire' : b.def.id === 'shrine' ? 'light' : b.def.id === 'stage' ? 'thunder' : 'wind')

function hurtPlayer(b, a, x, z) {
  damagePlayer(attackState(b), { ...a, power: a.characterDamage, kind: a.kind === 'bolt' ? 'magic' : a.kind === 'arc' ? 'melee' : 'aoe', element: elementOf(b), knockback: a.kind === 'arc' ? 6 : 4.5, unblockable: a.id === 'quake' || a.id === 'boil' }, { x, z })
}

function structureStrike(b, a, x, z, radius = a.breakRadius, burst = true) {
  damageTarget({ x, y: groundY(x, z) + 1, z, dirX: Math.sin(b.yaw), dirY: 0.45, dirZ: Math.cos(b.yaw), radius,
    attack: { ...a, power: a.structureDamage, kind: a.kind === 'bolt' ? 'magic' : 'heavy' }, attacker: attackState(b),
    hitEnemies: false, hitBosses: false, structureMul: b.strength.destruction, impulse: a.debrisImpulse * b.strength.destruction, juice: burst ? 0.52 : 0.16, slowmo: burst && a.power >= 55 })
}

function inArc(b, range, arc = 120) {
  const p = sim.player, dx = p.pos.x - b.pos.x, dz = p.pos.z - b.pos.z, d = Math.hypot(dx, dz)
  if (d > range + p.hitRadius) return false
  return (Math.sin(b.yaw) * dx + Math.cos(b.yaw) * dz) / (d || 1) >= Math.cos((arc / 2) * Math.PI / 180)
}

function fireBolt(b, a, count = 1, spread = 0) {
  const p = sim.player
  for (let i = 0; i < count; i++) {
    const angle = b.yaw + (i - (count - 1) / 2) * spread
    addProjectile({ owner: 'enemy', ownerId: b.id, kind: 'magic', attack: { ...a, kind: 'magic', element: elementOf(b), power: a.characterDamage, knockback: 2.4 }, attacker: attackState(b), mul: 1,
      x: b.pos.x + Math.sin(angle) * 0.9, y: b.pos.y + 1.4, z: b.pos.z + Math.cos(angle) * 0.9, dx: Math.sin(angle), dz: Math.cos(angle), speed: b.def.id === 'student' ? 19 : 24, radius: 0.24, color: a.color, life: 2.2, structure: true })
  }
  void p
}

function circle(b, a, x, z, radius = a.breakRadius) {
  const p = sim.player
  if (Math.hypot(p.pos.x - x, p.pos.z - z) <= radius + p.hitRadius) hurtPlayer(b, a, x, z)
  else floater(p.pos, '回避', '#a8ff9f', 0.8)
  structureStrike(b, a, x, z, radius)
  addEffect({ kind: 'aoe', x, y: groundY(x, z) + 0.1, z, radius, color: a.color, life: 0.55 })
}

function execute(b, a, x, z) {
  if (b.def.id === 'student') {
    if (a.id === 'drone') {
      const n = (b.phase === 2 ? 3 : 2) + (sim.bossProgress.defeatedBossCount >= 1 ? 1 : 0)
      for (let i = 0; i < n; i++) addBossObject({ ownerId: b.id, kind: 'drone', x: b.pos.x, z: b.pos.z, y: b.pos.y + 1.4, radius: 0.43, hp: 32, life: 3.2, orbit: i * 2.1, attack: a, color: a.color, onBreak: () => exposeBoss(b, 2.4, '暴走ドローンが試作機へ跳ね返った！') })
      return
    }
    if (a.id === 'mimic') { if (inArc(b, a.range, 105)) hurtPlayer(b, a, b.pos.x, b.pos.z); structureStrike(b, a, b.pos.x + Math.sin(b.yaw) * 2, b.pos.z + Math.cos(b.yaw) * 2, 2.8); addEffect({ kind: 'slash', x: b.pos.x, y: b.pos.y + 1, z: b.pos.z, yaw: b.yaw, radius: 2.2, color: a.color, life: 0.28 }); return }
    circle(b, a, x, z); return
  }
  if (b.def.id === 'stage') {
    if (a.id === 'speaker') { for (const dist of [5, 10, 15]) { const sx = b.pos.x + Math.sin(b.yaw) * dist, sz = b.pos.z + Math.cos(b.yaw) * dist; if (Math.hypot(sim.player.pos.x - sx, sim.player.pos.z - sz) < 1.35) hurtPlayer(b, a, sx, sz); structureStrike(b, a, sx, sz, 1.2, false); addEffect({ kind: 'slash', x: sx, y: groundY(sx, sz) + 0.8, z: sz, yaw: b.yaw, radius: 1.1, color: a.color, life: 0.38 }) } return }
    if (a.id === 'encore') { if (inArc(b, a.range, 150)) hurtPlayer(b, a, b.pos.x, b.pos.z); structureStrike(b, a, b.pos.x + Math.sin(b.yaw) * 2, b.pos.z + Math.cos(b.yaw) * 2, 3.2); addEffect({ kind: 'slash', x: b.pos.x, y: b.pos.y + 1, z: b.pos.z, yaw: b.yaw, radius: 3, color: a.color, life: 0.3 }); return }
    if (a.id === 'beat') {
      // 小→中→大の拍。各リングは別々に避けられ、連打型の範囲攻撃にならない。
      for (const [delay, r] of [[0, 2.2], [0.34, 3.9], [0.7, a.breakRadius]]) {
        addEffect({ kind: 'delayedBossCircle', ownerId: b.id, at: sim.time + delay, x: b.pos.x, z: b.pos.z, radius: r, color: a.color, attack: a, attacker: attackState(b), life: delay + 0.8 })
      }
      return
    }
    circle(b, a, x, z); return
  }
  if (b.def.id === 'shrine') {
    if (a.id === 'ofuda') { fireBolt(b, a, b.phase === 2 ? 2 : 1, 0.11); return }
    if (a.id === 'sweep' || a.id === 'gate') { if (inArc(b, a.range, 140)) hurtPlayer(b, a, b.pos.x, b.pos.z); structureStrike(b, a, b.pos.x + Math.sin(b.yaw) * 2, b.pos.z + Math.cos(b.yaw) * 2, 4); addEffect({ kind: 'slash', x: b.pos.x, y: b.pos.y + 1, z: b.pos.z, yaw: b.yaw, radius: 3.7, color: a.color, life: 0.35 }); return }
    circle(b, a, x, z); return
  }
  // 飲食: 炎は扇状飛び道具、油は継続的に残る危険地帯、鍋だけが大範囲。
  if (a.id === 'cook') {
    b.cooking = true
    addBossObject({ ownerId: b.id, kind: 'cookware', x: b.pos.x + Math.sin(b.yaw) * 1.2, z: b.pos.z + Math.cos(b.yaw) * 1.2, y: b.pos.y + 0.5, radius: 0.8, hp: 52, life: 2.7, color: '#8dff9b', onBreak: () => {
      b.cooking = false; b.cooked = true; b.nextCookAt = sim.time + 20
      exposeBoss(b, 4, '調理器具が壊れた！料理長はひるんだ。')
    } })
    // 成功時の回復は recover 終了時で確定する。中断は damageBoss で処理する。
    b.cookFinishAt = sim.time + 1.2
    return
  }
  if (a.id === 'flame') { fireBolt(b, a, b.phase === 2 ? 5 : 3, 0.14); return }
  if (a.id === 'pan') { if (inArc(b, a.range, 125)) hurtPlayer(b, a, b.pos.x, b.pos.z); structureStrike(b, a, b.pos.x + Math.sin(b.yaw) * 2, b.pos.z + Math.cos(b.yaw) * 2, 3.2); addEffect({ kind: 'slash', x: b.pos.x, y: b.pos.y + 1, z: b.pos.z, yaw: b.yaw, radius: 2.8, color: a.color, life: 0.28 }); return }
  if (a.id === 'oil') { structureStrike(b, a, x, z, 2.4); addEffect({ kind: 'bossHazard', x, y: groundY(x, z) + 0.05, z, radius: 2.4, color: a.color, life: 5, attack: { ...a, kind: 'magic' }, attacker: attackState(b), mul: 1, nextHit: sim.time + 0.25 }); return }
  for (const off of [-3, 0, 3]) circle(b, a, x + Math.sin(b.yaw + Math.PI / 2) * off, z + Math.cos(b.yaw + Math.PI / 2) * off, 2.1)
  // 鍋は残る反撃対象。攻撃で壊すと料理長にも隙ができる。
  addBossObject({ ownerId: b.id, kind: 'pot', x, z, y: groundY(x, z) + 0.7, radius: 0.9, hp: 55, life: 5, color: '#ffd166', onBreak: () => exposeBoss(b, 3.5, '落下した鍋が料理長へ跳ね返った！') })
}

export function damageBoss(b, attacker, attack, fromPos, mul = 1) {
  if (!b?.alive || b.state === 'dead' || sim.time < b.invulnUntil) return null
  const special = b.barrier || sim.time < b.vulnerableUntil
  const weak = attack.element === b.def.weakness
  let amount = attack.power * (1 + (attacker?.attack ?? 0) / 100) * mul
  if (weak) amount *= 1.45
  if (b.barrier) amount *= 0.25
  if (sim.time < b.vulnerableUntil) amount *= 1.75
  amount = Math.max(1, Math.round(amount))
  b.hp -= amount; b.hitFlash = 0.25
  floater(b.pos, `${amount}${weak ? ' 弱点!' : ''}`, weak ? '#ffe66b' : '#ffffff', weak ? 1.35 : 1.1)
  // 回復料理は本体を殴っても中断できる。小物へ当てればさらに長い隙になる。
  if (b.def.id === 'food' && b.cooking) {
    b.cooking = false; b.cooked = true; b.nextCookAt = sim.time + 20
    exposeBoss(b, 2.5, '回復料理を中断した！')
  }
  // ステージの発光予告中は、弱点属性の攻撃で大技を止められる。
  if (b.def.id === 'stage' && b.attack?.phase === 'windup' && (b.attack.def.id === 'speaker' || b.attack.def.id === 'spotlight') && weak) {
    exposeBoss(b, b.def.staggerRules.vulnerable, '発光装置が壊れ、演出が止まった！')
  }
  if ((b.def.id === 'student' || b.def.id === 'stage' || b.def.id === 'food') && special) {
    b.specialHits++
    const need = b.def.staggerRules.overheatHits || 1
    if (b.specialHits >= need) { b.specialHits = 0; b.vulnerableUntil = sim.time + b.def.staggerRules.vulnerable; b.attack = null; say(`${b.label} の隙ができた！`, 'boss') }
  }
  if (b.hp <= 0) defeatBoss(b)
  return { damage: amount, weak }
}

export function defeatBoss(b) {
  if (b.state === 'dead') return
  b.hp = 0; b.state = 'dead'; b.stateTime = 0; b.ragdollTime = 0; b.attack = null; b.defeated = true
  clearBossObjects(b.id)
  sim.bossProgress.defeatedBossCount++
  sim.bossProgress.order.push(b.def.id)
  sim.bossProgress.rewards[b.def.reward.item] = true
  gainXp(b.def.reward.xp); sim.player.gold += b.def.reward.gold; sim.player.items[b.def.reward.item] = (sim.player.items[b.def.reward.item] || 0) + 1
  spawnRagdoll({ ...b, scale: b.scale * 2.5 }, { x: b.pos.x, y: b.pos.y + 1, z: b.pos.z, dirX: Math.sin(b.yaw), dirY: 0.8, dirZ: Math.cos(b.yaw), power: 90, explosion: true })
  addEffect({ kind: 'burst', x: b.pos.x, y: b.pos.y + 1, z: b.pos.z, color: b.def.color, radius: 4.5, life: 1.4 })
  say(`${b.label} を撃破！ ${b.def.reward.label}を獲得。次のボスが強化される。`, 'boss')
  // 封鎖解除と敵の復帰。出現元の建物は壊したままにする（同じボスは再登場しない）
  if (isArenaLocked()) { unlockArena('clear'); resumeEnemies() }
}

/**
 * ボス戦の中断（プレイヤーが死んだとき）。
 * ボスを消し、出現元の建物を直し、封鎖を解いて敵を戻す。
 * 建物を直すので、もう一度壊せば同じボスがまた出てくる。
 */
export function abortBossFight(reason = 'playerDown') {
  const b = (sim.bosses || []).find((x) => x.alive && !x.defeated)
  if (!b) { if (isArenaLocked()) { unlockArena('abort'); resumeEnemies() } return false }
  clearBossObjects(b.id)
  b.alive = false
  b.spawned = false
  b.defeated = false
  b.state = 'hidden'
  b.stateTime = 0
  b.attack = null
  b.phase = 1
  b.hp = b.maxHp
  b.ragdollTime = 0
  sim.ragdolls = (sim.ragdolls || []).filter((r) => r.id !== b.id)
  sim.projectiles = sim.projectiles.filter((p) => p.ownerId !== b.id)
  sim.effects = sim.effects.filter((f) => f.ownerId !== b.id)
  // 出現元の建物を元通りにする（＝また壊せば再戦できる）
  const healed = restoreObject(b.def.objectName)
  unlockArena('abort')
  resumeEnemies()
  // 直後に破壊率がまだ高いと即再出現するので、少し猶予を置く
  sim.bossArmedAt = sim.time + 3
  say(`${b.label} は霧の中へ消えた。${b.def.objectName}は元通りになっている。`, 'boss')
  void reason
  return healed >= 0
}

export function applyBossSave(data) {
  if (!data || !sim.bosses) return
  const p = sim.bossProgress
  p.defeatedBossCount = Math.max(0, data.defeatedBossCount || 0); p.order = Array.isArray(data.order) ? [...data.order] : []; p.rewards = { ...(data.rewards || {}) }
  for (const b of sim.bosses) if (data.bosses?.[b.def.id]?.defeated) { b.defeated = true; b.spawned = true; b.alive = false; b.state = 'dead' }
}

export function serializeBosses() {
  const bosses = {}; for (const b of sim.bosses || []) bosses[b.def.id] = { spawned: b.spawned, defeated: b.defeated }
  return { bosses, defeatedBossCount: sim.bossProgress?.defeatedBossCount || 0, order: sim.bossProgress?.order || [], rewards: sim.bossProgress?.rewards || {} }
}

export const bossById = (id) => (sim.bosses || []).find((b) => b.id === id || b.def.id === id)
