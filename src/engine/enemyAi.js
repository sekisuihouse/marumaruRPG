/**
 * 敵AI。src/data/enemies.js の定義だけを読んで動く汎用ステートマシン。
 *
 * 状態遷移:
 *   idle(巡回/生活行動) ─視認/被弾→ chase ─間合い→ combat
 *   combat ─攻撃選択→ windup(予備動作) → 実行 → recover → combat
 *   被弾 → stagger(ひるみ) / dodge(回避)
 *   HP低下 → flee(逃走) または enrage(狂暴化)
 *   HP0 → dead → 一定時間後にリスポーン
 */
import * as THREE from 'three'
import { sim, spawnEnemy, canSpawnNow, addProjectile, addEffect, floater, say } from './sim.js'
import { move, groundY, hasLineOfSight, randomPointNear } from './nav.js'
import { damagePlayer } from './damage.js'
import { inAttackArc } from './combat.js'
import { ENEMY_BALANCE, enemyAttackMul, enemyIntervalMul, enemyWindupMul } from '../data/enemies.js'
import { removeRagdoll } from './ragdoll.js'

const RESPAWN_MIN = 24
const RESPAWN_MAX = 44
/** ラグドールを見せるため、死亡から退場までを少し長く取る */
const DEATH_LINGER = 3.5

const angleTo = (fromYaw, dx, dz) => {
  const a = Math.atan2(dx, dz) - fromYaw
  return Math.abs(Math.atan2(Math.sin(a), Math.cos(a)))
}

const turnToward = (e, dx, dz, dt, rate = 7) => {
  const want = Math.atan2(dx, dz)
  let diff = want - e.yaw
  diff = Math.atan2(Math.sin(diff), Math.cos(diff))
  e.yaw += THREE.MathUtils.clamp(diff, -rate * dt, rate * dt)
}

/** 攻撃側のステータス(個体差と狂暴化を反映) */
const attackerStateOf = (e) => {
  const nerf = enemyAttackMul(e.def)
  return {
    attack: e.def.stats.attack * e.mul * nerf,
    magicAttack: e.def.stats.magicAttack * e.mul * nerf,
    buff: e.buff,
  }
}

/** 同時に積極攻撃している敵の数（攻撃モーション中の敵） */
function aggressiveCount(except) {
  let n = 0
  for (const o of sim.enemies) {
    if (o === except || !o.alive || o.state === 'dead') continue
    if (o.attack) n++
  }
  return n
}

const enrageMul = (e, key) => (e.enraged ? (e.def.phases.enrage?.[key] ?? 1) : 1)

export function updateEnemies(dt) {
  for (const e of sim.enemies) updateEnemy(e, dt)
}

