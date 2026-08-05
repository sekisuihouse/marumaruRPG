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

import { loadNav, groundY as navGroundY, isWalkable as navIsWalkable } from './engine/nav.js'
import { sim, initEnemies, initQuests, resetPlayer, setPlayerDebugLevel, publishHud, say } from './engine/sim.js'
import { initNpcs } from './engine/step.js'
import { stepSim } from './engine/step.js'
import { ACTION_META, attachInput, bindingLabel, setBindings, setDebugInputEnabled } from './engine/input.js'
import { keys } from './engine/input.js'
import { readSave, applySave, deleteSave, saveGame } from './engine/save.js'
import { initDebris } from './engine/debris.js'
import { initRagdolls } from './engine/ragdoll.js'
import { initJuice } from './engine/juice.js'
import { initWeb } from './engine/webswing.js'
import { initFireStream } from './engine/firestream.js'
import { initBosses, armBossSystem, debugSetBossAi, debugSpawnBoss } from './engine/bosses.js'
import { initArena, lockArena, unlockArena, isArenaLocked } from './engine/arena.js'
import { stopMusic, refreshMusicVolume, musicState } from './engine/music.js'
import { initMultiplayerAuthority } from './net/hostAuthority.js'
import * as bossesApiNet from './net/hostAuthority.js'
import { isKeepAliveRunning as keepAliveRunning } from './net/keepalive.js'
import { netDiagnostics } from './net/diagnostics.js'
import { multiplayer, subscribeMultiplayer } from './net/multiplayerStore.js'
import { initKeepAlive, watchKeepAlive } from './net/keepalive.js'
import * as destructApi from './engine/destruct.js'
import * as bossesApi from './engine/bosses.js'
const { resetTown } = destructApi
import { World } from './scene/World.jsx'
import { MOTION_GAIN } from './gfx/BossModel.jsx'
import { Hud } from './ui/Hud.jsx'
import { MultiplayerMenu } from './ui/MultiplayerMenu.jsx'
import { BossForge } from './ui/BossForge.jsx'

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
          {ACTION_META.filter((action) => ['moveForward', 'sprint', 'dodge', 'interact', 'meleeAttack', 'webSwing'].includes(action.id)).map((action) => (
            <li key={action.id}><span>{bindingLabel(action.id)}</span> {action.label}</li>
          ))}
        </ul>
        <small>操作説明はゲーム中に F1 キーでいつでも開けます。</small>
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
    if (sim.bossForge && !sim.bossForge.combat) return
    if (autoStart) return
    try {
      const r = wrapRef.current?.requestPointerLock?.()
      if (r && typeof r.catch === 'function') r.catch(() => {})
    } catch { /* ロックできない環境 */ }
  }
  const autoStart = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('autostart')
  const bossForgeRequested = import.meta.env.DEV && typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('bossForge') === '1'
  const debugModeRequested = import.meta.env.DEV && typeof window !== 'undefined' && (
    import.meta.env.MODE === 'debug' || new URLSearchParams(window.location.search).get('debug') === '1'
  )
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
        initArena()
        initMultiplayerAuthority()
        // マルチプレイ中は非表示タブでも進行を止めない（ホストが止まると全員が凍るため）
        initKeepAlive(stepSim)
        watchKeepAlive(subscribeMultiplayer)
        resetPlayer(true)
        setBindings(sim.settings.bindings || {})
        sim.debugMode = debugModeRequested
        sim.debugPropShotsFired = 0
        setDebugInputEnabled(debugModeRequested)
        publishHud()
        saveRef.current = readSave()
        if (bossForgeRequested) startForge()
        else if (autoStart) start(false)
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
    if (phase !== 'play' && phase !== 'bossForge') return
    const detach = attachInput(window, wrapRef.current, { allowPointerLock: () => !sim.bossForge || sim.bossForge.combat })
    return detach
  }, [phase])

  const start = (useSave, roomSettings = null) => {
    if (useSave && saveRef.current) {
      applySave(saveRef.current)
      setBindings(sim.settings.bindings || {})
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
      initArena()
      stopMusic()
      sim.pendingBrokenSave = null   // 前のセーブの破壊状況を持ち越さない
      resetTown()                    // 見た目・破片・通行判定をまとめて元に戻す
      resetPlayer(true)
      if (roomSettings?.initialLevel > 1) setPlayerDebugLevel(roomSettings.initialLevel)
      say('未来の町へようこそ。WASDで歩き、Eで話す。F1で操作説明。', 'info')
      saveGame(true)
    }
    if (debugStartLevel > 0) setPlayerDebugLevel(debugStartLevel)
    if (sim.debugMode) console.info('[DEBUG] P: 町の小道具をランダム射出')
    sim.mode = 'play'
    armBossSystem()
    publishHud()
    setPhase('play')
    requestPointerLock()
  }

  const startForge = () => {
    // 本編セーブ・建物破壊進行を読まず、開発用の独立した一時状態を使う。
    if (document.pointerLockElement) document.exitPointerLock?.()
    initEnemies(); initQuests(); initDebris(); initRagdolls(); initWeb(); initFireStream(); initBosses(); initArena(); resetTown(); resetPlayer(true)
    const first = 'student'
    sim.bossForge = {
      bossId: first, actionId: 'drone', annotations: [],
      showHitboxes: false, showWeakpoint: false, showGround: true, showBones: false,
      combat: false, timeScale: 1, loop: false, loopAt: 0, stepOnce: false,
      // 手続きアニメーションの振り幅。編集中だけ上書きできる（既定は BossModel の MOTION_GAIN）。
      motionGain: MOTION_GAIN,
      // プレビューカメラ用。モデル読込後に自動フレーミングする。
      needsFrame: true, framedFor: null, view: null,
      draft: null, original: null, originals: {},
    }
    debugSpawnBoss(first)
    const boss = sim.bosses.find((b) => b.def.id === first)
    if (boss) {
      boss.forgeActive = true; boss.debugAi = false
      sim.bossForge.draft = JSON.parse(JSON.stringify(boss.def))
      sim.bossForge.original = JSON.parse(JSON.stringify(boss.def))
      sim.bossForge.originals[first] = JSON.parse(JSON.stringify(boss.def))
      // カメラは BossForgeCamera が bounding box から自動で合わせる。
      // プレイヤー座標や町のNavMeshには依存させない。
      sim.player.pos.copy(boss.pos)
      sim.player.vel.set(0, 0, 0)
    }
    sim.mode = 'play'; armBossSystem(999999); publishHud(); setPhase('bossForge')
  }

  const exitForge = () => {
    const originals = sim.bossForge?.originals || {}
    for (const b of sim.bosses || []) {
      const original = originals[b.def.id]
      if (original) Object.assign(b.def, JSON.parse(JSON.stringify(original)))
      b.forgeActive = false
      b.forgePose = null
      b.forgeBounds = null
      b.forgeModelReady = false
      b.forgeBoneOverrides = {}
      debugSetBossAi(b.def.id, false)
    }
    // 通常カメラへ戻す（編集中に広げた距離・俯角を持ち越さない）
    sim.camera.dist = 9; sim.camera.pitch = 0.28; sim.camera.yaw = Math.PI
    document.exitPointerLock?.()
    sim.bossForge = null
    initBosses(); resetPlayer(true); resetTown(); publishHud(); setPhase('title')
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
            {(phase === 'play' || phase === 'bossForge') && <World />}
          </Suspense>
        </Canvas>
      )}
      {phase === 'play' && <Hud onRequestPointerLock={requestPointerLock} />}
      {phase === 'bossForge' && <BossForge onExit={exitForge} onStartCombat={requestPointerLock} />}
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
    /** 開発環境専用: 当たり判定・小片名・HP・物理状態の表示 */
    toggleDebug: () => { sim.debugDraw = !sim.debugDraw; return sim.debugDraw },
  }
  if (import.meta.env.DEV) {
    // 複数タブ検証と通信不調の切り分け用。公開ビルドには含めない。
    window.__marugoto.multiplayer = multiplayer
    // ネットワーク診断の入口。__marugoto.net.stats() で接続段階から補間まで一望できる
    window.__marugoto.net = { stats: netDiagnostics, inputs: bossesApiNet.debugRemoteInputs, keepAlive: keepAliveRunning }
    window.__marugoto.keys = keys
    // 接地・通行判定の外部検証用（カメラが地面へ沈まないか等）
    window.__marugoto.nav = { groundY: navGroundY, isWalkable: navIsWalkable }
    window.__marugoto.killPlayer = () => import('./engine/damage.js').then((m) => m.killPlayer())
    window.__marugoto.bosses = {
      list: () => sim.bosses.map((b) => ({ id: b.def.id, spawned: b.spawned, defeated: b.defeated, hp: b.hp, ratio: sim.bossProgress.buildingRatios?.[b.def.id] })),
      spawn: (id) => bossesApi.debugSpawnBoss(id),
      hp1: (id) => { const b = bossesApi.bossById(id); if (b) b.hp = 1 },
      defeated: (n) => { sim.bossProgress.defeatedBossCount = Math.max(0, Number(n) || 0) },
      phase: (id, n = 2) => { const b = bossesApi.bossById(id); if (b) b.phase = n },
      abort: () => bossesApi.abortBossFight('debug'),
      arena: () => ({ locked: isArenaLocked(), ...sim.arena }),
      lock: (id) => lockArena(bossesApi.bossById(id)),
      music: musicState,
      unlock: () => unlockArena('abort'),
      models: () => sim.bosses.map((b) => ({ id: b.def.id, model: b.def.modelPath, scale: b.def.scale, area: b.def.objectName })),
    }
  }
}
