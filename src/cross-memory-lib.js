// 跨会话「人」维度的记忆（2026-10-22）。
//
// 背景：二代仿真的记忆严格按会话隔离 —— memberImpressions 记在
// state/social-v2.json 的 conversations[key] 下，日记也从 10-21 起按会话分开存。
// 为需要跨会话了解联系人近况的场景，提供可配置的人员记忆汇总。
// 汇总范围由调用方控制，避免默认跨越会话隐私边界。
//
// 这个文件只做三件事：
//   1) state/people.json：QQ 号 → 昵称/备注 的缓存（bridge.js 定期从 OneBot 拉；
//      拉不到就退回显示 QQ 号，绝不影响主流程）；
//   2) state/cross-memory.json：人维度的静态信息（手写关系、可选手写摘要、
//      AI 自己写的印象镜像），是唯一落盘的东西；
//   3) 渲染：把「别的私聊会话里那个人的近况」拼成一小段注入文本。
//
// 近况正文**不落盘**：每次从别的会话状态现算，避免两份数据不同步。
// 隐私边界（谁可以当来源、注入到哪些会话）由调用方 bridge.js 决定。
import fs from 'node:fs';
import path from 'node:path';

const CROSS_FILE = 'cross-memory.json';
const PEOPLE_FILE = 'people.json';
const MAX_NOTES = 20;
const MAX_NOTE_CHARS = 200;
const MAX_NAME_CHARS = 40;
const MAX_RELATION_CHARS = 120;
const MAX_DIGEST_CHARS = 200;

function stateDir(root) {
  return path.join(root, 'state');
}

export function peopleFilePath(root) {
  return path.join(stateDir(root), PEOPLE_FILE);
}

export function crossMemoryFilePath(root) {
  return path.join(stateDir(root), CROSS_FILE);
}

function clean(value, max) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

// ── 昵称缓存 ────────────────────────────────────────────────────────────────
// 只存展示用的昵称/备注；key 是 QQ 号字符串。读的时候任何异常都当空表处理。

export function readPeople(root) {
  const raw = readJson(peopleFilePath(root), {});
  const out = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!/^\d{5,12}$/.test(id)) continue;
    if (!value || typeof value !== 'object') continue;
    const nickname = clean(value.nickname, MAX_NAME_CHARS);
    const remark = clean(value.remark, MAX_NAME_CHARS);
    if (!nickname && !remark) continue;
    out[id] = { nickname, remark, at: Number(value.at) || 0 };
  }
  return out;
}

export function writePeople(root, map) {
  const out = {};
  for (const [id, value] of Object.entries(map ?? {})) {
    if (!/^\d{5,12}$/.test(String(id))) continue;
    if (!value || typeof value !== 'object') continue;
    const nickname = clean(value.nickname, MAX_NAME_CHARS);
    const remark = clean(value.remark, MAX_NAME_CHARS);
    if (!nickname && !remark) continue;
    out[String(id)] = { nickname, remark, at: Number(value.at) || 0 };
  }
  writeJsonAtomic(peopleFilePath(root), out);
  return out;
}

// ── 人维度记忆 ──────────────────────────────────────────────────────────────

export function readCrossMemory(root) {
  const raw = readJson(crossMemoryFilePath(root), {});
  const people = {};
  for (const [id, value] of Object.entries(raw.people ?? {})) {
    if (!/^\d{5,12}$/.test(id) || !value || typeof value !== 'object') continue;
    const notes = (Array.isArray(value.notes) ? value.notes : [])
      .map((note) => ({
        at: Number(note?.at) || 0,
        from: clean(note?.from, 64),
        text: clean(note?.text, MAX_NOTE_CHARS)
      }))
      .filter((note) => note.text)
      .slice(-MAX_NOTES);
    people[id] = {
      name: clean(value.name, MAX_NAME_CHARS),
      relation: clean(value.relation, MAX_RELATION_CHARS),
      digest: clean(value.digest, MAX_DIGEST_CHARS),
      notes,
      updatedAt: Number(value.updatedAt) || 0
    };
  }
  return { version: 1, people };
}

