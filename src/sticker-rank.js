// 表情/梗图的情绪、角色识别与打分排序。
//
// 设计来源：qqagent 的 reply-meme / whale-memes 两个 skill，但这里不依赖
// 任何宿主 API，只做纯函数，方便单测，也方便桥接和目录模块共用。
//
// 原则：
// - 否定词优先排除（“不同意”“不好笑”“没问题”不能当“同意/好笑/问题”匹配）；
// - 关键词命中标题/文案权重最高，story/标签次之；
// - 角色是加权项，不是硬过滤；没有合口味的结果时宁可不发（由调用方决定）；
// - 同分/同档随机，避免每次都是同一张。

export const MOODS = Object.freeze([
  { key: 'comfort', label: '安慰', words: ['难过', '伤心', '委屈', '抱抱', '摸摸', '安慰', '哭', '不开心', '丧', '低落', '心疼', '难受'] },
  { key: 'happy', label: '开心', words: ['开心', '高兴', '快乐', '好耶', '棒', '爽', '乐', '嘻嘻', '美滋滋'] },
  { key: 'thanks', label: '感谢', words: ['谢谢', '感谢', '多谢', 'thx', 'thanks', '感恩', '辛苦了'] },
  { key: 'agree', label: '赞同', words: ['赞同', '同意', '确实', '没错', '支持', '有道理', '是这样', '对的'] },
  { key: 'encourage', label: '鼓励', words: ['加油', '鼓励', '努力', '坚持', '你可以', '冲', '干杯', '会好的'] },
  { key: 'confused', label: '疑惑', words: ['疑惑', '不懂', '什么', '为啥', '为什么', '问号', '啊', '嗯'] },
  { key: 'speechless', label: '无语', words: ['无语', '服了', '离谱', '逆天', '难绷', '汗', '沉默', '6'] },
  { key: 'shock', label: '震惊', words: ['震惊', '惊了', '卧槽', '居然', '竟然', '真的假的', '天哪'] },
  { key: 'angry', label: '生气', words: ['生气', '气死', '愤怒', '恼火', '火大', '烦', '讨厌'] },
  { key: 'apology', label: '道歉', words: ['对不起', '抱歉', '不好意思', '我错了', '道歉', 'sorry', '怪我'] },
  { key: 'goodnight', label: '晚安', words: ['晚安', '睡了', '睡觉', '困', '安'] },
  { key: 'goodmorning', label: '早安', words: ['早安', '早上好', '起床', '早'] },
  { key: 'slack', label: '摸鱼', words: ['摸鱼', '摆烂', '躺平', '上班', '下班', '工作', '累', '不想动'] },
  { key: 'like', label: '喜欢', words: ['喜欢', '爱', '心动', '可爱', '贴贴', '亲亲', '抱', '想rua'] },
  { key: 'awkward', label: '尴尬', words: ['尴尬', '社死', '汗流浃背', '呃', 'emmm', '脚趾抠地'] },
  { key: 'proud', label: '得意', words: ['得意', '骄傲', '厉害', '牛', '强', '赢了', '嘿嘿', '拿捏'] },
  { key: 'laugh', label: '大笑', words: ['大笑', '爆笑', '笑死', '哈哈哈', '绷不住', '乐死'] },
  { key: 'cute', label: '可爱', words: ['可爱', '萌', '软', '乖', '小动物', '猫', '狗', '兔'] },
  { key: 'beg', label: '讨饭', words: ['饭', '饿', '吃', '求', '要', '投喂', '请客'] },
  { key: 'stare', label: '盯', words: ['盯', '看', '监视', '暗中观察', '注视'] }
]);

export const ROLES = Object.freeze([
  { key: 'deepseek', label: 'DeepSeek娘', aliases: ['deepseek', 'deepseek娘', '鲸', '鲸鱼', '鲸鱼娘', 'ds娘'] },
  { key: 'ai', label: 'AI娘化', aliases: ['ai娘', 'ai娘化', 'ai'] },
  { key: 'claude', label: 'Claude娘', aliases: ['claude', 'claude娘', '克劳德'] },
  { key: 'gpt', label: 'GPT娘', aliases: ['gpt', 'gpt娘', 'chatgpt'] },
  { key: 'kimi', label: 'Kimi娘', aliases: ['kimi', 'kimi娘'] },
  { key: 'tongyi', label: '通义千问娘', aliases: ['通义', '通义千问', '千问', 'qwen'] },
  { key: 'zhipu', label: '智谱清言娘', aliases: ['智谱', '清言', 'glm'] },
  { key: 'gemini', label: 'Gemini娘', aliases: ['gemini', '双子'] },
  { key: 'grok', label: 'Grok娘', aliases: ['grok'] },
  { key: 'stepfun', label: 'Stepfun娘', aliases: ['stepfun', '阶跃'] },
  { key: 'mimo', label: 'MiMo娘', aliases: ['mimo', '小米'] },
  { key: 'doubao', label: '豆大妈', aliases: ['豆包', '豆大妈', 'doubao'] }
]);

