/**
 * ゲーム状態の一元管理。
 *
 * React の再レンダリングを毎フレーム起こさないため、シミュレーション本体は
 * このミュータブルなオブジェクトで持ち、描画側(useFrame)は直接読んで
 * Object3D を更新する。HUD だけ useSyncExternalStore で 12Hz 程度に間引いて配信する。
 */
import * as THREE from 'three'
import { ENEMY_LIST, PLAYER_BASE, pickVariant, PLAYER_ATTACKS, enemyHpMul } from '../data/enemies.js'
import { FINAL_PHASE_OBJECTIVES } from '../data/finalBoss.js'
import { QUESTS } from '../data/quests.js'
import { spawnPoint, findLandmark, randomPointNear, groundY, nearestWalkable } from './nav.js'
import { xpForLevel } from './combat.js'

export const MAX_FLOATERS = 14
export const MAX_MESSAGES = 5

/** 敵1体分の初期状態 */
function makeEnemy(id, def, index) {
  const variant = pickVariant(def)
  const mul = variant.mul * 0.5
  const maxHp = Math.round(def.stats.maxHp * mul * enemyHpMul(def))
  return {
    id,
    typeId: def.id,
    def,
    variant,
    variantMul: variant.mul,
    spawnSlot: index,
    strength: 0.5,
    mul,
    label: variant.label ? `${variant.label}${def.name}` : def.name,
    scale: (def.look.scale || 1) * (variant.look?.scale || 1),
    alive: false,
    hp: maxHp,
    maxHp,
    pos: new THREE.Vector3(),
    vel: new THREE.Vector3(),
    yaw: 0,
    state: 'idle',
    stateTime: 0,
    anim: 'idle',
    animSpeed: 1,
    aware: false,          // プレイヤーを認識しているか
    lastSeen: -999,
    lastHeard: -999,
    cooldowns: {},
    attack: null,          // {def, phase:'windup'|'recover', timer}
    home: { x: 0, z: 0 },
    patrol: null,
    patrolWait: 0,
    buff: null,            // {attack, speed, until}
    enraged: false,
    fleeing: false,
    barrier: false,
    slowUntil: 0,
    slow: 0,
    hitFlash: 0,
    respawnAt: index * 1.5,
    deaths: 0,
    idleSeed: Math.random() * 10,
  }
}

function makePlayer() {
  return {
    ...PLAYER_BASE,
    pos: new THREE.Vector3(),
    vel: new THREE.Vector3(),
    yaw: 0,
    hp: PLAYER_BASE.maxHp,
    mp: PLAYER_BASE.maxMp,
    stamina: PLAYER_BASE.maxStamina,
    level: 1,
    xp: 0,
    gold: 0,
    deaths: 0,
    kills: {},
    skills: ['melee', 'heal'],
    /** 数字キーで選ぶ4つの技。発動は常に R。 */
    selectedAbility: 'magic',
    items: {},
    state: 'idle',
    stateTime: 0,
    anim: 'idle',
    animSpeed: 1,
    blocking: false,
    running: false,
    invuln: 0,
    /** 攻撃モーションの進行状態。数値ステータスの attack とは別物。 */
    action: null,
    cooldowns: {},
    knockback: new THREE.Vector3(),
    slow: 0,
    slowUntil: 0,
    dead: false,
    respawnTimer: 0,
    combo: 0,
    comboUntil: 0,
    hitFlash: 0,
    moveSpeed: 0,
    grounded: true,
    tutorialActions: {},
    // ── 追加アクション
    airborne: false,
    vy: 0,
    web: { attached: false, ax: 0, ay: 0, az: 0, rope: 0, partId: -1, cooldownUntil: 0, lastDetach: 0, swings: 0 },
    heat: 0,
    overheatUntil: 0,
    fireStreamNext: 0,
    fireStreamHold: false,
    staggerImmuneUntil: 0,
    finalBossPlatform: null,
  }
}

