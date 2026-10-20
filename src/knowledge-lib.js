// 小鲸鱼的长期知识库（JSONL，存在 qq-bridge/state/knowledge/knowledge.jsonl）。
//
// 和 diary-lib 的区别：
//   - diary 是"今天发生了什么/什么心情"，按天组织，注入最近 2 天；
//   - knowledge 是"我懂了什么"，按主题组织，长期保留，靠 search 取用。
//
// 设计目标（越逛越聪明的最小闭环）：
//   1) 逛到有用信息 -> add 一条（标题 + 结论 + 来源 + 标签）；
//   2) 聊到/逛到相关话题 -> search 先查旧笔记，别凭空编；
//   3) 同标题覆盖更新，避免重复；每天限 40 条，防止把知识库当流水账。
import fs from 'node:fs';
import path from 'node:path';

const MAX_ENTRIES = 2000;
const MAX_PER_DAY = 40;
const MAX_TITLE = 80;
const MAX_BODY = 2000;
const MAX_TAGS = 8;
const MAX_TAG_LEN = 20;
const MAX_SOURCE = 100;
const MAX_EXPIRES_DAYS = 365;
const STALE_DAYS = 180;
const CONSOLIDATE_THRESHOLD = 0.5;

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function keyOf(title) {
  return normalizeText(title).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function dayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function truncate(text, max) {
  const s = normalizeText(text);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function fileFor(root) {
  return path.join(root, 'state', 'knowledge', 'knowledge.jsonl');
}

export function loadKnowledge(root) {
  const file = fileFor(root);
  if (!fs.existsSync(file)) return [];
  const entries = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed);
      if (entry && typeof entry === 'object' && entry.id && entry.title) entries.push(entry);
    } catch {}
  }
  return entries;
}

function saveKnowledge(root, entries) {
  const file = fileFor(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 超上限时按「重要度 + 时间」保留，低价值的老条目先走。
  const kept = entries
    .slice()
    .sort((a, b) => ((b.importance ?? 3) * 1e13 + (b.ts ?? 0)) - ((a.importance ?? 3) * 1e13 + (a.ts ?? 0)))
    .slice(0, MAX_ENTRIES)
    .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  const body = kept.map((entry) => JSON.stringify(entry)).join('\n');
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body ? `${body}\n` : '', 'utf8');
  fs.renameSync(tmp, file);
}

function expiryOf(entry) {
  if (!entry?.expiresAt) return null;
  const ts = Date.parse(entry.expiresAt);
  return Number.isFinite(ts) ? ts : null;
}

function isExpired(entry, now) {
  const ts = expiryOf(entry);
  return ts !== null && ts <= now;
}

function activeKnowledge(root, now = Date.now()) {
  return loadKnowledge(root).filter((entry) => !isExpired(entry, now));
}

