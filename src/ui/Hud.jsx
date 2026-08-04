/**
 * HUD。sim からは 12Hz に間引かれたスナップショットだけを読む(useSyncExternalStore)。
 * ボタンはすべてキーボードで到達でき、キー名を併記している。
 */
import React, { useEffect, useState, useSyncExternalStore } from 'react'
import { sim, subscribeHud, getHudSnapshot, publishHud } from '../engine/sim.js'
import { PLAYER_ATTACKS, PRESS_ATTACKS, ELEMENTS, ENEMY_TYPES, ENEMY_BALANCE } from '../data/enemies.js'
import { QUESTS, ITEMS } from '../data/quests.js'
import { KEYMAP, keys, pressed, touch } from '../engine/input.js'
import { FIRE_STREAM } from '../data/abilities.js'
import { tryAttack } from '../engine/step.js'
import { dialogueView, chooseDialogue, closeDialogue, useItem } from '../engine/quests.js'
import { saveGame, deleteSave } from '../engine/save.js'
import { resetTown } from '../engine/destruct.js'
import { resetBossProgress } from '../engine/bosses.js'
import { Minimap } from './Minimap.jsx'
import { multiplayerSnapshot, subscribeMultiplayer } from '../net/multiplayerStore.js'

const useHud = () => useSyncExternalStore(subscribeHud, getHudSnapshot, getHudSnapshot)

const Bar = ({ value, max, className, label }) => (
  <div className={`bar ${className}`} role="progressbar" aria-label={label} aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={max}>
    <i style={{ width: `${Math.max(0, Math.min(100, (value / max) * 100))}%` }} />
  </div>
)