export const sim = {
  ready: false,
  time: 0,
  /** 0..1 の時刻。0.25=朝, 0.5=正午, 0.75=夕, 0/1=深夜 */
  dayTime: 0.34,
  dayLength: 300,           // 実時間300秒で1日
  paused: false,
  /** スマホが縦向きで、横にするまで進行を止めている状態 */
  orientationBlocked: false,
  /** 'play' | 'dialogue' | 'menu' | 'dead' */
  mode: 'play',
  player: makePlayer(),
  enemies: [],
  bosses: [],
  finalBoss: null,
  /** WebRTC参加者は可変Mapで保持し、ローカルプレイヤーとは別に補間描画する。 */
  remotePlayers: new Map(),
  net: { active: false, epoch: 0, sequence: 0, lastSnapshot: -1, correction: null, remoteAttack: null },
  /** ボス戦専用の破壊可能な核・ドローン・鍋。通常の建物破片とは別管理する。 */
  bossObjects: [],
  /** ボス戦のアリーナ封鎖（橋の封鎖・ATフィールド・敵の抑制） */
  arena: { active: false, bossId: null, since: 0, blockedCells: 0, panels: [] },
  bossProgress: { defeatedBossCount: 0, order: [], rewards: {}, buildingRatios: {} },
  /** Town.jsx が破壊小片を登録済みか。登録前はボス出現判定を行わない。 */
  townReady: false,
  /** タイトル開始直後の演出・セーブ復元が落ち着くまでボス判定を遅延する。 */
  bossArmedAt: Infinity,
  /** 最初の1体を倒すまで、敵は半数・半強度で出現する。 */
  enemyChallengeUnlocked: false,
  npcs: [],
  projectiles: [],
  effects: [],
  floaters: [],
  /** 破片（残骸）。HPを持たず、当たれば飛ぶ物理オブジェクト。 */
  debris: [],
  debrisStats: { spawnedThisFrame: 0, active: 0, sleeping: 0 },
  /** 倒した敵のラグドール */
  ragdolls: [],
  /** 支えを失って崩れ落ちる予約 */
  pendingCollapse: [],
  destructStats: { parts: 0, broken: 0, pending: 0 },
  /** ヒットストップ・シェイク・スロー */
  juice: { hitstop: 0, shake: 0, slowmo: 0, shockwave: 0, shockwaveMax: 0.35 },
  /** 開発用の当たり判定表示 */
  debugDraw: false,
  /** npm run dev:debug または ?debug=1 でだけ有効になる開発用のネタ技など。 */
  debugMode: false,
  debugPropShotsFired: 0,
  messages: [],
  levelUpNotice: null,
  tutorialCompleteUntil: 0,
  /** 画面中央に数秒だけ出す「いま何をすべきか」。ボスのフェーズ切替で差し替わる。 */
  objectiveBanner: null,
  quests: {},
  // 正面より少し上を見る初期角。以前の0.42(約24°下向き)より地平・高所を見つけやすい。
  camera: { yaw: Math.PI, pitch: 0.28, dist: 9, target: new THREE.Vector3(), profile: 'normal' },
  dialogue: null,           // {npcId, nodeId}
  stats: { damageDealt: 0, damageTaken: 0, blocked: 0 },
  settings: {
    reducedMotion: false, largeText: false, highContrast: false, invertY: false,
    /** 長押しが難しい人向けの代替操作。 */
    guardMode: 'hold', sprintMode: 'hold',
    /** action -> KeyboardEvent.code[]。入力設定画面がここへ保存する。 */
    bindings: null,
    /** 破壊演出。0で完全に無効、1が既定 */
    shakeAmount: 1,
    reducedFlash: false,
    debrisAmount: 1,
    dustAmount: 1,
    /** 'high' | 'medium' | 'low'。低くしても「殴った所が壊れる」性質は保つ */
    destructionQuality: 'high',
    sfxVolume: 1,
    musicVolume: 0.55,
    muteSfx: false,
  },
  autosaveAt: 0,
  hudTick: 0,
}

let nextId = 1
export const uid = () => nextId++

/** 敵プールを作る。個体数は enemies.js の spawn.count 由来。 */
export function initEnemies() {
  sim.enemies = []
  sim.enemyChallengeUnlocked = false
  let index = 0
  for (const def of ENEMY_LIST) {
    for (let i = 0; i < def.spawn.count; i++) {
      sim.enemies.push(makeEnemy(`${def.id}#${i}`, def, index++))
    }
  }
}

