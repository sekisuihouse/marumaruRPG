/**
 * 開発モード限定の「町小道具弾」。
 *
 * town-library は town.glb から分離した実データで、GLB 内のマテリアル
 * （画像テクスチャがあるモデルではその参照も含む）をそのまま表示する。
 * 大きさの違う車・自転車・箱を、飛び道具として見やすい同程度の大きさへ
 * 正規化するために sourceSize を使う。
 */
export const DEBUG_PROP_SHOT_ASSETS = Object.freeze([
  { id: 'truck', label: 'トラック', file: '/assets/town-library/props/001_トラック.glb', sourceSize: [26.854, 1.636, 43.366] },
  { id: 'mini-truck', label: '小型トラック', file: '/assets/town-library/props/004_トラック002.glb', sourceSize: [3.57, 1.561, 2.765] },
  { id: 'car', label: '車', file: '/assets/town-library/props/005_車001.glb', sourceSize: [38.554, 1.398, 49.063] },
  { id: 'bus', label: 'バス', file: '/assets/town-library/props/065_Bus.glb', sourceSize: [6.68, 2.546, 3.161] },
  { id: 'bus-2', label: 'バス', file: '/assets/town-library/props/066_Bus001.glb', sourceSize: [6.195, 2.546, 5.977] },
  { id: 'sudachi-box', label: 'すだち箱', file: '/assets/town-library/props/071_すだち箱.glb', sourceSize: [1.032, 0.528, 0.65] },
  { id: 'bicycle', label: '自転車', file: '/assets/town-library/props/073_自転車004.glb', sourceSize: [8.869, 1.197, 9.332] },
  { id: 'bicycle-2', label: '自転車', file: '/assets/town-library/props/074_自転車005.glb', sourceSize: [6.901, 1.357, 6.782] },
])

/** 連打時もシミュレーションと描画のプールを超えないようにする。 */
export const DEBUG_PROP_SHOT_MAX_ACTIVE = 12

/** 実戦用の通常攻撃と同じ damageTarget / projectile 経路へ渡す攻撃定義。 */
export const DEBUG_PROP_SHOT_ATTACK = Object.freeze({
  id: 'debug-prop-shot',
  label: '町小道具弾',
  power: 34,
  element: 'physical',
  kind: 'magic',
  knockback: 5.8,
  speed: 31,
  radius: 0.42,
  pierce: false,
})

export function debugPropProjectileScale(asset) {
  const largest = Math.max(...(asset?.sourceSize || [1]))
  // 最大辺がおよそ1.35mになるよう正規化。小箱だけは小さくなりすぎない。
  return Math.max(0.12, Math.min(1.45, 1.35 / Math.max(0.01, largest)))
}
