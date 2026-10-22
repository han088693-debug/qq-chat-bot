// Independently implemented persistence for the optional patrol module.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class PatrolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PatrolError';
    this.code = code;
  }
}

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const time = value => Number.isSafeInteger(value) && value >= 0;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function emptyState() {
  return { version: 1, candidates: {}, actions: {}, dryRuns: [], lastScanAt: 0, lastScanCount: 0 };
}

function validState(state) {
  if (!object(state) || state.version !== 1 || !object(state.candidates) || !object(state.actions)
      || !Array.isArray(state.dryRuns) || !time(state.lastScanAt) || !time(state.lastScanCount)) return false;
  if (!Object.entries(state.candidates).every(([id, c]) =>
    /^[a-f0-9-]{36}$/.test(id) && object(c) && typeof c.uin === 'string' && /^[1-9]\d{0,15}$/.test(c.uin)
      && Number.isSafeInteger(Number(c.uin)) && typeof c.tid === 'string' && c.tid.length > 0 && c.tid.length <= 200
      && digest(c.source) && (c.account === undefined || digest(c.account))
      && (c.kind === undefined || (c.kind === 'reply'
        && digest(c.account)
        && typeof c.commentId === 'string' && c.commentId.length > 0 && c.commentId.length <= 200
        && typeof c.commentUin === 'string' && /^[1-9]\d{0,15}$/.test(c.commentUin)
        && Number.isSafeInteger(Number(c.commentUin))))
      && time(c.time) && time(c.seenAt) && time(c.expiresAt))) return false;
  if (!Object.entries(state.actions).every(([key, a]) => digest(key) && object(a)
      && ['like', 'comment', 'reply', 'post'].includes(a.kind) && time(a.at)
      && (a.account === undefined || digest(a.account))
      && (a.postKey === undefined || digest(a.postKey)) && (a.personKey === undefined || digest(a.personKey))
      && (a.kind !== 'reply' || (digest(a.account) && digest(a.postKey) && digest(a.personKey)))
      && (a.kind !== 'post' || digest(a.account))
      && ['reserved', 'succeeded', 'unknown'].includes(a.status))) return false;
  const watcher = state.watcher;
  if (watcher !== undefined && (!object(watcher) || !object(watcher.baselines) || !object(watcher.notifications) || !object(watcher.lastRuns)
      || !Object.entries(watcher.baselines).every(([key, at]) => digest(key) && time(at))
      || !Object.entries(watcher.lastRuns).every(([key, date]) => digest(key) && /^\d{4}-\d{2}-\d{2}$/.test(date))
      || !Object.entries(watcher.notifications).every(([key, item]) => digest(key) && object(item)
        && time(item.at) && ['baseline', 'reserved', 'delivered', 'unknown'].includes(item.status)))) return false;
  return state.dryRuns.every(a => object(a) && digest(a.key)
    && ['like', 'comment', 'reply', 'post'].includes(a.kind) && time(a.at));
}

async function readState(file) {
  let bytes;
  try {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new PatrolError('state_path_unsafe', '巡逻状态文件必须是普通文件，不能是链接或目录');
    bytes = await fs.readFile(file);
  }
  catch (error) {
    if (error.code === 'ENOENT') return emptyState();
    if (error instanceof PatrolError) throw error;
    throw new PatrolError('state_read_failed', '无法读取巡逻状态；已停止操作，请在本机检查状态目录');
  }
  try {
    if (bytes.length > 16 * 1024 * 1024) throw new Error();
    const value = JSON.parse(bytes.toString('utf8'));
    if (!validState(value)) throw new Error();
    return value;
  } catch {
    throw new PatrolError('state_corrupt', '巡逻状态损坏或格式不支持；不会清空状态或重置额度');
  }
}

async function writeState(file, state) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(state));
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, file);
  } catch {
    throw new PatrolError('state_write_failed', '无法持久保存巡逻状态；已停止操作，不会继续发送请求');
  } finally {
    await handle?.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
  }
}

async function ensureDirectory(dir) {
  const absolute = path.resolve(dir);
  let current = path.parse(absolute).root;
  for (const part of path.relative(current, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { await fs.mkdir(current); }
    catch (error) { if (error.code !== 'EEXIST') throw new PatrolError('state_write_failed', '无法建立巡逻状态目录'); }
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new PatrolError('state_path_unsafe', '巡逻状态目录不能包含链接或非目录项');
  }
}

async function acquire(dir, name) {
  try { await ensureDirectory(dir); }
  catch (error) {
    if (error instanceof PatrolError) throw error;
    throw new PatrolError('state_write_failed', '无法检查巡逻状态目录；已停止操作');
  }
  const file = path.join(dir, name);
  const deadline = Date.now() + 2000;
  while (true) {
    try {
      const handle = await fs.open(file, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() })); }
      catch (error) {
        await handle.close();
        await fs.unlink(file).catch(() => {});
        throw error;
      }
      return async () => {
        await handle.close();
        await fs.unlink(file);
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw new PatrolError('state_write_failed', '无法锁定巡逻状态；已停止操作');
      if (Date.now() >= deadline) {
        throw new PatrolError('state_busy', '巡逻状态正在使用或留有未释放的锁；请稍后或在本机检查，未执行操作');
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
}

async function withLock(dir, name, callback) {
  const release = await acquire(path.resolve(dir), name);
  try {
    return await callback();
  } finally {
    try { await release(); }
    catch { throw new PatrolError('state_lock_failed', '巡逻状态锁未能释放；已停止操作，请在本机检查'); }
  }
}

export async function withState(dir, callback, { write = false } = {}) {
  return withLock(dir, 'patrol.lock', async () => {
    const file = path.join(dir, 'patrol-state.json');
    const state = await readState(file);
    const result = await callback(state);
    if (write) await writeState(file, state);
    return result;
  });
}

export function withRunnerLock(dir, callback) {
  return withLock(dir, 'runner.lock', callback);
}

export function withWatcherLock(dir, callback) {
  return withLock(dir, 'watcher.lock', callback);
}
