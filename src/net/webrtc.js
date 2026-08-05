import { CHANNEL, iceServers, signalUrl } from './protocol.js'
import { multiplayer, notifyMultiplayer, resetMultiplayer, setMultiplayer } from './multiplayerStore.js'
import { netDebug } from './debug.js'
import { resetSnapshotState } from './snapshots.js'
import { markStage, netStats, recordChannel, startStatsPolling, stopStatsPolling, resetSequenceStats } from './diagnostics.js'

/**
 * 接続の切り分け用。URLに ?ice=relay を付けるとTURN経由だけで試す。
 * 資料の「本番接続性を確認する最も有効な試験」に対応する。
 */
const icePolicy = () => (typeof location !== 'undefined' && new URLSearchParams(location.search).get('ice') === 'relay' ? 'relay' : 'all')

/**
 * 送信待ちキュー(bufferedAmount)のしきい値。
 * send() が成功してもネットワークへ出たとは限らず、キューが伸びると
 * 「数秒前の動きを今再生している」状態になる。移動系は古いものを捨てて
 * 最新だけを送り、重要イベントは限界まで送る。
 */
const BACKPRESSURE = { low: 64 * 1024, high: 256 * 1024, hard: 1024 * 1024 }
/** 落としてよい（＝次の更新が来れば取り戻せる）メッセージ */
const DROPPABLE = new Set(['snapshot', 'input'])

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
  const pc = new RTCPeerConnection({ iceServers: iceServers(), iceTransportPolicy: icePolicy() })
  // pendingIce: remoteDescription が入る前に届いた candidate を貯める場所。
  // ここを捨てると、候補の多い実ネットワークで接続できなくなる。
  const p = { id: peerId, pc, channels: {}, connected: false, pendingIce: [], queue: Promise.resolve() }
  peers.set(peerId, p)
  // 相手より先に届いていた candidate があれば引き継ぐ
  const early = earlyIce.get(peerId)
  if (early) { p.pendingIce.push(...early); earlyIce.delete(peerId) }
  pc.onicecandidate = ({ candidate }) => candidate && sendSignal({ type: 'relay', to: peerId, kind: 'ice', data: candidate })
  pc.onicecandidateerror = (e) => {
    // STUN/TURN へ届いていない・認証が切れている等はここに出る
    netStats.iceErrors.push({ url: e.url, code: e.errorCode, text: e.errorText })
    if (netStats.iceErrors.length > 8) netStats.iceErrors.shift()
    netDebug('WEBRTC ICE CANDIDATE ERROR', { url: e.url, code: e.errorCode, text: e.errorText })
  }
  pc.onconnectionstatechange = () => {
    p.connected = pc.connectionState === 'connected'
    if (pc.connectionState === 'connected') markStage('ICE_CONNECTED')
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
  // バイナリ化したときに型付き配列へ直接変換できるようにしておく（既定に依存しない）
  try { channel.binaryType = 'arraybuffer' } catch { /* 未対応環境 */ }
  channel.onmessage = (e) => receive(channel.label, e)
  channel.onopen = () => {
    p.connected = true
    markStage('DATA_CHANNEL_OPEN')
    recordChannel(channel.label, channel)
    netDebug('DATACHANNEL OPEN', { peerId: p.id, channel: channel.label, readyState: channel.readyState, ordered: channel.ordered, maxRetransmits: channel.maxRetransmits })
    notifyMultiplayer()
  }
  channel.onclose = () => { p.connected = false; recordChannel(channel.label, channel); notifyMultiplayer() }
  channel.onbufferedamountlow = () => recordChannel(channel.label, channel)
  try { channel.bufferedAmountLowThreshold = BACKPRESSURE.low } catch { /* 未対応環境 */ }
}
async function offer(peerId) {
  const p = peer(peerId, true)
  const desc = await p.pc.createOffer()
  await p.pc.setLocalDescription(desc)
  markStage('LOCAL_DESCRIPTION_SET')
  sendSignal({ type: 'relay', to: peerId, kind: 'offer', data: desc })
}
/** peer 生成前に届いた ICE candidate の一時置き場 */
const earlyIce = new Map()

/** remoteDescription が入ってから、溜めておいた candidate をまとめて流し込む */
async function flushIce(p) {
  if (!p.pc.remoteDescription || !p.pendingIce.length) return
  const queued = p.pendingIce.splice(0)
  for (const c of queued) {
    await p.pc.addIceCandidate(c).catch((error) => netDebug('WEBRTC ICE ERROR', { peerId: p.id, error: error.message }))
  }
  netDebug('WEBRTC ICE FLUSH', { peerId: p.id, count: queued.length })
}

/**
 * シグナリング中継の適用。
 *
 * onmessage は await しないので、offer/answer/ice が同時に走り得る。
 * setRemoteDescription の完了前に addIceCandidate すると候補が失われるため、
 * ピアごとに直列化し、remoteDescription が入るまで candidate を保留する。
 */
