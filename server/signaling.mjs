/** 軽量なWebRTCシグナリング。ゲーム状態は一切保持しない。 */
import http from 'node:http'
import crypto from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'

const PORT = Number(process.env.PORT || process.env.SIGNAL_PORT || 8787)
const MAX_BYTES = 16 * 1024
const ROOM_IDLE_MS = 20 * 60 * 1000
const RECONNECT_MS = 45 * 1000
const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean))
const rooms = new Map()
const socketsByIp = new Map()
const id = () => crypto.randomBytes(12).toString('base64url')
const code = () => crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6)
const hash = (value = '') => crypto.createHash('sha256').update(value).digest('hex')
const safeText = (v, max = 40) => String(v || '').replace(/[<>]/g, '').trim().slice(0, max)
const number = (value, min, max, fallback) => Math.max(min, Math.min(max, Number.isFinite(Number(value)) ? Number(value) : fallback))
function roomSettings(raw, maxPlayers) {
  const source = raw && typeof raw === 'object' ? raw : {}
  return {
    roomName: safeText(source.roomName, 48) || '未来の町', initialLevel: number(source.initialLevel, 1, 99, 1),
    bosses: source.bosses !== false, enemies: source.enemies !== false, pvp: source.pvp === true,
    maxPlayers, respawnSeconds: number(source.respawnSeconds, 1, 30, 5), allowJoinInProgress: source.allowJoinInProgress !== false,
    timeLimitSeconds: number(source.timeLimitSeconds, 0, 7200, 0),
    winCondition: ['free', 'kills', 'bosses', 'survival', 'destruction'].includes(source.winCondition) ? source.winCondition : 'free',
    initialDestruction: ['none', 'light', 'heavy'].includes(source.initialDestruction) ? source.initialDestruction : 'none',
    enemyStrength: number(source.enemyStrength, 0.5, 3, 1), bossStrength: number(source.bossStrength, 0.5, 3, 1),
  }
}

function send(ws, data) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)) }
function emitRoom(room, data, except = null) { for (const m of room.members.values()) if (m.ws !== except) send(m.ws, data) }
function closeRoom(room, reason = 'hostDisconnected') { emitRoom(room, { type: 'roomClosed', reason }); rooms.delete(room.code) }
function cleanRooms() {
  const now = Date.now()
  for (const room of rooms.values()) if (!room.members.size || now - room.updatedAt > ROOM_IDLE_MS) closeRoom(room, 'expired')
}
function rateOk(client) {
  const now = Date.now(); client.window ||= now; client.count ||= 0
  if (now - client.window > 10_000) { client.window = now; client.count = 0 }
  return ++client.count <= 80
}
function findMember(room, client) { return room && room.members.get(client.playerId) }

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, rooms: rooms.size })); return }
  res.writeHead(404); res.end('Not found')
})
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BYTES })
server.on('upgrade', (req, socket, head) => {
  const origin = req.headers.origin
  if (req.url !== '/signal' || (allowedOrigins.size && origin && !allowedOrigins.has(origin))) { socket.destroy(); return }
  const ip = String(req.socket.remoteAddress || 'unknown')
  const n = socketsByIp.get(ip) || 0
  if (n >= 24) { socket.destroy(); return }
  socketsByIp.set(ip, n + 1)
  wss.handleUpgrade(req, socket, head, (ws) => { ws.ip = ip; wss.emit('connection', ws) })
})

