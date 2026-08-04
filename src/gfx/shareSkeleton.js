/**
 * GLTFExporter は SkinnedMesh ごとに glTF skin を1つ書き出すため、
 * ビルド時に1本のスケルトンへ統合しても、読み戻すとメッシュ数だけ
 * Skeleton インスタンスが生まれてしまう(骨自体は共有されている)。
 *
 * Skeleton が9個あると毎フレーム 9×79 本のボーン行列計算とボーンテクスチャ更新が走る。
 * 骨の並びが完全に一致していれば1つに束ねられるので、読み込み後にここで統合する。
 *
 * @returns {{meshes:number, skeletons:number, shared:boolean}}
 */
export function shareSkeleton(root) {
  const skinned = []
  root.traverse((o) => { if (o.isSkinnedMesh) skinned.push(o) })
  if (skinned.length <= 1) {
    return { meshes: skinned.length, skeletons: skinned.length, shared: false }
  }

  const base = skinned[0].skeleton
  // 骨のインスタンスと並びが完全一致していなければ触らない(安全側に倒す)
  const shareable = skinned.every((m) => {
    const b = m.skeleton.bones
    return b.length === base.bones.length && b.every((bone, i) => bone === base.bones[i])
  })
  if (!shareable) {
    return { meshes: skinned.length, skeletons: new Set(skinned.map((m) => m.skeleton)).size, shared: false }
  }

  for (let i = 1; i < skinned.length; i++) {
    const m = skinned[i]
    const old = m.skeleton
    m.bind(base, m.bindMatrix)
    old.dispose?.()
  }
  return { meshes: skinned.length, skeletons: 1, shared: true }
}
