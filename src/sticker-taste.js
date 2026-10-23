// “自己的表情品味”画像 + 收藏候选提示。
//
// 来源：qqagent 的 meme-taste skill。它不做硬编码的“好图/坏图”判断，
// 而是把管理员/模型收藏时写的一句理由慢慢积累成 likes/dislikes，
// 再把这些偏好注入提示词，让选图越来越像“这个人”。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DEFAULT_LIKES = ['软乎乎', '圆滚滚', '呆脸', '笨拙真诚', '丑萌', '小动物', '吃的', '动画', '一图说清'];
const DEFAULT_DISLIKES = ['恐怖血腥', '擦边', '骂人', '卖惨', '糊', '要配字'];

const POSITIVE_WORDS = [
  ['软', '软乎乎'], ['圆', '圆滚滚'], ['呆', '呆脸'], ['傻', '呆脸'], ['憨', '笨拙真诚'],
  ['可爱', '可爱'], ['丑萌', '丑萌'], ['怪', '怪'], ['沙雕', '沙雕'], ['真诚', '笨拙真诚'],
  ['好笑', '好笑'], ['开心', '开心'], ['委屈', '委屈'], ['猫', '猫'], ['狗', '狗'], ['兔', '兔'],
  ['吃', '吃的'], ['饭', '吃的'], ['动图', '动画'], ['动画', '动画'], ['简单', '一图说清'],
  ['清楚', '一图说清'], ['颜色', '颜色'], ['配色', '配色'], ['眼神', '眼神'], ['表情', '表情']
];
const NEGATIVE_WORDS = [
  ['恐怖', '恐怖血腥'], ['血腥', '恐怖血腥'], ['吓人', '恐怖血腥'], ['擦边', '擦边'], ['色情', '擦边'],
  ['骂', '骂人'], ['脏话', '骂人'], ['卖惨', '卖惨'], ['糊', '糊'], ['看不清', '糊'],
  ['配字', '要配字'], ['文字太多', '要配字'], ['太丑', '太丑'], ['恶心', '恶心'], ['不适', '不适']
];

function sanitizeLine(value, max = 160) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function emptyState() {
  return {
    version: 1,
    likes: [...DEFAULT_LIKES],
    dislikes: [...DEFAULT_DISLIKES],
    notes: [],
    stats: { liked: 0, disliked: 0, collected: 0 },
    reminded: {}
  };
}

function loadState(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return emptyState();
    return {
      version: 1,
      likes: Array.isArray(parsed.likes) ? parsed.likes.map((x) => sanitizeLine(x, 24)).filter(Boolean) : [...DEFAULT_LIKES],
      dislikes: Array.isArray(parsed.dislikes) ? parsed.dislikes.map((x) => sanitizeLine(x, 24)).filter(Boolean) : [...DEFAULT_DISLIKES],
      notes: Array.isArray(parsed.notes) ? parsed.notes.slice(-40) : [],
      stats: { liked: 0, disliked: 0, collected: 0, ...(parsed.stats || {}) },
      reminded: parsed.reminded && typeof parsed.reminded === 'object' ? parsed.reminded : {}
    };
  } catch (err) {
    if (err?.code === 'ENOENT') return emptyState();
    throw err;
  }
}

function uniq(list, max = 24) {
  return [...new Set((list || []).map((x) => sanitizeLine(x, 24)).filter(Boolean))].slice(-max);
}

