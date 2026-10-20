// 表情/图片记忆：按图片内容哈希记住「这张图是什么」。
//
// 动机：QQ 私聊里表情包高频出现，每张图都以 image part 进入视觉上下文（一张 1~2k token）。
// 模型看过一次并把含义写进这里后，同一张图再出现只注入一行文字：
//   [表情3 id=a1b2c3d4e5f6（已记忆：竖大拇指，表示赞成）]
// 于是不再为它花视觉 token。
//
// 边界：
// - 条目只由模型通过 qq_sticker_remember（POST /api/socialV2/sticker-remember）主动写入；桥接不猜含义。
// - note 会出现在所有看到这张图的会话提示词里 → 写入时单行化 + 限长（同 sticker-lib 的防注入思路）。
// - 只存哈希与文字，不存图片字节；整个文件原子替换（tmp + rename）。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sanitizeStickerText } from './sticker-lib.js';

export const STICKER_MEMORY_HASH_LEN = 12;
export const STICKER_MEMORY_MAX_ENTRIES = 800;
export const STICKER_MEMORY_FILE_VERSION = 1;

// 图片内容指纹：只看字节，与文件名、发送者、会话无关。
export function stickerMemoryHash(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return '';
  return crypto.createHash('md5').update(buffer).digest('hex').slice(0, STICKER_MEMORY_HASH_LEN);
}

export function normalizeStickerMemoryEntry(raw) {
  const entry = raw && typeof raw === 'object' ? raw : {};
  const hash = String(entry.hash ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{8,32}$/.test(hash)) return null;
  const note = sanitizeStickerText(entry.note, 160);
  if (!note) return null;
  return {
    hash,
    note,
    source: entry.source === 'user' ? 'user' : 'model',
    chatKey: String(entry.chatKey ?? '').slice(0, 60),
    createdAt: Number(entry.createdAt) || Date.now(),
    usedAt: Number(entry.usedAt) || 0,
    useCount: Math.max(0, Math.floor(Number(entry.useCount) || 0))
  };
}

function readEntries(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`表情记忆库不是合法 JSON：${file}`);
  }
  const list = Array.isArray(data) ? data : data?.entries;
  if (!Array.isArray(list)) return [];
  const entries = [];
  for (const raw of list) {
    const entry = normalizeStickerMemoryEntry(raw);
    if (entry) entries.push(entry);
  }
  return entries;
}

export function saveStickerMemory(file, entries) {
  const payload = {
    version: STICKER_MEMORY_FILE_VERSION,
    savedAt: new Date().toISOString(),
    entries: [...entries].sort((a, b) => (b.usedAt || b.createdAt) - (a.usedAt || a.createdAt))
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 1)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return payload;
}

export function createStickerMemoryStore(file, { maxEntries = STICKER_MEMORY_MAX_ENTRIES, maxNoteChars = 160, log } = {}) {
  const cap = Math.max(50, Math.floor(Number(maxEntries) || STICKER_MEMORY_MAX_ENTRIES));
  const noteLimit = Math.max(20, Math.floor(Number(maxNoteChars) || 160));
  let entries = new Map();
  let loaded = false;
  let dirty = false;
  let lastSaveError = '';
  let flushTimer = null;

  function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    for (const entry of readEntries(file)) entries.set(entry.hash, entry);
  }

  function trim() {
    if (entries.size <= cap) return;
    const kept = [...entries.values()]
      .sort((a, b) => (b.usedAt || b.createdAt) - (a.usedAt || a.createdAt))
      .slice(0, cap);
    entries = new Map(kept.map((entry) => [entry.hash, entry]));
    dirty = true;
  }

  function save() {
    if (!dirty) return true;
    try {
      saveStickerMemory(file, entries.values());
      dirty = false;
      lastSaveError = '';
      return true;
    } catch (error) {
      lastSaveError = String(error?.message ?? error);
      log?.(`⚠️ 表情记忆库写入失败：${lastSaveError}`);
      return false;
    }
  }

  // 命中计数用节流写盘（每次看图都写没必要），remember 走直写。
  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      save();
    }, 1500);
    flushTimer.unref?.();
  }

  function lookup(hash) {
    const key = String(hash ?? '').trim().toLowerCase();
    if (!key) return null;
    ensureLoaded();
    return entries.get(key) ?? null;
  }

  function touch(hash) {
    const entry = lookup(hash);
    if (!entry) return false;
    entry.usedAt = Date.now();
    entry.useCount = (Number(entry.useCount) || 0) + 1;
    dirty = true;
    scheduleFlush();
    return true;
  }

  function remember({ hash, note, source = 'model', chatKey = '' } = {}) {
    const key = String(hash ?? '').trim().toLowerCase();
    if (!/^[0-9a-f]{8,32}$/.test(key)) throw new Error('hash 不合法（应为消息里 id= 后面的十六进制串）');
    const text = sanitizeStickerText(note, noteLimit);
    if (!text) throw new Error('note 为空');
    ensureLoaded();
    const now = Date.now();
    const prev = entries.get(key) || null;
    const entry = normalizeStickerMemoryEntry({
      hash: key,
      note: text,
      source: prev ? prev.source : (source === 'user' ? 'user' : 'model'),
      chatKey: chatKey || prev?.chatKey || '',
      createdAt: prev?.createdAt || now,
      usedAt: prev?.usedAt || 0,
      useCount: prev?.useCount || 0
    });
    entries.set(key, entry);
    trim();
    dirty = true;
    save();
    return entry;
  }

  return {
    file,
    lookup,
    touch,
    remember,
    save,
    flush: save,
    stats() {
      ensureLoaded();
      return { count: entries.size, file, dirty, lastSaveError };
    }
  };
}
