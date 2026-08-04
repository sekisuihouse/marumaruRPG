/* Main world only: the festival page owns Three.js and R3F, so this bridge never bundles a second renderer. */
(() => {
  'use strict'
  if (window.__marugotoTenseiThreeBridge) return
  window.__marugotoTenseiThreeBridge = true

  const roots = new Map()
  const debris = []
  const shots = []
  const MAX_DEBRIS = 96
  const MAX_SHOTS = 8
  const BREAK_HITS = 4
  const GRAVITY = -18
  const nativeMapSet = Map.prototype.set
  const announce = () => window.postMessage({ source: 'marugoto-tensei-bridge', type: 'ready', roots: roots.size }, location.origin)

  const captureRoot = (canvas, value) => {
    try {
      // createRoot() がMapへ入れる時点では、configure() 前でscene/cameraはまだ未完成。
      // Storeそのものを先に保持し、発射時に完成済みstateを読む。
      if (!(canvas instanceof HTMLCanvasElement) || typeof value?.store?.getState !== 'function') return
      roots.set(canvas, value.store)
      announce()
    } catch (_) { /* The page must continue even if an unrelated Map value resembles an R3F root. */ }
  }
  // R3F keeps its root store in a module-private Map. Intercept only Map#set during page boot,
  // capture Canvas root stores, then restore the platform method. No page mesh/camera size is changed.
  const patchedMapSet = function bridgeMapSet(key, value) {
    captureRoot(key, value)
    return nativeMapSet.call(this, key, value)
  }
  Map.prototype.set = patchedMapSet
  window.setTimeout(() => { if (Map.prototype.set === patchedMapSet) Map.prototype.set = nativeMapSet }, 90000)

  const rootAt = (x, y) => {
    let selected = null
    for (const [canvas, store] of roots) {
      if (!canvas.isConnected) { roots.delete(canvas); continue }
      const rect = canvas.getBoundingClientRect()
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) selected = { canvas, store, rect }
    }
    return selected
  }
  const materialCopies = (material) => {
    const copy = (item) => {
      const result = item?.clone?.() || item
      if (result?.color) result.color.setRGB(1, 0.16, 0.015)
      if (result?.emissive) { result.emissive.setRGB(1, 0.045, 0); result.emissiveIntensity = 2.5 }
      if (result) { result.transparent = true; result.opacity = 0.96; result.depthWrite = false }
      return result
    }
    return Array.isArray(material) ? material.map(copy) : copy(material)
  }
  const isTarget = (object) => object?.isMesh && object.visible && !object.userData?.mtgDebris && !object.userData?.mtgProjectile && object.geometry?.getAttribute?.('position')
  const rootObject = (object) => {
    let node = object
    while (node.parent && !node.parent.isScene) node = node.parent
    return node
  }
  const nearestTriangles = (object, point, count, Vector3) => {
    const geometry = object.geometry
    const position = geometry.getAttribute('position')
    const index = geometry.index
    if (!position) return geometry.clone()
    const local = object.worldToLocal(point.clone())
    const candidates = []
    const sample = (a, b, c, offset) => {
      const x = (position.getX(a) + position.getX(b) + position.getX(c)) / 3
      const y = (position.getY(a) + position.getY(b) + position.getY(c)) / 3
      const z = (position.getZ(a) + position.getZ(b) + position.getZ(c)) / 3
      candidates.push({ offset, distance: (x - local.x) ** 2 + (y - local.y) ** 2 + (z - local.z) ** 2 })
    }
    if (index) {
      for (let i = 0; i + 2 < index.count; i += 3) sample(index.getX(i), index.getX(i + 1), index.getX(i + 2), i)
      candidates.sort((a, b) => a.distance - b.distance)
      const chosen = candidates.slice(0, Math.max(1, count))
      const indices = []
      for (const item of chosen) indices.push(index.getX(item.offset), index.getX(item.offset + 1), index.getX(item.offset + 2))
      const result = geometry.clone()
      const ArrayType = index.array.constructor
      result.setIndex(new index.constructor(new ArrayType(indices), 1))
      return result
    }
    let best = 0, bestDistance = Infinity
    for (let i = 0; i + 2 < position.count; i += 3) {
      const a = new Vector3(position.getX(i), position.getY(i), position.getZ(i))
      const b = new Vector3(position.getX(i + 1), position.getY(i + 1), position.getZ(i + 1))
      const c = new Vector3(position.getX(i + 2), position.getY(i + 2), position.getZ(i + 2))
      const d = a.add(b).add(c).multiplyScalar(1 / 3).distanceToSquared(local)
      if (d < bestDistance) { bestDistance = d; best = i }
    }
    const result = geometry.clone(); result.setDrawRange(best, 3); return result
  }
  const worldTransform = (object, target) => object.matrixWorld.decompose(target.position, target.quaternion, target.scale)
  const makeFragment = (source, hitPoint, state, triangleCount) => {
    const Mesh = source.constructor
    const Vector3 = state.camera.position.constructor
    let fragment
    try {
      fragment = new Mesh(nearestTriangles(source, hitPoint, triangleCount, Vector3), materialCopies(source.material))
      worldTransform(source, fragment)
      fragment.userData = { mtgDebris: true, velocity: new Vector3(), life: 5.5 }
      state.scene.add(fragment)
      return fragment
    } catch (_) { return null }
  }
  const burst = (source, point, direction, state, strong = false) => {
    const Vector3 = state.camera.position.constructor
    const amount = strong ? 9 : 5
    for (let i = 0; i < amount && debris.length < MAX_DEBRIS; i++) {
      const piece = makeFragment(source, point, state, 1 + (i % 3))
      if (!piece) continue
      const spread = new Vector3((Math.random() - 0.5) * 0.7, Math.random() * 0.45 + 0.1, (Math.random() - 0.5) * 0.7).normalize()
      piece.position.addScaledVector(spread, 0.025 + Math.random() * 0.06)
      piece.userData.velocity.copy(direction).multiplyScalar((strong ? 13 : 7) + Math.random() * (strong ? 9 : 5)).addScaledVector(spread, 5 + Math.random() * 5)
      piece.userData.spin = new Vector3((Math.random() - 0.5) * 11, (Math.random() - 0.5) * 11, (Math.random() - 0.5) * 11)
      debris.push(piece)
    }
    state.invalidate?.()
  }
  const weakenPart = (source) => {
    const data = source.userData || (source.userData = {})
    data.mtgDamage = (data.mtgDamage || 0) + 1
    if (data.mtgDamage < BREAK_HITS) return
    // GLBで分かれているMesh単位で初めて外す。一発で建物全体を消さず、次のレイは奥の部品へ届く。
    source.visible = false
    rootObject(source).userData.mtgDamaged = true
  }
  const applyImpact = (shot) => {
    const { hit, direction, state } = shot
    const object = hit.object
    if (object.userData?.mtgDebris) {
      object.userData.velocity.addScaledVector(direction, 23)
      object.userData.velocity.y += 4
      object.userData.life = Math.max(object.userData.life, 3.5)
      state.invalidate?.()
      return
    }
    burst(object, hit.point, direction, state, (object.userData?.mtgDamage || 0) >= BREAK_HITS - 1)
    weakenPart(object)
  }
  const fire = (x, y) => {
    const entry = rootAt(x, y)
    if (!entry || shots.length >= MAX_SHOTS) return
    const state = entry.store.getState()
    const nx = ((x - entry.rect.left) / entry.rect.width) * 2 - 1
    const ny = -((y - entry.rect.top) / entry.rect.height) * 2 + 1
    const raycaster = state.raycaster
    raycaster.setFromCamera({ x: nx, y: ny }, state.camera)
    const hits = raycaster.intersectObjects(state.scene.children, true)
    const hit = hits.find((candidate) => isTarget(candidate.object))
    if (!hit) return
    const Vector3 = state.camera.position.constructor
    const direction = raycaster.ray.direction.clone().normalize()
    const visual = makeFragment(hit.object, hit.point, state, 2)
    if (visual) {
      const start = raycaster.ray.origin.clone().addScaledVector(direction, 0.45)
      visual.position.copy(start)
      visual.scale.multiplyScalar(0.18)
      visual.userData.mtgProjectile = true
      visual.userData.mtgDebris = false
    }
    shots.push({ hit, direction: direction.clone(), state, visual, started: performance.now(), duration: 430, Vector3 })
    state.invalidate?.()
  }
  const tick = (now) => {
    const dt = Math.min(0.05, Math.max(0.001, (now - (tick.previous || now)) / 1000)); tick.previous = now
    for (let i = shots.length - 1; i >= 0; i--) {
      const shot = shots[i], p = Math.min(1, (now - shot.started) / shot.duration)
      if (shot.visual) {
        const start = shot.state.camera.getWorldPosition(new shot.Vector3()).addScaledVector(shot.direction, 0.45)
        shot.visual.position.lerpVectors(start, shot.hit.point, 1 - (1 - p) * (1 - p))
        shot.visual.scale.setScalar(Math.max(0.03, 0.22 * (1 - p) + 0.035))
      }
      if (p >= 1) { if (shot.visual) shot.state.scene.remove(shot.visual); applyImpact(shot); shots.splice(i, 1) }
    }
    for (let i = debris.length - 1; i >= 0; i--) {
      const piece = debris[i], velocity = piece.userData.velocity
      if (!piece.parent || !velocity) { debris.splice(i, 1); continue }
      velocity.y += GRAVITY * dt
      piece.position.addScaledVector(velocity, dt)
      piece.rotation.x += piece.userData.spin.x * dt; piece.rotation.y += piece.userData.spin.y * dt; piece.rotation.z += piece.userData.spin.z * dt
      piece.userData.life -= dt
      if (piece.userData.life <= 0) { piece.parent.remove(piece); debris.splice(i, 1) }
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  window.addEventListener('message', (event) => {
    const data = event.data
    if (event.source !== window || data?.source !== 'marugoto-tensei-extension' || data.type !== 'fire3d') return
    fire(Number(data.x), Number(data.y))
  })
})()
