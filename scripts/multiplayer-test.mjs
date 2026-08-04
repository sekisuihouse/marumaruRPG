/** シグナリングの結合テスト。WebRTC本体はブラウザAPIが必要なのでここではルーム制御を検証する。 */
import { spawn } from 'node:child_process'
import { WebSocket } from 'ws'
import { interpolate } from '../src/net/interpolation.js'
import { validateInput } from '../src/net/validation.js'

const port = 18787
const base = `ws://127.0.0.1:${port}/signal`
const server = spawn(process.execPath, ['server/signaling.mjs'], {
  env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
})
let output = ''
server.stdout.on('data', (d) => { output += d })
server.stderr.on('data', (d) => { output += d })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const waitServer = async () => {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return } catch { /* booting */ }
    await sleep(50)
  }
  throw new Error(`シグナリングサーバーを起動できませんでした: ${output}`)
}
const connect = async () => {
  const ws = new WebSocket(base)
  const messages = []
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())))
  const wait = async (type) => {
    for (let i = 0; i < 80; i++) {
      const index = messages.findIndex((m) => m.type === type)
      if (index >= 0) return messages.splice(index, 1)[0]
      await sleep(25)
    }
    throw new Error(`${type} を受信できませんでした: ${JSON.stringify(messages)}`)
  }
  return { ws, send: (m) => ws.send(JSON.stringify(m)), wait }
}
let failures = 0
const check = (name, ok, detail = '') => { console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); if (!ok) failures++ }

try {
  await waitServer()
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json()
  check('GET /health', health.ok === true)
  const interp = { samples: [
    { hostTime: 900_000, receivedAt: 100, position: [0, 0, 0], rotation: 0, animationState: 'idle' },
    { hostTime: 900_100, receivedAt: 200, position: [10, 0, 0], rotation: 1, animationState: 'run' },
  ] }
  interpolate(interp, 150)
  check('タブごとの時刻差でも受信時刻で位置を補間する', Math.abs(interp.x - 5) < 0.01)
  check('入力メッセージは正規化して受理する', validateInput({ sequence: 1, move: [0.6, -0.8], rotation: 1.2, running: true })?.x === 0.6)
  check('不正な移動入力を拒否する', validateInput({ sequence: 2, move: [8, 0], rotation: 0 }) === null)

  const host = await connect()
  host.send({ type: 'create', name: 'test', playerName: 'host', password: 'pw', maxPlayers: 2, settings: { bosses: true } })
  const created = await host.wait('created')
  check('ルーム作成', !!created.room?.code && created.room.members.length === 1)

  const wrong = await connect(); wrong.send({ type: 'join', code: created.room.code, playerName: 'wrong', password: 'no' })
  check('パスワード拒否', (await wrong.wait('error')).code === 'badPassword')

  const guest = await connect(); guest.send({ type: 'join', code: created.room.code, playerName: 'guest', password: 'pw' })
  const joined = await guest.wait('joined'); const peer = await host.wait('peerJoined')
  check('ルーム参加と入室通知', joined.room.members.length === 2 && peer.peer.name === 'guest')
  check('参加者一覧がホストへ即時同期される', (await host.wait('presence')).members.length === 2)

  host.send({ type: 'start' })
  check('DataChannel前でも開始通知が参加者へ届く', (await guest.wait('gameStart')).settings.bosses === true)

  const full = await connect(); full.send({ type: 'join', code: created.room.code, playerName: 'full', password: 'pw' })
  check('満員拒否', (await full.wait('error')).code === 'roomFull')

  // 参加者→ホストは許可、参加者→参加者の直接中継はサーバーで拒否される設計。
  guest.send({ type: 'relay', to: created.playerId, kind: 'ice', data: { candidate: 'candidate:test' } })
  check('ホスト中心のICE中継', (await host.wait('relay')).from === joined.playerId)
  guest.send({ type: 'relay', to: joined.playerId, kind: 'ice', data: { candidate: 'bad' } })
  check('参加者間リレー拒否', (await guest.wait('error')).code === 'invalidRelay')

  const reconnect = await connect()
  guest.ws.close(); await host.wait('peerLeft')
  reconnect.send({ type: 'reconnect', code: created.room.code, reconnectToken: joined.reconnectToken })
  check('再接続トークン', (await reconnect.wait('reconnected')).playerId === joined.playerId)

  for (const c of [host, wrong, guest, full, reconnect]) try { c.ws.close() } catch { /* ignore */ }
} catch (error) {
  failures++; console.error(error)
} finally {
  server.kill('SIGTERM')
}
if (failures) process.exit(1)
