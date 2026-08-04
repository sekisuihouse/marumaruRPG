// 開発時だけ、同じ種別を最大1秒に1回出すネットワーク診断ログ。
const enabled = typeof import.meta.env !== 'undefined' && !!import.meta.env.DEV
const last = new Map()
export function netDebug(tag, data, interval = 1000) {
  if (!enabled) return
  const now = performance.now()
  if (now - (last.get(tag) || -Infinity) < interval) return
  last.set(tag, now)
  console.debug(`[${tag}]`, data)
}
