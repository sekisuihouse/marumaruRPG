/**
 * 1フレーム分のシミュレーション。描画コンポーネントからは
 * <SimDriver/> が1回だけ呼び、更新順を固定する。
 *
 *   入力 → プレイヤー → 敵AI → 弾 → エフェクト → クエスト → HUD配信
 */
import * as THREE from 'three'
import { sim, publishHud, say, floater, addEffect, addProjectile, resetPlayer, isNight, CAMERA_HOME_PITCH } from './sim.js'
import { actionActive, endFrame, isHeld, mouse, moveAxis, wasPressed } from './input.js'
import { move, groundY, isWalkable, findLandmark, nearestWalkable } from './nav.js'
import { PLAYER_ATTACKS } from '../data/enemies.js'
import { damageEnemy, damagePlayer } from './damage.js'
import { damageBoss } from './bosses.js'
import { updateEnemies } from './enemyAi.js'
import { updateQuests, openDialogue, closeDialogue, chooseDialogue } from './quests.js'
import { NPCS } from '../data/quests.js'
import { saveGame } from './save.js'
import { damageTarget, explode } from './targets.js'
import { updateDestruct, isInsideStructure } from './destruct.js'
import { updateBosses } from './bosses.js'
import { damageFinalBossAt, detachMountedPlayer, finalBossFooting, finalBossMounted, recoverFinalBossFall, updateFinalBoss, updateMountedPlayer } from './finalBoss.js'
import { updateDebris } from './debris.js'
import { updateRagdolls } from './ragdoll.js'
import { updateJuice, timeScale } from './juice.js'
import { updateFireStream, fireBlast } from './firestream.js'
import { updateWeb, updateFreeFall, tryWebAttach, webRelease, isSwinging, isWebAirborne, aimDirection } from './webswing.js'
import { isGuest, tickMultiplayer, requestAttack } from '../net/hostAuthority.js'
import { multiplayer } from '../net/multiplayerStore.js'
import { DEBUG_PROP_SHOT_ASSETS, DEBUG_PROP_SHOT_ATTACK, DEBUG_PROP_SHOT_MAX_ACTIVE } from '../data/debugPropShot.js'

const COMBO_MUL = [1, 1.12, 1.4]
const HUD_INTERVAL = 1 / 12
let hudTimer = 0

/** NPCをランドマークの入口に配置する */
export function initNpcs() {
  sim.npcs = NPCS.map((def) => {
    const lm = findLandmark(def.at)
    const base = lm ? lm.entry : { x: 0, z: 0 }
    const p = nearestWalkable(base.x, base.z)
    return {
      id: def.id,
      name: def.name,
      model: def.model,
      role: def.role,
      def,
      pos: new THREE.Vector3(p.x, groundY(p.x, p.z), p.z),
      yaw: Math.random() * Math.PI * 2,
      anim: def.idle || 'idle',
    }
  })
}

export function stepSim(rawDt) {
  // 非表示タブ用の保険(src/net/keepalive.js)が「描画フレームが来ているか」を見るための刻印
  if (typeof performance !== 'undefined') sim.lastStepAt = performance.now()
  let dt = Math.min(rawDt, 1 / 20)   // タブ復帰時の巨大な dt でワープしないよう制限
  updateJuice(dt)
  // ヒットストップ・スローモーションはここで時間を縮める（入力とカメラは等速のまま）
  dt *= timeScale()
  // BOSS FORGE の再生制御。編集中だけ効き、通常プレイには影響しない。
  const forge = sim.bossForge
  if (forge && !forge.combat) {
    if (forge.stepOnce) { dt = 1 / 60; forge.stepOnce = false }
    else dt *= Number.isFinite(forge.timeScale) ? forge.timeScale : 1
  }
  if (dt < 1e-6) dt = 1e-6
  sim.time += dt

  // 開発用の可視化は公開版の入力から完全に外す。
  if (typeof import.meta.env !== 'undefined' && import.meta.env.DEV && wasPressed('debug')) sim.debugDraw = !sim.debugDraw

  // 時間帯(bunbetu 13 出現条件に使う)
  const wasNight = isNight()
  sim.dayTime = (sim.dayTime + dt / sim.dayLength) % 1
  if (isNight() !== wasNight) say(isNight() ? '日が暮れた。夜の敵が現れる。' : '夜が明けた。', 'info')

  updateCamera(dt)

  if (sim.mode === 'dialogue') {
    handleDialogueInput()
    updateFloaters(dt)
    endFrame()
    publishThrottled(dt)
    return
  }

  if (!sim.paused) {
    updatePlayer(dt)
    // オフラインとホストだけがAIを決定する。ホスト設定で無効にした群は更新しない。
    if (!isGuest()) {
      if (multiplayer.role === 'offline' || multiplayer.settings.enemies) updateEnemies(dt)
      if (multiplayer.role === 'offline' || multiplayer.settings.bosses) updateBosses(dt)
      if (multiplayer.role === 'offline' || multiplayer.settings.bosses) updateFinalBoss(dt)
    }
    updateProjectiles(dt)
    updateEffects(dt)
    updateDestruct(dt)
    updateDebris(dt, onDebrisContact)
    updateRagdolls(dt)
    updateQuests()
    tickMultiplayer(dt)
  }
  updateFloaters(dt)
  updateNpcs(dt)

  // オートセーブ
  if (sim.time - sim.autosaveAt > 25 && !sim.player.dead) {
    sim.autosaveAt = sim.time
    saveGame(true)
  }

  endFrame()
  publishThrottled(dt)
}