export function Hud({ onRequestPointerLock }) {
  const hud = useHud()
  const [showHelp, setShowHelp] = useState(false)
  const [showQuests, setShowQuests] = useState(false)
  const [bigMap, setBigMap] = useState(false)
  const [tick, setTick] = useState(0)
  const resetMapAndBosses = () => {
    if (!confirm('町の破壊状態とボスの討伐状況を初期化します。出現中のボスも消えます。よろしいですか？')) return
    resetTown()
    resetBossProgress()
    saveGame(true)
    publishHud()
  }

  // UI開閉のキー操作。ゲーム内入力とは別に window で拾う
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
      const k = e.key.toLowerCase()
      if (k === 'h' || e.key === 'F1') { e.preventDefault(); setShowHelp((v) => !v) }
      else if (k === 't') setShowQuests((v) => !v)
      else if (k === 'm') setBigMap((v) => !v)
      else if (e.key === 'F5') { e.preventDefault(); saveGame() }
      else if (k === 'escape') {
        if (window.parent !== window && new URLSearchParams(window.location.search).has('autostart')) {
          window.parent.postMessage({ type: 'marugoto-future-quest-escape' }, '*')
          return
        }
        if (sim.mode === 'dialogue') closeDialogue()
        else if (showHelp || showQuests) {
          setShowHelp(false); setShowQuests(false); setBigMap(false)
          onRequestPointerLock?.()
        } else {
          document.exitPointerLock?.()
          setShowHelp(true)
        }
      }
      setTick((v) => v + 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showHelp, showQuests, onRequestPointerLock])

  // パネルを開いている間はシミュレーションを止める(読んでいる間に死なないように)
  useEffect(() => {
    sim.paused = showHelp || showQuests
    return () => { sim.paused = false }
  }, [showHelp, showQuests])

  const dialogue = hud.mode === 'dialogue' ? dialogueView() : null
  const cls = [
    'hud',
    hud.settings.largeText ? 'large-text' : '',
    hud.settings.highContrast ? 'high-contrast' : '',
  ].join(' ')

  return (
    <section className={cls} data-tick={tick}>
      <div className="brand">
        MARUGOTO<br /><small>FUTURE QUEST</small>
      </div>
      <NetworkStatus />
      {hud.bosses.map((boss) => (
        <section className="boss-hud" key={boss.id} aria-label={`${boss.label} HP`}>
          <b>{boss.label}　PHASE {boss.phase}{boss.vulnerable ? '　弱点露出!' : ''}</b>
          <Bar value={boss.hp} max={boss.maxHp} className="boss-hp" label={`${boss.label} HP`} />
        </section>
      ))}

      {/* ステータス */}
      <div className="stats">
        <b>Lv.{hud.level}　アドベンチャラー{hud.isNight ? '　🌙夜' : '　☀昼'}</b>
        <Bar value={hud.hp} max={hud.maxHp} className="hp" label="HP" />
        <Bar value={hud.mp} max={hud.maxMp} className="mp" label="MP" />
        <Bar value={hud.stamina} max={hud.maxStamina} className="sp" label="スタミナ" />
        <small>
          HP {hud.hp}/{hud.maxHp}　MP {hud.mp}/{hud.maxMp}<br />
          EXP {hud.xp}/{hud.xpNext}　✦ {hud.gold}　撃破 {hud.kills}
        </small>
      </div>

      <Minimap large={bigMap} />

      {/* スキルバー */}
      <div className="skills" role="toolbar" aria-label="技">
        <button
          onClick={() => { pressed[' '] = true }}
          aria-label="回避ローリング キーSpace"
          title="回避ローリング（Space）"
        >
          <span>↻ ローリング</span><em>Space</em>
        </button>
        <button
          onPointerDown={() => { keys.shift = true }}
          onPointerUp={() => { keys.shift = false }}
          onPointerCancel={() => { keys.shift = false }}
          aria-label="ダッシュ キーShift"
          title="ダッシュ（Shiftを押している間）"
        >
          <span>⇧ ダッシュ</span><em>Shift</em>
        </button>
        {PRESS_ATTACKS.map((a) => {
          const locked = !hud.skills.includes(a.id)
          const cd = (hud.cooldowns[a.id] || 0) - sim.time
          return (
            <button
              key={a.id}
              onClick={() => tryAttack(a.id)}
              disabled={locked}
              className={cd > 0 ? 'cooling' : ''}
              aria-label={`${a.label} キー${a.key}${locked ? `（レベル${a.unlockLevel}で解禁）` : ''}`}
              title={locked ? `Lv.${a.unlockLevel}で解禁` : `${a.label}（${a.key}）`}
            >
              <span>{a.label}</span>
              <em>{locked ? `Lv${a.unlockLevel}` : cd > 0 ? `${cd.toFixed(1)}s` : a.key}</em>
            </button>
          )
        })}
        <HoldButton
          ability={PLAYER_ATTACKS.webswing}
          locked={!hud.skills.includes('webswing')}
          active={hud.swinging}
          flag="webswing"
        />
        <HoldButton
          ability={PLAYER_ATTACKS.firestream}
          locked={!hud.skills.includes('firestream')}
          active={hud.heat > 0 && !hud.overheat}
          warn={hud.overheat}
          flag="firestream"
        />
        <button
          className={hud.blocking ? 'on' : ''}
          onPointerDown={() => { keys.control = true }}
          onPointerUp={() => { keys.control = false }}
          onPointerCancel={() => { keys.control = false }}
          aria-label="盾を構える キーControl"
        >
          <span>🛡 盾を構える</span><em>Ctrl</em>
        </button>
      </div>

      {hud.skills.includes('firestream') && (
        <div className="heat" aria-label="火球の熱量">
          <Bar value={hud.heat} max={FIRE_STREAM.heat.max} className={hud.overheat ? 'heat-over' : 'heat-bar'} label="熱量" />
          <small>{hud.overheat ? 'オーバーヒート！冷却中' : `熱量 ${hud.heat}/${FIRE_STREAM.heat.max}`}</small>
        </div>
      )}

      <Shockwave />

      {/* メッセージログ */}
      <div className="messages" aria-live="polite" aria-atomic="false">
        {hud.messages.map((m) => (
          <p key={m.id} className={`msg ${m.kind}`}>{m.text}</p>
        ))}
      </div>

      {hud.levelUp && <LevelUpNotice levelUp={hud.levelUp} />}
      {hud.tutorialComplete && <section className="tutorial-complete-notice" role="status" aria-live="assertive">レベルアップすると<br /><strong>攻撃が増えるよ！</strong></section>}

      {/* 進行中クエスト(常時1件だけ簡易表示) */}
      <ActiveQuest hud={hud} />

      {hud.nearest && hud.mode === 'play' && (
        <p className="interact-hint">Gキー: {hud.nearest.name} と話す</p>
      )}

      {dialogue && <Dialogue view={dialogue} />}
      {showQuests && <QuestLog hud={hud} onClose={() => setShowQuests(false)} />}
      {showHelp && <HelpOverlay hud={hud} onClose={() => setShowHelp(false)} />}
      {hud.dead && <DeathOverlay />}

      <button className="reset-fab" onClick={resetMapAndBosses} aria-label="マップとボスを初期化">
        ↻ マップ・ボス初期化
      </button>
      <button className="help-fab" onClick={() => setShowHelp(true)} aria-label="操作説明を開く（Hキー）">？ 操作 H</button>
    </section>
  )
}

