export function pushSample(entity, sample) {
  const samples = entity.samples || (entity.samples = [])
  if (samples.length && sample.sequence <= samples[samples.length - 1].sequence) return false
  samples.push(sample); while (samples.length > 5) samples.shift(); return true
}
export function interpolate(entity, renderTime) {
  const a = entity.samples || []; if (!a.length) return entity
  // performance.now() はタブごとに起点が異なる。ネット越しのhostTimeではなく、
  // この端末での受信時刻で補間しないと、別タブでは数分間初期位置に固定され得る。
  const stamp = (s) => s.receivedAt ?? s.hostTime
  const b = a.find((s) => stamp(s) >= renderTime) || a[a.length - 1]; const before = a[Math.max(0, a.indexOf(b) - 1)] || b
  const span = Math.max(1, stamp(b) - stamp(before)); const t = Math.max(0, Math.min(1, (renderTime - stamp(before)) / span))
  entity.x = before.position[0] + (b.position[0] - before.position[0]) * t; entity.y = before.position[1] + (b.position[1] - before.position[1]) * t; entity.z = before.position[2] + (b.position[2] - before.position[2]) * t; entity.yaw = before.rotation + (b.rotation - before.rotation) * t; entity.anim = b.animationState; return entity
}
