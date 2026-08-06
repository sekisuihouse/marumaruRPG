/**
 * スマホは横画面必須。縦向きのあいだはゲームを覆って進行を止める。
 *
 * 画面の向きは Screen Orientation API で固定できるが、Chrome(Android)は
 * 全画面のときしか受け付けず、iOS Safari は未対応。そのため
 *
 *   1. 全画面 + 向きロックを試す（効く端末では回転しても横のまま）
 *   2. 効かない端末でも、縦のあいだは必ずこの覆いを出して遊ばせない
 *
 * の二段構えにする。1が失敗しても2で必ず横画面になる。
 */
import React, { useEffect, useState } from 'react'
import { sim } from '../engine/sim.js'
import { clearKeys, isTouchDevice } from '../engine/input.js'

const isPortrait = () => (typeof window === 'undefined' ? false : window.innerHeight > window.innerWidth)

/** 全画面にしてから横向きへ固定する。ユーザー操作の直後にだけ通る。 */
export async function lockLandscape() {
  try {
    const el = document.documentElement
    if (!document.fullscreenElement && el.requestFullscreen) {
      await el.requestFullscreen({ navigationUI: 'hide' })
    }
  } catch { /* 全画面を拒否する端末・設定がある */ }
  try {
    await window.screen?.orientation?.lock?.('landscape')
    return true
  } catch { /* iOS Safari など、向きの固定に未対応 */ }
  return false
}

export function OrientationGate() {
  const [touch] = useState(isTouchDevice)
  const [portrait, setPortrait] = useState(isPortrait)

  useEffect(() => {
    if (!touch) return
    const update = () => setPortrait(isPortrait())
    // orientationchange の直後はまだ旧サイズを返す端末があるので、resize でも見る
    window.addEventListener('resize', update)
    window.addEventListener('orientationchange', update)
    const timer = setInterval(update, 500)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('orientationchange', update)
      clearInterval(timer)
    }
  }, [touch])

  // 縦のあいだは進行を止める。回転させている間に敵にやられないようにする。
  useEffect(() => {
    if (!touch) return
    const blocked = portrait
    sim.orientationBlocked = blocked
    if (blocked) clearKeys()
    return () => { sim.orientationBlocked = false }
  }, [touch, portrait])

  if (!touch || !portrait) return null
  return (
    <div className="orientation-gate" role="alertdialog" aria-live="assertive" aria-label="横画面にしてください">
      <div className="orientation-box">
        <i className="orientation-icon" aria-hidden="true" />
        <b>横画面にしてください</b>
        <p>このゲームは横向き専用です。<br />端末を横に回してください。</p>
        <button type="button" onClick={lockLandscape}>全画面にして横向きで固定</button>
        <small>固定できない端末では、本体の「画面の向きのロック」を解除してから回してください。</small>
      </div>
    </div>
  )
}
