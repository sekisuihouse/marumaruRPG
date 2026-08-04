import { CHANNEL, iceServers, signalUrl } from './protocol.js'
import { multiplayer, notifyMultiplayer, resetMultiplayer, setMultiplayer } from './multiplayerStore.js'
import { netDebug } from './debug.js'
import { resetSnapshotState } from './snapshots.js'

let signal = null
const peers = new Map()
let reliableHandler = () => {}
let fastHandler = () => {}
let peerLeftHandler = () => {}
const sendSignal = (msg) => { if (signal?.readyState === WebSocket.OPEN) signal.send(JSON.stringify(msg)) }
const encode = (m) => JSON.stringify(m)

function meter(out, data) { const n = typeof data === 'string' ? data.length : JSON.stringify(data).length; if (out) multiplayer.bytesOut += n, multiplayer.packetsOut++; else multiplayer.bytesIn += n, multiplayer.packetsIn++ }
function receive(channel, event) {
  let m; try { m = JSON.parse(event.data) } catch { return }
  meter(false, event.data)
  if (channel === CHANNEL.reliable) reliableHandler(m); else fastHandler(m)
  notifyMultiplayer()
}
function peer(peerId, initiator) {
  const pc = new RTCPeerConnection({ iceServers: iceServers() })
  const p = { id: peerId, pc, channels: {}, connected: false }
  peers.set(peerId, p)
  pc.onicecandidate = ({ candidate }) => candidate && sendSignal({ type: 'relay', to: peerId, kind: 'ice', data: candidate })
  pc.onconnectionstatechange = () => {
    p.connected = pc.connectionState === 'connected'
    multiplayer.peers.set(peerId, { ...(multiplayer.peers.get(peerId) || {}), id: peerId, connected: p.connected, connectionState: pc.connectionState })
    netDebug('PEER CONNECTION STATE', { peerId, state: pc.connectionState })
    notifyMultiplayer()
  }
  pc.ondatachannel = ({ channel }) => attachChannel(p, channel)
  if (initiator) {
    attachChannel(p, pc.createDataChannel(CHANNEL.reliable, { ordered: true }))
    attachChannel(p, pc.createDataChannel(CHANNEL.unreliable, { ordered: false, maxRetransmits: 0 }))
  }
  return p
}
function attachChannel(p, channel) {
  p.channels[channel.label] = channel
  channel.onmessage = (e) => receive(channel.label, e)
  channel.onopen = () => { p.connected = true; netDebug('DATACHANNEL OPEN', { peerId: p.id, channel: channel.label, readyState: channel.readyState }); notifyMultiplayer() }
  channel.onclose = () => { p.connected = false; notifyMultiplayer() }
}
async function offer(peerId) { const p = peer(peerId, true); const desc = await p.pc.createOffer(); await p.pc.setLocalDescription(desc); sendSignal({ type: 'relay', to: peerId, kind: 'offer', data: desc }) }
async function relay(message) {
  let p = peers.get(message.from)
  if (message.kind === 'offer') {
    p?.pc.close(); p = peer(message.from, false)
    await p.pc.setRemoteDescription(message.data)
    const answer = await p.pc.createAnswer(); await p.pc.setLocalDescription(answer)
    sendSignal({ type: 'relay', to: message.from, kind: 'answer', data: answer })
    netDebug('WEBRTC ANSWER', { peerId: message.from, signalingState: p.pc.signalingState })
    return
  }
  if (!p) return
  if (message.kind === 'answer') { await p.pc.setRemoteDescription(message.data); netDebug('WEBRTC ANSWER APPLIED', { peerId: message.from, signalingState: p.pc.signalingState }) }
  if (message.kind === 'ice') await p.pc.addIceCandidate(message.data).catch((error) => netDebug('WEBRTC ICE ERROR', { peerId: message.from, error: error.message }))
}

