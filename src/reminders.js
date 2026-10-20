// 到点提醒（本地文件存储，重启不丢）。
//
// 为什么单独一个文件：提醒是「单条事件」而不是会话状态，不该跟着 social-v2.json
// 一起被高频重写；而且桥接重启后必须还在，所以落盘要原子（tmp + rename）。
//
// 数据结构：state/reminders.json
//   { version: 1, items: [{ id, key, text, dueAt, createdAt, createdBy, firedAt }] }
//   · key    —— 触发时要唤醒哪个会话（private:QQ号 / group:群号）
//   · dueAt  —— 毫秒时间戳
//   · firedAt —— 已到点并投递过唤醒的时间；未触发为 0
//
// 谁在用：bridge.js 的 runReminderTick()（每 30 秒扫一次）→ sendWakePromptV2(key,'reminder')。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MAX_TEXT = 200;
export const MAX_PER_SESSION = 20;
export const MAX_TOTAL = 200;
export const MAX_AHEAD_MS = 60 * 24 * 60 * 60 * 1000; // 最多提前 60 天
export const KEEP_FIRED_MS = 7 * 24 * 60 * 60 * 1000; // 已触发的记录保留 7 天

function sanitizeText(text) {
  return String(text ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT);
}

function newId() {
  return `r${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
}

export function createReminderStore(root) {
  const dir = path.join(root, 'state');
  const file = path.join(dir, 'reminders.json');

  function load() {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const obj = JSON.parse(raw);
      const items = Array.isArray(obj?.items) ? obj.items : [];
      return items.filter((it) => it && typeof it === 'object' && it.id && it.key && Number.isFinite(Number(it.dueAt)));
    } catch {
      return [];
    }
  }

  function save(items) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, items }, null, 2), 'utf8');
      fs.renameSync(tmp, file);
      return true;
    } catch {
      return false;
    }
  }

  /** 清掉过期很久的已触发记录 + 超量截断，只在写盘前调用。 */
  function prune(items, now = Date.now()) {
    const kept = items.filter((it) => !(Number(it.firedAt) > 0 && now - Number(it.firedAt) > KEEP_FIRED_MS));
    if (kept.length <= MAX_TOTAL) return kept;
    // 超量时优先保留「未触发」的，再按时间倒序保留最近的已触发记录。
    const pending = kept.filter((it) => !(Number(it.firedAt) > 0));
    const fired = kept.filter((it) => Number(it.firedAt) > 0).sort((a, b) => Number(b.firedAt) - Number(a.firedAt));
    return [...pending, ...fired].slice(0, MAX_TOTAL);
  }

  return {
    file,

    /** 某个会话的未触发提醒，按时间正序。 */
    list(key) {
      return load()
        .filter((it) => it.key === key && !(Number(it.firedAt) > 0))
        .sort((a, b) => Number(a.dueAt) - Number(b.dueAt));
    },

    all() {
      return load().sort((a, b) => Number(a.dueAt) - Number(b.dueAt));
    },

    /** 新增一条。返回 { ok, item } 或 { ok:false, error }。 */
    add({ key, text, dueAt, createdBy = '' }, now = Date.now()) {
      const k = String(key ?? '').trim();
      const body = sanitizeText(text);
      const when = Number(dueAt);
      if (!k) return { ok: false, error: 'key 不能为空' };
      if (!body) return { ok: false, error: '提醒内容不能为空' };
      if (!Number.isFinite(when)) return { ok: false, error: 'dueAt 必须是毫秒时间戳' };
      if (when <= now - 60 * 1000) return { ok: false, error: '提醒时间已经过去了' };
      if (when - now > MAX_AHEAD_MS) return { ok: false, error: '最多只能提前 60 天提醒' };
      const items = load();
      const pendingForSession = items.filter((it) => it.key === k && !(Number(it.firedAt) > 0));
      if (pendingForSession.length >= MAX_PER_SESSION) return { ok: false, error: `该会话未触发的提醒已达上限（${MAX_PER_SESSION} 条）` };
      const item = { id: newId(), key: k, text: body, dueAt: Math.round(when), createdAt: now, createdBy: String(createdBy ?? '').slice(0, 64), firedAt: 0 };
      items.push(item);
      if (!save(prune(items, now))) return { ok: false, error: '写入提醒文件失败' };
      return { ok: true, item };
    },

    /** 到点且还没投递过的提醒。 */
    due(now = Date.now()) {
      return load().filter((it) => !(Number(it.firedAt) > 0) && Number(it.dueAt) <= now);
    },

    /** 标记已投递（不是删除）。返回是否命中。 */
    markFired(id, now = Date.now()) {
      const items = load();
      const item = items.find((it) => it.id === id);
      if (!item) return false;
      item.firedAt = now;
      return save(prune(items, now));
    },

    /** 取消：只能取消本会话的、还没触发的提醒。 */
    cancel(key, id, now = Date.now()) {
      const items = load();
      const idx = items.findIndex((it) => it.id === String(id ?? '') && it.key === String(key ?? ''));
      if (idx < 0) return { ok: false, error: '找不到这条提醒（或不属于该会话）' };
      if (Number(items[idx].firedAt) > 0) return { ok: false, error: '这条提醒已经触发过了' };
      const [removed] = items.splice(idx, 1);
      if (!save(prune(items, now))) return { ok: false, error: '写入提醒文件失败' };
      return { ok: true, item: removed };
    },

    /** 最近 windowMs 内刚投递过的提醒（给唤醒 prompt 取正文用）。 */
    lastFired(key, windowMs = 10 * 60 * 1000, now = Date.now()) {
      return load()
        .filter((it) => it.key === key && Number(it.firedAt) > 0 && now - Number(it.firedAt) <= windowMs)
        .sort((a, b) => Number(b.firedAt) - Number(a.firedAt));
    }
  };
}
