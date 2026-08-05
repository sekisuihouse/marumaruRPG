/**
 * ネットワーク計測。
 *
 * 「WebRTCホスト権威型P2PにおけるFPS風リアルタイム同期の障害分析と改善実務」の
 * 『ログとメトリクス』に対応する。動かない原因を層ごとに切り分けられるよう、
 *   接続 → チャネル → プロトコル → ゲーム状態 → 補間 → 描画
 * の各段で数字が取れるようにしてある。
 *
 * 参照は `__marugoto.net.stats()`。HUDのネットワークパネル（Nキー）も同じ値を読む。
 * webrtc.js からは片方向に import する（diagnostics 側は webrtc を知らない）。
 */

import { clock } from './clock.js'

const QUANTILE_SAMPLES = 120

const series = () => ({ values: [], last: 0 })
function push(s, v) {
  s.last = v
  s.values.push(v)
  if (s.values.length > QUANTILE_SAMPLES) s.values.shift()
}
function quantile(s, q) {
  if (!s.values.length) return 0
  const sorted = [...s.values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]
}

export const netStats = {
  /** 接続の到達段階。切り分けの一行目になる。 */
  stage: 'offline',
  signalingState: '', iceConnectionState: '', connectionState: '', sctpState: '',
  /** 選択された経路。relay しか無いのに relay 未設定、などを見つける */
  candidatePair: { local: '', remote: '', protocol: '', rttMs: 0 },
  /** チャネルごとの状態と送信待ちキュー */
  channels: {},
  /** 送信待ちキューの最大値。右肩上がりなら送りすぎ */
  bufferedMax: 0,
  /** backpressure で捨てた数（古い移動更新は捨てて最新を優先する） */
  droppedStale: 0,
  droppedNotOpen: 0,
  droppedReliable: 0,
  /** onicecandidateerror の記録。STUN/TURNへ届いていないと出る */
  iceErrors: [],
  /** アプリ層のシーケンス欠落・逆転・重複。Unordered では並び替えと損失を分けて見る */
  seqGap: 0, seqReorder: 0, seqDuplicate: 0, seqApplied: 0,
  /** 受信スナップショットの鮮度と補間バッファの深さ */
  snapshotAgeMs: series(),
  bufferDepth: 0,
  interpolationUnderrun: 0,
  interpolationFrames: 0,
  /** ホストの tick 間隔と snapshot 生成時間 */
  hostTickMs: series(),
  snapshotBuildMs: series(),
  snapshotBytes: series(),
  /** 権威位置と自分の予測位置の差 */
  correctionM: series(),
  corrections: { ignore: 0, smooth: 0, strong: 0, snap: 0 },
  updatedAt: 0,
}

export const markStage = (stage) => { netStats.stage = stage }

export function recordChannel(label, channel) {
  netStats.channels[label] = {
    label,
    readyState: channel.readyState,
    ordered: channel.ordered,
    maxRetransmits: channel.maxRetransmits ?? null,
    maxPacketLifeTime: channel.maxPacketLifeTime ?? null,
    buffered: channel.bufferedAmount,
    id: channel.id,
  }
  if (channel.bufferedAmount > netStats.bufferedMax) netStats.bufferedMax = channel.bufferedAmount
}

export const recordSnapshotBuild = (ms, bytes) => { push(netStats.snapshotBuildMs, ms); push(netStats.snapshotBytes, bytes) }
export const recordHostTick = (ms) => push(netStats.hostTickMs, ms)
export const recordSnapshotAge = (ms) => push(netStats.snapshotAgeMs, ms)
export function recordCorrection(distance) {
  push(netStats.correctionM, distance)
  if (distance < 0.15) netStats.corrections.ignore++
  else if (distance < 0.5) netStats.corrections.smooth++
  else if (distance < 1.5) netStats.corrections.strong++
  else netStats.corrections.snap++
}

/**
 * シーケンス番号の欠落・逆転・重複を数える。
 * 再接続で番号が戻るため、epoch が変わったらカウンタも作り直す。
 */
