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
const { applyFinalBossSave, damageFinalBossAt, finalBoss, initFinalBoss, mountPlayer, recoverFinalBossFall, resetFinalBoss, serializeFinalBoss, updateFinalBoss, updateFinalBossTransforms, updateMountedPlayer } = await import('../src/engine/finalBoss.js')
const THREE = await import('three')
const { moveAxis, touch } = await import('../src/engine/input.js')
await loadNav()
resetPlayer(true); initBosses(); initArena(); initFinalBoss()
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

hit('shinL'); updateFinalBoss(0.02)
assert.equal(boss.phase, 2, 'shin destruction opens the climb phase')
assert.equal(mountPlayer('forearmL'), true, 'player can mount a live platform')
const carriedFrom = sim.player.pos.clone()
const movedArm = boss.platforms.forearmL.matrix.clone().premultiply(new THREE.Matrix4().makeTranslation(1, 0, 0))
updateFinalBossTransforms({ 'mixamorig:LeftForeArm': movedArm })
updateMountedPlayer(1 / 60, { x: 0, z: 0, len: 0 })
assert.ok(sim.player.pos.distanceTo(carriedFrom) > 0.5, 'standing player follows a moving body platform')
hit('conduitShrine')
sim.player.invuln = 0; sim.player.hp = sim.player.maxHp; sim.player.pos.copy(boss.parts.conduitShrine.world)
const beforeBacklash = sim.player.hp
updateFinalBoss(1.1)
assert.ok(sim.player.hp < beforeBacklash, 'conduit backlash deals damage if its safe radius is not escaped')
hit('conduitStudent'); hit('crown'); boss.nextAttackAt = sim.time; updateFinalBoss(0.02)
assert.equal(boss.phase, 3, 'crown destruction opens the blind phase')
assert.equal(boss.attack?.def?.id, 'blindCharge', 'blind phase changes to its own charge attack')
boss.attack = null
for (const id of ['conduitFood', 'conduitStage']) hit(id)
updateFinalBoss(0.02)
assert.equal(boss.phase, 4, 'all conduits expose the core')
hit('core')
assert.equal(boss.state, 'death', 'core destruction starts the death descent')

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
assert.equal(recoverFinalBossFall(), true, 'fall recovery returns the player to a safe body platform')
console.log('✅ final boss lifecycle, parts, climb, save, and ending passed')
