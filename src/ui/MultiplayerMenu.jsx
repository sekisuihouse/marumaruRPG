import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { DEFAULT_ROOM_SETTINGS } from '../net/protocol.js'
import { createRoom, disconnect, joinRoom, pingSignal, setReady, startNetworkGame, updateRoomSettings } from '../net/webrtc.js'
import { multiplayerSnapshot, subscribeMultiplayer } from '../net/multiplayerStore.js'

const useMultiplayer = () => useSyncExternalStore(subscribeMultiplayer, multiplayerSnapshot, multiplayerSnapshot)
const field = (set, values, key, type = 'text') => <input type={type} value={values[key]} onChange={(e) => set({ ...values, [key]: type === 'number' ? Number(e.target.value) : e.target.value })} />

export function MultiplayerMenu({ onBack, onStart }) {
  const mp = useMultiplayer(); const [screen, setScreen] = useState('top'); const [name, setName] = useState(localStorage.getItem('marugoto.playerName') || 'プレイヤー')
  const [code, setCode] = useState(''); const [password, setPassword] = useState(''); const [settings, setSettings] = useState({ ...DEFAULT_ROOM_SETTINGS })
  const enteredWorld = useRef(false)
  useEffect(() => { localStorage.setItem('marugoto.playerName', name) }, [name])
  useEffect(() => { if (mp.room?.settings) setSettings({ ...DEFAULT_ROOM_SETTINGS, ...mp.room.settings }) }, [mp.room?.code])
  // DataChannel接続の有無にかかわらず、シグナリングの開始通知を受けた参加者は必ず遷移する。
  useEffect(() => {
    if (mp.role !== 'guest' || !mp.gameStarted || enteredWorld.current) return
    enteredWorld.current = true
    onStart(mp.settings)
  }, [mp.role, mp.gameStarted, mp.settings, onStart])
  if (mp.role !== 'offline') return <Lobby mp={mp} settings={settings} setSettings={setSettings} onStart={onStart} onBack={onBack} />
  return <div className="title" role="dialog" aria-modal="true" aria-label="マルチプレイ">
    <div className="title-box multi-box"><button className="back" onClick={onBack}>← 戻る</button><h2>マルチプレイ</h2>
      {screen === 'top' && <div className="title-actions"><button onClick={() => setScreen('host')}>ルームを作る</button><button onClick={() => setScreen('join')}>ルームに参加</button></div>}
      {screen === 'host' && <><label>プレイヤー名 {field((v) => setName(v.name), { name }, 'name')}</label><label>ルーム名 {field((v) => setSettings(v), settings, 'roomName')}</label><label>パスワード（任意）<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label><label>最大参加人数 {field((v) => setSettings(v), settings, 'maxPlayers', 'number')}</label><HostSettings settings={settings} setSettings={setSettings} /><button className="primary" onClick={() => createRoom({ name: settings.roomName, playerName: name, password, settings })}>ルームを作成</button></>}
      {screen === 'join' && <><label>プレイヤー名 {field((v) => setName(v.name), { name }, 'name')}</label><label>ルームコード<input value={code} maxLength="6" onChange={(e) => setCode(e.target.value.toUpperCase())} /></label><label>パスワード（必要な場合）<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label><button className="primary" onClick={() => joinRoom({ code, playerName: name, password })}>参加する</button></>}
      {mp.error && <p className="error">{mp.error}</p>}</div></div>
}
function HostSettings({ settings, setSettings }) {
  const set = (key, value) => setSettings({ ...settings, [key]: value })
  return <div className="room-settings"><label>初期Lv<input type="number" min="1" max="99" value={settings.initialLevel} onChange={(e) => set('initialLevel', Number(e.target.value))} /></label><label>敵の強さ<input type="number" min="0.5" max="3" step="0.1" value={settings.enemyStrength} onChange={(e) => set('enemyStrength', Number(e.target.value))} /></label><label>ボスの強さ<input type="number" min="0.5" max="3" step="0.1" value={settings.bossStrength} onChange={(e) => set('bossStrength', Number(e.target.value))} /></label><label>初期破壊<select value={settings.initialDestruction} onChange={(e) => set('initialDestruction', e.target.value)}><option value="none">なし</option><option value="light">軽度</option><option value="heavy">大きめ</option></select></label><label>リスポーン秒<input type="number" min="1" max="30" value={settings.respawnSeconds} onChange={(e) => set('respawnSeconds', Number(e.target.value))} /></label><label>制限時間（0=なし）<input type="number" min="0" value={settings.timeLimitSeconds} onChange={(e) => set('timeLimitSeconds', Number(e.target.value))} /></label><label>勝利条件<select value={settings.winCondition} onChange={(e) => set('winCondition', e.target.value)}><option value="free">自由プレイ</option><option value="kills">制限時間内の撃破数</option><option value="bosses">4ボス撃破</option><option value="survival">最後まで生存</option><option value="destruction">建物破壊スコア</option></select></label>{[['bosses','ボス出現'],['enemies','通常敵出現'],['pvp','PvPダメージ'],['allowJoinInProgress','途中参加']].map(([key,label]) => <label key={key}><input type="checkbox" checked={!!settings[key]} onChange={(e) => set(key, e.target.checked)} /> {label}</label>)}</div>
}
function Lobby({ mp, settings, setSettings, onStart, onBack }) {
  const host = mp.role === 'host'; const copy = () => navigator.clipboard?.writeText(mp.room.code)
  return <div className="title" role="dialog" aria-modal="true" aria-label="マルチプレイロビー"><div className="title-box multi-box"><h2>{host ? 'ホストロビー' : '参加ロビー'}</h2><p>ルームコード <button onClick={copy} className="code">{mp.room.code}　コピー</button></p><p>接続: {mp.status} / Ping: {mp.ping || '--'}ms / 可変人数（推奨 2〜4人）</p><h3>参加者</h3><ul>{(mp.room.members || []).map((m) => <li key={m.id}>{m.name}　{m.connected ? '接続中' : '再接続待ち'}　{m.ready ? '準備完了' : ''}</li>)}</ul>{host && <><HostSettings settings={settings} setSettings={(v) => { setSettings(v); updateRoomSettings(v) }} /><button className="primary" onClick={() => { startNetworkGame(settings); onStart(settings) }}>ゲーム開始</button></>}{!host && <><button className="primary" onClick={() => setReady(true)}>準備完了</button><p className="lobby-wait">準備完了後、ホストが「ゲーム開始」を押すと自動でワールドへ入ります。</p></>}<button onClick={pingSignal}>Ping確認</button><button onClick={() => { disconnect(); onBack() }}>切断して戻る</button></div></div>
}
