import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

globalThis.localStorage ||= { getItem: () => null, setItem: () => {}, removeItem: () => {} }
globalThis.fetch = async (url) => {
  const file = path.join('public', String(url).replace(/^\//, ''))
  return fs.existsSync(file) ? { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(file, 'utf8')) } : { ok: false, status: 404 }
}
const manifest = JSON.parse(fs.readFileSync('public/assets/final-boss/manifest.json', 'utf8'))
assert.equal(manifest.clips.idle.source, 'Walking.fbx', 'idle uses a grounded movement clip instead of the T-pose')
assert.ok(manifest.clips.idle.duration > 1, 'idle is a meaningful loop')
const { loadNav } = await import('../src/engine/nav.js')
const { sim, resetPlayer } = await import('../src/engine/sim.js')
const { initArena, isArenaLocked } = await import('../src/engine/arena.js')
const { initBosses } = await import('../src/engine/bosses.js')
const {
  applyFinalBossSave, damageFinalBossAt, finalBodyIntact, finalBodySupport, finalBoss, finalBossFooting,
  initFinalBoss, mountPlayer, recoverFinalBossFall, registerFinalBossChunks, resetFinalBoss,
  serializeFinalBoss, setFinalBossChunkSink, updateFinalBoss, updateFinalBossTransforms, updateMountedPlayer,
} = await import('../src/engine/finalBoss.js')
const { initDebris } = await import('../src/engine/debris.js')
const { initJuice } = await import('../src/engine/juice.js')
const { boneKey, FINAL_BODY_DEFS } = await import('../src/data/finalBoss.js')
// GLTFLoader は 'mixamorig:Hips' から ':' を落とす。書き出し名でも引けることを保証する。
assert.equal(boneKey('mixamorig:Hips'), boneKey('mixamorigHips'), 'bone lookup tolerates the loader renaming joints')
const THREE = await import('three')
const { moveAxis, touch } = await import('../src/engine/input.js')

// 骨のワールド行列を模した姿勢。実機では GLB のスケールで巨大になるので、
// 判定側がその実寸をきちんと拾えるかをここで再現する。
const BONE_AT = {}
for (const def of FINAL_BODY_DEFS) { BONE_AT[def.a] ||= def.from; BONE_AT[def.b] ||= def.to }
// 実機と同じく ':' を落とした名前で渡し、照合が名前差を吸収することも同時に見る。
const poseBones = (origin, height) => Object.fromEntries(Object.entries(BONE_AT).map(([bone, at]) => [
  boneKey(bone.replace(':', '')),
  new THREE.Matrix4().makeTranslation(origin.x + at[0] * height, origin.y + at[1] * height, origin.z + at[2] * height),
]))
await loadNav()
resetPlayer(true); initBosses(); initArena(); initFinalBoss(); initDebris(); initJuice()
for (const boss of sim.bosses) { boss.spawned = true; boss.alive = false; boss.defeated = true }
sim.bossProgress.defeatedBossCount = 4
sim.player.items = { prototype_core: 1, stage_pass: 1, boundary_seal: 1, chef_medal: 1 }
touch.move.x = 0.6; touch.move.y = -0.4
assert.deepEqual(moveAxis(), { x: 0.6, y: -0.4 }, 'mobile joystick feeds the shared movement axis')
touch.move.x = 0; touch.move.y = 0

updateFinalBoss(6.1)
const boss = finalBoss()
assert.equal(boss.alive, true, 'four clears spawn the final boss')
assert.equal(boss.phase, 1)
assert.equal(isArenaLocked(), false, 'final boss does not create an AT field or block bridges')
assert.equal(sim.objectiveBanner?.text?.includes('ひざ'), true, 'phase 1 announces its objective on screen')
const yawBefore = boss.yaw
sim.player.pos.set(boss.pos.x + 30, boss.pos.y, boss.pos.z + 20)
updateFinalBoss(0.5)
assert.notEqual(boss.yaw, yawBefore, 'ground phase turns and walks toward the player')

const attacker = { attack: 200 }
const attack = { power: 1200, range: 0.2, kind: 'melee' }
const hit = (id) => {
  const part = boss.parts[id]
  const result = damageFinalBossAt(part.world, attacker, attack)
  assert.equal(result?.partId, id, `${id} receives routed damage`)
  assert.equal(part.broken, true, `${id} breaks`)
}

// ── 判定の寸法は「実際に描画されている全高」から取り直される
updateFinalBossTransforms(poseBones(boss.pos, 12))
assert.ok(boss.visualHeight > 10, `collision scale follows the rendered giant (got ${boss.visualHeight})`)
assert.ok(boss.parts.shinL.radius > 0.8, 'weak point hit volumes grow with the boss')
assert.equal(boss.body.every((s) => s.ready), true, 'every body capsule tracks a real bone')
assert.ok(Math.abs(boss.parts.crown.world.y - (boss.pos.y + 0.88 * 12)) < 0.01, 'weak points sit on their bone, not on a guessed offset')

// ── 身体そのものが当たり判定になっているか
const chest = boss.bodyById.chest
const chestMid = chest.p0.clone().lerp(chest.p1, 0.5)
const support = finalBodySupport(chestMid.x, chestMid.z, chestMid.y + chest.radius + 0.01)
assert.equal(support?.seg?.id, 'chest', 'the boss body itself provides a standing surface')
assert.ok(support.y > chestMid.y, 'the surface sits on top of the body capsule')

hit('shinL'); updateFinalBoss(0.02)
assert.equal(boss.phase, 2, 'shin destruction opens the climb phase')
assert.equal(mountPlayer('foreArmL'), true, 'player can stand on a live piece of the body')
assert.equal(sim.player.finalBossPlatform, 'foreArmL')
const carriedFrom = sim.player.pos.clone()
const arm = boss.bodyById.foreArmL
updateFinalBossTransforms({
  [boneKey('mixamorig:LeftForeArm')]: new THREE.Matrix4().makeTranslation(arm.p0.x + 1, arm.p0.y, arm.p0.z),
  [boneKey('mixamorig:LeftHand')]: new THREE.Matrix4().makeTranslation(arm.p1.x + 1, arm.p1.y, arm.p1.z),
})
updateMountedPlayer(1 / 60, { x: 0, z: 0, len: 0 })
assert.ok(sim.player.pos.distanceTo(carriedFrom) > 0.5, 'standing player is carried by the moving body')

// ── 身体は建物と同じように壊せて、フェーズに応じた時間で戻る
const thigh = boss.bodyById.thighR
const thighMid = thigh.p0.clone().lerp(thigh.p1, 0.5)
const bodyHit = damageFinalBossAt(thighMid, attacker, { power: 9999, range: 0.2, kind: 'melee' })
assert.equal(bodyHit?.body, true, 'attacks that miss a weak point damage the body itself')
assert.equal(thigh.broken, true, 'the body breaks like a building')
assert.equal(finalBodySupport(thighMid.x, thighMid.z, thighMid.y + thigh.radius + 1)?.seg?.id !== 'thighR', true, 'a broken piece stops carrying the player')
const phase2Delay = thigh.restoreAt - sim.time
assert.ok(phase2Delay > 7 && phase2Delay < 8, `phase 2 heals in about 7.5s (got ${phase2Delay})`)
sim.time += phase2Delay + 0.1
updateFinalBoss(0.02)
assert.equal(thigh.broken, false, 'broken body pieces grow back')
// 時間を進めた副作用の攻撃は、以降の検証に影響しないよう畳んでおく
boss.attack = null; boss.nextAttackAt = sim.time + 999
mountPlayer('chest')

hit('conduitShrine')
sim.player.invuln = 0; sim.player.hp = sim.player.maxHp; sim.player.pos.copy(boss.parts.conduitShrine.world)
const beforeBacklash = sim.player.hp
updateFinalBoss(1.1)
assert.ok(sim.player.hp < beforeBacklash, 'conduit backlash deals damage if its safe radius is not escaped')
hit('conduitStudent'); hit('crown'); boss.nextAttackAt = sim.time; updateFinalBoss(0.02)
assert.equal(boss.phase, 3, 'crown destruction opens the blind phase')
assert.equal(boss.attack?.def?.id, 'blindCharge', 'blind phase changes to its own charge attack')
boss.attack = null

// 再生はフェーズが進むほど遅くなる
const foot = boss.bodyById.footR
const footMid = foot.p0.clone().lerp(foot.p1, 0.5)
damageFinalBossAt(footMid, attacker, { power: 9999, range: 0.2, kind: 'melee' })
assert.equal(foot.broken, true, 'the body can be attacked from the ground too')
const phase3Delay = foot.restoreAt - sim.time
assert.ok(phase3Delay > phase2Delay + 2, `phase 3 heals slower than phase 2 (${phase3Delay} vs ${phase2Delay})`)

for (const id of ['conduitFood', 'conduitStage']) hit(id)
updateFinalBoss(0.02)
assert.equal(boss.phase, 4, 'all conduits expose the core')

// ── ここから先は「建物と同じ小片」の経路。描画側が身体を分割した状態を再現する。
const maskEvents = []
setFinalBossChunkSink({ setBroken: (id, broken) => maskEvents.push({ id, broken }), reset: () => maskEvents.push({ reset: true }) })
const synthetic = []
for (const seg of boss.body) for (let k = 0; k < 6; k++) synthetic.push({ id: synthetic.length, boneName: seg.aId, radius: 0.7 })
registerFinalBossChunks(synthetic)
boss.chunks.forEach((c, i) => c.world.copy(boss.body[Math.floor(i / 6)].p0).lerp(boss.body[Math.floor(i / 6)].p1, (i % 6) / 5))
assert.equal(finalBodyIntact().total, synthetic.length, 'the body is now counted in building-sized pieces')

const footPieces = boss.chunks.filter((c) => c.segId === 'footR')
assert.ok(footPieces.length > 0, 'pieces are linked to the body part they belong to')
const spawnedBefore = sim.debrisStats.spawnedThisFrame
const pieceHit = damageFinalBossAt(footPieces[0].world, attacker, { power: 9999, range: 0.4, kind: 'melee' })
assert.equal(pieceHit?.body, true, 'body hits are routed to the pieces')
assert.equal(footPieces[0].broken, true, 'a piece of the body breaks like a building part')
assert.ok(sim.debrisStats.spawnedThisFrame > spawnedBefore, 'breaking the body throws real debris')
assert.ok(maskEvents.some((e) => e.id === footPieces[0].id && e.broken), 'the broken piece stops being drawn')
// 穴だらけになった部位は足場としても抜ける
for (const piece of footPieces) damageFinalBossAt(piece.world, attacker, { power: 9999, range: 0.4, kind: 'melee' })
assert.equal(boss.bodyById.footR.broken, true, 'a part riddled with holes stops holding the player')
// フェーズが進むほど塞がるのが遅い（PHASE4 は14秒）
const pieceDelay = footPieces[0].restoreAt - sim.time
assert.ok(pieceDelay > 13 && pieceDelay < 15, `phase 4 pieces heal in about 14s (got ${pieceDelay})`)
sim.time += pieceDelay + 0.1
updateFinalBoss(0.02)
assert.equal(footPieces[0].broken, false, 'pieces grow back while the altar still stands')
assert.equal(boss.bodyById.footR.broken, false, 'and the footing comes back with them')
boss.attack = null; boss.nextAttackAt = sim.time + 999

// ── 祭壇を壊すと再生が止まり、身体を削り切ると死ぬ
hit('core')
assert.equal(boss.phase, 5, 'core destruction moves to the collapse phase')
assert.equal(boss.regen, false, 'the body stops regenerating once the altar is gone')
assert.equal(boss.state, 'collapse', 'the boss is still standing right after the altar breaks')
for (const id of Object.keys(boss.parts)) if (!boss.parts[id].broken) hit(id)
const hpAtCollapse = boss.hp
for (let guard = 0; guard < 500 && boss.state !== 'death'; guard++) {
  const chunk = boss.chunks.find((c) => !c.broken)
  if (!chunk) break
  damageFinalBossAt(chunk.world, attacker, { power: 9999, range: 0.4, kind: 'melee' })
}
assert.equal(boss.state, 'death', 'stripping the body away finishes the boss')
assert.ok(finalBodyIntact().intact <= synthetic.length * 0.08, 'almost nothing of the body is left')
assert.ok(boss.hp < hpAtCollapse, 'the health bar drains as the body is carved off')
assert.equal(boss.hp, 0, 'and empties when the body is gone')

const save = serializeFinalBoss()
initArena(); initFinalBoss(); applyFinalBossSave(save)
assert.equal(finalBoss().state, 'death', 'death phase can be restored safely')
sim.player.dead = true
updateFinalBoss(12.1)
assert.equal(finalBoss().defeated, true, 'death animation completes the final battle')
sim.player.dead = false

resetFinalBoss(); updateFinalBoss(6.1)
assert.equal(finalBoss().alive, true, 'reset allows a clean consecutive rematch')
finalBoss().phase = 3; finalBoss().state = 'blind'; sim.player.finalBossPlatform = null; sim.player.airborne = true
sim.player.pos.set(finalBoss().pos.x, finalBoss().pos.y - 4, finalBoss().pos.z)
assert.equal(recoverFinalBossFall(), true, 'fall recovery returns the player onto the body')
assert.equal(finalBossFooting(), true, 'the player counts as standing on the boss afterwards')
console.log('✅ final boss body collision, destruction, regen pacing, collapse ending, and save passed')