function NetworkStatus() {
  const net = useSyncExternalStore(subscribeMultiplayer, multiplayerSnapshot, multiplayerSnapshot)
  if (net.role === 'offline') return null
  return <div className="network-status" aria-label="マルチプレイ接続状態">{net.role === 'host' ? 'HOST' : 'ONLINE'} · {net.ping || '--'}ms</div>
}

/**
 * 長押しで働く技（ウェブスイング・連続火球）のボタン。
 * PC はキー、スマホはこのボタンの長押しで動く。カメラ操作と同時に押せる。
 */
function HoldButton({ ability, locked, active, warn, flag }) {
  const down = (e) => {
    e.preventDefault()
    if (!locked) touch[flag] = true
  }
  const up = () => { touch[flag] = false }
  return (
    <button
      className={`hold ${active ? 'on' : ''} ${warn ? 'warn' : ''}`}
      disabled={locked}
      onPointerDown={down}
      onPointerUp={up}
      onPointerCancel={up}
      onPointerLeave={up}
      aria-label={`${ability.label} キー${ability.key}（押している間）${locked ? `（レベル${ability.unlockLevel}で解禁）` : ''}`}
      title={locked ? `Lv.${ability.unlockLevel}で解禁` : `${ability.label}（${ability.key}を押している間）`}
    >
      <span>{ability.label}</span>
      <em>{locked ? `Lv${ability.unlockLevel}` : ability.key}</em>
    </button>
  )
}

/** 大破壊のときだけ画面中央から外側へ広がる衝撃表現 */
function Shockwave() {
  const [v, setV] = useState(0)
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const s = sim.juice?.shockwave || 0
      setV((prev) => (Math.abs(prev - s) > 0.01 ? s : prev))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])
  if (v <= 0.01) return null
  return <div className="shockwave" style={{ opacity: Math.min(0.55, v), transform: `scale(${1 + v * 1.6})` }} aria-hidden="true" />
}

function LevelUpNotice({ levelUp }) {
  return (
    <section className="level-up-notice" role="status" aria-live="assertive">
      <strong>LEVEL UP!</strong>
      <b>Lv.{levelUp.level}</b>
      {levelUp.skills.length > 0 && <p>新しい攻撃を覚えた！<span>{levelUp.skills.map((s) => `${s.label}［${s.key}］`).join('　')}</span></p>}
    </section>
  )
}

function ActiveQuest({ hud }) {
  const active = hud.quests.find((q) => q.state === 'active')
  if (!active) return null
  const def = QUESTS.find((q) => q.id === active.id)
  const step = def?.steps[active.step]
  if (!def || !step) return null
  const count = step.kind === 'kill' ? `（${active.counters[step.typeId] || 0}/${step.count}）` : ''
  return (
    <aside className={`quest-tracker ${def.id === 'q_tutorial' ? 'tutorial-notice' : ''}`}>
      <b>◆ {def.title}</b>
      <span>{step.label}{count}</span>
      <small>T: クエストログ / H: 操作説明</small>
    </aside>
  )
}

