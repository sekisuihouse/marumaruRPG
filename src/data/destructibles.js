/**
 * 破壊可能オブジェクトの設定。
 *
 * town.glb を実際に走査して得たトップレベル名（125個）だけを使って分類する。
 * 名前は推測せず、scripts/build-destructibles.mjs が出力する対応表と一致させること。
 *
 *   node scripts/build-destructibles.mjs   → public/assets/destructibles.json（対応表・検証用）
 *
 * ランタイムはこのファイルの規則から直接分類するので JSON は必須ではない。
 */

/** 分割の粒度。ワールド m（TOWN.scale=6 適用後）。 */
export const CHUNKING = {
  /** 破片1個のおおよその一辺。小さいほど「殴った所だけ壊れる」が破片は増える。 */
  cell: 1.15,
  /** 1オブジェクトあたりの分割数の上限（巨大メッシュはセルを粗くする） */
  maxCellsPerAxis: 10,
  /** これ未満の三角形しか無いセルは隣へ吸収する */
  minTrisPerChunk: 2,
}

/**
 * トップレベル名 → 分類。上から順に最初に一致したものを採用する。
 * category:
 *   ground / water : 破壊不可（足場）
 *   nature / people / fx : 破壊不可（装飾・住民・演出）
 *   building : 建物（壁・屋根・窓に細分）
 *   structure: 柱状の構造物（鳥居・信号・遊具）
 *   prop     : 小物（車・自転車・箱）
 */
export const CATEGORY_RULES = [
  // ── 足場（絶対に壊さない）
  { re: /^(地面|ふち|駐車場地面|ガソスタ地面|土|棚田|畑|Loop|NURBSパス)/, category: 'ground' },
  { re: /^(川)$/, category: 'water' },
  { re: /^川岩/, category: 'ground' },
  // ── 自然物・住民・演出（壊さない）
  { re: /^(杉|イチョウ|すだち)(?!箱)/, category: 'nature' },
  { re: /^花火/, category: 'fx' },
  { re: /^(歩く|お話|聞き手|店員|作業|寝転がり|天を仰ぐ|スコップで掘る|阿波踊り|おてあげ人)/, category: 'people' },
  // ── 建物
  { re: /^(古民家|カフェ|温泉|コンビニ|パン屋|集会所|HOME|ROOMS|Office|ガソスタ$|社$|キャンプ|ステージ|物販|マルシェ|飲食|学生体験)/, category: 'building' },
  // ── 柱・構造物
  { re: /^(鳥居|一方通行|ガードレール|ぼうつき|滑り台|ブランコ)/, category: 'structure' },
  // ── 小物
  { re: /^(トラック|車|Bus|自転車|すだち箱)/, category: 'prop' },
]

/** 上のどれにも当たらなかった名前の既定。安全側（壊さない）に倒す。 */
export const DEFAULT_CATEGORY = 'nature'

/** 破壊対象にする分類 */
export const BREAKABLE = new Set(['building', 'structure', 'prop'])

/**
 * 部位ごとの基本値。building は高さから wall / roof / pillar / window を自動判定する。
 *  hp             破壊に必要な累積ダメージ
 *  mass           破片の重さ（初速と減衰に効く）
 *  breakThreshold これ未満の単発ダメージは弾く（硬さ）
 *  materialType   音・粉じんの種類
 *  debrisImpulse  破壊時に飛ぶ強さの倍率
 *  chainBreakRadius 連鎖して衝撃が伝わる半径(m)
 */
export const PART_STATS = {
  wall: { hp: 55, mass: 2.4, breakThreshold: 4, materialType: 'wood', debrisImpulse: 1.0, chainBreakRadius: 1.6 },
  roof: { hp: 40, mass: 1.8, breakThreshold: 3, materialType: 'tile', debrisImpulse: 1.25, chainBreakRadius: 2.0 },
  pillar: { hp: 90, mass: 4.0, breakThreshold: 8, materialType: 'stone', debrisImpulse: 0.8, chainBreakRadius: 2.4 },
  window: { hp: 16, mass: 0.7, breakThreshold: 1, materialType: 'glass', debrisImpulse: 1.6, chainBreakRadius: 1.2 },
  sign: { hp: 24, mass: 1.0, breakThreshold: 2, materialType: 'metal', debrisImpulse: 1.4, chainBreakRadius: 1.2 },
  floor: { hp: 120, mass: 5.0, breakThreshold: 12, materialType: 'stone', debrisImpulse: 0.6, chainBreakRadius: 1.4 },
  prop: { hp: 30, mass: 1.4, breakThreshold: 2, materialType: 'metal', debrisImpulse: 1.5, chainBreakRadius: 1.4 },
}

