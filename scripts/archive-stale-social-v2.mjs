#!/usr/bin/env node
// P1-1：旧会话归档（离线、可回退）。
//
// 只处理「不在白名单 + 最后活动超过 7 天」的会话，以及明显的测试 key。
// 默认只预览；--apply 才写盘，写盘前先留 .bak。恢复用 --restore <key>。
//
// 用法：
//   node scripts/archive-stale-social-v2.mjs --preview
//   node scripts/archive-stale-social-v2.mjs --apply
//   node scripts/archive-stale-social-v2.mjs --restore private:999999
//   node scripts/archive-stale-social-v2.mjs --preview --state /tmp/social-v2.json

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const stateArg = args.indexOf('--state');
const archiveArg = args.indexOf('--archive-dir');
const STATE_FILE = stateArg >= 0 ? path.resolve(args[stateArg + 1]) : path.join(ROOT, 'state', 'social-v2.json');
const ARCHIVE_DIR = archiveArg >= 0 ? path.resolve(args[archiveArg + 1]) : path.join(path.dirname(STATE_FILE), 'archive');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const STALE_DAYS = 7;
const TEST_KEYS = new Set(['private:999999', 'group:999999']);

function usage() {
  console.log(`用法：
  node scripts/archive-stale-social-v2.mjs --preview
  node scripts/archive-stale-social-v2.mjs --apply
  node scripts/archive-stale-social-v2.mjs --restore <key>
可选：--state <file> --archive-dir <dir>`);
}

function readJson(file, missingValue) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT' && missingValue !== undefined) return missingValue;
    throw new Error(`无法读取有效 JSON，已停止：${file}`, { cause: error });
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readState() {
  const raw = readJson(STATE_FILE);
  if (!isRecord(raw) || !isRecord(raw.conversations)) throw new Error('状态文件的 conversations 无效，已停止。');
  return raw;
}

function readArchive(file, allowMissing = false) {
  const archive = readJson(file, allowMissing ? { version: 1, archived: [] } : undefined);
  if (!isRecord(archive) || !Array.isArray(archive.archived)
      || archive.archived.some((entry) => !isRecord(entry) || typeof entry.key !== 'string' || !isRecord(entry.data))) {
    throw new Error(`归档文件结构无效，已停止：${file}`);
  }
  return archive;
}

function backupState() {
  const backup = `${STATE_FILE}.bak-${Date.now()}-${process.pid}`;
  fs.copyFileSync(STATE_FILE, backup, fs.constants.COPYFILE_EXCL);
  return backup;
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

function archiveFileName(now = new Date()) {
  return `social-v2-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}.json`;
}

function lastActivityAt(conv) {
  let last = Math.max(
    Number(conv?.lastIncomingAt) || 0,
    Number(conv?.lastAiReplyAt) || 0,
    Number(conv?.lastActionAt) || 0
  );
  for (const m of [...(conv?.recentMessages ?? []), ...(conv?.unread ?? [])]) {
    const raw = m?.time ?? m?.t ?? m?.timestamp;
    const n = typeof raw === 'number' ? raw : Date.parse(String(raw ?? ''));
    if (Number.isFinite(n) && n > last) last = n;
  }
  return last;
}

function allowedKeys() {
  const cfg = readJson(CONFIG_FILE);
  const allow = cfg?.allow;
  if (!isRecord(allow) || !Array.isArray(allow.private) || !Array.isArray(allow.groups)) {
    throw new Error('配置的 allow.private 和 allow.groups 必须是数组，已停止。');
  }
  return new Set([
    ...allow.private.map((x) => `private:${x}`),
    ...allow.groups.map((x) => `group:${x}`),
  ]);
}

function candidates(raw) {
  const allow = allowedKeys();
  const cutoff = Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000;
  const out = [];
  for (const [key, conv] of Object.entries(raw?.conversations ?? {})) {
    if (!conv || conv.archived) continue;
    if (!/^(group|private):\d+$/.test(key)) continue;
    const lastAt = lastActivityAt(conv);
    const test = TEST_KEYS.has(key);
    const stale = lastAt > 0 && lastAt < cutoff;
    const notAllowed = !allow.has(key);
    if (test || (notAllowed && stale)) {
      out.push({
        key,
        bytes: Buffer.byteLength(JSON.stringify(conv)),
        lastAt,
        reason: test ? 'test-key' : 'not-allowed-and-stale',
      });
    }
  }
  return out.sort((a, b) => a.lastAt - b.lastAt);
}

function preview() {
  const raw = readState();
  const list = candidates(raw);
  console.log(`状态文件：${STATE_FILE}`);
  console.log(`候选 ${list.length} 个，共 ${(list.reduce((s, x) => s + x.bytes, 0) / 1024).toFixed(1)} KB`);
  for (const x of list) {
    console.log(`- ${x.key}  ${(x.bytes / 1024).toFixed(1)} KB  last=${x.lastAt ? new Date(x.lastAt).toISOString() : 'never'}  ${x.reason}`);
  }
  return list;
}

function apply() {
  const raw = readState();
  const list = candidates(raw);
  if (!list.length) {
    console.log('没有需要归档的会话。');
    return;
  }
  const now = new Date();
  const file = path.join(ARCHIVE_DIR, archiveFileName(now));
  const archive = readArchive(file, true);
  const backup = backupState();
  for (const item of list) {
    const data = raw.conversations[item.key];
    archive.archived.push({ key: item.key, archivedAt: now.toISOString(), reason: item.reason, lastAt: item.lastAt, data });
    raw.conversations[item.key] = {
      archived: true,
      archivedAt: now.toISOString(),
      archiveFile: path.basename(file),
      recentMessages: [],
      unread: [],
      wakeConfig: data?.wakeConfig ?? {},
      agentToken: data?.agentToken,
      lastIncomingAt: Number(data?.lastIncomingAt) || 0,
    };
    console.log(`归档 ${item.key}（${(item.bytes / 1024).toFixed(1)} KB）`);
  }
  atomicWrite(file, archive);
  atomicWrite(STATE_FILE, raw);
  console.log(`备份：${backup}`);
  console.log(`归档文件：${file}`);
}

function restore(key) {
  if (!key) throw new Error('--restore 需要会话 key');
  const raw = readState();
  if (Object.hasOwn(raw.conversations, key) && raw.conversations[key]?.archived !== true) {
    throw new Error('目标会话仍处于活动状态，拒绝覆盖。');
  }
  const files = fs.existsSync(ARCHIVE_DIR)
    ? fs.readdirSync(ARCHIVE_DIR).filter((f) => /^social-v2-\d{6}\.json$/.test(f)).sort()
    : [];
  for (const f of files) {
    const file = path.join(ARCHIVE_DIR, f);
    const archive = readArchive(file);
    const idx = archive.archived.findIndex((x) => x.key === key);
    if (idx < 0) continue;
    const backup = backupState();
    const [entry] = archive.archived.splice(idx, 1);
    raw.conversations[key] = entry.data;
    atomicWrite(STATE_FILE, raw);
    atomicWrite(file, archive);
    console.log(`已恢复 ${key}（来自 ${file}）`);
    console.log(`备份：${backup}`);
    return;
  }
  throw new Error(`归档里找不到 ${key}`);
}

try {
  if (args.includes('--restore')) restore(args[args.indexOf('--restore') + 1]);
  else if (args.includes('--apply')) apply();
  else if (args.includes('--preview') || args.length === 0) preview();
  else { usage(); process.exitCode = 2; }
} catch (error) {
  console.error(error?.message ?? error);
  process.exitCode = 1;
}