function updateEnemy(e, dt) {
  const t = sim.time
  const def = e.def
  const p = sim.player

  if (!e.alive) {
    // ボス戦の封鎖中は通常の敵を出さない（ボスに集中させる）
    if (sim.arena?.active) return
    const initialSlotEnabled = sim.enemyChallengeUnlocked || e.spawnSlot % 2 === 0
    if (t >= e.respawnAt && initialSlotEnabled && canSpawnNow(def)) spawnEnemy(e)
    return
  }

  e.stateTime += dt
  if (e.hitFlash > 0) e.hitFlash = Math.max(0, e.hitFlash - dt)
  if (e.buff && t > e.buff.until) e.buff = null
  if (t > e.slowUntil) e.slow = 0

  // ── 死亡: 死亡モーションを見せてから退場し、リスポーンを予約
  if (e.state === 'dead') {
    e.anim = 'death'
    if (e.stateTime > DEATH_LINGER) {
      e.alive = false
      e.respawnAt = t + RESPAWN_MIN + Math.random() * (RESPAWN_MAX - RESPAWN_MIN)
      removeRagdoll(e.id)
    }
    return
  }

  // ── ノックバック等の速度を反映(壁ずり付き)
  applyVelocity(e, dt)

  const dx = p.pos.x - e.pos.x
  const dz = p.pos.z - e.pos.z
  const dist = Math.hypot(dx, dz)

  updatePerception(e, dt, dx, dz, dist)
  updatePhase(e)

  // ── ひるみ / 回避中は行動しない
  if (e.state === 'stagger') {
    e.anim = 'hit'
    if (e.stateTime > 0.55) setState(e, e.aware ? 'chase' : 'idle')
    return
  }
  if (e.state === 'dodge') {
    e.anim = 'roll'
    const away = 1
    stepMove(e, -(dx / (dist || 1)) * away, -(dz / (dist || 1)) * away, def.stats.runSpeed * 1.1, dt)
    if (e.stateTime > 0.45) setState(e, 'chase')
    return
  }

  // ── 攻撃モーション進行中
  if (e.attack) {
    runAttack(e, dt, dx, dz, dist)
    return
  }

  // ── 逃走(bunbetu 4: HPが減ると逃げる)
  if (e.fleeing) {
    e.anim = 'run'
    e.blocking = false
    // 逃げ切ったら少し回復して戦線復帰。ただし最低1.5秒は逃げること
    if (dist > def.senses.giveUpDistance * 0.9 && sim.time - (e.fleeSince ?? 0) > 1.5) {
      e.fleeing = false
      e.hp = Math.min(e.maxHp, e.hp + e.maxHp * 0.25)
      e.aware = false
      setState(e, 'idle')
      return
    }
    const away = dist || 1
    stepMove(e, -dx / away, -dz / away, def.stats.runSpeed * 1.05, dt)
    turnToward(e, -dx, -dz, dt)
    return
  }

  if (!e.aware) {
    idleBehaviour(e, dt)
    return
  }

  combatBehaviour(e, dt, dx, dz, dist)
}

// ───────────────────────────── 感知 (bunbetu 5)

function updatePerception(e, dt, dx, dz, dist) {
  const def = e.def
  const s = def.senses
  const p = sim.player
  const t = sim.time

  if (p.dead) {
    e.aware = false
    return
  }

  const withinSight = dist <= s.sightRange && angleTo(e.yaw, dx, dz) <= (s.fov / 2) * (Math.PI / 180)
  const los = withinSight && hasLineOfSight(e.pos.x, e.pos.z, p.pos.x, p.pos.z)
  // 音に反応する: 走っている/攻撃したプレイヤーは聴覚範囲で気づかれる
  const noisy = p.running || p.state === 'attack'
  const heard = noisy && dist <= s.hearing

  if (los || heard) {
    if (!e.aware) {
      e.aware = true
      // 発見時に周囲の仲間へ共有(bunbetu 5 警戒情報共有)
      for (const other of sim.enemies) {
        if (other === e || !other.alive || other.state === 'dead' || other.aware) continue
        if (other.pos.distanceTo(e.pos) <= s.alertShareRadius) { other.aware = true; other.lastSeen = t }
      }
    }
    e.lastSeen = t
  }

  if (e.aware) {
    if (dist > s.giveUpDistance) e.aware = false           // 追跡を諦める距離
    else if (t - e.lastSeen > s.loseSightTime) e.aware = false // 見失うまでの時間
  }
}

// ───────────────────────────── 戦闘フェーズ (bunbetu 10)

function updatePhase(e) {
  const def = e.def
  const ratio = e.hp / e.maxHp

  if (def.ai.enrageAtHp && !e.enraged && ratio <= def.ai.enrageAtHp) {
    e.enraged = true
    floater(e.pos, '狂暴化！', '#ff6b4a', 1.3)
    say(`${e.label} が狂暴化した！`, 'warn')
    addEffect({ kind: 'burst', x: e.pos.x, y: e.pos.y + 1, z: e.pos.z, color: '#ff6b4a', radius: 1.8, life: 0.7 })
  }
  if (def.defense.barrierAtHp && !e.barrier && ratio <= def.defense.barrierAtHp) {
    e.barrier = true
    floater(e.pos, 'バリア', '#9fd8ff', 1.1)
  }
  const wantFlee = def.ai.fleeAtHp > 0 && ratio <= def.ai.fleeAtHp
  if (wantFlee && !e.fleeing) {
    e.fleeing = true
    e.fleeSince = sim.time
    say(`${e.label} は逃げ出した！`, 'info')
  }
  if (def.ai.callAlliesAtHp && !e.calledAllies && ratio <= def.ai.callAlliesAtHp) {
    e.calledAllies = true
    let called = 0
    for (const other of sim.enemies) {
      if (other === e || !other.alive || other.state === 'dead' || other.aware) continue
      if (other.pos.distanceTo(e.pos) <= e.def.senses.alertShareRadius * 1.4) { other.aware = true; other.lastSeen = sim.time; called++ }
    }
    if (called) {
      floater(e.pos, '援軍！', '#ffd166', 1.2)
      say(`${e.label} が仲間を呼んだ（${called}体）`, 'warn')
    }
  }
}

