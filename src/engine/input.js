/**
 * アクション単位の入力管理。
 *
 * 物理キーは KeyboardEvent.code で扱い、ゲーム側は「攻撃」「ガード」などの
 * アクションだけを見る。設定画面で割り当てを変えても HUD と説明画面はここを
 * 参照するため、表示と実操作がずれない。
 */
export const DEFAULT_BINDINGS = Object.freeze({
  moveForward: ['KeyW'], moveBackward: ['KeyS'], moveLeft: ['KeyA'], moveRight: ['KeyD'],
  sprint: ['ShiftLeft', 'ShiftRight'], dodge: ['Space'], interact: ['KeyE'],
  meleeAttack: ['KeyF'], guard: ['KeyV'], heal: ['KeyC'],
  webSwing: ['KeyQ'], useAbility: ['KeyR'],
  ability1: ['Digit1'], ability2: ['Digit2'], ability3: ['Digit3'], ability4: ['Digit4'],
  map: ['KeyM'], quest: ['KeyJ'], help: ['F1'], pause: ['Escape'],
})

// 通常の設定画面・本番ビルドには出さない開発専用アクション。
// setDebugInputEnabled(true) のときだけ KeyboardEvent から有効になる。
export const DEBUG_BINDINGS = Object.freeze({ debugPropShot: ['KeyP'] })

export const ACTION_META = [
  { id: 'moveForward', group: '基本操作', label: '前進' },
  { id: 'moveBackward', group: '基本操作', label: '後退' },
  { id: 'moveLeft', group: '基本操作', label: '左へ移動' },
  { id: 'moveRight', group: '基本操作', label: '右へ移動' },
  { id: 'sprint', group: '基本操作', label: 'ダッシュ' },
  { id: 'dodge', group: '基本操作', label: '回避ローリング' },
  { id: 'interact', group: '基本操作', label: '話す・調べる' },
  { id: 'meleeAttack', group: '戦闘', label: '近接攻撃' },
  { id: 'guard', group: '戦闘', label: '盾を構える' },
  { id: 'heal', group: '戦闘', label: '回復' },
  { id: 'webSwing', group: 'ウェブ', label: 'ウェブスイング' },
  { id: 'useAbility', group: '技', label: '選択中の技を使用' },
  { id: 'ability1', group: '技', label: '技スロット 1' },
  { id: 'ability2', group: '技', label: '技スロット 2' },
  { id: 'ability3', group: '技', label: '技スロット 3' },
  { id: 'ability4', group: '技', label: '技スロット 4' },
  { id: 'map', group: 'メニュー', label: 'マップ' },
  { id: 'quest', group: 'メニュー', label: 'クエスト' },
  { id: 'help', group: 'メニュー', label: '操作説明' },
  { id: 'pause', group: 'メニュー', label: 'ポーズ・閉じる' },
]

const CODE_LABEL = {
  KeyW: 'W', KeyA: 'A', KeyS: 'S', KeyD: 'D', KeyE: 'E', KeyF: 'F', KeyQ: 'Q', KeyR: 'R', KeyC: 'C', KeyV: 'V', KeyP: 'P',
  ShiftLeft: 'Shift', ShiftRight: 'Shift', Space: 'Space',
  Digit1: '1', Digit2: '2', Digit3: '3', Digit4: '4', KeyM: 'M', KeyJ: 'J', Escape: 'Esc', F1: 'F1',
}
const KEY_FALLBACK = {
  w: 'KeyW', a: 'KeyA', s: 'KeyS', d: 'KeyD', e: 'KeyE', f: 'KeyF', q: 'KeyQ', r: 'KeyR', c: 'KeyC', v: 'KeyV', p: 'KeyP',
  m: 'KeyM', j: 'KeyJ', '1': 'Digit1', '2': 'Digit2', '3': 'Digit3', '4': 'Digit4',
  shift: 'ShiftLeft', control: 'ControlLeft', ctrl: 'ControlLeft', ' ': 'Space', spacebar: 'Space',
  escape: 'Escape', esc: 'Escape', f1: 'F1',
}

const cloneDefaults = () => Object.fromEntries(Object.entries(DEFAULT_BINDINGS).map(([id, codes]) => [id, [...codes]]))
let bindings = cloneDefaults()
let inputContext = 'gameplay'
let debugInputEnabled = false

