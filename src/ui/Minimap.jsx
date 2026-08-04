/**
 * ミニマップ。scripts/build-navmesh.mjs がベイクした町の色マップを背景に、
 * プレイヤー・敵・村人・クエスト目標・ランドマークを重ねて描く。
 * M キーで拡大表示に切り替わる。
 */
import React, { useEffect, useMemo, useRef } from 'react'
import { minimapImage, worldToMap, landmarks, getNav } from '../engine/nav.js'
import { sim } from '../engine/sim.js'
import { questMarkers } from '../engine/quests.js'

export function Minimap({ large }) {
  const canvasRef = useRef()
  const bg = useMemo(() => {
    const img = minimapImage()
    if (!img) return null
    const c = document.createElement('canvas')
    c.width = img.n
    c.height = img.n
    c.getContext('2d').putImageData(new ImageData(img.data, img.n, img.n), 0, 0)
    return { canvas: c, n: img.n }
  }, [])

  useEffect(() => {
    if (!bg) return
    let raf = 0
    const nav = getNav()
    const marks = landmarks()

    const draw = () => {
      raf = requestAnimationFrame(draw)
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      const size = canvas.width
      const p = sim.player
      const zoom = large ? 1.9 : 3.4          // 大きいほど寄る
      const view = bg.n / zoom                // 表示するセル数
      const { u, v } = worldToMap(p.pos.x, p.pos.z)
      const scale = size / view

      ctx.clearRect(0, 0, size, size)
      ctx.save()
      // 円形にクリップ
      ctx.beginPath()
      ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2)
      ctx.clip()
      ctx.fillStyle = '#16302c'
      ctx.fillRect(0, 0, size, size)

      ctx.imageSmoothingEnabled = false
      ctx.drawImage(bg.canvas, u - view / 2, v - view / 2, view, view, 0, 0, size, size)

      const toScreen = (wx, wz) => {
        const m = worldToMap(wx, wz)
        return [(m.u - (u - view / 2)) * scale, (m.v - (v - view / 2)) * scale]
      }

      // ランドマーク
      ctx.font = '9px system-ui, sans-serif'
      ctx.textAlign = 'center'
      for (const lm of marks) {
        const [x, y] = toScreen(lm.center[0], lm.center[2])
        if (x < -20 || y < -20 || x > size + 20 || y > size + 20) continue
        ctx.fillStyle = 'rgba(255,255,255,.75)'
        ctx.fillRect(x - 1.5, y - 1.5, 3, 3)
        if (large) {
          ctx.fillStyle = 'rgba(255,255,255,.9)'
          ctx.fillText(lm.label, x, y - 5)
        }
      }

      // クエスト目標
      for (const q of questMarkers()) {
        const [x, y] = toScreen(q.x, q.z)
        ctx.beginPath()
        ctx.arc(x, y, 6 + Math.sin(sim.time * 4) * 1.5, 0, Math.PI * 2)
        ctx.strokeStyle = '#ffd166'
        ctx.lineWidth = 2
        ctx.stroke()
      }

      // 村人
      for (const npc of sim.npcs) {
        const [x, y] = toScreen(npc.pos.x, npc.pos.z)
        ctx.fillStyle = '#8ef0c0'
        ctx.beginPath()
        ctx.arc(x, y, 3.2, 0, Math.PI * 2)
        ctx.fill()
      }

      // 敵
      for (const e of sim.enemies) {
        if (!e.alive || e.state === 'dead') continue
        const [x, y] = toScreen(e.pos.x, e.pos.z)
        ctx.fillStyle = e.def.look.color
        ctx.beginPath()
        ctx.arc(x, y, e.aware ? 4.4 : 3.4, 0, Math.PI * 2)
        ctx.fill()
        if (e.aware) {
          ctx.strokeStyle = 'rgba(255,255,255,.9)'
          ctx.lineWidth = 1.2
          ctx.stroke()
        }
      }

      // プレイヤー(向き付き三角)
      const [px, py] = toScreen(p.pos.x, p.pos.z)
      ctx.save()
      ctx.translate(px, py)
      ctx.rotate(-p.yaw + Math.PI)
      ctx.beginPath()
      ctx.moveTo(0, -7)
      ctx.lineTo(5, 6)
      ctx.lineTo(-5, 6)
      ctx.closePath()
      ctx.fillStyle = '#fff'
      ctx.strokeStyle = '#123'
      ctx.lineWidth = 1.5
      ctx.fill()
      ctx.stroke()
      ctx.restore()

      // カメラの向き
      ctx.strokeStyle = 'rgba(255,255,255,.35)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(px, py)
      ctx.lineTo(px + Math.sin(sim.camera.yaw + Math.PI) * -20, py + Math.cos(sim.camera.yaw + Math.PI) * -20)
      ctx.stroke()
      ctx.restore()

      // 枠
      ctx.beginPath()
      ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2)
      ctx.strokeStyle = 'rgba(255,255,255,.85)'
      ctx.lineWidth = 3
      ctx.stroke()
      void nav
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [bg, large])

  if (!bg) return null
  const px = large ? 420 : 168
  return (
    <div className={`minimap ${large ? 'large' : ''}`}>
      <canvas ref={canvasRef} width={px} height={px} aria-label="ミニマップ" role="img" />
      <span className="minimap-hint">M: {large ? '縮小' : '拡大'}</span>
    </div>
  )
}
