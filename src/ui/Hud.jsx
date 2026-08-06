/**
 * HUD。sim からは 12Hz に間引かれたスナップショットだけを読む(useSyncExternalStore)。
 * ボタンはすべてキーボードで到達でき、キー名を併記している。
 */
import React, { useEffect, useState, useSyncExternalStore } from 'react'
import { sim, subscribeHud, getHudSnapshot, publishHud } from '../engine/sim.js'
import { PLAYER_ATTACKS, ELEMENTS, ENEMY_TYPES, ENEMY_BALANCE } from '../data/enemies.js'
import { QUESTS, ITEMS } from '../data/quests.js'
import { ACTION_META, bindingCodes, bindingConflicts, bindingLabel, bindingsSnapshot, clearKeys, isTouchDevice, resetBindings, setBinding, setInputContext, setVirtualAction } from '../engine/input.js'
import { MobileControls } from './MobileControls.jsx'
import { findAnchor } from '../engine/webswing.js'
import { tryAttack } from '../engine/step.js'
import { dialogueView, chooseDialogue, closeDialogue, useItem } from '../engine/quests.js'
import { saveGame, deleteSave } from '../engine/save.js'
import { resetTown } from '../engine/destruct.js'
import { resetBossProgress } from '../engine/bosses.js'
import { resetFinalBoss } from '../engine/finalBoss.js'
import { Minimap } from './Minimap.jsx'
import { multiplayerSnapshot, subscribeMultiplayer } from '../net/multiplayerStore.js'
import { netDiagnostics } from '../net/diagnostics.js'
import { refreshMusicVolume } from '../engine/music.js'

const useHud = () => useSyncExternalStore(subscribeHud, getHudSnapshot, getHudSnapshot)
const ABILITY_SLOTS = ['magic', 'area', 'arrow', 'firestream']

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
    resetFinalBoss()
    saveGame(true)
    publishHud()
  }

  // UI開閉のキー操作。ゲーム内入力とは別に window で拾う
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
      const isAction = (action) => bindingCodes(action).includes(e.code)
      if (isAction('help')) { e.preventDefault(); setShowHelp((v) => !v) }
      else if (isAction('quest')) setShowQuests((v) => !v)
      else if (isAction('map')) setBigMap((v) => !v)
      else if (isAction('pause')) {
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
    setInputContext(showHelp || showQuests ? 'menu' : hud.mode === 'dialogue' ? 'dialog' : 'gameplay')
    clearKeys()
    return () => { sim.paused = false; setInputContext('gameplay'); clearKeys() }
  }, [showHelp, showQuests, hud.mode])

  const dialogue = hud.mode === 'dialogue' ? dialogueView() : null
  // タッチ端末は原神と同じ操作系(MobileControls)へ丸ごと差し替える。
  // 判定は初回だけで固定し、途中で操作系が入れ替わらないようにする。
  const [touchUi] = useState(isTouchDevice)
  const playing = !showHelp && !showQuests && !dialogue && hud.mode === 'play'
  const cls = [
    'hud',
    hud.settings.largeText ? 'large-text' : '',
    hud.settings.highContrast ? 'high-contrast' : '',
    touchUi ? 'touch-ui' : '',
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
      {hud.finalBoss && <FinalBossHud boss={hud.finalBoss} />}

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

      {touchUi
        ? playing && <MobileControls hud={hud} />
        : <><CombatHud hud={hud} /><ContextHint hud={hud} /></>}

      <Shockwave />

      {hud.objectiveBanner && <ObjectiveBanner banner={hud.objectiveBanner} />}
      {hud.levelUp && <LevelUpNotice levelUp={hud.levelUp} />}
      {hud.tutorialComplete && <section className="tutorial-complete-notice" role="status" aria-live="assertive">レベルアップすると<br /><strong>攻撃が増えるよ！</strong></section>}

      {/* 進行中クエスト(常時1件だけ簡易表示) */}
      <ActiveQuest hud={hud} />

      {dialogue && <Dialogue view={dialogue} />}
      {showQuests && <QuestLog hud={hud} onClose={() => setShowQuests(false)} />}
      {showHelp && <HelpOverlay hud={hud} onClose={() => setShowHelp(false)} />}
      {hud.dead && <DeathOverlay />}

      {import.meta.env.DEV && <button className="reset-fab" onClick={resetMapAndBosses} aria-label="開発用：マップとボスを初期化">↻ 開発用リセット</button>}
      <button className="help-fab" onClick={() => setShowHelp(true)} aria-label="操作説明を開く（F1キー）">？ 操作 F1</button>
    </section>
  )
}