// ───────────────────────────── 非戦闘時の行動 (bunbetu 15)

function idleBehaviour(e, dt) {
  const def = e.def
  e.blocking = false
  switch (def.ai.idleBehaviour) {
    case 'guard':
      e.anim = 'idle_sword'
      turnToward(e, Math.sin(sim.time * 0.3 + e.idleSeed), Math.cos(sim.time * 0.3 + e.idleSeed), dt, 0.6)
      break
    case 'work':
      e.anim = e.stateTime % 6 < 3 ? 'interact' : 'idle'
      break
    case 'stargaze':
      e.anim = 'idle'
      break
    case 'patrol':
    default: {
      // 巡回: 拠点周辺のランダム地点へ歩く
      if (!e.patrol || e.patrolWait > 0) {
        e.patrolWait -= dt
        e.anim = 'idle'
        if (e.patrolWait <= 0) {
          const p = randomPointNear(e.home.x, e.home.z, def.spawn.radius || 10)
          e.patrol = p
        }
        break
      }
      const dx = e.patrol.x - e.pos.x
      const dz = e.patrol.z - e.pos.z
      const d = Math.hypot(dx, dz)
      if (d < 0.7) {
        e.patrol = null
        e.patrolWait = 1.5 + Math.random() * 3.5
        e.anim = 'idle'
        break
      }
      e.anim = 'walk'
      const res = stepMove(e, dx / d, dz / d, def.stats.walkSpeed, dt)
      turnToward(e, dx, dz, dt, 3)
      if (res.hit) { e.patrol = null; e.patrolWait = 0.4 }
      break
    }
  }
}

// ───────────────────────────── 戦闘行動 (bunbetu 4 / 11)

