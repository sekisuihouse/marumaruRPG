/**
 * town.glb を再利用しやすい個別GLBライブラリへ分離する。
 *
 *   npm run build:town-library
 *
 * 元データは変更しない。town.glb のトップレベルオブジェクトを1つずつ出力し、
 * ゲームで使っているマテリアル色・透明度・頂点カラーを保ったまま、原点へ整列する。
 * worldUnitScale=6 は Town と同じため、出力GLBは敵の武器・小道具として直接使える。
 */
import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { categoryOf } from '../src/data/destructibles.js'
import { TOWN } from '../src/data/world.js'

if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class FileReader {
    readAsArrayBuffer(blob) { blob.arrayBuffer().then((buffer) => { this.result = buffer; this.onloadend?.() }) }
  }
}

const SOURCE = 'public/assets/town.glb'
const OUT = 'public/assets/town-library'
const UNIT_SCALE = TOWN.scale

const FOLDER_BY_CATEGORY = {
  building: 'buildings', structure: 'structures', prop: 'props', people: 'people',
  nature: 'environment/nature', ground: 'environment/ground', water: 'environment/water', fx: 'effects',
}
const WEAPON_CANDIDATE = /^(トラック|車|Bus|自転車|すだち箱|一方通行|ガードレール|ぼうつき|スコップで掘る)/
const TAGS = [
  [/古民家|カフェ|温泉|コンビニ|パン屋|集会所|HOME|ROOMS|Office|ガソスタ|社|キャンプ|ステージ|物販|マルシェ|飲食|学生体験/, 'building'],
  [/トラック|車|Bus/, 'vehicle'], [/自転車/, 'bicycle'], [/鳥居|ガードレール|一方通行|ぼうつき/, 'street-fixture'],
  [/ブランコ|滑り台/, 'playground'], [/歩く|お話|聞き手|店員|作業|寝転がり|天を仰ぐ|阿波踊り|スコップで掘る/, 'human-prop'],
  [/杉|イチョウ|すだち/, 'plant'], [/花火/, 'effect'],
]

const cleanName = (name) => String(name || 'unnamed')
  .normalize('NFC').replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
const fileStem = (index, name) => `${String(index + 1).padStart(3, '0')}_${cleanName(name) || 'unnamed'}`
const tagsFor = (name, category) => [category, ...TAGS.filter(([re]) => re.test(name)).map(([, tag]) => tag), ...(WEAPON_CANDIDATE.test(name) ? ['weapon-candidate'] : [])]

function materialSummary(root) {
  const materials = new Map()
  root.traverse((node) => {
    if (!node.isMesh) return
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
      if (!material || materials.has(material.uuid)) continue
      materials.set(material.uuid, {
        name: material.name || 'material', color: material.color ? `#${material.color.getHexString()}` : null,
        opacity: material.opacity ?? 1, transparent: Boolean(material.transparent), vertexColors: Boolean(material.vertexColors),
      })
    }
  })
  return [...materials.values()]
}

function prepareAsset(source) {
  const root = source.clone(true)
  root.scale.multiplyScalar(UNIT_SCALE)
  root.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(root)
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  // 武器／小道具として扱いやすい原点（水平中心・接地面）へ移す。
  root.position.x -= center.x
  root.position.y -= box.min.y
  root.position.z -= center.z
  root.updateMatrixWorld(true)
  return { root, size }
}

async function exportGlb(root, target) {
  const buffer = await new GLTFExporter().parseAsync(root, { binary: true, onlyVisible: false, includeCustomExtensions: false })
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, Buffer.from(buffer))
  return buffer.byteLength
}

if (!fs.existsSync(SOURCE)) throw new Error(`入力の町モデルがありません: ${SOURCE}`)
const bytes = fs.readFileSync(SOURCE)
const gltf = await new Promise((resolve, reject) => new GLTFLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '', resolve, reject))
const assets = []
for (const [index, object] of gltf.scene.children.entries()) {
  const category = categoryOf(object.name)
  const folder = FOLDER_BY_CATEGORY[category] || 'environment/misc'
  const stem = fileStem(index, object.name)
  const relativePath = path.posix.join(folder, `${stem}.glb`)
  const { root, size } = prepareAsset(object)
  const target = path.join(OUT, relativePath)
  const byteLength = await exportGlb(root, target)
  const tags = tagsFor(object.name, category)
  assets.push({
    id: stem, name: object.name, category, tags, file: relativePath, sourceNode: index,
    worldUnitScale: UNIT_SCALE, dimensions: { x: +size.x.toFixed(3), y: +size.y.toFixed(3), z: +size.z.toFixed(3) },
    materials: materialSummary(root), byteLength,
    weaponUse: tags.includes('weapon-candidate') ? { recommended: true, attachBone: 'WristR', note: '敵の武器・投擲物・障害物として使える。大きさは敵側で調整すること。' } : null,
  })
}

const manifest = {
  source: SOURCE, generatedAt: new Date().toISOString(), worldUnitScale: UNIT_SCALE,
  usage: '各GLBは原点・接地面へ整列済み。敵の手へ装着する場合は weaponUse.attachBone を基準にする。',
  categories: Object.fromEntries(Object.keys(FOLDER_BY_CATEGORY).map((category) => [category, assets.filter((asset) => asset.category === category).length])),
  weaponCandidates: assets.filter((asset) => asset.weaponUse).map((asset) => asset.id),
  assets,
}
fs.mkdirSync(OUT, { recursive: true })
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2))
const weaponCatalog = {
  generatedAt: manifest.generatedAt,
  source: manifest.source,
  note: '町モデルから敵の即席武器として再利用しやすい要素を抽出した参照カタログです。実体GLBはカテゴリ別フォルダに一度だけ保持します。敵へ装着するときは file を GLTFLoader で読み込み、敵モデルの手首ボーンへ必要な縮尺・回転でアタッチしてください。',
  assets: assets
    .filter((asset) => asset.weaponUse?.recommended)
    .map(({ id, name, category, file, dimensions, weaponUse }) => ({
      id,
      name,
      category,
      file,
      dimensions,
      ...weaponUse,
    })),
}
fs.mkdirSync(path.join(OUT, 'weapons'), { recursive: true })
fs.writeFileSync(path.join(OUT, 'weapons', 'manifest.json'), JSON.stringify(weaponCatalog, null, 2))
fs.writeFileSync(path.join(OUT, 'README.md'), `# Town Asset Library\n\n- 元データ: \`${SOURCE}\`（変更しません）\n- 単位: 1 = ゲーム内1m（町の配置倍率 ${UNIT_SCALE} を適用済み）\n- \`manifest.json\` に日本語名、分類、寸法、材質色、武器候補を収録\n- \`props/\` と \`structures/\` の \`weapon-candidate\` は敵の手・投擲物向け候補\n`)

console.log(`town-library を生成しました: ${assets.length} 個`)
console.log(`  出力: ${OUT}`)
console.log(`  武器候補: ${manifest.weaponCandidates.length} 個`)