export function createStickerTasteStore(file, { maxNotes = 40 } = {}) {
  let state;
  let loadError = null;
  try {
    state = loadState(file);
  } catch (err) {
    loadError = err;
    state = emptyState();
  }
  let writable = !loadError;
  let dirty = false;

  function save() {
    if (!writable || !dirty) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, file);
      dirty = false;
      return true;
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch {}
      throw err;
    }
  }

  function learnFromNote(note) {
    const text = sanitizeLine(note, 160);
    if (!text) return { likes: [], dislikes: [] };
    const liked = [];
    const disliked = [];
    const negative = /(?:不要|不喜欢|讨厌|别发|反感|雷)/.test(text);
    for (const [word, tag] of POSITIVE_WORDS) {
      if (text.includes(word)) (negative ? disliked : liked).push(tag);
    }
    for (const [word, tag] of NEGATIVE_WORDS) {
      if (text.includes(word)) disliked.push(tag);
    }
    if (liked.length) state.likes = uniq([...state.likes, ...liked]);
    if (disliked.length) state.dislikes = uniq([...state.dislikes, ...disliked]);
    dirty = true;
    return { likes: uniq(liked), dislikes: uniq(disliked) };
  }

  function addNote(note, sentiment = 'like') {
    const text = sanitizeLine(note, 160);
    if (!text) return false;
    state.notes.push({ text, sentiment, at: Date.now() });
    state.notes = state.notes.slice(-maxNotes);
    if (sentiment === 'like') state.stats.liked += 1;
    if (sentiment === 'dislike') state.stats.disliked += 1;
    const learned = learnFromNote(text);
    dirty = true;
    return learned;
  }

  function recordCollected(note = '') {
    state.stats.collected += 1;
    if (note) addNote(note, 'like');
    dirty = true;
  }

  function recordTaste(action, note = '') {
    const act = String(action || '').trim();
    if (act === 'like') return addNote(note || '喜欢', 'like');
    if (act === 'dislike') return addNote(note || '不喜欢', 'dislike');
    if (act === 'forget') {
      const text = sanitizeLine(note, 160);
      if (!text) return false;
      const before = state.notes.length;
      state.notes = state.notes.filter((n) => !String(n.text).includes(text));
      dirty = dirty || state.notes.length !== before;
      return state.notes.length !== before;
    }
    return false;
  }

  function promptSection() {
    if (!state.likes.length && !state.dislikes.length) return '';
    const lines = ['【我的表情品味】'];
    if (state.likes.length) lines.push(`喜欢：${state.likes.slice(-10).join('、')}。`);
    if (state.dislikes.length) lines.push(`不喜欢：${state.dislikes.slice(-10).join('、')}。`);
    lines.push('选图时优先合口味；没有合适的就不发，不要拿随机图凑数。');
    return lines.join('\n');
  }

  function profile() {
    return {
      likes: [...state.likes],
      dislikes: [...state.dislikes],
      notes: state.notes.slice(-10),
      stats: { ...state.stats }
    };
  }

  function markReminded(ids, now = Date.now()) {
    if (!ids?.length) return;
    for (const id of ids) state.reminded[String(id)] = now;
    // 只保留 24h 内，避免文件无限长
    for (const [id, at] of Object.entries(state.reminded)) {
      if (now - Number(at) > 24 * 60 * 60 * 1000) delete state.reminded[id];
    }
    dirty = true;
  }

  function collectCandidates(recentMessages, { max = 3, now = Date.now() } = {}) {
    const out = [];
    for (const msg of recentMessages || []) {
      if (!msg || msg.isSelf) continue;
      const media = Array.isArray(msg.media) ? msg.media : [];
      const image = media.find((m) => m && (m.kind === 'image' || m.kind === 'sticker' || m.kind === 'face'));
      if (!image) continue;
      const id = String(msg.messageId ?? msg.seq ?? '');
      if (!id || state.reminded[id]) continue;
      const age = now - (Number(msg.time) || now);
      if (age > 6 * 60 * 60 * 1000) continue;
      out.push({
        id,
        sender: sanitizeLine(msg.sender?.card || msg.sender?.nickname || msg.sender?.name || '群友', 20),
        kind: image.kind,
        preview: image.kind === 'face' ? '[小黄脸]' : '[图片]'
      });
      if (out.length >= max) break;
    }
    return out;
  }

  function collectHint(candidates, { hourCount = 0, dayCount = 0, hourLimit = 3, dayLimit = 10 } = {}) {
    if (!candidates?.length) return '';
    const lines = ['【表情品味·收藏机会】刚看到几张别人的图：'];
    candidates.forEach((c, i) => {
      lines.push(`- 候选${i + 1}: messageId=${c.id} 来自 ${c.sender} 类型=${c.kind === 'face' ? '小黄脸' : '图片'}`);
    });
    lines.push('想收就调 qq_collect_sticker(messageId=候选的 messageId, note="为什么想收/哪里好")；note 会进我的品味画像。');
    lines.push(`今天已收 ${dayCount}/${dayLimit}，本小时 ${hourCount}/${hourLimit}；不想收就不用管，别为了配额硬收。`);
    return lines.join('\n');
  }

  return {
    learnFromNote,
    addNote,
    recordCollected,
    recordTaste,
    promptSection,
    profile,
    markReminded,
    collectCandidates,
    collectHint,
    save,
    get writable() { return writable; },
    get loadError() { return loadError; },
    get state() { return state; }
  };
}

export { DEFAULT_LIKES, DEFAULT_DISLIKES };
