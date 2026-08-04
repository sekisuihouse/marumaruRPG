/**
 * 入力管理。キー配列は KEYMAP 1か所で定義し、
 * ヘルプ画面(アクセシビリティ)にも同じデータを表示する。
 * WASD/矢印キーの両方に対応し、マウスが無くても全操作できるようにしている。
 */

export const KEYMAP = [
  { id: 'move', keys: ['W', 'A', 'S', 'D'], alt: ['↑', '←', '↓', '→'], label: '移動（カメラの向きが前）' },
  { id: 'run', keys: ['Shift'], label: '走る（スタミナ消費）' },
  { id: 'dodge', keys: ['Space'], label: '回避ローリング（無敵時間あり）' },
  { id: 'block', keys: ['Control'], label: '盾を構える（押している間）' },
  { id: 'melee', keys: ['F'], alt: ['左クリック'], label: '近接攻撃（3段コンボ）' },
  { id: 'magic', keys: ['R'], label: '火球（MP12）' },
  { id: 'area', keys: ['L'], label: '範囲魔法（MP24）' },
  { id: 'arrow', keys: ['U'], label: '弓矢（スタミナ8）' },
  { id: 'heal', keys: ['E'], label: '回復（MP30）' },
  { id: 'firestream', keys: ['C'], label: '連続火球（押している間・熱量／Lv.8で解禁）' },
  { id: 'webswing', keys: ['Q'], alt: ['右クリック'], label: 'ウェブスイング：押している間は糸で振り子移動、離すと糸を張った場所まで一気に飛ぶ（W巻取り／S伸ばし／Lv.6で解禁）' },
  { id: 'interact', keys: ['G'], label: '話す・調べる' },
  { id: 'camLeft', keys: ['Z'], alt: ['マウス右ドラッグ'], label: 'カメラを左へ回す' },
  { id: 'camRight', keys: ['X'], label: 'カメラを右へ回す' },
  { id: 'zoom', keys: ['-', '+'], alt: ['ホイール'], label: 'カメラの距離' },
  { id: 'map', keys: ['M'], label: 'ミニマップの拡大' },
  { id: 'quest', keys: ['T'], label: 'クエストログ' },
  { id: 'help', keys: ['H', 'F1'], label: 'このキー説明を開閉' },
  { id: 'debug', keys: ['F9'], label: '開発用の当たり判定表示を切り替え' },
  { id: 'save', keys: ['F5'], label: '手動セーブ' },
  { id: 'pause', keys: ['Esc'], label: '会話・パネルを閉じる（パネル表示中はゲームが一時停止）' },
]

const CODE_ALIASES = {
  KeyW: 'w', ArrowUp: 'w',
  KeyS: 's', ArrowDown: 's',
  KeyA: 'a', ArrowLeft: 'a',
  KeyD: 'd', ArrowRight: 'd',
}

export const keys = Object.create(null)
/** 1フレームだけ立つ「押した瞬間」フラグ */
export const pressed = Object.create(null)
export const mouse = { dx: 0, dy: 0, wheel: 0, dragging: false, leftClick: false, right: false }

/**
 * タッチ操作（スマホ）用の仮想入力。HUDのボタンが直接立てる。
 * カメラ操作と同時に押せるよう、キーとは独立した状態として持つ。
 */
export const touch = { webswing: false, firestream: false, move: { x: 0, y: 0 } }

let handlers = null

const norm = (e) => CODE_ALIASES[e.code] || e.key.toLowerCase()

/** 入力を消費して pressed をクリアする(毎フレーム末に呼ぶ) */
export function endFrame() {
  for (const k in pressed) delete pressed[k]
  mouse.dx = 0
  mouse.dy = 0
  mouse.wheel = 0
  mouse.leftClick = false
}

export function clearKeys() {
  for (const k in keys) delete keys[k]
}

export function attachInput(target = window, canvasEl = null) {
  if (handlers) return handlers.detach
  const onKeyDown = (e) => {
    // 入力欄にフォーカスがあるときはゲーム操作を奪わない
    const t = e.target
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
    const k = norm(e)
    if (!keys[k]) pressed[k] = true
    keys[k] = true
    // ブラウザ既定動作を止めるキー(スクロール・検索など)
    if ([' ', 'w', 'a', 's', 'd', 'f1', 'f5', '/', "'"].includes(k)) e.preventDefault()
  }
  const onKeyUp = (e) => { keys[norm(e)] = false }
  const onBlur = () => clearKeys()
  const onWheel = (e) => { mouse.wheel += Math.sign(e.deltaY); e.preventDefault() }
  const onPointerDown = (e) => {
    // ポインターロック中はクリックを押し続けなくても視点を動かせる。
    if (el.requestPointerLock && document.pointerLockElement !== el) {
      try {
        const r = el.requestPointerLock()
        if (r && typeof r.catch === 'function') r.catch(() => {})
      } catch { /* ロックできない環境では視点はドラッグで操作する */ }
    }
    if (e.button === 0) mouse.leftClick = true
    if (e.button === 2) mouse.right = true
    if (e.button === 2 || e.button === 0) mouse.dragging = true
  }
  const onPointerUp = (e) => {
    mouse.dragging = false
    if (!e || e.button === 2) mouse.right = false
  }
  const onPointerMove = (e) => {
    if (document.pointerLockElement !== el && !mouse.dragging) return
    mouse.dx += e.movementX || 0
    mouse.dy += e.movementY || 0
  }
  const onContext = (e) => e.preventDefault()

  target.addEventListener('keydown', onKeyDown)
  target.addEventListener('keyup', onKeyUp)
  target.addEventListener('blur', onBlur)
  const el = canvasEl || target
  el.addEventListener('wheel', onWheel, { passive: false })
  el.addEventListener('pointerdown', onPointerDown)
  target.addEventListener('pointerup', onPointerUp)
  target.addEventListener('pointermove', onPointerMove)
  el.addEventListener('contextmenu', onContext)

  const detach = () => {
    target.removeEventListener('keydown', onKeyDown)
    target.removeEventListener('keyup', onKeyUp)
    target.removeEventListener('blur', onBlur)
    el.removeEventListener('wheel', onWheel)
    el.removeEventListener('pointerdown', onPointerDown)
    target.removeEventListener('pointerup', onPointerUp)
    target.removeEventListener('pointermove', onPointerMove)
    el.removeEventListener('contextmenu', onContext)
    handlers = null
  }
  handlers = { detach }
  return detach
}

/** WASD/矢印から生の入力ベクトル(スクリーン基準)を得る */
export function moveAxis() {
  const x = (keys.d ? 1 : 0) - (keys.a ? 1 : 0) + touch.move.x
  const y = (keys.w ? 1 : 0) - (keys.s ? 1 : 0) + touch.move.y
  return { x: Math.max(-1, Math.min(1, x)), y: Math.max(-1, Math.min(1, y)) }
}

/** 長押し系アクションが押されているか（キー・マウス・タッチを統合） */
export const holding = {
  webswing: () => !!keys.q || mouse.right || touch.webswing,
  firestream: () => !!keys.c || touch.firestream,
  forward: () => !!keys.w || touch.move.y > 0.3,
  back: () => !!keys.s || touch.move.y < -0.3,
}