function publishThrottled(dt) {
  hudTimer += dt
  if (hudTimer >= HUD_INTERVAL) {
    hudTimer = 0
    publishHud()
  }
}

// ───────────────────────────── カメラ(三人称)

/** 歩いている間に定位置へ戻る速さ(1/秒)。大きいほど強く引き戻す。 */
const CAMERA_RECENTER = 2.2
/** 最後に視点を動かしてから、この秒数は自動で戻さない。 */
const CAMERA_LOOK_GRACE = 0.35

function updateCamera(dt) {
  const c = sim.camera
  if (mouse.dx || mouse.dy) c.lookedAt = sim.time
  if (mouse.dx) c.yaw -= mouse.dx * 0.005
  if (mouse.dy) c.pitch += mouse.dy * 0.004 * (sim.settings.invertY ? -1 : 1)
  if (mouse.wheel) c.dist += mouse.wheel * 0.9
  // BOSS FORGE のプレビューは大きなボスを丸ごと見たいので、可動域を広げる
  const preview = sim.bossForge && !sim.bossForge.combat
  // 見上げ側(負)はほぼ真上まで開ける。巨大な最終ボスを首だけで見上げられるようにする。
  // 実際にカメラが地面へ潜らないよう、急角度では ThirdPersonCamera が距離を詰める。
  c.pitch = THREE.MathUtils.clamp(c.pitch, preview ? -1.45 : -1.42, preview ? 1.4 : 1.15)
  const profile = preview ? [1.5, 80] : c.profile === 'finalGround' ? [2.5, 6] : c.profile === 'finalMounted' ? [1, 3.5] : c.profile === 'finalCore' ? [1, 3] : c.profile === 'finalDeath' ? [2, 5] : [3.5, 16]
  c.dist = THREE.MathUtils.clamp(c.dist, profile[0], profile[1])

  // 基本は主人公の後ろ上から見る三人称。見回しは一時的に効き、
  // 歩き出すと自動でこの定位置へ戻る。指・マウスを動かしている間は割り込まない。
  const p = sim.player
  const looking = sim.time - (c.lookedAt ?? -99) < CAMERA_LOOK_GRACE
  if (!preview && !p.dead && !looking && p.moveSpeed > 0.4) {
    const want = p.yaw + Math.PI            // カメラは主人公の背後に回る
    const diff = Math.atan2(Math.sin(want - c.yaw), Math.cos(want - c.yaw))
    const k = Math.min(1, dt * CAMERA_RECENTER)
    c.yaw += diff * k
    c.pitch += (CAMERA_HOME_PITCH - c.pitch) * k
  }
}

/** カメラを主人公の後ろ上へ即座に置き直す（開始・復活時）。 */
export function resetCameraBehindPlayer() {
  const c = sim.camera
  c.yaw = sim.player.yaw + Math.PI
  c.pitch = CAMERA_HOME_PITCH
  c.lookedAt = -99
}

// ───────────────────────────── プレイヤー

