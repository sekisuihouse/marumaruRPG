/**
 * 建物の崩壊から現れる、祭の架空守護者たち。
 *
 * 3Dモデルは配布PMXを scripts/build-bosses.mjs で GLB へ変換したものを使う。
 *   source        … 変換元フォルダ（bos 3Dmoderu/<dir>/*.pmx）。配布物は public に置かない。
 *   modelPath     … 変換後のGLB。ランタイムが読むのはこれだけ。
 *   displayHeight … ゲーム内での身長(m)。GLBは高さ1.0に正規化済みなので、この値がそのまま倍率になる。
 */
import { assetUrl } from './world.js'
export const BOSS_SCALING = {
  hpMultiplier: (n) => 1 + n * 0.25,
  damageMultiplier: (n) => 1 + n * 0.15,
  speedMultiplier: (n) => 1 + n * 0.06,
  attackRateMultiplier: (n) => 1 + n * 0.08,
  destructionMultiplier: (n) => 1 + n * 0.15,
}

const attack = (id, kind, power, range, extra = {}) => ({
  id, kind, power, range, windup: 0.7, recover: 0.65,
  characterDamage: power, structureDamage: power * 1.3, debrisImpulse: 1.5,
  breakRadius: kind === 'aoe' ? range : 2.4, ...extra,
})

export const BOSS_TYPES = {
  student: {
    id: 'student', implementationId: 'studentExperienceBoss', name: '学生体験ボス・試作機の案内人', areaId: 'student', objectName: '学生体験',
    modelPath: assetUrl('assets/bosses/glb/student.glb'),
    source: { dir: 'gakuseitaiken' }, displayHeight: 3.4, scale: 0.18, baseHp: 980,
    baseDamage: 34, moveSpeed: 6.8, hitRadius: 0.95, phaseThreshold: 0.5, spawnDestroyRatio: 0.65,
    color: '#72e4ff', weakness: 'thunder', staggerRules: { overheatHits: 3, vulnerable: 6 },
    reward: { xp: 330, gold: 180, item: 'prototype_core', label: '試作コア' },
    abilities: [
      attack('drone', 'bolt', 28, 18, { color: '#72e4ff', label: '試作ドローン', telegraph: 'cyan-orbit' }),
      attack('spring', 'charge', 42, 12, { color: '#b9ff62', label: 'バネ跳躍', breakRadius: 3.2 }),
      attack('runaway', 'aoe', 54, 5.4, { color: '#ffb15f', label: '暴走試作機', windup: 1.05 }),
      attack('mimic', 'arc', 38, 3.6, { color: '#f6f1ff', label: '模倣ハンマー' }),
    ],
  },
  stage: {
    id: 'stage', implementationId: 'stageBoss', name: 'ステージボス・リズムの演出家', areaId: 'stage', objectName: 'ステージ',
    modelPath: assetUrl('assets/bosses/glb/stage.glb'),
    source: { dir: 'stage' }, displayHeight: 3.6, scale: 0.16, baseHp: 1120,
    baseDamage: 39, moveSpeed: 4.8, hitRadius: 1.0, phaseThreshold: 0.5, spawnDestroyRatio: 0.65,
    color: '#f36fff', weakness: 'thunder', staggerRules: { interruptWindow: true, vulnerable: 5 },
    reward: { xp: 370, gold: 210, item: 'stage_pass', label: '共鳴パス' },
    abilities: [
      attack('beat', 'aoe', 36, 5.5, { color: '#f36fff', label: '音波リング', windup: 1.0 }),
      attack('spotlight', 'aoe', 58, 4.0, { color: '#fff06a', label: 'スポットライト落下', windup: 1.35 }),
      attack('speaker', 'bolt', 31, 21, { color: '#72e4ff', label: 'スピーカー衝撃波' }),
      attack('encore', 'arc', 48, 4.2, { color: '#ff5e8e', label: 'アンコールスマッシュ' }),
    ],
  },
  shrine: {
    id: 'shrine', implementationId: 'shrineBoss', name: '神社ボス・境界の守護者', areaId: 'shrine', objectName: '社',
    modelPath: assetUrl('assets/bosses/glb/shrine.glb'),
    source: { dir: 'shrain' }, displayHeight: 4.0, scale: 0.15, baseHp: 1350,
    baseDamage: 48, moveSpeed: 3.6, hitRadius: 1.12, phaseThreshold: 0.5, spawnDestroyRatio: 0.65,
    color: '#ffd36a', weakness: 'dark', staggerRules: { coreHits: 3, vulnerable: 7 },
    reward: { xp: 430, gold: 250, item: 'boundary_seal', label: '境界の印' },
    abilities: [
      attack('sweep', 'arc', 52, 4.8, { color: '#ffd36a', label: '重い薙ぎ払い', breakRadius: 3.8 }),
      attack('quake', 'aoe', 66, 6.2, { color: '#d8a66a', label: '地鎮の衝撃', windup: 1.25, breakRadius: 6.2 }),
      attack('ofuda', 'bolt', 35, 20, { color: '#fff3c4', label: '追尾札' }),
      attack('gate', 'charge', 45, 15, { color: '#b58cff', label: '鳥居渡り', breakRadius: 4 }),
    ],
  },
  food: {
    id: 'food', implementationId: 'foodBoss', name: '飲食ボス・灼熱の料理長', areaId: 'food', objectName: '飲食',
    modelPath: assetUrl('assets/bosses/glb/food.glb'),
    source: { dir: 'food' }, displayHeight: 3.0, scale: 0.2, baseHp: 1060,
    baseDamage: 42, moveSpeed: 4.7, hitRadius: 1.0, phaseThreshold: 0.5, spawnDestroyRatio: 0.65,
    color: '#ff7b3f', weakness: 'water', staggerRules: { interruptWindow: true, vulnerable: 5 },
    reward: { xp: 390, gold: 230, item: 'chef_medal', label: '料理長の勲章' },
    abilities: [
      attack('flame', 'bolt', 34, 18, { color: '#ff7b3f', label: '火炎噴射' }),
      attack('pan', 'arc', 48, 4.0, { color: '#ffd166', label: '巨大フライパン', breakRadius: 3.5 }),
      attack('oil', 'aoe', 45, 4.8, { color: '#ff9d3d', label: '熱い油', windup: 1.1 }),
      attack('boil', 'aoe', 62, 6.0, { color: '#ff4f42', label: '火柱', windup: 1.35, breakRadius: 5.2 }),
      attack('cook', 'recover', 0, 0, { color: '#8dff9b', label: '回復料理', windup: 1.45, recover: 0.45, characterDamage: 0, structureDamage: 0, breakRadius: 0 }),
    ],
  },
}

export const BOSS_LIST = Object.values(BOSS_TYPES)