/** 分類ごとの倍率（同じ壁でも小屋と大きな建物で硬さを変える） */
export const CATEGORY_MUL = {
  building: { hp: 1.0, mass: 1.0 },
  structure: { hp: 1.35, mass: 1.2 },
  prop: { hp: 0.7, mass: 0.8 },
}

/** 材質ごとの演出 */
export const MATERIALS = {
  wood: { dust: '#c9a06a', spark: 0.1, volume: 0.9 },
  tile: { dust: '#b8b2a4', spark: 0.15, volume: 1.0 },
  stone: { dust: '#cfcfcf', spark: 0.2, volume: 1.15 },
  glass: { dust: '#d8f2ff', spark: 0.5, volume: 0.7 },
  metal: { dust: '#a8b4bd', spark: 0.8, volume: 1.05 },
}

/** 破片・物理の上限。品質切り替えで差し替える。 */
export const DEBRIS_QUALITY = {
  high: { maxDebris: 160, perHit: 10, dust: 1.0, lifeSmall: 9, lifeBig: 26 },
  medium: { maxDebris: 90, perHit: 6, dust: 0.6, lifeSmall: 7, lifeBig: 20 },
  low: { maxDebris: 40, perHit: 3, dust: 0.25, lifeSmall: 5, lifeBig: 14 },
}

export const DEBRIS_PHYSICS = {
  gravity: 22,
  restitution: 0.26,
  friction: 0.72,
  angularDamp: 0.55,
  sleepSpeed: 0.35,
  sleepTime: 1.1,
  /** 破片がプレイヤー/敵に当たったときの最大ダメージ（即死防止） */
  maxContactDamage: 9,
  contactCooldown: 0.6,
  /** これより遠い破片は物理を止める(m) */
  simRadius: 70,
  /** 小片とみなす体積のしきい値 */
  smallVolume: 1.1,
}

/** 名前から分類を引く */
export function categoryOf(topName) {
  for (const r of CATEGORY_RULES) if (r.re.test(topName)) return r.category
  return DEFAULT_CATEGORY
}

export const isBreakable = (topName) => BREAKABLE.has(categoryOf(topName))

/**
 * 建物内の部位を、オブジェクトのバウンディングボックス内での位置と形から決める。
 * 名前が「立方体005_3」のように意味を持たないので、形状から判定する。
 */
export function partTypeOf(category, chunk, objBox) {
  if (category === 'prop') return 'prop'
  const h = Math.max(0.001, objBox.maxY - objBox.minY)
  const rel = (chunk.cy - objBox.minY) / h
  const w = Math.max(chunk.hx, chunk.hz) * 2
  const tall = chunk.hy * 2
  if (category === 'structure') {
    return tall > w * 1.6 ? 'pillar' : 'sign'
  }
  // 細く高い断片は柱（鳥居の柱・建物の支柱）
  if (tall > w * 1.9 && rel < 0.7) return 'pillar'
  if (rel > 0.68) return 'roof'
  if (rel < 0.08) return 'floor'
  // 薄い板はガラス（窓）扱いにして派手に割れるようにする
  if (Math.min(chunk.hx, chunk.hz) * 2 < 0.18) return 'window'
  return 'wall'
}

/** 部位の最終ステータス */
export function statsFor(category, partType, volume) {
  const base = PART_STATS[partType] || PART_STATS.wall
  const mul = CATEGORY_MUL[category] || CATEGORY_MUL.building
  const sizeMul = Math.min(3, Math.max(0.35, Math.cbrt(Math.max(0.05, volume))))
  return {
    hp: Math.round(base.hp * mul.hp * sizeMul),
    mass: +(base.mass * mul.mass * sizeMul).toFixed(3),
    breakThreshold: base.breakThreshold,
    materialType: base.materialType,
    debrisImpulse: base.debrisImpulse,
    chainBreakRadius: base.chainBreakRadius,
  }
}