function relay(message) {
  const existing = peers.get(message.from)
  const chain = existing ? existing.queue : Promise.resolve()
  const next = chain.then(() => applyRelay(message)).catch((e) => netDebug('WEBRTC RELAY ERROR', { peerId: message.from, error: e.message }))
  const p = peers.get(message.from)
  if (p) p.queue = next
  return next
}

async function applyRelay(message) {
  let p = peers.get(message.from)
  if (message.kind === 'offer') {
    p?.pc.close()
    p = peer(message.from, false)
    markStage('REMOTE_DESCRIPTION_SET')
    await p.pc.setRemoteDescription(message.data)
    await flushIce(p)
    const answer = await p.pc.createAnswer()
    await p.pc.setLocalDescription(answer)
    markStage('LOCAL_DESCRIPTION_SET')
    sendSignal({ type: 'relay', to: message.from, kind: 'answer', data: answer })
    netDebug('WEBRTC ANSWER', { peerId: message.from, signalingState: p.pc.signalingState })
    return
  }
  if (message.kind === 'ice') {
    // まだピアが無い / remoteDescription 前なら捨てずに貯める
    if (!p) {
      const list = earlyIce.get(message.from) || []
      list.push(message.data)
      earlyIce.set(message.from, list)
      return
    }
    if (!p.pc.remoteDescription) { p.pendingIce.push(message.data); return }
    await p.pc.addIceCandidate(message.data).catch((error) => netDebug('WEBRTC ICE ERROR', { peerId: message.from, error: error.message }))
    return
  }
  if (!p) return
  if (message.kind === 'answer') {
    if (p.pc.signalingState !== 'have-local-offer') {
      netDebug('WEBRTC ANSWER IGNORED', { peerId: message.from, signalingState: p.pc.signalingState })
      return
    }
    await p.pc.setRemoteDescription(message.data)
    markStage('REMOTE_DESCRIPTION_SET')
    await flushIce(p)
    netDebug('WEBRTC ANSWER APPLIED', { peerId: message.from, signalingState: p.pc.signalingState })
  }
}

export function configureNetwork({ onReliable, onFast, onPeerLeft }) { reliableHandler = onReliable || (() => {}); fastHandler = onFast || (() => {}); peerLeftHandler = onPeerLeft || (() => {}) }
export function connectSignal() {
  if (signal && [WebSocket.OPEN, WebSocket.CONNECTING].includes(signal.readyState)) return signal
  setMultiplayer({ status: 'connecting', error: '' })
  signal = new WebSocket(signalUrl())
  signal.onopen = () => { markStage('SIGNAL_CONNECTED'); resetSequenceStats(); startStatsPolling(() => [...peers.values()]); setMultiplayer({ status: 'lobby' }) }
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
  const data = encode(message)
  const targets = peerId ? [peers.get(peerId)] : [...peers.values()]
  const droppable = DROPPABLE.has(message.type)
  for (const p of targets) {
    const c = p?.channels[channel]
    if (c?.readyState !== 'open') {
      netStats.droppedNotOpen++
      if (message.type === 'input') netDebug('GUEST INPUT SEND', { playerId: multiplayer.playerId, peerId: p?.id, channel, readyState: c?.readyState || 'missing', sequence: message.sequence, move: message.move })
      continue
    }
    if (c.bufferedAmount > netStats.bufferedMax) netStats.bufferedMax = c.bufferedAmount
    // 移動・入力は「最新が価値を持つ」。キューが伸びているなら送らずに捨て、
    // 次のフレームの新しい状態を送るほうが結果的に追従が速い。
    if (droppable && c.bufferedAmount > BACKPRESSURE.high) { netStats.droppedStale++; continue }
    // 重要イベントは基本落とさないが、限界を超えたら回線側の異常として記録する
    if (!droppable && c.bufferedAmount > BACKPRESSURE.hard) { netStats.droppedReliable++; continue }
    c.send(data)
    meter(true, data)
    recordChannel(channel, c)
    if (message.type === 'input') netDebug('GUEST INPUT SEND', { playerId: multiplayer.playerId, peerId: p.id, channel, readyState: c.readyState, sequence: message.sequence, move: message.move })
  }
  notifyMultiplayer()
}

/** 診断用: 現在のピア一覧（getStats のポーリングに使う） */
export const netPeers = () => [...peers.values()]
export function pingSignal() { sendSignal({ type: 'ping', sentAt: Date.now() }) }
export function disconnect() { stopStatsPolling(); markStage('offline'); earlyIce.clear(); for (const p of peers.values()) p.pc.close(); peers.clear(); if (signal?.readyState === WebSocket.OPEN) sendSignal({ type: 'leave' }); signal?.close(); signal = null; sessionStorage.removeItem('marugoto.reconnectToken'); resetMultiplayer() }
function closePeer(id) { const p = peers.get(id); p?.pc.close(); peers.delete(id) }
