// Independent implementation. No source or word lists copied from qzone-sweeper.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ROOT } from '../config.mjs';
import { PatrolError, withState } from './state.mjs';

export const CANDIDATE_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_STATE_DIR = path.join(ROOT, 'state', 'optional', 'qzone-patrol');
export const userId = value => typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value)
  && Number.isSafeInteger(Number(value));
const fail = (code, message) => { throw new PatrolError(code, message); };
const actionKey = (candidate, kind) => createHash('sha256')
  .update(JSON.stringify([candidate.uin, candidate.tid, kind])).digest('hex');
export const sourceKey = config => createHash('sha256')
  .update(JSON.stringify([origin(config.baseUrl), config.accessTokenEnv])).digest('hex');
export const accountKey = uin => createHash('sha256').update(uin).digest('hex');
export const writePolicy = config => JSON.stringify([
  config.enabled, config.dryRun, config.allowLikes, config.allowComments,
  [...new Set(config.allowedUsers)].sort(), [...new Set(config.blockedUsers)].sort(),
  sourceKey(config), config.dailyLikeLimit, config.dailyCommentLimit, config.hourlyLimit,
  config.cooldownMinutes, config.maxPostAgeHours,
  config.quietHours.start, config.quietHours.end, config.quietHours.timeZone,
  config.allowReplies, config.allowPosts, config.dailyReplyLimit, config.replyPerPostLimit,
  config.replyPerPersonLimit, config.replyMinGapSeconds, config.dailyPostLimit,
  config.postPerMinuteLimit, config.imageDirs, config.imageMaxBytes,
]);
export const WATCHER_DEFAULTS = {
  enabled: false, dryRun: true, intervalMinutes: 10, dailyAt: '21:00',
  bridgeUrl: 'http://127.0.0.1:3100', bridgeTokenEnv: 'QQ_BRIDGE_CONSOLE_TOKEN', sessionKey: '',
};

function origin(value) {
  let url;
  try { url = new URL(value); } catch { fail('config_invalid', '巡逻 HTTP 地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    fail('config_invalid', '巡逻 HTTP 地址只允许不含凭据或路径的本机环回地址');
  }
  return url.origin;
}

export function validatePatrolConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) fail('config_invalid', '巡逻配置无效');
  config = {
    allowReplies: false, allowPosts: false, dailyReplyLimit: 10, replyPerPostLimit: 3,
    replyPerPersonLimit: 1, replyMinGapSeconds: 60, dailyPostLimit: 20, postPerMinuteLimit: 3,
    imageDirs: [], imageMaxBytes: 8 * 1024 * 1024, ...config,
  };
  if (Object.hasOwn(config, 'watcher') && (!config.watcher || typeof config.watcher !== 'object' || Array.isArray(config.watcher))) fail('config_invalid', '守望者配置无效');
  config.watcher = { ...WATCHER_DEFAULTS, ...config.watcher };
  for (const key of ['enabled', 'dryRun', 'allowLikes', 'allowComments', 'allowReplies', 'allowPosts']) {
    if (typeof config[key] !== 'boolean') fail('config_invalid', '巡逻开关必须为 true 或 false');
  }
  for (const key of ['allowedUsers', 'blockedUsers']) {
    if (!Array.isArray(config[key]) || config[key].some(id => !userId(id))) fail('config_invalid', '巡逻目标名单格式无效');
  }
  origin(config.baseUrl);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.accessTokenEnv ?? '')) fail('config_invalid', '巡逻令牌环境变量名称无效');
  for (const [key, min, max] of [
    ['dailyLikeLimit', 0, 200], ['dailyCommentLimit', 0, 50], ['hourlyLimit', 0, 100],
    ['cooldownMinutes', 0, 1440], ['scanPageSize', 1, 50], ['maxPostAgeHours', 1, 720],
    ['dailyReplyLimit', 0, 100], ['replyPerPostLimit', 0, 20], ['replyPerPersonLimit', 0, 10],
    ['replyMinGapSeconds', 60, 86400], ['dailyPostLimit', 0, 200], ['postPerMinuteLimit', 0, 3],
    ['imageMaxBytes', 1, 8 * 1024 * 1024],
  ]) {
    if (!Number.isSafeInteger(config[key]) || config[key] < min || config[key] > max) fail('config_invalid', '巡逻数量或时间限制无效');
  }
  if (!Array.isArray(config.imageDirs) || config.imageDirs.some(p => typeof p !== 'string' || !path.isAbsolute(p))) {
    fail('config_invalid', '配图允许目录必须是绝对路径数组');
  }
  const w = config.watcher;
  if (typeof w.enabled !== 'boolean' || typeof w.dryRun !== 'boolean'
      || !Number.isSafeInteger(w.intervalMinutes) || w.intervalMinutes < 5 || w.intervalMinutes > 1440
      || typeof w.dailyAt !== 'string' || (w.dailyAt && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(w.dailyAt))
      || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(w.bridgeTokenEnv ?? '')
      || typeof w.sessionKey !== 'string'
      || (w.sessionKey && (!/^private:[1-9]\d{0,15}$/.test(w.sessionKey) || !Number.isSafeInteger(Number(w.sessionKey.slice(8)))))
      || (w.enabled && !w.sessionKey)) fail('config_invalid', '守望者开关、时间或目标会话无效');
  origin(w.bridgeUrl);
  const q = config.quietHours;
  if (!q || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(q.start ?? '')
      || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(q.end ?? '') || typeof q.timeZone !== 'string') {
    fail('config_invalid', '巡逻静默时段无效');
  }
  try { new Intl.DateTimeFormat('en', { timeZone: q.timeZone }).format(0); }
  catch { fail('config_invalid', '巡逻时区无效'); }
  return config;
}

