/**
 * localStorage セーブ。壊れたデータでもゲームが起動できるよう、
 * 読み込み時は必ず既定値へフォールバックする。
 */
import { SAVE_KEY } from '../data/world.js'
import { sim, say, publishHud } from './sim.js'
import { serializeBroken, applyBroken, resetTown } from './destruct.js'
import { serializeBosses, applyBossSave } from './bosses.js'

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d)

export function collectSave() {
  const p = sim.player
  return {
    version: 1,
    at: Date.now(),
    player: {
      pos: [p.pos.x, p.pos.y, p.pos.z],
      yaw: p.yaw,
      hp: p.hp, maxHp: p.maxHp, mp: p.mp, maxMp: p.maxMp, stamina: p.stamina,
      level: p.level, xp: p.xp, gold: p.gold,
      attack: p.attack, defense: p.defense, magicAttack: p.magicAttack, magicDefense: p.magicDefense,
      skills: [...p.skills], items: { ...p.items }, kills: { ...p.kills }, deaths: p.deaths,
    },
    quests: sim.quests,
    /** 壊した建物の小片。町を復元できるようにIDだけ持つ */
    town: serializeBroken(),
    bosses: serializeBosses(),
    dayTime: sim.dayTime,
    settings: sim.settings,
    stats: sim.stats,
  }
}

export function saveGame(quiet = false) {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(collectSave()))
    if (!quiet) say('セーブしました。', 'save')
    return true
  } catch (err) {
    say('セーブできませんでした（ブラウザの保存領域を確認してください）。', 'error')
    console.warn('save failed', err)
    return false
  }
}

export function hasSave() {
  try { return !!localStorage.getItem(SAVE_KEY) } catch { return false }
}

export function readSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY)
    if (!raw) return null
    const data = JSON.parse(raw)
    if (!data || typeof data !== 'object' || !data.player) return null
    return data
  } catch (err) {
    console.warn('save is corrupted, ignoring', err)
    return null
  }
}

/** セーブを sim に適用する。NavMesh 読み込み後に呼ぶこと。 */
export function applySave(data) {
  if (!data) return false
  const p = sim.player
  const s = data.player || {}
  if (Array.isArray(s.pos) && s.pos.length === 3 && s.pos.every((v) => Number.isFinite(v))) p.pos.fromArray(s.pos)
  p.yaw = num(s.yaw, p.yaw)
  p.maxHp = num(s.maxHp, p.maxHp)
  p.maxMp = num(s.maxMp, p.maxMp)
  p.hp = Math.min(num(s.hp, p.maxHp), p.maxHp)
  p.mp = Math.min(num(s.mp, p.maxMp), p.maxMp)
  p.stamina = Math.min(num(s.stamina, p.maxStamina), p.maxStamina)
  p.level = Math.max(1, Math.round(num(s.level, 1)))
  p.xp = num(s.xp, 0)
  p.gold = num(s.gold, 0)
  p.attack = num(s.attack, p.attack)
  p.defense = num(s.defense, p.defense)
  p.magicAttack = num(s.magicAttack, p.magicAttack)
  p.magicDefense = num(s.magicDefense, p.magicDefense)
  p.deaths = num(s.deaths, 0)
  if (Array.isArray(s.skills) && s.skills.length) p.skills = [...new Set(s.skills)]
  if (s.items && typeof s.items === 'object') p.items = { ...s.items }
  if (s.kills && typeof s.kills === 'object') p.kills = { ...s.kills }
  if (data.quests && typeof data.quests === 'object') {
    for (const [id, q] of Object.entries(data.quests)) {
      if (sim.quests[id] && q && typeof q === 'object') {
        sim.quests[id] = { ...sim.quests[id], ...q, counters: { ...(q.counters || {}) } }
      }
    }
  }
  // 町の破壊状況。まだ町を読み込んでいなければ保留し、登録後に適用する
  if (data.town) applyBroken(data.town)
  else resetTown()
  if (data.bosses) applyBossSave(data.bosses)
  sim.dayTime = num(data.dayTime, sim.dayTime) % 1
  if (data.settings && typeof data.settings === 'object') {
    Object.assign(sim.settings, data.settings)
    delete sim.settings.webSwingMode
  }
  if (data.stats && typeof data.stats === 'object') Object.assign(sim.stats, data.stats)
  p.dead = false
  publishHud()
  return true
}

export function deleteSave() {
  try { localStorage.removeItem(SAVE_KEY) } catch { /* 保存領域が使えない環境 */ }
}
