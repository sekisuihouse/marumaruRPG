/**
 * Ultimate Modular Men の部位別FBXを、ランタイム向けに最適化した GLB へ変換する。
 *
 *   node scripts/build-characters.mjs
 *
 * やっていること:
 *  1. 各衣装の Body/Legs/Feet/Head(+Backpack) FBX を読み、全部位を1本のスケルトンに統合
 *  2. マテリアル単位でジオメトリをマージ → 1キャラのドローコールを 12〜15 から 3〜4 へ削減
 *  3. mergeVertices で頂点を溶接、UV(未使用)を破棄
 *  4. FBX単位(cm)→m へ 0.01 スケールをルートに掛けて出力
 *  5. Animations.fbx は必要クリップのみ抽出し、共有 animations.glb として1回だけ出力
 *     (全衣装がボーン名の同一なリグなので、AnimationMixer は名前解決で共有できる)
 */
import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { CHAR } from '../src/data/world.js'

// GLTFExporter は binary 出力で FileReader を使う。Node には無いので最小実装で補う。
if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class FileReader {
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then((buf) => { this.result = buf; this.onloadend?.() })
    }
  }
}

const SRC = 'public/assets/characters'
const OUT = path.join('public', CHAR.dir.replace(/^\//, ''))

const OUTFITS = {
  Adventurer: ['Body', 'Legs', 'Feet', 'Head', 'Backpack'],
  Farmer: ['Body', 'Legs', 'Feet', 'Head'],
  King: ['Body', 'Legs', 'Feet', 'Head'],
  Punk: ['Body', 'Legs', 'Feet', 'Head'],
  SpaceSuit: ['Body', 'Legs', 'Feet', 'Head'],
  Swat: ['Body', 'Legs', 'Feet', 'Head'],
  Worker: ['Body', 'Legs', 'Feet', 'Head'],
  Casual_2: ['Body', 'Legs', 'Feet', 'Head'],
  Casual_Hoodie: ['Body', 'Legs', 'Feet', 'Head'],
  Beach: ['Body', 'Legs', 'Feet', 'Head'],
}
// フォルダ名とファイル接頭辞が一致しない衣装
const PREFIX = { Casual_2: 'Casual2', Casual_Hoodie: 'Casual' }

/** ランタイムで使うクリップ名 → Animations.fbx 内のクリップ名 */
const CLIP_MAP = {
  idle: 'Idle',
  idle_sword: 'Idle_Sword',
  idle_gun: 'Idle_Gun',
  walk: 'Walk',
  run: 'Run',
  attack: 'Sword_Slash',
  punch: 'Punch_Right',
  kick: 'Kick_Right',
  shoot: 'Gun_Shoot',
  cast: 'Idle_Gun_Pointing',
  hit: 'HitRecieve',
  death: 'Death',
  interact: 'Interact',
  wave: 'Wave',
  roll: 'Roll',
}

const loader = new FBXLoader()
const parseFbx = (file) => loader.parse(new Uint8Array(fs.readFileSync(file)).buffer, path.dirname(file) + '/')

const MAT_TWEAK = {
  Skin: { roughness: 0.85, metalness: 0 },
  White: { roughness: 0.6, metalness: 0.05 },
  Black: { roughness: 0.55, metalness: 0.1 },
  Metal: { roughness: 0.35, metalness: 0.8 },
}

/** "White.001" → "White"。部位ごとに枝番が付くため、まとめられるよう正規化する。 */
const baseName = (n) => (n || 'Mat').replace(/\.\d+$/, '')

function toStandard(src) {
  const name = baseName(src.name)
  const tweak = MAT_TWEAK[name] || { roughness: 0.7, metalness: 0.05 }
  return new THREE.MeshStandardMaterial({
    name,
    color: src.color ? src.color.clone() : new THREE.Color(0xcccccc),
    ...tweak,
  })
}

/** 非インデックスジオメトリを materialIndex ごとに切り出す */
function splitByMaterial(geom, attrNames) {
  const groups = geom.groups.length ? geom.groups : [{ start: 0, count: geom.attributes.position.count, materialIndex: 0 }]
  const byIndex = new Map()
  for (const g of groups) {
    if (!byIndex.has(g.materialIndex)) byIndex.set(g.materialIndex, [])
    byIndex.get(g.materialIndex).push(g)
  }
  const out = new Map()
  for (const [materialIndex, ranges] of byIndex) {
    const total = ranges.reduce((a, r) => a + r.count, 0)
    const sub = new THREE.BufferGeometry()
    for (const name of attrNames) {
      const src = geom.attributes[name]
      const itemSize = src.itemSize
      const dst = new src.array.constructor(total * itemSize)
      let cursor = 0
      for (const r of ranges) {
        dst.set(src.array.subarray(r.start * itemSize, (r.start + r.count) * itemSize), cursor)
        cursor += r.count * itemSize
      }
      sub.setAttribute(name, new THREE.BufferAttribute(dst, itemSize, src.normalized))
    }
    out.set(materialIndex, sub)
  }
  return out
}

function matrixMaxDiff(a, b) {
  let d = 0
  for (let i = 0; i < 16; i++) d = Math.max(d, Math.abs(a.elements[i] - b.elements[i]))
  return d
}

async function exportGlb(scene, animations, file) {
  const glb = await new GLTFExporter().parseAsync(scene, { binary: true, animations, onlyVisible: false, includeCustomExtensions: false })
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, Buffer.from(glb))
  return glb.byteLength
}

function buildOutfit(outfit, parts) {
  const prefix = PREFIX[outfit] || outfit
  const roots = parts.map((p) => {
    const file = path.join(SRC, outfit, `${prefix}_${p}.fbx`)
    if (!fs.existsSync(file)) throw new Error(`missing ${file}`)
    const r = parseFbx(file)
    r.updateMatrixWorld(true)
    return { part: p, root: r }
  })

  // 1本目のアーマチュアを正規リグに採用
  const armature = roots[0].root.children.find((c) => c.name === 'CharacterArmature')
  if (!armature) throw new Error(`${outfit}: CharacterArmature not found`)
  const bones = []
  armature.traverse((o) => { if (o.isBone) bones.push(o) })
  const boneIndex = new Map(bones.map((b, i) => [b.name, i]))

  // boneInverses は FBXルート空間(ルートスケール適用前)で確定させる
  const boneInverses = bones.map((b) => new THREE.Matrix4().copy(b.matrixWorld).invert())

  const attrNames = ['position', 'normal', 'skinIndex', 'skinWeight']
  /** @type {Map<string,{mat:THREE.Material, geoms:THREE.BufferGeometry[]}>} */
  const buckets = new Map()
  let srcVerts = 0
  let srcDraws = 0

  for (const { part, root } of roots) {
    const mesh = root.children.find((c) => c.isSkinnedMesh) || (() => { let m; root.traverse((o) => { if (o.isSkinnedMesh && !m) m = o }); return m })()
    if (!mesh) throw new Error(`${outfit}/${part}: SkinnedMesh not found`)

    // 部位ごとの boneInverse が正規リグと一致しているか検証(バインドポーズ共有の前提)
    mesh.skeleton.bones.forEach((b, i) => {
      const canonical = boneInverses[boneIndex.get(b.name)]
      if (!canonical) throw new Error(`${outfit}/${part}: unknown bone ${b.name}`)
      const d = matrixMaxDiff(canonical, mesh.skeleton.boneInverses[i])
      if (d > 1e-3) throw new Error(`${outfit}/${part}: bind pose mismatch on ${b.name} (${d})`)
    })

    const geom = mesh.geometry.clone()
    srcVerts += geom.attributes.position.count
    // FBXのメッシュ変換をジオメトリへ焼き込み、bindMatrix を単位行列にできる状態にする
    geom.applyMatrix4(mesh.matrixWorld)
    if (!geom.attributes.normal) geom.computeVertexNormals()
    // skinIndex を部位ローカル順から統合スケルトン順へ張り替え
    const si = geom.attributes.skinIndex
    const remapped = new Uint16Array(si.array.length)
    for (let i = 0; i < si.array.length; i++) remapped[i] = boneIndex.get(mesh.skeleton.bones[si.array[i]].name)
    geom.setAttribute('skinIndex', new THREE.BufferAttribute(remapped, 4))
    for (const key of Object.keys(geom.attributes)) if (!attrNames.includes(key)) geom.deleteAttribute(key)
    if (geom.index) geom.deleteAttribute('index')

    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    srcDraws += mats.length
    for (const [materialIndex, sub] of splitByMaterial(geom, attrNames)) {
      const src = mats[materialIndex] || mats[0]
      // テクスチャが無いモデルなので、同じ色は1マテリアル=1ドローコールに統合できる
      const key = src.color ? src.color.getHexString() : 'ffffff'
      if (!buckets.has(key)) buckets.set(key, { mat: toStandard(src), geoms: [] })
      buckets.get(key).geoms.push(sub)
    }
  }

  const skeleton = new THREE.Skeleton(bones, boneInverses)
  const root = new THREE.Group()
  root.name = outfit
  root.scale.setScalar(CHAR.unitScale)
  root.add(armature)

  let outVerts = 0
  for (const [key, { mat, geoms }] of buckets) {
    let merged = geoms.length > 1 ? mergeGeometries(geoms, false) : geoms[0]
    if (!merged) throw new Error(`${outfit}: merge failed for ${key}`)
    const before = merged.attributes.position.count
    try { merged = mergeVertices(merged, 1e-4) } catch { /* 溶接できなければ非インデックスのまま */ }
    outVerts += merged.attributes.position.count
    merged.computeBoundingSphere()
    const sm = new THREE.SkinnedMesh(merged, mat)
    sm.name = `${outfit}_${mat.name}`
    sm.frustumCulled = false
    root.add(sm)
    sm.bind(skeleton, new THREE.Matrix4())
    void before
  }
  root.updateMatrixWorld(true)

  return { root, stats: { srcVerts, outVerts, srcDraws, outDraws: buckets.size } }
}

function buildAnimations() {
  const anim = parseFbx(path.join(SRC, 'Animations.fbx'))
  const byName = new Map(anim.animations.map((c) => [c.name.replace(/^.*\|/, ''), c]))
  const clips = []
  for (const [alias, source] of Object.entries(CLIP_MAP)) {
    const src = byName.get(source)
    if (!src) { console.warn(`  ! clip not found: ${source}`); continue }
    const clip = src.clone()
    clip.name = alias
    // 定数トラックを1キーへ縮約し、scaleトラックは丸ごと捨てる(全て1.0)
    clip.tracks = clip.tracks.filter((t) => !t.name.endsWith('.scale'))
    clip.optimize()
    clips.push(clip)
  }
  const armature = anim.children.find((c) => c.name === 'CharacterArmature') || anim
  const root = new THREE.Group()
  root.name = 'AnimationRig'
  root.scale.setScalar(CHAR.unitScale)
  root.add(armature)
  root.updateMatrixWorld(true)
  return { root, clips }
}

console.log('== characters ==')
fs.mkdirSync(OUT, { recursive: true })
for (const [outfit, parts] of Object.entries(OUTFITS)) {
  const { root, stats } = buildOutfit(outfit, parts)
  const scene = new THREE.Scene()
  scene.add(root)
  const bytes = await exportGlb(scene, [], path.join(OUT, `${outfit}.glb`))
  console.log(
    `  ${outfit.padEnd(14)} ${(bytes / 1024).toFixed(0).padStart(5)}KB  ` +
    `verts ${stats.srcVerts}→${stats.outVerts}  draws ${stats.srcDraws}→${stats.outDraws}`
  )
}

console.log('== animations ==')
const { root: rig, clips } = buildAnimations()
const animScene = new THREE.Scene()
animScene.add(rig)
const animBytes = await exportGlb(animScene, clips, path.join(OUT, 'animations.glb'))
console.log(`  animations.glb ${(animBytes / 1024).toFixed(0)}KB  clips: ${clips.map((c) => c.name).join(', ')}`)
console.log('done ->', OUT)
