import * as THREE from 'three'
import {
  boneKey, FINAL_ATTACKS, FINAL_BODY_DEFS, FINAL_BODY_RESPAWN, FINAL_BOSS, FINAL_CHUNK,
  FINAL_FALLBACK_HEIGHT, FINAL_PART_DEFS, FINAL_PHASE_OBJECTIVES,
} from '../data/finalBoss.js'
import { sim, addEffect, floater, gainXp, say } from './sim.js'
import { damagePlayer } from './damage.js'
import { groundY, move, nearestWalkable } from './nav.js'
import { isArenaLocked, resumeEnemies, unlockArena } from './arena.js'
import { playMusic, stopMusic } from './music.js'
import { spawnDebris } from './debris.js'
import { dust, impact, playBreakSound } from './juice.js'

const tmp = new THREE.Vector3()
const tmp2 = new THREE.Vector3()
const inv = new THREE.Matrix4()
const delta = new THREE.Matrix4()
const up = new THREE.Vector3(0, 1, 0)

const makeParts = () => Object.fromEntries(Object.values(FINAL_PART_DEFS).map((def) => [def.id, {
  ...def, hp: def.hp, maxHp: def.hp, state: 'intact', broken: false, world: new THREE.Vector3(),
  ratio: def.radius, radius: def.radius * FINAL_FALLBACK_HEIGHT, boneId: boneKey(def.bone),
}]))

const makeBody = () => FINAL_BODY_DEFS.map((def) => ({
  ...def, hp: def.hp, maxHp: def.hp, broken: false, restoreAt: 0, brokenAt: 0, ready: false,
  ratio: def.radius, radius: def.radius * FINAL_FALLBACK_HEIGHT,
  aId: boneKey(def.a), bId: boneKey(def.b),
  p0: new THREE.Vector3(), p1: new THREE.Vector3(),
  matrix: new THREE.Matrix4(), previous: new THREE.Matrix4(),
}))

/** ボスのローカル比率座標（全高が 1 のときの値）をワールドへ置く。 */
function localToWorld(boss, ratio, out) {
  const h = boss.visualHeight
  const s = Math.sin(boss.yaw), c = Math.cos(boss.yaw)
  const [x, y, z] = ratio
  return out.set(boss.pos.x + (x * c + z * s) * h, boss.pos.y + y * h, boss.pos.z + (-x * s + z * c) * h)
}

/** 段差をどれだけ登れるか。巨人の実寸に比例させる。 */
const stepUp = (boss) => Math.max(0.55, boss.visualHeight * 0.05)

export function makeFinalBoss() {
  const p = nearestWalkable(0, 0)
  const boss = {
    id: 'boss:final', def: FINAL_BOSS, label: FINAL_BOSS.name, spawned: false, alive: false, defeated: false,
    state: 'locked', phase: 0, stateTime: 0, anim: 'idle', pos: new THREE.Vector3(p.x, groundY(p.x, p.z), p.z),
    yaw: 0, hp: FINAL_BOSS.baseHp, maxHp: FINAL_BOSS.baseHp, hitFlash: 0, attack: null, nextAttackAt: 0,
    parts: makeParts(), body: makeBody(), bodyById: {}, chunks: [], hazards: [], checkpoint: 'ground',
    firstSeen: false, modelReady: false, visualHeight: FINAL_FALLBACK_HEIGHT,
    regen: true, collapseHp: FINAL_BOSS.baseHp, collapseTotal: FINAL_BODY_DEFS.length,
  }
  for (const seg of boss.body) boss.bodyById[seg.id] = seg
  syncFallbackTransforms(boss)
  return boss
}

export function initFinalBoss() { sim.finalBoss = makeFinalBoss(); return sim.finalBoss }
export const finalBoss = () => sim.finalBoss || initFinalBoss()
export const finalBossActive = () => !!sim.finalBoss?.alive && sim.finalBoss.state !== 'defeated'
export const finalBossMounted = () => !!sim.player.finalBossPlatform && finalBossActive()

const allFourDefeated = () => (sim.bosses || []).length >= 4 && sim.bosses.every((b) => b.defeated) && (sim.bossProgress?.defeatedBossCount || 0) >= 4
const setState = (boss, state, phase = boss.phase) => { boss.state = state; boss.phase = phase; boss.stateTime = 0; boss.attack = null }

