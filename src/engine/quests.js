/**
 * クエスト進行と会話分岐。
 * NPCとの会話ノードは quests.js(data) の定義をそのまま辿る。
 */
import { QUESTS, NPCS, ITEMS } from '../data/quests.js'
import { sim, say, gainXp, publishHud } from './sim.js'
import { findLandmark } from './nav.js'

const questDef = (id) => QUESTS.find((q) => q.id === id)
export const npcDef = (id) => NPCS.find((n) => n.id === id)

export const activeQuests = () => Object.values(sim.quests).filter((q) => q.state === 'active')

export function currentStep(q) {
  const def = questDef(q.id)
  return def?.steps[q.step] || null
}

export function startQuest(id) {
  const q = sim.quests[id]
  if (!q || q.state === 'active' || q.state === 'done') return
  q.state = 'active'
  q.step = 0
  q.counters = {}
  const def = questDef(id)
  say(`クエスト開始: ${def.title} — ${def.steps[0].label}`, 'quest')
  publishHud()
}

export function advanceQuest(id) {
  const q = sim.quests[id]
  const def = questDef(id)
  if (!q || !def || q.state !== 'active') return
  q.step++
  if (q.step >= def.steps.length) {
    q.state = 'done'
    if (def.reward) {
      if (def.reward.gold) sim.player.gold += def.reward.gold
      if (def.reward.xp) gainXp(def.reward.xp)
    }
    say(`クエスト達成: ${def.title}！`, 'quest')
    if (id === 'q_tutorial') {
      sim.tutorialCompleteUntil = sim.time + 5
      say('レベルアップすると攻撃が増えるよ！', 'level')
    }
  } else {
    say(`次の目標: ${def.steps[q.step].label}`, 'quest')
  }
  publishHud()
}

/** 敵撃破をクエストに反映 */
export function notifyKill(typeId) {
  for (const q of activeQuests()) {
    const step = currentStep(q)
    if (!step || step.kind !== 'kill' || step.typeId !== typeId) continue
    q.counters[typeId] = (q.counters[typeId] || 0) + 1
    if (q.counters[typeId] >= step.count) advanceQuest(q.id)
    else say(`${questDef(q.id).title}: ${q.counters[typeId]}/${step.count}`, 'quest')
  }
}

/** 到達チェック(visit ステップ) */
export function updateQuests() {
  const p = sim.player
  for (const q of activeQuests()) {
    const step = currentStep(q)
    if (!step) continue
    if (step.kind === 'visit') {
      const lm = findLandmark(step.landmark)
      if (!lm) continue
      const d = Math.hypot(p.pos.x - lm.center[0], p.pos.z - lm.center[2])
      if (d < lm.radius + 4) advanceQuest(q.id)
    } else if (step.kind === 'collect') {
      if ((p.items[step.itemId] || 0) >= step.count) advanceQuest(q.id)
    } else if (step.kind === 'action' && p.tutorialActions?.[step.action]) {
      advanceQuest(q.id)
    }
  }
}

/** クエストマーカー(ミニマップ用)。今の目標地点を返す。 */
export function questMarkers() {
  const out = []
  for (const q of activeQuests()) {
    const def = questDef(q.id)
    const step = currentStep(q)
    if (!step) continue
    if (step.kind === 'visit') {
      const lm = findLandmark(step.landmark)
      if (lm) out.push({ x: lm.center[0], z: lm.center[2], label: def.title, kind: 'visit' })
    } else if (step.kind === 'talk') {
      const npc = sim.npcs.find((n) => n.id === step.npcId)
      if (npc) out.push({ x: npc.pos.x, z: npc.pos.z, label: def.title, kind: 'talk' })
    }
  }
  return out
}

// ───────────────────────────── 会話

/** その NPC がいま話すべきノードを決める */
function nodeForNpc(npcId) {
  const def = npcDef(npcId)
  if (!def) return null
  // この NPC への報告待ちクエストがあるか
  for (const q of activeQuests()) {
    const step = currentStep(q)
    if (step?.kind === 'talk' && step.npcId === npcId) return 'done'
  }
  // 進行中のクエストの依頼主なら progress
  const own = QUESTS.filter((q) => q.giver === npcId)
  if (own.some((q) => sim.quests[q.id]?.state === 'active')) return 'progress'
  if (own.length && own.every((q) => sim.quests[q.id]?.state === 'done')) return 'greet'
  return def.root
}

export function openDialogue(npcId) {
  const def = npcDef(npcId)
  if (!def) return
  const nodeId = nodeForNpc(npcId)
  sim.dialogue = { npcId, nodeId, name: def.name, role: def.role }
  sim.mode = 'dialogue'
  publishHud()
}

export function dialogueView() {
  if (!sim.dialogue) return null
  const def = npcDef(sim.dialogue.npcId)
  const node = def?.nodes[sim.dialogue.nodeId]
  if (!node) return null
  return {
    name: def.name,
    role: def.role,
    text: node.text,
    choices: node.choices.map((c, i) => ({ index: i, label: c.label })),
  }
}

export function chooseDialogue(index) {
  if (!sim.dialogue) return
  const def = npcDef(sim.dialogue.npcId)
  const node = def?.nodes[sim.dialogue.nodeId]
  const choice = node?.choices[index]
  if (!choice) return

  if (choice.quest) startQuest(choice.quest)
  if (choice.advance) {
    for (const q of activeQuests()) {
      const step = currentStep(q)
      if (step?.kind === 'talk' && step.npcId === sim.dialogue.npcId) { advanceQuest(q.id); break }
    }
  }
  if (choice.reward) {
    const r = choice.reward
    if (r.gold) sim.player.gold += r.gold
    if (r.xp) gainXp(r.xp)
    if (r.item) {
      sim.player.items[r.item] = (sim.player.items[r.item] || 0) + 1
      say(`${ITEMS[r.item]?.label || r.item} を受け取った。`, 'loot')
    }
  }
  if (choice.text) say(`${def.name}「${choice.text}」`, 'talk')

  if (choice.close || !choice.next) {
    closeDialogue()
  } else {
    sim.dialogue.nodeId = choice.next
  }
  publishHud()
}

export function closeDialogue() {
  sim.dialogue = null
  if (sim.mode === 'dialogue') sim.mode = 'play'
  publishHud()
}

/** アイテム使用 */
export function useItem(id) {
  const p = sim.player
  if (!(p.items[id] > 0)) return
  const item = ITEMS[id]
  if (!item) return
  if (!item.heal && !item.mp && !item.attack) { say(`${item.label} は素材だ。`, 'info'); return }
  if (item.heal) p.hp = Math.min(p.maxHp, p.hp + item.heal)
  if (item.mp) p.mp = Math.min(p.maxMp, p.mp + item.mp)
  if (item.attack) { p.attack += item.attack; say(`攻撃力が ${item.attack} 上がった。`, 'level') }
  p.items[id]--
  if (p.items[id] <= 0) delete p.items[id]
  say(`${item.label} を使った。`, 'info')
  publishHud()
}
