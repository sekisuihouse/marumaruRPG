export const PROTOCOL_VERSION = 1
export const CHANNEL = { reliable: 'reliable', unreliable: 'unreliable' }
export const NET_RATE = { movingHz: 20, idleHz: 8, snapshotHz: 20, inputTimeoutMs: 350, maxPlayers: 16, bossHpPerPlayer: 0.45 }
export const DEFAULT_ROOM_SETTINGS = {
  roomName: '未来の町', initialLevel: 1, bosses: true, enemies: true, pvp: false, maxPlayers: 4,
  respawnSeconds: 5, allowJoinInProgress: true, timeLimitSeconds: 0, winCondition: 'free',
  initialDestruction: 'none', enemyStrength: 1, bossStrength: 1,
}
export const clamp = (n, min, max) => Math.max(min, Math.min(max, Number(n) || 0))
export const iceServers = () => {
  // TURNは必ず環境変数から注入する。公開STUNだけはNAT越えの最低限として既定で使う。
  const fallback = [{ urls: 'stun:stun.l.google.com:19302' }]
  try {
    const v = JSON.parse(import.meta.env.VITE_ICE_SERVERS_JSON || '[]')
    return Array.isArray(v) && v.length ? v : fallback
  } catch { return fallback }
}
export const signalUrl = () => import.meta.env.VITE_SIGNAL_URL || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname}:8787/signal`