function brief(entry) {
  return {
    id: entry.id,
    title: entry.title,
    tags: entry.tags ?? [],
    importance: entry.importance ?? 3,
    ts: entry.ts ?? 0,
    source: entry.source ?? '',
    expiresAt: entry.expiresAt ?? null,
  };
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  const out = [];
  for (const raw of tags) {
    const tag = normalizeText(raw);
    if (!tag || tag.length > MAX_TAG_LEN) continue;
    if (!out.includes(tag)) out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

export function addKnowledge(root, { title, body, tags, source, importance, expiresInDays, now = Date.now() }) {
  const cleanTitle = normalizeText(title);
  const cleanBody = normalizeText(body);
  if (!cleanTitle) throw new Error('标题不能为空');
  if (cleanTitle.length > MAX_TITLE) throw new Error(`标题太长（最多 ${MAX_TITLE} 字）`);
  if (!cleanBody) throw new Error('正文不能为空');
  if (cleanBody.length > MAX_BODY) throw new Error(`正文太长（最多 ${MAX_BODY} 字）`);
  const imp = Math.max(1, Math.min(5, Math.round(Number(importance ?? 3) || 3)));
  const cleanSource = truncate(source, MAX_SOURCE);
  const cleanTags = normalizeTags(tags);
  const days = expiresInDays === undefined || expiresInDays === null ? null : Math.round(Number(expiresInDays));
  if (days !== null && (!Number.isFinite(days) || days < 1 || days > MAX_EXPIRES_DAYS)) {
    throw new Error(`到期天数要在 1–${MAX_EXPIRES_DAYS} 之间`);
  }
  const expiresAt = days === null ? null : new Date(now + days * 86400000).toISOString();

  const entries = loadKnowledge(root);
  const today = dayKey(now);
  const todayCount = entries.filter((entry) => dayKey(entry.ts ?? 0) === today).length;
  if (todayCount >= MAX_PER_DAY) throw new Error(`今天已经记了 ${todayCount} 条，先消化一下，明天再记`);

  const key = keyOf(cleanTitle);
  const existing = entries.find((entry) => keyOf(entry.title) === key);
  if (existing) {
    existing.body = cleanBody;
    existing.tags = cleanTags;
    existing.source = cleanSource;
    existing.importance = imp;
    existing.ts = now;
    if (expiresAt) existing.expiresAt = expiresAt;
    else if (isExpired(existing, now)) delete existing.expiresAt;
    saveKnowledge(root, entries);
    return { id: existing.id, updated: true, total: activeKnowledge(root, now).length };
  }

  const id = `k_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const entry = { id, ts: now, title: cleanTitle, body: cleanBody, tags: cleanTags, source: cleanSource, importance: imp };
  if (expiresAt) entry.expiresAt = expiresAt;
  entries.push(entry);
  saveKnowledge(root, entries);
  return { id, updated: false, total: activeKnowledge(root, now).length };
}

function tokensOf(query) {
  const q = normalizeText(query).toLowerCase();
  if (!q) return [];
  const tokens = new Set();
  if (q.length >= 2) tokens.add(q);
  for (const part of q.split(/[\s,，。;；、/|+]+/)) {
    if (part.length >= 2) tokens.add(part);
    // 中文没有空格时补 2-gram，提升召回（"游戏本推荐" -> 游戏/戏本/本推/推荐）。
    if (part.length > 2 && /[\u3400-\u9fff]/.test(part)) {
      for (let i = 0; i + 2 <= part.length; i++) tokens.add(part.slice(i, i + 2));
    }
  }
  return [...tokens];
}

export function searchKnowledge(root, { query, limit = 8, now = Date.now() }) {
  const entries = activeKnowledge(root, now);
  const max = Math.max(1, Math.min(20, Number(limit) || 8));
  const tokens = tokensOf(query);
  if (!tokens.length) return { total: entries.length, entries: recentKnowledge(root, { limit: max, now }).entries };

  const scored = [];
  for (const entry of entries) {
    const title = normalizeText(entry.title).toLowerCase();
    const body = normalizeText(entry.body).toLowerCase();
    const tags = (entry.tags ?? []).join(' ').toLowerCase();
    const source = normalizeText(entry.source).toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (title.includes(token)) score += 6;
      if (tags.includes(token)) score += 4;
      if (body.includes(token)) score += 2;
      if (source.includes(token)) score += 1;
    }
    if (score > 0) scored.push({ entry, score });
  }
  scored.sort((a, b) => b.score - a.score || (b.entry.importance ?? 3) - (a.entry.importance ?? 3) || (b.entry.ts ?? 0) - (a.entry.ts ?? 0));
  return {
    total: entries.length,
    matched: scored.length,
    entries: scored.slice(0, max).map(({ entry }) => entry),
  };
}

export function recentKnowledge(root, { limit = 10, now = Date.now() } = {}) {
  const entries = activeKnowledge(root, now);
  const max = Math.max(1, Math.min(20, Number(limit) || 10));
  return {
    total: entries.length,
    entries: entries.slice().sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0)).slice(0, max),
  };
}

function bigramsOf(text) {
  const norm = keyOf(text);
  const grams = new Set();
  if (!norm) return grams;
  if (norm.length < 2) {
    grams.add(norm);
    return grams;
  }
  for (let i = 0; i + 2 <= norm.length; i++) grams.add(norm.slice(i, i + 2));
  return grams;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const token of a) if (b.has(token)) inter++;
  return inter / (a.size + b.size - inter);
}

export function deleteKnowledge(root, { id } = {}) {
  const target = String(id ?? '').trim();
  if (!target) throw new Error('id 不能为空');
  const entries = loadKnowledge(root);
  const index = entries.findIndex((entry) => entry.id === target);
  if (index < 0) return { deleted: false, remaining: entries.length };
  const [entry] = entries.splice(index, 1);
  saveKnowledge(root, entries);
  return { deleted: true, entry, remaining: entries.length };
}

export function pruneKnowledge(root, { now = Date.now(), staleDays = STALE_DAYS } = {}) {
  const entries = loadKnowledge(root);
  if (!entries.length) return { removed: [], remaining: 0 };
  const removed = [];
  const kept = [];
  for (const entry of entries) {
    if (isExpired(entry, now)) {
      removed.push({ id: entry.id, title: entry.title, reason: 'expired' });
      continue;
    }
    if ((entry.importance ?? 3) <= 2 && now - (entry.ts ?? 0) > staleDays * 86400000) {
      removed.push({ id: entry.id, title: entry.title, reason: 'stale' });
      continue;
    }
    kept.push(entry);
  }
  if (removed.length) saveKnowledge(root, kept);
  return { removed, remaining: kept.length };
}

export function consolidateKnowledge(root, { now = Date.now(), threshold = CONSOLIDATE_THRESHOLD, maxClusters = 10, staleDays = STALE_DAYS } = {}) {
  const all = loadKnowledge(root);
  const entries = all.filter((entry) => !isExpired(entry, now));
  const expired = all.filter((entry) => isExpired(entry, now));
  const stale = entries.filter((entry) => (entry.importance ?? 3) <= 2 && now - (entry.ts ?? 0) > staleDays * 86400000);
  const cutoff = Math.max(0.2, Math.min(0.9, Number(threshold) || CONSOLIDATE_THRESHOLD));
  const limit = Math.max(1, Math.min(20, Number(maxClusters) || 10));

  const parent = new Map(entries.map((entry) => [entry.id, entry.id]));
  const find = (id) => {
    let x = id;
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  const grams = new Map(entries.map((entry) => [entry.id, bigramsOf(entry.title)]));
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (jaccard(grams.get(entries[i].id), grams.get(entries[j].id)) >= cutoff) {
        union(entries[i].id, entries[j].id);
      }
    }
  }

  const groups = new Map();
  for (const entry of entries) {
    const key = find(entry.id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  const clusters = [...groups.values()]
    .filter((group) => group.length >= 2)
    .sort((a, b) => b.length - a.length || (b[0].ts ?? 0) - (a[0].ts ?? 0))
    .slice(0, limit)
    .map((group) => ({
      entries: group
        .slice()
        .sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))
        .map(brief),
    }));

  return {
    total: entries.length,
    threshold: cutoff,
    clusters,
    expired: expired.map(brief),
    stale: stale.map(brief),
  };
}

export function formatKnowledgeEntry(entry, index) {
  const tags = entry.tags?.length ? ` #${entry.tags.join(' #')}` : '';
  const date = new Date(entry.ts ?? 0).toISOString().slice(0, 10);
  const stars = '★'.repeat(Math.max(1, Math.min(5, entry.importance ?? 3)));
  const source = entry.source ? `来源：${entry.source} · ` : '';
  const expires = entry.expiresAt ? ` · 到期 ${new Date(entry.expiresAt).toISOString().slice(0, 10)}` : '';
  return `${index + 1}. 【${entry.title}】${tags}\n${truncate(entry.body, 500)}\n   ${source}${date} · ${stars}${expires} · id: ${entry.id}`;
}

export const KNOWLEDGE_LIMITS = Object.freeze({
  MAX_ENTRIES,
  MAX_PER_DAY,
  MAX_TITLE,
  MAX_BODY,
  MAX_TAGS,
  MAX_EXPIRES_DAYS,
  STALE_DAYS,
  CONSOLIDATE_THRESHOLD,
});