/** 現在押されているアクション / このフレームに押した・離したアクション */
export const keys = Object.create(null)
export const pressed = Object.create(null)
export const released = Object.create(null)
const virtual = Object.create(null)
const latched = Object.create(null)
export const mouse = { dx: 0, dy: 0, wheel: 0, dragging: false }

/** スマホの補助ボタン用。PCの必須操作には使わない。 */
export const touch = { move: { x: 0, y: 0 } }
let handlers = null

export const bindingCodes = (action) => [...(bindings[action] || DEFAULT_BINDINGS[action] || DEBUG_BINDINGS[action] || [])]
export const bindingLabels = (action) => bindingCodes(action).map((code) => CODE_LABEL[code] || code)
export const bindingLabel = (action, separator = ' / ') => bindingLabels(action).join(separator)
export const bindingsSnapshot = () => Object.fromEntries(Object.keys(DEFAULT_BINDINGS).map((id) => [id, bindingCodes(id)]))

export function setBindings(next = {}) {
  const merged = cloneDefaults()
  for (const id of Object.keys(DEFAULT_BINDINGS)) {
    if (Array.isArray(next[id]) && next[id].length) merged[id] = [...new Set(next[id].filter((code) => typeof code === 'string' && code.length))]
  }
  bindings = merged
  clearKeys()
  return bindingsSnapshot()
}

export function setBinding(action, codes) {
  if (!DEFAULT_BINDINGS[action] || !Array.isArray(codes) || !codes.length) return false
  bindings[action] = [...new Set(codes.filter((code) => typeof code === 'string' && code.length))]
  clearKeys()
  return true
}

/** 指定したキーと重なる別アクション。設定画面の警告表示に使う。 */
export function bindingConflicts(action, codes) {
  const next = new Set((codes || []).filter(Boolean))
  if (!next.size) return []
  return ACTION_META.filter(({ id }) => id !== action && bindingCodes(id).some((code) => next.has(code)))
}

export function resetBindings() {
  bindings = cloneDefaults()
  clearKeys()
  return bindingsSnapshot()
}

/** 本番・通常プレイでは P をゲーム入力として捕まえない。 */
export function setDebugInputEnabled(enabled = false) {
  debugInputEnabled = !!enabled && typeof import.meta.env !== 'undefined' && !!import.meta.env.DEV
  clearKeys()
  return debugInputEnabled
}
export const isDebugInputEnabled = () => debugInputEnabled

/**
 * 入力の受け取り先を明示する。実際の可否はゲーム側の pause / dialogue 状態でも
 * 制御するが、この値を持つことで、メニューや会話中に残った入力を安全に破棄できる。
 */
export const getInputContext = () => inputContext
export function setInputContext(next = 'gameplay') {
  if (!['gameplay', 'webSwing', 'menu', 'dialog', 'textInput', 'debug'].includes(next)) return inputContext
  if (inputContext !== next) clearKeys()
  inputContext = next
  return inputContext
}

// テストや外部デバッグ窓口が従来の keys.w のように直接立てた場合にも、
// アクション入力として読める互換層。ブラウザイベントからはアクション名だけを書き込む。
const LEGACY_HELD = { moveForward: 'w', moveBackward: 's', moveLeft: 'a', moveRight: 'd', sprint: 'shift', guard: 'v', webSwing: 'q' }
export const isHeld = (action) => !!keys[action] || !!keys[LEGACY_HELD[action]] || !!virtual[action]
export const wasPressed = (action) => !!pressed[action]
export const wasReleased = (action) => !!released[action]

/** 長押し / 押すたび切替の双方を同じアクションで提供する。 */
export function actionActive(action, toggle = false) {
  if (!toggle) return isHeld(action)
  if (wasPressed(action)) latched[action] = !latched[action]
  return !!latched[action]
}

export function setVirtualAction(action, value) {
  if (!DEFAULT_BINDINGS[action]) return
  const next = !!value
  if (next && !virtual[action] && !keys[action]) pressed[action] = true
  if (!next && virtual[action] && !keys[action]) released[action] = true
  virtual[action] = next
}

/** 入力欄やポーズ中からゲームへ戻るときにも残留入力を持ち越さない。 */
export function clearKeys() {
  for (const target of [keys, pressed, released, virtual, latched]) for (const key in target) delete target[key]
  touch.move.x = 0; touch.move.y = 0
  mouse.dragging = false
}
export const clearAll = clearKeys

