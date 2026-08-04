import { DEFAULT_ROOM_SETTINGS } from './protocol.js'
const listeners = new Set()
let revision = 0
let cachedRevision = -1
let cachedSnapshot = null
export const multiplayer = {
  status: 'offline', role: 'offline', playerId: null, room: null, settings: { ...DEFAULT_ROOM_SETTINGS },
  peers: new Map(), remotePlayers: new Map(), ping: 0, bytesIn: 0, bytesOut: 0, packetsIn: 0, packetsOut: 0,
  interpolationDelay: 110, error: '', gameStarted: false, reconnectToken: typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('marugoto.reconnectToken') || '' : '',
}
export const notifyMultiplayer = () => { revision++; listeners.forEach((fn) => fn()) }
export const subscribeMultiplayer = (fn) => { listeners.add(fn); return () => listeners.delete(fn) }
export const multiplayerSnapshot = () => {
  if (cachedRevision === revision && cachedSnapshot) return cachedSnapshot
  cachedRevision = revision
  cachedSnapshot = { ...multiplayer, peers: [...multiplayer.peers.values()], remotePlayers: [...multiplayer.remotePlayers.values()] }
  return cachedSnapshot
}
export function setMultiplayer(patch) { Object.assign(multiplayer, patch); notifyMultiplayer() }
export function resetMultiplayer() { multiplayer.status = 'offline'; multiplayer.role = 'offline'; multiplayer.playerId = null; multiplayer.room = null; multiplayer.gameStarted = false; multiplayer.peers.clear(); multiplayer.remotePlayers.clear(); notifyMultiplayer() }