/** フェーズが切り替わった瞬間に、やることを画面中央へ数秒出す。 */
function ObjectiveBanner({ banner }) {
  return <section className="objective-banner" role="status" aria-live="assertive" key={banner.id}>
    <small style={{ color: banner.color }}>{banner.label}</small>
    <strong>{banner.text}</strong>
  </section>
}

function FinalBossHud({ boss }) {
  const live = boss.parts.filter((p) => p.state !== 'broken' && (boss.phase >= 4 ? p.id === 'core' : p.id !== 'core')).slice(0, 5)
  return <section className="boss-hud final-boss-hud" aria-label={`${boss.label} HP`}>
    <b>{boss.label}　PHASE {boss.phase}</b>
    <Bar value={boss.hp} max={boss.maxHp} className="boss-hp" label={`${boss.label} HP`} />
    <small>{boss.objective}</small>
    {boss.phase >= 5
      ? <div className="final-parts"><span>身体 残り {boss.bodyIntact}/{boss.bodyTotal}</span></div>
      : <div className="final-parts">{live.map((part) => <span key={part.id}>{part.label} {Math.ceil(part.hp / part.maxHp * 100)}%</span>)}</div>}
  </section>
}

function HoldActionButton({ action, children, active = false, className = '' }) {
  const down = (event) => { event.preventDefault(); setVirtualAction(action, true) }
  const up = () => setVirtualAction(action, false)
  return <button className={`${className} ${active ? 'on' : ''}`} onPointerDown={down} onPointerUp={up} onPointerCancel={up} onPointerLeave={up}>{children}</button>
}

/** 常に同じ位置へ置く、4スロット + R発動の戦闘HUD。 */
function CombatHud({ hud }) {
  const selected = hud.selectedAbility || 'magic'
  const selectedDef = PLAYER_ATTACKS[selected] || PLAYER_ATTACKS.magic
  const selectedLocked = !hud.skills.includes(selected)
  const selectedCd = Math.max(0, (hud.cooldowns[selected] || 0) - sim.time)
  const insufficient = !selectedLocked && selectedDef.cost?.mp && hud.mp < selectedDef.cost.mp ? 'MP不足'
    : !selectedLocked && selectedDef.cost?.stamina && hud.stamina < selectedDef.cost.stamina ? 'スタミナ不足' : ''
  const useText = selected === 'firestream'
    ? `[${bindingLabel('useAbility')} 長押し] 連続火球　熱量 ${hud.heat}%`
    : selectedLocked ? `🔒 Lv.${selectedDef.unlockLevel}で解放` : insufficient ? `${insufficient}　[${bindingLabel('useAbility')}] ${selectedDef.label}` : selectedCd > 0 ? `クールダウン ${selectedCd.toFixed(1)}秒` : `[${bindingLabel('useAbility')}] ${selectedDef.label} を使う`
  const choose = (id) => { sim.player.selectedAbility = id; publishHud() }
  return (
    <section className="combat-hud" aria-label="戦闘操作">
      <div className="ability-slots" role="toolbar" aria-label="技スロット">
        {ABILITY_SLOTS.map((id, index) => {
          const ability = PLAYER_ATTACKS[id]
          const locked = !hud.skills.includes(id)
          const cd = Math.max(0, (hud.cooldowns[id] || 0) - sim.time)
          const isSelected = selected === id
          return <button key={id} onClick={() => choose(id)} className={`${isSelected ? 'selected' : ''} ${locked ? 'locked' : ''} ${cd > 0 ? 'cooling' : ''}`} aria-pressed={isSelected}>
            <b><kbd>{bindingLabel(`ability${index + 1}`)}</kbd> {ability.label}</b>
            <span>{locked ? `🔒 Lv.${ability.unlockLevel}` : cd > 0 ? `◔ ${cd.toFixed(1)}秒` : ability.cost?.mp ? `MP ${ability.cost.mp}${isSelected ? '　選択中' : ''}` : ability.cost?.stamina ? `ST ${ability.cost.stamina}${isSelected ? '　選択中' : ''}` : isSelected ? '選択中' : '使用可能'}</span>
          </button>
        })}
      </div>
      <div className={`ability-use ${selectedLocked ? 'locked' : ''} ${selected === 'firestream' && hud.overheat ? 'warn' : ''}`} role="status">{selected === 'firestream' && hud.overheat ? 'オーバーヒート：冷却中' : useText}</div>
      <div className="quick-actions" role="toolbar" aria-label="基本アクション">
        <button onClick={() => tryAttack('melee')}><kbd>{bindingLabel('meleeAttack')}</kbd><span>⚔ 近接</span></button>
        <HoldActionButton action="webSwing" active={hud.swinging}><kbd>{bindingLabel('webSwing')}</kbd><span>🕸 ウェブ</span></HoldActionButton>
        <button onClick={() => tryAttack('heal')}><kbd>{bindingLabel('heal')}</kbd><span>✚ 回復</span></button>
        <HoldActionButton action="guard" active={hud.blocking}><kbd>{bindingLabel('guard')}</kbd><span>🛡 盾</span></HoldActionButton>
      </div>
    </section>
  )
}