export function writeCrossMemory(root, data) {
  const people = {};
  for (const [id, value] of Object.entries(data?.people ?? {})) {
    if (!/^\d{5,12}$/.test(id) || !value || typeof value !== 'object') continue;
    const record = {
      name: clean(value.name, MAX_NAME_CHARS),
      relation: clean(value.relation, MAX_RELATION_CHARS),
      digest: clean(value.digest, MAX_DIGEST_CHARS),
      notes: (Array.isArray(value.notes) ? value.notes : [])
        .map((note) => ({
          at: Number(note?.at) || 0,
          from: clean(note?.from, 64),
          text: clean(note?.text, MAX_NOTE_CHARS)
        }))
        .filter((note) => note.text)
        .slice(-MAX_NOTES),
      updatedAt: Number(value.updatedAt) || 0
    };
    // 全空的记录不写，免得文件越攒越脏。
    if (!record.name && !record.relation && !record.digest && !record.notes.length) continue;
    people[id] = record;
  }
  const clean_ = { version: 1, people };
  writeJsonAtomic(crossMemoryFilePath(root), clean_);
  return clean_;
}

/** 手写/更新某人的字段；空字符串表示清掉该字段。返回该人的记录。 */
export function upsertCrossPerson(data, id, patch = {}) {
  const key = String(id ?? '').trim();
  if (!/^\d{5,12}$/.test(key)) throw new Error(`无效的 QQ 号：${key}`);
  if (!data.people) data.people = {};
  const person = data.people[key] ?? { name: '', relation: '', digest: '', notes: [], updatedAt: 0 };
  let touched = false;
  for (const [field, max] of [['name', MAX_NAME_CHARS], ['relation', MAX_RELATION_CHARS], ['digest', MAX_DIGEST_CHARS]]) {
    if (patch[field] === undefined) continue;
    person[field] = clean(patch[field], max);
    touched = true;
  }
  if (touched) person.updatedAt = Date.now();
  data.people[key] = person;
  return person;
}

/** 把 AI 自己写的印象镜像到人维度记忆；连续重复的文本不重复记。 */
export function addCrossNote(data, id, { from = '', text = '', at = Date.now() } = {}) {
  const key = String(id ?? '').trim();
  if (!/^\d{5,12}$/.test(key)) return null;
  const body = clean(text, MAX_NOTE_CHARS);
  if (!body) return null;
  if (!data.people) data.people = {};
  const person = data.people[key] ?? { name: '', relation: '', digest: '', notes: [], updatedAt: 0 };
  const notes = Array.isArray(person.notes) ? person.notes : [];
  const last = notes[notes.length - 1];
  if (last && last.text === body) return person;
  notes.push({ at: Number(at) || Date.now(), from: clean(from, 64), text: body });
  person.notes = notes.slice(-MAX_NOTES);
  person.updatedAt = Date.now();
  data.people[key] = person;
  return person;
}

export function displayName(id, person, people = {}) {
  const own = clean(person?.name, MAX_NAME_CHARS);
  if (own) return own;
  const cached = people?.[String(id)] ?? {};
  return clean(cached.remark, MAX_NAME_CHARS) || clean(cached.nickname, MAX_NAME_CHARS) || `QQ ${id}`;
}

export function relativeTime(ts, now = Date.now()) {
  const at = Number(ts) || 0;
  if (!at) return '';
  const diff = Math.max(0, now - at);
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return `${Math.round(diff / 60000)} 分钟前`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.round(diff / 3600000)} 小时前`;
  return `${Math.round(diff / 86400000)} 天前`;
}

export function clip(text, max = 40) {
  const s = clean(text, max + 1);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * 渲染一小段「别人那边的近况」。
 * rows: [{ id, name, relation, bits: string[], lastAt }]
 * 任何一行都不含换行；总量受 maxTotalChars 限制，超了就少放几行。
 */
export function renderCrossBlock(rows, { header = '', hint = '', maxTotalChars = 800 } = {}) {
  const lines = [];
  let used = 0;
  for (const row of rows ?? []) {
    if (!row || !row.id) continue;
    const relation = clean(row.relation, MAX_RELATION_CHARS);
    const bits = (Array.isArray(row.bits) ? row.bits : []).map((b) => clean(b, MAX_NOTE_CHARS)).filter(Boolean);
    const when = relativeTime(row.lastAt);
    const body = bits.length ? bits.join('；') : '最近没说什么';
    const line = `- ${clip(row.name || `QQ ${row.id}`, MAX_NAME_CHARS)}（QQ ${row.id}${relation ? `，${relation}` : ''}）：${body}${when ? `；${when}` : ''}`;
    if (used + line.length + 1 > maxTotalChars && lines.length) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (!lines.length) return '';
  const head = header || '【别人那边的近况（只有你知道，不是你现在聊的人；被问起可以直接答，别原文念）】';
  return [head, ...lines, ...(hint ? [hint] : [])].join('\n');
}