function updatePlayer(dt) {
  const p = sim.player
  const t = sim.time

  if (p.hitFlash > 0) p.hitFlash = Math.max(0, p.hitFlash - dt)
  if (p.invuln > 0) p.invuln = Math.max(0, p.invuln - dt)
  if (t > p.slowUntil) p.slow = 0
  p.stateTime += dt

  // 死亡・リスポーン
  if (p.dead) {
    p.anim = 'death'
    p.respawnTimer -= dt
    if (p.respawnTimer <= 0) {
      resetPlayer(true)
      sim.mode = 'play'
      say('復活した。装備も経験値もそのままだ。', 'info')
      publishHud()
    }
    return
  }

  // 回復・スタミナ
  p.mp = Math.min(p.maxMp, p.mp + dt * 2.6)
  const staminaRate = p.running ? -14 : p.blocking ? 3 : 16
  p.stamina = THREE.MathUtils.clamp(p.stamina + dt * staminaRate, 0, p.maxStamina)

  // 盾(押している間)
  const wantSprint = actionActive('sprint', sim.settings.sprintMode === 'toggle')
  const wantBlock = actionActive('guard', sim.settings.guardMode === 'toggle') && p.stamina > 2 && !p.action && p.state !== 'roll'
  p.blocking = wantBlock
  if (p.blocking) p.tutorialActions.block = true

  // 攻撃入力
  handleAttackInput()
  if (sim.debugMode && wasPressed('debugPropShot')) launchDebugPropShot()

  // ── ウェブはQを押している間だけ接続。離すと糸が切れ、そのまま落下する。
  if (isHeld('webSwing') && !isSwinging()) tryWebAttach()
  else if (!isHeld('webSwing') && isSwinging()) webRelease(false)
  updateFireStream(dt, p.selectedAbility === 'firestream' && isHeld('useAbility'))

  // ── ジャンプ。地上（ボスの身体の上を含む）からだけ跳べる。
  if (wasPressed('jump') && !p.airborne && !p.dead && p.state !== 'roll' && p.state !== 'hit') {
    if (finalBossMounted()) detachMountedPlayer(p.jumpSpeed)
    else { p.airborne = true; p.vy = p.jumpSpeed }
    p.tutorialActions.jump = true
  }

  // ── 空中（ジャンプ・スイング中・飛び出し中）は専用の物理で動かす
  if (p.airborne) {
    const axis = cameraRelative(moveAxis())
    // 糸に繋がっている間だけウェブの物理。ただのジャンプ・落下は自由落下側で動かす。
    if (isWebAirborne()) updateWeb(dt, axis)
    else updateFreeFall(dt, axis)
    // 落ちてきた先にボスの身体があれば、そこへ着地する
    if (!finalBossFooting()) recoverFinalBossFall()
    if (p.action) runPlayerAttack(dt)
    return
  }

  // 回避ローリング
  if (wasPressed('dodge') && p.state !== 'roll' && p.stamina >= p.dodgeCost && !p.dead) {
    p.state = 'roll'
    p.stateTime = 0
    p.anim = 'roll'
    p.stamina -= p.dodgeCost
    p.invuln = p.dodgeInvuln
    p.action = null
    const axis = cameraRelative(moveAxis())
    p.rollDir = axis.len > 0.01 ? { x: axis.x, z: axis.z } : { x: Math.sin(p.yaw), z: Math.cos(p.yaw) }
    p.yaw = Math.atan2(p.rollDir.x, p.rollDir.z)
    p.tutorialActions.roll = true
  }

  // 会話
  if (wasPressed('interact')) tryInteract()

  if (finalBossMounted()) {
    const axis = cameraRelative(moveAxis())
    p.running = wantSprint && p.stamina > 3 && !p.blocking
    updateMountedPlayer(dt, axis)
    if (p.action) runPlayerAttack(dt)
    return
  }

  // ── 移動
  let moveX = 0, moveZ = 0
  let speed = 0
  const locked = p.state === 'roll' || p.state === 'hit' || (p.action && p.action.phase === 'windup')

  if (p.state === 'roll') {
    speed = p.dodgeSpeed * (1 - p.stateTime / 0.5) * 1.2
    moveX = p.rollDir.x
    moveZ = p.rollDir.z
    if (p.stateTime > 0.5) { p.state = 'idle'; p.stateTime = 0 }
  } else if (p.state === 'hit') {
    if (p.stateTime > 0.45) { p.state = 'idle'; p.stateTime = 0 }
  } else if (!locked) {
    const axis = cameraRelative(moveAxis())
    if (axis.len > 0.01) {
      const canRun = wantSprint && p.stamina > 3 && !p.blocking
      p.running = canRun
      speed = (canRun ? p.runSpeed : p.walkSpeed) * (p.blocking ? 0.55 : 1) * (1 - p.slow)
      moveX = axis.x
      moveZ = axis.z
      // 移動方向を向く(カメラ相対)
      const want = Math.atan2(axis.x, axis.z)
      let diff = want - p.yaw
      diff = Math.atan2(Math.sin(diff), Math.cos(diff))
      p.yaw += THREE.MathUtils.clamp(diff, -12 * dt, 12 * dt)
    } else {
      p.running = false
    }
  } else {
    p.running = false
  }

  // ノックバック合成
  const kb = p.knockback
  let dx = moveX * speed * dt + kb.x * dt
  let dz = moveZ * speed * dt + kb.z * dt
  kb.multiplyScalar(Math.max(0, 1 - dt * 6))
  if (kb.lengthSq() < 0.0004) kb.set(0, 0, 0)

  if (Math.abs(dx) > 1e-6 || Math.abs(dz) > 1e-6) {
    const res = move(p.pos.x, p.pos.z, dx, dz, p.hitRadius)
    p.pos.x = res.x
    p.pos.z = res.z
  }
  // 万一詰まったら押し戻す(川に落ちた等)
  if (!isWalkable(p.pos.x, p.pos.z)) {
    const n = nearestWalkable(p.pos.x, p.pos.z)
    p.pos.x = n.x
    p.pos.z = n.z
  }
  // 足元にボスの身体があれば、そこが地面になる（歩いて足の甲へ登れる）
  if (!finalBossFooting()) {
    const gy = groundY(p.pos.x, p.pos.z, p.pos.y)
    p.pos.y += (gy - p.pos.y) * Math.min(1, dt * 12)
  }
  p.vel.set(moveX * speed, 0, moveZ * speed)
  p.moveSpeed = speed * Math.hypot(moveX, moveZ)
  if (p.moveSpeed > 0.25) p.tutorialActions[p.running ? 'run' : 'walk'] = true

  // ── アニメーション決定(状態に応じてクロスフェード)
  if (p.state === 'roll') p.anim = 'roll'
  else if (p.state === 'hit') p.anim = 'hit'
  else if (p.action) p.anim = p.action.def.clip || 'attack'
  else if (p.fireStreamHold) { p.anim = 'cast'; p.animSpeed = 1.4 }
  else if (p.moveSpeed > p.walkSpeed + 0.6) { p.anim = 'run'; p.animSpeed = THREE.MathUtils.clamp(p.moveSpeed / p.runSpeed, 0.6, 1.4) }
  else if (p.moveSpeed > 0.25) { p.anim = 'walk'; p.animSpeed = THREE.MathUtils.clamp(p.moveSpeed / p.walkSpeed, 0.6, 1.5) }
  else { p.anim = p.blocking ? 'idle_sword' : 'idle'; p.animSpeed = 1 }

  // 攻撃モーション進行
  if (p.action) runPlayerAttack(dt)
}