wss.on('connection', (ws) => {
  const client = { id: id(), playerId: null, roomCode: null, reconnectToken: null, ws, count: 0, window: Date.now() }
  send(ws, { type: 'hello', clientId: client.id })
  ws.on('message', (raw, isBinary) => {
    if (isBinary || raw.length > MAX_BYTES || !rateOk(client)) return send(ws, { type: 'error', code: 'rateOrSize' })
    let msg; try { msg = JSON.parse(raw.toString()) } catch { return send(ws, { type: 'error', code: 'malformed' }) }
    if (!msg || typeof msg.type !== 'string') return send(ws, { type: 'error', code: 'malformed' })
    if (msg.type === 'ping') return send(ws, { type: 'pong', sentAt: msg.sentAt || 0, now: Date.now() })
    if (msg.type === 'create') {
      const maxPlayers = Math.max(2, Math.min(16, Number(msg.maxPlayers) || 4))
      let roomCode; do { roomCode = code() } while (rooms.has(roomCode))
      const playerId = id(), token = id()
      const settings = roomSettings(msg.settings, maxPlayers)
      const room = { code: roomCode, name: safeText(msg.name, 48) || settings.roomName, maxPlayers, passwordHash: msg.password ? hash(String(msg.password)) : null, hostId: playerId, members: new Map(), settings, updatedAt: Date.now() }
      const member = { id: playerId, name: safeText(msg.playerName, 24) || 'ホスト', token, ws, connected: true, disconnectedAt: 0 }
      room.members.set(playerId, member); rooms.set(roomCode, room)
      Object.assign(client, { playerId, reconnectToken: token, roomCode })
      return send(ws, { type: 'created', room: roomView(room), playerId, reconnectToken: token })
    }
    if (msg.type === 'join') {
      const room = rooms.get(String(msg.code || '').toUpperCase())
      if (!room) return send(ws, { type: 'error', code: 'roomNotFound' })
      if (room.passwordHash && room.passwordHash !== hash(String(msg.password || ''))) return send(ws, { type: 'error', code: 'badPassword' })
      if (room.members.size >= room.maxPlayers) return send(ws, { type: 'error', code: 'roomFull' })
      const playerId = id(), token = id(), member = { id: playerId, name: safeText(msg.playerName, 24) || '参加者', token, ws, connected: true, disconnectedAt: 0 }
      room.members.set(playerId, member); room.updatedAt = Date.now(); Object.assign(client, { playerId, reconnectToken: token, roomCode: room.code })
      send(ws, { type: 'joined', room: roomView(room), playerId, reconnectToken: token })
      const host = room.members.get(room.hostId); if (host) send(host.ws, { type: 'peerJoined', peer: peerView(member) })
      return
    }
    if (msg.type === 'reconnect') {
      const room = rooms.get(String(msg.code || '').toUpperCase()); const member = room && [...room.members.values()].find((m) => m.token === msg.reconnectToken)
      if (!member || (member.connected && member.ws !== ws)) return send(ws, { type: 'error', code: 'reconnectDenied' })
      member.ws = ws; member.connected = true; member.disconnectedAt = 0; room.updatedAt = Date.now(); Object.assign(client, { playerId: member.id, reconnectToken: member.token, roomCode: room.code })
      send(ws, { type: 'reconnected', room: roomView(room), playerId: member.id, reconnectToken: member.token })
      if (member.id !== room.hostId) send(room.members.get(room.hostId)?.ws, { type: 'peerJoined', peer: peerView(member), reconnected: true })
      return
    }
    const room = rooms.get(client.roomCode); const member = findMember(room, client)
    if (!room || !member) return send(ws, { type: 'error', code: 'notInRoom' })
    room.updatedAt = Date.now()
    if (msg.type === 'relay') {
      const to = room.members.get(msg.to)
      // スター型: ホスト以外の参加者同士の中継は禁止。
      if (!to || (member.id !== room.hostId && to.id !== room.hostId)) return send(ws, { type: 'error', code: 'invalidRelay' })
      const kind = ['offer', 'answer', 'ice'].includes(msg.kind) ? msg.kind : null
      if (!kind || !msg.data || JSON.stringify(msg.data).length > MAX_BYTES - 400) return send(ws, { type: 'error', code: 'invalidRelay' })
      return send(to.ws, { type: 'relay', from: member.id, kind, data: msg.data })
    }
    if (msg.type === 'settings' && member.id === room.hostId && msg.settings && typeof msg.settings === 'object') {
      room.settings = roomSettings(msg.settings, room.maxPlayers); emitRoom(room, { type: 'settings', settings: room.settings }); return
    }
    if (msg.type === 'ready') { member.ready = !!msg.ready; emitRoom(room, { type: 'presence', members: [...room.members.values()].map(peerView) }); return }
    if (msg.type === 'leave') return leave(client, 'left')
    send(ws, { type: 'error', code: 'unknownMessage' })
  })
  ws.on('close', () => {
    socketsByIp.set(ws.ip, Math.max(0, (socketsByIp.get(ws.ip) || 1) - 1))
    const room = rooms.get(client.roomCode); const member = findMember(room, client)
    if (!room || !member) return
    if (member.id === room.hostId) return closeRoom(room)
    member.connected = false; member.disconnectedAt = Date.now(); emitRoom(room, { type: 'peerLeft', playerId: member.id, reconnectable: true })
    setTimeout(() => { if (room.members.get(member.id)?.connected === false && Date.now() - member.disconnectedAt >= RECONNECT_MS) room.members.delete(member.id) }, RECONNECT_MS + 10)
  })
})
function leave(client, reason) { const room = rooms.get(client.roomCode); const member = findMember(room, client); if (!room || !member) return; if (member.id === room.hostId) closeRoom(room, reason); else { room.members.delete(member.id); emitRoom(room, { type: 'peerLeft', playerId: member.id }); send(member.ws, { type: 'left' }) } client.roomCode = null }
function peerView(m) { return { id: m.id, name: m.name, ready: !!m.ready, connected: !!m.connected } }
function roomView(room) { return { code: room.code, name: room.name, maxPlayers: room.maxPlayers, hostId: room.hostId, settings: room.settings, members: [...room.members.values()].map(peerView) } }
setInterval(cleanRooms, 60_000).unref()
server.listen(PORT, '0.0.0.0', () => console.log(`signal listening on 0.0.0.0:${PORT}`))