/** フェーズの目標を画面中央に約2秒出す。 */
function announce(boss, phase) {
  const text = FINAL_PHASE_OBJECTIVES[phase]
  if (!text) return
  sim.objectiveBanner = { id: `final:${phase}`, label: `PHASE ${phase}`, text, color: boss.def.color, until: sim.time + 2.2 }
  sim.hudTick++
}

// ───────────────────────────── 身体の当たり判定（骨をつないだカプセル）

/** 骨がまだ届いていないときの仮の姿勢。 */
function syncFallbackTransforms(boss) {
  for (const part of Object.values(boss.parts)) {
    localToWorld(boss, part.at, part.world)
    part.radius = Math.max(0.08, part.ratio * boss.visualHeight)
  }
  for (const seg of boss.body) {
    localToWorld(boss, seg.from, seg.p0)
    localToWorld(boss, seg.to, seg.p1)
    seg.radius = Math.max(0.06, seg.ratio * boss.visualHeight)
    seg.previous.copy(seg.matrix)
    seg.matrix.makeTranslation(seg.p0.x, seg.p0.y, seg.p0.z)
  }
}

/** 骨のワールド座標から、実際に描画されている全高を測る。 */
function measureHeight(boneMatrices) {
  let min = Infinity, max = -Infinity
  for (const key in boneMatrices) {
    const y = boneMatrices[key].elements[13]
    if (y < min) min = y
    if (y > max) max = y
  }
  return max > min ? max - min : 0
}

export function updateFinalBossTransforms(boneMatrices = {}) {
  const boss = finalBoss()
  // 巨人の寸法は縮まないので、測れた最大値を保持する。
  // アニメーションでかがんだ瞬間に判定が痩せるのを防ぐ。
  const measured = measureHeight(boneMatrices)
  if (measured > boss.visualHeight) boss.visualHeight = measured

  for (const part of Object.values(boss.parts)) {
    part.radius = Math.max(0.08, part.ratio * boss.visualHeight)
    const m = boneMatrices[part.boneId]
    if (m) part.world.setFromMatrixPosition(m)
    else localToWorld(boss, part.at, part.world)
  }
  for (const seg of boss.body) {
    seg.radius = Math.max(0.06, seg.ratio * boss.visualHeight)
    seg.previous.copy(seg.matrix)
    const ma = boneMatrices[seg.aId], mb = boneMatrices[seg.bId]
    if (ma && mb) {
      seg.matrix.copy(ma)
      seg.p0.setFromMatrixPosition(ma)
      seg.p1.setFromMatrixPosition(mb)
      seg.ready = true
    } else {
      localToWorld(boss, seg.from, seg.p0)
      localToWorld(boss, seg.to, seg.p1)
      seg.matrix.makeTranslation(seg.p0.x, seg.p0.y, seg.p0.z)
      seg.ready = false
    }
  }
}

/** 縦線 (x,z) が当たるカプセルの上面。外れていれば null。 */
function segmentSurfaceY(seg, x, z) {
  const bx = seg.p1.x - seg.p0.x, bz = seg.p1.z - seg.p0.z
  const len2 = bx * bx + bz * bz
  const t = len2 > 1e-9 ? THREE.MathUtils.clamp(((x - seg.p0.x) * bx + (z - seg.p0.z) * bz) / len2, 0, 1) : 0
  const cx = seg.p0.x + bx * t, cz = seg.p0.z + bz * t
  const d2 = (x - cx) ** 2 + (z - cz) ** 2
  const r = seg.radius
  if (d2 >= r * r) return null
  return seg.p0.y + (seg.p1.y - seg.p0.y) * t + Math.sqrt(r * r - d2)
}

/** 点から線分までの距離。攻撃がどの身体に当たったかを決める。 */
function distanceToSegment(seg, point) {
  tmp2.subVectors(seg.p1, seg.p0)
  const len2 = tmp2.lengthSq()
  const t = len2 > 1e-9 ? THREE.MathUtils.clamp(tmp.subVectors(point, seg.p0).dot(tmp2) / len2, 0, 1) : 0
  tmp.copy(seg.p0).addScaledVector(tmp2, t)
  return tmp.distanceTo(point)
}

/** カプセルの真上（乗せ直し用の安全な足場）。 */
function segmentTop(seg, out) {
  return out.copy(seg.p0).lerp(seg.p1, 0.5).addScaledVector(up, seg.radius + 0.12)
}

/**
 * (x,z) の柱で、maxY 以下にある一番高い身体の面を返す。
 * これがボスの「地面」になる。
 */
