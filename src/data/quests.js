/**
 * クエストと会話データ。
 *
 * クエストは steps の配列で進行する。各 step は kind で判定方法が決まる:
 *   talk    … 指定NPCと会話する
 *   kill    … 指定タイプの敵を count 体倒す
 *   visit   … 指定ランドマークの半径内に入る
 *   collect … 指定アイテムを count 個持つ
 *
 * 会話は node ベースの分岐。choices の効果:
 *   next        … 次のノードへ
 *   quest       … クエスト開始
 *   advance     … 現在の talk ステップを進める
 *   reward      … 金/経験値/アイテム
 *   close       … 会話終了
 */

export const NPCS = [
  {
    id: 'minato',
    name: 'ミナト',
    model: 'Farmer',
    at: '畑',
    role: '畑の番人',
    idle: 'interact',
    root: 'greet',
    nodes: {
      greet: {
        text: '畑が工房ガーディアンに踏み荒らされてしまった。追い払ってくれないか？',
        choices: [
          { label: '引き受ける', quest: 'q_field', next: 'accept' },
          { label: '敵のことを教えて', next: 'lore' },
          { label: '今はやめておく', close: true, text: 'そうか。気が変わったらまた来てくれ。' },
        ],
      },
      lore: {
        text: '工房ガーディアンは土の属性だ。水の攻撃に弱い。突進の前には必ず身を沈めるから、そこで横に避けるといい。',
        choices: [{ label: '引き受ける', quest: 'q_field', next: 'accept' }, { label: '戻る', next: 'greet' }],
      },
      accept: {
        text: '頼んだぞ。3体倒せば畑は落ち着くはずだ。',
        choices: [{ label: '行ってくる', close: true }],
      },
      progress: {
        text: 'まだ畑の周りが騒がしい。頼むぞ。',
        choices: [{ label: '進める', close: true }],
      },
      done: {
        text: 'よくやってくれた！ 畑の恵みを持っていけ。',
        choices: [{ label: '受け取る', reward: { gold: 60, xp: 80, item: 'veg_basket' }, advance: true, close: true }],
      },
    },
  },
  {
    id: 'yui',
    name: 'ユイ',
    model: 'Casual_Hoodie',
    at: 'パン屋',
    role: 'パン職人',
    idle: 'wave',
    root: 'greet',
    nodes: {
      greet: {
        text: '鎮守の社に「王の号令」が居座っていて、お参りできないの。なんとかならない？',
        choices: [
          { label: '社へ向かう', quest: 'q_shrine', next: 'accept' },
          { label: '戦い方のコツを聞く', next: 'tips' },
          { label: 'また来る', close: true },
        ],
      },
      tips: {
        text: 'Qキーで盾を構えると正面のダメージを7割カットできる。ただしガード不能の強打は避けるしかない。Spaceで回避ローリングよ。',
        choices: [{ label: '社へ向かう', quest: 'q_shrine', next: 'accept' }, { label: '戻る', next: 'greet' }],
      },
      accept: { text: '王の号令は光属性。闇の攻撃が効くけれど、まずは回復させる前に押し切って。', choices: [{ label: '行く', close: true }] },
      progress: { text: '社はまだ騒がしい？ 気をつけてね。', choices: [{ label: '進める', close: true }] },
      done: { text: 'ありがとう！ 焼きたてを持っていって。', choices: [{ label: '受け取る', reward: { gold: 90, xp: 140, item: 'bread' }, advance: true, close: true }] },
    },
  },
  {
    id: 'sora',
    name: 'ソラ',
    model: 'Beach',
    at: 'ステージ',
    role: '祭の司会',
    idle: 'wave',
    root: 'greet',
    nodes: {
      greet: {
        text: '夜になるとステージに「星詠み」が現れる。祭の本番までに静めてほしいんだ。',
        choices: [
          { label: '夜に来る', quest: 'q_night', next: 'accept' },
          { label: '星詠みって？', next: 'lore' },
          { label: '興味ない', close: true },
        ],
      },
      lore: {
        text: '雷の魔法使いだ。詠唱が始まると足元に光の輪が出る。輪の外へ走れば範囲魔法は当たらない。土の攻撃に弱いらしい。',
        choices: [{ label: '夜に来る', quest: 'q_night', next: 'accept' }, { label: '戻る', next: 'greet' }],
      },
      accept: { text: '夜だけ現れる。空が暗くなるまで待つか、他の用事を済ませてくるといい。', choices: [{ label: 'わかった', close: true }] },
      progress: { text: 'まだ星詠みが残っている。夜を待って。', choices: [{ label: '進める', close: true }] },
      done: { text: '祭が守られた！ 主役はあなただ。', choices: [{ label: '受け取る', reward: { gold: 150, xp: 240, item: 'festival_fan' }, advance: true, close: true }] },
    },
  },
  {
    id: 'kaji',
    name: 'カジ',
    model: 'Casual_2',
    at: '集会所',
    role: '自警団',
    idle: 'idle_sword',
    root: 'greet',
    nodes: {
      greet: {
        text: '町の見回りを手伝ってほしい。温泉とコンビニ、給油スタンドを見てきてくれ。',
        choices: [
          { label: '見回りを始める', quest: 'q_patrol', next: 'accept' },
          { label: '報酬は？', next: 'pay' },
          { label: 'また今度', close: true },
        ],
      },
      pay: { text: '町の資金から出す。悪くない額だぞ。', choices: [{ label: '始める', quest: 'q_patrol', next: 'accept' }, { label: '戻る', next: 'greet' }] },
      accept: { text: '3か所回ればいい。ミニマップ(Mキー)に印が出る。', choices: [{ label: '行く', close: true }] },
      progress: { text: 'まだ回っていない場所があるな。', choices: [{ label: '進める', close: true }] },
      done: { text: '助かった。これは礼だ。', choices: [{ label: '受け取る', reward: { gold: 120, xp: 160 }, advance: true, close: true }] },
    },
  },
]

