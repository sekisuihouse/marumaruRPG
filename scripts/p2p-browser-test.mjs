/**
 * 実ブラウザ2台でのP2P結合テスト。
 *
 *   npm run dev:all              # 別ターミナルで Vite + シグナリングを起動
 *   node scripts/p2p-browser-test.mjs [url]          # ブラウザ2台（別PC相当）
 *   node scripts/p2p-browser-test.mjs [url] --tabs   # 1ブラウザ2タブ（手元で試す構成）
 *
 * scripts/multiplayer-test.mjs はシグナリングサーバーと純関数だけを見る。
 * こちらは「ルーム作成 → 参加 → ゲーム開始 → WebRTC DataChannel 確立 →
 * 入力・スナップショット・破壊イベントが実際に往復するか」までを通しで確認する。
 *
 * 既定はホストと参加者を別のChromeプロセスで起動する（別PC相当）。
 * --tabs では1ブラウザの2タブにする。背面タブは requestAnimationFrame が止まるので、
 * src/net/keepalive.js の保険が効いているかを確かめる構成になる。
 *
 * 注意1: ヘッドレスは SwiftShader(ソフトウェア描画)なので実速度の 1/5 程度しか出ない。
 *         距離や件数のしきい値はそれを見込んで緩めにしてある。
 * 注意2: このテストと npm run test:browser は同時に走らせない。
 *         ソフトウェア描画のChromeを3つ以上同時に動かすと、どれかが初期化に失敗する。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const URL_TARGET = process.argv[2] || 'http://localhost:5173/'
const SIGNAL_HEALTH = process.env.SIGNAL_HEALTH || 'http://localhost:8787/health'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (!fs.existsSync(CHROME)) {
  console.log('Chrome が見つからないためスキップします:', CHROME)
  process.exit(0)
}
try {
  const health = await (await fetch(SIGNAL_HEALTH)).json()
  if (!health?.ok) throw new Error('unhealthy')
} catch {
  console.log(`シグナリングサーバー(${SIGNAL_HEALTH})が起動していないためスキップします。`)
  console.log('  npm run dev:all  で Vite とシグナリングをまとめて起動できます。')
  process.exit(0)
}

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? `  — ${detail}` : ''}`)
  if (!ok) failures++
}

const procs = []
const profiles = []

const TAB_MODE = process.argv.includes('--tabs')
/**
 * --slow-sdp: setRemoteDescription をわざと遅らせ、
 * 「answerの適用中に相手のICE candidateが届く」実ネットワークの状況を再現する。
 * ここで候補を捨てると実機で接続できなくなるため、その回帰を捕まえる。
 */
const SLOW_SDP = process.argv.includes('--slow-sdp')
const SLOW_SDP_PATCH = `(() => {
  const proto = window.RTCPeerConnection.prototype
  if (proto.__slowPatched) return 'already'
  const orig = proto.setRemoteDescription
  proto.setRemoteDescription = function (d) {
    return new Promise((r) => setTimeout(r, 400)).then(() => orig.call(this, d))
  }
  proto.__slowPatched = true
  return 'patched'
})()`

/** Chrome を起動して CDP へ繋ぐ */
async function connectCdp(port, startUrl) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'marugoto-p2p-'))
  profiles.push(profile)
  procs.push(spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--window-size=1100,700',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    startUrl,
  ], { stdio: 'ignore' }))

  let ws
  for (let i = 0; i < 80; i++) {
    try {
      const j = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
      if (j.webSocketDebuggerUrl) { ws = new WebSocket(j.webSocketDebuggerUrl); break }
    } catch { /* まだ起動していない */ }
    await sleep(250)
  }
  if (!ws) throw new Error(`Chrome(${port}) の DevTools に接続できませんでした`)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

  const pending = new Map()
  const events = []
  let id = 0
  ws.onmessage = (m) => {
    const g = JSON.parse(m.data)
    if (g.id && pending.has(g.id)) {
      const { resolve, reject } = pending.get(g.id)
      pending.delete(g.id)
      g.error ? reject(new Error(JSON.stringify(g.error))) : resolve(g.result)
    } else if (g.method) events.push(g)
  }
  const send = (method, params = {}, sid) => new Promise((resolve, reject) => {
    const i = ++id
    pending.set(i, { resolve, reject })
    ws.send(JSON.stringify({ id: i, method, params, sessionId: sid }))
  })
  return { send, events }
}