/** 初回撃破後に通常の敵強度・出現数へ戻す。 */
export function unlockEnemyChallenge() {
  if (sim.enemyChallengeUnlocked) return
  sim.enemyChallengeUnlocked = true
  for (const e of sim.enemies) {
    const hpRatio = e.maxHp > 0 ? e.hp / e.maxHp : 1
    e.strength = 1
    e.mul = e.variantMul
    e.maxHp = Math.round(e.def.stats.maxHp * e.mul * enemyHpMul(e.def))
    if (e.alive && e.state !== 'dead') e.hp = Math.max(1, Math.round(e.maxHp * hpRatio))
    // 初期に抑えていたプールの敵をすぐ出現可能にする。
    if (!e.alive) e.respawnAt = sim.time + Math.random() * 2
  }
  say('最初の敵を倒した！ 敵が本来の強さで現れるようになった。', 'level')
}

/** 敵の出現地点を landmark から決める(bunbetu 12 生息環境) */
export function pickSpawnPos(def) {
  const names = def.spawn.near
  for (let attempt = 0; attempt < names.length + 2; attempt++) {
    const name = names[Math.floor(Math.random() * names.length)]
    const lm = findLandmark(name)
    const base = lm ? lm.entry : spawnPoint()
    const p = randomPointNear(base.x, base.z, def.spawn.radius || 12)
    if (p) return p
  }
  const s = spawnPoint()
  return { x: s.x, z: s.z }
}

/** 出現条件(bunbetu 13)。夜だけ/昼だけの敵を弾く。 */
export function canSpawnNow(def) {
  const night = isNight()
  if (def.spawn.time === 'night') return night
  if (def.spawn.time === 'day') return !night
  return true
}

export const isNight = () => sim.dayTime < 0.2 || sim.dayTime > 0.82

export function spawnEnemy(e) {
  const p = pickSpawnPos(e.def)
  e.pos.set(p.x, groundY(p.x, p.z), p.z)
  e.home = { x: p.x, z: p.z }
  e.hp = e.maxHp
  e.alive = true
  e.state = 'idle'
  e.stateTime = 0
  e.aware = false
  e.attack = null
  e.cooldowns = {}
  e.enraged = false
  e.fleeing = false
  e.barrier = false
  e.buff = null
  e.vel.set(0, 0, 0)
  e.yaw = Math.random() * Math.PI * 2
  e.patrol = null
  e.hitFlash = 0
  e.anim = 'idle'
}

export function resetPlayer(full = true) {
  const p = sim.player
  const s = spawnPoint()
  const near = nearestWalkable(s.x, s.z)
  p.pos.set(near.x, groundY(near.x, near.z), near.z)
  p.vel.set(0, 0, 0)
  p.knockback.set(0, 0, 0)
  p.state = 'idle'
  p.anim = 'idle'
  p.dead = false
  p.action = null
  p.blocking = false
  p.invuln = 1.2
  p.airborne = false
  p.vy = 0
  p.finalBossPlatform = null
  p.heat = 0
  p.overheatUntil = 0
  p.staggerImmuneUntil = 0
  if (p.web) { p.web.attached = false; p.web.zipping = false; p.web.partId = -1 }
  if (full) {
    p.hp = p.maxHp
    p.mp = p.maxMp
    p.stamina = p.maxStamina
  }
}