function combatBehaviour(e, dt, dx, dz, dist) {
  const def = e.def
  const t = sim.time
  const [minR, maxR] = def.ai.preferredRange
  const speedMul = enrageMul(e, 'speed') * (e.buff?.speed ?? 1) * (1 - e.slow)

  turnToward(e, dx, dz, dt, 6)

  // タンクは盾を構える(bunbetu 7 ガード)
  if (def.defense.blockChance > 0 && dist < 5.5) {
    if (e.blockUntil === undefined) e.blockUntil = 0
    if (t > e.blockUntil && t > (e.blockCheck || 0)) {
      e.blockCheck = t + 1.4
      if (Math.random() < def.defense.blockChance) e.blockUntil = t + 0.9
    }
    e.blocking = t < e.blockUntil
  } else e.blocking = false

  // 攻撃するか(攻撃間隔 = bunbetu 1)
  const interval = def.stats.attackInterval * enrageMul(e, 'interval') * enemyIntervalMul(def)
  // 同時に攻撃してくる敵の数を制限して、囲まれても捌けるようにする
  const crowded = aggressiveCount(e) >= ENEMY_BALANCE.maxAggressive
  if (t >= (e.nextAttackAt || 0) && !crowded) {
    const atk = chooseAttack(e, dist)
    if (atk) { beginAttack(e, atk, dist); return }
  }
  if (crowded) e.nextAttackAt = Math.max(e.nextAttackAt || 0, t + 0.25)

  // 間合い調整
  const dirX = dx / (dist || 1)
  const dirZ = dz / (dist || 1)
  let mx = 0, mz = 0
  let anim = 'idle'
  let speed = def.stats.walkSpeed

  if (dist > maxR) {
    // 接近。回り込み(flank)があれば少し斜めに寄る
    const flank = def.ai.flank || 0
    const side = e.flankSide ?? (e.flankSide = Math.random() < 0.5 ? -1 : 1)
    const a = Math.atan2(dirX, dirZ) + side * flank * 0.9
    mx = Math.sin(a); mz = Math.cos(a)
    anim = dist > maxR + 2 ? 'run' : 'walk'
    speed = dist > maxR + 2 ? def.stats.runSpeed : def.stats.walkSpeed
  } else if (dist < minR) {
    // 近すぎるので後退(距離を取りながら戦う)
    mx = -dirX; mz = -dirZ
    anim = 'walk'
    speed = def.stats.walkSpeed * 1.1
  } else if (def.ai.strafe > 0) {
    // 横移動で囲む
    const side = e.strafeSide ?? (e.strafeSide = Math.random() < 0.5 ? -1 : 1)
    mx = -dirZ * side; mz = dirX * side
    anim = 'walk'
    speed = def.stats.walkSpeed * def.ai.strafe
    if (Math.random() < dt * 0.35) e.strafeSide = -side
  }

  // 味方と重ならないよう分離(プレイヤーを囲む挙動になる)
  for (const other of sim.enemies) {
    if (other === e || !other.alive || other.state === 'dead') continue
    const ox = e.pos.x - other.pos.x
    const oz = e.pos.z - other.pos.z
    const od = Math.hypot(ox, oz)
    const want = (def.stats.hitRadius + other.def.stats.hitRadius) * 1.9
    if (od < want && od > 0.001) {
      mx += (ox / od) * (1 - od / want) * 1.4
      mz += (oz / od) * (1 - od / want) * 1.4
    }
  }

  const len = Math.hypot(mx, mz)
  if (len > 0.01) {
    const res = stepMove(e, mx / len, mz / len, speed * speedMul, dt)
    e.anim = anim
    if (res.hit) {
      // 壁に詰まって間合いを取れない状態。射手が棒立ちにならないよう記録する
      e.cornered = t
      if (anim !== 'idle') e.strafeSide = -(e.strafeSide ?? 1)
    }
  } else {
    e.anim = e.blocking ? 'idle_sword' : 'idle'
  }
  void interval
}

/** 使える攻撃を選ぶ。距離・クールダウン・役割条件で絞る。 */
function chooseAttack(e, dist) {
  const t = sim.time
  // 壁際で下がれないときは最低射程を無視して撃つ(遠距離型が無抵抗にならないように)
  const cornered = t - (e.cornered ?? -99) < 0.5
  const ready = []
  for (const atk of e.def.attacks) {
    if ((e.cooldowns[atk.id] || 0) > t) continue
    const [lo, hi] = atk.range
    if (dist > hi) continue
    if (dist < lo && !(cornered && atk.kind !== 'charge')) continue

    // 役割ごとの発動条件
    if (atk.kind === 'heal') {
      const hurt = sim.enemies.filter((o) => o.alive && o.state !== 'dead' && o.hp / o.maxHp < (atk.allyHpBelow ?? 0.75) && o.pos.distanceTo(e.pos) <= atk.radius)
      if (!hurt.length) continue
    }
    if (atk.kind === 'buff') {
      const allies = sim.enemies.filter((o) => o !== e && o.alive && o.state !== 'dead' && !o.buff && o.pos.distanceTo(e.pos) <= atk.radius)
      if (!allies.length) continue
    }
    if (atk.kind === 'trap' && sim.effects.some((f) => f.kind === 'trap' && f.ownerId === e.id)) continue
    if (atk.kind === 'arrow' || atk.kind === 'magic' || atk.kind === 'aoe') {
      if (!hasLineOfSight(e.pos.x, e.pos.z, sim.player.pos.x, sim.player.pos.z)) continue
    }
    ready.push(atk)
  }
  if (!ready.length) return null
  // 基本は威力の高いものを選び、ときどきランダムにして単調さを避ける
  if (Math.random() < 0.35) return ready[Math.floor(Math.random() * ready.length)]
  return ready.reduce((a, b) => ((b.power ?? 0) > (a.power ?? 0) ? b : a))
}

