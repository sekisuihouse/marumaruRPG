(() => {
  'use strict'

  const ROOT_ID = 'marugoto-tensei-gate'
  const SPELL_HINT_ID = 'marugoto-home-spell-hint'
  const FIRE_INTERVAL = 150
  const FIRE_DURATION = 520
  const MAX_PROJECTILES = 8
  let gameOpen = false
  let castTimer = 0
  let lastCastAt = -Infinity
  let pointer = { x: innerWidth * 0.5, y: innerHeight * 0.55 }
  const projectiles = []
  let threeReady = false

  const isEditable = (node) => node && (node.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/i.test(node.tagName))
  const isUsableCanvas = (canvas) => {
    if (!(canvas instanceof HTMLCanvasElement)) return false
    const rect = canvas.getBoundingClientRect()
    return rect.width > 120 && rect.height > 100 && rect.bottom > 0 && rect.top < innerHeight
  }
  const canvases = () => [...document.querySelectorAll('canvas')].filter(isUsableCanvas)
  const primaryCanvas = () => {
    const intro = document.querySelector('#intro-section')
    return canvases().find((canvas) => intro?.contains(canvas)) || canvases()[0] || null
  }
  const targetAtPointer = () => {
    const direct = document.elementFromPoint(pointer.x, pointer.y)
    if (direct instanceof HTMLCanvasElement && isUsableCanvas(direct)) return direct
    return canvases().find((canvas) => {
      const r = canvas.getBoundingClientRect()
      return pointer.x >= r.left && pointer.x <= r.right && pointer.y >= r.top && pointer.y <= r.bottom
    }) || primaryCanvas()
  }

  const createHint = () => {
    if (document.getElementById(SPELL_HINT_ID)) return
    const hint = document.createElement('p')
    hint.id = SPELL_HINT_ID
    hint.innerHTML = '<kbd>C</kbd><span>火球連射　カーソルで3D照準</span>'
    document.documentElement.append(hint)
  }

  const shoot = () => {
    if (gameOpen || document.getElementById(ROOT_ID)) return
    const now = performance.now()
    if (now - lastCastAt < FIRE_INTERVAL || projectiles.length >= MAX_PROJECTILES) return
    const target = targetAtPointer()
    if (!target) return
    lastCastAt = now
    createHint()
    const rect = target.getBoundingClientRect()
    const end = { x: Math.max(rect.left + 8, Math.min(rect.right - 8, pointer.x)), y: Math.max(rect.top + 8, Math.min(rect.bottom - 8, pointer.y)) }
    projectiles.push({ start: { x: innerWidth * 0.5, y: innerHeight * 0.78 }, end, began: now, duration: FIRE_DURATION })
    // Main world のR3Fシーンへ送る。座標は画面座標のまま渡し、向こうで各Canvasのカメラからレイを作る。
    window.postMessage({ source: 'marugoto-tensei-extension', type: 'fire3d', x: end.x, y: end.y, at: now }, location.origin)
  }

  const effects = document.createElement('canvas')
  effects.id = 'marugoto-home-fire-overlay'
  const fx = effects.getContext('2d')
  const resizeEffects = () => {
    const dpr = Math.min(devicePixelRatio || 1, 2)
    effects.width = Math.round(innerWidth * dpr); effects.height = Math.round(innerHeight * dpr)
    effects.style.width = `${innerWidth}px`; effects.style.height = `${innerHeight}px`
  }
  resizeEffects()
  document.documentElement.append(effects)
  const render = (now) => {
    const dpr = Math.min(devicePixelRatio || 1, 2)
    fx.setTransform(dpr, 0, 0, dpr, 0, 0)
    fx.clearRect(0, 0, innerWidth, innerHeight)
    for (let i = projectiles.length - 1; i >= 0; i--) {
      const shot = projectiles[i], p = Math.min(1, (now - shot.began) / shot.duration)
      const eased = 1 - (1 - p) * (1 - p)
      const x = shot.start.x + (shot.end.x - shot.start.x) * eased
      const y = shot.start.y + (shot.end.y - shot.start.y) * eased
      // 視覚用の火球は手前で大きく、実際の命中・破壊はpage-bridge.js内のThree.js空間で処理する。
      const radius = Math.max(12, Math.hypot(innerWidth, innerHeight) * (0.72 * (1 - eased) + 0.012))
      const glow = fx.createRadialGradient(x, y, radius * 0.06, x, y, radius)
      glow.addColorStop(0, '#fffbd1'); glow.addColorStop(0.12, '#fff08a'); glow.addColorStop(0.32, '#ff9b25'); glow.addColorStop(0.62, 'rgba(243,66,20,.58)'); glow.addColorStop(1, 'rgba(243,66,20,0)')
      fx.fillStyle = glow; fx.beginPath(); fx.arc(x, y, radius, 0, Math.PI * 2); fx.fill()
      if (p >= 1) projectiles.splice(i, 1)
    }
    requestAnimationFrame(render)
  }
  requestAnimationFrame(render)

  function createGate() {
    if (document.getElementById(ROOT_ID)) return
    const root = document.createElement('div')
    root.id = ROOT_ID
    root.innerHTML = `
      <section class="mtg-dialog" role="dialog" aria-modal="true" aria-labelledby="mtg-question">
        <p class="mtg-kicker">MARUGOTO FUTURE QUEST</p>
        <h1 id="mtg-question">転生しますか？</h1>
        <div class="mtg-actions"><button type="button" class="mtg-yes">はい</button><button type="button" class="mtg-no">いいえ</button></div>
      </section>`
    document.documentElement.append(root)
    root.querySelector('.mtg-yes').addEventListener('click', beginTensei)
    root.querySelector('.mtg-no').addEventListener('click', () => root.remove())
  }
  function beginTensei() {
    const root = document.getElementById(ROOT_ID)
    if (!root || gameOpen) return
    gameOpen = true; root.classList.add('mtg-reborn'); root.innerHTML = '<p class="mtg-welcome">ようこそ<br>小さな社会へ</p>'
    window.setTimeout(openGame, 1650)
  }
  function openGame() {
    const root = document.getElementById(ROOT_ID)
    if (!root) return
    const gameUrl = chrome.runtime.getURL('game/index.html?autostart=1')
    root.className = 'mtg-game'
    root.innerHTML = `<iframe class="mtg-frame" title="まるごと祭：未来の町" src="${gameUrl}" allow="fullscreen; autoplay"></iframe><button class="mtg-exit" type="button" aria-label="ゲームを終了してまるごと祭ページへ戻る">×</button>`
    root.querySelector('.mtg-exit').addEventListener('click', closeGame)
  }
  function closeGame() { document.getElementById(ROOT_ID)?.remove(); gameOpen = false }
  function showPauseMenu() {
    const root = document.getElementById(ROOT_ID)
    if (!root || root.querySelector('.mtg-pause')) return
    const menu = document.createElement('section')
    menu.className = 'mtg-pause'; menu.setAttribute('role', 'dialog'); menu.setAttribute('aria-modal', 'true')
    menu.innerHTML = '<div class="mtg-pause-box"><p>未来の町を旅の途中です</p><button type="button" class="mtg-resume">継続</button><button type="button" class="mtg-return">まるごと祭ページに戻る</button></div>'
    root.append(menu); menu.querySelector('.mtg-resume').addEventListener('click', () => menu.remove()); menu.querySelector('.mtg-return').addEventListener('click', closeGame)
  }
  function bindDisc(canvas) {
    if (!canvas || canvas.dataset.mtgBound) return
    canvas.dataset.mtgBound = 'true'
    canvas.addEventListener('click', (event) => {
      if (gameOpen || document.getElementById(ROOT_ID) || castTimer) return
      event.preventDefault(); event.stopPropagation(); createGate()
    }, true)
  }
  const findDisc = () => bindDisc(primaryCanvas())
  findDisc(); new MutationObserver(findDisc).observe(document.documentElement, { childList: true, subtree: true })

  window.addEventListener('message', (event) => {
    if (event.source !== window) return
    if (event.data?.source === 'marugoto-tensei-bridge' && event.data.type === 'ready') threeReady = true
    if (event.data?.type === 'marugoto-future-quest-escape' && gameOpen) showPauseMenu()
  })
  window.addEventListener('pointermove', (event) => { pointer.x = event.clientX; pointer.y = event.clientY }, true)
  window.addEventListener('keydown', (event) => {
    if (event.key.toLowerCase() !== 'c' || gameOpen || isEditable(event.target)) return
    event.preventDefault(); event.stopPropagation()
    if (!castTimer) { shoot(); castTimer = window.setInterval(shoot, FIRE_INTERVAL) }
  }, true)
  window.addEventListener('keyup', (event) => { if (event.key.toLowerCase() === 'c' && castTimer) { clearInterval(castTimer); castTimer = 0 } }, true)
  window.addEventListener('blur', () => { if (castTimer) { clearInterval(castTimer); castTimer = 0 } })
  window.addEventListener('resize', resizeEffects)
  window.addEventListener('keydown', (event) => { if (event.key === 'Escape' && gameOpen) { event.preventDefault(); event.stopPropagation(); showPauseMenu() } }, true)
  // bridge未捕捉中でもUIは使える。3D生成はサイトのR3F Canvasを検出してからだけ行い、2D破壊への偽装フォールバックはしない。
  window.setTimeout(() => { if (!threeReady) console.info('[まるごと祭] 3D火球シーンを待機中です') }, 5000)
})()
