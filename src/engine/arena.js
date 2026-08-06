/**
 * ボス戦のアリーナ封鎖。
 *
 * ボスが出た瞬間に、ボスを中心とした**閉じた戦場**を作る。橋を通行止めにしたうえで
 * 「そこから歩いて行ける範囲」だけを場内とし、外側は全部ATフィールドで塞ぐ。
 * 川べりを膨らませるだけの旧実装は、川の端を大きく迂回して対岸へ回り込めていた
 * （実測: 封鎖しても町全体が1つの連結成分のままだった）。同時に通常の敵の湧きを
 * 止め、ボス戦のBGMへ切り替える。
 *
 * 壁は地上だけでなく空中にも効く（arenaBlocksPoint / arenaBlocksSegment）。
 * ウェブスイングは NavMesh を無視して飛ぶので、そちらから明示的に呼んで止める。
 *
 * 解除の条件は2つ。
 *   撃破     → 封鎖を解く。出現元の建物は壊れたままにする（再戦させない）
 *   戦闘中に死亡 → 封鎖を解き、ボスを消し、出現元の建物を直す
 *                  （もう一度壊せば、また同じボスが出る）
 *
 * 通行判定はベイク済みの NavMesh を書き換えず、nav.js のマスクで被せる。
 * 建物破壊による開通と混ざらないので、解除は「マスクを捨てるだけ」で済む。
 */
import { sim, say, addEffect } from './sim.js'
import {
  arenaRegion, riverCrossings, setArenaMask, clearArenaMask, isArenaBlocked,
  cellIndexAt, cellCenter, cellGroundY, cellSize, isNavReady, nearestWalkable,
} from './nav.js'
import { playMusic, stopMusic } from './music.js'

export const ARENA = {
  /** 闘技場の半径(m)。ボスを中心に、ここまで歩ける範囲だけが戦場になる。 */
  radius: 42,
  /** プレイヤーが場外になってしまうときに広げる上限(m) */
  maxRadius: 84,
  /** ATフィールドの高さ(m)。見た目と当たり判定で同じ値を使う。 */
  wallHeight: 22,
  /** 橋とみなす「左右の水までの距離」(セル)と、塞ぐ厚み(セル) */
  bridgeSpan: 10,
  bridgePlug: 4,
  /** 封鎖時に、この距離より遠い通常敵は引き上げさせる */
  despawnRadius: 26,
  music: 'bossChase',
}

export function initArena() {
  sim.arena = { active: false, bossId: null, since: 0, blockedCells: 0, panels: [], center: null }
  clearArenaMask()
}

const arena = () => sim.arena || (initArena(), sim.arena)

/** 橋の位置は地形だけで決まるので1度だけ計算して覚えておく */
let bridgeCells = null
const crossings = () => (bridgeCells ||= riverCrossings(ARENA.bridgeSpan, ARENA.bridgePlug))

/**
 * 中心から届く範囲で闘技場を作る。プレイヤーが場外になるときだけ半径を広げる。
 * それでも入らなければ（対岸にいる等）プレイヤーを中心にして作り直す。
 */
function buildArena(center, player, initialRadius = ARENA.radius) {
  const bridges = crossings()
  // 空中（建物の上など）に居ても判定できるよう、最寄りの歩けるセルで見る
  const foot = nearestWalkable(player.x, player.z)
  const k = cellIndexAt(foot.x, foot.z)
  let last = null
  for (let radius = initialRadius; radius <= ARENA.maxRadius; radius *= 1.5) {
    last = arenaRegion(center.x, center.z, radius, { crossings: bridges })
    if (last.reached > 0 && k >= 0 && last.inside[k]) return { region: last, center, radius }
  }
  // プレイヤーが遠すぎる（対岸など）。ボス周りに場が作れているならそのまま最大半径で閉じ、
  // ボスの足元が塞がっているときだけプレイヤー側で閉じる。
  if (last && last.reached > 1) return { region: last, center, radius: ARENA.maxRadius }
  return {
    region: arenaRegion(foot.x, foot.z, ARENA.maxRadius, { crossings: bridges }),
    center: { x: foot.x, z: foot.z }, radius: ARENA.maxRadius,
  }
}