export function calendar(at, zone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(at).map(part => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

export function isQuiet(config, at) {
  const minute = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const { start, end, timeZone } = config.quietHours;
  const a = minute(start), b = minute(end), current = calendar(at, timeZone).minute;
  return a === b ? false : a < b ? current >= a && current < b : current >= a || current < b;
}

export function counts(state, config, at) {
  const records = Object.values(state.actions);
  const today = calendar(at, config.quietHours.timeZone).date;
  const daily = records.filter(action => calendar(action.at, config.quietHours.timeZone).date === today);
  return {
    likes: daily.filter(action => action.kind === 'like').length,
    comments: daily.filter(action => action.kind === 'comment').length,
    replies: daily.filter(action => action.kind === 'reply').length,
    posts: daily.filter(action => action.kind === 'post').length,
    hourly: records.filter(action => at - action.at < 3600000).length,
    lastActionAt: records.reduce((last, action) => Math.max(last, action.at), 0),
  };
}

export function allowed(config, uin) {
  return config.allowedUsers.includes(uin) && !config.blockedUsers.includes(uin);
}

function list(data) {
  const result = Array.isArray(data) ? data : data?.msglist ?? data?.list ?? data?.feeds;
  if (!Array.isArray(result)) fail('gateway_format', '网关返回了不支持的动态列表格式');
  return result;
}

export function plain(value) {
  return String(value ?? '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(?:div|p)>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').trim().slice(0, 600);
}

export async function defaultRequest(action, payload, config) {
  let token = String(process.env[config.accessTokenEnv] || '').trim();
  if (!token) {
    try {
      const bridge = JSON.parse((await fs.readFile(path.join(ROOT, 'config.json'), 'utf8')).replace(/^\uFEFF/, ''));
      token = String(bridge?.snowluma?.accessToken || '').trim();
    } catch {}
  }
  if (!token) fail('token_missing', '未配置巡逻使用的 SnowLuma HTTP 令牌');
  try {
    const response = await fetch(`${origin(config.baseUrl)}/${action}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 8 * 1024 * 1024) throw new Error();
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!response.ok || body?.status !== 'ok' || (body.retcode != null && body.retcode !== 0)) throw new Error();
    return body.data;
  } catch { fail('gateway_failed', 'SnowLuma 请求失败；原始响应和凭据未显示，请在本机检查'); }
}

export function createPatrol({ getConfig, stateDir = DEFAULT_STATE_DIR, requestOneBot = defaultRequest, now = Date.now }) {
  async function config(requireEnabled = true) {
    let value;
    try { value = structuredClone(validatePatrolConfig(await getConfig())); }
    catch { fail('config_invalid', '无法读取有效的巡逻配置；已停止操作，不会使用默认值继续运行'); }
    if (requireEnabled && !value.enabled) fail('disabled', 'QQ 空间巡逻模块已关闭');
    return value;
  }

  async function request(action, payload, cfg) {
    try { return await requestOneBot(action, payload, cfg); }
    catch (error) {
      if (error instanceof PatrolError) throw error;
      fail('gateway_failed', 'SnowLuma 请求失败；原始响应和凭据未显示');
    }
  }

  async function scan() {
    const cfg = await config();
    const at = now();
    if (isQuiet(cfg, at)) return { items: [], dryRun: cfg.dryRun, reason: 'quiet_hours' };
    const users = [...new Set(cfg.allowedUsers)].filter(uin => allowed(cfg, uin));
    if (!users.length) return { items: [], dryRun: cfg.dryRun, reason: 'no_allowed_users' };
    // Check existing state before contacting a gateway; corruption is never an empty state.
    await withState(stateDir, () => {});
    const login = await request('get_login_info', {}, cfg);
    const self = String(login?.user_id ?? '');
    if (!userId(self)) fail('gateway_format', '无法确认当前登录账号；未扫描任何目标');
    const posts = [];
    let failedTargets = 0;
    for (const uin of users.filter(uin => uin !== self)) {
      if (writePolicy(await config()) !== writePolicy(cfg)) fail('config_changed', '巡逻配置已变更，已停止本轮扫描');
      try {
        const response = await request('get_qzone_msg_list', {
          target_uin: Number(uin), pos: 0, num: Math.min(3, cfg.scanPageSize),
        }, cfg);
        for (const item of list(response).slice(0, Math.min(3, cfg.scanPageSize))) {
          if (!item || typeof item !== 'object' || item.is_private === true) continue;
          const tid = String(item.tid ?? item.id ?? '');
          let time = Number(item.time ?? item.abstime);
          if (time > 1e12) time = Math.floor(time / 1000);
          if (!tid || tid.length > 200 || !Number.isSafeInteger(time) || time <= 0
              || time * 1000 > at + 60000 || at - time * 1000 > cfg.maxPostAgeHours * 3600000) continue;
          if (posts.some(post => post.uin === uin && post.tid === tid)) continue;
          posts.push({ uin, tid, text: plain(item.content ?? item.text ?? item.summary), time });
        }
      } catch { failedTargets++; }
    }
    const targetCount = users.filter(uin => uin !== self).length;
    if (targetCount && failedTargets === targetCount) fail('scan_failed', '本轮目标动态均未成功读取；不会把接口失败解释为空空间');
    if (writePolicy(await config()) !== writePolicy(cfg)) fail('config_changed', '巡逻配置已变更，未保存本轮候选');
    const picked = posts.sort((a, b) => b.time - a.time).slice(0, cfg.scanPageSize);
    const items = await withState(stateDir, state => {
      for (const [id, candidate] of Object.entries(state.candidates)) {
        if (candidate.expiresAt <= at || !allowed(cfg, candidate.kind === 'reply' ? candidate.commentUin : candidate.uin)) delete state.candidates[id];
      }
      const result = picked.map(post => {
        const old = Object.entries(state.candidates).find(([, candidate]) => candidate.uin === post.uin && candidate.tid === post.tid);
        const candidateId = old?.[0] || randomUUID();
        state.candidates[candidateId] = {
          uin: post.uin, tid: post.tid, time: post.time, source: sourceKey(cfg),
          account: accountKey(self), seenAt: at, expiresAt: at + CANDIDATE_TTL_MS,
        };
        return { candidateId, ...post };
      });
      state.lastScanAt = at;
      state.lastScanCount = result.length;
      return result;
    }, { write: true });
    return { items, dryRun: cfg.dryRun, failedTargets, candidateTtlMinutes: CANDIDATE_TTL_MS / 60000 };
  }

  async function act(kind, input) {
    const cfg = await config();
    if (!cfg[kind === 'like' ? 'allowLikes' : 'allowComments']) fail('action_disabled', '该类巡逻写操作未开启');
    const at = now();
    if (isQuiet(cfg, at)) fail('quiet_hours', '当前处于巡逻静默时段，未执行写操作');
    const candidateId = input?.candidateId;
    if (typeof candidateId !== 'string' || !/^[a-f0-9-]{36}$/.test(candidateId)) fail('candidate_invalid', '必须使用近期扫描返回的 candidateId');
    let content;
    if (kind === 'comment') {
      content = typeof input?.content === 'string' ? input.content.trim() : '';
      if (!content || content.length > 200 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(content)) fail('comment_invalid', '评论需为 1 至 200 字的普通文本');
      if (/@|\b\d{5,}\b/.test(content)) fail('comment_private', '评论不能包含 @ 提及或账号号码，请修改正文后重新确认');
    }
    const reservation = await withState(stateDir, state => {
      const candidate = state.candidates[candidateId];
      if (candidate?.kind === 'reply') fail('candidate_invalid', '评论回复候选只能用于精准回复工具');
      if (!candidate || candidate.expiresAt <= at || at - candidate.time * 1000 > cfg.maxPostAgeHours * 3600000) {
        fail('candidate_expired', '候选不存在或已过期，请先重新扫描');
      }
      if (!candidate.account || candidate.source !== sourceKey(cfg)) fail('candidate_source_changed', '巡逻来源无法确认或已变更，请在当前配置下重新扫描');
      if (!allowed(cfg, candidate.uin)) fail('target_denied', '候选目标已不在允许范围内');
      const key = actionKey(candidate, kind);
      if (state.actions[key]) fail('already_reserved', '该动作已执行或结果未明；不会重复提交');
      const used = counts(state, cfg, at);
      const dailyLimit = kind === 'like' ? cfg.dailyLikeLimit : cfg.dailyCommentLimit;
      if (dailyLimit === 0 || cfg.hourlyLimit === 0) fail('quota_zero', '该类动作配额为 0，禁止执行');
      if (used[kind === 'like' ? 'likes' : 'comments'] >= dailyLimit || used.hourly >= cfg.hourlyLimit) {
        fail('quota_exhausted', '巡逻动作已达到本日或最近一小时上限');
      }
      if (used.lastActionAt && at - used.lastActionAt < cfg.cooldownMinutes * 60000) fail('cooldown', '巡逻动作仍在冷却时间内');
      if (cfg.dryRun) {
        state.dryRuns.push({ key, kind, at });
        state.dryRuns = state.dryRuns.slice(-100);
      } else {
        // The reservation is durable before any outbound write; even a crash cannot repeat it.
        state.actions[key] = { kind, at, status: 'reserved' };
      }
      return { key, candidate };
    }, { write: true });
    if (cfg.dryRun) return { ok: true, dryRun: true, performed: false, action: kind, candidateId };
    let succeeded = false;
    try {
      const current = await config();
      if (writePolicy(current) !== writePolicy(cfg) || current.dryRun || !current[kind === 'like' ? 'allowLikes' : 'allowComments']
          || !allowed(current, reservation.candidate.uin) || isQuiet(current, now())) {
        fail('config_changed', '巡逻授权已变更，预占保留，未执行写操作');
      }
      const candidate = reservation.candidate;
      const login = await request('get_login_info', {}, current);
      const self = String(login?.user_id ?? '');
      if (!userId(self) || candidate.account !== accountKey(self) || candidate.uin === self) {
        fail('candidate_account_changed', '无法确认扫描时的登录账号；预占保留，请检查本机账号并重新扫描');
      }
      const verified = await config();
      if (writePolicy(verified) !== writePolicy(cfg) || isQuiet(verified, now())
          || candidate.expiresAt <= now() || now() - candidate.time * 1000 > verified.maxPostAgeHours * 3600000) {
        fail('config_changed', '巡逻授权或候选有效期已变更，预占保留，未执行写操作');
      }
      await request(kind === 'like' ? 'like_qzone' : 'comment_qzone', {
        tid: candidate.tid, target_uin: Number(candidate.uin),
        ...(kind === 'like' ? { abstime: candidate.time } : { content }),
      }, verified);
      succeeded = true;
    } finally {
      await withState(stateDir, state => {
        if (!state.actions[reservation.key]) fail('state_corrupt', '巡逻动作预占丢失；已停止操作');
        state.actions[reservation.key].status = succeeded ? 'succeeded' : 'unknown';
      }, { write: true });
    }
    return { ok: true, dryRun: false, performed: true, action: kind, candidateId };
  }

  async function status() {
    const cfg = await config(false);
    const at = now();
    return withState(stateDir, state => ({
      enabled: cfg.enabled, dryRun: cfg.dryRun, allowLikes: cfg.allowLikes, allowComments: cfg.allowComments,
      allowReplies: cfg.allowReplies, allowPosts: cfg.allowPosts,
      quiet: isQuiet(cfg, at), timeZone: cfg.quietHours.timeZone,
      counts: counts(state, cfg, at),
      limits: { dailyLikes: cfg.dailyLikeLimit, dailyComments: cfg.dailyCommentLimit,
        dailyReplies: cfg.dailyReplyLimit, dailyPosts: cfg.dailyPostLimit, hourly: cfg.hourlyLimit },
      lastScanAt: state.lastScanAt, lastScanCount: state.lastScanCount,
      activeCandidates: Object.values(state.candidates).filter(candidate => candidate.account
        && candidate.source === sourceKey(cfg) && candidate.expiresAt > at && allowed(cfg, candidate.uin)).length,
      dryRunCount: state.dryRuns.length, candidateTtlMinutes: CANDIDATE_TTL_MS / 60000,
    }));
  }
  return { scan, like: input => act('like', input), comment: input => act('comment', input), status };
}
