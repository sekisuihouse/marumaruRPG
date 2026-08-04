import { clamp } from './protocol.js'
export const validateMove = (previous, next, elapsed, maxSpeed = 10) => {
  if (!previous) return next
  const dx = next[0] - previous[0], dz = next[2] - previous[2], max = maxSpeed * Math.max(0.05, elapsed) + 0.75
  if (dx * dx + dz * dz > max * max) return null
  return [Number(next[0]) || 0, Number(next[1]) || 0, Number(next[2]) || 0]
}
export const validateInput = (input) => {
  if (!input || !Number.isInteger(input.sequence) || !Array.isArray(input.move) || input.move.length !== 2) return null
  const x = Number(input.move[0]), z = Number(input.move[1]), yaw = Number(input.rotation)
  if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(yaw)) return null
  const length = Math.hypot(x, z)
  if (length > 1.05) return null
  return { x, z, yaw, running: !!input.running, jump: !!input.jump, attack: input.attack || null }
}
export const validateAttack = (attack, player, now) => {
  if (!attack || !player || player.dead || !player.skills?.includes(attack.attackId)) return false
  const last = player.lastAttackAt?.[attack.attackId] || -Infinity
  if (now - last < 80) return false
  return Array.isArray(attack.origin) && attack.origin.length === 3 && Array.isArray(attack.direction) && attack.direction.length === 3
}
export const validateRoomSettings = (s) => ({ ...s, maxPlayers: clamp(s.maxPlayers, 2, 16), initialLevel: clamp(s.initialLevel, 1, 99), respawnSeconds: clamp(s.respawnSeconds, 1, 30), timeLimitSeconds: clamp(s.timeLimitSeconds, 0, 7200), enemyStrength: clamp(s.enemyStrength, 0.5, 3), bossStrength: clamp(s.bossStrength, 0.5, 3) })
