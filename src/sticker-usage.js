// 每个会话的表情使用记录：去重 + 每小时/每天额度。
//
// 为什么不复用 bridge 里的 socialV2 state：
// 1) 那个 state 只持久化白名单字段，新增字段要同时改 load/save，容易漏；
// 2) 表情记录增长快，单独文件可以独立裁剪，不把主 state 撑大；
// 3) 会话 key 只存 sha256，不把 QQ 号写进新文件。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MAX_ITEMS = 80;
const MAX_CHATS = 200;
const KEEP_MS = 7 * DAY_MS;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function emptyState() {
  return { version: 1, chats: {} };
}

function loadState(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.chats || typeof parsed.chats !== 'object') {
      return emptyState();
    }
    return { version: 1, chats: parsed.chats };
  } catch (err) {
    if (err?.code === 'ENOENT') return emptyState();
    throw err;
  }
}

export function createStickerUsageStore(file, { maxItems = MAX_ITEMS, maxChats = MAX_CHATS } = {}) {
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

  function chatId(key) {
    return sha256(key).slice(0, 24);
  }

  function chat(key) {
    const id = chatId(key);
    if (!state.chats[id]) state.chats[id] = { items: [], lastAt: 0, lastAuto: 0 };
    if (!Array.isArray(state.chats[id].items)) state.chats[id].items = [];
    return state.chats[id];
  }

  function peek(key) {
    const entry = state.chats[chatId(key)];
    if (!entry || !Array.isArray(entry.items)) return { items: [], lastAt: 0, lastAuto: 0 };
    return entry;
  }

  function cutoff(now) {
    return now - KEEP_MS;
  }

  function pruneChat(entry, now) {
    const min = cutoff(now);
    entry.items = entry.items.filter((it) => {
      const at = Number(it?.at) || 0;
      return at >= min;
    }).slice(-maxItems);
  }

  function prune(now = Date.now()) {
    for (const [id, entry] of Object.entries(state.chats)) {
      if (!entry || typeof entry !== 'object') {
        delete state.chats[id];
        continue;
      }
      pruneChat(entry, now);
      if (!entry.items.length && !entry.lastAt) delete state.chats[id];
    }
    const ids = Object.keys(state.chats);
    if (ids.length > maxChats) {
      ids.sort((a, b) => (Number(state.chats[a]?.lastAt) || 0) - (Number(state.chats[b]?.lastAt) || 0));
      for (const id of ids.slice(0, ids.length - maxChats)) delete state.chats[id];
    }
  }

  function save() {
    if (!writable || !dirty) return false;
    prune();
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
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

  function stats(key, now = Date.now()) {
    const entry = peek(key);
    const hour = entry.items.filter((it) => now - (Number(it.at) || 0) < HOUR_MS).length;
    const day = entry.items.filter((it) => now - (Number(it.at) || 0) < DAY_MS).length;
    return {
      total: entry.items.length,
      hour,
      day,
      lastAt: Number(entry.items.at(-1)?.at) || 0,
      lastAuto: Number(entry.lastAuto) || 0
    };
  }

  function check(key, {
    source = 'qq',
    maxPerHour = 0,
    maxPerDay = 0,
    proactiveCooldownMs = 0,
    now = Date.now()
  } = {}) {
    const entry = peek(key);
    pruneChat(entry, now);
    const matching = entry.items.filter((it) => !source || it.source === source);
    const inHour = matching.filter((it) => now - (Number(it.at) || 0) < HOUR_MS);
    const inDay = matching.filter((it) => now - (Number(it.at) || 0) < DAY_MS);
    if (maxPerHour > 0 && inHour.length >= maxPerHour) {
      const oldest = inHour.reduce((min, it) => Math.min(min, Number(it.at) || now), now);
      return {
        ok: false,
        reason: 'hour',
        retryAfterMs: Math.max(1000, HOUR_MS - (now - oldest)),
        stats: stats(key, now)
      };
    }
    if (maxPerDay > 0 && inDay.length >= maxPerDay) {
      const oldest = inDay.reduce((min, it) => Math.min(min, Number(it.at) || now), now);
      return {
        ok: false,
        reason: 'day',
        retryAfterMs: Math.max(1000, DAY_MS - (now - oldest)),
        stats: stats(key, now)
      };
    }
    if (proactiveCooldownMs > 0 && entry.lastAuto && now - Number(entry.lastAuto) < proactiveCooldownMs) {
      return {
        ok: false,
        reason: 'cooldown',
        retryAfterMs: Math.max(1000, proactiveCooldownMs - (now - Number(entry.lastAuto))),
        stats: stats(key, now)
      };
    }
    return { ok: true, reason: '', retryAfterMs: 0, stats: stats(key, now) };
  }

  function record(key, item = {}, { auto = false, now = Date.now() } = {}) {
    if (!writable) return false;
    const entry = chat(key);
    const id = String(item.id || item.stickerId || '');
    const source = String(item.source || 'qq');
    if (!id) return false;
    entry.items.push({
      id,
      source,
      hash: item.hash ? String(item.hash) : '',
      at: now,
      auto: Boolean(auto)
    });
    entry.lastAt = now;
    if (auto) entry.lastAuto = now;
    pruneChat(entry, now);
    dirty = true;
    return true;
  }

  function hasRecent(key, id, windowMs = DAY_MS, now = Date.now()) {
    const entry = peek(key);
    return entry.items.some((it) => it.id === String(id) && now - (Number(it.at) || 0) < windowMs);
  }

  function recentIds(key, windowMs = DAY_MS, now = Date.now()) {
    const entry = peek(key);
    return new Set(entry.items
      .filter((it) => now - (Number(it.at) || 0) < windowMs)
      .map((it) => String(it.id)));
  }

  prune();
  return {
    check,
    record,
    stats,
    hasRecent,
    recentIds,
    prune,
    save,
    get writable() { return writable; },
    get loadError() { return loadError; },
    get chats() { return state.chats; }
  };
}
