/**
 * 頭上の名札とHPバー。Canvas を焼いた Sprite なので、
 * DOM を使う drei/Html より軽く、HPが変わったときだけ描き直す。
 */
import React, { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'

const W = 256
const H = 72

export function Nameplate({ source, color = '#ffffff', offsetY = 2.15, width = 1.55 }) {
  const ref = useRef()
  const { canvas, ctx, texture } = useMemo(() => {
    const canvas = document.createElement('canvas')
    canvas.width = W
    canvas.height = H
    const ctx = canvas.getContext('2d')
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    return { canvas, ctx, texture }
  }, [])
  const key = useRef('')

  useEffect(() => () => texture.dispose(), [texture])

  const draw = (label, hp, maxHp, accent, enraged) => {
    ctx.clearRect(0, 0, W, H)
    // 名前
    ctx.font = 'bold 22px "Hiragino Kaku Gothic ProN", system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.lineWidth = 5
    ctx.strokeStyle = 'rgba(12,32,28,0.85)'
    ctx.strokeText(label, W / 2, 20)
    ctx.fillStyle = enraged ? '#ff9a7a' : '#ffffff'
    ctx.fillText(label, W / 2, 20)
    // HPバー
    const bw = W - 40
    const bx = 20
    const by = 42
    const bh = 16
    ctx.fillStyle = 'rgba(12,32,28,0.8)'
    ctx.fillRect(bx - 2, by - 2, bw + 4, bh + 4)
    ctx.fillStyle = '#2b3f47'
    ctx.fillRect(bx, by, bw, bh)
    const ratio = Math.max(0, Math.min(1, hp / maxHp))
    const grd = ctx.createLinearGradient(bx, 0, bx + bw, 0)
    grd.addColorStop(0, enraged ? '#ff5a3c' : accent)
    grd.addColorStop(1, '#ffd166')
    ctx.fillStyle = grd
    ctx.fillRect(bx, by, bw * ratio, bh)
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'
    ctx.lineWidth = 2
    ctx.strokeRect(bx, by, bw, bh)
    ctx.font = 'bold 13px system-ui, sans-serif'
    ctx.fillStyle = '#ffffff'
    ctx.fillText(`${Math.max(0, Math.round(hp))} / ${maxHp}`, W / 2, by + bh / 2 + 1)
    texture.needsUpdate = true
  }

  useFrame(() => {
    const st = source()
    const sprite = ref.current
    if (!sprite || !st) return
    const show = st.alive !== false && st.state !== 'dead'
    sprite.visible = show
    if (!show) return
    sprite.position.set(st.pos.x, st.pos.y + offsetY * (st.scale ?? 1), st.pos.z)
    const k = `${st.label}|${Math.round(st.hp)}|${st.maxHp}|${st.enraged ? 1 : 0}|${st.aware ? 1 : 0}`
    if (k !== key.current) {
      key.current = k
      draw(`${st.aware ? '⚔ ' : ''}${st.label}`, st.hp, st.maxHp, color, st.enraged)
    }
  })

  return (
    <sprite ref={ref} scale={[width, (width * H) / W, 1]} renderOrder={5}>
      <spriteMaterial map={texture} transparent depthWrite={false} />
    </sprite>
  )
}