/** ウェブに必要な「狙える / 狙えない / 接続中」を画面中央で明示する。 */
function ContextHint({ hud }) {
  if (hud.dead || hud.mode !== 'play') return null
  const web = sim.player.web
  const attached = !!web?.attached
  const failed = (web?.failHintUntil || 0) > sim.time
  const anchor = hud.canWeb && !attached && !failed ? findAnchor() : null
  const hint = attached ? `[${bindingLabel('webSwing')}] を離す：糸を切って落下`
    : failed ? web.failReason || '接続先なし'
      : hud.nearest ? `[${bindingLabel('interact')}] ${hud.nearest.name} と話す`
        : anchor ? `[${bindingLabel('webSwing')}] 長押し　ウェブを接続` : null
  return <div className={`context-hint ${attached ? 'attached' : anchor ? 'ready' : failed ? 'unavailable' : ''}`} role="status"><i aria-hidden="true">{attached ? '◎' : anchor ? '○' : '＋'}</i>{hint && <span>{hint}</span>}</div>
}

/**
 * マルチプレイの接続状態。
 * P2P(DataChannel)が張れていないと「ゲームは始まるのに相手が全く見えない」状態になる。
 * それが一目で分かるよう、状態表示と警告を出す。詳細は N キー。
 */
function NetworkStatus() {
  const net = useSyncExternalStore(subscribeMultiplayer, multiplayerSnapshot, multiplayerSnapshot)
  const [detail, setDetail] = useState(false)
  const [stats, setStats] = useState(null)
  const [waited, setWaited] = useState(0)

  useEffect(() => {
    if (net.role === 'offline') return
    const onKey = (e) => { if (e.key.toLowerCase() === 'n') setDetail((v) => !v) }
    window.addEventListener('keydown', onKey)
    const t = setInterval(() => { setStats(netDiagnostics()); setWaited((v) => v + 1) }, 1000)
    return () => { window.removeEventListener('keydown', onKey); clearInterval(t) }
  }, [net.role])

  if (net.role === 'offline') return null
  const linked = net.peers.some((p) => p.connected)
  const seeing = net.remotePlayers.length > 0
  // 10秒待っても繋がらないなら、原因の切り分け方まで出す
  const stuck = !linked && waited > 10
  return (
    <>
      <div className={`network-status ${linked ? '' : 'warn'}`} aria-label="マルチプレイ接続状態">
        {net.role === 'host' ? 'HOST' : 'ONLINE'} · {linked ? 'P2P接続' : 'P2P未接続'} · 相手{net.remotePlayers.length}人 · {net.ping || '--'}ms
        <em>（Nキーで詳細）</em>
      </div>
      {stuck && (
        <div className="network-alert" role="alert">
          <b>相手と直接つながれていません</b>
          <span>ゲームは動いていますが、この状態では相手の姿は見えません。</span>
          <small>
            経路: {stats?.route?.local || '—'}/{stats?.route?.remote || '—'} ／ ICE: {stats?.states?.ice || '—'} ／ 段階: {stats?.stage}<br />
            同じWi-Fiなら「ネットワーク分離(AP isolation)」を切る。別回線どうしなら TURN の設定が必要です。
          </small>
        </div>
      )}
      {linked && !seeing && waited > 12 && (
        <div className="network-alert" role="alert">
          <b>つながっていますが相手の位置が届いていません</b>
          <small>受信 {stats?.sequence?.applied ?? 0} 件 ／ 欠落 {stats?.sequence?.gap ?? 0}。Nキーで詳細。</small>
        </div>
      )}
      {detail && stats && (
        <pre className="network-panel" aria-label="ネットワーク詳細">{JSON.stringify(stats, null, 1)}</pre>
      )}
    </>
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
      <small>{bindingLabel('quest')}: クエスト / {bindingLabel('help')}: 操作説明</small>
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

function HelpRow({ action, children }) {
  return <tr><th scope="row"><kbd>{bindingLabel(action)}</kbd></th><td>{children}</td></tr>
}

function HelpTab({ tab, hud }) {
  const content = {
    基本: <>
      <p className="help-lead">左手はWASD周辺、右手はトラックパッドでカメラを操作します。</p>
      <table className="keymap"><tbody>
        <HelpRow action="moveForward">WASD　移動</HelpRow>
        <tr><th>トラックパッド</th><td>カメラを動かす（画面クリック後はポインターロック）</td></tr>
        <tr><th>2本指スクロール</th><td>カメラ距離</td></tr>
        <HelpRow action="sprint">ダッシュ</HelpRow><HelpRow action="dodge">回避ローリング</HelpRow><HelpRow action="interact">話す・調べる</HelpRow>
      </tbody></table>
    </>,
    戦闘: <table className="keymap"><tbody>
      <HelpRow action="meleeAttack">近接攻撃</HelpRow><HelpRow action="guard">盾を構える</HelpRow><HelpRow action="heal">回復</HelpRow>
      <HelpRow action="ability1">〜 <kbd>{bindingLabel('ability4')}</kbd>　技を選択</HelpRow><HelpRow action="useAbility">選択中の技を使う</HelpRow>
    </tbody></table>,
    技: <table className="keymap"><tbody>{ABILITY_SLOTS.map((id, index) => {
      const ability = PLAYER_ATTACKS[id]; const unlocked = hud.skills.includes(id)
      return <tr key={id}><th><kbd>{bindingLabel(`ability${index + 1}`)}</kbd></th><td>{unlocked ? <>{ability.label} を選択 → <kbd>{bindingLabel('useAbility')}</kbd>で発動</> : <>🔒 Lv.{ability.unlockLevel}で新しい技を解放</>}</td></tr>
    })}</tbody></table>,
    ウェブ: <><p className="help-lead">建物を狙って <kbd>{bindingLabel('webSwing')}</kbd> を<strong>長押し</strong>します。接続点へ引っ張られ、離すと落下します。</p><table className="keymap"><tbody>
      <HelpRow action="webSwing">長押しで接続・牽引／離すと落下</HelpRow>
    </tbody></table></>,
    メニュー: <table className="keymap"><tbody>
      <HelpRow action="map">マップ</HelpRow><HelpRow action="quest">クエスト</HelpRow><HelpRow action="help">操作説明</HelpRow><HelpRow action="pause">ポーズ・画面を閉じる</HelpRow>
    </tbody></table>,
  }
  return <section className="help-content">{content[tab]}</section>
}

function HelpOverlay({ hud, onClose }) {
  const [tab, setTab] = useState('基本')
  const [rebinding, setRebinding] = useState(null)
  const [duplicateWarning, setDuplicateWarning] = useState('')
  const set = (key, value) => { sim.settings[key] = value; publishHud() }
  const saveBindings = () => { sim.settings.bindings = bindingsSnapshot(); publishHud() }
  useEffect(() => {
    if (!rebinding) return undefined
    const capture = (event) => {
      event.preventDefault(); event.stopImmediatePropagation()
      if (event.code === 'Escape') { setRebinding(null); return }
      const conflicts = bindingConflicts(rebinding, [event.code])
      if (setBinding(rebinding, [event.code])) {
        saveBindings()
        setDuplicateWarning(conflicts.length ? `「${conflicts.map((a) => a.label).join('・')}」と同じキーです。必要なら片方を変更してください。` : '')
        setRebinding(null)
      }
    }
    window.addEventListener('keydown', capture, true)
    return () => window.removeEventListener('keydown', capture, true)
  }, [rebinding])
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
        <header><b>操作説明：MacBook<br /><small>キーボード＋トラックパッド</small></b><button onClick={onClose} aria-label="閉じる">✕</button></header>
        <nav className="help-tabs" aria-label="操作説明の分類">
          {['基本', '戦闘', '技', 'ウェブ', 'メニュー', 'キー設定'].map((name) => <button key={name} className={tab === name ? 'active' : ''} onClick={() => setTab(name)}>{name}</button>)}
        </nav>
        {tab !== 'キー設定' && <HelpTab tab={tab} hud={hud} />}
        {tab === 'キー設定' && <>
          <h4>キー設定</h4>
          <p className="binding-note">{rebinding ? <b>「{ACTION_META.find((a) => a.id === rebinding)?.label}」に割り当てるキーを押してください（Escで中止）</b> : 'キーを選んで「変更」を押すと、次に押した物理キーへ割り当てます。'}</p>
          <div className="binding-list">
            {ACTION_META.map((action) => <div key={action.id}><span>{action.label}</span><kbd>{bindingLabel(action.id)}</kbd><button onClick={() => setRebinding(action.id)}>変更</button></div>)}
          </div>
          {duplicateWarning && <p className="binding-warning" role="alert">⚠ {duplicateWarning}</p>}
          <button className="reset-bindings" onClick={() => { resetBindings(); saveBindings() }}>標準のキー配置に戻す</button>
          <h4>長押しの代替操作</h4>
          <div className="toggles action-modes">
            <label>盾 <select value={hud.settings.guardMode || 'hold'} onChange={(e) => set('guardMode', e.target.value)}><option value="hold">長押し</option><option value="toggle">切り替え</option></select></label>
            <label>ダッシュ <select value={hud.settings.sprintMode || 'hold'} onChange={(e) => set('sprintMode', e.target.value)}><option value="hold">長押し</option><option value="toggle">切り替え</option></select></label>
          </div>
        </>}
        <h4>表示とアクセシビリティ</h4>
        <div className="toggles">
          <label><input type="checkbox" checked={hud.settings.largeText} onChange={(e) => set('largeText', e.target.checked)} /> 文字を大きく</label>
          <label><input type="checkbox" checked={hud.settings.highContrast} onChange={(e) => set('highContrast', e.target.checked)} /> 高コントラスト</label>
          <label><input type="checkbox" checked={hud.settings.reducedMotion} onChange={(e) => set('reducedMotion', e.target.checked)} /> 画面の揺れ・星を減らす</label>
          <label><input type="checkbox" checked={hud.settings.invertY} onChange={(e) => set('invertY', e.target.checked)} /> カメラ上下反転</label>
          <label><input type="checkbox" checked={hud.settings.reducedFlash} onChange={(e) => set('reducedFlash', e.target.checked)} /> 光の点滅を減らす</label>
          <label><input type="checkbox" checked={hud.settings.muteSfx} onChange={(e) => set('muteSfx', e.target.checked)} /> 音を消す（BGMも含む）</label>
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
          <label>
            ボス戦BGMの音量 <b>{Math.round((hud.settings.musicVolume ?? 0.55) * 100)}%</b>
            <input type="range" min="0" max="1" step="0.05" value={hud.settings.musicVolume ?? 0.55}
              onChange={(e) => { set('musicVolume', Number(e.target.value)); refreshMusicVolume() }} />
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
          <button onClick={() => saveGame()}>今すぐセーブ</button>
          {import.meta.env.DEV && <button onClick={resetMapAndBosses}>開発用：マップ・ボスを初期化</button>}
          <button onClick={() => { if (confirm('セーブを削除して最初からやり直しますか？')) { deleteSave(); location.reload() } }}>セーブを削除</button>
          <small>進行は25秒ごとに自動セーブされます。必要なときだけここから手動保存できます。</small>
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
