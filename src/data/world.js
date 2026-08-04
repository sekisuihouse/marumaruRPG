// 世界の共通定数。ビルドスクリプト(scripts/*.mjs)とランタイム(src/*)の
// 両方から import されるため、three や CSS への依存を持たせない。

// Vite public配下の素材は、GitHub Pagesでは /<repo>/assets/... になる。
// Nodeで実行するビルド/スモークスクリプトにも読まれるので、Vite環境外では '/'.
const PUBLIC_BASE = typeof import.meta.env !== 'undefined' ? import.meta.env.BASE_URL : '/'
export const assetUrl = (path) => `${PUBLIC_BASE}${String(path).replace(/^\//, '')}`

/** 町GLBの配置。navmesh のベイクとランタイム描画で必ず同じ値を使う。 */
export const TOWN = {
  url: assetUrl('assets/town.glb'),
  /** town.glb 内の人物プロップ(歩く(Man)等)が約0.38単位なので、身長1.7mを基準に6倍。 */
  scale: 6,
  position: [0, 0, 0],
  rotationY: 0,
}

/** NavMesh グリッド設定。セル0.375mで約120m四方をカバーする。 */
export const NAV = {
  /**
   * セル一辺(m)。ラスタライズの粒度がそのまま当たり判定の太さになるので、
   * 信号機のポールや鳥居の柱が実物大で抜けるよう 0.375m まで細かくしている。
   */
  cell: 0.375,
  halfExtent: 58,
  /** 歩ける高さの範囲(ワールドm)。これを外れた接地点は非歩行。 */
  minY: -1.5,
  maxY: 6.5,
  /** 一歩で登り降りできる段差の上限(m)。ランタイムの move() で判定する。 */
  maxStep: 0.55,
  /** プレイヤーの半径(m)。壁ずり計算で使用。 */
  agentRadius: 0.3,
}

/** キャラクターGLBの出力先。 */
export const CHAR = {
  dir: assetUrl('assets/characters/glb'),
  /** GLB内でルートに掛けたスケール(FBX単位→m)。参照用。 */
  unitScale: 0.01,
}

export const SPAWN = { x: 4, z: 20 }

// ボス導入前の開発用セーブ（破壊状態を含む）を新規ゲームへ持ち込まない。
export const SAVE_KEY = 'marugoto.save.v2'
