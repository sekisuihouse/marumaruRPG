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

  const forgeMode = URL_TARGET.includes('bossForge=1')
  // ヘッドレスChromeでは Pointer Lock を伴うタイトルの synthetic click が応答を返さない
  // 場合があるため、通常の描画・入力検証は既存の自動開始経路を使う。
  const navigateUrl = !forgeMode && !URL_TARGET.includes('?') ? `${URL_TARGET}?autostart=1` : URL_TARGET
  console.log(`\n開いています: ${navigateUrl}`)
  await send('Page.navigate', { url: navigateUrl }, sessionId)

  // 起動 + アセット読み込みを待つ
  await sleep(9000)

  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    }, sessionId)
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed')
    return r.result.value
  }

  if (forgeMode) {
    let forgeReady = false
    for (let i = 0; i < 100; i++) {
      forgeReady = await evalJs(`Boolean(document.querySelector('.boss-forge') && window.__three && window.__frames > 20)`)
      if (forgeReady) break
      await sleep(500)
    }
    check('BOSS FORGEが開発URLで起動する', forgeReady)
    const forge = await evalJs(`(async () => {
      const s = window.__sim
      const ids = ['student', 'stage', 'shrine', 'food']
      const switched = []
      for (const id of ids) {
        const button = document.querySelector('.forge-left button[data-boss-id="' + id + '"]')
        if (!button) continue
        button.click()
        await new Promise((resolve) => setTimeout(resolve, 180))
        switched.push(s.bossForge?.bossId)
      }
      const force = [...document.querySelectorAll('.forge-controls button')].find((b) => b.textContent.includes('指定攻撃'))
      force?.click()
      const forced = s.bosses.find((b) => b.def.id === s.bossForge?.bossId)?.attack?.def?.id || null
      ;[...document.querySelectorAll('.forge-right button')].find((b) => b.textContent.includes('Codexプロンプト'))?.click()
      await new Promise((resolve) => setTimeout(resolve, 80))
      const prompt = document.querySelector('.forge-prompt')?.value || ''
      const combat = [...document.querySelectorAll('.forge-controls button')].find((b) => b.textContent.includes('実戦開始'))
      combat?.click()
      const inCombat = s.bossForge?.combat === true
      await new Promise((resolve) => setTimeout(resolve, 80))
      ;[...document.querySelectorAll('.forge-controls button')].find((b) => b.textContent.includes('編集へ戻る'))?.click()
      await new Promise((resolve) => setTimeout(resolve, 350))
      return {
        panels: document.querySelectorAll('.forge-panel').length,
        actions: document.querySelectorAll('.forge-actions button').length,
        switched,
        forced,
        inCombat,
        prompt,
        hitbox: !!document.querySelector('.forge-marker') || !!s.bossForge,
        modelHeight: s.bosses.find((b) => b.def.id === s.bossForge?.bossId)?.forgeModelHeight || 0,
        pointerLocked: Boolean(document.pointerLockElement),
        townVisible: (() => { let visible = 0; window.__three.scene.traverse((o) => { if (!o.name.startsWith('town_')) return; let node = o; while (node && node.visible) node = node.parent; if (!node) visible++ }); return visible })(),
      }
    })()`)
    check('BOSS FORGEの左右パネルが表示される', forge.panels === 2, `${forge.panels}枚`)
    check('4ボスを順番に切り替えられる', forge.switched.join(',') === 'student,stage,shrine,food', forge.switched.join(','))
    check('選択ボスの攻撃を即時再生できる', Boolean(forge.forced), String(forge.forced))
    check('実戦デモへ切り替えられる', forge.inCombat === true)
    check('Codex向けプロンプトを生成できる', /bossId: food/.test(forge.prompt), forge.prompt.slice(0, 80))
    check('BOSS FORGEの攻撃一覧が表示される', forge.actions > 0, `${forge.actions}個`)
    check('編集時は通常の町を隠す', forge.townVisible === 0, `${forge.townVisible} メッシュ`)
    check('選択ボスのモデル寸法を取得できる', forge.modelHeight > 0, `${forge.modelHeight.toFixed(2)}m`)
    check('編集時のボタン操作でカーソルをロックしない', forge.pointerLocked === false)
  } else {
  // タイトル画面 → ゲーム開始
  const started = await evalJs(`(() => {
    const btns = [...document.querySelectorAll('.title-actions button')]
    const target = btns.find(b => b.textContent.includes('はじめる') || b.textContent.includes('最初から'))
    if (!target) return window.__sim?.mode === 'play' ? 'autostart' : 'no-title-button'
    target.click()
    return 'clicked'
  })()`)
  check('通常ゲームを開始できる', started === 'clicked' || started === 'autostart', String(started))

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
  // スポーンの正面はすぐ壁なので、NavMeshで通れる向きを選んでから歩かせる
  await evalJs(`(async () => {
    const nav = await import('/src/engine/nav.js'); const s = window.__sim
    let best = null
    for (let a = 0; a < 24; a++) {
      const ang = a / 24 * Math.PI * 2
      let reach = 0
      for (let d = 0.5; d <= 10; d += 0.5) {
        if (!nav.canStand(s.player.pos.x + Math.cos(ang) * d, s.player.pos.z + Math.sin(ang) * d)) break
        reach = d
      }
      if (!best || reach > best.reach) best = { ang, reach }
    }
    // カメラ前方 = -(sin yaw, cos yaw) が進行方向になる
    s.camera.yaw = Math.atan2(-Math.cos(best.ang), -Math.sin(best.ang))
    return best.reach
  })()`)
  const before = await evalJs(`(() => { const s = window.__sim; return s ? [s.player.pos.x, s.player.pos.z] : null })()`)
  await key('keyDown', 'w', 'KeyW', 87)
  await sleep(5000)
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
      abilitySlots: document.querySelectorAll('.ability-slots button').length,
      quickActions: document.querySelectorAll('.quick-actions button').length,
      abilityUse: document.querySelector('.ability-use')?.textContent || '',
      questOpen: !!document.querySelector('.quest-list'),
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
    check('4つの技スロットが表示される', state.abilitySlots === 4, `${state.abilitySlots}個`)
    check('短い基本アクションが4つ表示される', state.quickActions === 4, `${state.quickActions}個`)
    check('選択中の技の状態が文字で分かる', /R.*(使う|連続火球)|🔒 Lv\./.test(state.abilityUse), state.abilityUse)
    check('Jキーでクエスト画面を開ける', state.questOpen === true)
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

  // 以降の描画検証はポーズを解除して行う。
  await evalJs(`document.querySelector('.quest-list')?.closest('.panel')?.querySelector('header button')?.click()`)
  await sleep(300)

  // 開発URLだけにあるネタ技。実際の KeyboardEvent → Input Manager →
  // Projectile → GLB表示の入口まで通す。本番URLではこの判定自体をしない。
  if (URL_TARGET.includes('debug=1')) {
    await evalJs(`window.__sim.camera.pitch = 0`)
    await key('keyDown', 'p', 'KeyP', 80)
    const debugKeySeen = await evalJs(`Boolean(window.__marugoto?.keys?.debugPropShot)`)
    await key('keyUp', 'p', 'KeyP', 80)
    await sleep(80)
    const debugPropShot = await evalJs(`(() => {
      const s = window.__sim
      const projectiles = s.projectiles.filter((p) => p.kind === 'debug-prop')
      return { enabled: s.debugMode, fired: s.debugPropShotsFired, count: projectiles.length, asset: projectiles[0]?.propAsset, rendered: !!window.__three }
    })()`)
    check('デバッグ時にPで町小道具弾を発射できる', debugKeySeen && debugPropShot.enabled && debugPropShot.fired > 0 && debugPropShot.count > 0 && Number.isInteger(debugPropShot.asset), JSON.stringify({ debugKeySeen, ...debugPropShot }))
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

  // 破壊シェイク中でもカメラが地面へ沈まないか（ボス戦で揺れが最大になる）
  {
    const shake = JSON.parse(await evalJs(`(async () => {
      const s = window.__sim, t = window.__three
      const nav = window.__marugoto.nav
      const dist = s.camera.dist, amount = s.settings.shakeAmount
      // カメラを地面すれすれ（最短距離・最小俯角）にして、大きく揺らす
      s.camera.dist = 3.5
      s.settings.shakeAmount = 30
      let worst = 0
      for (let i = 0; i < 40; i++) {
        s.juice.shake = 1.4                     // ボス級の破壊シェイクを毎フレーム積む
        s.player.hp = Math.max(1, s.player.hp - 1)  // 被弾シェイクも重ねる
        s.camera.pitch = 0.06                       // 最小俯角＝地面すれすれ
        await new Promise((r) => requestAnimationFrame(r))
        const cam = t.camera.position
        const floor = nav.groundY(cam.x, cam.z, s.player.pos.y) + 0.7
        worst = Math.min(worst, cam.y - floor)
      }
      s.juice.shake = 0
      s.camera.dist = dist
      s.settings.shakeAmount = amount
      s.player.hp = s.player.maxHp
      return JSON.stringify({ worst: +worst.toFixed(2) })
    })()`))
    // カメラの下限は groundY+0.7。揺れをクランプの後に掛けないとここを割って地面へ沈む。
    check('破壊シェイク中もカメラが地面に沈まない', shake.worst > -0.05,
      `接地下限からの余裕 最小 ${shake.worst}m`)
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
        tabs: document.querySelectorAll('.help-tabs button').length,
        title: panel?.querySelector('header b')?.textContent || '',
        aria: document.querySelector('.panel')?.getAttribute('aria-modal'),
      })
    }, 400))
  })()`)
  check('操作説明パネルが開く', help.open === true)
  check('基本操作のキー説明が表示される', help.rows >= 5, `${help.rows}行`)
  check('操作説明が6つのタブに分かれている', help.tabs === 6, `${help.tabs}個`)
  check('MacBook向けの操作説明になっている', /MacBook/.test(help.title), help.title)
  check('モーダルに aria 属性がある', help.aria === 'true', String(help.aria))
  const shotHelp = await send('Page.captureScreenshot', { format: 'png' }, sessionId)
  fs.writeFileSync('screenshot-help.png', Buffer.from(shotHelp.data, 'base64'))
  await evalJs(`document.querySelector('.panel-box header button')?.click()`)
  await sleep(500)
  }

  // ── BOSS FORGE（開発用の編集モード）
  try {
    await send('Page.navigate', { url: `${URL_TARGET.replace(/\?.*$/, '')}?bossForge=1` }, sessionId)
    let forgeReady = false
    for (let i = 0; i < 90; i++) {
      forgeReady = await evalJs(`!!(window.__three && document.querySelector('.boss-forge') && (window.__frames||0) > 20 && window.__sim.bossForge)`)
      if (forgeReady) break
      await sleep(1000)
    }
    check('BOSS FORGE: ?bossForge=1 で編集モードが開く', forgeReady)

    if (forgeReady) {
      /** 編集画面の状態を一度にまとめて取る（見た目・カメラ・遮蔽） */
      const probe = `(() => {
        const t = window.__three, s = window.__sim, f = s.bossForge
        const b = (s.bosses || []).find((x) => x.def.id === f.bossId)
        const visibleOf = (o) => { let n = o; while (n) { if (!n.visible) return false; n = n.parent } return true }
        let bossMeshes = 0, stage = false, townVisible = false, bossRoot = null
        t.scene.traverse((o) => {
          if (o.userData && o.userData.bossModelPath && visibleOf(o)) { bossMeshes++; bossRoot = bossRoot || o }
          if (o.name === 'BossForgePreviewStage') stage = o.visible
          if (typeof o.name === 'string' && o.name.startsWith('town_') && visibleOf(o)) townVisible = true
        })
        const cam = t.camera
        cam.updateMatrixWorld(true)
        // 全身が画面に収まるか: モデルのバウンディングボックス8頂点をNDCへ落とす
        let inView = null
        if (bossRoot) {
          const box = new (Object.getPrototypeOf(cam).constructor === Object ? Object : Object)
          bossRoot.updateWorldMatrix(true, true)
          let minX = 1e9, minY = 1e9, minZ = 1e9, maxX = -1e9, maxY = -1e9, maxZ = -1e9
          bossRoot.traverse((m) => {
            if (!m.isMesh && !m.isSkinnedMesh) return
            const g = m.geometry
            if (!g.boundingBox) g.computeBoundingBox()
            const bb = g.boundingBox
            for (const px of [bb.min.x, bb.max.x]) for (const py of [bb.min.y, bb.max.y]) for (const pz of [bb.min.z, bb.max.z]) {
              const v = new cam.position.constructor(px, py, pz).applyMatrix4(m.matrixWorld)
              minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x)
              minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y)
              minZ = Math.min(minZ, v.z); maxZ = Math.max(maxZ, v.z)
            }
          })
          let ok = true, worst = 0
          for (const px of [minX, maxX]) for (const py of [minY, maxY]) for (const pz of [minZ, maxZ]) {
            const v = new cam.position.constructor(px, py, pz).project(cam)
            worst = Math.max(worst, Math.abs(v.x), Math.abs(v.y))
            if (Math.abs(v.x) > 1 || Math.abs(v.y) > 1 || v.z > 1) ok = false
          }
          inView = { ok, worst: +worst.toFixed(2), height: +(maxY - minY).toFixed(2) }
        }
        return JSON.stringify({
          bossMeshes, stage, townVisible, inView,
          pointerLock: !!document.pointerLockElement,
          camDist: +s.camera.dist.toFixed(1), framed: f.framedFor,
        })
      })()`
      const forge = JSON.parse(await evalJs(probe))
      check('BOSS FORGE: 通常の町が表示されない', forge.townVisible === false)
      check('BOSS FORGE: Preview Stage が表示される', forge.stage === true)
      check('BOSS FORGE: 選択ボスが1体だけ表示される', forge.bossMeshes === 1, `${forge.bossMeshes}体`)
      check('BOSS FORGE: ボスの全身がカメラに収まる', forge.inView?.ok === true,
        `画面端まで ${forge.inView?.worst} / 高さ ${forge.inView?.height}m / 距離 ${forge.camDist}m`)
      check('BOSS FORGE: 自動フレーミングが実行される', /:model$/.test(forge.framed || ''), String(forge.framed))

      // カメラとボスの間に遮蔽物が無いこと（レイの最初のヒットがボス本体）
      const blocked = await evalJs(`(() => {
        const t = window.__three, s = window.__sim, f = s.bossForge
        const cam = t.camera
        const dir = new cam.position.constructor(f.view.x - cam.position.x, f.view.y - cam.position.y, f.view.z - cam.position.z)
        const dist = dir.length(); dir.normalize()
        const ray = new t.scene.constructor().constructor === Object ? null : null
        // Raycaster は three のグローバルが取れないので、代わりに
        // 「カメラとボスの間に入り得る不透明メッシュ」を距離で調べる
        const between = []
        t.scene.traverse((o) => {
          if (!o.isMesh || !o.visible) return
          // ボス本体（子メッシュ含む）と検証台は遮蔽ではない
          let n = o, isBoss = false, isStage = false
          while (n) {
            if (n.userData && n.userData.bossModelPath) isBoss = true
            if (n.name === 'BossForgePreviewStage') isStage = true
            n = n.parent
          }
          if (isBoss || isStage) return
          if (/grid|Grid|Helper/.test(o.name || o.type || '')) return
          o.updateWorldMatrix(true, false)
          const p = o.getWorldPosition(new cam.position.constructor())
          const to = p.clone().sub(cam.position)
          const along = to.dot(dir)
          // ボスと同じ奥行きにある物（足元の影など）は遮蔽ではない。
          // カメラとボスの「間」に入っている物だけを数える。
          if (along <= 0.5 || along >= dist - 1.0) return
          const perp = to.clone().sub(dir.clone().multiplyScalar(along)).length()
          if (perp < 2.0) between.push({ name: o.name || o.type, along: +along.toFixed(1), perp: +perp.toFixed(1) })
        })
        return JSON.stringify(between.slice(0, 5))
      })()`)
      check('BOSS FORGE: カメラ前方に遮蔽物が無い', blocked === '[]', blocked)

      // 4ボス切替 + 攻撃再生
      const perBoss = JSON.parse(await evalJs(`(async () => {
        const s = window.__sim, f = s.bossForge
        const out = []
        for (const id of ['student', 'stage', 'shrine', 'food']) {
          document.querySelector('[data-boss-id="' + id + '"]')?.click()
          for (let i = 0; i < 25; i++) {
            await new Promise((r) => setTimeout(r, 350))
            const b = s.bosses.find((x) => x.def.id === id)
            if (b?.alive && b.forgeBounds) break
          }
          const b = s.bosses.find((x) => x.def.id === id)
          let visible = 0
          const visibleOf = (o) => { let n = o; while (n) { if (!n.visible) return false; n = n.parent } return true }
          window.__three.scene.traverse((o) => { if (o.userData && o.userData.bossModelPath && visibleOf(o)) visible++ })
          f.timeScale = 1
          document.querySelector('[data-forge="play"]')?.click()
          // beginAttack は同期で走るので、押した直後に attack が立っていること
          const started = { id: b?.attack?.def?.id || null, phase: b?.attack?.phase || null, timer: b?.attack?.timer ?? null }
          // ヘッドレスは数fpsしか出ないので、時間ではなく描画フレームが進むのを待つ
          const frames0 = window.__frames || 0
          for (let w = 0; w < 40 && (window.__frames || 0) - frames0 < 3; w++) await new Promise((r) => setTimeout(r, 200))
          const after = b?.attack ? b.attack.timer : -1
          out.push({
            id, visible, attack: started.id, phase: started.phase,
            progressed: started.timer !== null && (after < started.timer || after === -1),
            pointerLock: !!document.pointerLockElement,
          })
        }
        return JSON.stringify(out)
      })()`))
      check('BOSS FORGE: 4ボス切替で常に1体だけ表示される', perBoss.every((x) => x.visible === 1),
        perBoss.map((x) => `${x.id}:${x.visible}`).join(' '))
      check('BOSS FORGE: 各ボスで指定攻撃が再生される', perBoss.every((x) => !!x.attack && x.phase === 'windup'),
        perBoss.map((x) => `${x.id}:${x.attack}/${x.phase}`).join(' '))
      check('BOSS FORGE: 攻撃の進行（timer）が進む', perBoss.every((x) => x.progressed),
        perBoss.map((x) => `${x.id}:${x.progressed}`).join(' '))
      check('BOSS FORGE: 編集操作でPointer Lockされない', perBoss.every((x) => !x.pointerLock))

      // 単体モーション
      const poses = JSON.parse(await evalJs(`(async () => {
        const s = window.__sim, f = s.bossForge
        const out = []
        for (const id of ['walk', 'hit', 'stagger', 'death', 'idle']) {
          document.querySelector('[data-pose-id="' + id + '"]')?.click()
          await new Promise((r) => setTimeout(r, 260))
          const b = s.bosses.find((x) => x.def.id === f.bossId)
          out.push({ id, pose: b?.forgePose?.id || null })
        }
        return JSON.stringify(out)
      })()`))
      check('BOSS FORGE: 単体モーションを再生できる', poses.every((p) => p.pose === p.id),
        poses.map((p) => `${p.id}:${p.pose}`).join(' '))

      // 実戦開始でだけ通常のゲーム世界へ戻る
      const combat = JSON.parse(await evalJs(`(async () => {
        [...document.querySelectorAll('.forge-controls button')].find((b) => b.textContent.includes('実戦開始'))?.click()
        await new Promise((r) => setTimeout(r, 2500))
        const s = window.__sim
        const visibleOf = (o) => { let n = o; while (n) { if (!n.visible) return false; n = n.parent } return true }
        let townVisible = false, stage = false
        window.__three.scene.traverse((o) => {
          if (typeof o.name === 'string' && o.name.startsWith('town_') && visibleOf(o)) townVisible = true
          if (o.name === 'BossForgePreviewStage') stage = o.visible
        })
        return JSON.stringify({ combat: !!s.bossForge?.combat, townVisible, stage })
      })()`))
      check('BOSS FORGE: 実戦開始で通常のゲーム世界へ戻る', combat.combat === true && combat.townVisible === true && combat.stage === false,
        JSON.stringify(combat))
      const shotForge = await send('Page.captureScreenshot', { format: 'png' }, sessionId)
      fs.writeFileSync('screenshot-boss-forge.png', Buffer.from(shotForge.data, 'base64'))
    }
  } catch (err) {
    check('BOSS FORGE: 検証を完走できる', false, String(err.message).slice(0, 160))
  }

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
    // ERR_ABORTED はページ遷移で打ち切られただけ（BOSS FORGE検証で ?bossForge=1 へ移動する）
    if (ev.method === 'Network.loadingFailed' && ev.params.errorText !== 'net::ERR_ABORTED') netFails.push(ev.params.errorText)
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
