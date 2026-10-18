// Single source of truth for love-expression types.
// Used by the browser (labels, colors, classifier) and by the server (prompt motifs).

export const LOVE_TYPES = [
  {
    id: 'words', label: '言语', emoji: '💌', hint: '夸奖 · 感谢 · 告白',
    from: '#FFE0EE', to: '#FFA6CF', color: '#FF7EB6',
    colorName: 'bubblegum rose pink', accentName: 'butter yellow',
    motif: 'a plump speech bubble with a small glossy heart inside',
    theme: 'kind words, a compliment, thanks or a message',
    keywords: ['我爱你', '爱你', '想你', '喜欢你', '夸', '赞', '表扬', '称赞', '谢谢', '感谢', '道歉', '对不起', '告白', '情话', '留言', '短信', '微信', '写信', '信', 'love you', 'miss you', 'thank', 'compliment', 'praise', 'sorry', 'letter'],
  },
  {
    id: 'time', label: '陪伴', emoji: '🧑‍🤝‍🧑', hint: '一起 · 散步 · 约会',
    from: '#D6F6EE', to: '#8EE0CC', color: '#4FCDB4',
    colorName: 'fresh mint teal', accentName: 'peach',
    motif: 'two cute round blob characters walking side by side and holding hands, with a tiny heart floating above them',
    theme: 'spending time together (a walk, a movie, a date, waiting for someone)',
    keywords: ['陪', '一起', '散步', '约会', '看电影', '电影', '旅行', '旅游', '聊天', '聊了', '逛', '通话', '视频', '等我', 'together', 'date', 'walk', 'trip', 'movie', 'chat'],
  },
  {
    id: 'gift', label: '礼物', emoji: '🎁', hint: '送礼 · 小心意',
    from: '#E9E0FF', to: '#BCA6FF', color: '#9B82FF',
    colorName: 'soft lavender purple', accentName: 'pink',
    motif: 'a gift box tied with a ribbon bow',
    theme: 'a gift or a small present',
    keywords: ['礼物', '送给', '送了', '买给', '买了', '花', '玫瑰', '巧克力', '戒指', '项链', '红包', '手作', '纪念', 'gift', 'flower', 'present', 'bought', 'chocolate'],
  },
  {
    id: 'care', label: '照顾', emoji: '☂️', hint: '接送 · 帮忙',
    from: '#D9F0FF', to: '#8CCBFF', color: '#5BB5FF',
    colorName: 'clear sky blue', accentName: 'coral pink',
    motif: 'a cozy umbrella sheltering a small heart',
    theme: 'taking care of someone (a pickup, help, an umbrella, medicine, a chore)',
    keywords: ['来接', '接我', '接你', '送我', '照顾', '帮', '修', '洗', '收拾', '打扫', '家务', '雨', '伞', '药', '生病', '感冒', '盖被', '叫醒', '提醒', '开车', 'care', 'help', 'pick up', 'drove', 'umbrella', 'clean', 'fix'],
  },
  {
    id: 'hug', label: '拥抱', emoji: '🤗', hint: '拥抱 · 牵手',
    from: '#FFE3D6', to: '#FFAE8C', color: '#FF8F66',
    colorName: 'warm peach coral', accentName: 'rose pink',
    motif: 'two cute round blob characters hugging each other tightly',
    theme: 'a hug, holding hands or being physically close',
    keywords: ['抱', '亲', '吻', '牵手', '摸头', '拥', '依偎', '靠', '握', '按摩', '捏', 'hug', 'kiss', 'cuddle', 'hold hands', 'snuggle', 'massage'],
  },
  {
    id: 'surprise', label: '惊喜', emoji: '🎈', hint: '生日 · 布置',
    from: '#FFF4BF', to: '#FFD84F', color: '#FFC800',
    colorName: 'sunny lemon yellow', accentName: 'magenta pink',
    motif: 'a party popper bursting with confetti and a floating heart balloon',
    theme: 'a surprise or a celebration (a birthday, decorations)',
    keywords: ['惊喜', '没想到', '突然', '意外', '准备了', '布置', '生日', '庆祝', '蛋糕', '烟花', '气球', 'surprise', 'birthday', 'cake', 'balloon', 'unexpected'],
  },
  {
    id: 'support', label: '支持', emoji: '🌱', hint: '鼓励 · 倾听',
    from: '#E4F7CF', to: '#A8DF7A', color: '#86CF55',
    colorName: 'spring leaf green', accentName: 'warm orange',
    motif: 'a tiny sprout with two leaves growing out of a heart-shaped pot, with a little sun above',
    theme: 'encouragement, listening and understanding',
    keywords: ['支持', '鼓励', '理解', '倾听', '听我', '包容', '相信', '安慰', '肯定', '加油', '信任', '尊重', '成长', 'support', 'encourage', 'listen', 'understand', 'trust', 'believe', 'comfort'],
  },
  {
    id: 'food', label: '美食', emoji: '🍲', hint: '做饭 · 带饭',
    from: '#FFEBCF', to: '#FFBE6B', color: '#FFA63D',
    colorName: 'golden apricot orange', accentName: 'tomato red',
    motif: 'a steaming bowl of soup with heart-shaped steam and a pair of chopsticks',
    theme: 'food or drink (a meal, a snack, coffee, bubble tea)',
    keywords: ['做饭', '煮', '饭', '菜', '汤', '吃', '早餐', '午餐', '晚餐', '宵夜', '咖啡', '奶茶', '甜点', '烤', '面', '粥', '带了', 'cook', 'meal', 'soup', 'dinner', 'breakfast', 'coffee', 'milk tea', 'snack', 'bake', 'food'],
  },
  {
    // fixedSubject: always drawn as the same flying disc, whatever the text says (one shared picture for all of them, like the hotel).
    // winsTies: a very specific topic: when a text also matches another type just as well (一起打飞盘 is also 陪伴), the frisbee wins.
    id: 'frisbee', label: '飞盘', emoji: '🥏', hint: '一起打盘 · 传盘 · 接盘', fixedSubject: true, winsTies: true,
    from: '#DCE8FF', to: '#9DB8FF', color: '#6C8DFF',
    colorName: 'sporty cobalt periwinkle blue', accentName: 'sunshine yellow',
    motif: 'a plump glossy flying frisbee disc in sunshine yellow with a white rim ring, tilted as if it was just thrown, with two curved speed lines behind it and one tiny floating heart',
    theme: 'playing frisbee together (ultimate frisbee: throwing, catching, a game, practice)',
    keywords: ['飞盘', '极限飞盘', '打飞盘', '玩飞盘', '飞盘队', '传盘', '扔盘', '投盘', '接盘', 'frisbee', 'ultimate'],
  },
  {
    // fixedSubject: this category is always drawn as its own picture, whatever the text says (a hotel name, a city, a room)
    id: 'hotel', label: '酒店', emoji: '🛌', hint: '过夜 · 旅行 · 住一晚', fixedSubject: true,
    from: '#F6E6D8', to: '#DDB48D', color: '#C48F66',
    colorName: 'warm caramel latte brown', accentName: 'butter yellow',
    motif: 'two cute round blob characters sleeping peacefully in a cozy bed under one fluffy blanket, cuddled up and hugging each other, eyes closed, with a tiny floating heart and a small crescent moon above them',
    theme: 'a night away together at a hotel (sleeping in each other\'s arms)',
    keywords: ['酒店', '宾馆', '旅馆', '民宿', '客栈', '开房', '入住', '过夜', '住一晚', '同床', '抱着睡', '一起睡', '搂着睡', '度假村', '套房', '大床', 'hotel', 'motel', 'airbnb', 'resort', 'overnight', 'stay the night', 'suite'],
  },
  {
    // fixedSubject: always drawn as a pen writing, whatever the text says (and one shared picture for all of them).
    // multiline + a much larger limit: a poem, a lyric or a longer letter, shown in its own layout.
    // The id stays 'poem' because saved entries refer to it; only the name the visitor sees changed.
    id: 'poem', label: '回音', emoji: '🖋️', hint: '诗 · 歌词 · 长一点的话', fixedSubject: true, multiline: true, maxLength: 600,
    from: '#F3E0F3', to: '#D79AD9', color: '#C26BC8',
    colorName: 'soft orchid plum', accentName: 'butter yellow',
    motif: 'a chunky glossy fountain pen with a golden nib, in the middle of writing a flowing wavy line of abstract cursive strokes (no readable letters) across a sheet of cream paper, with one tiny heart at the end of the line',
    theme: 'writing a poem or a handwritten note by hand',
    keywords: ['写诗', '作诗', '诗', '歌词', '十四行', '押韵', '手写', '亲笔', 'poem', 'poetry', 'verse', 'lyrics', 'sonnet', 'haiku'],
  },
  {
    id: 'other', label: '其他', emoji: '💗', hint: '不好归类',
    from: '#FFE1E1', to: '#FF9C9C', color: '#FF6B6B',
    colorName: 'warm coral red', accentName: 'cream white',
    motif: 'a plump glossy heart with a soft highlight and two tiny sparkles',
    theme: 'a warm gesture',
    keywords: [],
  },
];