export function finalBodySupport(x, z, maxY) {
  const boss = sim.finalBoss
  if (!boss?.alive || boss.state === 'assembling') return null
  let best = null
  for (const seg of boss.body) {
    if (seg.broken) continue
    const y = segmentSurfaceY(seg, x, z)
    if (y === null || y > maxY) continue
    if (!best || y > best.y) best = { seg, y }
  }
  return best
}

/**
 * 足元にボスの身体があれば乗る。地面から足の甲へ歩いて登る動きもここが担当する。
 * @returns {boolean} 身体の上に立っているか
 */
export function finalBossFooting() {
  const boss = sim.finalBoss
  const p = sim.player
  if (!boss?.alive || p.dead || boss.state === 'assembling') return false
  if (p.finalBossPlatform) return true
  const climb = stepUp(boss)
  const support = finalBodySupport(p.pos.x, p.pos.z, p.pos.y + climb)
  if (!support) return false
  // 落下中に身体を突き抜けないよう、下方向は広めに拾う
  if (support.y < p.pos.y - (p.airborne ? climb * 6 : climb * 2)) return false
  // 地面すれすれの面は「乗った」扱いにしない（歩いていて勝手に持ち上がる）
  if (support.y < groundY(p.pos.x, p.pos.z, p.pos.y) + 0.25) return false
  standOn(support.seg.id, support.y)
  return true
}

function standOn(id, y) {
  const boss = finalBoss(), p = sim.player
  const first = !p.finalBossPlatform
  p.finalBossPlatform = id
  p.airborne = false
  p.vy = 0
  p.pos.y = y
  if (first) {
    sim.camera.profile = boss.phase >= 4 ? 'finalCore' : 'finalMounted'
    if (boss.phase >= 1) floater(p.pos, '身体に取り付いた', '#a8ffdf', 1)
  }
}

/** 指定した身体へ瞬間的に乗せ直す（復帰・チェックポイント用）。 */
export function mountPlayer(id) {
  const boss = finalBoss()
  const seg = boss.bodyById[id] || boss.body.find((s) => !s.broken)
  if (!seg || seg.broken) return false
  const p = sim.player
  segmentTop(seg, tmp)
  p.pos.copy(tmp)
  p.invuln = Math.max(p.invuln, 0.5)
  standOn(seg.id, tmp.y)
  return true
}

export function updateMountedPlayer(dt, axis) {
  const boss = finalBoss(), p = sim.player
  const seg = boss.bodyById[p.finalBossPlatform]
  if (!seg || seg.broken || !boss.alive) { detachMountedPlayer(-1.2); return false }
  // 骨の移動量でプレイヤーを運んでから、入力を解決する。
  // 逆にすると、動く腕の上で入力が毎フレーム打ち消される。
  inv.copy(seg.previous).invert(); delta.multiplyMatrices(seg.matrix, inv)
  p.pos.applyMatrix4(delta)
  const speed = (p.running ? p.runSpeed : p.walkSpeed) * (p.state === 'roll' ? 1.45 : 1)
  p.pos.x += axis.x * speed * dt
  p.pos.z += axis.z * speed * dt

  const climb = stepUp(boss)
  const support = finalBodySupport(p.pos.x, p.pos.z, p.pos.y + climb)
  if (!support || support.y < p.pos.y - climb * 2.5) { detachMountedPlayer(-1.2); return false }
  p.finalBossPlatform = support.seg.id
  p.pos.y += (support.y - p.pos.y) * Math.min(1, dt * 16)
  p.vel.set(axis.x * speed, 0, axis.z * speed)
  p.moveSpeed = speed * axis.len
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
  if (!boss.alive || p.finalBossPlatform || boss.phase < 2) return false
  if (p.pos.y > boss.pos.y - 2) return false
  const target = boss.body.find((s) => !s.broken && (s.id === 'chest' || s.id === 'hips' || s.id === 'foreArmL'))
    || boss.body.find((s) => !s.broken)
  if (!target || !mountPlayer(target.id)) return false
  floater(p.pos, '祭の糸が引き戻した', '#dff6ff', 1.1)
  return true
}

// ───────────────────────────── 身体の小片（建物とまったく同じ壊れ方）

const respawnDelay = (boss) => FINAL_BODY_RESPAWN[THREE.MathUtils.clamp(boss.phase, 0, FINAL_BODY_RESPAWN.length - 1)]

