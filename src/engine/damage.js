/**
 * ダメージ適用。プレイヤー/敵の HP 減少、盾ブロック、ノックバック、
 * ひるみ、死亡とリスポーン予約をここで一手に扱う。
 */
import * as THREE from 'three'
import { resolveDamage } from './combat.js'
import { sim, say, floater, gainXp, addEffect, unlockEnemyChallenge } from './sim.js'
import { ELEMENTS } from '../data/enemies.js'
import { notifyKill } from './quests.js'
import { ITEMS } from '../data/quests.js'
import { ENEMY_BALANCE } from '../data/enemies.js'
import { spawnRagdoll } from './ragdoll.js'

const tmpDir = new THREE.Vector3()

const dirFrom = (target, source) => {
  tmpDir.set(source.x - target.pos.x, 0, source.z - target.pos.z)
  const len = tmpDir.length() || 1
  return { x: tmpDir.x / len, z: tmpDir.z / len }
}

/** 敵→プレイヤー */
export function damagePlayer(attackerState, attack, fromPos, mul = 1) {
  const p = sim.player
  if (p.dead || p.invuln > 0) return null
  const fromDir = dirFrom(p, fromPos)
  const r = resolveDamage({
    attacker: attackerState,
    defender: p,
    attack,
    fromDir,
    facing: p.yaw,
    mul,
  })

  p.hp -= r.damage
  p.hitFlash = 0.25
  sim.stats.damageTaken += r.damage

  if (r.blocked) {
    sim.stats.blocked++
    p.stamina -= p.blockStaminaPerHit
    floater(p.pos, `ガード ${r.damage}`, '#9fd8ff', 0.85)
    if (p.stamina <= 0) {
      // ガードブレイク: スタミナ切れで大きくひるむ
      p.stamina = 0
      p.blocking = false
      p.state = 'hit'
      p.stateTime = 0
      p.anim = 'hit'
      p.action = null
      say('スタミナが切れてガードが崩れた！', 'warn')
    }
  } else {
    floater(p.pos, `${r.damage}`, ELEMENTS[r.element]?.color || '#ff8080', r.fromBehind ? 1.25 : 1)
    // 連続ひるみ防止: 一度ひるんだら一定時間は仰け反らない
    if (r.stagger && p.state !== 'roll' && sim.time >= (p.staggerImmuneUntil ?? 0)) {
      p.staggerImmuneUntil = sim.time + ENEMY_BALANCE.staggerImmunity
      p.state = 'hit'
      p.stateTime = 0
      p.anim = 'hit'
      p.action = null
    }
  }

  // ノックバック(向きは攻撃が来た方向の逆)
  if (r.knockback > 0) {
    p.knockback.x += -fromDir.x * r.knockback
    p.knockback.z += -fromDir.z * r.knockback
  }
  if (attack.slow) {
    p.slow = attack.slow
    p.slowUntil = sim.time + 3
  }

  if (p.hp <= 0) killPlayer()
  sim.hudTick++
  return r
}

export function killPlayer() {
  const p = sim.player
  if (p.dead) return
  p.hp = 0
  p.dead = true
  p.deaths++
  p.state = 'dead'
  p.anim = 'death'
  p.stateTime = 0
  p.action = null
  p.blocking = false
  p.respawnTimer = 4.0
  sim.mode = 'dead'
  say('力尽きた……集会所前で目を覚ます。', 'death')
  // 敵はプレイヤーを見失う
  for (const e of sim.enemies) { e.aware = false; e.attack = null }
}