/** 入力(スクリーン基準)をカメラの向きに合わせたワールド方向へ変換 */
function cameraRelative({ x, y }) {
  const yaw = sim.camera.yaw
  // カメラは +Z 側に居るので、前方は -(sin yaw, cos yaw)
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw)
  const rx = -fz, rz = fx
  let wx = fx * y + rx * x
  let wz = fz * y + rz * x
  const len = Math.hypot(wx, wz)
  if (len > 0.001) { wx /= len; wz /= len }
  return { x: wx, z: wz, len }
}

function handleAttackInput() {
  const p = sim.player
  const slots = ['magic', 'area', 'arrow', 'firestream']
  for (let i = 0; i < slots.length; i++) {
    if (wasPressed(`ability${i + 1}`)) {
      p.selectedAbility = slots[i]
      const def = PLAYER_ATTACKS[p.selectedAbility]
      say(`${def.label} を選択`, p.skills.includes(def.id) ? 'info' : 'warn')
      return
    }
  }
  if (wasPressed('meleeAttack')) { tryAttack('melee'); return }
  if (wasPressed('heal')) { tryAttack('heal'); return }
  if (wasPressed('useAbility') && p.selectedAbility !== 'firestream') tryAttack(p.selectedAbility)
}

/**
 * デバッグ限定のネタ技。分離した町GLBをランダムに選び、通常の弾と同じ
 * 命中・建物破壊・敵ダメージ経路へ流す。連打を気持ちよくするためクールダウンなし。
 */
