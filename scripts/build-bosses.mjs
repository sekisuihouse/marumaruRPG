/**
 * ボスの配布モデル(PMX) → ゲーム用GLB へ変換する。
 *
 *   node scripts/build-bosses.mjs      （npm run build:bosses）
 *
 * 入力  : bos 3Dmoderu/<フォルダ>/<名前>.pmx ＋ Texture/*      ← 配布物そのまま。public には置かない
 * 出力  : public/assets/bosses/glb/<ボスID>.glb ＋ manifest.json
 *
 * なぜ変換するか:
 *   - PMX を実行時に解析すると 5MB 超の読み込みと MMD 用シェーダが必要になり、
 *     ブラウザでの初回表示が遅い（実測で1体しか間に合わなかった）
 *   - テクスチャ名が日本語なので、URL 経由の取得は環境差が出やすい
 *   - 既存のキャラクター(FBX→GLB)と同じ「ビルドで焼く」流儀に合わせる
 *
 * 変換でやること:
 *   1. 頂点・法線・UV・面・マテリアルとPMXのボーン/ウェイトを取り出す
 *      ※ 配布元 readme が許可している「最適化」の範囲。改変版の再配布はしない。
 *   2. 高さ1.0・足元 y=0・中心を原点へ正規化（ランタイムは displayHeight を掛けるだけでよい）
 *   3. baseColor に使うテクスチャだけを最大1024pxへ縮小して GLB に埋め込む
 *      （toon.png / スフィアマップ mc3.png は PBR で使わないので入れない）
 */
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import sharp from 'sharp'
import * as THREE from 'three'
import { MMDLoader } from 'three-stdlib'
import { BOSS_LIST } from '../src/data/bosses.js'

const SRC_ROOT = 'bos 3Dmoderu'
const OUT_DIR = 'public/assets/bosses/glb'
/** テクスチャの最大辺。2048のままだと1体あたり80MB近くVRAMを食う。 */
const MAX_TEXTURE = 1024
const JPEG_QUALITY = 86

const parser = new MMDLoader()._getParser()

// ───────────────────────────── GLB 組み立て

class GlbBuilder {
  constructor() {
    this.json = {
      asset: { version: '2.0', generator: 'marugoto build-bosses (PMX→GLB)' },
      scene: 0, scenes: [{ nodes: [0] }], nodes: [],
      meshes: [], materials: [], textures: [], images: [],
      samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
      accessors: [], bufferViews: [], buffers: [], skins: [],
    }
    this.chunks = []
    this.offset = 0
  }

  /** バイナリを追加して bufferView 番号を返す */
  addView(buffer, target = null) {
    // bufferView の開始位置は4バイト境界に揃える
    const pad = (4 - (this.offset % 4)) % 4
    if (pad) { this.chunks.push(Buffer.alloc(pad)); this.offset += pad }
    const view = { buffer: 0, byteOffset: this.offset, byteLength: buffer.length }
    if (target) view.target = target
    this.chunks.push(buffer)
    this.offset += buffer.length
    this.json.bufferViews.push(view)
    return this.json.bufferViews.length - 1
  }

  addAccessor(desc) {
    this.json.accessors.push(desc)
    return this.json.accessors.length - 1
  }

  build() {
    this.json.buffers = [{ byteLength: this.offset }]
    const bin = Buffer.concat(this.chunks)
    const jsonText = Buffer.from(JSON.stringify(this.json), 'utf8')
    const jsonPad = (4 - (jsonText.length % 4)) % 4
    const jsonChunk = Buffer.concat([jsonText, Buffer.alloc(jsonPad, 0x20)])
    const binPad = (4 - (bin.length % 4)) % 4
    const binChunk = Buffer.concat([bin, Buffer.alloc(binPad)])

    const header = Buffer.alloc(12)
    header.writeUInt32LE(0x46546c67, 0)                       // 'glTF'
    header.writeUInt32LE(2, 4)
    header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8)
    const jsonHead = Buffer.alloc(8)
    jsonHead.writeUInt32LE(jsonChunk.length, 0)
    jsonHead.writeUInt32LE(0x4e4f534a, 4)                     // 'JSON'
    const binHead = Buffer.alloc(8)
    binHead.writeUInt32LE(binChunk.length, 0)
    binHead.writeUInt32LE(0x004e4942, 4)                      // 'BIN\0'
    return Buffer.concat([header, jsonHead, jsonChunk, binHead, binChunk])
  }
}

