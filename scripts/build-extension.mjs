/**
 * ビルド結果を Chrome 拡張機能フォルダへ同期する。
 *
 *   npm run build && node scripts/build-extension.mjs
 *   （まとめて: npm run build:extension）
 *
 * 拡張機能側のレイアウト:
 *   marugoto-tensei-extension/
 *     manifest.json / content.js / content.css   ← 手書き。触らない
 *     game/index.html                            ← dist/index.html
 *     assets/…                                   ← dist/assets/…
 *
 * dist/index.html は `/assets/…` を絶対パスで参照するので、
 * assets を拡張機能のルートに置けばそのまま解決できる。
 */
import fs from 'node:fs'
import path from 'node:path'

const DIST = 'dist'
const EXT = 'marugoto-tensei-extension'
const GAME_DIR = path.join(EXT, 'game')
const ASSETS_DIR = path.join(EXT, 'assets')

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error('dist/index.html がありません。先に npm run build を実行してください。')
  process.exit(1)
}

// 古いビルド成果物を消してから入れ直す（ハッシュ付きファイル名が残るのを防ぐ）
fs.rmSync(GAME_DIR, { recursive: true, force: true })
fs.rmSync(ASSETS_DIR, { recursive: true, force: true })
fs.mkdirSync(GAME_DIR, { recursive: true })

fs.copyFileSync(path.join(DIST, 'index.html'), path.join(GAME_DIR, 'index.html'))
fs.cpSync(path.join(DIST, 'assets'), ASSETS_DIR, { recursive: true })

const count = (dir) => {
  let n = 0, bytes = 0
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { const r = count(p); n += r.n; bytes += r.bytes }
    else { n++; bytes += fs.statSync(p).size }
  }
  return { n, bytes }
}
const { n, bytes } = count(ASSETS_DIR)
console.log(`${EXT}/ を更新しました`)
console.log(`  game/index.html + assets ${n} ファイル (${(bytes / 1024 / 1024).toFixed(1)}MB)`)
console.log('  Chrome の「パッケージ化されていない拡張機能を読み込む」で再読み込みしてください。')
