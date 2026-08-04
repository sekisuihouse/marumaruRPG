/**
 * 変換したGLBが元のFBXと同じスキニング結果になるかを検証する。
 *
 *   node scripts/verify-characters.mjs
 *
 * スキニングの式は
 *   world = mesh.matrixWorld * bindMatrixInverse * Σw(bone.matrixWorld * boneInverse) * bindMatrix * p
 * なので、
 *   (A) バインドポーズの頂点ワールド座標が一致
 *   (B) 任意時刻のボーンworld行列が一致 (boneInverses はビルド時に同一性を検証済み)
 * の2点が満たされれば、全アニメーションで一致することが保証できる。
 *
 * 注: 元FBXは部位ごとに別アーマチュアを持つため、複数部位を1グループに入れて
 * AnimationMixer を回すと最初に見つかった1体しか動かない(元実装のバグ)。
 * ここでは参照として単一部位のFBXを使う。
 */
import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { CHAR } from '../src/data/world.js'

const OUT = path.join('public', CHAR.dir.replace(/^\//, ''))
const SRC = 'public/assets/characters'
const PREFIX = { Casual_2: 'Casual2', Casual_Hoodie: 'Casual' }

const fbxLoader = new FBXLoader()
const parseFbx = (f) => fbxLoader.parse(new Uint8Array(fs.readFileSync(f)).buffer, path.dirname(f) + '/')
const parseGlb = (f) => new Promise((res, rej) => new GLTFLoader().parse(new Uint8Array(fs.readFileSync(f)).buffer, '', res, rej))

/** シェーダーと同じ式でスキニング後の頂点ワールド座標AABBを求める */
function skinnedBox(root, step = 3) {
  root.updateMatrixWorld(true)
  const box = new THREE.Box3()
  const v = new THREE.Vector3()
  root.traverse((o) => {
    if (!o.isSkinnedMesh) return
    const pos = o.geometry.attributes.position
    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i)
      o.applyBoneTransform(i, v)
      box.expandByPoint(v.applyMatrix4(o.matrixWorld))
    }
  })
  return box
}

function boneMap(root) {
  const m = new Map()
  root.traverse((o) => { if (o.isBone && !m.has(o.name)) m.set(o.name, o) })
  return m
}

const boxStr = (b) => `[${b.min.toArray().map((x) => x.toFixed(3)).join(',')}]→[${b.max.toArray().map((x) => x.toFixed(3)).join(',')}]`

const animFbx = parseFbx(path.join(SRC, 'Animations.fbx'))
const animGlb = await parseGlb(path.join(OUT, 'animations.glb'))
const clipOf = (list, name) => list.find((c) => c.name.replace(/^.*\|/, '') === name)

const CASES = [['idle', 'Idle'], ['run', 'Run'], ['attack', 'Sword_Slash'], ['death', 'Death'], ['hit', 'HitRecieve']]
let worstVert = 0
let worstBone = 0
let failed = 0

for (const file of fs.readdirSync(OUT).filter((f) => f.endsWith('.glb') && f !== 'animations.glb').sort()) {
  const outfit = file.replace(/\.glb$/, '')
  const prefix = PREFIX[outfit] || outfit

  // 参照: Body 部位のみ(単一アーマチュア)を 0.01 スケールで配置
  const fbxRoot = new THREE.Group()
  fbxRoot.scale.setScalar(CHAR.unitScale)
  fbxRoot.add(parseFbx(path.join(SRC, outfit, `${prefix}_Body.fbx`)))

  const glb = await parseGlb(path.join(OUT, file))
  const glbRoot = glb.scene

  // --- (A) バインドポーズの一致(全部位マージ後の全体AABB) ---
  const fullFbx = new THREE.Group()
  fullFbx.scale.setScalar(CHAR.unitScale)
  for (const f of fs.readdirSync(path.join(SRC, outfit)).filter((n) => n.startsWith(prefix + '_'))) {
    fullFbx.add(parseFbx(path.join(SRC, outfit, f)))
  }
  const bindFbx = skinnedBox(fullFbx)
  const bindGlb = skinnedBox(glbRoot)
  const dBind = Math.max(bindFbx.min.distanceTo(bindGlb.min), bindFbx.max.distanceTo(bindGlb.max))
  worstVert = Math.max(worstVert, dBind)
  if (dBind > 0.02) failed++

  // --- (B) 各クリップでのボーンworld行列の一致 ---
  const fbxBones = boneMap(fbxRoot)
  const glbBones = boneMap(glbRoot)
  const missing = [...fbxBones.keys()].filter((n) => !glbBones.has(n))
  if (missing.length) { console.log(`${outfit}: MISSING BONES ${missing.length}`); failed++ }

  const rows = []
  for (const [glbName, fbxName] of CASES) {
    const cf = clipOf(animFbx.animations, fbxName)
    const cg = clipOf(animGlb.animations, glbName)
    if (!cf || !cg) { rows.push(`${glbName}: clip missing`); failed++; continue }
    const cfTrim = cf.clone()
    cfTrim.tracks = cfTrim.tracks.filter((tr) => !tr.name.endsWith('.scale'))
    const mf = new THREE.AnimationMixer(fbxRoot)
    const mg = new THREE.AnimationMixer(glbRoot)
    mf.clipAction(cfTrim).play()
    mg.clipAction(cg).play()
    let dBone = 0
    for (const t of [0, cf.duration * 0.37, cf.duration * 0.73, cf.duration]) {
      mf.setTime(t); mg.setTime(t)
      fbxRoot.updateMatrixWorld(true); glbRoot.updateMatrixWorld(true)
      for (const [name, b] of fbxBones) {
        const g = glbBones.get(name)
        if (!g) continue
        for (let i = 0; i < 16; i++) dBone = Math.max(dBone, Math.abs(b.matrixWorld.elements[i] - g.matrixWorld.elements[i]))
      }
    }
    // 姿勢が実際に変化していること(=クリップが効いていること)も確認
    mf.setTime(cf.duration * 0.5); mg.setTime(cg.duration * 0.5)
    const posed = skinnedBox(glbRoot)
    const moved = posed.min.distanceTo(bindGlb.min) + posed.max.distanceTo(bindGlb.max)
    worstBone = Math.max(worstBone, dBone)
    if (dBone > 1e-3) failed++
    if (moved < 0.01) { rows.push(`${glbName}: clip had no effect`); failed++; continue }
    rows.push(`${glbName.padEnd(7)} bone Δ=${dBone.toExponential(1)}  posed=${boxStr(posed)}`)
    mf.stopAllAction(); mg.stopAllAction()
  }

  console.log(`${outfit.padEnd(14)} height=${(bindGlb.max.y - bindGlb.min.y).toFixed(2)}m  bind Δ=${(dBind * 1000).toFixed(1)}mm  bones=${glbBones.size}`)
  rows.forEach((r) => console.log('    ' + r))
}

console.log(`\nbind-pose worst: ${(worstVert * 1000).toFixed(1)}mm   bone-matrix worst: ${worstBone.toExponential(2)}   failures: ${failed}`)
process.exit(failed ? 1 : 0)
