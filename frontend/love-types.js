// Single source of truth for love-expression types.
// Used by the browser (labels, colors, classifier) and by the server (prompt motifs).

export const LOVE_TYPES = [
  {
    id: 'words', label: '言语', emoji: '💌', hint: '夸奖 · 感谢 · 告白',
    from: '#FFE0EE', to: '#FFA6CF', color: '#FF7EB6',
    colorName: 'bubblegum rose pink', accentName: 'butter yellow',
    motif: 'a plump speech bubble with a small glossy heart inside',
    keywords: ['我爱你', '爱你', '想你', '喜欢你', '夸', '赞', '表扬', '称赞', '谢谢', '感谢', '道歉', '对不起', '告白', '情话', '留言', '短信', '微信', '写信', '信', 'love you', 'miss you', 'thank', 'compliment', 'praise', 'sorry', 'letter'],
  },
  {
    id: 'time', label: '陪伴', emoji: '🧑‍🤝‍🧑', hint: '一起 · 散步 · 约会',
    from: '#D6F6EE', to: '#8EE0CC', color: '#4FCDB4',
    colorName: 'fresh mint teal', accentName: 'peach',
    motif: 'two cute round blob characters walking side by side and holding hands, with a tiny heart floating above them',
    keywords: ['陪', '一起', '散步', '约会', '看电影', '电影', '旅行', '旅游', '聊天', '聊了', '逛', '通话', '视频', '等我', 'together', 'date', 'walk', 'trip', 'movie', 'chat'],
  },
  {
    id: 'gift', label: '礼物', emoji: '🎁', hint: '送礼 · 小心意',
    from: '#E9E0FF', to: '#BCA6FF', color: '#9B82FF',
    colorName: 'soft lavender purple', accentName: 'pink',
    motif: 'a gift box tied with a ribbon bow',
    keywords: ['礼物', '送给', '送了', '买给', '买了', '花', '玫瑰', '巧克力', '戒指', '项链', '红包', '手作', '纪念', 'gift', 'flower', 'present', 'bought', 'chocolate'],
  },
  {
    id: 'care', label: '照顾', emoji: '☂️', hint: '接送 · 帮忙',
    from: '#D9F0FF', to: '#8CCBFF', color: '#5BB5FF',
    colorName: 'clear sky blue', accentName: 'coral pink',
    motif: 'a cozy umbrella sheltering a small heart',
    keywords: ['来接', '接我', '接你', '送我', '照顾', '帮', '修', '洗', '收拾', '打扫', '家务', '雨', '伞', '药', '生病', '感冒', '盖被', '叫醒', '提醒', '开车', 'care', 'help', 'pick up', 'drove', 'umbrella', 'clean', 'fix'],
  },
  {
    id: 'hug', label: '拥抱', emoji: '🤗', hint: '拥抱 · 牵手',
    from: '#FFE3D6', to: '#FFAE8C', color: '#FF8F66',
    colorName: 'warm peach coral', accentName: 'rose pink',
    motif: 'two cute round blob characters hugging each other tightly',
    keywords: ['抱', '亲', '吻', '牵手', '摸头', '拥', '依偎', '靠', '握', '按摩', '捏', 'hug', 'kiss', 'cuddle', 'hold hands', 'snuggle', 'massage'],
  },
  {
    id: 'surprise', label: '惊喜', emoji: '🎈', hint: '生日 · 布置',
    from: '#FFF4BF', to: '#FFD84F', color: '#FFC800',
    colorName: 'sunny lemon yellow', accentName: 'magenta pink',
    motif: 'a party popper bursting with confetti and a floating heart balloon',
    keywords: ['惊喜', '没想到', '突然', '意外', '准备了', '布置', '生日', '庆祝', '蛋糕', '烟花', '气球', 'surprise', 'birthday', 'cake', 'balloon', 'unexpected'],
  },
  {
    id: 'support', label: '支持', emoji: '🌱', hint: '鼓励 · 倾听',
    from: '#E4F7CF', to: '#A8DF7A', color: '#86CF55',
    colorName: 'spring leaf green', accentName: 'warm orange',
    motif: 'a tiny sprout with two leaves growing out of a heart-shaped pot, with a little sun above',
    keywords: ['支持', '鼓励', '理解', '倾听', '听我', '包容', '相信', '安慰', '肯定', '加油', '信任', '尊重', '成长', 'support', 'encourage', 'listen', 'understand', 'trust', 'believe', 'comfort'],
  },
  {
    id: 'food', label: '美食', emoji: '🍲', hint: '做饭 · 带饭',
    from: '#FFEBCF', to: '#FFBE6B', color: '#FFA63D',
    colorName: 'golden apricot orange', accentName: 'tomato red',
    motif: 'a steaming bowl of soup with heart-shaped steam and a pair of chopsticks',
    keywords: ['做饭', '煮', '饭', '菜', '汤', '吃', '早餐', '午餐', '晚餐', '宵夜', '咖啡', '奶茶', '甜点', '烤', '面', '粥', '带了', 'cook', 'meal', 'soup', 'dinner', 'breakfast', 'coffee', 'milk tea', 'snack', 'bake', 'food'],
  },
  {
    id: 'other', label: '其他', emoji: '💗', hint: '不好归类',
    from: '#FFE1E1', to: '#FF9C9C', color: '#FF6B6B',
    colorName: 'warm coral red', accentName: 'cream white',
    motif: 'a plump glossy heart with a soft highlight and two tiny sparkles',
    keywords: [],
  },
];

export const TYPE_IDS = LOVE_TYPES.map((t) => t.id);

const BY_ID = new Map(LOVE_TYPES.map((t) => [t.id, t]));

export function typeOf(id) {
  return BY_ID.get(id) ?? BY_ID.get('other');
}

// Keyword scoring; ties resolve by the order above. No match -> 'other'.
export function classify(text) {
  const s = String(text ?? '').toLowerCase();
  let best = 'other';
  let bestScore = 0;
  for (const t of LOVE_TYPES) {
    let score = 0;
    for (const k of t.keywords) if (s.includes(k)) score += 1;
    if (score > bestScore) {
      best = t.id;
      bestScore = score;
    }
  }
  return best;
}
