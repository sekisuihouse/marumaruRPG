/**
 * スマホ操作。原神（Genshin Impact）と同じ操作系に合わせている。
 *
 *   画面左側     … どこを触ってもそこにスティックが出る（フローティング）
 *   画面右側     … ボタン以外をなぞるとカメラが回る
 *   右下の円弧   … 通常攻撃（最大）・元素スキル・元素爆発・ジャンプ・ダッシュ
 *   右端の縦列   … キャラ切替の位置。ここでは技スロット1〜4を切り替える
 *   中央右       … 近くに対象があるときだけ出る「調べる」
 *
 * 原神に無いこのゲーム固有の操作（盾・回復）は、邪魔にならない位置へ小さく置く。
 * 指は同時に複数使える（移動しながら視点を回し、ボタンも押せる）。
 */
import React, { useEffect, useRef, useState } from 'react'
import { publishHud, sim } from '../engine/sim.js'
import { PLAYER_ATTACKS } from '../data/enemies.js'
import { addLookDelta, setVirtualAction, touch } from '../engine/input.js'
import { tryAttack } from '../engine/step.js'

const ABILITY_SLOTS = ['magic', 'area', 'arrow', 'firestream']
/** スティックの可動半径(px)。原神と同じく端まで倒しても走らない（走りはダッシュボタン）。 */
const STICK_RADIUS = 58
/** 指1pxあたりの視点移動量。マウスと同じ経路に流すので、感度と反転設定は共通で効く。 */
const LOOK_SENSITIVITY = 1
/** 通常攻撃を押しっぱなしにしたときの連打間隔(ms)。実際の発動間隔は攻撃側の硬直で決まる。 */
const ATTACK_REPEAT = 120

/**
 * 一瞬だけ押した扱いにする。回避や会話は「押した瞬間」だけを見ているので、
 * 立てっぱなしにすると次の入力が効かなくなる。1フレーム以上あけて必ず戻す。
 */
function pulse(action) {
  setVirtualAction(action, true)
  setTimeout(() => setVirtualAction(action, false), 80)
}

/** 押している間だけアクションを立てるボタン。 */
function HoldButton({ action, className, label, hint, active, disabled }) {
  const down = (event) => {
    if (disabled) return
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    setVirtualAction(action, true)
  }
  const up = (event) => { event.preventDefault(); setVirtualAction(action, false) }
  return <button
    type="button" className={`mc-btn ${className} ${active ? 'on' : ''} ${disabled ? 'off' : ''}`}
    aria-label={label} aria-pressed={!!active}
    onPointerDown={down} onPointerUp={up} onPointerCancel={up} onPointerLeave={up}
  >
    <b>{label}</b>{hint && <small>{hint}</small>}
  </button>
}

/** 押した瞬間に発動し、押しっぱなしで連打されるボタン。 */
function TapButton({ onFire, repeat, className, label, hint, disabled, cooldown }) {
  const timer = useRef(0)
  const stop = () => { if (timer.current) { clearInterval(timer.current); timer.current = 0 } }
  useEffect(() => stop, [])
  const down = (event) => {
    if (disabled) return
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    onFire()
    if (repeat) { stop(); timer.current = setInterval(onFire, ATTACK_REPEAT) }
  }
  const up = (event) => { event.preventDefault(); stop() }
  return <button
    type="button" className={`mc-btn ${className} ${disabled ? 'off' : ''}`} aria-label={label}
    onPointerDown={down} onPointerUp={up} onPointerCancel={up} onPointerLeave={up}
  >
    <b>{label}</b>{hint && <small>{hint}</small>}
    {cooldown > 0 && <em className="mc-cd">{cooldown.toFixed(1)}</em>}
  </button>
}

