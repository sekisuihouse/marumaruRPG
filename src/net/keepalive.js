/**
 * マルチプレイ中だけ、シミュレーションを止めないための保険。
 *
 * ブラウザはタブが非表示になると requestAnimationFrame を止める。
 * シングルプレイなら「止まって待つ」で正しいが、マルチプレイでは
 *   - ホストが別タブを見た瞬間、敵もボスもスナップショット送出も止まり、全員の画面が凍る
 *   - 参加者が別タブを見ると入力が送られなくなり、その場に張り付く
 * という致命的な症状になる。
 *
 * setInterval もバックグラウンドでは1秒に1回まで間引かれるため、
 * 間引きの対象外である Worker のタイマーからメインスレッドを起こす。
 * 実際に stepSim を呼ぶのは「直近の描画フレームがしばらく来ていないとき」だけなので、
 * 前面表示中は通常の useFrame と二重に進むことはない。
 */
import { sim } from '../engine/sim.js'
import { multiplayer } from './multiplayerStore.js'

/** 描画フレームがこの時間(ms)来ていなければ、代わりに1ステップ進める */
const IDLE_MS = 60
/** バックグラウンドでの更新間隔(ms) */
const TICK_MS = 33
/** 1回で進める上限(s)。復帰時にワープしないよう小さく刻む */
const MAX_STEP = 1 / 20

const WORKER_SRC = `let t=null
onmessage=(e)=>{
  if (e.data && e.data.start) { clearInterval(t); t=setInterval(()=>postMessage(1), e.data.interval) }
  else { clearInterval(t); t=null }
}`

let worker = null
let running = false
let stepFn = null
let lastTick = 0

/** 循環importを避けるため、stepSim は起動時に渡してもらう */
export function initKeepAlive(step) {
  stepFn = step
}

const shouldRun = () => multiplayer.role !== 'offline' && multiplayer.status === 'connected'

function tick() {
  if (!stepFn || sim.mode === 'dialogue') return
  const now = performance.now()
  // 描画フレームが動いているならそちらに任せる
  if (now - (sim.lastStepAt || 0) < IDLE_MS) { lastTick = now; return }
  const dt = Math.min(MAX_STEP, Math.max(1 / 240, (now - (lastTick || now - TICK_MS)) / 1000))
  lastTick = now
  try { stepFn(dt) } catch (err) { console.error('[keepalive] stepSim に失敗しました', err) }
}

function start() {
  if (running || typeof Worker === 'undefined') return
  try {
    const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }))
    worker = new Worker(url)
    URL.revokeObjectURL(url)
    worker.onmessage = tick
    worker.postMessage({ start: true, interval: TICK_MS })
    running = true
    lastTick = performance.now()
  } catch (err) {
    console.warn('[keepalive] Worker を作れないため、非表示タブでは進行が止まります', err)
  }
}

function stop() {
  if (!running) return
  worker?.postMessage({ start: false })
  worker?.terminate()
  worker = null
  running = false
}

/** マルチプレイの開始・終了に合わせて保険を入切する。main.jsx から1回だけ呼ぶ。 */
export function watchKeepAlive(subscribe) {
  if (typeof window === 'undefined') return () => {}
  const sync = () => { if (shouldRun()) start(); else stop() }
  sync()
  const un = subscribe(sync)
  return () => { un?.(); stop() }
}

export const isKeepAliveRunning = () => running
