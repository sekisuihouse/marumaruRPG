/**
 * リモートプレイヤーの補間バッファ。
 *
 * 受信した最新位置へ即座に飛ばすと、ジッタがそのまま瞬間移動として見える。
 * 少し過去（interpolationDelay 分）の状態を描画し、間を補間する。
 *
 * 時刻は hostTime ではなく「この端末での受信時刻」で扱う。
 * performance.now() の起点は端末ごとに違うため、ネット越しの hostTime を
 * そのまま補間に使うと別端末で数分間初期位置に固定され得る。
 */
import { netStats } from './diagnostics.js'

/** バッファに残す件数。多いほど遅延・損失に強いが、メモリと描画遅延が増える */
const MAX_SAMPLES = 8
/** 次のスナップショットが来ていないときに延長してよい上限(ms)。
 *  長く伸ばすと衝突・ノックバック時に大きく外して引き戻される。 */
const MAX_EXTRAPOLATION_MS = 100

const stamp = (s) => s.receivedAt ?? s.hostTime

export function resetSamples(entity) {
  entity.samples = []
}

/**
 * サンプルを時刻順に挿入する。
 * Unordered チャネルでは後から古いものが届くのが正常なので、
 * 「古いから捨てる」ではなく「順に並べる」で扱う（補間に必要な過去点を失わないため）。
 */
export function pushSample(entity, sample) {
  const samples = entity.samples || (entity.samples = [])
  // 同じ sequence の重複だけは弾く
  for (const s of samples) if (s.sequence === sample.sequence) return false
  let i = samples.length
  while (i > 0 && stamp(samples[i - 1]) > stamp(sample)) i--
  samples.splice(i, 0, sample)
  while (samples.length > MAX_SAMPLES) samples.shift()
  return true
}

export function interpolate(entity, renderTime) {
  const a = entity.samples || []
  if (!a.length) return entity
  netStats.interpolationFrames++

  const newest = a[a.length - 1]
  // ── 描画したい時刻がバッファの先を追い越した（＝次がまだ届いていない）
  if (renderTime > stamp(newest)) {
    netStats.interpolationUnderrun++
    const ahead = Math.min(MAX_EXTRAPOLATION_MS, renderTime - stamp(newest)) / 1000
    const v = newest.velocity || [0, 0, 0]
    entity.x = newest.position[0] + v[0] * ahead
    entity.y = newest.position[1] + v[1] * ahead
    entity.z = newest.position[2] + v[2] * ahead
    entity.yaw = newest.rotation
    entity.anim = newest.animationState
    return entity
  }

  // ── renderTime を挟む2点を探して線形補間する
  let after = newest
  let before = a[0]
  for (let i = 0; i < a.length; i++) {
    if (stamp(a[i]) >= renderTime) { after = a[i]; before = a[Math.max(0, i - 1)]; break }
  }
  const span = Math.max(1, stamp(after) - stamp(before))
  const t = Math.max(0, Math.min(1, (renderTime - stamp(before)) / span))
  entity.x = before.position[0] + (after.position[0] - before.position[0]) * t
  entity.y = before.position[1] + (after.position[1] - before.position[1]) * t
  entity.z = before.position[2] + (after.position[2] - before.position[2]) * t
  // 角度は最短回りで補間する（πをまたぐと逆向きに回って見えるため）
  let d = after.rotation - before.rotation
  d = Math.atan2(Math.sin(d), Math.cos(d))
  entity.yaw = before.rotation + d * t
  entity.anim = after.animationState
  return entity
}