/** 開発用の開始レベル。通常のレベルアップと同じ能力値・スキル解放則を再現する。 */
export function setPlayerDebugLevel(level = 8) {
  const p = sim.player
  const target = Math.max(1, Math.round(level))
  p.level = 1
  p.xp = 0
  p.maxHp = PLAYER_BASE.maxHp
  p.maxMp = PLAYER_BASE.maxMp
  p.maxStamina = PLAYER_BASE.maxStamina
  p.attack = PLAYER_BASE.attack
  p.defense = PLAYER_BASE.defense
  p.magicAttack = PLAYER_BASE.magicAttack
  p.magicDefense = PLAYER_BASE.magicDefense
  p.skills = Object.values(PLAYER_ATTACKS).filter((a) => a.unlockLevel <= target).map((a) => a.id)
  for (let next = 2; next <= target; next++) {
    p.level = next
    p.maxHp += 22
    p.maxMp += 10
    p.attack += 3
    p.defense += 2
    p.magicAttack += 3
    p.magicDefense += 2
  }
  p.hp = p.maxHp
  p.mp = p.maxMp
  p.stamina = p.maxStamina
  say(`開発モード: レベル${target}で開始`, 'level')
}

export function initQuests() {
  sim.quests = {}
  for (const q of QUESTS) {
    sim.quests[q.id] = { id: q.id, state: q.autoStart ? 'active' : 'locked', step: 0, counters: {} }
  }
  sim.player.tutorialActions = {}
}

// ───────────────────────────── メッセージ / ダメージ表示

export function say(text, kind = 'info') {
  // 通知キューは持たない。既存の呼び出しは保ち、最新の状態だけ残す。
  sim.messages[0] = { id: uid(), text, kind, at: sim.time }
  sim.messages.length = 1
  sim.hudTick++
}

export function floater(pos, text, color, size = 1) {
  if (sim.floaters.length >= MAX_FLOATERS) sim.floaters.shift()
  sim.floaters.push({
    id: uid(),
    x: pos.x + (Math.random() - 0.5) * 0.4,
    y: pos.y + 1.6,
    z: pos.z + (Math.random() - 0.5) * 0.4,
    text, color, size,
    life: 1.1,
    max: 1.1,
  })
}

export function addEffect(effect) {
  sim.effects.push({ id: uid(), life: effect.life ?? 0.6, max: effect.life ?? 0.6, ...effect })
  return sim.effects[sim.effects.length - 1]
}

export function addProjectile(p) {
  sim.projectiles.push({ id: uid(), life: 4, ...p })
}

// ───────────────────────────── 成長

export function gainXp(amount) {
  const p = sim.player
  p.xp += amount
  let leveled = false
  const unlocked = []
  while (p.xp >= xpForLevel(p.level)) {
    p.xp -= xpForLevel(p.level)
    p.level++
    leveled = true
    p.maxHp += 22
    p.maxMp += 10
    p.attack += 3
    p.defense += 2
    p.magicAttack += 3
    p.magicDefense += 2
    p.hp = p.maxHp
    p.mp = p.maxMp
    // スキル解禁
    for (const [id, a] of Object.entries(PLAYER_ATTACKS)) {
      if (a.unlockLevel <= p.level && !p.skills.includes(id)) {
        p.skills.push(id)
        unlocked.push(a)
        say(`新しい技を覚えた: ${a.label}（${a.key}キー）`, 'level')
      }
    }
  }
  if (leveled) {
    sim.levelUpNotice = { level: p.level, skills: unlocked.map((a) => ({ label: a.label, key: a.key })), until: sim.time + 5 }
    say(`レベル ${p.level} になった！`, 'level')
  }
  sim.hudTick++
}

// ───────────────────────────── HUD 配信 (useSyncExternalStore)

let snapshot = emptySnapshot()
const listeners = new Set()

function emptySnapshot() {
  return {
    hp: 0, maxHp: 1, mp: 0, maxMp: 1, stamina: 0, maxStamina: 1,
    level: 1, xp: 0, xpNext: 1, gold: 0, skills: [], cooldowns: {},
    messages: [], quests: [], mode: 'play', dialogue: null, dead: false,
    dayTime: 0, isNight: false, enemies: [], settings: sim.settings,
    blocking: false, kills: 0, deaths: 0, nearest: null, items: {}, levelUp: null, objectiveBanner: null, tutorialComplete: false,
    heat: 0, overheat: false, swinging: false, canWeb: false, brokenParts: 0, debris: 0, bosses: [], finalBoss: null, bossProgress: { defeatedBossCount: 0, buildingRatios: {} },
  }
}

