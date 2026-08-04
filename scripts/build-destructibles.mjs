/**
 * town.glb を走査して「破壊用データ」を書き出す。元GLBは一切変更しない。
 *
 *   node scripts/build-destructibles.mjs   →  public/assets/destructibles.json
 *
 * 出力内容:
 *   - トップレベル名 → 分類 の対応表（名前を推測せず、実物を見て作る）
 *   - 分割後の小片の数・部位・HP・質量などの統計
 *
 * ランタイム(src/gfx/townBuild.js)は同じ規則で同じ小片を作るので、この JSON は
 * 検証と調整のための資料であり、ゲームの起動には必須ではない。
 */
import fs from 'node:fs'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { buildTown } from '../src/gfx/townBuild.js'
import { categoryOf, BREAKABLE } from '../src/data/destructibles.js'

const OUT = 'public/assets/destructibles.json'
const SRC = 'public/assets/town.glb'

const gltf = await new Promise((res, rej) =>
  new GLTFLoader().parse(new Uint8Array(fs.readFileSync(SRC)).buffer, '', res, rej))

// 名前 → 分類の対応表（実際の GLB のトップレベル名だけを載せる）
const table = gltf.scene.children.map((o) => {
  const category = categoryOf(o.name)
  return { name: o.name, category, breakable: BREAKABLE.has(category) }
})

const { parts, stats } = buildTown(gltf.scene, { withGeometry: false })

const byObject = new Map()
const byType = {}
for (const p of parts) {
  byObject.set(p.objectName, (byObject.get(p.objectName) || 0) + 1)
  byType[p.partType] = (byType[p.partType] || 0) + 1
}

const out = {
  source: SRC,
  generatedAt: new Date().toISOString(),
  stats: {
    ...stats,
    partTypes: byType,
    breakableObjects: byObject.size,
    totalHp: Math.round(parts.reduce((a, p) => a + p.maxHp, 0)),
  },
  /** 名前 → 分類 の対応表 */
  classification: table,
  /** オブジェクトごとの小片数と代表値 */
  objects: [...byObject.entries()].map(([name, count]) => {
    const list = parts.filter((p) => p.objectName === name)
    return {
      name,
      category: list[0].category,
      chunks: count,
      hp: Math.round(list.reduce((a, p) => a + p.maxHp, 0)),
      types: [...new Set(list.map((p) => p.partType))],
    }
  }).sort((a, b) => b.chunks - a.chunks),
}

fs.writeFileSync(OUT, JSON.stringify(out, null, 1))

const nonBreak = table.filter((t) => !t.breakable)
console.log(`${OUT} を書き出しました`)
console.log(`  トップレベル ${table.length} 個 / 破壊対象 ${table.length - nonBreak.length} 個`)
console.log(`  小片 ${stats.parts} 個 (${JSON.stringify(byType)})`)
console.log(`  除外: ${[...new Set(nonBreak.map((t) => t.category))].join(', ')}`)