export function launchDebugPropShot() {
  const p = sim.player
  if (!sim.debugMode || p.dead || isGuest()) return false
  const oldest = sim.projectiles.findIndex((projectile) => projectile.kind === 'debug-prop')
  if (sim.projectiles.filter((projectile) => projectile.kind === 'debug-prop').length >= DEBUG_PROP_SHOT_MAX_ACTIVE && oldest >= 0) {
    sim.projectiles.splice(oldest, 1)
  }
  const assetIndex = Math.floor(Math.random() * DEBUG_PROP_SHOT_ASSETS.length)
  const asset = DEBUG_PROP_SHOT_ASSETS[assetIndex]
  if (!asset) return false
  const aim = aimDirection()
  const flat = Math.hypot(aim.x, aim.z) || 1
  const dx = aim.x / flat
  const dz = aim.z / flat
  const dy = THREE.MathUtils.clamp(aim.y * 0.7 + 0.08, -0.42, 0.42)
  const attacker = { attack: p.attack, magicAttack: p.magicAttack, buff: null }
  addProjectile({
    kind: 'debug-prop', owner: 'player', attack: DEBUG_PROP_SHOT_ATTACK, attacker, mul: 1,
    x: p.pos.x + dx * 0.75, y: p.pos.y + 1.25, z: p.pos.z + dz * 0.75,
    dx, dy, dz, speed: DEBUG_PROP_SHOT_ATTACK.speed, radius: DEBUG_PROP_SHOT_ATTACK.radius,
    color: '#d9f8ff', life: 2.4, maxLife: 2.4, armAt: sim.time + 0.12, propAsset: assetIndex,
  })
  sim.debugPropShotsFired++
  addEffect({ kind: 'muzzle', x: p.pos.x + dx * 0.7, y: p.pos.y + 1.2, z: p.pos.z + dz * 0.7, radius: 0.7, color: '#a9f1ff', life: 0.18 })
  return true
}

/** 破片がプレイヤー/敵に当たったとき（上限つき。接触だけでは即死しない） */
function onDebrisContact(who, enemy, damage, d) {
  if (damage <= 0) return
  const attack = { power: damage, element: 'physical', kind: 'melee', knockback: 1.2 }
  const attacker = { attack: 0, magicAttack: 0, buff: null }
  if (who === 'player') {
    const p = sim.player
    if (p.invuln > 0 || p.dead) return
    p.hp = Math.max(1, p.hp - damage)      // 残骸との接触だけでは死なせない
    p.hitFlash = 0.15
    floater(p.pos, `${damage}`, '#c9a06a', 0.8)
    sim.hudTick++
  } else if (enemy) {
    damageEnemy(enemy, attacker, attack, { x: d.x, z: d.z }, 1)
  }
}

export function tryAttack(id) {
  const p = sim.player
  const def = PLAYER_ATTACKS[id]
  if (!def || p.dead) return false
  // 長押し技（ウェブスイング・連続火球）はボタン押下では発動しない
  if (def.mode === 'hold') return false
  if (!p.skills.includes(id)) { say(`${def.label} はまだ覚えていない（Lv.${def.unlockLevel}で解禁）`, 'warn'); return false }
  if ((p.cooldowns[id] || 0) > sim.time) return false
  if (p.state === 'roll' || p.state === 'hit') return false
  // 近接はコンボ中のみ連続入力を許可
  if (p.action) {
    const chain = id === 'melee' && p.action.phase === 'recover' && p.action.def.id === 'melee' && p.combo < 2
    if (!chain) return false
  }
  const cost = def.cost || {}
  if (cost.mp && p.mp < cost.mp) { say('MPが足りない。', 'warn'); return false }
  if (cost.stamina && p.stamina < cost.stamina) { say('スタミナが足りない。', 'warn'); return false }
  if (cost.mp) p.mp -= cost.mp
  if (cost.stamina) p.stamina -= cost.stamina

  if (id === 'melee') {
    p.combo = p.action && sim.time < p.comboUntil ? Math.min(2, p.combo + 1) : 0
    p.comboUntil = sim.time + 1.1
  } else p.combo = 0

  p.action = { def, phase: 'windup', timer: def.windup }
  p.lastAttackId = id
  p.state = 'attack'
  p.stateTime = 0
  p.blocking = false
  p.anim = def.clip
  if (id === 'melee') p.tutorialActions.melee = true
  if (id === 'heal') p.tutorialActions.heal = true
  return true
}

function runPlayerAttack(dt) {
  const p = sim.player
  const a = p.action
  a.timer -= dt
  if (a.timer > 0) return

  if (a.phase === 'windup') {
    executePlayerAttack(a.def)
    a.phase = 'recover'
    a.timer = a.def.id === 'melee' ? 0.3 : 0.35
    p.cooldowns[a.def.id] = sim.time + a.def.cooldown
  } else {
    p.action = null
    if (p.state === 'attack') { p.state = 'idle'; p.stateTime = 0 }
  }
}

/** 主人公の狙い: 正面コーン内で一番近い敵。無ければ真正面 */
function aimTarget(range, cone = 42) {
  const p = sim.player
  let best = null
  for (const e of sim.enemies) {
    if (!e.alive || e.state === 'dead') continue
    const dx = e.pos.x - p.pos.x
    const dz = e.pos.z - p.pos.z
    const d = Math.hypot(dx, dz)
    if (d > range) continue
    const a = Math.abs(Math.atan2(Math.sin(Math.atan2(dx, dz) - p.yaw), Math.cos(Math.atan2(dx, dz) - p.yaw)))
    if (a > (cone * Math.PI) / 180) continue
    if (!best || d < best.d) best = { e, d, dx, dz }
  }
  return best
}