/** セッション（＝1つの画面）を操作する窓口 */
async function makeSession(cdp, sessionId) {
  await cdp.send('Runtime.enable', {}, sessionId)
  await cdp.send('Page.enable', {}, sessionId)
  await cdp.send('Log.enable', {}, sessionId)
  const ev = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result.value
  }
  return {
    ev,
    events: cdp.events,
    click: (text) => ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes(${JSON.stringify(text)}))?.click()`),
    key: (type, k, code, vk) => cdp.send('Input.dispatchKeyEvent', {
      type, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
    }, sessionId),
    shot: async (file) => {
      const r = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId)
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
    },
    /** そのタブを前面にする（--tabs のときだけ意味を持つ） */
    front: () => cdp.send('Page.bringToFront', {}, sessionId).catch(() => {}),
  }
}

/** ブラウザ1台＋1画面 */
async function launch(port) {
  const cdp = await connectCdp(port, URL_TARGET)
  const { targetInfos } = await cdp.send('Target.getTargets')
  const page = targetInfos.find((t) => t.type === 'page')
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true })
  return makeSession(cdp, sessionId)
}

/** 既存ブラウザに新しいタブを開く */
async function openTab(cdp) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  const session = await makeSession(cdp, sessionId)
  await cdp.send('Page.navigate', { url: URL_TARGET }, sessionId)
  return session
}

const cleanup = async () => {
  for (const p of procs) { try { p.kill('SIGKILL') } catch { /* already gone */ } }
  await Promise.all(procs.map((p) => new Promise((r) => { if (p.exitCode !== null) r(); else p.once('exit', r); setTimeout(r, 3000) })))
  await sleep(1500)
  for (const p of profiles) { try { fs.rmSync(p, { recursive: true, force: true }) } catch { /* ignore */ } }
}

try {
  console.log(`\n開いています: ${URL_TARGET}（${TAB_MODE ? '1ブラウザ2タブ' : 'ホスト用と参加者用に2台のChrome'}）`)
  let host, guest
  if (TAB_MODE) {
    const cdp = await connectCdp(9391, 'about:blank')
    host = await openTab(cdp)
    guest = await openTab(cdp)
  } else {
    host = await launch(9391)
    guest = await launch(9392)
  }
  const H = host.ev
  const G = guest.ev
  await sleep(13000)
  if (SLOW_SDP) {
    console.log('      SDP適用を遅延させて ICE candidate の競合を再現します:',
      await host.ev(SLOW_SDP_PATCH), await guest.ev(SLOW_SDP_PATCH))
  }

  // ── ルーム作成
  await host.click('マルチプレイ'); await sleep(700)
  await host.click('ルームを作る'); await sleep(700)
  await host.click('ルームを作成'); await sleep(3000)
  const code = await H(`(()=>{const b=document.querySelector('button.code');return b?b.textContent.replace('　コピー','').trim():null})()`)
  check('ホストがルームを作成できる', !!code && code.length === 6, `コード ${code}`)
  if (!code) throw new Error('ルームコードを取得できませんでした')

  // ── 参加
  await guest.click('マルチプレイ'); await sleep(700)
  await guest.click('ルームに参加'); await sleep(700)
  await G(`(()=>{const i=[...document.querySelectorAll('.multi-box input')].find(x=>x.maxLength===6)
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(i, ${JSON.stringify(code)})
    i.dispatchEvent(new Event('input',{bubbles:true})); return i.value})()`)
  await sleep(500)
  await guest.click('参加する'); await sleep(4000)
  check('参加者がルームへ入れる', await G(`window.__marugoto.multiplayer.status==='connected'&&window.__marugoto.multiplayer.role==='guest'`))
  check('ホストの参加者一覧に反映される', (await H(`(window.__marugoto.multiplayer.room?.members||[]).length`)) === 2)

  // ── 開始
  await guest.click('準備完了'); await sleep(1500)
  // 実際の操作と同じく、開始ボタンを押す時点ではホスト画面が前面にある。
  // 3D（町の破壊データ）は前面のあいだに構築される。背面のままだと
  // レイアウトが測れず Canvas が起動しないため、ここは必ず前面にする。
  await host.front()
  await host.click('ゲーム開始')
  let townReady = false
  for (let i = 0; i < 60; i++) { await sleep(1000); townReady = await H(`(window.__townParts||0)>0`); if (townReady) break }
  check('ホスト画面で町の破壊データが構築される', townReady, `${await H(`window.__townParts`)} 個`)
  // 以降ホストは背面（利用者が参加者側の画面を見ている状態）
  await guest.front()
  await sleep(20000)

  const probe = `(()=>{const m=window.__marugoto.multiplayer,s=window.__sim
    return JSON.stringify({role:m.role,pkOut:m.packetsOut,pkIn:m.packetsIn,netSeq:s.net.sequence,
      lastSnap:s.net.lastSnapshot,remote:m.remotePlayers.size,simTime:+s.time.toFixed(1),
      frames:window.__frames||0,parts:window.__townParts||0})})()`
  console.log('      HOST :', await H(probe))
  console.log('      GUEST:', await G(probe))

  check('両方がワールドへ入る', (await H(`!!document.querySelector('.hud')`)) && (await G(`!!document.querySelector('.hud')`)))
  const peerState = await H(`JSON.stringify([...window.__marugoto.multiplayer.peers.values()].map(p=>({connected:p.connected,state:p.connectionState})))`)
  check('WebRTC DataChannel が接続される', /"connected":true/.test(peerState), peerState)
  const hostVisibility = await H(`document.visibilityState`)
  check('ホストのシミュレーションが進む', (await H(`window.__sim.time`)) > 3,
    `simTime=${await H(`+window.__sim.time.toFixed(1)`)} / 画面=${hostVisibility} / 描画フレーム=${await H(`window.__frames||0`)}`)
  check('非表示・低fpsでも進行を止めない保険が動く', (await H(`window.__marugoto.net.keepAlive()`)) === true)
  check('ホストがスナップショットを送出する', (await H(`window.__sim.net.sequence`)) > 20, `seq=${await H(`window.__sim.net.sequence`)}`)
  check('参加者がスナップショットを受信する', (await G(`window.__sim.net.lastSnapshot`)) > 0, `lastSnapshot=${await G(`window.__sim.net.lastSnapshot`)}`)
  check('互いのアバターが生成される',
    (await G(`window.__marugoto.multiplayer.remotePlayers.size`)) >= 1 && (await H(`window.__marugoto.multiplayer.remotePlayers.size`)) >= 1)
  const enemies = [await H(`window.__sim.enemies.filter(e=>e.alive).length`), await G(`window.__sim.enemies.filter(e=>e.alive).length`)]
  check('敵の出現がホストから参加者へ同期される', enemies[1] > 0 && enemies[1] === enemies[0], `ホスト${enemies[0]}体 / 参加者${enemies[1]}体`)

  // ── 参加者を歩かせ、ホスト側のアバターが追従するか
  // 進める向きは NavMesh で選ぶ（スポーンの正面はすぐ壁になっている）
  await G(`(async()=>{const nav=await import('/src/engine/nav.js'); const s=window.__sim
    let best=null
    for(let a=0;a<24;a++){const ang=a/24*Math.PI*2; let reach=0
      for(let d=0.5;d<=10;d+=0.5){ if(!nav.canStand(s.player.pos.x+Math.cos(ang)*d, s.player.pos.z+Math.sin(ang)*d)) break; reach=d }
      if(!best||reach>best.reach) best={ang,reach}}
    // カメラ前方 = -(sin yaw, cos yaw) が進行方向になる
    s.camera.yaw = Math.atan2(-Math.cos(best.ang), -Math.sin(best.ang))
    return best.reach})()`)
  const selfPos = () => G(`JSON.stringify([+window.__sim.player.pos.x.toFixed(2),+window.__sim.player.pos.z.toFixed(2)])`)
  const avatarPos = () => H(`(()=>{const r=[...window.__marugoto.multiplayer.remotePlayers.values()][0];return JSON.stringify([+r.pos.x.toFixed(2),+r.pos.z.toFixed(2)])})()`)
  const gBefore = JSON.parse(await selfPos())
  const hBefore = JSON.parse(await avatarPos())
  await guest.key('keyDown', 'w', 'KeyW', 87)
  await sleep(16000)
  await guest.key('keyUp', 'w', 'KeyW', 87)
  await sleep(3500)
  const gAfter = JSON.parse(await selfPos())
  const hAfter = JSON.parse(await avatarPos())
  const gMoved = Math.hypot(gAfter[0] - gBefore[0], gAfter[1] - gBefore[1])
  const hMoved = Math.hypot(hAfter[0] - hBefore[0], hAfter[1] - hBefore[1])
  const gap = Math.hypot(hAfter[0] - gAfter[0], hAfter[1] - gAfter[1])
  check('参加者が実際に移動する', gMoved > 1, `${gMoved.toFixed(2)}m`)
  check('参加者の移動がホストへ届く', hMoved > 1, `${hMoved.toFixed(2)}m`)
  check('ホストと参加者で位置が一致する', gap < 1.5, `ずれ ${gap.toFixed(2)}m`)

  // ── 実際に3Dシーンへ「相手の姿」が出ているか（ストアではなく描画を見る）
  const sceneProbe = `(()=>{
    const t = window.__three
    if (!t) return JSON.stringify({ ok:false, reason:'no scene' })
    const mp = window.__marugoto.multiplayer
    const remotes = [...mp.remotePlayers.values()]
    const avatars = []
    t.scene.traverse((o) => { if (o.name === 'Adventurer') {
      o.updateWorldMatrix(true, false)
      const p = o.getWorldPosition(new (o.position.constructor)())
      let visible = o.visible, n = o
      while (n.parent) { n = n.parent; if (!n.visible) visible = false }
      avatars.push({ x:+p.x.toFixed(2), y:+p.y.toFixed(2), z:+p.z.toFixed(2), visible })
    }})
    return JSON.stringify({ ok:true, avatars, remoteData: remotes.map(r=>({ id:r.id.slice(0,4),
      pos:[+r.pos.x.toFixed(2), +r.pos.y.toFixed(2), +r.pos.z.toFixed(2)], samples:(r.samples||[]).length, alive:r.alive })),
      self:[+window.__sim.player.pos.x.toFixed(2), +window.__sim.player.pos.z.toFixed(2)] })
  })()`
  const hostScene = JSON.parse(await H(sceneProbe))
  const guestScene = JSON.parse(await G(sceneProbe))
  console.log('      ホスト描画:', JSON.stringify(hostScene))
  console.log('      参加者描画:', JSON.stringify(guestScene))
  check('ホストの画面に相手の3Dモデルが出ている', hostScene.ok && hostScene.avatars.filter((a) => a.visible).length >= 2,
    `Adventurer ${hostScene.avatars?.length}体（表示 ${hostScene.avatars?.filter((a) => a.visible).length}体）`)
  check('参加者の画面に相手の3Dモデルが出ている', guestScene.ok && guestScene.avatars.filter((a) => a.visible).length >= 2,
    `Adventurer ${guestScene.avatars?.length}体（表示 ${guestScene.avatars?.filter((a) => a.visible).length}体）`)
  {
    const far = (sc) => {
      const vis = (sc.avatars || []).filter((a) => a.visible)
      const other = vis.find((a) => Math.hypot(a.x - sc.self[0], a.z - sc.self[1]) > 0.5)
      return other || null
    }
    check('相手の3Dモデルが自分と別の位置にある（重なって見えなくなっていない）',
      !!far(hostScene) && !!far(guestScene),
      `ホスト側=${JSON.stringify(far(hostScene))} 参加者側=${JSON.stringify(far(guestScene))}`)
  }

  // ── 建物破壊の同期
  const pid = await H(`(()=>{const d=window.__marugoto.destruct
    const p=d.registry.parts.find(x=>x.category==='building'&&!x.broken); if(!p) return -1
    d.breakPart(p,1,0.4,0,1.2); return p.id})()`)
  await sleep(4000)
  check('建物の破壊が参加者へ同期される', pid >= 0 && await G(`window.__marugoto.destruct.registry.parts[${pid}]?.broken===true`), `partId=${pid}`)

  // ── 計測（資料『ログとメトリクス』『成功基準』に対応）
  const hostStats = JSON.parse(await H(`JSON.stringify(window.__marugoto.net.stats())`))
  const guestStats = JSON.parse(await G(`JSON.stringify(window.__marugoto.net.stats())`))
  console.log('      ホスト計測:', JSON.stringify({ stage: hostStats.stage, states: hostStats.states, route: hostStats.route,
    backpressure: hostStats.backpressure, snapshot: hostStats.snapshot, hostTick: hostStats.host.tickMs }))
  console.log('      参加者計測:', JSON.stringify({ sequence: guestStats.sequence, snapshotAge: guestStats.snapshot.ageMs,
    interpolation: guestStats.interpolation, correction: guestStats.correction, clock: guestStats.clock }))

  check('接続段階が DATA_CHANNEL_OPEN まで到達する', hostStats.stage === 'DATA_CHANNEL_OPEN' || hostStats.stage === 'ICE_CONNECTED', hostStats.stage)
  check('選択された経路が取得できる', !!hostStats.route.local, `${hostStats.route.local}/${hostStats.route.remote} ${hostStats.route.protocol} rtt=${hostStats.route.rttMs}ms`)
  const chans = Object.fromEntries(hostStats.channels.map((c) => [c.label, c]))
  check('移動チャネルが ordered:false / 再送なし', chans.unreliable && chans.unreliable.ordered === false && chans.unreliable.maxRetransmits === 0,
    JSON.stringify(hostStats.channels.map((c) => ({ l: c.label, ordered: c.ordered, rt: c.maxRetransmits }))))
  check('重要イベントチャネルは ordered', chans.reliable && chans.reliable.ordered === true)
  check('送信待ちキューが積み上がっていない', hostStats.backpressure.bufferedMax < 256 * 1024,
    `最大 ${Math.round(hostStats.backpressure.bufferedMax / 1024)}KiB / 破棄 ${hostStats.backpressure.droppedStale}`)
  check('スナップショットが 16KiB 以内', hostStats.snapshot.bytes.p95 > 0 && hostStats.snapshot.bytes.p95 < 16 * 1024,
    `p95 ${Math.round(hostStats.snapshot.bytes.p95 / 1024 * 10) / 10}KiB`)
  check('ホストの tick 処理が送信間隔(50ms)未満', hostStats.host.tickMs.p95 < 50, `p95 ${hostStats.host.tickMs.p95}ms`)
  check('参加者がシーケンスを適用できている', guestStats.sequence.applied > 20,
    `適用${guestStats.sequence.applied} 欠落${guestStats.sequence.gap} 逆転${guestStats.sequence.reorder} 重複${guestStats.sequence.duplicate}`)
  check('補間バッファが枯渇しきっていない', guestStats.interpolation.frames === 0 || guestStats.interpolation.underrun / Math.max(1, guestStats.interpolation.frames) < 0.9,
    `underrun ${guestStats.interpolation.underrun}/${guestStats.interpolation.frames} depth=${guestStats.interpolation.depth}`)
  check('自己位置の補正量が小さい', guestStats.correction.meters.p95 < 0.5,
    `p95 ${guestStats.correction.meters.p95}m / snap ${guestStats.correction.snap}回`)
  check('ホストとの時刻オフセットを推定できている', guestStats.clock.ready === true && guestStats.clock.samples >= 3,
    `offset ${guestStats.clock.offsetMs}ms / rtt ${guestStats.clock.rttMs}ms / ${guestStats.clock.samples}サンプル`)
  check('スナップショットの鮮度が測れている', guestStats.snapshot.ageMs.p95 > 0 && guestStats.snapshot.ageMs.p95 < 1000,
    `p50 ${guestStats.snapshot.ageMs.p50}ms / p95 ${guestStats.snapshot.ageMs.p95}ms`)

  console.log('      通信量:', await H(`(()=>{const m=window.__marugoto.multiplayer
    return JSON.stringify({送信:Math.round(m.bytesOut/1024)+'KB',受信:Math.round(m.bytesIn/1024)+'KB'})})()`))
  await host.shot('screenshot-p2p-host.png')
  await guest.shot('screenshot-p2p-guest.png')

  for (const [label, tab] of [['ホスト', host], ['参加者', guest]]) {
    const errs = tab.events.filter((e) => e.method === 'Runtime.exceptionThrown')
      .map((e) => e.params.exceptionDetails.exception?.description?.slice(0, 160))
    const cons = tab.events.filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
      .map((e) => e.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200))
    check(`${label}: JavaScript例外が出ていない`, errs.length === 0, errs.slice(0, 2).join(' | '))
    check(`${label}: コンソールエラーが出ていない`, cons.length === 0, cons.slice(0, 2).join(' | '))
  }

  console.log(`\n${failures === 0 ? '✅ P2P結合検証を通過' : `❌ ${failures} 件の失敗`}`)
} catch (err) {
  console.error('検証中にエラー:', err.message)
  failures++
} finally {
  await cleanup()
}
process.exit(failures ? 1 : 0)
