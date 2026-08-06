/**
 * スマホは横画面専用。ただし縦のまま締め出すのではなく、画面ごと90°回して出す。
 *
 * 端末の「画面の向きのロック」がONだと、本体を横に倒してもOSは回してくれない。
 * そこで縦向きを検出したら、アプリ全体を横向きレイアウトのまま90°回して描く。
 *
 *   ・向きロックOFFの人 … 本体を倒すとOSが回す → 縦でなくなるので回転は自動で解除される
 *   ・向きロックONの人  … OSは回さないが、こちらが回してあるので倒せば正しく見える
 *
 * どちらも「本体を倒す」だけで正しい向きになる。
 *
 * 指の座標は画面座標で届くので、回しているあいだは MobileControls 側で
 * 同じだけ回して受け取る（localPoint）。変換式はここの transform と対になっている。
 */
import React, { useEffect, useState } from 'react'
import { sim } from '../engine/sim.js'
import { isTouchDevice } from '../engine/input.js'

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

/**
 * 縦向きのあいだ、アプリ全体へ当てる回転スタイルを返す。
 * vh/vw はモバイルのアドレスバーで揺れるので、実測値でサイズを決める。
 */
export function useScreenRotation() {
  const [touch] = useState(isTouchDevice)
  const [size, setSize] = useState(() => ({ w: 0, h: 0, portrait: false }))

  useEffect(() => {
    if (!touch) return
    const update = () => setSize({ w: window.innerWidth, h: window.innerHeight, portrait: isPortrait() })
    update()
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

  const rotated = touch && size.portrait && size.w > 0
  useEffect(() => {
    sim.screenRotated = !!rotated
    return () => { sim.screenRotated = false }
  }, [rotated])

  if (!rotated) return { rotated: false, style: undefined }
  return {
    rotated: true,
    style: {
      position: 'fixed',
      top: 0,
      left: 0,
      width: `${size.h}px`,
      height: `${size.w}px`,
      transformOrigin: 'top left',
      // 画面座標 (sx, sy) ← ローカル (x, y) は  sx = w - y, sy = x
      transform: `rotate(90deg) translateY(-${size.w}px)`,
    },
  }
}

/** 回している間だけ出る案内。回転の内側にあるので、正しく倒すと読める向きになる。 */
export function RotateHint() {
  const [dismissed, setDismissed] = useState(false)
  if (dismissed) return null
  return (
    <div className="rotate-hint" role="status" aria-live="polite">
      <i aria-hidden="true">⟲</i>
      <b>本体を左に倒してください</b>
      <small>横画面専用です。この文字がまっすぐ読める向きが正解です。</small>
      <button type="button" onClick={() => { setDismissed(true); lockLandscape() }}>閉じる</button>
    </div>
  )
}
