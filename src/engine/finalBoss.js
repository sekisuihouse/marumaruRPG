import * as THREE from 'three'
import { FINAL_ATTACKS, FINAL_BOSS, FINAL_PART_DEFS, FINAL_PLATFORM_DEFS } from '../data/finalBoss.js'
import { sim, addEffect, floater, gainXp, say } from './sim.js'
import { damagePlayer } from './damage.js'
import { groundY, move, nearestWalkable } from './nav.js'
import { isArenaLocked, lockArena, resumeEnemies, unlockArena } from './arena.js'

const tmp = new THREE.Vector3()
const tmp2 = new THREE.Vector3()
const inv = new THREE.Matrix4()
const delta = new THREE.Matrix4()
const up = new THREE.Vector3(0, 1, 0)

const makeParts = () => Object.fromEntries(Object.values(FINAL_PART_DEFS).map((def) => [def.id, {
  ...def, hp: def.hp, maxHp: def.hp, state: 'intact', broken: false, world: new THREE.Vector3(),
}]))

const fallbackMatrix = (boss, def) => {
  const [lx, ly, lz] = def.fallback
  const s = Math.sin(boss.yaw), c = Math.cos(boss.yaw)
  return new THREE.Matrix4().compose(
    new THREE.Vector3(boss.pos.x + lx * c + lz * s, boss.pos.y + ly, boss.pos.z - lx * s + lz * c),
    new THREE.Quaternion().setFromAxisAngle(up, boss.yaw), new THREE.Vector3(1, 1, 1),
  )
}

export function makeFinalBoss() {
  const p = nearestWalkable(0, 0)
  const boss = {
    id: 'boss:final', def: FINAL_BOSS, label: FINAL_BOSS.name, spawned: false, alive: false, defeated: false,
    state: 'locked', phase: 0, stateTime: 0, anim: 'idle', pos: new THREE.Vector3(p.x, groundY(p.x, p.z), p.z),
    yaw: 0, hp: FINAL_BOSS.baseHp, maxHp: FINAL_BOSS.baseHp, hitFlash: 0, attack: null, nextAttackAt: 0,
    parts: makeParts(), platforms: {}, hazards: [], checkpoint: 'ground', firstSeen: false, modelReady: false,
  }
  for (const def of FINAL_PLATFORM_DEFS) {
    const matrix = fallbackMatrix(boss, def)
    boss.platforms[def.id] = { ...def, matrix, previous: matrix.clone(), ready: false, safe: new THREE.Vector3().setFromMatrixPosition(matrix) }
  }
  if (!boss.modelReady) syncFallbackParts(boss)
  return boss
}

export function initFinalBoss() { sim.finalBoss = makeFinalBoss(); return sim.finalBoss }
export const finalBoss = () => sim.finalBoss || initFinalBoss()
export const finalBossActive = () => !!sim.finalBoss?.alive && sim.finalBoss.state !== 'defeated'
export const finalBossMounted = () => !!sim.player.finalBossPlatform && finalBossActive()

const allFourDefeated = () => (sim.bosses || []).length >= 4 && sim.bosses.every((b) => b.defeated) && (sim.bossProgress?.defeatedBossCount || 0) >= 4
const setState = (boss, state, phase = boss.phase) => { boss.state = state; boss.phase = phase; boss.stateTime = 0; boss.attack = null }

function syncFallbackParts(boss) {
  const byRole = {
    shinL: [-2.1, 6.5, 0], shinR: [2.1, 6.5, 0], armL: [-7.2, 18, 0], armR: [7.2, 18, 0],
    conduitStudent: [-2.2, 23, -1.1], conduitStage: [-3.7, 25, 0], conduitShrine: [3.7, 25, 0], conduitFood: [2.2, 23, -1.1],
    crown: [0, 33, 0], core: [0, 26, -1.5],
  }
  const s = Math.sin(boss.yaw), c = Math.cos(boss.yaw)
  for (const part of Object.values(boss.parts)) {
    const [x, y, z] = byRole[part.id]
    part.world.set(boss.pos.x + x * c + z * s, boss.pos.y + y, boss.pos.z - x * s + z * c)
  }
}