export const TYPE_IDS = LOVE_TYPES.map((t) => t.id);

// Most entries are one short line; a type may allow much more (and keep its line breaks).
export const DEFAULT_MAX_LENGTH = 60;


const BY_ID = new Map(LOVE_TYPES.map((t) => [t.id, t]));

export function typeOf(id) {
  return BY_ID.get(id) ?? BY_ID.get('other');
}

export const maxLengthOf = (id) => typeOf(id).maxLength ?? DEFAULT_MAX_LENGTH;

// The one place that decides how stored text looks, used by the browser and the server alike. Whitespace is tidied, the
// characters themselves are never rewritten. Single-line types collapse every run of whitespace (line breaks included);
// multiline types keep their line breaks (at most one blank line in a row) and only tidy the spaces within each line.
// The result is cut at the type's limit; callers that must not lose text check the length first.
export function tidyText(typeId, text) {
  const raw = String(text ?? '');
  const max = maxLengthOf(typeId);
  if (!typeOf(typeId).multiline) return raw.replace(/\s+/g, ' ').trim().slice(0, max);
  return raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

// Keyword scoring; ties resolve by the order above (a type with winsTies beats an equal score). No match -> 'other'.
export function classify(text) {
  // a long text, or three or more lines, can only be a poem / letter: it would not fit any other type anyway
  const raw = String(text ?? '');
  if (raw.trim().length > DEFAULT_MAX_LENGTH || raw.split('\n').filter((l) => l.trim()).length >= 3) return 'poem';
  const s = raw.toLowerCase();
  let best = 'other';
  let bestScore = 0;
  for (const t of LOVE_TYPES) {
    let score = 0;
    for (const k of t.keywords) if (s.includes(k)) score += 1;
    if (score > 0 && t.winsTies) score += 0.5; // a half point: only breaks a tie
    if (score > bestScore) {
      best = t.id;
      bestScore = score;
    }
  }
  return best;
}