// ───────────────────────────── テクスチャ

/**
 * PMX 内のテクスチャ名は簡体字のまま（"Texture\脸.jpg"）だが、
 * 配布フォルダのファイルは日本語にリネームされている（顔.jpg）。その対応表。
 */
const NAME_ALIASES = [
  ['脸', '顔'],       // 顔
  ['头发', '髪'],     // 髪
  ['衣服', '服'],     // 服
  ['披风', 'マント'], // マント
  ['表情', '表情'],
]

const nfc = (s) => s.normalize('NFC').toLowerCase()

/** PMX のテクスチャ表記を実ファイルへ解決する */
function resolveTexture(dir, rawPath) {
  const rel = rawPath.replace(/\\/g, '/')
  const direct = path.join(dir, rel)
  if (fs.existsSync(direct)) return direct

  // フォルダ内の全画像を集めておく（macOS の NFD 正規化があるので直接比較しない）
  const files = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(png|jpg|jpeg|bmp|tga)$/i.test(e.name)) files.push(p)
    }
  }
  walk(dir)

  const wanted = path.basename(rel)
  const stem = wanted.replace(/\.[^.]+$/, '')
  // 簡体字 → 日本語 の言い換えも候補に入れる
  const candidates = new Set([stem])
  for (const [cn, ja] of NAME_ALIASES) {
    if (stem.includes(cn)) candidates.add(stem.split(cn).join(ja))
  }

  for (const cand of candidates) {
    // 拡張子込み → 拡張子違いの順に探す（顔.jpg / 顔.png の揺れがある）
    const exact = files.find((f) => nfc(path.basename(f)) === nfc(`${cand}${path.extname(wanted)}`))
    if (exact) return exact
    const anyExt = files.find((f) => nfc(path.basename(f).replace(/\.[^.]+$/, '')) === nfc(cand))
    if (anyExt) return anyExt
  }
  return null
}

/** 縮小して埋め込み用のバイト列にする */
async function encodeTexture(file) {
  const img = sharp(file)
  const meta = await img.metadata()
  const scale = Math.min(1, MAX_TEXTURE / Math.max(meta.width, meta.height))
  const width = Math.max(1, Math.round(meta.width * scale))
  const height = Math.max(1, Math.round(meta.height * scale))
  let opaque = !meta.hasAlpha
  if (meta.hasAlpha) {
    try { opaque = (await sharp(file).stats()).isOpaque } catch { opaque = false }
  }
  const resized = sharp(file).resize(width, height, { fit: 'fill' })
  const data = opaque
    ? await resized.jpeg({ quality: JPEG_QUALITY, mozjpeg: true }).toBuffer()
    : await resized.png({ compressionLevel: 9, palette: false }).toBuffer()
  return { data, mimeType: opaque ? 'image/jpeg' : 'image/png', width, height, opaque }
}

// ───────────────────────────── 立ち姿の焼き込み
//
// 配布モデルは編集用の A ポーズ（腕が水平から約38度）で、そのまま出すと
// 案山子のように見える。モーションデータは配布物に含まれないので、
// 旧版では頂点へ焼き込んでいた。現在はスキンを保持し、ランタイムで同じ
// 補正と待機・攻撃モーションを掛ける。
// （readme が許可している「ボーンの修正・最適化」の範囲。改変版は再配布しない）

const POSE = {
  /** 腕の目標角度（水平からの下向き角度） */
  armAngleDeg: 66,
  /** 1本の腕に加える回転の上限。元がすでに下がっているモデルを壊さない */
  maxExtraDeg: 40,
  /** 腕のペア [腕ボーン, 向きを測る子ボーン] */
  arms: [['左腕', '左ひじ'], ['右腕', '右ひじ']],
}

const IDENTITY_Q = new THREE.Quaternion()
const ONE = new THREE.Vector3(1, 1, 1)