const STOPWORDS = new Set([
  '表情包', '表情', '梗图', '配图', '图片', '来一张', '来张', '一张', '发个', '发张',
  'meme', 'memes', 'sticker', 'pic', 'image', '一个', '这个', '那个', '一下', '帮我', '给我'
]);

const NOISE_PHRASES = ['表情包', '表情', '梗图', '配图', '图片', '来一张', '来张', '一张', '发个', '发张', 'meme', 'sticker'];

// “不/没/别 + 最多 4 个程度词”紧贴在命中词前面时，视为否定。
// 例：不同意、不太同意、不好笑、没问题、别哭、没有很开心。
const NEGATION_RE = /(?:不|没(?:有)?|未|别|莫|勿|并非|不是|不能|无法)(?:再|太|很|好|怎么|那么|这么|够|算|想|要|会|敢|能|可能|真的|真|特别|完全|十分|一直|已经|任何|一点|一丝|一丁点|有点|值得|需要|觉得|认为|\s){0,4}$/;

const LAYOUT_RE = /(四五六九格|九宫格|拼图|合集|多图|组图)/;

export function normalizeText(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase();
}

export function compactText(value) {
  return normalizeText(value).replace(/[^\p{L}\p{N}]+/gu, '');
}

export function isNegatedAt(compact, index) {
  if (index <= 0) return false;
  const before = compact.slice(Math.max(0, index - 14), index);
  return NEGATION_RE.test(before);
}

// 返回未落在否定语境里的命中下标；没有命中返回空数组。
export function findMatches(haystack, needle) {
  const h = compactText(haystack);
  const n = compactText(needle);
  if (!h || !n) return [];
  const found = [];
  let from = 0;
  while (from <= h.length - n.length) {
    const idx = h.indexOf(n, from);
    if (idx < 0) break;
    if (!isNegatedAt(h, idx)) found.push(idx);
    from = idx + 1;
  }
  return found;
}

export function includesTerm(haystack, needle) {
  return findMatches(haystack, needle).length > 0;
}

export function moodByKeyOrLabel(value) {
  if (!value) return null;
  const v = compactText(value);
  return MOODS.find((m) => compactText(m.key) === v || compactText(m.label) === v) || null;
}

export function roleByKeyOrLabel(value) {
  if (!value) return null;
  const v = compactText(value);
  return ROLES.find((r) => compactText(r.key) === v || compactText(r.label) === v || compactText(r.aliases.join(' ')).includes(v)) || null;
}

export function detectMood(text) {
  const raw = compactText(text);
  if (!raw) return null;
  let best = null;
  for (const mood of MOODS) {
    let hit = 0;
    for (const word of mood.words) {
      if (findMatches(raw, word).length) hit += 1;
    }
    if (hit && (!best || hit > best.hit)) best = { mood, hit };
  }
  return best?.mood || null;
}

export function detectCharacter(text, { explicit = '', defaultCharacter = '' } = {}) {
  const e = String(explicit || '').trim();
  if (e && e !== 'auto') {
    const role = roleByKeyOrLabel(e);
    if (role) return role;
  }
  const d = String(defaultCharacter || '').trim();
  if (d && d !== 'auto') {
    const role = roleByKeyOrLabel(d);
    if (role) return role;
  }
  const raw = compactText(text);
  if (!raw) return null;
  for (const role of ROLES) {
    for (const alias of [role.label, ...role.aliases]) {
      if (alias && findMatches(raw, alias).length) return role;
    }
  }
  return null;
}

export function tokenizeQuery(query) {
  let raw = normalizeText(query);
  for (const noise of NOISE_PHRASES) raw = raw.split(noise).join(' ');
  raw = raw.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (!raw) return [];
  const terms = raw.split(/\s+/)
    .map((t) => compactText(t))
    .filter((t) => t && !STOPWORDS.has(t) && t.length <= 12);
  return [...new Set(terms)].slice(0, 4);
}

function itemFields(item) {
  const title = compactText(item.caption || item.title || item.localNote || item.desc || '');
  const name = compactText(item.name || item.desc || item.title || '');
  const story = compactText(item.story || item.usage || '');
  const tags = compactText(Array.isArray(item.tags) ? item.tags.join(' ') : (item.tags || ''));
  const category = compactText(item.category || item.character || '');
  return { title, name, story, tags, category };
}

function roleHits(text, role) {
  if (!text || !role) return false;
  if (text.includes(compactText(role.label)) || text.includes(compactText(role.key))) return true;
  return role.aliases.some((a) => a && text.includes(compactText(a)));
}