const seqState = new Map()
export function recordSequence(key, epoch, sequence) {
  const prev = seqState.get(key)
  if (!prev || prev.epoch !== epoch) { seqState.set(key, { epoch, last: sequence }); netStats.seqApplied++; return 'reset' }
  const gap = sequence - prev.last
  if (gap === 1) netStats.seqApplied++
  else if (gap > 1) { netStats.seqGap += gap - 1; netStats.seqApplied++ }
  else if (gap === 0) { netStats.seqDuplicate++; return 'duplicate' }
  else { netStats.seqReorder++; return 'reorder' }
  prev.last = sequence
  return 'ok'
}
export const resetSequenceStats = () => {
  seqState.clear()
  netStats.seqGap = netStats.seqReorder = netStats.seqDuplicate = netStats.seqApplied = 0
  netStats.interpolationUnderrun = netStats.interpolationFrames = 0
  netStats.droppedStale = netStats.droppedNotOpen = netStats.droppedReliable = 0
  netStats.bufferedMax = 0
}

/** RTCPeerConnection の状態と選択経路を1秒ごとに拾う */
let pollTimer = null
export function startStatsPolling(getPeers, intervalMs = 1000) {
  if (pollTimer) return
  pollTimer = setInterval(async () => {
    const peers = getPeers()
    const first = peers[0]
    if (!first?.pc) return
    const pc = first.pc
    netStats.signalingState = pc.signalingState
    netStats.iceConnectionState = pc.iceConnectionState
    netStats.connectionState = pc.connectionState
    netStats.sctpState = pc.sctp?.state || ''
    for (const [label, c] of Object.entries(first.channels || {})) recordChannel(label, c)
    try {
      const stats = await pc.getStats()
      const byId = new Map()
      stats.forEach((s) => byId.set(s.id, s))
      stats.forEach((s) => {
        if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated) {
          netStats.candidatePair = {
            local: byId.get(s.localCandidateId)?.candidateType || '',
            remote: byId.get(s.remoteCandidateId)?.candidateType || '',
            protocol: byId.get(s.localCandidateId)?.protocol || '',
            rttMs: Math.round((s.currentRoundTripTime || 0) * 1000),
          }
        }
        if (s.type === 'data-channel') {
          const entry = netStats.channels[s.label] || (netStats.channels[s.label] = { label: s.label })
          entry.messagesSent = s.messagesSent
          entry.messagesReceived = s.messagesReceived
          entry.bytesSent = s.bytesSent
          entry.bytesReceived = s.bytesReceived
        }
      })
    } catch { /* 取得できないブラウザでは状態だけ使う */ }
    netStats.updatedAt = performance.now()
  }, intervalMs)
}
export function stopStatsPolling() { clearInterval(pollTimer); pollTimer = null }

/** 人が読める形にまとめる（__marugoto.net.stats() / HUD が使う） */
export function netDiagnostics() {
  const q = (s) => ({ p50: Math.round(quantile(s, 0.5) * 100) / 100, p95: Math.round(quantile(s, 0.95) * 100) / 100, last: Math.round(s.last * 100) / 100 })
  return {
    stage: netStats.stage,
    states: {
      signaling: netStats.signalingState, ice: netStats.iceConnectionState,
      connection: netStats.connectionState, sctp: netStats.sctpState,
    },
    route: netStats.candidatePair,
    iceErrors: netStats.iceErrors,
    channels: Object.values(netStats.channels),
    backpressure: {
      bufferedMax: netStats.bufferedMax,
      droppedStale: netStats.droppedStale,
      droppedNotOpen: netStats.droppedNotOpen,
      droppedReliable: netStats.droppedReliable,
    },
    sequence: { applied: netStats.seqApplied, gap: netStats.seqGap, reorder: netStats.seqReorder, duplicate: netStats.seqDuplicate },
    snapshot: { ageMs: q(netStats.snapshotAgeMs), buildMs: q(netStats.snapshotBuildMs), bytes: q(netStats.snapshotBytes) },
    interpolation: { depth: netStats.bufferDepth, underrun: netStats.interpolationUnderrun, frames: netStats.interpolationFrames },
    host: { tickMs: q(netStats.hostTickMs) },
    correction: { meters: q(netStats.correctionM), ...netStats.corrections },
    clock: { offsetMs: Math.round(clock.offsetMs * 10) / 10, rttMs: clock.rttMs, samples: clock.samples, ready: clock.ready },
  }
}