/** 腕を下ろす回転（MMD座標系・親空間）を作る */
function buildPose(data) {
  const bones = data.bones || []
  const byName = new Map(bones.map((b, i) => [b.name, i]))
  const rot = new Map()
  const applied = []
  for (const [armName, childName] of POSE.arms) {
    const ai = byName.get(armName)
    const ci = byName.get(childName)
    if (ai === undefined || ci === undefined) continue
    const a = new THREE.Vector3().fromArray(bones[ai].position)
    const c = new THREE.Vector3().fromArray(bones[ci].position)
    const dir = c.clone().sub(a)
    if (dir.lengthSq() < 1e-8) continue
    const horiz = Math.hypot(dir.x, dir.z)
    const current = (Math.atan2(-dir.y, horiz) * 180) / Math.PI
    const extra = Math.min(POSE.maxExtraDeg, Math.max(0, POSE.armAngleDeg - current))
    if (extra < 0.5) continue
    const angle = (extra * Math.PI) / 180
    // 左右で回す向きが逆になるので、「腕が下がるほう」を選ぶ
    const axis = new THREE.Vector3(0, 0, 1)
    const q1 = new THREE.Quaternion().setFromAxisAngle(axis, angle)
    const q2 = new THREE.Quaternion().setFromAxisAngle(axis, -angle)
    const down = dir.clone().applyQuaternion(q1).y < dir.clone().applyQuaternion(q2).y ? q1 : q2
    rot.set(ai, down)
    applied.push(`${armName} ${current.toFixed(0)}°→${(current + extra).toFixed(0)}°`)
  }
  return { rot, applied }
}

/** ポーズを適用したスキニング行列を求める */
function skinMatrices(data, rot) {
  const bones = data.bones || []
  const world = bones.map(() => new THREE.Matrix4())
  const resolved = new Uint8Array(bones.length)
  let remaining = bones.length
  const local = new THREE.Matrix4()
  const offset = new THREE.Vector3()
  for (let pass = 0; pass < 128 && remaining > 0; pass++) {
    let progressed = false
    for (let i = 0; i < bones.length; i++) {
      if (resolved[i]) continue
      const p = bones[i].parentIndex
      const hasParent = p >= 0 && p < bones.length
      if (hasParent && !resolved[p]) continue
      const pos = bones[i].position
      const ppos = hasParent ? bones[p].position : [0, 0, 0]
      offset.set(pos[0] - ppos[0], pos[1] - ppos[1], pos[2] - ppos[2])
      local.compose(offset, rot.get(i) || IDENTITY_Q, ONE)
      if (hasParent) world[i].multiplyMatrices(world[p], local)
      else world[i].copy(local)
      resolved[i] = 1
      remaining--
      progressed = true
    }
    if (!progressed) break        // 親子が循環している壊れたデータ対策
  }
  // 頂点に掛ける行列 = 姿勢行列 × 元の位置を原点へ戻す平行移動
  const inv = new THREE.Matrix4()
  return bones.map((b, i) => {
    inv.makeTranslation(-b.position[0], -b.position[1], -b.position[2])
    return new THREE.Matrix4().multiplyMatrices(world[i], inv)
  })
}

/** 線形ブレンドスキニングで頂点と法線を動かす */
function applyPose(data, skin) {
  if (!skin.length) return 0
  const blend = new THREE.Matrix4()
  const pos = new THREE.Vector3()
  const nor = new THREE.Vector3()
  const normalMat = new THREE.Matrix3()
  let moved = 0
  for (const v of data.vertices) {
    const idx = v.skinIndices || []
    const wts = v.skinWeights || []
    let total = 0
    for (let k = 0; k < idx.length; k++) total += wts[k] || 0
    if (total <= 1e-6) continue
    for (let e = 0; e < 16; e++) blend.elements[e] = 0
    for (let k = 0; k < idx.length; k++) {
      const w = (wts[k] || 0) / total
      if (w <= 0) continue
      const m = skin[idx[k]]
      if (!m) continue
      for (let e = 0; e < 16; e++) blend.elements[e] += m.elements[e] * w
    }
    pos.fromArray(v.position).applyMatrix4(blend)
    v.position[0] = pos.x; v.position[1] = pos.y; v.position[2] = pos.z
    normalMat.setFromMatrix4(blend)
    nor.fromArray(v.normal).applyMatrix3(normalMat).normalize()
    v.normal[0] = nor.x; v.normal[1] = nor.y; v.normal[2] = nor.z
    moved++
  }
  return moved
}

