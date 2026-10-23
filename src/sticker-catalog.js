// 外部梗图目录（梗鲸 / aigengtu）。
//
// 只做三件事：
// 1) 拉 gallery-index.json 并缓存（12h 内存/磁盘，失败降级旧缓存）；
// 2) 把 2000+ 张图按情绪/角色/关键词排序，交给 bridge 当“第二图库”；
// 3) 按需下载、校验尺寸、落盘缓存，供 file:// 或 base64 发送。
//
// 默认只在私聊启用；群聊启用与否由 bridge 的配置决定。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { safeFetchBuffer } from './safe-fetch.js';
import { validateImageBuffer, cacheImage, sweepCache } from './sticker-media.js';
import { rankCandidates, moodByKeyOrLabel, detectCharacter, ROLES, MOODS } from './sticker-rank.js';

const DEFAULT_INDEX_URL = 'https://aigengtu.com/gallery-index.json';
const ALLOWED_HOSTS = new Set(['aigengtu.com', 'www.aigengtu.com', 'img.aigengtu.com']);
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_MAX_BYTES = 12 * 1024 * 1024;
const DEFAULT_MIN_SIDE = 200;
const PREFERRED_ROLES = ROLES.filter((r) => r.key === 'deepseek' || r.key === 'ai');

function clean(value, max = 200) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function allowedImageUrl(raw) {
  try {
    const url = new URL(String(raw));
    if (url.protocol !== 'https:') return false;
    return ALLOWED_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function imageKey(original) {
  return `ext:${crypto.createHash('sha1').update(String(original)).digest('hex').slice(0, 12)}`;
}

export function parseGalleryIndex(json, { maxItems = 6000 } = {}) {
  const out = [];
  const seen = new Set();

  function walk(node, category = '') {
    if (out.length >= maxItems) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, category);
      return;
    }
    if (!node || typeof node !== 'object') return;

    const original = String(node.original || node.url || '');
    if (/\/meme\/\d+\.(webp|png|jpe?g|gif)(?:\?.*)?$/i.test(original)) {
      if (!allowedImageUrl(original)) return;
      const id = imageKey(original);
      if (seen.has(id)) return;
      seen.add(id);
      const name = clean(node.name, 80);
      const alt = clean(node.alt, 160);
      const caption = alt || name || path.basename(new URL(original).pathname);
      const storyObj = node.story && typeof node.story === 'object' ? node.story : {};
      const story = clean(storyObj.zh || storyObj.en || '', 240);
      const previewRaw = String(node.preview || '');
      const preview = allowedImageUrl(previewRaw) ? previewRaw : original;
      out.push({
        id,
        source: 'ext',
        title: name || caption,
        name,
        caption,
        story,
        category: clean(node.category || category, 40),
        original,
        preview
      });
      return;
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === 'story') continue;
      if (Array.isArray(value)) walk(value, category || key);
      else if (value && typeof value === 'object') walk(value, category || key);
    }
  }

  const root = json && typeof json === 'object' && json.gallery && typeof json.gallery === 'object'
    ? json.gallery
    : json;
  walk(root);
  return out;
}