/** ボス戦の封鎖を開始する */
export function lockArena(boss) {
  const a = arena()
  if (a.active) return false
  const wanted = boss?.pos ? { x: boss.pos.x, z: boss.pos.z } : { x: sim.player.pos.x, z: sim.player.pos.z }
  const built = isNavReady() ? buildArena(wanted, sim.player.pos, Math.min(ARENA.maxRadius, boss?.def?.arenaRadius || ARENA.radius)) : null
  const region = built?.region
  const center = built?.center || wanted
  if (!region || !region.reached) {
    // NavMesh が無いときでも戦闘自体は成立させる（封鎖だけ諦める）
    a.active = true; a.bossId = boss?.id ?? null; a.since = sim.time
    playMusic(ARENA.music)
    return true
  }
  // 場外は「歩けない」で表す。水面・地形外もまとめて場外扱いにするので、
  // 空中を飛んでいても同じ判定で弾ける。
  const mask = new Uint8Array(region.inside.length)
  for (let k = 0; k < mask.length; k++) mask[k] = region.inside[k] ? 0 : 1
  // home: 場外へ出てしまったときの戻り先。center/radius: 封鎖中に壊して開通した
  // セルを場内へ取り込む範囲（これが無いと壊した建物の当たり判定が残る）。
  setArenaMask(mask, { home: center, center, radius: built.radius })

  const size = cellSize()
  a.active = true
  a.bossId = boss?.id ?? null
  a.since = sim.time
  // 板は「中心を向く壁」として立てるので、中心を残しておく
  a.center = { x: center.x, z: center.z }
  a.blockedCells = region.blocked.length
  a.panels = region.panels.map((k) => {
    const c = cellCenter(k)
    return { x: c.x, z: c.z, y: cellGroundY(k) ?? (boss?.pos?.y ?? 0), size }
  })

  // 通常の敵を引き上げさせる（ボスに集中できるように）
  retreatEnemies()
  playMusic(ARENA.music)
  say('ATフィールド展開。橋も封じた——逃げ場はない。', 'boss')
  addEffect({
    kind: 'ring', x: sim.player.pos.x, y: sim.player.pos.y + 0.1, z: sim.player.pos.z,
    radius: 6, color: '#ffb15f', life: 0.9,
  })
  return true
}

/** 封鎖を解く */
export function unlockArena(reason = 'clear') {
  const a = arena()
  if (!a.active) return false
  clearArenaMask()
  a.active = false
  a.bossId = null
  a.panels = []
  a.center = null
  a.blockedCells = 0
  stopMusic()
  if (reason === 'clear') say('ATフィールドが消えた。橋を渡れるようになった。', 'boss')
  else say('ATフィールドが解けた。町は元の姿へ戻った。', 'info')
  return true
}

export const isArenaLocked = () => !!sim.arena?.active
export const arenaPanels = () => sim.arena?.panels || []

/**
 * ATフィールドの当たり判定。場外セルの上、壁の高さまでを塞ぐ。
 * 地上の移動は nav 側のマスクで止まるが、ウェブスイングのように
 * NavMesh を無視して飛ぶ移動はここで止める。
 */
export function arenaBlocksPoint(x, y, z) {
  if (!sim.arena?.active) return false
  const k = cellIndexAt(x, z)
  if (k < 0) return true                       // 地形の外は常に場外
  if (!isArenaBlocked(k)) return false
  const top = (cellGroundY(k) ?? y) + ARENA.wallHeight
  return y < top
}

/**
 * 線分がATフィールドを横切るか。高速移動でも1フレームで壁を飛び越えないよう、
 * セル幅より細かく刻んで調べる。
 */
export function arenaBlocksSegment(x0, y0, z0, x1, y1, z1) {
  if (!sim.arena?.active) return false
  const dist = Math.hypot(x1 - x0, z1 - z0)
  const steps = Math.max(1, Math.ceil(dist / Math.max(0.2, cellSize() * 0.8)))
  for (let s = 1; s <= steps; s++) {
    const t = s / steps
    if (arenaBlocksPoint(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, z0 + (z1 - z0) * t)) return true
  }
  return false
}

/**
 * ボス戦中は通常の敵を減らす。
 * 遠い敵はその場から引き上げ（＝退場）させ、近い敵はそのまま戦わせる。
 */
function retreatEnemies() {
  const p = sim.player
  let removed = 0
  for (const e of sim.enemies) {
    if (!e.alive || e.state === 'dead') continue
    if (e.pos.distanceTo(p.pos) < ARENA.despawnRadius) continue
    e.alive = false
    e.respawnAt = Infinity      // 封鎖が解けるまで戻らない
    removed++
  }
  return removed
}

/** 封鎖が解けたら、止めていた敵の復帰を予約し直す */
export function resumeEnemies(delay = 3) {
  let resumed = 0
  for (const e of sim.enemies) {
    if (e.alive || e.respawnAt !== Infinity) continue
    e.respawnAt = sim.time + delay + Math.random() * 6
    resumed++
  }
  return resumed
}