/** 描画側（GPUのマスク）へ壊れた小片を伝える窓口。 */
let chunkSink = null
export function setFinalBossChunkSink(sink) { chunkSink = sink }

export const finalBossChunks = () => sim.finalBoss?.chunks || []

/**
 * 描画側が分割した身体の小片を登録する。
 * 位置は毎フレーム描画側が world へ書き込む（骨で動くため）。
 * @param {Array<{id:number,boneName:string,radius:number}>} list
 */
export function registerFinalBossChunks(list) {
  const boss = finalBoss()
  boss.chunks = list.map((c) => ({
    id: c.id, boneName: c.boneName, radius: Math.max(0.2, c.radius),
    hp: FINAL_CHUNK.hp, maxHp: FINAL_CHUNK.hp, broken: false, restoreAt: 0,
    world: new THREE.Vector3(), segId: null,
  }))
  linkChunksToBody(boss)
  chunkSink?.reset?.()
  return boss.chunks
}

/** 小片を身体カプセルへ結びつける。足場が抜けるかの判定に使う。 */
function linkChunksToBody(boss) {
  const byStart = new Map(), byEnd = new Map()
  for (const seg of boss.body) {
    seg.chunkTotal = 0; seg.chunkBroken = 0
    if (!byStart.has(seg.aId)) byStart.set(seg.aId, seg)
    if (!byEnd.has(seg.bId)) byEnd.set(seg.bId, seg)
  }
  for (const chunk of boss.chunks) {
    const seg = byStart.get(chunk.boneName) || byEnd.get(chunk.boneName) || null
    chunk.segId = seg ? seg.id : null
    if (seg) seg.chunkTotal++
  }
}

/** ボス再出現時に小片だけ元へ戻す（分割結果は描画側が持ったまま）。 */
function resetChunks(boss) {
  for (const chunk of boss.chunks) { chunk.hp = chunk.maxHp; chunk.broken = false; chunk.restoreAt = 0 }
  linkChunksToBody(boss)
  chunkSink?.reset?.()
}

/** カプセルの「壊れた」は小片の残りから決まる。穴だらけになれば足場ごと抜ける。 */
function refreshSegment(boss, seg) {
  if (!seg.chunkTotal) return
  const broken = seg.chunkBroken / seg.chunkTotal >= FINAL_CHUNK.collapseRatio
  if (broken === seg.broken) return
  seg.broken = broken
  if (broken && sim.player.finalBossPlatform === seg.id) detachMountedPlayer(-1.4)
}

/** 小片ひとつを壊す。破片・粉塵・破壊音・連鎖まで建物と同じ入口を通す。 */
function breakChunk(boss, chunk, from, impulseMul = 1, depth = 0) {
  if (chunk.broken) return
  chunk.hp = 0
  chunk.broken = true
  chunk.restoreAt = boss.regen ? sim.time + respawnDelay(boss) : Infinity
  chunkSink?.setBroken?.(chunk.id, true)
  const seg = chunk.segId != null ? boss.bodyById[chunk.segId] : null
  if (seg) { seg.chunkBroken++; refreshSegment(boss, seg) }

  tmp.copy(chunk.world).sub(from || boss.pos)
  if (tmp.lengthSq() < 1e-6) tmp.set(0, 1, 0)
  tmp.normalize()
  const size = Math.max(0.25, chunk.radius)
  spawnDebris({
    x: chunk.world.x, y: chunk.world.y, z: chunk.world.z,
    size, volume: size ** 3, mass: Math.max(0.6, size * 6), materialType: FINAL_CHUNK.material,
    partId: -1, dirX: tmp.x, dirY: Math.max(0.2, tmp.y), dirZ: tmp.z, power: 9 * impulseMul, spread: 0.9,
  })
  const scale = Math.min(1, 0.2 + size * 0.12)
  dust(chunk.world.x, chunk.world.y, chunk.world.z, FINAL_CHUNK.material, scale)
  playBreakSound(FINAL_CHUNK.material, scale)
  impact(scale * 0.5, { slowmo: false })

  // 連鎖：隣の小片へ衝撃が伝わる。無制限に広げると1発で全身が消えるので数を絞る。
  if (depth < 2) {
    const reach = chunk.radius * FINAL_CHUNK.chainRatio
    let spread = 0
    for (const n of boss.chunks) {
      if (n.broken || n === chunk || spread >= 6) continue
      if (n.world.distanceTo(chunk.world) > reach) continue
      spread++
      n.hp -= chunk.maxHp * FINAL_CHUNK.chainDamage
      if (n.hp <= 0) breakChunk(boss, n, chunk.world, impulseMul * 0.7, depth + 1)
    }
  }
  onBodyLost(boss)
}