/** プレイヤー/敵→敵 */
export function damageEnemy(e, attackerState, attack, fromPos, mul = 1) {
  if (!e.alive || e.state === 'dead') return null
  const def = e.def
  const defender = {
    defense: def.stats.defense * e.mul,
    magicDefense: def.stats.magicDefense * e.mul,
    weakness: def.weakness,
    resist: e.barrier ? { ...def.resist, physical: (def.resist.physical || 0) + 0.4 } : def.resist,
    knockbackResist: def.stats.knockbackResist,
    staggerResist: def.stats.staggerResist,
    blocking: e.blocking,
    blockAngle: def.defense.guardAngle || 0,
    blockReduction: def.defense.blockReduction || 0.5,
  }
  const fromDir = dirFrom(e, fromPos)
  const r = resolveDamage({ attacker: attackerState, defender, attack, fromDir, facing: e.yaw, mul })

  // 回避(bunbetu 7 防御行動)
  if (!r.blocked && def.defense.dodgeChance > 0 && Math.random() < def.defense.dodgeChance && e.state !== 'windup') {
    floater(e.pos, '回避', '#cfe8ff', 0.8)
    e.state = 'dodge'
    e.stateTime = 0
    e.anim = 'roll'
    return null
  }

  e.hp -= r.damage
  e.hitFlash = 0.22
  // ラグドールへ渡すため、最後に受けた攻撃の位置・方向・威力を覚えておく
  e.lastHit = {
    x: fromPos.x, y: fromPos.y ?? e.pos.y + 1.0, z: fromPos.z,
    dirX: -fromDir.x, dirY: 0.35, dirZ: -fromDir.z,
    power: r.damage + (attack.knockback ?? 0) * 6,
    explosion: attack.kind === 'aoe' || attack.kind === 'heavy',
  }
  sim.stats.damageDealt += r.damage
  e.aware = true
  e.lastSeen = sim.time

  const weak = (def.weakness[attack.element] || 0) > 0
  floater(e.pos, `${r.damage}${weak ? ' 弱点!' : ''}`, r.blocked ? '#9fd8ff' : weak ? '#ffe66b' : '#ffffff', weak ? 1.2 : 1)

  if (r.knockback > 0) {
    e.vel.x += -fromDir.x * r.knockback * 2
    e.vel.z += -fromDir.z * r.knockback * 2
  }
  if (r.stagger && e.state !== 'dead') {
    e.state = 'stagger'
    e.stateTime = 0
    e.anim = 'hit'
    e.attack = null
  }

  // 仲間が攻撃されると参戦する(bunbetu 4)
  for (const other of sim.enemies) {
    if (other === e || !other.alive || other.state === 'dead') continue
    if (!other.def.ai.joinAllyFight) continue
    if (other.pos.distanceTo(e.pos) <= def.senses.alertShareRadius) {
      if (!other.aware) other.aware = true
      other.lastSeen = sim.time
    }
  }

  if (e.hp <= 0) killEnemy(e)
  sim.hudTick++
  return r
}

export function killEnemy(e) {
  if (e.state === 'dead') return
  e.hp = 0
  e.state = 'dead'
  e.stateTime = 0
  e.anim = 'death'
  e.attack = null
  e.blocking = false
  e.vel.set(0, 0, 0)
  e.deaths++

  const drops = e.def.drops
  const xp = Math.round(drops.xp * e.mul)
  const gold = Math.round(drops.gold * e.mul)
  gainXp(xp)
  sim.player.gold += gold
  sim.player.kills[e.typeId] = (sim.player.kills[e.typeId] || 0) + 1
  unlockEnemyChallenge()
  floater(e.pos, `+${xp} EXP`, '#a8ff9f', 1.1)

  for (const item of drops.items || []) {
    if (Math.random() <= item.chance) {
      sim.player.items[item.id] = (sim.player.items[item.id] || 0) + 1
      say(`${ITEMS[item.id]?.label || item.label} を手に入れた。`, 'loot')
    }
  }
  say(`${e.label} を倒した！（+${xp}EXP / +${gold}✦）`, 'kill')
  addEffect({ kind: 'burst', x: e.pos.x, y: e.pos.y + 0.9, z: e.pos.z, color: e.def.look.color, radius: 1.4, life: 0.6 })
  notifyKill(e.typeId)
  // 通常アニメーション → 物理ラグドールへ切り替える（報酬処理はこの上で完了済み）
  spawnRagdoll(e, e.lastHit)
}
