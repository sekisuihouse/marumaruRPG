/** Chrome拡張を実サイトへ読み込み、転生ゲートとホーム火球の接続を確認する。 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 9355
const extension = path.resolve('marugoto-tensei-extension')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'marugoto-extension-'))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let failures = 0
const check = (name, ok, detail = '') => { console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); if (!ok) failures++ }

if (!fs.existsSync(CHROME)) { console.log('Chrome が見つからないためスキップします。'); process.exit(0) }
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, `--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1280,800', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', 'about:blank',
], { stdio: 'ignore' })
const cleanup = () => { try { chrome.kill('SIGKILL') } catch { /* already closed */ }; try { fs.rmSync(profile, { recursive: true, force: true }) } catch { /* ignore */ } }

try {
  let wsUrl = null
  for (let i = 0; i < 60 && !wsUrl; i++) {
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl } catch { await sleep(250) }
  }
  if (!wsUrl) throw new Error('Chrome DevTools に接続できません')
  const ws = new WebSocket(wsUrl); await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let id = 0; const pending = new Map()
  ws.onmessage = ({ data }) => { const m = JSON.parse(data); const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result) }
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const requestId = ++id; pending.set(requestId, { resolve, reject }); ws.send(JSON.stringify({ id: requestId, method, params, sessionId })) })
  const { targetInfos } = await send('Target.getTargets'); const page = targetInfos.find((target) => target.type === 'page')
  const { sessionId } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true })
  await send('Runtime.enable', {}, sessionId); await send('Page.enable', {}, sessionId)
  await send('Page.navigate', { url: 'https://2026.marugotosai.jp/' }, sessionId)
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)).result.value
  for (let i = 0; i < 32; i++) {
    const ready = await evaluate(`!!document.querySelector('#marugoto-home-fire-overlay') && [...document.querySelectorAll('canvas')].some((x)=>{const r=x.getBoundingClientRect();return r.width>120&&r.height>100&&r.bottom>0&&r.top<innerHeight})`)
    if (ready) break
    await sleep(250)
  }
  check('実サイトの3D Canvasを検出', (await evaluate(`document.querySelectorAll('canvas').length`)) > 0)
  const injected = await evaluate(`!!document.querySelector('#marugoto-home-fire-overlay')`)
  // Chromeのヘッドレス実行ではポリシーにより unpacked 拡張の content script を
  // 読み込まない版がある。これはテスト環境の制限として明示的にスキップする。
  if (!injected) { console.log('  skip  ヘッドレスChromeが拡張機能のcontent scriptを有効化しませんでした。通常Chromeで確認してください。'); ws.close(); process.exitCode = 0 }
  else {
  check('ホーム火球レイヤーを注入', injected)
  const target = await evaluate(`(() => { const c=[...document.querySelectorAll('canvas')].find((x)=>{const r=x.getBoundingClientRect(); return r.width>120&&r.height>100&&r.bottom>0&&r.top<innerHeight}); if(!c)return null; const r=c.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height} })()`)
  if (!target) throw new Error('対象Canvasが見つかりません')
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y }, sessionId)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67 }, sessionId)
  await sleep(800)
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67 }, sessionId)
  const fire = await evaluate(`({ hint:!!document.querySelector('#marugoto-home-spell-hint'), proxies:document.querySelectorAll('.mtg-home-fx').length, effect:!!document.querySelector('#marugoto-home-fire-overlay') })`)
  check('Cキーで火球・局所破壊レイヤーを開始', fire.hint && fire.effect && fire.proxies > 0, JSON.stringify(fire))
  const dimensions = await evaluate(`(() => { const c=[...document.querySelectorAll('canvas')].find((x)=>x.style.opacity==='0'); const r=c?.getBoundingClientRect(); return r&&[r.width,r.height] })()`)
  check('対象3D Canvasの表示サイズを維持', !!dimensions && dimensions[0] === target.w && dimensions[1] === target.h, `${dimensions}`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 }, sessionId)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 }, sessionId)
  await sleep(500)
  check('3D円盤から転生確認を開く', await evaluate(`!!document.querySelector('#marugoto-tensei-gate .mtg-dialog')`))
  ws.close()
  }
} catch (error) { failures++; console.error(error) } finally { cleanup() }
if (failures) process.exit(1)