/** 攻撃を小片へ配る。命中点からの距離で減衰させるのは建物の damageStructure と同じ。 */
function damageChunks(boss, point, attacker, attack, mul, reach) {
  const radius = Math.max(reach, 0.6)
  let hits = 0, total = 0, broken = 0
  const power = attack.power * (1 + (attacker?.attack ?? attacker?.magicAttack ?? 0) / 120) * mul
  for (const chunk of boss.chunks) {
    if (chunk.broken) continue
    const d = chunk.world.distanceTo(point) - chunk.radius
    if (d > radius) continue
    const falloff = Math.max(0.25, 1 - Math.max(0, d) / radius)
    const amount = Math.max(1, Math.round(power * falloff))
    chunk.hp -= amount
    total += amount
    hits++
    if (chunk.hp <= 0) { breakChunk(boss, chunk, point, 1); broken++ }
  }
  if (!hits) return null
  boss.hitFlash = 0.2
  sim.hudTick++
  return { damage: total, partId: 'body', body: true, broken: broken > 0, chunks: hits }
}

function updateChunkRestore(boss) {
  if (!boss.regen || !boss.chunks.length) return
  for (const chunk of boss.chunks) {
    if (!chunk.broken || sim.time < chunk.restoreAt) continue
    chunk.broken = false
    chunk.hp = chunk.maxHp
    chunk.restoreAt = 0
    chunkSink?.setBroken?.(chunk.id, false)
    const seg = chunk.segId != null ? boss.bodyById[chunk.segId] : null
    if (seg) { seg.chunkBroken = Math.max(0, seg.chunkBroken - 1); refreshSegment(boss, seg) }
    // 一斉に戻るので、光は間引いて出す
    if (chunk.id % 7 === 0) addEffect({ kind: 'ring', x: chunk.world.x, y: chunk.world.y, z: chunk.world.z, radius: chunk.radius, color: '#9fe6ff', life: 0.4 })
  }
  sim.hudTick++
}

/** 再生が止まったあと、削れた分だけHPを減らし、削り切ったら崩れ落とす。 */
function onBodyLost(boss) {
  if (boss.regen || !boss.chunks.length) return
  const intact = boss.chunks.reduce((n, c) => n + (c.broken ? 0 : 1), 0)
  boss.hp = Math.max(0, Math.round(boss.collapseHp * (intact / Math.max(1, boss.collapseTotal))))
  if (intact <= boss.chunks.length * (1 - FINAL_CHUNK.deathRatio)) beginDeath(boss)
}

export const finalBodyIntact = () => {
  const boss = sim.finalBoss
  if (!boss) return { intact: 0, total: 0 }
  if (boss.chunks.length) return { intact: boss.chunks.reduce((n, c) => n + (c.broken ? 0 : 1), 0), total: boss.chunks.length }
  return { intact: boss.body.reduce((n, s) => n + (s.broken ? 0 : 1), 0), total: boss.body.length }
}

// ───────────────────────────── モデル読込前のフォールバック（カプセル単位の破壊）
// 小片が登録される前でも身体を壊せるようにしておく。登録後はこの経路は使わない。

function breakBodySegment(boss, seg) {
  if (seg.broken) return
  seg.hp = 0; seg.broken = true; seg.brokenAt = sim.time
  seg.restoreAt = boss.regen ? sim.time + respawnDelay(boss) : Infinity
  segmentTop(seg, tmp)
  addEffect({ kind: 'burst', x: tmp.x, y: tmp.y, z: tmp.z, radius: seg.radius * 1.5, color: '#ffb066', life: 0.9 })
  if (sim.player.finalBossPlatform === seg.id) detachMountedPlayer(-1.4)
  if (!boss.regen) {
    // 祭壇を壊した後は塞がらない。残りが尽きた時点で崩れ落ちる。
    const intact = boss.body.reduce((n, s) => n + (s.broken ? 0 : 1), 0)
    boss.hp = Math.max(0, Math.round(boss.collapseHp * (intact / Math.max(1, boss.collapseTotal))))
    say(`${seg.label}が崩れ落ちた（残り${intact}）`, 'boss')
    if (intact === 0) beginDeath(boss)
  }
  sim.hudTick++
}

