/**
 * BGM。ボス戦の間だけ流すために使う。
 *
 * Web Audio ではなく HTMLAudioElement を使う。長い曲をストリーミングで扱えて、
 * ループ・音量・停止が素直に書けるため。
 * 自動再生はユーザー操作の後でないと拒否されるので、失敗しても黙って諦める
 * （タイトルのボタンを押した後なので、実プレイでは通る）。
 */
import { sim } from './sim.js'
import { assetUrl } from '../data/world.js'

export const TRACKS = {
  /** ボス戦（配布素材「追跡者.mp3」） */
  bossChase: 'assets/audio/boss-chase.mp3',
}

let element = null
let currentTrack = ''
let fade = null

const volumeFor = () => (sim.settings.muteSfx ? 0 : (sim.settings.musicVolume ?? 0.55))

function ensure() {
  if (element || typeof Audio === 'undefined') return element
  element = new Audio()
  element.loop = true
  element.preload = 'auto'
  element.volume = 0
  return element
}

/** 曲を流す。すでに同じ曲なら何もしない。 */
export function playMusic(track) {
  const el = ensure()
  if (!el) return false
  const url = assetUrl(TRACKS[track] || track)
  if (currentTrack === track && !el.paused) { el.volume = volumeFor(); return true }
  currentTrack = track
  el.src = url
  el.currentTime = 0
  el.volume = 0
  const started = el.play()
  if (started?.catch) started.catch(() => { /* 自動再生が拒否された環境 */ })
  // いきなり最大音量だと驚くので短くフェードイン
  clearInterval(fade)
  fade = setInterval(() => {
    const target = volumeFor()
    el.volume = Math.min(target, el.volume + 0.06)
    if (el.volume >= target - 0.001) clearInterval(fade)
  }, 60)
  return true
}

/** 曲を止める（少しフェードアウトしてから） */
export function stopMusic() {
  if (!element) return
  currentTrack = ''
  clearInterval(fade)
  const el = element
  fade = setInterval(() => {
    el.volume = Math.max(0, el.volume - 0.08)
    if (el.volume <= 0.001) { clearInterval(fade); el.pause(); el.currentTime = 0 }
  }, 50)
}

/** 設定変更を今の再生へ反映する */
export function refreshMusicVolume() {
  if (element && currentTrack) element.volume = volumeFor()
}

export const currentMusic = () => currentTrack
/** 開発用: 実際に鳴っているかを確認する */
export const musicState = () => (element
  ? { track: currentTrack, src: element.src.split('/').pop(), paused: element.paused, volume: +element.volume.toFixed(2), loop: element.loop, time: +element.currentTime.toFixed(1) }
  : { track: '', src: null, paused: true, volume: 0, loop: false, time: 0 })