export function updateFinalBossTransforms(boneMatrices = {}) {
  const boss = finalBoss()
  for (const platform of Object.values(boss.platforms)) {
    platform.previous.copy(platform.matrix)
    const next = boneMatrices[platform.bone]
    if (next) { platform.matrix.copy(next); platform.ready = true }
    else { platform.matrix.copy(fallbackMatrix(boss, platform)); platform.ready = false }
    platform.safe.setFromMatrixPosition(platform.matrix).addScaledVector(up, platform.size[1] + 0.8)
  }
  for (const part of Object.values(boss.parts)) {
    const m = boneMatrices[part.bone]
    if (m) part.world.setFromMatrixPosition(m)
  }
}

function spawn() {
  const boss = finalBoss()
  if (boss.defeated || boss.spawned || isArenaLocked()) return false
  const p = nearestWalkable(0, 0)
  boss.pos.set(p.x, groundY(p.x, p.z), p.z)
  boss.yaw = Math.atan2(sim.player.pos.x - p.x, sim.player.pos.z - p.z)
  boss.spawned = boss.alive = true
  boss.firstSeen = true
  boss.hp = boss.maxHp
  boss.parts = makeParts()
  boss.anim = 'swagger'
  setState(boss, 'assembling', 0)
  syncFallbackParts(boss)
  lockArena(boss)
  sim.camera.profile = 'finalGround'
  addEffect({ kind: 'burst', x: boss.pos.x, y: boss.pos.y + 2, z: boss.pos.z, radius: 12, color: boss.def.color, life: 2.5 })
  say('四つの祭の力が集まり、祭典終端巨人・ティウが立ち上がる！', 'boss')
  return true
}

export function updateFinalBoss(dt) {
  const boss = finalBoss()
  if (!boss.spawned && !boss.defeated && allFourDefeated()) spawn()
  if (!boss.alive) return
  boss.stateTime += dt
  boss.hitFlash = Math.max(0, boss.hitFlash - dt)
  syncFallbackParts(boss)
  updateHazards(boss, dt)
  if (boss.state === 'assembling') {
    boss.anim = 'swagger'
    if (boss.stateTime >= 6) { setState(boss, 'ground', 1); boss.anim = 'walk'; boss.nextAttackAt = sim.time + 1.5; boss.checkpoint = 'ground'; say('PHASE 1：二本の脚を止めろ', 'boss') }
    return
  }
  if (boss.state === 'death') {
    boss.anim = 'death'; sim.camera.profile = 'finalDeath'
    if (boss.stateTime >= 8 && !sim.player.dead && !sim.player.finalBossPlatform) landPlayerOnHand(boss)
    if (boss.stateTime >= 12) finishFinalBoss(boss)
    return
  }
  if (sim.player.dead) { boss.pendingRecovery = true; return }
  if (boss.pendingRecovery) { boss.pendingRecovery = false; restoreCheckpoint(); return }
  updatePhase(boss)
  updateLocomotion(boss, dt)
  if (boss.attack) runAttack(boss, dt)
  else if (sim.time >= boss.nextAttackAt) beginAttack(boss)
  else boss.anim = boss.state === 'ground' ? 'walk' : 'idle'
  tryMountNearby(boss)
}

function updateLocomotion(boss, dt) {
  if (boss.state === 'ground' && !boss.attack) {
    const dx = sim.player.pos.x - boss.pos.x, dz = sim.player.pos.z - boss.pos.z
    const distance = Math.hypot(dx, dz)
    const wanted = Math.atan2(dx, dz)
    const diff = Math.atan2(Math.sin(wanted - boss.yaw), Math.cos(wanted - boss.yaw))
    const brokenShins = Number(boss.parts.shinL.broken) + Number(boss.parts.shinR.broken)
    const turnSpeed = 0.42 * (1 - brokenShins * 0.28)
    boss.yaw += THREE.MathUtils.clamp(diff, -turnSpeed * dt, turnSpeed * dt)
    if (distance > 12) {
      const speed = 0.72 * (1 - brokenShins * 0.32)
      const next = move(boss.pos.x, boss.pos.z, Math.sin(boss.yaw) * speed * dt, Math.cos(boss.yaw) * speed * dt, 2.2)
      boss.pos.set(next.x, groundY(next.x, next.z), next.z)
    }
  } else if (boss.phase >= 2 && boss.phase < 5 && !boss.attack) {
    // 身体上戦闘でも完全静止させず、足場追従を体験できる緩い旋回を続ける。
    boss.yaw += Math.sin(sim.time * 0.55) * 0.07 * dt
  }
}