function beginAttack(e, atk, dist) {
  // 攻撃予告（予備動作）を少し長くして反応しやすくする
  const windup = atk.windup * enemyWindupMul(e.def)
  e.attack = { def: atk, phase: 'windup', timer: windup, windup, center: null }
  e.anim = atk.clip || 'attack'
  e.animSpeed = 1
  e.blocking = false
  setState(e, 'windup')
  e.nextAttackAt = sim.time + e.def.stats.attackInterval * enrageMul(e, 'interval') * enemyIntervalMul(e.def)

  // 範囲魔法は着弾点を予告表示(プレイヤーが避けられるようにする)
  if (atk.kind === 'aoe') {
    const p = sim.player.pos
    e.attack.center = { x: p.x, z: p.z }
    addEffect({
      kind: 'telegraph', x: p.x, y: groundY(p.x, p.z) + 0.05, z: p.z,
      radius: atk.radius, life: windup, color: '#ffe14c',
    })
  }
  if (atk.kind === 'charge') {
    e.attack.chargeDir = { x: Math.sin(e.yaw), z: Math.cos(e.yaw) }
  }
  void dist
}

function runAttack(e, dt, dx, dz, dist) {
  const a = e.attack
  const atk = a.def
  a.timer -= dt

  if (a.phase === 'windup') {
    // 予備動作中も少しだけ狙いを追う(突進は方向を固定)
    if (atk.kind !== 'charge') turnToward(e, dx, dz, dt, 3.5)
    else a.chargeDir = { x: Math.sin(e.yaw), z: Math.cos(e.yaw) }
    if (a.timer <= 0) {
      executeAttack(e, atk, dist)
      a.phase = atk.kind === 'charge' ? 'charge' : 'recover'
      a.timer = atk.kind === 'charge' ? 0.55 : atk.recover
      if (atk.kind === 'charge') e.anim = 'run'
    }
    return
  }

  if (a.phase === 'charge') {
    // 突進中: 当たり判定を毎フレーム見る
    const res = stepMove(e, a.chargeDir.x, a.chargeDir.z, atk.chargeSpeed || 11, dt)
    if (!a.hit && dist < e.def.stats.hitRadius + sim.player.hitRadius + 1.1) {
      a.hit = true
      damagePlayer(attackerStateOf(e), atk, e.pos, enrageMul(e, 'attack'))
      addEffect({ kind: 'impact', x: sim.player.pos.x, y: sim.player.pos.y + 1, z: sim.player.pos.z, color: '#ffd166', radius: 0.9, life: 0.3 })
    }
    if (a.timer <= 0 || res.hit) {
      a.phase = 'recover'
      a.timer = atk.recover
      e.anim = 'idle'
    }
    return
  }

  // recover
  e.anim = e.blocking ? 'idle_sword' : 'idle'
  if (a.timer <= 0) {
    e.cooldowns[atk.id] = sim.time + atk.cooldown
    e.attack = null
    setState(e, e.aware ? 'chase' : 'idle')
  }
}