// 返回 { score, reason, support }；score<0 表示明确不该选。
export function scoreItem(item, options = {}) {
  const {
    keywords = [],
    emotion = null,
    character = null,
    requireSupport = false,
    random = true,
    preferredCharacters = []
  } = options;
  const fields = itemFields(item);
  const mood = typeof emotion === 'string' ? moodByKeyOrLabel(emotion) : emotion;
  let score = 0;
  let support = false;
  const reason = [];

  for (const term of keywords) {
    const t = compactText(term);
    if (!t) continue;
    const inTitle = findMatches(fields.title, t).length > 0;
    const inName = findMatches(fields.name, t).length > 0;
    const inStory = findMatches(fields.story, t).length > 0;
    const inTags = findMatches(fields.tags, t).length > 0;
    if (inTitle) {
      score += 12;
      support = true;
      reason.push(`标题:${t}`);
      if (fields.title === t) score += 12;
      if (t.length >= 2) score += 6;
    }
    if (inName && !inTitle) {
      score += 4;
      support = true;
      reason.push(`名称:${t}`);
    }
    if (inStory) {
      score += 3;
      reason.push(`故事:${t}`);
    }
    if (inTags) {
      score += 5;
      support = true;
      reason.push(`标签:${t}`);
    }
  }

  if (mood) {
    for (const word of mood.words) {
      const w = compactText(word);
      if (!w) continue;
      if (findMatches(fields.title, w).length) {
        score += 10;
        support = true;
        reason.push(`情绪:${mood.label}`);
        break;
      }
      if (findMatches(fields.tags, w).length) {
        score += 4;
        support = true;
        reason.push(`情绪标签:${mood.label}`);
        break;
      }
      if (findMatches(fields.story, w).length) {
        score += 2;
        reason.push(`情绪故事:${mood.label}`);
        break;
      }
    }
  }

  if (character) {
    if (roleHits(fields.category, character)) {
      score += 40;
      reason.push(`角色:${character.label}`);
    } else if (roleHits(fields.title, character)) {
      score += 20;
      reason.push(`标题角色:${character.label}`);
    }
  }

  for (const pref of preferredCharacters) {
    if (character && pref.key === character.key) continue;
    if (roleHits(fields.category, pref) || roleHits(fields.title, pref)) {
      score += 12;
      reason.push(`偏好:${pref.label}`);
      break;
    }
  }

  if (item.verified) score += 8;
  if (fields.title.length > 35) score *= 0.65;
  if (LAYOUT_RE.test(`${fields.title}${fields.story}`)) score *= 0.65;

  if (requireSupport && (keywords.length || mood) && !support) score = -1;
  if (random && score > 0) score += Math.random() * 0.9;

  return { score, reason, support };
}

export function rankCandidates(items, options = {}) {
  const {
    limit = 12,
    exclude = null,
    keyword = '',
    keywords = null,
    emotion = '',
    character = '',
    defaultCharacter = '',
    preferredCharacters = [],
    requireSupport = false,
    now = Date.now()
  } = options;
  const terms = keywords || tokenizeQuery(keyword);
  const mood = typeof emotion === 'object' && emotion ? emotion : moodByKeyOrLabel(emotion);
  const role = typeof character === 'object' && character
    ? character
    : detectCharacter(keyword, { explicit: character, defaultCharacter });
  const excluded = exclude instanceof Set ? exclude : new Set(exclude || []);
  const seen = new Set();

  const scored = [];
  for (const item of items || []) {
    const id = String(item.id || item.original || item.url || '');
    if (!id || excluded.has(id) || seen.has(id)) continue;
    seen.add(id);
    const result = scoreItem(item, {
      keywords: terms,
      emotion: mood,
      character: role,
      requireSupport,
      preferredCharacters
    });
    if (result.score < 0) continue;
    scored.push({ ...item, score: result.score, matchReason: result.reason, _now: now });
  }

  scored.sort((a, b) => b.score - a.score);
  if (!scored.length) return [];
  // 只在「同分档」内随机：先保住明显更相关的图，再在相近分数里打散。
  // 之前把整个 band 全洗牌，会把最高分的图洗到 limit 之外，出现「点了难过却给天气图」。
  const bandSize = Math.min(scored.length, Math.max(limit * 3, 12));
  const band = scored.slice(0, bandSize);
  const buckets = new Map();
  for (const item of band) {
    const key = Math.round(item.score * 2) / 2;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(item);
  }
  const ordered = [];
  for (const key of [...buckets.keys()].sort((a, b) => b - a)) {
    const bucket = buckets.get(key);
    for (let i = bucket.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [bucket[i], bucket[j]] = [bucket[j], bucket[i]];
    }
    ordered.push(...bucket);
  }
  return ordered.slice(0, Math.max(0, limit));
}

export function moodLabel(value) {
  const mood = typeof value === 'string' ? moodByKeyOrLabel(value) : value;
  return mood?.label || '';
}