function updatePhase(boss) {
  const shins = ['shinL', 'shinR'].filter((id) => boss.parts[id].broken).length
  const conduits = Object.values(boss.parts).filter((p) => p.role === 'conduit' && p.broken).length
  if (shins && boss.phase < 2) {
    setState(boss, 'mounted', 2); boss.checkpoint = 'mounted'; sim.camera.profile = 'finalMounted'
    say('PHASE 2：地面についた腕から身体へ登れ', 'boss')
  }
  if (boss.parts.crown.broken && boss.phase < 3) {
    setState(boss, 'blind', 3); boss.checkpoint = 'blind'; say('PHASE 3：視界を奪った。胸へ進め', 'boss')
  }
  if (conduits === 4 && boss.phase < 4) {
    setState(boss, 'core', 4); boss.checkpoint = 'core'; sim.camera.profile = 'finalCore'; say('PHASE 4：胸の祭核が露出した！', 'boss')
  }
}

function beginAttack(boss) {
  let def
  if (boss.phase === 1) def = boss.parts.armR.broken || Math.random() < 0.68 ? FINAL_ATTACKS.stomp : FINAL_ATTACKS.throw
  else if (boss.phase === 4) def = FINAL_ATTACKS.pulse
  else if (boss.phase === 3) def = FINAL_ATTACKS.blindCharge
  else {
    const bothArmsBroken = boss.parts.armL.broken && boss.parts.armR.broken
    def = bothArmsBroken || boss.parts.crown.broken || Math.random() >= 0.55 ? FINAL_ATTACKS.shake : FINAL_ATTACKS.swat
  }
  boss.attack = { def, phase: 'windup', timer: def.windup, target: sim.player.pos.clone(), hit: false }
  boss.anim = def.anim
  boss.telegraphUntil = sim.time + def.windup
  addEffect({ kind: 'telegraph', x: boss.attack.target.x, y: groundY(boss.attack.target.x, boss.attack.target.z) + 0.05, z: boss.attack.target.z, radius: def.radius || 4, color: '#ffcf70', life: def.windup })
}

function runAttack(boss, dt) {
  const a = boss.attack
  a.timer -= dt
  if (a.def.id === 'shake' && a.phase === 'windup') boss.yaw += Math.sin(a.timer * 22) * 1.8 * dt
  if (a.phase === 'windup' && a.timer <= 0) {
    executeAttack(boss, a)
    a.phase = 'recover'; a.timer = a.def.recover
  } else if (a.phase === 'recover' && a.timer <= 0) {
    boss.attack = null; boss.nextAttackAt = sim.time + (boss.phase === 4 ? 1.2 : 2.0); boss.anim = 'idle'
  }
}

const bossAttackState = () => ({ attack: 68, magicAttack: 68 })
function hitPlayer(boss, def, from = boss.pos) {
  damagePlayer(bossAttackState(), { power: def.damage, kind: 'aoe', element: 'dark', knockback: 5, unblockable: def.id === 'stomp' }, from)
}

function executeAttack(boss, attack) {
  const def = attack.def, p = sim.player
  if (def.id === 'stomp' || def.id === 'throw' || def.id === 'blindCharge') {
    if (Math.hypot(p.pos.x - attack.target.x, p.pos.z - attack.target.z) <= def.radius + p.hitRadius) hitPlayer(boss, def, attack.target)
    addEffect({ kind: 'aoe', x: attack.target.x, y: groundY(attack.target.x, attack.target.z) + 0.08, z: attack.target.z, radius: def.radius, color: '#ff9d4d', life: 0.65 })
    if (def.id === 'blindCharge') {
      const dx = attack.target.x - boss.pos.x, dz = attack.target.z - boss.pos.z, len = Math.hypot(dx, dz) || 1
      const next = move(boss.pos.x, boss.pos.z, dx / len * Math.min(8, len) , dz / len * Math.min(8, len), 2.2)
      boss.pos.set(next.x, groundY(next.x, next.z), next.z); boss.yaw = Math.atan2(dx, dz)
    }
  } else if (def.id === 'swat') {
    if (p.finalBossPlatform && p.invuln <= 0) hitPlayer(boss, def)
  } else if (def.id === 'shake') {
    if (p.finalBossPlatform && !p.blocking && p.state !== 'roll') detachMountedPlayer(-2.5)
    else if (p.finalBossPlatform) floater(p.pos, 'グリップ！', '#a8ffdf', 1)
  } else if (def.id === 'pulse' && p.finalBossPlatform) hitPlayer(boss, def, boss.parts.core.world)
}