function updateBodyRestore(boss) {
  if (!boss.regen || boss.chunks.length) return
  for (const seg of boss.body) {
    if (!seg.broken || sim.time < seg.restoreAt) continue
    seg.broken = false; seg.hp = seg.maxHp; seg.restoreAt = 0
    segmentTop(seg, tmp)
    addEffect({ kind: 'ring', x: tmp.x, y: tmp.y, z: tmp.z, radius: seg.radius, color: '#9fe6ff', life: 0.45 })
    sim.hudTick++
  }
}

function damageBody(boss, point, attacker, attack, mul, reach) {
  let seg = null, distance = Infinity
  for (const candidate of boss.body) {
    if (candidate.broken) continue
    const d = distanceToSegment(candidate, point) - candidate.radius
    if (d <= reach && d < distance) { seg = candidate; distance = d }
  }
  if (!seg) return null
  const amount = Math.max(1, Math.round(attack.power * (1 + (attacker?.attack ?? attacker?.magicAttack ?? 0) / 120) * mul))
  seg.hp -= amount
  boss.hitFlash = 0.2
  segmentTop(seg, tmp)
  floater(tmp, `${amount} ${seg.label}`, '#ffd9a8', 0.9)
  if (seg.hp <= 0) breakBodySegment(boss, seg)
  sim.hudTick++
  return { damage: amount, partId: seg.id, body: true, broken: seg.broken }
}

// ───────────────────────────── 進行

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
  boss.body = makeBody()
  boss.bodyById = {}
  for (const seg of boss.body) boss.bodyById[seg.id] = seg
  resetChunks(boss)
  boss.regen = true
  boss.anim = 'swagger'
  setState(boss, 'assembling', 0)
  syncFallbackTransforms(boss)
  playMusic('bossChase')
  sim.camera.profile = 'finalGround'
  addEffect({ kind: 'burst', x: boss.pos.x, y: boss.pos.y + boss.visualHeight * 0.2, z: boss.pos.z, radius: boss.visualHeight * 0.35, color: boss.def.color, life: 2.5 })
  say('四つの祭の力が集まり、祭典終端巨人・ティウが立ち上がる！', 'boss')
  return true
}

export function updateFinalBoss(dt) {
  const boss = finalBoss()
  if (!boss.spawned && !boss.defeated && allFourDefeated()) spawn()
  if (!boss.alive) return
  boss.stateTime += dt
  boss.hitFlash = Math.max(0, boss.hitFlash - dt)
  if (!boss.modelReady) syncFallbackTransforms(boss)
  updateHazards(boss, dt)
  updateBodyRestore(boss)
  updateChunkRestore(boss)
  if (boss.state === 'assembling') {
    boss.anim = 'swagger'
    if (boss.stateTime >= 6) {
      setState(boss, 'ground', 1); boss.anim = 'walk'; boss.nextAttackAt = sim.time + 1.5; boss.checkpoint = 'ground'
      announce(boss, 1); say('PHASE 1：光るひざを壊せ', 'boss')
    }
    return
  }
  if (boss.state === 'death') {
    boss.anim = 'death'; sim.camera.profile = 'finalDeath'
    if (boss.stateTime >= 8 && sim.player.finalBossPlatform) detachMountedPlayer(-1)
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
  finalBossFooting()
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
    announce(boss, 2); say('PHASE 2：身体を登れ', 'boss')
  }
  if (boss.parts.crown.broken && boss.phase < 3) {
    setState(boss, 'blind', 3); boss.checkpoint = 'blind'
    announce(boss, 3); say('PHASE 3：視界を奪った', 'boss')
  }
  if (conduits === 4 && boss.phase < 4) {
    setState(boss, 'core', 4); boss.checkpoint = 'core'; sim.camera.profile = 'finalCore'
    announce(boss, 4); say('PHASE 4：胸の祭壇が露出した！', 'boss')
  }
}

/** 祭壇を壊した後の最終局面。身体は二度と塞がらない。 */
function beginCollapse(boss) {
  boss.regen = false
  boss.collapseTotal = Math.max(1, finalBodyIntact().intact)
  boss.collapseHp = Math.max(1, boss.hp)
  for (const seg of boss.body) if (seg.broken) seg.restoreAt = Infinity
  for (const chunk of boss.chunks) if (chunk.broken) chunk.restoreAt = Infinity
  setState(boss, 'collapse', 5); boss.checkpoint = 'collapse'
  sim.camera.profile = 'finalCore'
  announce(boss, 5)
  say('祭壇が砕けた。再生は止まった——身体を残らず壊せ！', 'boss')
  if (boss.collapseTotal <= 0) beginDeath(boss)
}

