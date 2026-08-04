/**
 * まるごと祭：未来の町 — エントリポイント
 *
 * 起動手順:
 *   1. NavMesh(ベイク済みJSON)を読む
 *   2. 敵プール・クエスト・NPCを初期化
 *   3. セーブがあればタイトルで「続きから／最初から」を選ばせる
 *   4. Canvas をマウントして World を描画
 */
import React, { Suspense, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Canvas } from '@react-three/fiber'
import { useProgress } from '@react-three/drei'
import * as THREE from 'three'
import './style.css'

import { loadNav } from './engine/nav.js'
import { sim, initEnemies, initQuests, resetPlayer, setPlayerDebugLevel, publishHud, say } from './engine/sim.js'
import { initNpcs } from './engine/step.js'
import { attachInput } from './engine/input.js'
import { readSave, applySave, deleteSave, saveGame } from './engine/save.js'
import { initDebris } from './engine/debris.js'
import { initRagdolls } from './engine/ragdoll.js'
import { initJuice } from './engine/juice.js'
import { initWeb } from './engine/webswing.js'
import { initFireStream } from './engine/firestream.js'
import { initBosses, armBossSystem } from './engine/bosses.js'
import { initMultiplayerAuthority } from './net/hostAuthority.js'
import * as destructApi from './engine/destruct.js'
import * as bossesApi from './engine/bosses.js'
const { resetTown } = destructApi
import { World } from './scene/World.jsx'
import { Hud } from './ui/Hud.jsx'
import { MultiplayerMenu } from './ui/MultiplayerMenu.jsx'
import { KEYMAP } from './engine/input.js'

function Loader() {
  const { progress, active } = useProgress()
  if (!active && progress >= 100) return null
  return (
    <div className="boot" role="status" aria-live="polite">
      <b>未来の町を読み込み中…</b>
      <div className="boot-bar"><i style={{ width: `${progress.toFixed(0)}%` }} /></div>
      <small>{progress.toFixed(0)}%</small>
    </div>
  )
}

function Title({ hasSave, onContinue, onNew, onMultiplayer }) {
  return (
    <div className="title" role="dialog" aria-modal="true" aria-label="タイトル">
      <div className="title-box">
        <h1>MARUGOTO<small>FUTURE QUEST</small></h1>
        <p>未来の町を歩き、住民の頼みを聞き、5種の敵と戦う小さなオープンワールド。</p>
        <div className="title-actions">
          {hasSave && <button autoFocus onClick={onContinue}>続きから</button>}
          <button autoFocus={!hasSave} onClick={onNew}>{hasSave ? '最初から' : 'はじめる'}</button>
          <button onClick={onMultiplayer}>マルチプレイ</button>
        </div>
        <ul className="title-keys">
          {KEYMAP.slice(0, 8).map((k) => (
            <li key={k.id}><span>{k.keys.join(' ')}</span> {k.label}</li>
          ))}
        </ul>
        <small>操作説明はゲーム中に H キーでいつでも開けます。</small>
      </div>
    </div>
  )
}