function updateHazards(boss, dt) {
  for (let i = boss.hazards.length - 1; i >= 0; i--) {
    const h = boss.hazards[i]; h.life -= dt
    if (!h.hit && h.life <= 0.15) {
      h.hit = true
      if (!sim.player.dead && sim.player.pos.distanceTo(h) <= h.radius) hitPlayer(boss, { id: 'backlash', damage: h.damage }, h)
    }
    if (h.life <= 0) boss.hazards.splice(i, 1)
  }
}

function tryMountNearby(boss) {
  const p = sim.player
  if (p.airborne || p.finalBossPlatform || boss.phase < 2) return
  let best = null
  for (const platform of Object.values(boss.platforms)) {
    const pos = platform.safe
    const d = p.pos.distanceTo(pos)
    if (d < 3.2 && (!best || d < best.d)) best = { platform, d }
  }
  // Knee phase also provides a generous arm ramp from the ground.
  if (!best) {
    for (const [shinId, side, platformId] of [['shinL', -1, 'forearmL'], ['shinR', 1, 'forearmR']]) {
      if (!boss.parts[shinId].broken) continue
      tmp.set(boss.pos.x + side * 5, boss.pos.y + 1.2, boss.pos.z)
      const d = p.pos.distanceTo(tmp)
      if (d < 4 && (!best || d < best.d)) best = { platform: boss.platforms[platformId], d }
    }
  }
  if (best) mountPlayer(best.platform.id)
}

export function mountPlayer(id) {
  const boss = finalBoss(), platform = boss.platforms[id]
  if (!platform) return false
  const p = sim.player
  p.finalBossPlatform = id; p.airborne = false; p.vy = 0
  p.pos.copy(platform.safe); p.invuln = Math.max(p.invuln, 0.5)
  sim.camera.profile = boss.phase >= 4 ? 'finalCore' : 'finalMounted'
  return true
}

export function updateMountedPlayer(dt, axis) {
  const boss = finalBoss(), p = sim.player, platform = boss.platforms[p.finalBossPlatform]
  if (!platform || !boss.alive) { p.finalBossPlatform = null; return false }
  // Carry the player by the platform transform delta before local movement.
  inv.copy(platform.previous).invert(); delta.multiplyMatrices(platform.matrix, inv)
  p.pos.applyMatrix4(delta)
  const speed = (p.running ? p.runSpeed : p.walkSpeed) * (p.state === 'roll' ? 1.45 : 1)
  p.pos.x += axis.x * speed * dt; p.pos.z += axis.z * speed * dt
  inv.copy(platform.matrix).invert(); tmp.copy(p.pos).applyMatrix4(inv)
  const halfX = platform.size[0] * 0.5, halfZ = platform.size[2] * 0.5
  if (Math.abs(tmp.x) > halfX + 1.4 || Math.abs(tmp.z) > halfZ + 1.4) { detachMountedPlayer(-1.5); return false }
  tmp.x = THREE.MathUtils.clamp(tmp.x, -halfX, halfX); tmp.z = THREE.MathUtils.clamp(tmp.z, -halfZ, halfZ); tmp.y = platform.size[1] * 0.5 + 0.08
  p.pos.copy(tmp.applyMatrix4(platform.matrix)); p.vel.set(axis.x * speed, 0, axis.z * speed); p.moveSpeed = speed * axis.len
  if (axis.len > 0.01) p.yaw = Math.atan2(axis.x, axis.z)
  p.anim = p.state === 'roll' ? 'roll' : p.action ? p.action.def.clip : p.moveSpeed > 0.25 ? 'run' : p.blocking ? 'idle_sword' : 'idle'
  return true
}

