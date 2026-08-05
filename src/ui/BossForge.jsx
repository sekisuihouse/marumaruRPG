import React, { useEffect, useState } from 'react'
import { BOSS_LIST } from '../data/bosses.js'
import { sim, publishHud } from '../engine/sim.js'
import {
  debugForceBossAttack, debugSetBossAi, debugSetBossPhase, debugSpawnBoss,
  debugPlayBossPose, debugStopBossPose, FORGE_POSES,
} from '../engine/bosses.js'
import { MOTION_GAIN } from '../gfx/BossModel.jsx'

const STORE = 'marugoto-boss-forge-v1'
const issues = ['動きが小さい', '速すぎる', '不自然', '判定が早い', '判定が広すぎる', '予告が弱い', '後隙が短い', '壁に埋まる', '建物破壊が強すぎる']
const fixes = ['角度を増やす', '速度を下げる', '開始を遅らせる', '判定を縮小', '予告動作を追加', '後隙を追加', '建物ダメージを変更', '小物の位置を修正']

const clone = (value) => JSON.parse(JSON.stringify(value))
const selectedBoss = (id) => (sim.bosses || []).find((b) => b.def.id === id)

export function BossForge({ onExit, onStartCombat }) {
  const forge = sim.bossForge
  const [tick, setTick] = useState(0)
  const [draft, setDraft] = useState(() => clone(forge.draft))
  const [issue, setIssue] = useState(issues[0])
  const [fix, setFix] = useState(fixes[0])
  const [note, setNote] = useState('')
  const [bone, setBone] = useState('')
  const [prompt, setPrompt] = useState('')
  const [combat, setCombat] = useState(false)
  const boss = selectedBoss(forge.bossId)
  const action = draft?.abilities?.find((a) => a.id === forge.actionId) || draft?.abilities?.[0]

  useEffect(() => {
    const timer = setInterval(() => {
      // ループ再生: 選択中の攻撃が終わったら少し置いて撃ち直す
      const live = selectedBoss(forge.bossId)
      if (forge.loop && live?.alive && !live.attack && !forge.combat) {
        if (!forge.loopAt || sim.time - forge.loopAt > 0.45) {
          forge.loopAt = sim.time
          debugForceBossAttack(forge.bossId, forge.actionId)
        }
      }
      setTick((v) => v + 1)
    }, 125)
    return () => clearInterval(timer)
  }, [forge])
  useEffect(() => {
    const onKey = (event) => {
      if (event.code === 'F2') addAnnotation('不具合', '中程度')
      if (event.code === 'F3') addAnnotation('AI', '中程度', '予告が分かりにくい')
      if (event.code === 'F4') addAnnotation('判定', '高', '攻撃判定を確認')
      if (event.code === 'F6') addAnnotation('動き', '中程度', '動きが不自然')
      if (event.code === 'F7') addAnnotation('良かった点', '低', '良かった')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  function selectBoss(id) {
    forge.bossId = id
    debugSpawnBoss(id)
    const next = selectedBoss(id)
    // 前のボスを完全に片付ける（モデル・攻撃・ポーズ・Skeleton表示・骨補正の参照）
    for (const other of sim.bosses || []) {
      if (other === next) continue
      other.alive = false; other.spawned = false; other.attack = null
      other.forgeActive = false; other.forgePose = null
      other.forgeBounds = null; other.forgeModelReady = false
      other.hitFlash = 0; other.ragdollTime = 0
    }
    next.forgeActive = true; next.debugAi = false; next.phase = 1; next.forgeBoneOverrides ||= {}
    next.forgePose = null; next.attack = null; next.hitFlash = 0
    if (!forge.originals[id]) forge.originals[id] = clone(next.def)
    forge.actionId = next.def.abilities[0].id
    // カメラはプレビュー専用カメラが担当する。モデル読込後に自動フレーミングさせる。
    forge.needsFrame = true; forge.framedFor = null; forge.view = null
    forge.draft = clone(next.def); forge.original = clone(forge.originals[id]); forge.annotations = []
    setDraft(clone(forge.draft)); setBone(next.forgeBones?.[0] || ''); setCombat(false); setTick((v) => v + 1)
  }
  function selectAction(actionId) { forge.actionId = actionId; setTick((v) => v + 1) }
  function update(key, value) {
    setDraft((prev) => ({ ...prev, abilities: prev.abilities.map((a) => a.id === action.id ? { ...a, [key]: Number(value) } : a) }))
  }
  function applyDraft() {
    const live = selectedBoss(forge.bossId)
    live.def.abilities = clone(draft.abilities)
    live.def.baseDamage = draft.baseDamage; live.def.moveSpeed = draft.moveSpeed
    forge.draft = clone(draft); publishHud(); setTick((v) => v + 1)
  }
  function resetDraft() { setDraft(clone(forge.original)); forge.draft = clone(forge.original) }
  function addAnnotation(category = '動き', severity = '中程度', text = note) {
    const b = selectedBoss(forge.bossId); if (!b) return
    forge.annotations.push({ id: `forge:${Date.now()}`, bossId: b.def.id, actionId: forge.actionId, phase: b.phase, time: sim.time, targetType: 'ボス全体', targetName: b.label, hierarchyPath: '', worldPosition: [b.pos.x, b.pos.y + 1.5, b.pos.z], localPosition: [0, 1.5, 0], note: text, category, severity })
    setNote(''); setTick((v) => v + 1)
  }
  function generate(kind = 'Codex向け') {
    const b = selectedBoss(forge.bossId)
    // 受け手のskillが機械的に読めるJSONも一緒に出す（数値の適用先を推測させない）
    const original = forge.original?.abilities?.find((a) => a.id === action?.id) || null
    const changed = {}
    for (const key of ['windup', 'recover', 'characterDamage', 'structureDamage', 'breakRadius', 'range']) {
      if (original && action && original[key] !== action[key]) changed[key] = { from: original[key], to: action[key] }
    }
    const payload = {
      source: 'BOSS FORGE', bossId: b.def.id, actionId: action?.id || null, phase: b.phase,
      modelPath: b.def.modelPath, motionGain: forge.motionGain ?? MOTION_GAIN,
      issue, fix, note: note || null,
      draft: action ? { windup: action.windup, recover: action.recover, characterDamage: action.characterDamage, structureDamage: action.structureDamage, breakRadius: action.breakRadius, range: action.range } : null,
      changed,
      annotations: forge.annotations.map((a) => ({ category: a.category, severity: a.severity, targetType: a.targetType, actionId: a.actionId, phase: a.phase, localPosition: a.localPosition.map((n) => +n.toFixed(2)), note: a.note })),
    }
    const invoke = kind.startsWith('Codex') ? 'skill: boss-forge-fix（~/.codex/skills/boss-forge-fix）' : '/boss-forge-fix'
    const text = `${kind}：${b.label}の${action?.id || 'action'}を修正してください。\n使用するskill: ${invoke}\n\n対象\n- bossId: ${b.def.id}\n- modelPath: ${b.def.modelPath}\n- phase: ${b.phase}\n- actionId: ${action?.id}\n- 現在値: windup ${action?.windup}s / recover ${action?.recover}s / damage ${action?.characterDamage}\n- 動きの大きさ(motionGain): ${forge.motionGain ?? MOTION_GAIN}（既定 ${MOTION_GAIN}）\n\n問題\n- ${issue}${note ? `\n- ${note}` : ''}\n\n修正\n- ${fix}\n\n3Dポインター\n${forge.annotations.map((a, i) => `${i + 1}. ${a.targetType} @ ${a.worldPosition.map((n) => n.toFixed(2)).join(', ')} ${a.note}`).join('\n') || '- なし'}\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n\n変更してはいけない箇所\n- 他ボス・本番セーブ・P2Pプロトコル\n\n完了条件\n- 攻撃予告、判定、後隙が一致する\n- npm run build と npm test が成功する`
    setPrompt(text)
  }
  function saveDraft() {
    localStorage.setItem(STORE, JSON.stringify({ draft, annotations: forge.annotations, bossId: forge.bossId, at: Date.now() }))
  }
  function loadDraft() {
    try { const saved = JSON.parse(localStorage.getItem(STORE) || 'null'); if (saved?.draft) { setDraft(saved.draft); forge.draft = saved.draft; forge.annotations = saved.annotations || [] } } catch { /* 開発用データが壊れていてもゲームへ影響させない */ }
  }
  function startCombat() { debugSetBossAi(forge.bossId, true); forge.combat = true; setCombat(true); onStartCombat?.() }
  function endCombat() { debugSetBossAi(forge.bossId, false); forge.combat = false; document.exitPointerLock?.(); setCombat(false) }
  function force() { debugForceBossAttack(forge.bossId, forge.actionId); setTick((v) => v + 1) }
  function setBoneAxis(axis, value) {
    if (!boss || !bone) return
    boss.forgeBoneOverrides ||= {}
    boss.forgeBoneOverrides[bone] = { ...(boss.forgeBoneOverrides[bone] || { x: 0, y: 0, z: 0 }), [axis]: Number(value) }
    setTick((v) => v + 1)
  }
  const boneOverride = boss?.forgeBoneOverrides?.[bone] || { x: 0, y: 0, z: 0 }
  const timeline = action ? [['予備動作', 0, action.windup], ['攻撃判定', action.windup, action.windup + 0.18], ['後隙', action.windup + 0.18, action.windup + action.recover]] : []
  // 表示は推測値ではなく、実際の attack.phase / timer をそのまま出す
  const live = (() => {
    if (boss?.forgePose) return { label: `${FORGE_POSES.find((p) => p.id === boss.forgePose.id)?.label || boss.forgePose.id}`, phaseLabel: '' }
    const a = boss?.attack
    if (!a) return { label: '待機', phaseLabel: '' }
    const phaseLabel = a.phase === 'windup' ? '予備動作' : a.phase === 'charge' ? '攻撃判定' : '後隙'
    return { label: `${a.def.label || a.def.id}／${phaseLabel} 残り${Math.max(0, a.timer).toFixed(2)}s`, phaseLabel }
  })()

  return <section className={`boss-forge ${combat ? 'combat' : ''}`} data-tick={tick}>
    <header className="forge-title"><b>BOSS FORGE</b><span>開発環境限定・本番セーブとは分離</span><button onClick={onExit}>通常ゲームへ戻る</button></header>
    <aside className="forge-panel forge-left"><h3>ボス</h3>{BOSS_LIST.map((d) => <button key={d.id} data-boss-id={d.id} className={forge.bossId === d.id ? 'active' : ''} onClick={() => selectBoss(d.id)}>{d.name}</button>)}
      <hr /><b>ID</b><small>{boss?.def.id}</small><b>モデル</b><small>{boss?.def.modelPath}</small><b>状態</b><small>{boss?.state} / {boss?.attack?.def?.id || 'idle'}</small>
      <label>PHASE <select value={boss?.phase || 1} onChange={(e) => { debugSetBossPhase(forge.bossId, e.target.value); setTick((v) => v + 1) }}><option>1</option><option>2</option></select></label>
      <label>HP <input type="range" min="1" max={boss?.maxHp || 1} value={boss?.hp || 1} onChange={(e) => { boss.hp = Number(e.target.value); setTick((v) => v + 1) }} /></label>
      <label><input type="checkbox" checked={forge.showHitboxes} onChange={(e) => { forge.showHitboxes = e.target.checked; setTick((v) => v + 1) }} /> 判定表示</label>
      <label><input type="checkbox" checked={forge.showWeakpoint} onChange={(e) => { forge.showWeakpoint = e.target.checked; setTick((v) => v + 1) }} /> 弱点表示</label>
      <label><input type="checkbox" checked={forge.showGround} onChange={(e) => { forge.showGround = e.target.checked; setTick((v) => v + 1) }} /> 接地グリッド</label>
      <label><input type="checkbox" checked={forge.showBones} onChange={(e) => { forge.showBones = e.target.checked; setTick((v) => v + 1) }} /> Skeleton表示</label>
      <p>ボーン {boss?.forgeBones?.length || 0}本</p><select size="5" value={bone} onChange={(e) => setBone(e.target.value)}>{(boss?.forgeBones || []).map((name) => <option key={name}>{name}</option>)}</select>
      {bone && <div className="forge-bone"><b>{bone}</b>{['x', 'y', 'z'].map((axis) => <label key={axis}>回転{axis.toUpperCase()} {boneOverride[axis]}°<input type="range" min="-90" max="90" value={boneOverride[axis]} onChange={(e) => setBoneAxis(axis, e.target.value)} /></label>)}<button onClick={() => { boss.forgeBoneOverrides[bone] = { x: 0, y: 0, z: 0 }; setTick((v) => v + 1) }}>このボーンを戻す</button></div>}
    </aside>
    <aside className="forge-panel forge-right"><h3>Draft：{action?.label}</h3>{[['windup', '予備動作'], ['recover', '後隙'], ['characterDamage', 'ダメージ'], ['structureDamage', '建物ダメージ'], ['breakRadius', '破壊半径'], ['range', '移動・射程']].map(([key, label]) => <label key={key}>{label}<input type="number" step="0.05" value={action?.[key] ?? 0} onChange={(e) => update(key, e.target.value)} /></label>)}
      <button onClick={applyDraft}>Draftを適用</button><button onClick={resetDraft}>初期値へ戻す</button>
      <hr /><h3>動きの大きさ</h3>
      <label>全身モーション倍率 {(forge.motionGain ?? MOTION_GAIN).toFixed(1)}x
        <input type="range" min="0" max="10" step="0.5" value={forge.motionGain ?? MOTION_GAIN}
          onChange={(e) => { forge.motionGain = Number(e.target.value); setTick((v) => v + 1) }} /></label>
      <button onClick={() => { forge.motionGain = MOTION_GAIN; setTick((v) => v + 1) }}>既定({MOTION_GAIN}x)へ戻す</button>
      <hr /><h3>修正指示</h3><select value={issue} onChange={(e) => setIssue(e.target.value)}>{issues.map((x) => <option key={x}>{x}</option>)}</select><select value={fix} onChange={(e) => setFix(e.target.value)}>{fixes.map((x) => <option key={x}>{x}</option>)}</select><textarea value={note} placeholder="自由記述" onChange={(e) => setNote(e.target.value)} /><button onClick={() => addAnnotation()}>現在位置に注釈</button>
      <button onClick={() => generate('Codex向け')}>Codexプロンプト</button><button onClick={() => generate('Claude Code向け')}>Claudeプロンプト</button>
      <button onClick={saveDraft}>JSON保存</button><button onClick={loadDraft}>JSON読込</button>
    </aside>
    <footer className="forge-bottom"><div className="forge-actions"><b>動作・攻撃</b>{boss?.def.abilities.map((a) => <button key={a.id} data-action-id={a.id} className={forge.actionId === a.id ? 'active' : ''} onClick={() => selectAction(a.id)}>{a.label}</button>)}</div>
      <div className="forge-actions"><b>単体モーション</b>{FORGE_POSES.map((p) => <button key={p.id} data-pose-id={p.id} className={boss?.forgePose?.id === p.id ? 'active' : ''} onClick={() => { debugPlayBossPose(forge.bossId, p.id); setTick((v) => v + 1) }}>{p.label}</button>)}</div>
      <div className="forge-controls">
        <button data-forge="play" onClick={force}>指定攻撃を再生</button>
        <button data-forge="loop" className={forge.loop ? 'active' : ''} onClick={() => { forge.loop = !forge.loop; forge.loopAt = 0; setTick((v) => v + 1) }}>ループ</button>
        <button data-forge="pause" className={forge.timeScale === 0 ? 'active' : ''} onClick={() => { forge.timeScale = forge.timeScale === 0 ? 1 : 0; setTick((v) => v + 1) }}>{forge.timeScale === 0 ? '再開' : '一時停止'}</button>
        <button data-forge="stop" onClick={() => { forge.loop = false; debugStopBossPose(forge.bossId); forge.timeScale = 1; setTick((v) => v + 1) }}>停止</button>
        <button data-forge="step" onClick={() => { forge.timeScale = 0; forge.stepOnce = true; setTick((v) => v + 1) }}>1フレーム進む</button>
        {[0.1, 0.25, 0.5, 1, 2].map((n) => <button key={n} className={forge.timeScale === n ? 'active' : ''} onClick={() => { forge.timeScale = n; setTick((v) => v + 1) }}>{n}x</button>)}
        <button data-forge="reset-view" onClick={() => { forge.needsFrame = true; window.dispatchEvent(new Event('marugoto:forge-reset-view')); setTick((v) => v + 1) }}>視点リセット</button>
        <button onClick={combat ? endCombat : startCombat}>{combat ? '編集へ戻る' : '実戦開始'}</button>
        <button onClick={() => { boss.hp = 1; setTick((v) => v + 1) }}>HP 1</button>
        <button onClick={() => { boss.hp = boss.maxHp; setTick((v) => v + 1) }}>全回復</button>
      </div>
      <div className="forge-timeline">
        {timeline.map(([name, from, to]) => <span key={name} className={live.phaseLabel === name ? 'now' : ''}><b>{name}</b> {Number(from).toFixed(2)}〜{Number(to).toFixed(2)}s</span>)}
        <span className="forge-live"><b>再生中</b> {live.label}</span>
      </div>
      <div className="forge-annotations"><b>注釈 {forge.annotations.length}</b>{forge.annotations.map((a, i) => <button key={a.id} onClick={() => { forge.actionId = a.actionId || forge.actionId; setTick((v) => v + 1) }}>#{i + 1} {a.category} {a.note || a.targetType}</button>)}</div>
      {prompt && <><textarea className="forge-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} /><button onClick={() => navigator.clipboard?.writeText(prompt)}>コピー</button></>}
    </footer>
  </section>
}