export function configureNetwork({ onReliable, onFast, onPeerLeft }) { reliableHandler = onReliable || (() => {}); fastHandler = onFast || (() => {}); peerLeftHandler = onPeerLeft || (() => {}) }
export function connectSignal() {
  if (signal && [WebSocket.OPEN, WebSocket.CONNECTING].includes(signal.readyState)) return signal
  setMultiplayer({ status: 'connecting', error: '' })
  signal = new WebSocket(signalUrl())
  signal.onopen = () => setMultiplayer({ status: 'lobby' })
  signal.onmessage = async ({ data }) => {
    let m; try { m = JSON.parse(data) } catch { return }
    if (m.type === 'pong') { multiplayer.ping = Date.now() - m.sentAt; notifyMultiplayer(); return }
    if (m.type === 'created') { multiplayer.remotePlayers.clear(); resetSnapshotState(); setMultiplayer({ status: 'connected', role: 'host', playerId: m.playerId, room: m.room, settings: m.room.settings, reconnectToken: m.reconnectToken }); sessionStorage.setItem('marugoto.reconnectToken', m.reconnectToken) }
    else if (m.type === 'joined' || m.type === 'reconnected') { multiplayer.remotePlayers.clear(); resetSnapshotState(); setMultiplayer({ status: 'connected', role: 'guest', playerId: m.playerId, room: m.room, settings: m.room.settings, reconnectToken: m.reconnectToken }); sessionStorage.setItem('marugoto.reconnectToken', m.reconnectToken); const host = m.room.hostId; if (host && host !== m.playerId) multiplayer.peers.set(host, { id: host, name: 'ホスト', connected: false }); notifyMultiplayer() }
    else if (m.type === 'peerJoined' && multiplayer.role === 'host') { multiplayer.peers.set(m.peer.id, m.peer); notifyMultiplayer(); offer(m.peer.id).catch((e) => setMultiplayer({ error: e.message })) }
    else if (m.type === 'peerLeft') { closePeer(m.playerId); peerLeftHandler(m.playerId); multiplayer.peers.delete(m.playerId); multiplayer.remotePlayers.delete(m.playerId); notifyMultiplayer() }
    else if (m.type === 'relay') relay(m).catch((e) => setMultiplayer({ error: e.message }))
    else if (m.type === 'settings') setMultiplayer({ settings: m.settings, room: multiplayer.room ? { ...multiplayer.room, settings: m.settings } : null })
    else if (m.type === 'presence' && multiplayer.room) { multiplayer.room.members = m.members; notifyMultiplayer() }
    else if (m.type === 'gameStart') { meter(false, data); reliableHandler(m) }
    else if (m.type === 'roomClosed') { disconnect(); setMultiplayer({ error: 'ホストが切断したためルームを終了しました。' }) }
    else if (m.type === 'error') setMultiplayer({ error: m.code })
  }
  signal.onclose = () => { if (multiplayer.status !== 'offline') setMultiplayer({ status: 'disconnected' }) }
  signal.onerror = () => setMultiplayer({ error: 'シグナリングへ接続できません。' })
  return signal
}
export function createRoom({ name, playerName, password, settings }) { connectSignal(); const wait = setInterval(() => { if (signal?.readyState === WebSocket.OPEN) { clearInterval(wait); sendSignal({ type: 'create', name, playerName, password, maxPlayers: settings.maxPlayers, settings }) } }, 40) }
export function joinRoom({ code, playerName, password, reconnectToken = '' }) { connectSignal(); const wait = setInterval(() => { if (signal?.readyState === WebSocket.OPEN) { clearInterval(wait); sendSignal(reconnectToken ? { type: 'reconnect', code, reconnectToken } : { type: 'join', code, playerName, password }) } }, 40) }
export function updateRoomSettings(settings) { if (multiplayer.role === 'host') { multiplayer.settings = settings; sendSignal({ type: 'settings', settings }); notifyMultiplayer() } }
export function setReady(ready) { sendSignal({ type: 'ready', ready }) }
export function startNetworkGame(settings) { if (multiplayer.role === 'host') { multiplayer.gameStarted = true; sendSignal({ type: 'start' }); send(CHANNEL.reliable, { type: 'gameStart', settings }); notifyMultiplayer() } }
export function send(channel, message, peerId = null) {
  const data = encode(message); const targets = peerId ? [peers.get(peerId)] : [...peers.values()]
  for (const p of targets) {
    const c = p?.channels[channel]
    if (c?.readyState === 'open') {
      c.send(data); meter(true, data)
      if (message.type === 'input') netDebug('GUEST INPUT SEND', { playerId: multiplayer.playerId, peerId: p.id, channel, readyState: c.readyState, sequence: message.sequence, move: message.move })
    }
    else if (message.type === 'input') netDebug('GUEST INPUT SEND', { playerId: multiplayer.playerId, peerId: p?.id, channel, readyState: c?.readyState || 'missing', sequence: message.sequence, move: message.move })
  }
  notifyMultiplayer()
}
export function pingSignal() { sendSignal({ type: 'ping', sentAt: Date.now() }) }
export function disconnect() { for (const p of peers.values()) p.pc.close(); peers.clear(); if (signal?.readyState === WebSocket.OPEN) sendSignal({ type: 'leave' }); signal?.close(); signal = null; sessionStorage.removeItem('marugoto.reconnectToken'); resetMultiplayer() }
function closePeer(id) { const p = peers.get(id); p?.pc.close(); peers.delete(id) }