function executePlayerAttack(def) {
  const p = sim.player
  if (isGuest()) {
    requestAttack(def.id, [p.pos.x, p.pos.y + 1, p.pos.z], [Math.sin(p.yaw), 0, Math.cos(p.yaw)])
    addEffect({ kind: 'slash', x: p.pos.x, y: p.pos.y + 1, z: p.pos.z, yaw: p.yaw, radius: 1.1, color: '#b9eaff', life: 0.2 })
    return
  }
  const attacker = { attack: p.attack, magicAttack: p.magicAttack, buff: null }

  switch (def.id) {
    case 'melee': {
      const mul = COMBO_MUL[p.combo] || 1
      const heavy = p.combo === 2
      const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw)
      // 命中点は剣の届く先。ここを中心に建物の小片だけが壊れる
      const hx = p.pos.x + fx * def.range * 0.65
      const hz = p.pos.z + fz * def.range * 0.65
      const hy = p.pos.y + 1.05
      const r = damageTarget({
        x: hx, y: hy, z: hz,
        dirX: fx, dirY: 0.12, dirZ: fz,
        radius: def.range * 0.62,
        arc: def.arc,
        arcRange: def.range,
        originX: p.pos.x, originZ: p.pos.z,
        yaw: p.yaw,
        attack: def, attacker, mul,
        structureMul: heavy ? 1.8 : 1,
        impulse: heavy ? 1.7 : 1,
        juice: heavy ? 0.42 : 0.16,
        slowmo: heavy,
      })
      // 扇形判定は近接位置基準で行う（damageTarget の arc は x,z を中心に見る）
      addEffect({
        kind: 'slash', x: p.pos.x + fx * 1.2, y: p.pos.y + 1.1, z: p.pos.z + fz * 1.2,
        color: heavy ? '#ffd166' : '#ffffff', radius: 1.0 + p.combo * 0.2, life: 0.2, yaw: p.yaw,
      })
      if (!r.enemies.length && !r.damaged && !r.debris) say(p.combo === 0 ? '空を斬った。' : '', 'info')
      break
    }
    case 'magic':
    case 'arrow': {
      const target = aimTarget(def.range)
      const dirYaw = target ? Math.atan2(target.dx, target.dz) : p.yaw
      // 狙う敵が居なければカメラの上下を反映して、屋根や看板も狙えるようにする
      const aim = aimDirection()
      const dy = target ? 0 : Math.max(-0.85, Math.min(0.85, aim.y))
      const flat = Math.sqrt(Math.max(0.0001, 1 - dy * dy))
      addProjectile({
        kind: def.id === 'arrow' ? 'arrow' : 'magic', owner: 'player', attack: def, mul: 1,
        attacker,
        x: p.pos.x + Math.sin(dirYaw) * 0.5, y: p.pos.y + 1.25, z: p.pos.z + Math.cos(dirYaw) * 0.5,
        dx: Math.sin(dirYaw) * flat, dy, dz: Math.cos(dirYaw) * flat,
        speed: def.speed, color: def.id === 'arrow' ? '#fff0a8' : '#ff9a4c',
        radius: def.id === 'arrow' ? 0.16 : 0.28, life: 3,
      })
      break
    }
    case 'area': {
      const target = aimTarget(def.range, 70)
      const cx = target ? target.e.pos.x : p.pos.x + Math.sin(p.yaw) * Math.min(6, def.range)
      const cz = target ? target.e.pos.z : p.pos.z + Math.cos(p.yaw) * Math.min(6, def.range)
      const cy = groundY(cx, cz) + 0.6
      addEffect({ kind: 'aoe', x: cx, y: cy - 0.5, z: cz, radius: def.radius, color: '#9fd8ff', life: 0.55 })
      // 範囲攻撃は爆発として扱い、敵・建物・残骸をまとめて吹き飛ばす
      explode({
        x: cx, y: cy, z: cz,
        dirX: 0, dirY: 0.75, dirZ: 0,
        radius: def.radius,
        attack: def, attacker, mul: 1,
        structureMul: 1.5,
        impulse: 1.8,
        checkHeight: false,
        juice: 0.62,
        slowmo: true,
      })
      break
    }
    case 'heal': {
      const amount = def.power
      p.hp = Math.min(p.maxHp, p.hp + amount)
      floater(p.pos, `+${amount}`, '#a8ff9f', 1.1)
      addEffect({ kind: 'ring', x: p.pos.x, y: p.pos.y + 0.1, z: p.pos.z, radius: 1.8, color: '#a8ff9f', life: 0.7 })
      break
    }
    default: break
  }
}