export function detachMountedPlayer(vy = -1.5) {
  const p = sim.player
  p.finalBossPlatform = null; p.airborne = true; p.vy = vy
}

export function recoverFinalBossFall() {
  const boss = finalBoss(), p = sim.player
  if (!boss.alive || p.finalBossPlatform || p.pos.y > boss.pos.y - 2) return false
  const target = boss.phase >= 4 ? 'chest' : boss.phase >= 3 ? 'back' : 'forearmL'
  mountPlayer(target); floater(p.pos, '祭の糸が引き戻した', '#dff6ff', 1.1); return true
}

function landPlayerOnHand(boss) {
  mountPlayer('forearmR'); sim.player.pos.copy(boss.platforms.forearmR.safe)
}

export function damageFinalBossAt(point, attacker, attack, mul = 1) {
  const boss = finalBoss()
  if (!boss.alive || boss.state === 'assembling' || boss.state === 'death') return null
  let part = null, distance = Infinity
  for (const candidate of Object.values(boss.parts)) {
    if (candidate.broken) continue
    if (candidate.role === 'core' && boss.phase < 4) continue
    if ((candidate.role === 'conduit' || candidate.role === 'crown' || candidate.role === 'core') && !sim.player.finalBossPlatform) continue
    const d = candidate.world.distanceTo(point)
    if (d <= candidate.radius + (attack.range || 1.5) && d < distance) { part = candidate; distance = d }
  }
  if (!part) return null
  let amount = Math.max(1, Math.round(attack.power * (1 + (attacker?.attack ?? attacker?.magicAttack ?? 0) / 120) * mul))
  if (part.role === 'core') amount = Math.round(amount * 1.25)
  part.hp -= amount
  boss.hp = part.role === 'core'
    ? Math.max(0, boss.hp - amount)
    : Math.max(1, boss.hp - Math.round(amount * 0.42))
  boss.hitFlash = 0.24
  part.state = part.hp <= 0 ? 'broken' : part.hp <= part.maxHp * 0.5 ? 'wounded' : 'intact'
  floater(part.world, `${amount} ${part.label}`, part.color || '#fff3bf', 1.2)
  if (part.hp <= 0) breakPart(boss, part)
  if (part.role === 'core' && part.hp <= 0) beginDeath(boss)
  sim.hudTick++
  return { damage: amount, partId: part.id, broken: part.broken }
}

function breakPart(boss, part) {
  if (part.broken) return
  part.hp = 0; part.broken = true; part.state = 'broken'; part.brokenAt = sim.time
  addEffect({ kind: 'burst', x: part.world.x, y: part.world.y, z: part.world.z, radius: part.radius * 1.6, color: part.color || '#ffcf70', life: 1.2 })
  say(`${part.label}を破壊！`, 'boss')
  if (part.role === 'conduit') {
    boss.hazards.push({ id: `backlash:${part.id}`, x: part.world.x, y: part.world.y, z: part.world.z, radius: 4, damage: 36, life: 1.2, hit: false, color: part.color })
    addEffect({ kind: 'telegraph', x: part.world.x, y: part.world.y, z: part.world.z, radius: 4, color: part.color, life: 1.2 })
    // The matching trophy turns the backlash into a readable safe response window.
    if (sim.player.items[part.reward]) { boss.nextAttackAt = Math.max(boss.nextAttackAt, sim.time + 2.8); say(`${part.label}の力を、獲得した証が押し返した！`, 'boss') }
  }
  if (part.role === 'arm') boss.nextAttackAt = Math.max(boss.nextAttackAt, sim.time + 2.2)
  if (part.role === 'crown') boss.nextAttackAt = Math.max(boss.nextAttackAt, sim.time + 3.2)
}

function beginDeath(boss) {
  setState(boss, 'death', 5); boss.anim = 'death'; boss.attack = null; boss.checkpoint = 'death'; sim.camera.profile = 'finalDeath'
  say('最後の降下：崩れる身体を手のひらまで降りろ！', 'boss')
}

