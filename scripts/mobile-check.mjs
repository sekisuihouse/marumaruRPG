/**
 * スマホ操作の実機確認（ヘッドレスChrome + CDP）。
 * 端末をスマホとしてエミュレートし、実際のタッチイベントを流して
 * 「フローティングスティックで動く / 右側ドラッグで視点が回る / 2本指で同時操作
 *  / 各ボタンが効く」を確かめる。
 *
 *   npm run dev            # 別ターミナルで起動しておく
 *   npm run test:mobile
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const URL_TARGET = process.argv[2] || 'http://localhost:5173/'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 9377
if (!fs.existsSync(CHROME)) {
  console.log('Chrome が見つからないためスキップします:', CHROME)
  process.exit(0)
}
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'marugoto-mob-'))
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--window-size=844,390',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars', 'about:blank'],
{ stdio: ['ignore', 'pipe', 'pipe'] })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function findWs() {
  for (let i = 0; i < 60; i++) {
    try { const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl } catch {}
    await sleep(250)
  }
  throw new Error('no devtools')
}
let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? `  — ${detail}` : ''}`)
  if (!ok) failures++
}

try {
  const ws = new WebSocket(await findWs())
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let id = 0; const pending = new Map(); const logs = []
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data)
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id)
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result)
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      logs.push(msg.params.args.map((a) => a.value || a.description).join(' '))
    } else if (msg.method === 'Runtime.exceptionThrown') {
      logs.push('EXCEPTION ' + (msg.params.exceptionDetails.exception?.description || '').slice(0, 200))
    }
  }
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params, sessionId }))
  })
  const { targetInfos } = await send('Target.getTargets')
  const page = targetInfos.find((t) => t.type === 'page')
  const { sessionId } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true })
  await send('Runtime.enable', {}, sessionId)
  await send('Page.enable', {}, sessionId)
  // スマホとして開く（pointer:coarse を成立させる）
  await send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 2, mobile: true }, sessionId)
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sessionId)
  await send('Emulation.setEmitTouchEventsForMouse', { enabled: false }, sessionId)

  const evalJs = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }, sessionId)
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed')
    return r.result.value
  }
  const touch = (type, points) => send('Input.dispatchTouchEvent', { type, touchPoints: points }, sessionId)
  const frames = () => evalJs('window.__frames || 0')
  const waitFrames = async (n = 3) => {
    const start = await frames()
    for (let i = 0; i < 40; i++) { if ((await frames()) > start + n) return; await sleep(250) }
  }

  await send('Page.navigate', { url: `${URL_TARGET}?autostart=1` }, sessionId)
  await sleep(9000)
  for (let i = 0; i < 40; i++) { if (await evalJs('Boolean(window.__sim?.ready ?? window.__sim)')) break; await sleep(500) }
  await waitFrames(3)

  const ui = await evalJs(`(() => ({
    touchUi: !!document.querySelector('.hud.touch-ui'),
    controls: !!document.querySelector('.mobile-controls'),
    field: !!document.querySelector('.mc-field'),
    attack: !!document.querySelector('.mc-attack'),
    skill: !!document.querySelector('.mc-skill'),
    burst: !!document.querySelector('.mc-burst'),
    jump: !!document.querySelector('.mc-jump'),
    sprint: !!document.querySelector('.mc-sprint'),
    slots: document.querySelectorAll('.mc-slot').length,
    desktopBar: getComputedStyle(document.querySelector('.combat-hud') || document.body).display,
  }))()`)
  console.log('     ui:', JSON.stringify(ui))
  check('スマホUIへ切り替わる', ui.touchUi && ui.controls && ui.field, JSON.stringify(ui))
  check('原神配置のボタンが揃っている', ui.attack && ui.skill && ui.burst && ui.jump && ui.sprint && ui.slots === 4,
    `攻撃/スキル/爆発/ジャンプ/ダッシュ + スロット${ui.slots}`)

  // ── 左半分：フローティングスティックで移動
  const before = await evalJs('({x: window.__sim.player.pos.x, z: window.__sim.player.pos.z})')
  await touch('touchStart', [{ x: 160, y: 240, id: 1 }])
  await touch('touchMove', [{ x: 160, y: 170, id: 1 }])
  const stick = await evalJs(`(() => {
    const el = document.querySelector('.mc-stick')
    return { visible: !!el, moveX: Math.round(window.__marugoto?.touchMove?.x * 100) / 100 }
  })()`)
  const axis = await evalJs(`(() => { const t = window.__marugoto.input.touch.move; return { x: Math.round(t.x * 100) / 100, y: Math.round(t.y * 100) / 100 } })()`)
  check('左側を触るとスティックが出る', stick.visible === true)
  check('スティックの入力が前進として入る', axis.y > 0.8, `move.y=${axis.y}`)
  await waitFrames(6)
  const after = await evalJs('({x: window.__sim.player.pos.x, z: window.__sim.player.pos.z})')
  const moved = Math.hypot(after.x - before.x, after.z - before.z)
  await touch('touchEnd', [])
  check('スティックでプレイヤーが動く', moved > 0.4, `${moved.toFixed(2)}m`)

  // ── 右半分：ドラッグで視点
  const yaw0 = await evalJs('window.__sim.camera.yaw')
  await touch('touchStart', [{ x: 620, y: 150, id: 2 }])
  for (let i = 1; i <= 6; i++) await touch('touchMove', [{ x: 620 + i * 20, y: 150, id: 2 }])
  await touch('touchEnd', [])
  await waitFrames(3)
  const yaw1 = await evalJs('window.__sim.camera.yaw')
  check('右側のドラッグでカメラが回る', Math.abs(yaw1 - yaw0) > 0.2, `Δyaw=${(yaw1 - yaw0).toFixed(2)}rad`)

  // ── 移動と視点の同時操作（原神と同じく2本指）
  const yaw2 = await evalJs('window.__sim.camera.yaw')
  await touch('touchStart', [{ x: 160, y: 240, id: 3 }])
  await touch('touchStart', [{ x: 160, y: 240, id: 3 }, { x: 620, y: 150, id: 4 }])
  await touch('touchMove', [{ x: 200, y: 240, id: 3 }, { x: 700, y: 150, id: 4 }])
  const both = await evalJs(`({ moveX: Math.round(window.__marugoto.input.touch.move.x * 100) / 100 })`)
  await waitFrames(2)
  const yaw3 = await evalJs('window.__sim.camera.yaw')
  await touch('touchEnd', [])
  check('移動しながら視点を回せる', both.moveX > 0.5 && Math.abs(yaw3 - yaw2) > 0.1,
    `move.x=${both.moveX} Δyaw=${(yaw3 - yaw2).toFixed(2)}`)

  // ── 攻撃ボタン
  const box = await evalJs(`(() => { const r = document.querySelector('.mc-attack').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
  await touch('touchStart', [{ x: box.x, y: box.y, id: 5 }])
  const attacked = await evalJs('!!window.__sim.player.action')
  await touch('touchEnd', [])
  check('攻撃ボタンで攻撃が出る', attacked === true, JSON.stringify(box))

  // ── スロット切替（原神のキャラ切替列）
  const slot = await evalJs(`(() => { const r = document.querySelectorAll('.mc-slot')[1].getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
  await touch('touchStart', [{ x: slot.x, y: slot.y, id: 6 }])
  await touch('touchEnd', [])
  await sleep(300)
  const picked = await evalJs('window.__sim.player.selectedAbility')
  check('右端の列で技を切り替えられる', picked === 'area', `選択=${picked}`)

  // ── ダッシュ（長押し）
  const sp = await evalJs(`(() => { const r = document.querySelector('.mc-sprint').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
  await touch('touchStart', [{ x: sp.x, y: sp.y, id: 7 }])
  const sprinting = await evalJs(`window.__marugoto.input.isHeld('sprint')`)
  await touch('touchEnd', [])
  const released = await evalJs(`window.__marugoto.input.isHeld('sprint')`)
  check('ダッシュは押している間だけ効く', sprinting === true && released === false, `押下=${sprinting} 離す=${released}`)

  const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId)
  fs.writeFileSync('screenshot-mobile.png', Buffer.from(shot.data, 'base64'))
  check('スマホ画面のスクリーンショット', fs.statSync('screenshot-mobile.png').size > 20000)

  const real = logs.filter((l) => !/Download the React DevTools|deprecat/i.test(l))
  check('例外・エラーが出ていない', real.length === 0, real.slice(0, 3).join(' | ').slice(0, 400))
  console.log(failures ? `\n❌ ${failures} 件失敗` : '\n✅ スマホ操作の実機確認を通過')
} catch (err) {
  console.error('検証中にエラー:', err.message)
  failures++
} finally {
  try { chrome.kill('SIGKILL') } catch {}
  try { fs.rmSync(profile, { recursive: true, force: true }) } catch {}
}
process.exit(failures ? 1 : 0)