function tryInteract() {
  const p = sim.player
  let best = null
  for (const npc of sim.npcs) {
    const d = npc.pos.distanceTo(p.pos)
    if (d < 3.4 && (!best || d < best.d)) best = { npc, d }
  }
  if (best) {
    openDialogue(best.npc.id)
    best.npc.yaw = Math.atan2(p.pos.x - best.npc.pos.x, p.pos.z - best.npc.pos.z)
  } else {
    say('話せる相手がいない。緑の名札に近づいてEキー。', 'info')
  }
}

function updateNpcs(dt) {
  const p = sim.player
  let nearest = null
  for (const npc of sim.npcs) {
    const d = npc.pos.distanceTo(p.pos)
    if (d < 6) {
      // 近づくとプレイヤーの方を向く
      const want = Math.atan2(p.pos.x - npc.pos.x, p.pos.z - npc.pos.z)
      let diff = want - npc.yaw
      diff = Math.atan2(Math.sin(diff), Math.cos(diff))
      npc.yaw += THREE.MathUtils.clamp(diff, -2 * dt, 2 * dt)
    }
    if (d < 3.4 && (!nearest || d < nearest.d)) nearest = { npc, d }
  }
  sim.nearestNpc = nearest ? nearest.npc : null
}

function handleDialogueInput() {
  if (wasPressed('pause')) { closeDialogue(); return }
  for (let i = 1; i <= 4; i++) if (wasPressed(`ability${i}`)) { chooseDialogue(i - 1); return }
}

// ───────────────────────────── 弾

function updateProjectiles(dt) {
  const p = sim.player
  for (let i = sim.projectiles.length - 1; i >= 0; i--) {
    const pr = sim.projectiles[i]
    const stepLen = pr.speed * dt
    pr.x += pr.dx * stepLen
    pr.y += (pr.dy || 0) * stepLen
    pr.z += pr.dz * stepLen
    pr.life -= dt

    let done = false
    // 発射直後だけは自分のいる建物コライダーに当てず、GLBが魔法球として
    // 画面から飛び出すまでの短い猶予を確保する。
    if (sim.time < (pr.armAt ?? -Infinity)) continue
    // 建物の小片に当たったか（3D）。命中位置から局所破壊する
    const part = (pr.owner === 'player' || pr.structure) ? isInsideStructure(pr.x, pr.y, pr.z) : null
    if (part) {
      hitStructureWithProjectile(pr)
      done = !pr.attack.pierce
    } else if (pr.y < groundY(pr.x, pr.z, -999)) {
      if (pr.stream) fireBlast(pr)
      else addEffect({ kind: 'impact', x: pr.x, y: pr.y, z: pr.z, color: pr.color, radius: 0.5, life: 0.25 })
      done = true
    } else if (!isWalkable(pr.x, pr.z) && Math.abs(pr.y - groundY(pr.x, pr.z, pr.y)) < 3.2) {
      // NavMesh 上の障害物（破壊対象として登録されていない地形など）
      if (pr.stream) fireBlast(pr)
      else addEffect({ kind: 'impact', x: pr.x, y: pr.y, z: pr.z, color: pr.color, radius: 0.5, life: 0.25 })
      done = true
    } else if (pr.owner === 'enemy') {
      if (!p.dead && Math.hypot(pr.x - p.pos.x, pr.z - p.pos.z) < p.hitRadius + pr.radius + 0.25 && Math.abs(pr.y - (p.pos.y + 1.1)) < 1.4) {
        damagePlayer(pr.attacker, pr.attack, { x: pr.x, z: pr.z }, pr.mul)
        addEffect({ kind: 'impact', x: pr.x, y: pr.y, z: pr.z, color: pr.color, radius: 0.6, life: 0.25 })
        done = true
      }
    } else {
      for (const e of sim.enemies) {
        if (!e.alive || e.state === 'dead') continue
        if (Math.hypot(pr.x - e.pos.x, pr.z - e.pos.z) > e.def.stats.hitRadius + pr.radius + 0.3) continue
        if (Math.abs(pr.y - (e.pos.y + 1.1)) > 1.5) continue
        if (pr.stream) fireBlast(pr)
        else {
          damageEnemy(e, pr.attacker, pr.attack, { x: pr.x, z: pr.z }, pr.mul)
          addEffect({ kind: 'impact', x: pr.x, y: pr.y, z: pr.z, color: pr.color, radius: 0.6, life: 0.25 })
        }
        if (!pr.attack.pierce) done = true
        break
      }
      if (!done) for (const b of sim.bosses || []) {
        if (!b.alive || b.state === 'dead') continue
        if (Math.hypot(pr.x - b.pos.x, pr.z - b.pos.z) > b.def.hitRadius + pr.radius + 0.35) continue
        damageBoss(b, pr.attacker, pr.attack, { x: pr.x, y: pr.y, z: pr.z }, pr.mul)
        addEffect({ kind: 'impact', x: pr.x, y: pr.y, z: pr.z, color: pr.color, radius: 0.75, life: 0.25 })
        if (!pr.attack.pierce) done = true
        break
      }
      if (!done) {
        const r = damageFinalBossAt({ x: pr.x, y: pr.y, z: pr.z }, pr.attacker, { ...pr.attack, range: pr.radius + 0.4 }, pr.mul)
        if (r) {
          addEffect({ kind: 'impact', x: pr.x, y: pr.y, z: pr.z, color: pr.color, radius: 0.75, life: 0.25 })
          if (!pr.attack.pierce) done = true
        }
      }
    }
    if (done || pr.life <= 0) sim.projectiles.splice(i, 1)
  }
}