function finishFinalBoss(boss) {
  boss.alive = false; boss.defeated = true; boss.state = 'defeated'; boss.phase = 5; boss.hp = 0
  sim.player.finalBossPlatform = null; sim.camera.profile = 'normal'
  if (isArenaLocked()) { unlockArena('clear'); resumeEnemies() }
  if (!boss.rewarded) { boss.rewarded = true; gainXp(1200); sim.player.gold += 800 }
  say('祭典終端巨人・ティウを撃破。四つの祭の光が町へ帰った。', 'boss')
}

export function restoreCheckpoint() {
  const boss = finalBoss()
  if (!boss.alive || boss.state === 'assembling' || boss.state === 'death') return false
  const target = boss.phase >= 4 ? 'chest' : boss.phase >= 2 ? 'forearmL' : null
  if (target) mountPlayer(target)
  else {
    const p = nearestWalkable(boss.pos.x + 12, boss.pos.z)
    sim.player.pos.set(p.x, groundY(p.x, p.z), p.z)
    sim.player.finalBossPlatform = null
  }
  return true
}

export function finalBossHud() {
  const boss = sim.finalBoss
  if (!boss?.alive) return null
  return {
    id: boss.id, label: boss.label, hp: boss.hp, maxHp: boss.maxHp, phase: boss.phase, color: boss.def.color,
    state: boss.state, objective: boss.phase <= 1 ? '左右どちらかのすねを破壊' : boss.phase === 2 ? '身体を登り、4本の祭導管を破壊' : boss.phase === 3 ? '視界冠と残る祭導管を破壊' : boss.phase === 4 ? '胸の祭核を破壊' : '手のひらまで降りる',
    parts: Object.values(boss.parts).map((part) => ({ id: part.id, label: part.label, hp: Math.max(0, part.hp), maxHp: part.maxHp, state: part.state, color: part.color })),
  }
}

export function serializeFinalBoss() {
  const boss = finalBoss()
  return { spawned: boss.spawned, defeated: boss.defeated, firstSeen: boss.firstSeen, phase: boss.phase, state: boss.state, hp: boss.hp, checkpoint: boss.checkpoint, rewarded: !!boss.rewarded,
    parts: Object.fromEntries(Object.values(boss.parts).map((part) => [part.id, { hp: part.hp, broken: part.broken, state: part.state }])) }
}

export function applyFinalBossSave(data) {
  if (!data) return
  const boss = finalBoss()
  boss.defeated = !!data.defeated; boss.firstSeen = !!data.firstSeen; boss.rewarded = !!data.rewarded
  if (boss.defeated) { boss.spawned = true; boss.alive = false; boss.state = 'defeated'; boss.phase = 5; boss.hp = 0; return }
  if (data.spawned && !allFourDefeated() && (sim.bosses || []).length >= 4) {
    // 最終戦出現済みのセーブを正とし、旧版や不整合セーブでも進行不能にしない。
    for (const cleared of sim.bosses) { cleared.spawned = true; cleared.alive = false; cleared.defeated = true }
    sim.bossProgress.defeatedBossCount = Math.max(4, sim.bossProgress.defeatedBossCount || 0)
  }
  if (data.spawned && allFourDefeated()) {
    spawn(); boss.phase = Math.max(1, Math.min(5, data.phase || 1)); boss.checkpoint = data.checkpoint || 'ground'
    const savedState = data.state === 'death' ? 'death' : boss.phase === 1 ? 'ground' : boss.phase === 2 ? 'mounted' : boss.phase === 3 ? 'blind' : 'core'
    setState(boss, savedState, boss.phase); boss.hp = Math.max(0, data.hp ?? boss.maxHp); boss.anim = savedState === 'death' ? 'death' : 'idle'
    for (const [id, saved] of Object.entries(data.parts || {})) if (boss.parts[id]) Object.assign(boss.parts[id], { hp: Math.max(0, saved.hp ?? boss.parts[id].maxHp), broken: !!saved.broken, state: saved.state || (saved.broken ? 'broken' : 'intact') })
  }
}

export function resetFinalBoss() {
  if (isArenaLocked() && sim.arena?.bossId === 'boss:final') { unlockArena('abort'); resumeEnemies(0) }
  sim.player.finalBossPlatform = null; sim.camera.profile = 'normal'; sim.finalBoss = makeFinalBoss()
}
