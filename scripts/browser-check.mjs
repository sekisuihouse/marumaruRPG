/**
 * 実ブラウザ(ヘッドレスChrome)でページを開き、コンソールエラー・例外・
 * WebGL描画までを確認する。React/three の描画側の不具合を捕まえるための検証。
 *
 *   npm run dev            # 別ターミナルで起動しておく
 *   node scripts/browser-check.mjs [url]
 *
 * CDP(Chrome DevTools Protocol)を直接叩くので追加の依存は不要。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const URL_TARGET = process.argv[2] || 'http://localhost:5173/'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 9333
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'marugoto-chrome-'))

if (!fs.existsSync(CHROME)) {
  console.log('Chrome が見つからないためスキップします:', CHROME)
  process.exit(0)
}

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--window-size=1280,800',
  // ヘッドレスでも WebGL を使えるようにする
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--hide-scrollbars',
  'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] })

let chromeErr = ''
chrome.stderr.on('data', (d) => { chromeErr += d.toString() })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function findWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      const json = await res.json()
      if (json.webSocketDebuggerUrl) return json.webSocketDebuggerUrl
    } catch { /* まだ起動していない */ }
    await sleep(250)
  }
  throw new Error('Chrome の DevTools に接続できませんでした\n' + chromeErr.slice(-800))
}