/** 弾が建物に当たったとき。命中点・方向・威力から局所的に壊す。 */
function hitStructureWithProjectile(pr) {
  if (pr.stream) { fireBlast(pr); return }
  const isArrow = pr.kind === 'arrow'
  damageTarget({
    x: pr.x, y: pr.y, z: pr.z,
    dirX: pr.dx, dirY: pr.dy || 0, dirZ: pr.dz,
    radius: isArrow ? 0.85 : 1.5,
    attack: pr.attack, attacker: pr.attacker, mul: pr.mul,
    hitEnemies: false,
    hitBosses: false,
    structureMul: isArrow ? 0.8 : 1.3,
    impulse: isArrow ? 0.7 : 1.3,
    juice: isArrow ? 0.12 : 0.28,
  })
  addEffect({ kind: 'impact', x: pr.x, y: pr.y, z: pr.z, color: pr.color, radius: 0.6, life: 0.25 })
}

// ───────────────────────────── エフェクト(罠・範囲・演出)

function updateEffects(dt) {
  const p = sim.player
  for (let i = sim.effects.length - 1; i >= 0; i--) {
    const f = sim.effects[i]
    f.life -= dt

    if (f.kind === 'trap' && !p.dead) {
      const d = Math.hypot(p.pos.x - f.x, p.pos.z - f.z)
      if (d < f.radius) {
        damagePlayer(f.attacker, f.attack, { x: f.x, z: f.z }, f.mul)
        addEffect({ kind: 'aoe', x: f.x, y: f.y, z: f.z, radius: f.radius, color: '#e27d35', life: 0.45 })
        say('罠を踏んだ！', 'warn')
        sim.effects.splice(i, 1)
        continue
      }
    }
    if (f.kind === 'bossHazard' && !p.dead && sim.time >= (f.nextHit || 0)) {
      const d = Math.hypot(p.pos.x - f.x, p.pos.z - f.z)
      if (d < f.radius) {
        damagePlayer(f.attacker, f.attack, { x: f.x, z: f.z }, f.mul)
        f.nextHit = sim.time + 0.8
      }
    }
    if (f.kind === 'delayedBossCircle' && !f.fired && sim.time >= f.at) {
      f.fired = true
      if (!p.dead && Math.hypot(p.pos.x - f.x, p.pos.z - f.z) < f.radius + p.hitRadius) {
        damagePlayer(f.attacker, { ...f.attack, power: f.attack.characterDamage, kind: 'aoe', knockback: 4.5 }, { x: f.x, z: f.z }, 1)
      }
      damageTarget({ x: f.x, y: groundY(f.x, f.z) + 0.5, z: f.z, radius: f.radius, dirY: 0.4,
        attack: { ...f.attack, power: f.attack.structureDamage, kind: 'aoe' }, attacker: f.attacker,
        hitEnemies: false, hitBosses: false, structureMul: 1, impulse: f.attack.debrisImpulse, juice: 0.3 })
      addEffect({ kind: 'aoe', x: f.x, y: groundY(f.x, f.z) + 0.06, z: f.z, radius: f.radius, color: f.color, life: 0.42 })
    }
    if (f.life <= 0) sim.effects.splice(i, 1)
  }
}

function updateFloaters(dt) {
  for (let i = sim.floaters.length - 1; i >= 0; i--) {
    const f = sim.floaters[i]
    f.life -= dt
    f.y += dt * 1.1
    if (f.life <= 0) sim.floaters.splice(i, 1)
  }
}
