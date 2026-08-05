/**
 * ホストとの時刻オフセット推定（NTP風 ping/pong）。
 *
 * performance.now() の起点は端末ごとに違うので、受信した hostTime を
 * そのまま自分の時計と比べると「全部未来」または「全部過去」になる。
 * スナップショットの鮮度(snapshot age)や遅延補正の判断がそこで壊れるため、
 * オフセットを別途推定する。
 *
 *   t0 = 参加者の送信時刻
 *   t1 = ホストの受信時刻
 *   t2 = ホストの返信時刻
 *   t3 = 参加者の受信時刻
 *   RTT    = (t3 - t0) - (t2 - t1)
 *   offset = ((t1 - t0) + (t2 - t3)) / 2
 *
 * 補間そのものは「自分の端末での受信時刻」で行う（interpolation.js）。
 * オフセットが多少ずれても描画が壊れないようにするため、時刻同期は
 * 計測と遅延判断だけに使う。
 */

/** 起動直後は速く、落ち着いたらゆっくり測り直す */
const FAST_INTERVAL_MS = 500
const SLOW_INTERVAL_MS = 8000
const FAST_SAMPLES = 12
/** RTTの小さいサンプルだけを採用する割合 */
const BEST_RATIO = 0.5
const MAX_SAMPLES = 16

export const clock = {
  offsetMs: 0,
  rttMs: 0,
  samples: 0,
  ready: false,
}

let history = []
let nextAt = 0
let seq = 0

export function resetClock() {
  history = []
  nextAt = 0
  seq = 0
  clock.offsetMs = 0
  clock.rttMs = 0
  clock.samples = 0
  clock.ready = false
}

/** 参加者側: 測り直す頃合いなら ping メッセージを返す */
export function dueTimeSync(now = performance.now()) {
  if (now < nextAt) return null
  const interval = clock.samples < FAST_SAMPLES ? FAST_INTERVAL_MS : SLOW_INTERVAL_MS
  nextAt = now + interval
  return { type: 'timeSync', seq: ++seq, t0: now }
}

/** ホスト側: 受信したらそのまま折り返す */
export const answerTimeSync = (m) => ({ type: 'timeSyncReply', seq: m.seq, t0: m.t0, t1: performance.now(), t2: performance.now() })

/** 参加者側: 返信からオフセットを更新する */
export function applyTimeSync(m, now = performance.now()) {
  if (!m || !Number.isFinite(m.t0) || !Number.isFinite(m.t1) || !Number.isFinite(m.t2)) return false
  const rtt = (now - m.t0) - (m.t2 - m.t1)
  if (!Number.isFinite(rtt) || rtt < 0 || rtt > 5000) return false
  const offset = ((m.t1 - m.t0) + (m.t2 - now)) / 2
  history.push({ rtt, offset })
  if (history.length > MAX_SAMPLES) history.shift()

  // RTTが小さいサンプルほど信頼できる。良い方の半分の中央値を採る。
  const best = [...history].sort((a, b) => a.rtt - b.rtt).slice(0, Math.max(1, Math.round(history.length * BEST_RATIO)))
  const offsets = best.map((s) => s.offset).sort((a, b) => a - b)
  const median = offsets[Math.floor(offsets.length / 2)]
  clock.rttMs = Math.round(best[0].rtt * 10) / 10
  clock.samples = history.length
  // 急に書き換えず指数移動平均で寄せる（描画の飛びを防ぐ）
  clock.offsetMs = clock.ready ? clock.offsetMs + (median - clock.offsetMs) * 0.25 : median
  clock.ready = true
  return true
}

/** 自分の時計から見た「ホストの今」 */
export const estimatedHostNow = (now = performance.now()) => now + clock.offsetMs
/** 受信したホスト時刻の鮮度(ms)。時刻同期前は null */
export const hostTimeAge = (hostTime, now = performance.now()) =>
  (clock.ready && Number.isFinite(hostTime) ? estimatedHostNow(now) - hostTime : null)
