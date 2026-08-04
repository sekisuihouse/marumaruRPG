(() => {
  'use strict'

  const ROOT_ID = 'marugoto-tensei-gate'
  const SPELL_HINT_ID = 'marugoto-home-spell-hint'
  const FIRE_INTERVAL = 150
  const FIRE_DURATION = 520
  const MAX_PROJECTILES = 8
  const MAX_WOUNDS = 18
  const MAX_DEBRIS = 72
  let gameOpen = false
  let castTimer = 0
  let lastCastAt = -Infinity
  let pointer = { x: innerWidth * 0.5, y: innerHeight * 0.55 }
  const projectiles = []
  const proxies = new Map()

  const isEditable = (node) => node && (node.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/i.test(node.tagName))
  const isUsableCanvas = (canvas) => {
    if (!(canvas instanceof HTMLCanvasElement) || canvas.classList.contains('mtg-home-fx')) return false
    const rect = canvas.getBoundingClientRect()
    return rect.width > 120 && rect.height > 100 && rect.bottom > 0 && rect.top < innerHeight
  }
  const canvases = () => [...document.querySelectorAll('canvas')].filter(isUsableCanvas)
  const primaryCanvas = () => {
    const intro = document.querySelector('#intro-section')
    const inIntro = canvases().find((canvas) => intro?.contains(canvas))
    return inIntro || canvases()[0] || null
  }
  const targetAtPointer = () => {
    const direct = document.elementFromPoint(pointer.x, pointer.y)
    if (direct instanceof HTMLCanvasElement && isUsableCanvas(direct)) return direct
    return canvases().find((canvas) => {
      const r = canvas.getBoundingClientRect()
      return pointer.x >= r.left && pointer.x <= r.right && pointer.y >= r.top && pointer.y <= r.bottom
    }) || primaryCanvas()
  }

  class CanvasProxy {
    constructor(source) {
      this.source = source
      this.overlay = document.createElement('canvas')
      this.overlay.className = 'mtg-home-fx'
      this.ctx = this.overlay.getContext('2d')
      this.wounds = []
      this.debris = []
      this.dpr = 1
      this.width = 0
      this.height = 0
      this.rect = null
      this.disabled = false
      this.previousOpacity = source.style.getPropertyValue('opacity')
      this.previousPriority = source.style.getPropertyPriority('opacity')
      document.documentElement.append(this.overlay)
      // 元Canvasは更新を続け、同じフレームをこのレイヤーへ複写する。
      // サイズやモデルのスケール、サイト側のアニメーション設定は変更しない。
      source.style.setProperty('opacity', '0', 'important')
      this.sync()
    }
    dispose() {
      this.overlay.remove()
      if (this.previousOpacity) this.source.style.setProperty('opacity', this.previousOpacity, this.previousPriority)
      else this.source.style.removeProperty('opacity')
    }
    sync() {
      const r = this.source.getBoundingClientRect()
      this.rect = r
      this.overlay.style.left = `${r.left}px`
      this.overlay.style.top = `${r.top}px`
      this.overlay.style.width = `${r.width}px`
      this.overlay.style.height = `${r.height}px`
      const dpr = Math.min(devicePixelRatio || 1, 2)
      const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr))
      if (w !== this.overlay.width || h !== this.overlay.height) { this.overlay.width = w; this.overlay.height = h }
      this.width = r.width; this.height = r.height; this.dpr = dpr
    }
    impact(clientX, clientY, dx, dy) {
      this.sync()
      const x = Math.max(0, Math.min(this.width, clientX - this.rect.left))
      const y = Math.max(0, Math.min(this.height, clientY - this.rect.top))
      const hitDebris = this.debris.filter((d) => Math.hypot(d.x - x, d.y - y) < d.size * 1.8)
      if (hitDebris.length) {
        for (const d of hitDebris) { d.vx += dx * 1250; d.vy += dy * 1250 - 220; d.spin += (Math.random() - 0.5) * 20; d.life = Math.max(d.life, 1.25) }
        return
      }
      const radius = Math.max(18, Math.min(45, Math.min(this.width, this.height) * 0.055))
      this.wounds.push({ x, y, radius })
      while (this.wounds.length > MAX_WOUNDS) this.wounds.shift()
      // 一発で全面を消さず、命中周辺だけを6個前後の破片へ分ける。
      for (let i = 0; i < 6 && this.debris.length < MAX_DEBRIS; i++) {
        const angle = Math.atan2(dy, dx) + (Math.random() - 0.5) * 1.8
        const size = radius * (0.45 + Math.random() * 0.55)
        const px = Math.max(0, Math.min(this.width - size, x + (Math.random() - 0.5) * radius * 1.3 - size * 0.5))
        const py = Math.max(0, Math.min(this.height - size, y + (Math.random() - 0.5) * radius * 1.3 - size * 0.5))
        const speed = 140 + Math.random() * 170
        this.debris.push({ x: px + size * 0.5, y: py + size * 0.5, u: px, v: py, size, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 90, rotation: 0, spin: (Math.random() - 0.5) * 9, life: 1.8 + Math.random() * 0.9 })
      }
    }
    update(dt) {
      if (!this.source.isConnected) { this.dispose(); proxies.delete(this.source); return }
      const visible = this.rect && this.rect.bottom > -80 && this.rect.top < innerHeight + 80
      if (!visible || this.disabled) return
      this.sync()
      for (const d of this.debris) { d.vy += 560 * dt; d.x += d.vx * dt; d.y += d.vy * dt; d.rotation += d.spin * dt; d.life -= dt }
      this.debris = this.debris.filter((d) => d.life > 0 && d.x > -d.size * 3 && d.y > -d.size * 3 && d.x < this.width + d.size * 3 && d.y < this.height + d.size * 3)
      const ctx = this.ctx
      try {
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
        ctx.clearRect(0, 0, this.width, this.height)
        ctx.globalCompositeOperation = 'source-over'
        ctx.globalAlpha = 1
        ctx.drawImage(this.source, 0, 0, this.width, this.height)
        // 欠損は元Canvasを隠した同期レイヤー上にだけ開ける。サイトのレイアウト・モデルサイズは維持する。
        ctx.globalCompositeOperation = 'destination-out'
        for (const wound of this.wounds) {
          const g = ctx.createRadialGradient(wound.x, wound.y, wound.radius * 0.3, wound.x, wound.y, wound.radius)
          g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(0.72, 'rgba(0,0,0,.94)'); g.addColorStop(1, 'rgba(0,0,0,0)')
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(wound.x, wound.y, wound.radius, 0, Math.PI * 2); ctx.fill()
        }
        ctx.globalCompositeOperation = 'source-over'
        for (const d of this.debris) {
          const alpha = Math.min(1, d.life * 1.7)
          ctx.save(); ctx.globalAlpha = alpha; ctx.translate(d.x, d.y); ctx.rotate(d.rotation)
          ctx.drawImage(this.source, d.u * this.dpr, d.v * this.dpr, d.size * this.dpr, d.size * this.dpr, -d.size * 0.5, -d.size * 0.5, d.size, d.size)
          ctx.restore()
        }
      } catch (_) {
        // サイト側Canvasの実装が複写を拒否したときは、サイトを隠したままにしない。
        this.disabled = true
        this.dispose()
        proxies.delete(this.source)
      }
    }
  }

  const proxyFor = (canvas) => {
    let proxy = proxies.get(canvas)
    if (!proxy) { proxy = new CanvasProxy(canvas); proxies.set(canvas, proxy) }
    return proxy
  }
  const createHint = () => {
    if (document.getElementById(SPELL_HINT_ID)) return
    const hint = document.createElement('p')
    hint.id = SPELL_HINT_ID
    hint.innerHTML = '<kbd>C</kbd><span>火球連射　カーソルで狙う</span>'
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
    const end = {
      x: Math.max(rect.left + 8, Math.min(rect.right - 8, pointer.x)),
      y: Math.max(rect.top + 8, Math.min(rect.bottom - 8, pointer.y)),
    }
    const start = { x: innerWidth * 0.5, y: innerHeight * 0.78 }
    projectiles.push({ target, start, end, began: now, duration: FIRE_DURATION })
  }
  const impact = (shot) => {
    const dx = shot.end.x - shot.start.x, dy = shot.end.y - shot.start.y
    const length = Math.hypot(dx, dy) || 1
    proxyFor(shot.target).impact(shot.end.x, shot.end.y, dx / length, dy / length)
  }
  const effects = document.createElement('canvas')
  effects.id = 'marugoto-home-fire-overlay'
  effects.width = Math.max(1, innerWidth * Math.min(devicePixelRatio || 1, 2))
  effects.height = Math.max(1, innerHeight * Math.min(devicePixelRatio || 1, 2))
  const fx = effects.getContext('2d')
  const resizeEffects = () => {
    const dpr = Math.min(devicePixelRatio || 1, 2)
    effects.width = Math.round(innerWidth * dpr); effects.height = Math.round(innerHeight * dpr)
    effects.style.width = `${innerWidth}px`; effects.style.height = `${innerHeight}px`
  }
  document.documentElement.append(effects)
  let previous = performance.now()
  const render = (now) => {
    const dt = Math.min(0.05, (now - previous) / 1000); previous = now
    fx.setTransform(Math.min(devicePixelRatio || 1, 2), 0, 0, Math.min(devicePixelRatio || 1, 2), 0, 0)
    fx.clearRect(0, 0, innerWidth, innerHeight)
    for (let i = projectiles.length - 1; i >= 0; i--) {
      const shot = projectiles[i], p = Math.min(1, (now - shot.began) / shot.duration)
      const eased = 1 - (1 - p) * (1 - p)
      const x = shot.start.x + (shot.end.x - shot.start.x) * eased
      const y = shot.start.y + (shot.end.y - shot.start.y) * eased
      // 手前では画面を覆うほど大きく、奥へ進むほど小さくする遠近表現。
      const radius = Math.max(12, Math.hypot(innerWidth, innerHeight) * (0.72 * (1 - eased) + 0.012))
      const glow = fx.createRadialGradient(x, y, radius * 0.06, x, y, radius)
      glow.addColorStop(0, '#fffbd1'); glow.addColorStop(0.12, '#fff08a'); glow.addColorStop(0.32, '#ff9b25'); glow.addColorStop(0.62, 'rgba(243,66,20,.58)'); glow.addColorStop(1, 'rgba(243,66,20,0)')
      fx.fillStyle = glow; fx.beginPath(); fx.arc(x, y, radius, 0, Math.PI * 2); fx.fill()
      if (p >= 1) { impact(shot); projectiles.splice(i, 1) }
    }
    for (const proxy of [...proxies.values()]) proxy.update(dt)
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
        <div class="mtg-actions">
          <button type="button" class="mtg-yes">はい</button>
          <button type="button" class="mtg-no">いいえ</button>
        </div>
      </section>`
    document.documentElement.append(root)
    root.querySelector('.mtg-yes').addEventListener('click', beginTensei)
    root.querySelector('.mtg-no').addEventListener('click', () => root.remove())
  }

  function beginTensei() {
    const root = document.getElementById(ROOT_ID)
    if (!root || gameOpen) return
    gameOpen = true
    root.classList.add('mtg-reborn')
    root.innerHTML = '<p class="mtg-welcome">ようこそ<br>小さな社会へ</p>'
    window.setTimeout(openGame, 1650)
  }

  function openGame() {
    const root = document.getElementById(ROOT_ID)
    if (!root) return
    // game/ と assets/ は npm run build:extension で毎回、現在のゲームビルドから同期される。
    const gameUrl = chrome.runtime.getURL('game/index.html?autostart=1')
    root.className = 'mtg-game'
    root.innerHTML = `
      <iframe class="mtg-frame" title="まるごと祭：未来の町" src="${gameUrl}" allow="fullscreen; autoplay"></iframe>
      <button class="mtg-exit" type="button" aria-label="ゲームを終了してまるごと祭ページへ戻る">×</button>`
    root.querySelector('.mtg-exit').addEventListener('click', closeGame)
  }

  function closeGame() {
    document.getElementById(ROOT_ID)?.remove()
    gameOpen = false
  }

  function showPauseMenu() {
    const root = document.getElementById(ROOT_ID)
    if (!root || root.querySelector('.mtg-pause')) return
    const menu = document.createElement('section')
    menu.className = 'mtg-pause'
    menu.setAttribute('role', 'dialog')
    menu.setAttribute('aria-modal', 'true')
    menu.innerHTML = `<div class="mtg-pause-box"><p>未来の町を旅の途中です</p><button type="button" class="mtg-resume">継続</button><button type="button" class="mtg-return">まるごと祭ページに戻る</button></div>`
    root.append(menu)
    menu.querySelector('.mtg-resume').addEventListener('click', () => menu.remove())
    menu.querySelector('.mtg-return').addEventListener('click', closeGame)
  }

  function bindDisc(canvas) {
    if (!canvas || canvas.dataset.mtgBound) return
    canvas.dataset.mtgBound = 'true'
    canvas.addEventListener('click', (event) => {
      if (gameOpen || document.getElementById(ROOT_ID) || castTimer) return
      event.preventDefault()
      event.stopPropagation()
      createGate()
    }, true)
  }

  const findDisc = () => bindDisc(primaryCanvas())
  findDisc()
  new MutationObserver(findDisc).observe(document.documentElement, { childList: true, subtree: true })

  window.addEventListener('pointermove', (event) => { pointer.x = event.clientX; pointer.y = event.clientY }, true)
  window.addEventListener('keydown', (event) => {
    if (event.key.toLowerCase() !== 'c' || gameOpen || isEditable(event.target)) return
    event.preventDefault(); event.stopPropagation()
    if (!castTimer) { shoot(); castTimer = window.setInterval(shoot, FIRE_INTERVAL) }
  }, true)
  window.addEventListener('keyup', (event) => {
    if (event.key.toLowerCase() !== 'c') return
    if (castTimer) { clearInterval(castTimer); castTimer = 0 }
  }, true)
  window.addEventListener('blur', () => { if (castTimer) { clearInterval(castTimer); castTimer = 0 } })
  window.addEventListener('resize', resizeEffects)

  // ゲーム内のEscはiframeから通知される。
  window.addEventListener('message', (event) => {
    if (event.data?.type === 'marugoto-future-quest-escape' && gameOpen) showPauseMenu()
  })
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !gameOpen) return
    event.preventDefault(); event.stopPropagation(); showPauseMenu()
  }, true)
})()