function beginAttack(boss) {
  let def
  if (boss.phase === 1) def = boss.parts.armR.broken || Math.random() < 0.68 ? FINAL_ATTACKS.stomp : FINAL_ATTACKS.throw
  else if (boss.phase >= 4) def = FINAL_ATTACKS.pulse
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
    boss.attack = null; boss.nextAttackAt = sim.time + (boss.phase >= 4 ? 1.2 : 2.0); boss.anim = 'idle'
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
      const next = move(boss.pos.x, boss.pos.z, dx / len * Math.min(8, len), dz / len * Math.min(8, len), 2.2)
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

// ───────────────────────────── ダメージ入口

export function damageFinalBossAt(point, attacker, attack, mul = 1) {
  const boss = finalBoss()
  if (!boss.alive || boss.state === 'assembling' || boss.state === 'death') return null
  const reach = attack.range || 1.5
  let part = null, distance = Infinity
  for (const candidate of Object.values(boss.parts)) {
    if (candidate.broken) continue
    if (candidate.role === 'core' && boss.phase < 4) continue
    if ((candidate.role === 'conduit' || candidate.role === 'crown' || candidate.role === 'core') && !sim.player.finalBossPlatform) continue
    const d = candidate.world.distanceTo(point)
    if (d <= candidate.radius + reach && d < distance) { part = candidate; distance = d }
  }
  // 主要部位に届かない攻撃は、当たった身体そのものを削る。
  // 小片が登録済みなら、建物とまったく同じ「欠けて破片が飛ぶ」破壊を通す。
  if (!part) {
    return boss.chunks.length
      ? damageChunks(boss, point, attacker, attack, mul, reach)
      : damageBody(boss, point, attacker, attack, mul, reach)
  }

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
  if (part.role === 'core' && part.hp <= 0) beginCollapse(boss)
  sim.hudTick++
  return { damage: amount, partId: part.id, broken: part.broken }
}

function breakPart(boss, part) {
  if (part.broken) return
  part.hp = 0; part.broken = true; part.state = 'broken'; part.brokenAt = sim.time
  addEffect({ kind: 'burst', x: part.world.x, y: part.world.y, z: part.world.z, radius: part.radius * 1.6, color: part.color || '#ffcf70', life: 1.2 })
  say(`${part.label}を破壊！`, 'boss')
  if (part.role === 'conduit') {
    const blast = Math.max(0.2, boss.visualHeight * 0.2)
    boss.hazards.push({ id: `backlash:${part.id}`, x: part.world.x, y: part.world.y, z: part.world.z, radius: blast, damage: 36, life: 1.2, hit: false, color: part.color })
    addEffect({ kind: 'telegraph', x: part.world.x, y: part.world.y, z: part.world.z, radius: blast, color: part.color, life: 1.2 })
    // The matching trophy turns the backlash into a readable safe response window.
    if (sim.player.items[part.reward]) { boss.nextAttackAt = Math.max(boss.nextAttackAt, sim.time + 2.8); say(`${part.label}の力を、獲得した証が押し返した！`, 'boss') }
  }
  if (part.role === 'arm') boss.nextAttackAt = Math.max(boss.nextAttackAt, sim.time + 2.2)
  if (part.role === 'crown') boss.nextAttackAt = Math.max(boss.nextAttackAt, sim.time + 3.2)
}

function beginDeath(boss) {
  setState(boss, 'death', 5); boss.anim = 'death'; boss.attack = null; boss.checkpoint = 'death'; sim.camera.profile = 'finalDeath'
  boss.hp = 0
  say('祭典終端巨人・ティウが崩れ落ちる——', 'boss')
}

function finishFinalBoss(boss) {
  boss.alive = false; boss.defeated = true; boss.state = 'defeated'; boss.phase = 5; boss.hp = 0
  sim.player.finalBossPlatform = null; sim.camera.profile = 'normal'
  stopMusic()
  if (isArenaLocked()) { unlockArena('clear'); resumeEnemies() }
  if (!boss.rewarded) { boss.rewarded = true; gainXp(1200); sim.player.gold += 800 }
  say('祭典終端巨人・ティウを撃破。四つの祭の光が町へ帰った。', 'boss')
}

export function restoreCheckpoint() {
  const boss = finalBoss()
  if (!boss.alive || boss.state === 'assembling' || boss.state === 'death') return false
  const wanted = boss.phase >= 4 ? ['chest', 'hips'] : boss.phase >= 2 ? ['foreArmL', 'foreArmR', 'hips'] : []
  const target = wanted.map((id) => boss.bodyById[id]).find((s) => s && !s.broken)
  if (target) mountPlayer(target.id)
  else {
    const p = nearestWalkable(boss.pos.x + 12, boss.pos.z)
    sim.player.pos.set(p.x, groundY(p.x, p.z), p.z)
    sim.player.finalBossPlatform = null
  }
  return true
}

// ───────────────────────────── HUD / セーブ

export function finalBossHud() {
  const boss = sim.finalBoss
  if (!boss?.alive) return null
  const body = finalBodyIntact()
  return {
    id: boss.id, label: boss.label, hp: boss.hp, maxHp: boss.maxHp, phase: boss.phase, color: boss.def.color,
    state: boss.state, objective: FINAL_PHASE_OBJECTIVES[boss.phase] || '',
    bodyIntact: body.intact, bodyTotal: body.total, regen: boss.regen,
    parts: Object.values(boss.parts).map((part) => ({ id: part.id, label: part.label, hp: Math.max(0, part.hp), maxHp: part.maxHp, state: part.state, color: part.color })),
  }
}

export function serializeFinalBoss() {
  const boss = finalBoss()
  return {
    spawned: boss.spawned, defeated: boss.defeated, firstSeen: boss.firstSeen, phase: boss.phase, state: boss.state,
    hp: boss.hp, checkpoint: boss.checkpoint, rewarded: !!boss.rewarded, regen: boss.regen,
    parts: Object.fromEntries(Object.values(boss.parts).map((part) => [part.id, { hp: part.hp, broken: part.broken, state: part.state }])),
    body: Object.fromEntries(boss.body.map((seg) => [seg.id, { hp: seg.hp, broken: seg.broken }])),
    // 小片は数が多いので、壊れているものの番号だけ持つ
    chunks: boss.chunks.filter((c) => c.broken).map((c) => c.id),
  }
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
    const savedState = data.state === 'death' ? 'death'
      : boss.phase >= 5 ? 'collapse' : boss.phase === 1 ? 'ground' : boss.phase === 2 ? 'mounted' : boss.phase === 3 ? 'blind' : 'core'
    setState(boss, savedState, boss.phase); boss.hp = Math.max(0, data.hp ?? boss.maxHp); boss.anim = savedState === 'death' ? 'death' : 'idle'
    boss.regen = data.regen ?? boss.phase < 5
    for (const [id, saved] of Object.entries(data.parts || {})) if (boss.parts[id]) Object.assign(boss.parts[id], { hp: Math.max(0, saved.hp ?? boss.parts[id].maxHp), broken: !!saved.broken, state: saved.state || (saved.broken ? 'broken' : 'intact') })
    for (const [id, saved] of Object.entries(data.body || {})) {
      const seg = boss.bodyById[id]
      if (!seg) continue
      seg.hp = Math.max(0, saved.hp ?? seg.maxHp); seg.broken = !!saved.broken
      seg.restoreAt = seg.broken ? (boss.regen ? sim.time + respawnDelay(boss) : Infinity) : 0
    }
    for (const id of data.chunks || []) {
      const chunk = boss.chunks[id]
      if (!chunk) continue
      chunk.broken = true
      chunk.hp = 0
      chunk.restoreAt = boss.regen ? sim.time + respawnDelay(boss) : Infinity
      chunkSink?.setBroken?.(chunk.id, true)
      const seg = chunk.segId != null ? boss.bodyById[chunk.segId] : null
      if (seg) { seg.chunkBroken++; refreshSegment(boss, seg) }
    }
    boss.collapseTotal = Math.max(1, finalBodyIntact().intact)
    boss.collapseHp = Math.max(1, boss.hp)
  }
}

export function resetFinalBoss() {
  if (isArenaLocked() && sim.arena?.bossId === 'boss:final') { unlockArena('abort'); resumeEnemies(0) }
  if (sim.finalBoss?.alive) stopMusic()
  sim.player.finalBossPlatform = null; sim.camera.profile = 'normal'; sim.finalBoss = makeFinalBoss()
}
