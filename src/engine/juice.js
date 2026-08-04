/**
 * 爽快感（ヒットストップ・カメラシェイク・スロー・粉じん・衝撃波）。
 *
 * すべて「規模 scale(0..1)」1つで制御する。通常攻撃は 0.1〜0.2 程度なので
 * ほとんど揺れず、大規模崩壊や爆発だけが強く揺れる。
 * 設定（シェイク量・フラッシュ軽減・モーション軽減）はここで一括して掛ける。
 */
import { sim, addEffect } from './sim.js'
import { JUICE } from '../data/abilities.js'
import { MATERIALS } from '../data/destructibles.js'
import { quality } from './debris.js'

export function initJuice() {
  sim.juice = { hitstop: 0, shake: 0, slowmo: 0, shockwave: 0, shockwaveMax: 0.35 }
}

const j = () => sim.juice || (initJuice(), sim.juice)

/** 攻撃・破壊のインパクトを1か所で受ける */
export function impact(scale, opts = {}) {
  const s = Math.max(0, Math.min(1, scale))
  const st = sim.settings
  const jc = j()
  const motion = st.reducedMotion ? 0.25 : 1
  const shakeMul = (st.shakeAmount ?? 1) * motion

  jc.hitstop = Math.max(jc.hitstop, JUICE.hitstopMax * s * motion)
  if (s >= JUICE.shakeFloor) jc.shake = Math.min(1.4, jc.shake + JUICE.shakeMax * s * shakeMul)
  if (opts.slowmo && s >= JUICE.shockwaveFloor && !st.reducedMotion) {
    jc.slowmo = Math.max(jc.slowmo, JUICE.slowmoMax * s)
  }
  if (s >= JUICE.shockwaveFloor && !st.reducedFlash) {
    jc.shockwave = Math.max(jc.shockwave, jc.shockwaveMax * s)
  }
}

/** 破壊音（Web Audio）。素材と規模で音色を変える。 */
let audioCtx = null
export function playBreakSound(materialType, scale) {
  if (typeof window === 'undefined' || sim.settings.muteSfx) return
  try {
    const AC = window.AudioContext || window.webkitAudioContext
    if (!AC) return
    audioCtx ||= new AC()
    if (audioCtx.state === 'suspended') audioCtx.resume()
    const m = MATERIALS[materialType] || MATERIALS.wood
    const t = audioCtx.currentTime
    const dur = 0.06 + scale * 0.35
    const buf = audioCtx.createBuffer(1, Math.max(1, Math.floor(audioCtx.sampleRate * dur)), audioCtx.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < data.length; i++) {
      const k = 1 - i / data.length
      data[i] = (Math.random() * 2 - 1) * k * k
    }
    const src = audioCtx.createBufferSource()
    src.buffer = buf
    const filter = audioCtx.createBiquadFilter()
    filter.type = materialType === 'glass' ? 'highpass' : 'lowpass'
    filter.frequency.value = materialType === 'glass' ? 2200 : 400 + scale * 1200
    const gain = audioCtx.createGain()
    gain.gain.value = Math.min(0.4, 0.08 + scale * 0.3) * m.volume * (sim.settings.sfxVolume ?? 1)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    src.connect(filter).connect(gain).connect(audioCtx.destination)
    src.start(t)
    src.stop(t + dur)
  } catch { /* 音が出せない環境では黙って諦める */ }
}

/** 粉じん・火花 */
export function dust(x, y, z, materialType, scale) {
  const q = quality()
  const amount = (sim.settings.dustAmount ?? 1) * q.dust
  if (amount <= 0.02) return
  const m = MATERIALS[materialType] || MATERIALS.wood
  addEffect({ kind: 'dust', x, y, z, color: m.dust, radius: 0.7 + scale * 2.4, life: 0.5 + scale * 0.8 })
  if (m.spark > 0.3 && !sim.settings.reducedFlash) {
    addEffect({ kind: 'spark', x, y, z, color: '#fff0b0', radius: 0.5 + scale * 1.2, life: 0.22 })
  }
}

/** 毎フレームの減衰。stepSim の先頭で呼ぶ。 */
export function updateJuice(dt) {
  const jc = j()
  jc.hitstop = Math.max(0, jc.hitstop - dt)
  jc.shake = Math.max(0, jc.shake - dt * 2.6)
  jc.slowmo = Math.max(0, jc.slowmo - dt)
  jc.shockwave = Math.max(0, jc.shockwave - dt * 1.8)
}

/** シミュレーション時間の倍率（ヒットストップ / スロー） */
export function timeScale() {
  const jc = j()
  if (jc.hitstop > 0) return 0.06
  if (jc.slowmo > 0) return JUICE.slowmoScale + (1 - JUICE.slowmoScale) * (1 - Math.min(1, jc.slowmo / JUICE.slowmoMax))
  return 1
}