/** 入力を消費してフレーム限定の状態をクリアする。 */
export function endFrame() {
  for (const target of [pressed, released]) for (const key in target) delete target[key]
  mouse.dx = 0; mouse.dy = 0; mouse.wheel = 0
}

const eventCode = (event) => event.code || KEY_FALLBACK[String(event.key || '').toLowerCase()] || ''
const actionsForCode = (code) => [
  ...Object.keys(bindings).filter((id) => bindings[id].includes(code)),
  ...(debugInputEnabled && DEBUG_BINDINGS.debugPropShot.includes(code) ? ['debugPropShot'] : []),
]
const editable = (target) => target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)

export function attachInput(target = window, canvasEl = null, options = {}) {
  if (handlers) return handlers.detach
  const el = canvasEl || target
  const onKeyDown = (event) => {
    if (editable(event.target)) { setInputContext('textInput'); clearKeys(); return }
    const actions = actionsForCode(eventCode(event))
    for (const action of actions) {
      if (!keys[action]) pressed[action] = true
      keys[action] = true
    }
    // ゲームに使うキーだけを抑止し、CommandなどmacOS標準ショートカットには触れない。
    if (actions.length && !event.metaKey && !event.altKey) event.preventDefault()
  }
  const onKeyUp = (event) => {
    for (const action of actionsForCode(eventCode(event))) {
      if (keys[action]) released[action] = true
      keys[action] = false
    }
  }
  const onBlur = () => clearKeys()
  const onVisibilityChange = () => { if (document.hidden) clearKeys() }
  const onPointerLockChange = () => { if (document.pointerLockElement !== el) clearKeys() }
  const onWheel = (event) => { mouse.wheel += Math.sign(event.deltaY); event.preventDefault() }
  const onPointerDown = (event) => {
    // クリックは攻撃に使わず、3Dカメラ用の Pointer Lock を開始するだけ。
    // BOSS FORGEの編集画面など、UIを操作するモードではカーソルを保持する。
    if (options.allowPointerLock && !options.allowPointerLock()) {
      // 編集中はパネル上のクリックではカメラも動かさず、中央3D表示だけは
      // カーソルを残したドラッグ操作で回せるようにする。
      mouse.dragging = !event.target?.closest?.('.boss-forge')
      return
    }
    if (el.requestPointerLock && document.pointerLockElement !== el) {
      try { const result = el.requestPointerLock(); result?.catch?.(() => {}) } catch { /* 未対応時は下のドラッグ操作 */ }
    }
    mouse.dragging = document.pointerLockElement !== el
  }
  const onPointerUp = () => { mouse.dragging = false }
  const onPointerMove = (event) => {
    if (document.pointerLockElement !== el && !mouse.dragging) return
    mouse.dx += event.movementX || 0
    mouse.dy += event.movementY || 0
  }
  const onContext = (event) => event.preventDefault()

  target.addEventListener('keydown', onKeyDown)
  target.addEventListener('keyup', onKeyUp)
  target.addEventListener('blur', onBlur)
  document.addEventListener('visibilitychange', onVisibilityChange)
  document.addEventListener('pointerlockchange', onPointerLockChange)
  el.addEventListener('wheel', onWheel, { passive: false })
  el.addEventListener('pointerdown', onPointerDown)
  target.addEventListener('pointerup', onPointerUp)
  target.addEventListener('pointermove', onPointerMove)
  el.addEventListener('contextmenu', onContext)

  const detach = () => {
    target.removeEventListener('keydown', onKeyDown); target.removeEventListener('keyup', onKeyUp); target.removeEventListener('blur', onBlur)
    document.removeEventListener('visibilitychange', onVisibilityChange); document.removeEventListener('pointerlockchange', onPointerLockChange)
    el.removeEventListener('wheel', onWheel); el.removeEventListener('pointerdown', onPointerDown); target.removeEventListener('pointerup', onPointerUp)
    target.removeEventListener('pointermove', onPointerMove); el.removeEventListener('contextmenu', onContext)
    clearKeys(); handlers = null
  }
  handlers = { detach }
  return detach
}

export function moveAxis() {
  const x = (isHeld('moveRight') ? 1 : 0) - (isHeld('moveLeft') ? 1 : 0) + touch.move.x
  const y = (isHeld('moveForward') ? 1 : 0) - (isHeld('moveBackward') ? 1 : 0) + touch.move.y
  return { x: Math.max(-1, Math.min(1, x)), y: Math.max(-1, Math.min(1, y)) }
}
export const getMoveAxis = moveAxis