const cleanup = () => {
  try { chrome.kill('SIGKILL') } catch { /* already gone */ }
  try { fs.rmSync(profile, { recursive: true, force: true }) } catch { /* ignore */ }
}

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? `  — ${detail}` : ''}`)
  if (!ok) failures++
}

try {
  const wsUrl = await findWs()
  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

  let id = 0
  const pending = new Map()
  const events = []
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
    } else if (msg.method) events.push(msg)
  }
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const msgId = ++id
    pending.set(msgId, { resolve, reject })
    ws.send(JSON.stringify({ id: msgId, method, params, sessionId }))
  })

  // ターゲット(タブ)にアタッチ
  const { targetInfos } = await send('Target.getTargets')
  const page = targetInfos.find((t) => t.type === 'page')
  const { sessionId } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true })
  await send('Runtime.enable', {}, sessionId)
  await send('Log.enable', {}, sessionId)
  await send('Page.enable', {}, sessionId)
  await send('Network.enable', {}, sessionId)

  console.log(`\n開いています: ${URL_TARGET}`)
  await send('Page.navigate', { url: URL_TARGET }, sessionId)

  // 起動 + アセット読み込みを待つ
  await sleep(9000)

  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    }, sessionId)
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed')
    return r.result.value
  }

  // タイトル画面 → ゲーム開始
  const started = await evalJs(`(() => {
    const btns = [...document.querySelectorAll('.title-actions button')]
    const target = btns.find(b => b.textContent.includes('はじめる') || b.textContent.includes('最初から'))
    if (!target) return 'no-title-button'
    target.click()
    return 'clicked'
  })()`)
  check('タイトル画面のボタンを押せる', started === 'clicked', String(started))

  // GLB群は初回キャッシュなし・SwiftShader環境では読み込みに時間が掛かる。
  // 固定12秒では町のSuspense解決前に判定してしまうため、実際のシーン開始を待つ。
  let sceneReady = false
  for (let i = 0; i < 80; i++) {
    sceneReady = await evalJs(`Boolean(window.__three && window.__townParts && window.__frames > 20)`)
    if (sceneReady) break
    await sleep(500)
  }
  check('3Dシーンの初期化完了を待てる', sceneReady)

  // キー入力を送って実際に動かす
  const key = async (type, keyName, code, keyCode) => {
    await send('Input.dispatchKeyEvent', {
      type, key: keyName, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
    }, sessionId)
  }
  const before = await evalJs(`(() => { const s = window.__sim; return s ? [s.player.pos.x, s.player.pos.z] : null })()`)
  await key('keyDown', 'w', 'KeyW', 87)
  await sleep(1800)
  await key('keyUp', 'w', 'KeyW', 87)
  await key('keyDown', 'j', 'KeyJ', 74)
  await key('keyUp', 'j', 'KeyJ', 74)
  await sleep(800)
  const after = await evalJs(`(() => { const s = window.__sim; return s ? [s.player.pos.x, s.player.pos.z] : null })()`)

  const state = await evalJs(`(() => {
    const s = window.__sim
    if (!s) return { ok: false, reason: 'sim not exposed' }
    const canvas = document.querySelector('canvas')
    const gl = canvas && (canvas.getContext('webgl2') || canvas.getContext('webgl'))
    return {
      ok: true,
      canvas: canvas ? [canvas.width, canvas.height] : null,
      glLost: gl ? gl.isContextLost() : 'no-context',
      hud: !!document.querySelector('.hud'),
      skills: document.querySelectorAll('.skills button').length,
      minimap: !!document.querySelector('.minimap canvas'),
      enemiesAlive: s.enemies.filter(e => e.alive).length,
      npcs: s.npcs.length,
      playerHp: Math.round(s.player.hp),
      playerAnim: s.player.anim,
      time: Math.round(s.time),
      dayTime: +s.dayTime.toFixed(2),
      townDraws: window.__townDraws ?? null,
      townParts: window.__townParts ?? null,
      brokenParts: s.destructStats?.broken ?? null,
      bossesAlive: (s.bosses || []).filter((b) => b.alive).length,
      frames: window.__frames ?? null,
    }
  })()`)

  check('sim がブラウザ上で動いている', state.ok === true, JSON.stringify(state).slice(0, 220))
  if (state.ok) {
    check('canvas が生成されている', !!state.canvas, `${state.canvas?.join('x')}`)
    check('WebGL コンテキストが生きている', state.glLost === false, String(state.glLost))
    check('HUD が描画されている', state.hud === true)
    check('スキルボタンが10個ある（長押し技2つを含む）', state.skills === 10, `${state.skills}個`)
    check('ミニマップが描画されている', state.minimap === true)
    check('村人が配置されている', state.npcs === 4, `${state.npcs}人`)
    check('敵が出現している', state.enemiesAlive > 0, `${state.enemiesAlive}体`)
    // ヘッドレスは SwiftShader(ソフトウェア描画)なので fps は出ない。進行だけ見る
    check('フレームが進んでいる', state.frames > 20, `${state.frames} フレーム / 内部時間 ${state.time}s`)
    check('町がマージされている', state.townDraws > 0 && state.townDraws < 40, `${state.townDraws} ドローコール`)
    check('破壊可能な小片が登録されている', state.townParts > 300, `${state.townParts} 個`)
    check('新規開始時に建物が壊れていない', state.brokenParts === 0, `${state.brokenParts} 個`)
    check('新規開始時にボスが出現していない', state.bossesAlive === 0, `${state.bossesAlive} 体`)
    check('Wキーで前進する', before && after && Math.hypot(after[0] - before[0], after[1] - before[1]) > 0.5,
      before && after ? `${Math.hypot(after[0] - before[0], after[1] - before[1]).toFixed(2)}m 移動` : 'sim未公開')
  }

  // 描画レイヤの検証: 装備のボーン追従・スケルトン統合・描画統計
  const render = await evalJs(`(() => {
    const t = window.__three
    if (!t) return { ok: false }
    let skinned = 0, skeletons = new Set(), gearOnBones = 0, sprites = 0, players = 0
    t.scene.traverse((o) => {
      if (o.isSkinnedMesh) { skinned++; skeletons.add(o.skeleton) }
      if (o.isSprite) sprites++
      if (o.isBone && (o.name === 'WristR' || o.name === 'WristL')) {
        // 装備グループが手のボーンの子になっているか
        if (o.children.some((c) => !c.isBone)) gearOnBones++
      }
      if (o.name === 'Adventurer') players++
    })
    const info = t.gl.info
    return {
      ok: true, skinned, skeletons: skeletons.size, gearOnBones, sprites, players,
      calls: info.render.calls, triangles: info.render.triangles,
      programs: info.programs ? info.programs.length : -1,
      textures: info.memory.textures, geometries: info.memory.geometries,
      shadowMap: t.gl.shadowMap.enabled,
      pixelRatio: t.gl.getPixelRatio(),
      camPos: [+t.camera.position.x.toFixed(1), +t.camera.position.y.toFixed(1), +t.camera.position.z.toFixed(1)],
      playerPos: [+window.__sim.player.pos.x.toFixed(1), +window.__sim.player.pos.z.toFixed(1)],
    }
  })()`)
  check('three のシーンにアクセスできる', render.ok === true)
  if (render.ok) {
    console.log(`      描画統計: calls=${render.calls} tris=${render.triangles} skinned=${render.skinned} ` +
      `skeleton=${render.skeletons} sprites=${render.sprites} tex=${render.textures} geo=${render.geometries}`)
    check('スキンメッシュが描画されている', render.skinned > 0, `${render.skinned}個`)
    check('スケルトンがキャラ数程度に収まっている', render.skeletons <= 16, `${render.skeletons}個 (15体想定)`)
    check('装備が手のボーンに追従している', render.gearOnBones > 0, `${render.gearOnBones}箇所`)
    check('名札・ダメージ数値のスプライトがある', render.sprites > 0, `${render.sprites}個`)
    check('影が有効', render.shadowMap === true)
    check('カメラがプレイヤーの近くにある',
      Math.hypot(render.camPos[0] - render.playerPos[0], render.camPos[2] - render.playerPos[1]) < 20,
      `カメラ${render.camPos} プレイヤー${render.playerPos}`)
    check('ドローコールが妥当な範囲', render.calls > 0 && render.calls < 400, `${render.calls}`)
  }

  // 実際に建物を壊して、描画側の頂点書き換え・破片・復元まで通るか
  const destroy = await evalJs(`(async () => {
    const m = window.__marugoto
    if (!m || !m.destruct) return { ok: false, reason: 'destruct not exposed' }
    const { registry, breakPart, resetTown } = m.destruct
    const s = window.__sim
    if (!registry.ready) return { ok: false, reason: 'registry not ready' }
    const target = registry.parts.find((p) => p.category === 'building' && !p.broken)
    const before = s.destructStats.broken
    // プレイヤーを小片の近くへ移動して、描画対象に入る状態で壊す
    s.player.pos.set(target.cx + 3, target.cy, target.cz)
    breakPart(target, 1, 0.4, 0, 1.4)
    await new Promise((r) => setTimeout(r, 900))
    const debris = s.debris.filter((d) => d.active).length
    const brokenAfter = s.destructStats.broken
    resetTown()
    await new Promise((r) => setTimeout(r, 300))
    return {
      ok: true,
      broken: brokenAfter - before,
      debris,
      restored: registry.parts.every((p) => !p.broken),
      partName: target.objectPath,
      partType: target.partType,
      calls: window.__three.gl.info.render.calls,
    }
  })()`)
  check('建物の小片をブラウザ上で壊せる', destroy.ok === true && destroy.broken > 0,
    destroy.ok ? `${destroy.partName} (${destroy.partType}) を ${destroy.broken} 個破壊` : String(destroy.reason))
  if (destroy.ok) {
    check('破壊で破片（物理オブジェクト）が出る', destroy.debris > 0, `${destroy.debris} 個`)
    check('町を復元できる', destroy.restored === true)
    check('破壊後もドローコールが妥当', destroy.calls > 0 && destroy.calls < 400, `${destroy.calls}`)
  }

  // 操作説明(アクセシビリティ)パネルが開くか
  const help = await evalJs(`(() => {
    document.querySelector('.help-fab')?.click()
    return new Promise(r => setTimeout(() => {
      const panel = document.querySelector('.panel-box')
      r({
        open: !!panel,
        rows: document.querySelectorAll('.keymap tr').length,
        toggles: document.querySelectorAll('.toggles input').length,
        aria: document.querySelector('.panel')?.getAttribute('aria-modal'),
      })
    }, 400))
  })()`)
  check('操作説明パネルが開く', help.open === true)
  check('キー説明が一覧表示される', help.rows >= 15, `${help.rows}行`)
  check('アクセシビリティ・破壊表現の設定がある', help.toggles === 9, `${help.toggles}個`)
  check('モーダルに aria 属性がある', help.aria === 'true', String(help.aria))
  const shotHelp = await send('Page.captureScreenshot', { format: 'png' }, sessionId)
  fs.writeFileSync('screenshot-help.png', Buffer.from(shotHelp.data, 'base64'))
  await evalJs(`document.querySelector('.panel-box header button')?.click()`)
  await sleep(500)

  // コンソールのエラーと例外
  const consoleErrors = []
  const exceptions = []
  const netFails = []
  for (const ev of events) {
    if (ev.method === 'Runtime.consoleAPICalled' && ev.params.type === 'error') {
      consoleErrors.push(ev.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '))
    }
    if (ev.method === 'Runtime.exceptionThrown') {
      exceptions.push(ev.params.exceptionDetails.exception?.description || ev.params.exceptionDetails.text)
    }
    if (ev.method === 'Log.entryAdded' && ev.params.entry.level === 'error') {
      consoleErrors.push(`${ev.params.entry.text} ${ev.params.entry.url || ''}`)
    }
    if (ev.method === 'Network.loadingFailed') netFails.push(ev.params.errorText)
    if (ev.method === 'Network.responseReceived' && ev.params.response.status >= 400) {
      netFails.push(`${ev.params.response.status} ${ev.params.response.url}`)
    }
  }
  // SwiftShader 由来の性能警告は無視する
  const ignorable = (t) => /SwiftShader|Automatic fallback|GroupMarker|deprecated/i.test(t)
  const realErrors = consoleErrors.filter((t) => !ignorable(t))

  check('JavaScript 例外が出ていない', exceptions.length === 0, exceptions.slice(0, 3).join(' | ').slice(0, 400))
  check('コンソールエラーが出ていない', realErrors.length === 0, realErrors.slice(0, 4).join(' | ').slice(0, 500))
  check('アセットの読み込み失敗が無い', netFails.length === 0, netFails.slice(0, 4).join(' | ').slice(0, 400))

  // 画面を保存して目視確認できるようにする
  const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId)
  const out = 'screenshot.png'
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'))
  const size = fs.statSync(out).size
  check('スクリーンショットが撮れる', size > 20000, `${out} (${(size / 1024).toFixed(0)}KB)`)

  console.log(`\n${failures === 0 ? '✅ ブラウザ検証を通過' : `❌ ${failures} 件の失敗`}`)
} catch (err) {
  console.error('検証中にエラー:', err.message)
  failures++
} finally {
  cleanup()
}
process.exit(failures ? 1 : 0)