function Dialogue({ view }) {
  return (
    <div className="dialogue" role="dialog" aria-modal="true" aria-label={`${view.name}との会話`}>
      <div className="dialogue-box">
        <b>{view.name}<small>　{view.role}</small></b>
        <p>{view.text}</p>
        <ul>
          {view.choices.map((c) => (
            <li key={c.index}>
              <button autoFocus={c.index === 0} onClick={() => chooseDialogue(c.index)}>
                <kbd>{c.index + 1}</kbd> {c.label}
              </button>
            </li>
          ))}
        </ul>
        <small>数字キーで選択 / Escで閉じる</small>
      </div>
    </div>
  )
}

function QuestLog({ hud, onClose }) {
  return (
    <div className="panel" role="dialog" aria-modal="true" aria-label="クエストログ">
      <div className="panel-box">
        <header><b>クエストログ</b><button onClick={onClose} aria-label="閉じる">✕</button></header>
        <ul className="quest-list">
          {QUESTS.map((def) => {
            const q = hud.quests.find((x) => x.id === def.id)
            if (!q) return null
            const stateLabel = { locked: '未受注', active: '進行中', done: '達成' }[q.state]
            return (
              <li key={def.id} className={q.state}>
                <b>{def.title}</b> <em>{stateLabel}</em>
                <ol>
                  {def.steps.map((s, i) => {
                    const done = q.state === 'done' || i < q.step
                    const now = q.state === 'active' && i === q.step
                    const c = s.kind === 'kill' ? `（${q.counters[s.typeId] || 0}/${s.count}）` : ''
                    return <li key={i} className={done ? 'done' : now ? 'now' : ''}>{done ? '✔' : now ? '▶' : '・'} {s.label}{c}</li>
                  })}
                </ol>
              </li>
            )
          })}
        </ul>
        <h4>所持品</h4>
        <ul className="items">
          {Object.entries(hud.items).length === 0 && <li><small>なし</small></li>}
          {Object.entries(hud.items).map(([id, n]) => (
            <li key={id}>
              <button onClick={() => useItem(id)} disabled={!ITEMS[id]?.heal && !ITEMS[id]?.mp && !ITEMS[id]?.attack}>
                {ITEMS[id]?.label || id} ×{n}
              </button>
              <small>{ITEMS[id]?.desc}</small>
            </li>
          ))}
        </ul>
        <h4>敵の情報</h4>
        <ul className="bestiary">
          {Object.values(ENEMY_TYPES).map((d) => (
            <li key={d.id}>
              <b style={{ color: d.look.color }}>{d.name}</b> <small>{d.role}</small><br />
              <small>
                HP {d.stats.maxHp}／索敵 {d.senses.sightRange}m／攻撃間隔 {d.stats.attackInterval}s／
                弱点 {Object.keys(d.weakness).map((k) => ELEMENTS[k]?.label).join('・') || 'なし'}／
                {d.ai.fleeAtHp ? `HP${Math.round(d.ai.fleeAtHp * 100)}%で逃走` : '逃げない'}
                {d.ai.enrageAtHp ? `／HP${Math.round(d.ai.enrageAtHp * 100)}%で狂暴化` : ''}
              </small>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function HelpOverlay({ hud, onClose }) {
  const set = (key, value) => { sim.settings[key] = value; publishHud() }
  const resetMapAndBosses = () => {
    if (!confirm('町の破壊状態とボスの討伐状況を初期化します。出現中のボスも消えます。よろしいですか？')) return
    resetTown()
    resetBossProgress()
    saveGame(true)
    publishHud()
  }
  return (
    <div className="panel" role="dialog" aria-modal="true" aria-label="操作説明と表示設定">
      <div className="panel-box">
        <header><b>操作説明（キーボードだけで遊べます）</b><button onClick={onClose} aria-label="閉じる">✕</button></header>
        <table className="keymap">
          <caption className="sr-only">キー割り当て一覧</caption>
          <tbody>
            {KEYMAP.map((k) => (
              <tr key={k.id}>
                <th scope="row">
                  {k.keys.map((x) => <kbd key={x}>{x}</kbd>)}
                  {k.alt && <span className="alt">（{k.alt.join(' / ')}）</span>}
                </th>
                <td>{k.label}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h4>表示とアクセシビリティ</h4>
        <div className="toggles">
          <label><input type="checkbox" checked={hud.settings.largeText} onChange={(e) => set('largeText', e.target.checked)} /> 文字を大きく</label>
          <label><input type="checkbox" checked={hud.settings.highContrast} onChange={(e) => set('highContrast', e.target.checked)} /> 高コントラスト</label>
          <label><input type="checkbox" checked={hud.settings.reducedMotion} onChange={(e) => set('reducedMotion', e.target.checked)} /> 画面の揺れ・星を減らす</label>
          <label><input type="checkbox" checked={hud.settings.invertY} onChange={(e) => set('invertY', e.target.checked)} /> カメラ上下反転</label>
          <label><input type="checkbox" checked={hud.settings.reducedFlash} onChange={(e) => set('reducedFlash', e.target.checked)} /> 光の点滅を減らす</label>
          <label><input type="checkbox" checked={hud.settings.muteSfx} onChange={(e) => set('muteSfx', e.target.checked)} /> 破壊音を消す</label>
        </div>
        <h4>破壊表現</h4>
        <div className="toggles sliders">
          <label>
            カメラの揺れ <b>{Math.round((hud.settings.shakeAmount ?? 1) * 100)}%</b>
            <input type="range" min="0" max="1" step="0.1" value={hud.settings.shakeAmount ?? 1}
              onChange={(e) => set('shakeAmount', Number(e.target.value))} />
          </label>
          <label>
            破片の量 <b>{Math.round((hud.settings.debrisAmount ?? 1) * 100)}%</b>
            <input type="range" min="0" max="1" step="0.1" value={hud.settings.debrisAmount ?? 1}
              onChange={(e) => set('debrisAmount', Number(e.target.value))} />
          </label>
          <label>
            粉じんの量 <b>{Math.round((hud.settings.dustAmount ?? 1) * 100)}%</b>
            <input type="range" min="0" max="1" step="0.1" value={hud.settings.dustAmount ?? 1}
              onChange={(e) => set('dustAmount', Number(e.target.value))} />
          </label>
          <label>
            破壊の品質
            <select value={hud.settings.destructionQuality ?? 'high'} onChange={(e) => set('destructionQuality', e.target.value)}>
              <option value="high">高（PC向け）</option>
              <option value="medium">中</option>
              <option value="low">低（低性能端末向け）</option>
            </select>
          </label>
          <small>品質を下げても「攻撃した場所が壊れる」動きはそのままで、破片の数だけ減ります。</small>
        </div>
        <h4>敵のバランス</h4>
        <p className="balance-note">
          <small>
            HP {Math.round(ENEMY_BALANCE.hpMul * 100)}%／攻撃力 {Math.round(ENEMY_BALANCE.attackMul * 100)}%／
            攻撃頻度 {Math.round(ENEMY_BALANCE.frequencyMul * 100)}%／同時に攻撃してくる敵は最大 {ENEMY_BALANCE.maxAggressive} 体。
          </small>
        </p>
        <h4>セーブ</h4>
        <div className="toggles">
          <button onClick={() => saveGame()}>今すぐセーブ（F5）</button>
          <button onClick={resetMapAndBosses}>マップ・ボスを初期化</button>
          <button onClick={() => { if (confirm('セーブを削除して最初からやり直しますか？')) { deleteSave(); location.reload() } }}>セーブを削除</button>
          <small>初期化は町の破壊、ボス出現・討伐・報酬をリセットして保存します。25秒ごとに自動セーブされます。</small>
        </div>
      </div>
    </div>
  )
}

function DeathOverlay() {
  return (
    <div className="death" role="alert">
      <b>力尽きた……</b>
      <span>まもなく集会所前で復活します（経験値と所持品はそのまま）</span>
    </div>
  )
}

export { useHud }
