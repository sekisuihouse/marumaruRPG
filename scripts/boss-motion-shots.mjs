/**
 * BOSS FORGE を実ブラウザで開き、ボスのモーションを連番スクリーンショットで残す。
 *
 * 「動きが小さい」「脚が動いていない」といった見た目の指摘は、テストの ok/FAIL では
 * 判定できない。ここで撮った画像を見て直すための道具。
 *
 *   npm run dev                       # 別ターミナルで起動しておく
 *   node scripts/boss-motion-shots.mjs                     # 全ボス・代表攻撃
 *   node scripts/boss-motion-shots.mjs shrine quake        # ボスと攻撃を指定
 *   node scripts/boss-motion-shots.mjs --out /tmp/shots    # 保存先を指定
 *
 * CDP を直接叩くので追加の依存は無い（scripts/browser-check.mjs と同じ方式）。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const argv = process.argv.slice(2)
const outIndex = argv.indexOf('--out')
const OUT = outIndex >= 0 ? argv[outIndex + 1] : 'boss-motion-shots'
const positional = argv.filter((a, i) => !a.startsWith('--') && !a.startsWith('http') && !(outIndex >= 0 && i === outIndex + 1))
const URL_BASE = (argv.find((a) => a.startsWith('http')) || 'http://localhost:5173/').replace(/\?.*$/, '')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 9344

// 既定は4ボス×代表2技。脚と重心が見える技を選んである。
const DEFAULT_PLAN = [
  ['student', 'mimic'], ['student', 'spring'],
  ['stage', 'beat'], ['stage', 'encore'],
  ['shrine', 'quake'], ['shrine', 'sweep'],
  ['food', 'pan'], ['food', 'boil'],
]
const PLAN = positional.length >= 2 ? [[positional[0], positional[1]]]
  : positional.length === 1 ? DEFAULT_PLAN.filter(([b]) => b === positional[0])
    : DEFAULT_PLAN

if (!fs.existsSync(CHROME)) { console.log('Chrome が見つからないためスキップします:', CHROME); process.exit(0) }
if (!PLAN.length) { console.error('対象が見つかりません:', positional.join(' ')); process.exit(1) }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'marugoto-motion-'))
fs.mkdirSync(OUT, { recursive: true })
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--window-size=1280,860',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars', 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let ws = null

try {
  let wsUrl = null
  for (let i = 0; i < 60 && !wsUrl; i++) {
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl } catch { await sleep(250) }
  }
  if (!wsUrl) throw new Error('Chrome の DevTools に接続できませんでした')
  ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

  let id = 0
  const pending = new Map()
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data)
    if (!msg.id || !pending.has(msg.id)) return
    const p = pending.get(msg.id); pending.delete(msg.id)
    msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result)
  }
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const msgId = ++id; pending.set(msgId, { resolve, reject })
    ws.send(JSON.stringify({ id: msgId, method, params, sessionId }))
  })

  const { targetInfos } = await send('Target.getTargets')
  const page = targetInfos.find((t) => t.type === 'page')
  const { sessionId } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true })
  await send('Runtime.enable', {}, sessionId)
  await send('Page.enable', {}, sessionId)
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
    return r.result.value
  }
  const shot = async (name) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId)
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'))
    return `${name}.png`
  }

  await send('Page.navigate', { url: `${URL_BASE}?bossForge=1` }, sessionId)
  let ready = false
  for (let i = 0; i < 80 && !ready; i++) {
    ready = await evalJs(`!!(window.__three && document.querySelector('.boss-forge') && (window.__frames||0) > 20)`)
    if (!ready) await sleep(250)
  }
  if (!ready) throw new Error('BOSS FORGE が開きませんでした（npm run dev は動いていますか）')
  await sleep(1500)

  for (const [boss, action] of PLAN) {
    await evalJs(`document.querySelector('.forge-left button[data-boss-id="${boss}"]')?.click()`)
    await sleep(2200)
    // 歩き（脚が動いているか）
    await evalJs(`document.querySelector('.forge-actions button[data-pose-id="walk"]')?.click()`)
    await sleep(700); console.log(' ', await shot(`${boss}-walk`))
    await evalJs(`document.querySelector('.forge-actions button[data-pose-id="idle"]')?.click()`)
    await sleep(300)
    // 攻撃の3段階（予備動作・判定・後隙）
    await evalJs(`document.querySelector('.forge-actions button[data-action-id="${action}"]')?.click()`)
    await evalJs(`document.querySelector('.forge-controls button[data-forge="play"]')?.click()`)
    for (const [tag, wait] of [['1-windup', 500], ['2-hit', 350], ['3-recover', 350]]) {
      await sleep(wait)
      const phase = await evalJs(`(window.__sim.bosses||[]).find(b=>b.def.id==='${boss}')?.attack?.phase || 'idle'`)
      console.log(' ', await shot(`${boss}-${action}-${tag}`), `(${phase})`)
    }
    await sleep(400)
  }

  const errors = await evalJs(`JSON.stringify(window.__bossModelErrors || [])`)
  if (errors !== '[]') console.log('モデル読み込みエラー:', errors)
  console.log(`\n保存先: ${path.resolve(OUT)}`)
} catch (err) {
  console.error('失敗:', err.message)
  process.exitCode = 1
} finally {
  try { ws?.close() } catch { /* ignore */ }
  try { chrome.kill('SIGKILL') } catch { /* ignore */ }
  try { fs.rmSync(profile, { recursive: true, force: true }) } catch { /* ignore */ }
}