export const QUESTS = [
  {
    id: 'q_field',
    title: '畑を荒らす者',
    giver: 'minato',
    autoStart: false,
    steps: [
      { kind: 'kill', typeId: 'Worker', count: 3, label: '工房ガーディアンを3体倒す' },
      { kind: 'talk', npcId: 'minato', label: 'ミナトに報告する' },
    ],
    reward: { gold: 60, xp: 80 },
  },
  {
    id: 'q_shrine',
    title: '社の主',
    giver: 'yui',
    autoStart: false,
    steps: [
      { kind: 'visit', landmark: '社', label: '鎮守の社へ行く' },
      { kind: 'kill', typeId: 'King', count: 1, label: '王の号令を倒す' },
      { kind: 'talk', npcId: 'yui', label: 'ユイに報告する' },
    ],
    reward: { gold: 90, xp: 140 },
  },
  {
    id: 'q_night',
    title: '夜の星詠み',
    giver: 'sora',
    autoStart: false,
    steps: [
      { kind: 'kill', typeId: 'SpaceSuit', count: 2, label: '星詠みを2体倒す（夜のみ出現）' },
      { kind: 'talk', npcId: 'sora', label: 'ソラに報告する' },
    ],
    reward: { gold: 150, xp: 240 },
  },
  {
    id: 'q_patrol',
    title: '町の見回り',
    giver: 'kaji',
    autoStart: false,
    steps: [
      { kind: 'visit', landmark: '温泉', label: '湯けむり温泉を確認する' },
      { kind: 'visit', landmark: 'コンビニ', label: '夜明けコンビニを確認する' },
      { kind: 'visit', landmark: 'ガソスタ', label: '給油スタンドを確認する' },
      { kind: 'talk', npcId: 'kaji', label: 'カジに報告する' },
    ],
    reward: { gold: 120, xp: 160 },
  },
  {
    id: 'q_tutorial',
    title: 'はじめの一歩',
    giver: null,
    autoStart: true,
    steps: [
      { kind: 'action', action: 'walk', label: '歩いてみよう！ WASDで移動' },
      { kind: 'action', action: 'melee', label: '切ってみよう！ Fで近接攻撃' },
      { kind: 'action', action: 'run', label: '走ってみよう！ Shiftを押しながら移動' },
      { kind: 'action', action: 'roll', label: '転がってみよう！ Spaceでローリング' },
      { kind: 'action', action: 'heal', label: '回復してみよう！ Eで回復' },
      { kind: 'action', action: 'block', label: '盾を使ってみよう！ Controlを押す' },
    ],
    reward: { gold: 20, xp: 30 },
  },
]

export const ITEMS = {
  veg_basket: { label: '採れたて野菜', desc: '使うとHPを60回復する', heal: 60 },
  bread: { label: '焼きたてパン', desc: '使うとHPを40、MPを20回復する', heal: 40, mp: 20 },
  festival_fan: { label: '祭の扇', desc: '攻撃力が5上がった証', attack: 5 },
  arrow_bundle: { label: '矢束', desc: '素材' },
  plate: { label: '装甲板', desc: '素材' },
  star_shard: { label: '星片', desc: '素材' },
  crown_piece: { label: '王冠の欠片', desc: 'レア素材' },
  elixir: { label: 'エリクサー', desc: '使うとHPとMPを全回復する', heal: 999, mp: 999 },
  gear_part: { label: '歯車部品', desc: '素材' },
}
