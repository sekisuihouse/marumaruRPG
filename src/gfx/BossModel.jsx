/**
 * ボスのPMX由来モデル描画。
 *
 * ボスGLBは元PMXのskin/bind poseを保持する。配布物にはVMD/AnimationClipが
 * 無いため、各インスタンスで基準Quaternionから手続き姿勢を作る。これにより
 * T/Aポーズのまま移動することはなく、AI状態と攻撃の見た目も同期する。
 */
import React, { useEffect, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { sim } from '../engine/sim.js'

const loader = new GLTFLoader()
const cache = new Map()
const pending = new Map()
const AXIS_X = new THREE.Vector3(1, 0, 0)
const AXIS_Y = new THREE.Vector3(0, 1, 0)
const AXIS_Z = new THREE.Vector3(0, 0, 1)
const tmpQ = new THREE.Quaternion()
const tmpQ2 = new THREE.Quaternion()
const tmpV = new THREE.Vector3()
const tmpV2 = new THREE.Vector3()
const tmpColor = new THREE.Color()

const BONE_ALIASES = {
  hips: ['腰', 'センター', 'Hips', 'mixamorigHips', 'pelvis', 'root'],
  spine: ['上半身', 'Spine', 'mixamorigSpine'],
  chest: ['上半身2', 'Chest', 'mixamorigSpine1'],
  head: ['頭', 'Head', 'mixamorigHead'],
  leftArm: ['左腕', 'LeftArm', 'upperarm_l', 'mixamorigLeftArm'],
  rightArm: ['右腕', 'RightArm', 'upperarm_r', 'mixamorigRightArm'],
  leftForeArm: ['左ひじ', 'LeftForeArm', 'lowerarm_l', 'mixamorigLeftForeArm'],
  rightForeArm: ['右ひじ', 'RightForeArm', 'lowerarm_r', 'mixamorigRightForeArm'],
  leftLeg: ['左足', 'LeftUpLeg', 'thigh_l', 'mixamorigLeftUpLeg'],
  rightLeg: ['右足', 'RightUpLeg', 'thigh_r', 'mixamorigRightUpLeg'],
  leftKnee: ['左ひざ', 'LeftLeg', 'calf_l', 'mixamorigLeftLeg'],
  rightKnee: ['右ひざ', 'RightLeg', 'calf_r', 'mixamorigRightLeg'],
  leftFoot: ['左足首', 'LeftFoot', 'foot_l', 'mixamorigLeftFoot'],
  rightFoot: ['右足首', 'RightFoot', 'foot_r', 'mixamorigRightFoot'],
}

// モデルごとの初期姿勢。全モデルは同じMMD骨格だが、重さの印象だけ変える。
const POSE = {
  student: { shoulderDown: 0.7, elbowBend: 0.26, kneeBend: 0.12, torsoLean: 0.09, legSpread: 0.04 },
  stage: { shoulderDown: 0.63, elbowBend: 0.2, kneeBend: 0.1, torsoLean: 0.04, legSpread: 0.03 },
  shrine: { shoulderDown: 0.58, elbowBend: 0.3, kneeBend: 0.16, torsoLean: 0.12, legSpread: 0.05 },
  food: { shoulderDown: 0.68, elbowBend: 0.28, kneeBend: 0.14, torsoLean: 0.08, legSpread: 0.05 },
}

function loadBossModel(url) {
  if (cache.has(url)) return Promise.resolve(cache.get(url))
  if (pending.has(url)) return pending.get(url)
  const p = new Promise((resolve, reject) => loader.load(url, (gltf) => {
    cache.set(url, gltf); pending.delete(url); resolve(gltf)
  }, undefined, (err) => { pending.delete(url); reject(err) }))
  pending.set(url, p)
  return p
}

/**
 * 手続きアニメーションの振り幅。
 *
 * applyProcedural の中の角度(rad)・骨の移動量(身長比)は、すべて「ゲイン1相当の素の値」で書く。
 * 実際の見た目は MOTION_GAIN 倍になり、関節ごとの可動域 MOTION_LIMIT で滑らかに頭打ちする。
 * 単純な定数倍だと肘・膝・肩が胴体を突き抜けるので、tanh で飽和させている
 * （小さい動きはほぼゲイン倍、大きい動きは可動域まで）。
 * BOSS FORGE では sim.bossForge.motionGain で一時的に上書きして確認できる。
 */
export const MOTION_GAIN = 5
const MOTION_LIMIT = { hips: 0.5, spine: 0.85, chest: 0.92, head: 0.8, arm: 1.5, foreArm: 1.35, leg: 1.4, knee: 1.75 }
// 足の裏を地面から必ずこれだけ上に置く（身長比）。めり込みも接地の浮きも見えない量。
const FOOT_CLEARANCE = 0.004
const FAMILY = {}
const familyOf = (key) => (FAMILY[key] ??= key.replace(/^(left|right)/, '').replace(/^[A-Z]/, (c) => c.toLowerCase()))
const soft = (value, limit, gain) => (value ? limit * Math.tanh((value * gain) / limit) : 0)
const currentGain = () => {
  const v = Number(sim.bossForge?.motionGain)
  return Number.isFinite(v) && v >= 0 ? v : MOTION_GAIN
}

function boneFor(all, aliases) {
  for (const name of aliases) {
    const exact = all.find((b) => b.name === name)
    if (exact) return exact
  }
  const lower = aliases.map((x) => x.toLowerCase())
  return all.find((b) => lower.some((x) => b.name.toLowerCase().includes(x))) || null
}

function qAxis(axis, angle) { return new THREE.Quaternion().setFromAxisAngle(axis, angle) }

function setupRig(scene, typeId) {
  const all = []
  scene.traverse((o) => { if (o.isBone) all.push(o) })
  if (!all.length) return null
  const map = {}
  for (const [key, aliases] of Object.entries(BONE_ALIASES)) map[key] = boneFor(all, aliases)
  const rest = new Map(all.map((b) => [b, { q: b.quaternion.clone(), p: b.position.clone() }]))
  const target = new Map(all.map((b) => [b, { q: b.quaternion.clone(), p: b.position.clone() }]))
  // root: 骨ではなくモデル全体の移動・傾き。踏み込み/跳躍/のけぞりを腰から下ごと動かす。
  // contacts: 接地点（足首・つま先）。体の高さは「一番低い接地点が地面に着く」ように決まる。
  // 補助骨(D)とIK骨は実際の足と一致しないので入れない。
  const contacts = all
    .filter((b) => /^(左|右)(足首|つま先)$/.test(b.name)
      || /^(LeftFoot|RightFoot|LeftToeBase|RightToeBase|foot_[lr]|ball_[lr])$/i.test(b.name))
    .map((bone) => ({ bone, restY: 0 }))
  return {
    all, map, contacts, pose: POSE[typeId] || POSE.student,
    gain: MOTION_GAIN, rootAmp: 1, rest, target,
    root: { x: 0, y: 0, z: 0, pitch: 0, roll: 0, spin: 0, air: 0 },
    smooth: { x: 0, y: 0, z: 0 },
  }
}

/**
 * 各接地点がバインドポーズで足元からどれだけ上にあるかを測る（ワールド単位）。
 * GLBは足元が y=0 になるよう正規化してあるので、読み込み直後のこの値がそのまま基準になる。
 */
function measureContacts(rig, mesh) {
  if (!rig?.contacts.length) return
  mesh.updateMatrixWorld(true)
  const base = mesh.getWorldPosition(tmpV).y
  for (const c of rig.contacts) c.restY = Math.max(0, c.bone.getWorldPosition(tmpV2).y - base)
}

/**
 * 接地。**足がアニメーション全体の軸**。体の高さは一番低い接地点が地面へ着くように決める。
 *
 * 各接地点について「その骨の高さから見た足元の位置」を求め、その最小値を地面へ合わせる。
 * 腰から上をいくら動かしても脚の形が変わらなければ値は動かないので、上半身の動きで沈まない。
 * 膝を曲げれば足が浮く分だけ体が下がり、しゃがみになる。
 * 戻り値は符号つき（正=持ち上げ／負=下ろす）。
 */
function groundOffset(rig, groundY, clearance) {
  if (!rig.contacts.length) return 0
  let lowest = Infinity
  for (const c of rig.contacts) lowest = Math.min(lowest, c.bone.getWorldPosition(tmpV).y - c.restY)
  if (!Number.isFinite(lowest)) return 0
  return groundY + clearance - lowest
}

function resetTargets(rig) {
  for (const b of rig.all) {
    const r = rig.rest.get(b), t = rig.target.get(b)
    t.q.copy(r.q); t.p.copy(r.p)
  }
  const root = rig.root
  root.x = root.y = root.z = root.pitch = root.roll = root.spin = root.air = 0
}

/** 基準姿勢。ゲインを掛けない（掛けると肩・肘が畳まれて別の体型になる） */
function addBase(rig, key, axis, angle) {
  const b = rig.map[key]
  if (!b || !angle) return
  rig.target.get(b).q.multiply(qAxis(axis, angle))
}

/** 動きの成分。MOTION_GAIN 倍したうえで関節可動域へ収める */
function addRot(rig, key, axis, angle) {
  const b = rig.map[key]
  if (!b || !angle) return
  rig.target.get(b).q.multiply(qAxis(axis, soft(angle, MOTION_LIMIT[familyOf(key)] ?? 1, rig.gain)))
}

/**
 * 脚（腿・膝）だけは**最終角度(rad)をそのまま**書く。ここにゲインは掛けない。
 * 脚の形が接地点＝体の高さを決めるので、倍にすると歩くだけで体が沈む。
 * 「動きを大きく」は上半身・腕・体幹の振り幅で作る。
 */
function addLeg(rig, key, axis, angle) {
  const b = rig.map[key]
  if (!b || !angle) return
  const limit = MOTION_LIMIT[familyOf(key)] ?? 1
  rig.target.get(b).q.multiply(qAxis(axis, THREE.MathUtils.clamp(angle, -limit, limit)))
}

/** モデル全体を動かす。値は身長比（+z が正面、+y が上）。 */
function addRoot(rig, forward = 0, up = 0, side = 0) {
  rig.root.z += forward * rig.rootAmp
  rig.root.y += up * rig.rootAmp
  rig.root.x += side * rig.rootAmp
}

/** モデル全体を傾ける。pitch=前後、roll=左右、spin=水平回転(rad)。 */
function addTilt(rig, pitch = 0, roll = 0, spin = 0) {
  rig.root.pitch += pitch * rig.rootAmp
  rig.root.roll += roll * rig.rootAmp
  rig.root.spin += spin * rig.rootAmp
}

// ── 全身モーションの部品。攻撃ごとに腕だけを動かさないための共通土台 ──

// 左右の脚は必ず別々に動かす。両脚に同じ値を入れると「棒立ちのまま上下する」に見える。
const near = (side) => (side > 0 ? 'right' : 'left')
const far = (side) => (side > 0 ? 'left' : 'right')

/** 沈み込み。軸足を深く、反対の脚は浅く曲げて「ため」を作る。 */
function crouch(rig, t, side = 1) {
  if (t <= 0) return
  const a = near(side), b = far(side)
  addLeg(rig, `${a}Knee`, AXIS_X, 0.55 * t); addLeg(rig, `${b}Knee`, AXIS_X, 0.3 * t)
  addLeg(rig, `${a}Leg`, AXIS_X, -0.26 * t); addLeg(rig, `${b}Leg`, AXIS_X, -0.1 * t)
  addLeg(rig, `${b}Leg`, AXIS_Z, 0.13 * t * side)
  addRot(rig, 'hips', AXIS_Z, -0.03 * t * side)
}

/** 踏み込み。front>0 で右足を前へ出し、後ろ足で踏ん張る。 */
function lunge(rig, t, front = 1) {
  if (t <= 0) return
  const fLeg = front > 0 ? 'rightLeg' : 'leftLeg', bLeg = front > 0 ? 'leftLeg' : 'rightLeg'
  const fKnee = front > 0 ? 'rightKnee' : 'leftKnee', bKnee = front > 0 ? 'leftKnee' : 'rightKnee'
  addLeg(rig, fLeg, AXIS_X, -0.5 * t)
  addLeg(rig, bLeg, AXIS_X, 0.4 * t)
  addLeg(rig, fKnee, AXIS_X, 0.3 * t)
  addLeg(rig, bKnee, AXIS_X, 0.15 * t)
  addRot(rig, 'hips', AXIS_Z, -0.04 * t * front)
}

/** 跳躍。振り上げ足を高く畳み、踏み切り足は後ろへ流す。 */
function airborne(rig, t, side = 1) {
  if (t <= 0) return
  const lead = near(side), trail = far(side)
  // 接地に引き戻されないよう、跳んでいることを接地側へ伝える
  rig.root.air = Math.max(rig.root.air, t)
  addRoot(rig, 0, 0.17 * t, 0)
  addLeg(rig, `${lead}Knee`, AXIS_X, 1.1 * t); addLeg(rig, `${lead}Leg`, AXIS_X, -0.75 * t)
  addLeg(rig, `${trail}Knee`, AXIS_X, 0.6 * t); addLeg(rig, `${trail}Leg`, AXIS_X, 0.25 * t)
}

/** 踏みつけ。t=0で足を上げ、t=1で踏み下ろす。 */
function stomp(rig, t, side = 1) {
  const lift = Math.sin(THREE.MathUtils.clamp(t, 0, 1) * Math.PI)
  if (lift <= 0) return
  addLeg(rig, side > 0 ? 'rightLeg' : 'leftLeg', AXIS_X, -0.8 * lift)
  addLeg(rig, side > 0 ? 'rightKnee' : 'leftKnee', AXIS_X, 1.0 * lift)
  addRot(rig, 'hips', AXIS_Z, 0.05 * lift * side)
  addRoot(rig, 0, 0.045 * lift, 0)
}

/** 腰から捻る。amount は -1〜1。上半身だけで振らないための回転源。 */
function twist(rig, amount) {
  if (!amount) return
  // 腰(hips)は回さない。腰から上だけを回すので、いくら振っても足は動かない。
  addRot(rig, 'spine', AXIS_Y, amount * 0.5)
  addRot(rig, 'chest', AXIS_Y, amount * 0.42)
  addRot(rig, 'head', AXIS_Y, amount * -0.12)
  addTilt(rig, 0, 0, amount * 0.1)
}

/** 両腕を上げる（+1）／下ろす（-1）。肩・肘・胸をまとめて動かす。 */
function armsUp(rig, t) {
  if (!t) return
  addRot(rig, 'leftArm', AXIS_Z, 0.4 * t); addRot(rig, 'rightArm', AXIS_Z, -0.4 * t)
  addRot(rig, 'leftForeArm', AXIS_Z, 0.14 * t); addRot(rig, 'rightForeArm', AXIS_Z, -0.14 * t)
  addRot(rig, 'chest', AXIS_X, -0.1 * t)
}

function applyProcedural(rig, st, dt) {
  resetTargets(rig)
  rig.gain = currentGain()
  // モデル全体の移動量はゲイン5のときに等倍。ゲインを下げれば踏み込みも一緒に小さくなる。
  rig.rootAmp = rig.gain / MOTION_GAIN
  const p = rig.pose
  const t = sim.time
  // 攻撃中は攻撃側が脚を作る。歩行サイクルと踏み込みが混ざって足踏みに見えるのを防ぐ。
  const moving = !st.attack && (st.anim === 'run' || st.state === 'approach' || st.state === 'reposition')
  const running = moving && st.def.id === 'student'
  const cycle = t * (running ? 8.6 : moving ? 5.4 : 2.2)
  const step = moving ? Math.sin(cycle) * (running ? 0.62 : 0.45) : 0
  const breathe = Math.sin(cycle) * 0.025

  // 基本姿勢: 肩を下ろし、肘/膝を曲げ、Tポーズを必ず崩す。ここは体型なのでゲインを掛けない。
  addBase(rig, 'leftArm', AXIS_Z, -p.shoulderDown)
  addBase(rig, 'rightArm', AXIS_Z, p.shoulderDown)
  addBase(rig, 'leftForeArm', AXIS_Z, -p.elbowBend)
  addBase(rig, 'rightForeArm', AXIS_Z, p.elbowBend)
  addBase(rig, 'spine', AXIS_X, p.torsoLean)
  addBase(rig, 'leftKnee', AXIS_X, p.kneeBend)
  addBase(rig, 'rightKnee', AXIS_X, p.kneeBend)
  addBase(rig, 'leftLeg', AXIS_Z, -p.legSpread)
  addBase(rig, 'rightLeg', AXIS_Z, p.legSpread)
  addRot(rig, 'spine', AXIS_X, breathe)

  if (moving) {
    // 歩行/走行。脚→骨盤→胸→腕→頭まで連動させる（腕だけが揺れる歩きにしない）。
    addLeg(rig, 'leftLeg', AXIS_X, step)
    addLeg(rig, 'rightLeg', AXIS_X, -step)
    // 後ろへ流れた脚を畳み、前に出た脚は伸ばす。棒足で滑らせない。
    addLeg(rig, 'leftKnee', AXIS_X, Math.max(0, step) * 1.2 + 0.04)
    addLeg(rig, 'rightKnee', AXIS_X, Math.max(0, -step) * 1.2 + 0.04)
    addRot(rig, 'hips', AXIS_Y, step * 0.09)
    addRot(rig, 'chest', AXIS_Y, -step * 0.13)
    addRot(rig, 'hips', AXIS_Z, Math.cos(cycle) * 0.035)
    addRot(rig, 'leftArm', AXIS_X, -step * 0.4)
    addRot(rig, 'rightArm', AXIS_X, step * 0.4)
    addRot(rig, 'leftForeArm', AXIS_Z, -Math.max(0, -step) * 0.2)
    addRot(rig, 'rightForeArm', AXIS_Z, Math.max(0, step) * 0.2)
    // 前傾は「揺れ」ではなく構えなので、ゲインを掛けずに一定量だけ倒す
    addBase(rig, 'chest', AXIS_X, running ? 0.19 : 0.09)
    addBase(rig, 'head', AXIS_X, running ? -0.12 : -0.05)
    // 体そのものが弾み、傾く。足踏みではなく前進している見た目にする。
    addTilt(rig, running ? 0.13 : 0.06, Math.cos(cycle) * 0.05, -step * 0.04)
  } else if (!st.attack) {
    // 待機。呼吸・体重移動・膝の伸び縮みで、立っているだけでも全身が生きている。
    const sway = Math.sin(t * 0.9)
    addRot(rig, 'head', AXIS_Y, Math.sin(t * 0.75) * 0.09)
    addRot(rig, 'head', AXIS_X, Math.sin(t * 1.3) * 0.028)
    addRot(rig, 'chest', AXIS_X, -breathe * 1.1)
    addRot(rig, 'leftArm', AXIS_X, Math.sin(t * 1.7) * 0.045)
    addRot(rig, 'rightArm', AXIS_X, -Math.sin(t * 1.7) * 0.045)
    addRot(rig, 'leftArm', AXIS_Z, -Math.sin(t * 1.7) * 0.03)
    addRot(rig, 'rightArm', AXIS_Z, Math.sin(t * 1.7) * 0.03)
    addRot(rig, 'hips', AXIS_Z, sway * 0.055)
    addRot(rig, 'hips', AXIS_Y, sway * 0.045)
    addLeg(rig, 'leftKnee', AXIS_X, Math.max(0, sway) * 0.16)
    addLeg(rig, 'rightKnee', AXIS_X, Math.max(0, -sway) * 0.16)
    addRoot(rig, 0, Math.sin(cycle) * 0.006, sway * 0.016)
    addTilt(rig, 0, sway * 0.03, 0)
  }

  const attack = st.attack?.def?.id
  const phase = st.attack?.phase
  // 予備動作は 0→1 でためる。判定・後隙は 1→0 で戻る。
  // ここを段階で分けないと、押した瞬間に伸びきったまま止まって見える。
  let progress = 0
  let release = 0
  if (st.attack) {
    const a = st.attack
    if (phase === 'windup') progress = Math.min(1, 1 - (a.timer || 0) / Math.max(0.05, (a.def.windup || 0.7)))
    else if (phase === 'charge') { progress = 1; release = 1 }
    else { // recover
      progress = 1
      release = Math.min(1, 1 - (a.timer || 0) / Math.max(0.05, a.def.recover || 0.5))
    }
  }
  // 単体ポーズ再生（BOSS FORGE）。攻撃より優先して見せる。
  const posePlay = st.forgePose && (st.forgePose.seconds <= 0 || sim.time - st.forgePose.startedAt < st.forgePose.seconds)
    ? st.forgePose : null
  const poseT = posePlay ? Math.min(1, (sim.time - posePlay.startedAt) / Math.max(0.2, posePlay.seconds || 1)) : 0
  if (posePlay && ['hit', 'stagger', 'down', 'recover', 'phaseChange', 'death'].includes(posePlay.id)) {
    const arc = Math.sin(poseT * Math.PI)
    if (posePlay.id === 'hit') {
      // のけぞり。上体だけでなく後ろ足へ体重を逃がし、体ごと後ずさる。
      addRot(rig, 'chest', AXIS_X, -0.55 * arc); addRot(rig, 'head', AXIS_X, 0.3 * arc)
      addRot(rig, 'leftArm', AXIS_X, 0.4 * arc); addRot(rig, 'rightArm', AXIS_X, 0.4 * arc)
      addLeg(rig, 'leftLeg', AXIS_X, 0.3 * arc); addLeg(rig, 'rightLeg', AXIS_X, -0.22 * arc)
      addLeg(rig, 'rightKnee', AXIS_X, 0.5 * arc)
      addRoot(rig, -0.09 * arc, 0, 0); addTilt(rig, -0.12 * arc, 0.05 * arc, 0)
    } else if (posePlay.id === 'stagger') {
      // よろけ。膝が笑い、足を踏み替えながら体が左右へ流れる。
      const wob = Math.sin(poseT * 12)
      addRot(rig, 'chest', AXIS_X, -0.62); addRot(rig, 'spine', AXIS_Z, wob * 0.16)
      addLeg(rig, 'leftKnee', AXIS_X, 0.62 + Math.max(0, wob) * 0.3); addLeg(rig, 'rightKnee', AXIS_X, 0.4 + Math.max(0, -wob) * 0.3)
      addLeg(rig, 'leftLeg', AXIS_X, wob * 0.3); addLeg(rig, 'rightLeg', AXIS_X, -wob * 0.3)
      addRot(rig, 'hips', AXIS_Z, wob * 0.1); addRot(rig, 'head', AXIS_X, 0.3)
      addRoot(rig, -0.03, 0, wob * 0.05); addTilt(rig, -0.08, wob * 0.1, wob * 0.06)
    } else if (posePlay.id === 'down') {
      const f = Math.min(1, poseT * 1.6)
      addRot(rig, 'spine', AXIS_X, 0.85 * f); addRot(rig, 'chest', AXIS_X, 0.5 * f)
      addLeg(rig, 'leftKnee', AXIS_X, 1.5 * f); addLeg(rig, 'rightKnee', AXIS_X, 1.1 * f)
      addLeg(rig, 'leftLeg', AXIS_X, -0.6 * f); addLeg(rig, 'rightLeg', AXIS_X, -0.5 * f)
      addRot(rig, 'leftArm', AXIS_X, 0.4 * f); addRot(rig, 'rightArm', AXIS_X, 0.4 * f)
      addRoot(rig, -0.06 * f, 0, 0); addTilt(rig, 0.2 * f, 0, 0)
    } else if (posePlay.id === 'recover') {
      const f = 1 - Math.min(1, poseT * 1.3)
      addRot(rig, 'spine', AXIS_X, 0.85 * f); addRot(rig, 'chest', AXIS_X, 0.5 * f)
      addLeg(rig, 'leftKnee', AXIS_X, 1.5 * f); addLeg(rig, 'rightKnee', AXIS_X, 1.1 * f)
      // 片膝立ちから立ち上がる。前足を踏み出して体を押し上げる。
      addLeg(rig, 'rightLeg', AXIS_X, -0.7 * f); addLeg(rig, 'leftLeg', AXIS_X, 0.25 * f)
      addRot(rig, 'leftArm', AXIS_X, -0.5 * f); addRot(rig, 'rightArm', AXIS_X, -0.5 * f)
      addRoot(rig, -0.05 * f, 0, 0); addTilt(rig, 0.18 * f, 0, 0)
    } else if (posePlay.id === 'phaseChange') {
      // 咆哮。両腕を突き上げ、脚を開いて踏ん張り、体ごと浮き上がる。
      addRot(rig, 'chest', AXIS_X, -0.45 * arc); addRot(rig, 'head', AXIS_X, -0.35 * arc)
      armsUp(rig, arc)
      addLeg(rig, 'leftLeg', AXIS_Z, -0.3 * arc); addLeg(rig, 'rightLeg', AXIS_Z, 0.14 * arc)
      addLeg(rig, 'leftKnee', AXIS_X, 0.45 * arc); addLeg(rig, 'rightKnee', AXIS_X, 0.22 * arc)
      addRoot(rig, 0, 0.1 * arc, 0); addTilt(rig, -0.16 * arc, 0, 0)
    } else if (posePlay.id === 'death') {
      const f = Math.min(1, poseT * 1.2)
      addRot(rig, 'spine', AXIS_X, 1.1 * f); addRot(rig, 'chest', AXIS_X, 0.6 * f)
      addRot(rig, 'head', AXIS_X, 0.5 * f)
      addLeg(rig, 'leftKnee', AXIS_X, 1.6 * f); addLeg(rig, 'rightKnee', AXIS_X, 1.2 * f)
      addLeg(rig, 'leftLeg', AXIS_X, -0.7 * f); addLeg(rig, 'rightLeg', AXIS_X, -0.55 * f)
      addRot(rig, 'leftArm', AXIS_X, 0.7 * f); addRot(rig, 'rightArm', AXIS_X, 0.7 * f)
      addRoot(rig, -0.04 * f, 0, 0); addTilt(rig, 0.26 * f, 0.1 * f, 0)
    }
  } else if (st.state === 'entrance') {
    // 登場。沈み込みから立ち上がり、腕を広げて体を起こす。
    const rise = Math.min(1, st.stateTime / 1.2)
    addRot(rig, 'chest', AXIS_X, -0.18 + rise * 0.32)
    addRot(rig, 'leftArm', AXIS_Y, -0.25); addRot(rig, 'rightArm', AXIS_Y, 0.25)
    armsUp(rig, 0.5 * rise)
    crouch(rig, 1 - rise, -1)
    addLeg(rig, 'leftLeg', AXIS_Z, -0.22 * rise); addLeg(rig, 'rightLeg', AXIS_Z, 0.1 * rise)
    addRoot(rig, 0, 0, 0); addTilt(rig, -0.14 * rise, 0, 0)
  } else if (st.state === 'stagger') {
    // ひるみ。両膝が落ち、体が前へ泳ぐ。
    const wob = Math.sin(t * 9)
    addRot(rig, 'chest', AXIS_X, -0.5); addRot(rig, 'head', AXIS_X, 0.24)
    addLeg(rig, 'leftKnee', AXIS_X, 0.5 + Math.max(0, wob) * 0.3); addLeg(rig, 'rightKnee', AXIS_X, 0.3 + Math.max(0, -wob) * 0.3)
    addLeg(rig, 'leftLeg', AXIS_X, wob * 0.22); addLeg(rig, 'rightLeg', AXIS_X, -wob * 0.22)
    addRot(rig, 'hips', AXIS_Z, wob * 0.08)
    addRoot(rig, -0.02, 0, wob * 0.03); addTilt(rig, 0.1, wob * 0.08, 0)
  } else if (st.phase === 2 && st.stateTime < 1.2) {
    // フェーズ移行。脚を開いて踏ん張り、体を反らせる。
    addRot(rig, 'chest', AXIS_X, -0.34); addRot(rig, 'leftArm', AXIS_Y, -0.38); addRot(rig, 'rightArm', AXIS_Y, 0.38)
    armsUp(rig, 0.6)
    addLeg(rig, 'leftLeg', AXIS_Z, -0.28); addLeg(rig, 'rightLeg', AXIS_Z, 0.13)
    addLeg(rig, 'leftKnee', AXIS_X, 0.42); addLeg(rig, 'rightKnee', AXIS_X, 0.2)
    addRoot(rig, 0, 0.05, 0); addTilt(rig, -0.12, 0, 0)
  } else if (attack) {
    // 攻撃別に異なる重心と腕の軌道。エフェクトだけの静止攻撃にしない。
    // swing は「ためて振り抜き、後隙で戻る」形にする。
    const swing = phase === 'windup'
      ? Math.sin(Math.min(1, progress) * Math.PI * 0.5) * 0.55        // ための途中
      : 1 - release * 0.85                                             // 振り抜き→戻り
    // ため(load)と振り抜き(drive)。どの攻撃でもこの2つで全身の重心が動く。
    const load = phase === 'windup' ? progress : Math.max(0, 1 - release * 1.6)
    const drive = phase === 'windup' ? 0 : 1 - release * 0.7
    const charging = phase === 'charge'
    // 右構えの技は左足を前に出す（右手で振るなら踏み込むのは逆足）
    const front = ['mimic', 'sweep', 'gate', 'pan', 'encore', 'ofuda', 'flame'].includes(attack) ? -1 : 1
    if (charging) {
      // 突進中は走る。脚を回し、体を前へ倒す。
      const c = t * 12
      addLeg(rig, 'leftLeg', AXIS_X, Math.sin(c) * 0.6)
      addLeg(rig, 'rightLeg', AXIS_X, -Math.sin(c) * 0.6)
      addLeg(rig, 'leftKnee', AXIS_X, Math.max(0, Math.sin(c)) * 0.8 + 0.06)
      addLeg(rig, 'rightKnee', AXIS_X, Math.max(0, -Math.sin(c)) * 0.8 + 0.06)
      addRot(rig, 'leftArm', AXIS_X, -Math.sin(c) * 0.3); addRot(rig, 'rightArm', AXIS_X, Math.sin(c) * 0.3)
      addRot(rig, 'spine', AXIS_X, 0.26)
      addRoot(rig, 0.04, Math.abs(Math.sin(c)) * 0.03, 0)
      addTilt(rig, 0.18, Math.cos(c) * 0.05, 0)
    } else {
      // 段階が姿勢だけで分かるよう、沈み込み → 踏み込み → 前のめりを全身で作る。
      // 上体は倒しすぎない。頭から突っ込ませず、脚と腰で大きさを出す。
      crouch(rig, 0.7 * load, -front)
      lunge(rig, drive, front)
      addRot(rig, 'spine', AXIS_X, -0.1 * load + 0.09 * drive)
      addRot(rig, 'head', AXIS_X, -0.05 * load + 0.05 * drive)
      addRoot(rig, -0.035 * load + 0.15 * drive, 0, 0)
      addTilt(rig, -0.05 * load + 0.08 * drive, 0, 0)
    }
    if (st.def.id === 'student') {
      if (attack === 'mimic') {
        // 模倣ハンマー: 腰から捻って振り下ろす。踏み込み足が着地と同時に判定。
        twist(rig, (-0.5 + progress) * (phase === 'windup' ? 1 : 1 - release))
        addRot(rig, 'chest', AXIS_Y, -0.55 + progress * 1.1)
        addRot(rig, 'rightArm', AXIS_X, -1.1 * swing); addRot(rig, 'rightForeArm', AXIS_X, -0.55 * swing)
        addRot(rig, 'rightArm', AXIS_Z, -0.5 * load + 0.3 * drive)
        stomp(rig, drive, -front)
      } else if (attack === 'spring' || attack === 'runaway') {
        // バネ跳躍: 深く沈んでから跳ぶ。跳躍中は脚を畳んで体ごと浮かせる。
        crouch(rig, 1.1 * load, -front)
        airborne(rig, drive, front)
        addRot(rig, 'chest', AXIS_X, 0.34 * load - 0.2 * drive)
        armsUp(rig, 0.7 * drive - 0.3 * load)
      } else if (attack === 'drone') {
        // ドローン射出: 片脚を引いて上体を反らし、両腕を突き上げる。
        armsUp(rig, 0.5 + 0.5 * drive)
        addLeg(rig, 'leftLeg', AXIS_X, 0.35 * load); addLeg(rig, 'leftKnee', AXIS_X, 0.45 * load)
        addLeg(rig, 'rightLeg', AXIS_X, -0.3 * drive)
        addRot(rig, 'chest', AXIS_X, -0.3 * load + 0.24 * drive)
      } else { addRot(rig, 'leftArm', AXIS_X, -0.55 * swing); addRot(rig, 'rightArm', AXIS_X, -0.55 * swing) }
    } else if (st.def.id === 'stage') {
      if (attack === 'speaker' || attack === 'beat') {
        // 拍を刻む: 腕を振り下ろすと同時に足で踏み鳴らす。
        addRot(rig, 'chest', AXIS_X, -0.22 * load + 0.18 * drive)
        addRot(rig, 'rightArm', AXIS_X, -0.9 * progress)
        armsUp(rig, 0.8 * load - 0.15 * drive)
        stomp(rig, drive, 1)
              } else if (attack === 'spotlight' || attack === 'encore') {
        // 見得を切る: 腕を大きく開き、腰から回って足をクロスさせる。
        addRot(rig, 'leftArm', AXIS_Y, -0.75 * swing); addRot(rig, 'rightArm', AXIS_Y, 0.75 * swing)
        addRot(rig, 'chest', AXIS_X, -0.18)
        twist(rig, -0.6 * load + 0.9 * drive)
        addLeg(rig, 'leftLeg', AXIS_Z, -0.26 * drive); addLeg(rig, 'rightLeg', AXIS_Z, 0.1 * drive)
        addLeg(rig, 'rightLeg', AXIS_X, -0.45 * drive); addLeg(rig, 'rightKnee', AXIS_X, 0.4 * drive)
        addRoot(rig, 0, 0.05 * drive, 0)
      }
    } else if (st.def.id === 'shrine') {
      if (attack === 'quake') {
        // 地鎮の衝撃: 両腕を振り上げて跳び、両膝を折って地面を叩き割る。
        armsUp(rig, load)
        airborne(rig, 0.7 * load, front)
        addRot(rig, 'leftArm', AXIS_X, -1.05 * (1 - progress)); addRot(rig, 'rightArm', AXIS_X, -1.05 * (1 - progress))
        addRot(rig, 'chest', AXIS_X, 0.32 * progress)
        crouch(rig, 0.85 * drive, -front)
        addLeg(rig, 'leftLeg', AXIS_Z, -0.32 * drive); addLeg(rig, 'rightLeg', AXIS_Z, 0.14 * drive)
              } else if (attack === 'sweep' || attack === 'gate') {
        // 重い薙ぎ払い: 軸足で踏ん張り、腰から体ごと回す。
        twist(rig, -0.7 * load + 1 * drive)
        addRot(rig, 'chest', AXIS_Y, -0.65 + progress * 1.3)
        addRot(rig, 'rightArm', AXIS_X, -0.8 * swing)
        addRot(rig, 'rightArm', AXIS_Z, -0.45 * drive)
        addLeg(rig, 'leftLeg', AXIS_X, 0.35 * load); addLeg(rig, 'leftKnee', AXIS_X, 0.5 * load)
        addRoot(rig, 0.05 * drive, 0, -0.06 * drive)
      } else {
        // 追尾札: 一歩踏み出して腕を突き出す。
        addRot(rig, 'leftArm', AXIS_Y, -0.35); addRot(rig, 'rightArm', AXIS_Y, 0.35)
        addRot(rig, 'rightArm', AXIS_X, -0.5 * drive)
        addLeg(rig, 'leftLeg', AXIS_X, -0.4 * drive); addLeg(rig, 'leftKnee', AXIS_X, 0.3 * drive)
        addRot(rig, 'chest', AXIS_X, -0.24 * load + 0.2 * drive)
      }
    } else {
      if (attack === 'flame') {
        // 火炎噴射: 反動で後ろ足へ体重が乗り、上体が押し戻される。
        addRot(rig, 'chest', AXIS_X, -0.32 * progress)
        addRot(rig, 'rightArm', AXIS_X, -0.85 * progress)
        addRot(rig, 'leftArm', AXIS_X, -0.55 * progress)
        addLeg(rig, 'rightLeg', AXIS_X, 0.4 * drive); addLeg(rig, 'rightKnee', AXIS_X, 0.5 * drive)
        addLeg(rig, 'leftLeg', AXIS_X, -0.35 * drive)
        addRoot(rig, -0.06 * drive, 0, 0); addTilt(rig, -0.1 * drive, 0, 0)
      } else if (attack === 'oil' || attack === 'cook') {
        // 鍋を振る: 左右へ体重を移し替えながら、膝を屈伸させる。
        const stir = Math.sin(t * 8)
        addRot(rig, 'leftArm', AXIS_X, stir * 0.35); addRot(rig, 'rightArm', AXIS_X, -stir * 0.35)
        addRot(rig, 'chest', AXIS_X, 0.16); addRot(rig, 'chest', AXIS_Y, stir * 0.22)
        addRot(rig, 'hips', AXIS_Z, stir * 0.09); addRot(rig, 'hips', AXIS_Y, -stir * 0.1)
        addLeg(rig, 'leftKnee', AXIS_X, Math.max(0, stir) * 0.4); addLeg(rig, 'rightKnee', AXIS_X, Math.max(0, -stir) * 0.4)
        addRoot(rig, 0, 0, stir * 0.03); addTilt(rig, 0, stir * 0.06, 0)
      } else if (attack === 'boil') {
        // 火柱: 踏み鳴らしてから両腕を突き上げる。
        stomp(rig, load, 1)
        armsUp(rig, drive)
        addRot(rig, 'chest', AXIS_X, -0.3 * drive)
        addRoot(rig, 0, 0.06 * drive, 0)
      } else {
        // 巨大フライパン: 腰から捻って大振りし、踏み込みで振り切る。
        twist(rig, -0.6 * load + 1 * drive)
        addRot(rig, 'chest', AXIS_Y, -0.45 + progress * 0.9)
        addRot(rig, 'rightArm', AXIS_X, -1.0 * swing)
        addRot(rig, 'rightArm', AXIS_Z, -0.4 * drive)
        addLeg(rig, 'leftLeg', AXIS_X, 0.38 * load)
        stomp(rig, drive, -front)
        addRoot(rig, 0.05 * drive, 0, 0)
      }
    }
  }
  // 被弾は上体だけでなく、膝と体そのものを後ろへ逃がす。
  if (st.hitFlash > 0) {
    const f = st.hitFlash
    addRot(rig, 'chest', AXIS_X, -f * 0.65)
    addLeg(rig, 'leftKnee', AXIS_X, f * 0.55); addLeg(rig, 'rightKnee', AXIS_X, f * 0.3)
    addLeg(rig, 'leftLeg', AXIS_X, f * 0.25); addLeg(rig, 'rightLeg', AXIS_X, -f * 0.18)
    addRoot(rig, -f * 0.12, 0, 0); addTilt(rig, -f * 0.16, f * 0.06, 0)
  }

  // BOSS FORGEの補正は既存の姿勢・攻撃の後に重ねる。基準姿勢を直接壊さないので
  // スライダーを戻せばアニメーションの見た目も即座に元へ戻る。
  for (const b of rig.all) {
    const value = st.forgeBoneOverrides?.[b.name]
    if (!value) continue
    const target = rig.target.get(b)
    target.q.multiply(qAxis(AXIS_X, THREE.MathUtils.degToRad(value.x || 0)))
    target.q.multiply(qAxis(AXIS_Y, THREE.MathUtils.degToRad(value.y || 0)))
    target.q.multiply(qAxis(AXIS_Z, THREE.MathUtils.degToRad(value.z || 0)))
  }

  const ease = 1 - Math.exp(-13 * dt)
  for (const b of rig.all) {
    const target = rig.target.get(b)
    b.quaternion.slerp(target.q, ease)
    b.position.lerp(target.p, ease)
  }
}

/** 出現したボスだけをロードし、個体ごとに骨格と材質を複製する。 */
export function BossModel({ source }) {
  const host = useRef()
  const model = useRef(null)
  const mats = useRef([])
  const rig = useRef(null)
  const skeleton = useRef(null)
  const loading = useRef(false)

  const load = (st) => {
    if (loading.current || model.current) return
    loading.current = true
    loadBossModel(st.def.modelPath).then((gltf) => {
      loading.current = false
      if (!host.current) return
      const mesh = cloneSkeleton(gltf.scene)
      const materials = []
      mesh.traverse((node) => {
        if (!node.isMesh) return
        node.castShadow = true; node.receiveShadow = true; node.frustumCulled = false
        node.material = Array.isArray(node.material) ? node.material.map((m) => m.clone()) : node.material.clone()
        for (const m of Array.isArray(node.material) ? node.material : [node.material]) { m.emissive = new THREE.Color(0); m.emissiveIntensity = 0; materials.push(m) }
      })
      mesh.scale.setScalar(st.def.displayHeight || 3.5)
      mesh.userData.bossModelPath = st.def.modelPath
      mesh.updateMatrixWorld(true)
      const bounds = new THREE.Box3().setFromObject(mesh)
      const size = bounds.getSize(new THREE.Vector3())
      const center = bounds.getCenter(new THREE.Vector3())
      st.forgeModelHeight = size.y
      // プレビューカメラの自動フレーミング用。ボス原点からの相対で持つ。
      st.forgeBounds = {
        min: [bounds.min.x, bounds.min.y, bounds.min.z],
        max: [bounds.max.x, bounds.max.y, bounds.max.z],
        center: [center.x, center.y, center.z],
        size: [size.x, size.y, size.z],
        radius: size.length() / 2,
      }
      st.forgeModelReady = true
      if (sim.bossForge) sim.bossForge.needsFrame = true
      host.current.add(mesh); model.current = mesh; mats.current = materials
      rig.current = setupRig(mesh, st.def.id)
      skeleton.current = new THREE.SkeletonHelper(mesh)
      skeleton.current.visible = false
      host.current.add(skeleton.current)
      if (st.forgeActive && rig.current) st.forgeBones = rig.current.all.map((bone) => bone.name)
      // 接地補正の基準（足首が足の裏からどれだけ上か）はバインドポーズで測る。
      measureContacts(rig.current, mesh)
      // 読み込み直後の1フレームもTポーズを見せない。
      if (rig.current) applyProcedural(rig.current, st, 1 / 60)
      if (import.meta.env.DEV) (window.__bossModelLoads ||= []).push({
        path: st.def.modelPath, bones: rig.current?.all.length || 0, clips: gltf.animations.length,
        // 接地が効いているかの確認用（contacts が 0 なら足首/つま先の骨名が合っていない）
        contacts: rig.current?.contacts.map((c) => `${c.bone.name}:${c.restY.toFixed(2)}`) || [],
      })
    }).catch((err) => {
      loading.current = false
      if (import.meta.env.DEV) (window.__bossModelErrors ||= []).push({ path: st.def.modelPath, message: String(err?.message || err) })
      console.error(`ボスモデルを読み込めませんでした: ${st.def.modelPath}`, err)
    })
  }

  useEffect(() => () => {
    const mesh = model.current
    if (mesh) mesh.parent?.remove(mesh)
    const helper = skeleton.current
    if (helper) {
      helper.parent?.remove(helper)
      helper.geometry?.dispose?.(); helper.material?.dispose?.()
    }
    for (const m of mats.current) m.dispose?.()
    mats.current = []; model.current = null; rig.current = null; skeleton.current = null
  }, [])

  useFrame((_, dt) => {
    const st = source(), group = host.current
    if (!st || !group) return
    group.visible = st.alive
    if (!st.alive) return
    load(st)
    group.position.set(st.pos.x, st.pos.y, st.pos.z); group.rotation.set(0, st.yaw, 0)
    const mesh = model.current
    if (!mesh) return
    // BOSS FORGE の死亡ポーズ再生中は、手続き姿勢で見せる（倒れて固まらせない）
    if (st.state === 'dead' && !st.forgePose) {
      mesh.rotation.x = Math.min(1.4, (st.ragdollTime || 0) * 1.4)
      // 直前の踏み込み・跳躍の残りを引きずらせない
      const s = rig.current?.smooth
      if (s) { s.x *= 0.9; s.y *= 0.9; s.z *= 0.9 }
      mesh.position.multiplyScalar(0.9); mesh.rotation.z *= 0.9; mesh.rotation.y *= 0.9
      return
    }
    if (rig.current) {
      applyProcedural(rig.current, st, dt)
      // 骨だけでなくモデル全体を動かす。踏み込み・跳躍・のけぞりが体ごと出る。
      const r = rig.current.root
      const s = rig.current.smooth
      const h = st.def.displayHeight || 3.5
      const k = 1 - Math.exp(-15 * dt)
      s.x += (r.x * h - s.x) * k
      s.y += (r.y * h - s.y) * k
      s.z += (r.z * h - s.z) * k
      mesh.position.set(s.x, s.y, s.z)
      mesh.rotation.x += (r.pitch - mesh.rotation.x) * k
      mesh.rotation.y += (r.spin - mesh.rotation.y) * k
      mesh.rotation.z += (r.roll - mesh.rotation.z) * k
      // 足を軸にして体の高さを決める。腰から上の動きは接地点を動かさないので沈まない。
      // 跳躍中(air>0)だけは地面へ引き戻さず、持ち上げ方向にしか効かせない。
      // 補正値は smooth へ混ぜない（混ぜると次のフレームで足が浮き続ける）。
      const off = groundOffset(rig.current, st.pos.y, h * FOOT_CLEARANCE)
      mesh.position.y = s.y + (r.air > 0 ? Math.max(0, off) : off)
    } else {
      mesh.rotation.set(0, 0, 0)
      mesh.position.y = Math.sin(sim.time * 2) * 0.02 // 読み込み失敗時でも完全静止にしない
    }
    if (skeleton.current) skeleton.current.visible = Boolean(st.forgeActive && sim.bossForge?.showBones)

    const flash = st.hitFlash || 0
    const telegraph = sim.time < (st.telegraphUntil || 0)
    for (const m of mats.current) {
      if (flash > 0) { tmpColor.setRGB(1, 0.4, 0.35); m.emissive.copy(tmpColor); m.emissiveIntensity = flash * 2.6 }
      else if (telegraph) { tmpColor.set(st.telegraphColor || st.def.color); m.emissive.copy(tmpColor); m.emissiveIntensity = 0.42 + Math.abs(Math.sin(sim.time * 12)) * 0.5 }
      else if (m.emissiveIntensity !== 0) { m.emissive.setRGB(0, 0, 0); m.emissiveIntensity = 0 }
    }
  })
  return <group ref={host} />
}

export const preloadBoss = (url) => loadBossModel(url).catch(() => {})