export function createStickerCatalog({
  file,
  cacheDir,
  indexUrl = DEFAULT_INDEX_URL,
  ttlMs = DEFAULT_TTL_MS,
  maxItems = 6000,
  maxBytes = DEFAULT_MAX_BYTES,
  minSide = DEFAULT_MIN_SIDE,
  fetchImpl = globalThis.fetch,
  logger = null
} = {}) {
  let entries = [];
  let byId = new Map();
  let fetchedAt = 0;
  let fromCache = false;
  let lastError = null;
  let indexPromise = null;

  function log(...args) {
    try { logger?.(...args); } catch {}
  }

  function setEntries(list, at, cached) {
    entries = Array.isArray(list) ? list : [];
    byId = new Map(entries.map((e) => [e.id, e]));
    fetchedAt = Number(at) || 0;
    fromCache = Boolean(cached);
  }

  function readCache() {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed?.entries) || !parsed.entries.length) return false;
      setEntries(parsed.entries, parsed.fetchedAt, true);
      return true;
    } catch {
      return false;
    }
  }

  function writeCache() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
      const payload = JSON.stringify({ version: 1, fetchedAt, source: indexUrl, entries }, null, 0);
      fs.writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      log('[sticker-catalog] 写缓存失败:', err?.message || err);
    }
  }

  async function refresh() {
    if (typeof fetchImpl !== 'function') throw new Error('当前 Node 没有 fetch');
    const res = await fetchImpl(indexUrl, {
      headers: {
        accept: 'application/json',
        'user-agent': 'qq-bridge/1.0 (+sticker-catalog)'
      },
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const list = parseGalleryIndex(json, { maxItems });
    if (list.length < 10) throw new Error(`索引里只解析到 ${list.length} 张图`);
    setEntries(list, Date.now(), false);
    writeCache();
    lastError = null;
    log(`[sticker-catalog] 已刷新 ${entries.length} 张外部梗图`);
    return entries;
  }

  async function ensureIndex({ force = false } = {}) {
    if (!force && entries.length && Date.now() - fetchedAt < ttlMs) return entries;
    if (indexPromise) return indexPromise;
    indexPromise = (async () => {
      try {
        await refresh();
      } catch (err) {
        lastError = err;
        log('[sticker-catalog] 刷新失败，使用缓存:', err?.message || err);
        if (!entries.length) readCache();
        if (!entries.length) throw err;
      } finally {
        indexPromise = null;
      }
      return entries;
    })();
    return indexPromise;
  }

  // 启动时只读磁盘缓存，不阻塞；需要最新索引时再 ensureIndex。
  readCache();
  try { sweepCache(cacheDir, 48 * 60 * 60 * 1000); } catch {}

  function list({ query = '', emotion = '', character = '', limit = 30, source = 'ext' } = {}) {
    if (source && source !== 'ext') return [];
    return rankCandidates(entries, {
      keyword: query,
      emotion,
      character,
      limit,
      preferredCharacters: PREFERRED_ROLES
    });
  }

  function find(ref) {
    const raw = String(ref || '').trim();
    if (!raw) return null;
    const id = raw.startsWith('ext:') ? raw : `ext:${raw}`;
    return byId.get(id) || byId.get(raw) || null;
  }

  function pick({ keyword = '', emotion = '', character = '', limit = 1, exclude = null } = {}) {
    const role = character
      ? (typeof character === 'object' ? character : detectCharacter('', { explicit: character }))
      : null;
    const mood = typeof emotion === 'object' ? emotion : moodByKeyOrLabel(emotion);
    const ranked = rankCandidates(entries, {
      keyword,
      emotion: mood,
      character: role,
      limit,
      exclude,
      preferredCharacters: PREFERRED_ROLES
    });
    return ranked;
  }

  function pickForPrompt({ max = 3, exclude = null } = {}) {
    const wanted = [
      moodByKeyOrLabel('comfort'),
      moodByKeyOrLabel('happy'),
      moodByKeyOrLabel('laugh'),
      moodByKeyOrLabel('speechless'),
      moodByKeyOrLabel('like'),
      moodByKeyOrLabel('confused')
    ].filter(Boolean);
    const out = [];
    const used = new Set(exclude || []);
    for (const mood of wanted) {
      if (out.length >= max) break;
      const found = rankCandidates(entries, {
        emotion: mood,
        limit: 1,
        exclude: used,
        preferredCharacters: PREFERRED_ROLES
      });
      if (found[0]) {
        out.push({ ...found[0], promptMood: mood.label });
        used.add(found[0].id);
      }
    }
    // 不够就用任意“有 caption”的补，但不超过 max
    if (out.length < max) {
      const rest = rankCandidates(entries, { limit: max - out.length, exclude: used });
      for (const item of rest) out.push({ ...item, promptMood: '随便看看' });
    }
    return out.slice(0, max);
  }

  async function fetchImage(item, { previewFallback = true } = {}) {
    if (!item) throw new Error('外部梗图不存在');
    const urls = [item.original, previewFallback ? item.preview : ''].filter(Boolean);
    let lastErr = null;
    for (const url of urls) {
      if (!allowedImageUrl(url)) {
        lastErr = new Error('图片地址不在允许的图床域名内');
        continue;
      }
      try {
        const res = await safeFetchBuffer(url, maxBytes);
        const buf = res.buffer;
        const meta = validateImageBuffer(buf, {
          maxBytes,
          maxPixels: 64_000_000,
          minSide,
          label: '外部梗图'
        });
        return { buffer: buf, mime: meta.mime, width: meta.width, height: meta.height, url };
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('外部梗图下载失败');
  }

  async function downloadToCache(item) {
    const fetched = await fetchImage(item);
    const cached = cacheImage(cacheDir, fetched.buffer, fetched.mime);
    return { ...fetched, path: cached.path, hash: cached.hash, reused: cached.reused };
  }

  function formatLine(item, { prefix = '' } = {}) {
    if (!item) return '';
    const mood = item.promptMood ? `${item.promptMood}｜` : '';
    const role = item.category ? `（${item.category}）` : '';
    return `- ${prefix}${mood}${clean(item.caption || item.title, 60)}${role} · ${item.id}`;
  }

  return {
    ensureIndex,
    list,
    find,
    pick,
    pickForPrompt,
    fetchImage,
    downloadToCache,
    formatLine,
    sweep: () => sweepCache(cacheDir, 48 * 60 * 60 * 1000),
    get entries() { return entries; },
    get size() { return entries.length; },
    get fetchedAt() { return fetchedAt; },
    get fromCache() { return fromCache; },
    get lastError() { return lastError; },
    get moods() { return MOODS; }
  };
}