/** MMD(左手系) → three/glTF(右手系)。mmd-parser の leftToRight と同じ処理を自前で行う。 */
function toRightHanded(data) {
  for (const v of data.vertices) {
    v.position[2] = -v.position[2]
    v.normal[2] = -v.normal[2]
  }
  for (const f of data.faces) {
    const tmp = f.indices[2]
    f.indices[2] = f.indices[0]
    f.indices[0] = tmp
  }
}

// ───────────────────────────── 変換本体

async function convert(def) {
  const dir = path.join(SRC_ROOT, def.source.dir)
  if (!fs.existsSync(dir)) throw new Error(`配布フォルダが見つかりません: ${dir}`)
  // macOS のファイル名は NFD 正規化なので、日本語名を直接書かず拡張子で探す
  const pmxName = fs.readdirSync(dir).find((f) => f.toLowerCase().endsWith('.pmx'))
  if (!pmxName) throw new Error(`${dir} に .pmx がありません`)
  const pmx = path.join(dir, pmxName)

  const raw = fs.readFileSync(pmx)
  // ポーズ付けは MMD の座標系のまま行いたいので、左右系の変換は自分で後から掛ける
  const data = parser.parsePmx(
    raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), false)

  // スキンを保持するため頂点へポーズを焼き込まない。ポーズは描画時に適用する。
  const { rot, applied } = buildPose(data)
  const posedVertices = 0
  toRightHanded(data)

  const vCount = data.metadata.vertexCount
  const positions = new Float32Array(vCount * 3)
  const normals = new Float32Array(vCount * 3)
  const uvs = new Float32Array(vCount * 2)
  const joints = new Uint16Array(vCount * 4)
  const weights = new Float32Array(vCount * 4)
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let i = 0; i < vCount; i++) {
    const v = data.vertices[i]
    positions[i * 3] = v.position[0]
    positions[i * 3 + 1] = v.position[1]
    positions[i * 3 + 2] = v.position[2]
    normals[i * 3] = v.normal[0]
    normals[i * 3 + 1] = v.normal[1]
    normals[i * 3 + 2] = v.normal[2]
    uvs[i * 2] = v.uv[0]
    uvs[i * 2 + 1] = v.uv[1]        // MMDLoader と同じく flipY=false 相当。glTF の UV 原点と一致する
    let weightSum = 0
    for (let k = 0; k < 4; k++) weightSum += v.skinWeights?.[k] || 0
    for (let k = 0; k < 4; k++) {
      joints[i * 4 + k] = Math.max(0, Math.min(65535, v.skinIndices?.[k] ?? 0))
      weights[i * 4 + k] = weightSum > 1e-6 ? (v.skinWeights?.[k] || 0) / weightSum : (k === 0 ? 1 : 0)
    }
    if (v.position[0] < minX) minX = v.position[0]
    if (v.position[0] > maxX) maxX = v.position[0]
    if (v.position[1] < minY) minY = v.position[1]
    if (v.position[1] > maxY) maxY = v.position[1]
    if (v.position[2] < minZ) minZ = v.position[2]
    if (v.position[2] > maxZ) maxZ = v.position[2]
  }

  // 高さ1.0・足元 y=0・中心を原点へ（ランタイムは displayHeight を掛けるだけでよい）
  const srcHeight = maxY - minY
  const s = 1 / Math.max(1e-6, srcHeight)
  const cx = (minX + maxX) / 2
  const cz = (minZ + maxZ) / 2
  const box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }
  for (let i = 0; i < vCount; i++) {
    positions[i * 3] = (positions[i * 3] - cx) * s
    positions[i * 3 + 1] = (positions[i * 3 + 1] - minY) * s
    positions[i * 3 + 2] = (positions[i * 3 + 2] - cz) * s
    for (let a = 0; a < 3; a++) {
      const val = positions[i * 3 + a]
      if (val < box.min[a]) box.min[a] = val
      if (val > box.max[a]) box.max[a] = val
    }
  }

  const indices = new Uint32Array(data.metadata.faceCount * 3)
  for (let i = 0; i < data.metadata.faceCount; i++) {
    const f = data.faces[i].indices
    indices[i * 3] = f[0]
    indices[i * 3 + 1] = f[1]
    indices[i * 3 + 2] = f[2]
  }

  const glb = new GlbBuilder()
  const posView = glb.addView(Buffer.from(positions.buffer), 34962)
  const norView = glb.addView(Buffer.from(normals.buffer), 34962)
  const uvView = glb.addView(Buffer.from(uvs.buffer), 34962)
  const jointView = glb.addView(Buffer.from(joints.buffer), 34962)
  const weightView = glb.addView(Buffer.from(weights.buffer), 34962)
  const idxView = glb.addView(Buffer.from(indices.buffer), 34963)

  const posAcc = glb.addAccessor({ bufferView: posView, componentType: 5126, count: vCount, type: 'VEC3', min: box.min, max: box.max })
  const norAcc = glb.addAccessor({ bufferView: norView, componentType: 5126, count: vCount, type: 'VEC3' })
  const uvAcc = glb.addAccessor({ bufferView: uvView, componentType: 5126, count: vCount, type: 'VEC2' })
  const jointAcc = glb.addAccessor({ bufferView: jointView, componentType: 5123, count: vCount, type: 'VEC4' })
  const weightAcc = glb.addAccessor({ bufferView: weightView, componentType: 5126, count: vCount, type: 'VEC4' })

  // ── テクスチャ（baseColor に使うものだけ埋め込む）
  const texCache = new Map()          // PMXのテクスチャ番号 → glTFのtexture番号
  const texInfo = []
  const addTexture = async (index) => {
    if (index === undefined || index === null || index < 0) return null
    if (texCache.has(index)) return texCache.get(index)
    const file = resolveTexture(dir, data.textures[index] || '')
    if (!file) {
      console.warn(`  ! テクスチャが見つかりません: ${data.textures[index]}`)
      texCache.set(index, null)
      return null
    }
    const enc = await encodeTexture(file)
    const view = glb.addView(enc.data)
    glb.json.images.push({ bufferView: view, mimeType: enc.mimeType, name: path.basename(file) })
    glb.json.textures.push({ sampler: 0, source: glb.json.images.length - 1 })
    const id = glb.json.textures.length - 1
    texCache.set(index, id)
    texInfo.push({ name: path.basename(file), size: `${enc.width}x${enc.height}`, kb: Math.round(enc.data.length / 1024), type: enc.mimeType })
    return id
  }

  const primitives = []
  let faceOffset = 0
  let skipped = 0
  for (let i = 0; i < data.metadata.materialCount; i++) {
    const m = data.materials[i]
    const faceCount = m.faceCount
    const start = faceOffset
    faceOffset += faceCount
    if (faceCount <= 0) continue
    const alpha = m.diffuse[3] ?? 1
    if (alpha <= 0.01) { skipped++; continue }        // 完全透明のマテリアルは出力しない

    const tex = await addTexture(m.textureIndex)
    const mat = {
      name: m.name || `material_${i}`,
      doubleSided: (m.flag & 1) === 1,
      pbrMetallicRoughness: {
        baseColorFactor: [m.diffuse[0], m.diffuse[1], m.diffuse[2], alpha],
        metallicFactor: 0,
        roughnessFactor: 0.72,
      },
    }
    if (tex !== null) mat.pbrMetallicRoughness.baseColorTexture = { index: tex }
    // 半透明マテリアルは合成、PNG（顔の表情など）は抜き色として扱う
    const png = tex !== null && glb.json.images[glb.json.textures[tex].source].mimeType === 'image/png'
    if (alpha < 0.99) mat.alphaMode = 'BLEND'
    else if (png) { mat.alphaMode = 'MASK'; mat.alphaCutoff = 0.5 }
    glb.json.materials.push(mat)

    const idxAcc = glb.addAccessor({
      bufferView: idxView, byteOffset: start * 3 * 4,
      componentType: 5125, count: faceCount * 3, type: 'SCALAR',
    })
    primitives.push({
      attributes: { POSITION: posAcc, NORMAL: norAcc, TEXCOORD_0: uvAcc, JOINTS_0: jointAcc, WEIGHTS_0: weightAcc },
      indices: idxAcc,
      material: glb.json.materials.length - 1,
    })
  }

  glb.json.meshes.push({ name: def.id, primitives })
  // PMXの骨格をglTF skinとして保存する。頂点とボーンは同じ正規化・右手系変換を使う。
  const bones = data.bones || []
  const boneNode = bones.map((_, i) => i + 1)
  const local = bones.map((bone) => {
    const p = bone.position || [0, 0, 0]
    const parent = bones[bone.parentIndex]
    const pp = parent?.position || [cx, minY, -cz]
    return [(p[0] - pp[0]) * s, (p[1] - pp[1]) * s, -(p[2] - pp[2]) * s]
  })
  const global = bones.map((bone) => {
    const p = bone.position || [0, 0, 0]
    return [(p[0] - cx) * s, (p[1] - minY) * s, (-p[2] - cz) * s]
  })
  const children = bones.map(() => [])
  const roots = []
  bones.forEach((bone, i) => {
    if (bone.parentIndex >= 0 && bone.parentIndex < bones.length) children[bone.parentIndex].push(boneNode[i])
    else roots.push(boneNode[i])
  })
  glb.json.nodes.push({ mesh: 0, skin: 0, name: def.id })
  bones.forEach((bone, i) => {
    const node = { name: bone.name || `bone_${i}`, translation: local[i] }
    if (children[i].length) node.children = children[i]
    glb.json.nodes.push(node)
  })
  const inverse = new Float32Array(Math.max(1, bones.length) * 16)
  for (let i = 0; i < bones.length; i++) {
    inverse.set(new THREE.Matrix4().makeTranslation(-global[i][0], -global[i][1], -global[i][2]).elements, i * 16)
  }
  const inverseView = glb.addView(Buffer.from(inverse.buffer))
  const inverseAcc = glb.addAccessor({ bufferView: inverseView, componentType: 5126, count: bones.length, type: 'MAT4' })
  glb.json.skins.push({ name: `${def.id}_skeleton`, inverseBindMatrices: inverseAcc, joints: boneNode, skeleton: roots[0] ?? 0 })
  glb.json.scenes[0].nodes = [0, ...roots]

  const out = glb.build()
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const file = path.join(OUT_DIR, `${def.id}.glb`)
  fs.writeFileSync(file, out)

  return {
    id: def.id,
    name: def.name,
    source: `${def.source.dir}/${pmxName}`,
    file: `${OUT_DIR}/${def.id}.glb`,
    sizeKB: Math.round(out.length / 1024),
    vertices: vCount,
    triangles: data.metadata.faceCount,
    materials: primitives.length,
    skippedMaterials: skipped,
    textures: texInfo,
    /** 元モデルの高さ(MMD単位)。GLBは高さ1.0に正規化してある。 */
    sourceHeight: +srcHeight.toFixed(2),
    displayHeight: def.displayHeight,
    pose: applied,
    posedVertices,
  }
}

// ───────────────────────────── 実行

const report = []
for (const def of BOSS_LIST) {
  if (!def.source) { console.warn(`${def.id}: source が未設定なので飛ばします`); continue }
  process.stdout.write(`${def.id} … `)
  const r = await convert(def)
  report.push(r)
  console.log(`${r.sizeKB}KB / ${r.triangles}三角形 / マテリアル${r.materials} / テクスチャ${r.textures.length}`)
  if (r.pose.length) console.log(`      立ち姿: ${r.pose.join(' , ')}（${r.posedVertices}頂点）`)
  else console.log('      立ち姿: 腕ボーンが見つからないため元のポーズのまま')
  for (const t of r.textures) console.log(`      ${t.name} ${t.size} ${t.kb}KB`)
}

fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  note: '配布元(miHoYo)のPMXから変換したゲーム用データ。元データは bos 3Dmoderu/ にあり public には置かない。',
  bosses: report,
}, null, 1))

const total = report.reduce((a, r) => a + r.sizeKB, 0)
console.log(`\n${OUT_DIR}/ に ${report.length} 体を出力しました（合計 ${(total / 1024).toFixed(1)}MB）`)
void url