function executeAttack(e, atk, dist) {
  const p = sim.player
  const state = attackerStateOf(e)
  const mul = enrageMul(e, 'attack')
  const from = { x: e.pos.x, z: e.pos.z }

  switch (atk.kind) {
    case 'melee':
    case 'heavy': {
      const reach = atk.range[1] + p.hitRadius
      if (inAttackArc(e.pos.x, e.pos.z, e.yaw, p.pos.x, p.pos.z, reach, 140)) {
        damagePlayer(state, atk, from, mul)
      }
      addEffect({ kind: 'slash', x: e.pos.x + Math.sin(e.yaw) * 1.1, y: e.pos.y + 1.1, z: e.pos.z + Math.cos(e.yaw) * 1.1, color: atk.unblockable ? '#ff6b4a' : '#ffffff', radius: 0.9, life: 0.22 })
      break
    }
    case 'arrow':
    case 'magic': {
      // 弾速から着弾までを見越して少し先を狙う
      const speed = atk.speed || 20
      const flight = dist / speed
      const tx = p.pos.x + p.vel.x * flight * 0.55
      const tz = p.pos.z + p.vel.z * flight * 0.55
      const ox = e.pos.x + Math.sin(e.yaw) * 0.5
      const oz = e.pos.z + Math.cos(e.yaw) * 0.5
      const len = Math.hypot(tx - ox, tz - oz) || 1
      addProjectile({
        kind: atk.kind, owner: 'enemy', ownerId: e.id, attack: atk, mul,
        attacker: state,
        x: ox, y: e.pos.y + 1.25, z: oz,
        dx: (tx - ox) / len, dz: (tz - oz) / len,
        speed, color: atk.kind === 'arrow' ? '#ffd267' : (atk.element === 'ice' ? '#a5e9ff' : '#ffe14c'),
        radius: atk.kind === 'arrow' ? 0.18 : 0.3,
        life: 3.2,
      })
      break
    }
    case 'aoe': {
      const c = e.attack.center || { x: p.pos.x, z: p.pos.z }
      addEffect({ kind: 'aoe', x: c.x, y: groundY(c.x, c.z) + 0.1, z: c.z, radius: atk.radius, color: '#ffe14c', life: 0.5 })
      if (Math.hypot(p.pos.x - c.x, p.pos.z - c.z) <= atk.radius) {
        damagePlayer(state, atk, c, mul)
      } else {
        floater(p.pos, '回避成功', '#a8ff9f', 0.9)
      }
      break
    }
    case 'heal': {
      let healed = 0
      for (const o of sim.enemies) {
        if (!o.alive || o.state === 'dead') continue
        if (o.pos.distanceTo(e.pos) > atk.radius) continue
        if (o.hp >= o.maxHp) continue
        const amount = Math.round(atk.power * e.mul)
        o.hp = Math.min(o.maxHp, o.hp + amount)
        floater(o.pos, `+${amount}`, '#a8ff9f', 1)
        healed++
      }
      addEffect({ kind: 'ring', x: e.pos.x, y: e.pos.y + 0.1, z: e.pos.z, radius: atk.radius, color: '#a8ff9f', life: 0.8 })
      if (healed) say(`${e.label} が仲間を回復した（${healed}体）`, 'warn')
      break
    }
    case 'buff': {
      let n = 0
      for (const o of sim.enemies) {
        if (!o.alive || o.state === 'dead' || o === e) continue
        if (o.pos.distanceTo(e.pos) > atk.radius) continue
        o.buff = { attack: atk.buff.attack, speed: atk.buff.speed, until: sim.time + atk.buff.duration }
        floater(o.pos, '強化', '#ffd166', 0.95)
        n++
      }
      addEffect({ kind: 'ring', x: e.pos.x, y: e.pos.y + 0.1, z: e.pos.z, radius: atk.radius, color: '#ffd166', life: 0.9 })
      if (n) say(`${e.label} の号令で仲間が強化された（${n}体）`, 'warn')
      break
    }
    case 'trap': {
      const tx = p.pos.x, tz = p.pos.z
      addEffect({
        kind: 'trap', ownerId: e.id, x: tx, y: groundY(tx, tz) + 0.06, z: tz,
        radius: atk.radius, color: '#e27d35', life: atk.life || 20,
        attack: atk, attacker: state, mul,
      })
      say(`${e.label} が罠を設置した。`, 'warn')
      break
    }
    default:
      break
  }
}

// ───────────────────────────── 移動ヘルパー

function setState(e, state) {
  if (e.state === state) return
  e.state = state
  e.stateTime = 0
}

/** 単位方向 + 速度で1フレーム動かす(NavMeshで壁ずり) */
function stepMove(e, dirX, dirZ, speed, dt) {
  const res = move(e.pos.x, e.pos.z, dirX * speed * dt, dirZ * speed * dt, e.def.stats.hitRadius)
  e.pos.x = res.x
  e.pos.z = res.z
  e.pos.y = groundY(res.x, res.z, e.pos.y)
  return res
}

/** ノックバック速度の減衰と反映 */
function applyVelocity(e, dt) {
  if (e.vel.lengthSq() < 0.0004) { e.vel.set(0, 0, 0); return }
  const res = move(e.pos.x, e.pos.z, e.vel.x * dt, e.vel.z * dt, e.def.stats.hitRadius)
  e.pos.x = res.x
  e.pos.z = res.z
  e.pos.y = groundY(res.x, res.z, e.pos.y)
  e.vel.multiplyScalar(Math.max(0, 1 - dt * 7))
}