export function buildSnapshot() {
  const p = sim.player
  return {
    hp: Math.max(0, Math.round(p.hp)), maxHp: p.maxHp,
    mp: Math.round(p.mp), maxMp: p.maxMp,
    stamina: Math.round(p.stamina), maxStamina: p.maxStamina,
    level: p.level, xp: Math.round(p.xp), xpNext: xpForLevel(p.level),
    selectedAbility: p.selectedAbility || 'magic',
    gold: p.gold, skills: [...p.skills],
    cooldowns: { ...p.cooldowns },
    blocking: p.blocking,
    dead: p.dead,
    deaths: p.deaths,
    kills: Object.values(p.kills).reduce((a, b) => a + b, 0),
    items: { ...p.items },
    messages: sim.messages.map((m) => ({ ...m })),
    quests: Object.values(sim.quests).map((q) => ({ ...q })),
    mode: sim.mode,
    dialogue: sim.dialogue ? { ...sim.dialogue } : null,
    dayTime: Math.round(sim.dayTime * 100) / 100,
    isNight: isNight(),
    settings: { ...sim.settings },
    nearest: sim.nearestNpc ? { id: sim.nearestNpc.id, name: sim.nearestNpc.name } : null,
    levelUp: sim.levelUpNotice && sim.time < sim.levelUpNotice.until ? { ...sim.levelUpNotice } : null,
    objectiveBanner: sim.objectiveBanner && sim.time < sim.objectiveBanner.until ? { ...sim.objectiveBanner } : null,
    tutorialComplete: sim.time < sim.tutorialCompleteUntil,
    heat: Math.round(p.heat ?? 0),
    overheat: sim.time < (p.overheatUntil ?? 0),
    swinging: !!(p.web?.attached || p.web?.zipping),
    canWeb: !!p.skills.includes('webswing'),
    brokenParts: sim.destructStats?.broken ?? 0,
    debris: sim.debrisStats?.active ?? 0,
    bosses: (sim.bosses || []).filter((b) => b.alive && b.state !== 'dead').map((b) => ({ id: b.id, label: b.label, hp: Math.max(0, Math.round(b.hp)), maxHp: b.maxHp, phase: b.phase, color: b.def.color, vulnerable: sim.time < b.vulnerableUntil })),
    finalBoss: sim.finalBoss?.alive ? {
      id: sim.finalBoss.id, label: sim.finalBoss.label, hp: Math.max(0, Math.round(sim.finalBoss.hp)), maxHp: sim.finalBoss.maxHp,
      phase: sim.finalBoss.phase, state: sim.finalBoss.state, color: sim.finalBoss.def.color,
      objective: FINAL_PHASE_OBJECTIVES[sim.finalBoss.phase] || '',
      regen: sim.finalBoss.regen,
      // 小片が登録済みならそちらが身体の実体。未登録（モデル読込前）はカプセル数で代用する。
      bodyIntact: sim.finalBoss.chunks.length
        ? sim.finalBoss.chunks.reduce((n, c) => n + (c.broken ? 0 : 1), 0)
        : sim.finalBoss.body.reduce((n, s) => n + (s.broken ? 0 : 1), 0),
      bodyTotal: sim.finalBoss.chunks.length || sim.finalBoss.body.length,
      parts: Object.values(sim.finalBoss.parts).map((part) => ({ id: part.id, label: part.label, hp: Math.max(0, part.hp), maxHp: part.maxHp, state: part.state, color: part.color })),
    } : null,
    bossProgress: { defeatedBossCount: sim.bossProgress?.defeatedBossCount || 0, buildingRatios: { ...(sim.bossProgress?.buildingRatios || {}) } },
    enemies: sim.enemies.filter((e) => e.alive).map((e) => ({
      id: e.id, label: e.label, hp: Math.max(0, Math.round(e.hp)), maxHp: e.maxHp,
      x: e.pos.x, z: e.pos.z, color: e.def.look.color, aware: e.aware, enraged: e.enraged,
      role: e.def.role,
    })),
  }
}

export function subscribeHud(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
export const getHudSnapshot = () => snapshot

export function publishHud() {
  snapshot = buildSnapshot()
  for (const fn of listeners) fn()
}