export function MobileControls({ hud }) {
  const field = useRef(null)
  /** pointerId → 役割。移動と視点を同時に扱うため指ごとに覚える。 */
  const pointers = useRef(new Map())
  const [stick, setStick] = useState(null)

  const release = () => {
    pointers.current.clear()
    touch.move.x = 0; touch.move.y = 0
    setStick(null)
  }
  useEffect(() => {
    const hidden = () => { if (document.hidden) release() }
    document.addEventListener('visibilitychange', hidden)
    return () => { document.removeEventListener('visibilitychange', hidden); release() }
  }, [])

  const onDown = (event) => {
    // PCはPointer Lockのままにする。指とペンだけをここで受ける。
    if (event.pointerType === 'mouse') return
    event.preventDefault()
    const hasMove = [...pointers.current.values()].some((p) => p.kind === 'move')
    // 画面左寄りの最初の指が移動。以降の指は視点。
    if (!hasMove && event.clientX < window.innerWidth * 0.46) {
      pointers.current.set(event.pointerId, { kind: 'move', ox: event.clientX, oy: event.clientY })
      setStick({ x: event.clientX, y: event.clientY, kx: 0, ky: 0 })
    } else {
      pointers.current.set(event.pointerId, { kind: 'look', lx: event.clientX, ly: event.clientY })
    }
    field.current?.setPointerCapture?.(event.pointerId)
  }

  const onMove = (event) => {
    const p = pointers.current.get(event.pointerId)
    if (!p) return
    event.preventDefault()
    if (p.kind === 'move') {
      let kx = event.clientX - p.ox, ky = event.clientY - p.oy
      const len = Math.hypot(kx, ky)
      if (len > STICK_RADIUS) { kx *= STICK_RADIUS / len; ky *= STICK_RADIUS / len }
      touch.move.x = kx / STICK_RADIUS
      touch.move.y = -ky / STICK_RADIUS
      setStick((s) => (s ? { ...s, kx, ky } : s))
    } else {
      addLookDelta((event.clientX - p.lx) * LOOK_SENSITIVITY, (event.clientY - p.ly) * LOOK_SENSITIVITY)
      p.lx = event.clientX
      p.ly = event.clientY
    }
  }

  const onUp = (event) => {
    const p = pointers.current.get(event.pointerId)
    if (!p) return
    pointers.current.delete(event.pointerId)
    if (p.kind === 'move') { touch.move.x = 0; touch.move.y = 0; setStick(null) }
  }

  const selected = hud.selectedAbility || 'magic'
  const selectedDef = PLAYER_ATTACKS[selected] || PLAYER_ATTACKS.magic
  const selectedLocked = !hud.skills.includes(selected)
  const cooldownOf = (id) => Math.max(0, (hud.cooldowns[id] || 0) - sim.time)
  const skillHold = selected === 'firestream'
  const interactLabel = hud.nearest ? hud.nearest.name : null

  return <div className="mobile-controls">
    <div
      ref={field} className="mc-field"
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
    />

    {stick && <div className="mc-stick" style={{ left: stick.x, top: stick.y }} aria-hidden="true">
      <i style={{ transform: `translate(${stick.kx}px,${stick.ky}px)` }} />
    </div>}

    {/* 右端の縦列＝原神のキャラ切替。ここでは技スロット。 */}
    <div className="mc-slots" role="toolbar" aria-label="技スロット">
      {ABILITY_SLOTS.map((id, index) => {
        const ability = PLAYER_ATTACKS[id]
        const locked = !hud.skills.includes(id)
        const cd = cooldownOf(id)
        return <button
          key={id} type="button"
          className={`mc-slot ${selected === id ? 'on' : ''} ${locked ? 'off' : ''}`}
          aria-pressed={selected === id} aria-label={ability.label}
          onPointerDown={(e) => { e.preventDefault(); sim.player.selectedAbility = id; publishHud() }}
        >
          <b>{index + 1}</b><span>{ability.label.replace(/^[^ ]+ /, '')}</span>
          {cd > 0 && <em>{cd.toFixed(1)}</em>}
        </button>
      })}
    </div>

    {/* 右下の円弧＝原神のボタン配置 */}
    <div className="mc-cluster">
      {/* 元素爆発Qの位置。このゲームではウェブスイング（長押し） */}
      <HoldButton action="webSwing" className="mc-burst" label="🕸" hint="ウェブ" active={hud.swinging} disabled={!hud.canWeb} />
      {/* 元素スキルEの位置。選択中の技 */}
      {skillHold
        ? <HoldButton action="useAbility" className="mc-skill" label="連射" hint={`熱 ${hud.heat}%`} active={hud.overheat} />
        : <TapButton
          className="mc-skill" label={selectedDef.label.replace(/^[^ ]+ /, '')} hint="スキル"
          onFire={() => tryAttack(selected)} disabled={selectedLocked} cooldown={cooldownOf(selected)}
        />}
      {/* 通常攻撃。最大の円 */}
      <TapButton className="mc-attack" label="攻撃" onFire={() => tryAttack('melee')} repeat />
      {/* ジャンプの位置。このゲームでは回避ローリング */}
      <TapButton className="mc-jump" label="回避" onFire={() => pulse('dodge')} />
      {/* ダッシュ */}
      <HoldButton action="sprint" className="mc-sprint" label="ダッシュ" />
      {/* 原神に無いこのゲーム固有の操作 */}
      <HoldButton action="guard" className="mc-guard" label="🛡" active={hud.blocking} />
      <TapButton className="mc-heal" label="✚" onFire={() => tryAttack('heal')} cooldown={cooldownOf('heal')} />
    </div>

    {interactLabel && <button
      type="button" className="mc-interact" aria-label={`${interactLabel} と話す`}
      onPointerDown={(e) => { e.preventDefault(); pulse('interact') }}
    ><b>調べる</b><small>{interactLabel}</small></button>}
  </div>
}