function App() {
  const [phase, setPhase] = useState('boot')   // boot | title | multiplayer | play | error
  const [error, setError] = useState(null)
  const saveRef = useRef(null)
  const wrapRef = useRef(null)
  /**
   * ポインターロックは「ユーザー操作の直後」でないと拒否される。
   * 拡張機能の autostart 起動はクリックを伴わないので要求しない
   * （最初に画面をクリックしたときに input.js 側が取りに行く）。
   * 失敗しても視点はドラッグで動かせるので、例外にせず握りつぶす。
   */
  const requestPointerLock = () => {
    if (autoStart) return
    try {
      const r = wrapRef.current?.requestPointerLock?.()
      if (r && typeof r.catch === 'function') r.catch(() => {})
    } catch { /* ロックできない環境 */ }
  }
  const autoStart = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('autostart')
  const debugStartLevel = Number(import.meta.env.VITE_DEBUG_START_LEVEL || 0)

  // 初期化
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        await loadNav()
        if (!alive) return
        initEnemies()
        initQuests()
        initNpcs()
        initDebris()
        initRagdolls()
        initJuice()
        initWeb()
        initFireStream()
        initBosses()
        initMultiplayerAuthority()
        resetPlayer(true)
        publishHud()
        saveRef.current = readSave()
        if (autoStart) start(false)
        else setPhase('title')
      } catch (e) {
        console.error(e)
        setError(e?.message || String(e))
        setPhase('error')
      }
    })()
    return () => { alive = false }
  }, [])

  // 入力は play に入ってから受け付ける
  useEffect(() => {
    if (phase !== 'play') return
    const detach = attachInput(window, wrapRef.current)
    return detach
  }, [phase])

  const start = (useSave, roomSettings = null) => {
    if (useSave && saveRef.current) {
      applySave(saveRef.current)
      say('セーブデータから再開しました。', 'save')
    } else {
      deleteSave()
      initEnemies()
      initQuests()
      initDebris()
      initRagdolls()
      initWeb()
      initFireStream()
      initBosses()
      sim.pendingBrokenSave = null   // 前のセーブの破壊状況を持ち越さない
      resetTown()                    // 見た目・破片・通行判定をまとめて元に戻す
      resetPlayer(true)
      if (roomSettings?.initialLevel > 1) setPlayerDebugLevel(roomSettings.initialLevel)
      say('未来の町へようこそ。WASDで歩き、Eで話し、Hで操作説明。', 'info')
      saveGame(true)
    }
    if (debugStartLevel > 0) setPlayerDebugLevel(debugStartLevel)
    sim.mode = 'play'
    armBossSystem()
    publishHud()
    setPhase('play')
    requestPointerLock()
  }

  if (phase === 'error') {
    return (
      <main className="fatal">
        <h2>読み込みに失敗しました</h2>
        <p>{error}</p>
        <pre>npm run build:assets を実行して、public/assets/navmesh.json と
public/assets/characters/glb/*.glb を生成してください。</pre>
      </main>
    )
  }

  return (
    <main ref={wrapRef}>
      {phase !== 'boot' && (
        <Canvas
          shadows
          dpr={[1, 1.75]}
          camera={{ fov: 52, near: 0.25, far: 420, position: [0, 6, 12] }}
          gl={{ antialias: true, powerPreference: 'high-performance' }}
          onCreated={({ gl }) => {
            gl.toneMapping = THREE.ACESFilmicToneMapping
            gl.toneMappingExposure = 1.05
            // PCFSoftShadowMap は three r18x で非推奨。PCF で同等の見た目を保つ。
            gl.shadowMap.type = THREE.PCFShadowMap
          }}
        >
          <Suspense fallback={null}>
            {phase === 'play' && <World />}
          </Suspense>
        </Canvas>
      )}
      {phase === 'play' && <Hud onRequestPointerLock={requestPointerLock} />}
      {phase === 'title' && <Title hasSave={!!saveRef.current} onContinue={() => start(true)} onNew={() => start(false)} onMultiplayer={() => setPhase('multiplayer')} />}
      {phase === 'multiplayer' && <MultiplayerMenu onBack={() => setPhase('title')} onStart={(settings) => start(false, settings)} />}
      <Loader />
    </main>
  )
}

createRoot(document.getElementById('root')).render(<App />)

// デバッグ用の窓口。DevTools のコンソールから状態を覗ける。
// 例) __sim.player.hp = 999 / __sim.enemies[0].hp = 1
if (typeof window !== 'undefined') {
  window.__sim = sim
  window.__marugoto = {
    sim,
    save: () => import('./engine/save.js').then((m) => m.saveGame()),
    /** 破壊系のデバッグ窓口。__marugoto.destruct.breakPart(...) / resetTown() */
    destruct: destructApi,
    /** F9 と同じ: 当たり判定・小片名・HP・物理状態の表示 */
    toggleDebug: () => { sim.debugDraw = !sim.debugDraw; return sim.debugDraw },
  }
  if (import.meta.env.DEV) {
    window.__marugoto.bosses = {
      list: () => sim.bosses.map((b) => ({ id: b.def.id, spawned: b.spawned, defeated: b.defeated, hp: b.hp, ratio: sim.bossProgress.buildingRatios?.[b.def.id] })),
      spawn: (id) => bossesApi.debugSpawnBoss(id),
      hp1: (id) => { const b = bossesApi.bossById(id); if (b) b.hp = 1 },
      defeated: (n) => { sim.bossProgress.defeatedBossCount = Math.max(0, Number(n) || 0) },
      phase: (id, n = 2) => { const b = bossesApi.bossById(id); if (b) b.phase = n },
      models: () => sim.bosses.map((b) => ({ id: b.def.id, model: b.def.modelPath, scale: b.def.scale, area: b.def.objectName })),
    }
  }
}
