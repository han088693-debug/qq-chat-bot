// 小鲸鱼的日记本（本地文件存储）。
//
// 设计：
// - 一天一个 Markdown 文件：state/diary/YYYY-MM-DD.md（人可以直接打开看）
// - 同目录 index.jsonl 只存元数据，便于快速统计/检索，不重复存正文
// - 写入只追加，不覆盖历史；单条长度、每日条数都有上限，防止被诱导刷屏
// - 读取不暴露绝对路径；只返回日期、时间和正文
//
// 说明：日记是「她自己的」，不按 QQ 会话隔离；同一个人格的所有会话共享同一本日记。
import fs from 'node:fs';
import path from 'node:path';

export const DIARY_DIR = 'diary';
export const MAX_TEXT = 4000;
export const MAX_ENTRIES_PER_DAY = 20;
export const MAX_READ_DAYS = 7;
export const MAX_FILE_BYTES = 128 * 1024;

function pad2(n) {
  return String(n).padStart(2, '0');
}

export function dayKey(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function isValidDay(day) {
  const s = String(day ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00`);
  return !Number.isNaN(d.getTime()) && dayKey(d) === s;
}

function diaryRoot(root) {
  return path.join(root, 'state', DIARY_DIR);
}

function sanitizeText(text) {
  // 保留换行/制表，去掉其它控制字符；不转义 Markdown（日记本来就可以有格式）。
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim();
}

function sanitizeShort(value, max) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function byteLength(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8');
}

function countEntriesForDay(indexFile, day) {
  if (!fs.existsSync(indexFile)) return 0;
  let count = 0;
  try {
    const lines = fs.readFileSync(indexFile, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        if (JSON.parse(line).day === day) count += 1;
      } catch { /* 坏行跳过，不阻塞写入 */ }
    }
  } catch { /* 读不到索引时按 0 处理 */ }
  return count;
}

/**
 * 写一条日记。
 * @param {string} root qq-bridge 根目录
 * @param {{text:string,title?:string,mood?:string,tags?:string[]}} entry
 * @param {Date} [now]
 * @returns {{ok:true,day:string,time:string,title:string,file:string,entryId:string,entriesToday:number}}
 */
export function writeDiary(root, entry, now = new Date()) {
  const text = sanitizeText(entry?.text);
  if (!text) throw new Error('日记内容不能为空');
  if (text.length > MAX_TEXT) throw new Error(`日记内容过长（${text.length} > ${MAX_TEXT} 字）`);
  const title = sanitizeShort(entry?.title, 60) || '';
  const mood = sanitizeShort(entry?.mood, 40) || '';
  const tags = Array.isArray(entry?.tags)
    ? [...new Set(entry.tags.map((tag) => sanitizeShort(tag, 20)).filter(Boolean))].slice(0, 8)
    : [];
  const day = dayKey(now);
  const time = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  const dir = diaryRoot(root);
  const indexFile = path.join(dir, 'index.jsonl');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const entriesToday = countEntriesForDay(indexFile, day);
  if (entriesToday >= MAX_ENTRIES_PER_DAY) {
    throw new Error(`今天已经写了 ${entriesToday} 条日记，超过上限 ${MAX_ENTRIES_PER_DAY} 条；明天再写吧`);
  }
  const file = path.join(dir, `${day}.md`);
  const freshFile = !fs.existsSync(file) || fs.statSync(file).size === 0;
  const entryId = `${day}-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}-${Math.random().toString(36).slice(2, 6)}`;
  const heading = title ? `${time} ${title}` : time;
  const lines = [`## ${heading}`, '', text, ''];
  if (mood) lines.push(`- 心情：${mood}`);
  if (tags.length) lines.push(`- 标签：${tags.join('、')}`);
  lines.push('');
  let prefix = '';
  if (freshFile) prefix = `# ${day} 的日记\n\n`;
  fs.appendFileSync(file, `${prefix}${lines.join('\n')}`, 'utf8');
  const meta = { id: entryId, day, time, title, mood, tags, chars: text.length, createdAt: now.toISOString() };
  fs.appendFileSync(indexFile, `${JSON.stringify(meta)}\n`, 'utf8');
  return { ok: true, day, time, title, file: path.relative(path.join(root, 'state'), file).replace(/\\/g, '/'), entryId, entriesToday: entriesToday + 1 };
}

/**
 * 读日记：指定 day 读当天；否则按日期从新到旧读最近 n 天。
 * @param {string} root
 * @param {{n?:number,day?:string}} [options]
 * @returns {{ok:true,days:number,entries:Array<{day:string,text:string}>,truncated:boolean}}
 */
export function readDiary(root, options = {}) {
  const dir = diaryRoot(root);
  const requestedDay = options?.day === undefined || options?.day === null || options?.day === ''
    ? ''
    : String(options.day);
  if (requestedDay && !isValidDay(requestedDay)) throw new Error('day 必须是 YYYY-MM-DD 格式的有效日期');
  let days = [];
  if (requestedDay) {
    days = [requestedDay];
  } else {
    const n = Math.min(MAX_READ_DAYS, Math.max(1, Math.round(Number(options?.n) || 2)));
    try {
      days = fs.readdirSync(dir)
        .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
        .map((name) => name.slice(0, -3))
        .sort()
        .slice(-n)
        .reverse();
    } catch {
      days = [];
    }
  }
  const entries = [];
  let truncated = false;
  for (const day of days) {
    const file = path.join(dir, `${day}.md`);
    if (!fs.existsSync(file)) continue;
    let text = '';
    try {
      const stat = fs.statSync(file);
      if (stat.size > MAX_FILE_BYTES) {
        truncated = true;
        const fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(MAX_FILE_BYTES);
        const read = fs.readSync(fd, buf, 0, MAX_FILE_BYTES, 0);
        fs.closeSync(fd);
        text = buf.subarray(0, read).toString('utf8');
      } else {
        text = fs.readFileSync(file, 'utf8');
      }
    } catch {
      continue;
    }
    entries.push({ day, text: text.trim() });
  }
  return { ok: true, days: entries.length, entries, truncated };
}
