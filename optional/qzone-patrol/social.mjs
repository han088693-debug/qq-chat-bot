// On-demand self posts and exact replies; no scheduled replies or implicit enablement.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  DEFAULT_STATE_DIR, CANDIDATE_TTL_MS, validatePatrolConfig, defaultRequest,
  isQuiet, counts, allowed, userId, plain, sourceKey, accountKey, writePolicy,
} from './core.mjs';
import { PatrolError, withState } from './state.mjs';
import { buildReplyRequest, sendNativeReply } from './native-reply.mjs';

const fail = (code, message) => { throw new PatrolError(code, message); };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const replyRecord = (cfg, account, candidate) => {
  // Keep existing own-post keys so an upgrade cannot resend an earlier reply.
  const scope = candidate.uin === account ? [accountKey(account), candidate.tid]
    : [accountKey(account), candidate.uin, candidate.tid];
  return {
    key: digest([sourceKey(cfg), ...scope, candidate.commentId, 'reply']), account: accountKey(account),
    postKey: digest(scope), personKey: digest([...scope, candidate.commentUin]),
  };
};
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x20]/.test(value);
const list = data => {
  if (!Array.isArray(data?.msglist)) fail('gateway_format', '网关没有返回可识别的动态列表');
  return data.msglist;
};
const text = (value, max) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max
      || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) fail('content_invalid', `正文须为 1 至 ${max} 字普通文本`);
  if (/@|\b\d{5,}\b/.test(value)) fail('content_private', '正文不能包含 @ 提及或账号号码');
  return value.trim();
};

async function noLinks(file) {
  let cursor = path.parse(file).root;
  for (const part of path.relative(cursor, file).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if ((await fs.lstat(cursor)).isSymbolicLink()) fail('image_path_unsafe', '图片路径不能包含链接');
  }
}

async function imagesFor(input, cfg) {
  if (!Array.isArray(input) || input.length > 9) fail('image_invalid', '最多使用 9 张本地图片');
  const images = [];
  for (const file of input) {
    if (typeof file !== 'string' || !path.isAbsolute(file)) fail('image_invalid', '图片必须是允许目录里的本地绝对路径');
    const absolute = path.resolve(file);
    const inside = cfg.imageDirs.some(root => {
      const relative = path.relative(path.resolve(root), absolute);
      return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
    });
    if (!inside) fail('image_denied', '图片不在允许目录中');
    try {
      await noLinks(absolute);
      const before = await fs.lstat(absolute);
      if (before.isSymbolicLink() || !before.isFile()) fail('image_path_unsafe', '图片必须是普通文件');
      const handle = await fs.open(absolute, 'r');
      let bytes;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) fail('image_path_unsafe', '图片路径在读取时发生变化');
        if (stat.size > cfg.imageMaxBytes) fail('image_invalid', '图片超过大小上限');
        await noLinks(absolute);
        const buffer = Buffer.alloc(cfg.imageMaxBytes + 1);
        let length = 0;
        while (length < buffer.length) {
          const read = await handle.read(buffer, length, buffer.length - length, null);
          if (!read.bytesRead) break;
          length += read.bytesRead;
        }
        if (length > cfg.imageMaxBytes) fail('image_invalid', '图片超过大小上限');
        await noLinks(absolute);
        const after = await fs.lstat(absolute);
        if (after.isSymbolicLink() || after.dev !== stat.dev || after.ino !== stat.ino) fail('image_path_unsafe', '图片路径在读取时发生变化');
        bytes = buffer.subarray(0, length);
      } finally { await handle.close(); }
      const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
      const webp = bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
      if (bytes.length > cfg.imageMaxBytes || !(png || jpeg || webp)) fail('image_invalid', '只接受 PNG、JPEG 或 WebP 图片');
      images.push({ bytes, extension: png ? '.png' : jpeg ? '.jpg' : '.webp', sha: createHash('sha256').update(bytes).digest('hex') });
    } catch (error) {
      if (error instanceof PatrolError) throw error;
      fail('image_invalid', '无法安全读取图片，请在本机检查');
    }
  }
  return images;
}

export function createSocial({
  getConfig, stateDir = DEFAULT_STATE_DIR, requestOneBot = defaultRequest,
  requestReply = sendNativeReply, now = Date.now,
}) {
  async function config() {
    let cfg;
    try { cfg = structuredClone(validatePatrolConfig(await getConfig())); }
    catch { fail('config_invalid', '空间配置无效；已停止操作'); }
    if (!cfg.enabled) fail('disabled', 'QQ 空间模块已关闭');
    if (isQuiet(cfg, now())) fail('quiet_hours', '当前处于空间静默时段');
    return cfg;
  }
  async function request(action, payload, cfg) {
    try { return await requestOneBot(action, payload, cfg); }
    catch (error) {
      if (error instanceof PatrolError) throw error;
      fail('gateway_failed', '空间请求失败；原始响应和凭据未显示');
    }
  }
  async function self(cfg) {
    const value = String((await request('get_login_info', {}, cfg))?.user_id ?? '');
    if (!userId(value)) fail('gateway_format', '无法确认当前登录账号');
    return value;
  }
  async function unchanged(cfg, account) {
    const current = await config();
    if (writePolicy(current) !== writePolicy(cfg)) fail('config_changed', '空间授权已改变；未执行写操作');
    if (await self(current) !== account) fail('candidate_account_changed', '空间登录账号已改变；未执行写操作');
    if (writePolicy(await config()) !== writePolicy(cfg)) fail('config_changed', '空间授权已改变；未执行写操作');
    return current;
  }
  async function posts(input = {}, own = false) {
    const cfg = await config();
    if (!own && (!userId(input.targetUin) || !allowed(cfg, input.targetUin))) fail('target_denied', '目标不在空间允许名单中');
    await withState(stateDir, () => {});
    const account = await self(cfg);
    const target = own ? account : input.targetUin;
    const num = Math.min(20, Math.max(1, Number(input.num) || 5));
    const data = await request('get_qzone_msg_list', { target_uin: Number(target), pos: 0, num }, cfg);
    await unchanged(cfg, account);
    return { targetUin: target, items: list(data).slice(0, num).filter(p => id(String(p?.tid ?? '')) && p?.is_private !== true)
      .map(p => ({
        postId: String(p.tid), text: plain(p.content), time: Number(p.time) || null,
        commentCount: Number.isSafeInteger(p.comment_num) && p.comment_num >= 0 ? p.comment_num : null,
      })) };
  }
  async function detail(tid, target, cfg, requireOwner = false) {
    const data = await request('get_qzone_msg_detail', { tid, target_uin: Number(target), pos: 0, num: 50 }, cfg);
    if (!data || !Array.isArray(data.comments) || data.is_private === true
        || (data.tid != null && String(data.tid) !== tid)
        || (data.uin != null && String(data.uin) !== target)
        || (requireOwner && (String(data.tid ?? '') !== tid || String(data.uin ?? '') !== target))) {
      fail('gateway_format', '无法确认说说归属及评论列表；不会创建回复候选');
    }
    return data;
  }
  async function comments(input = {}) {
    if (!id(input.postId)) fail('post_invalid', '需要读取说说返回的 postId');
    const cfg = await config();
    await withState(stateDir, () => {});
    const account = await self(cfg);
    const target = input.targetUin ?? account;
    if (!userId(target) || (target !== account && !allowed(cfg, target))) fail('target_denied', '说说属主不在空间允许名单中');
    const data = await detail(input.postId, target, cfg, target !== account);
    await unchanged(cfg, account);
    const at = now();
    return withState(stateDir, state => {
      for (const [key, candidate] of Object.entries(state.candidates)) {
        if (candidate.expiresAt <= at) delete state.candidates[key];
      }
      const items = data.comments.slice(0, 50).filter(c => id(String(c?.comment_id ?? c?.commentId ?? '')))
        .map(c => {
          const commentId = String(c.comment_id ?? c.commentId);
          const commentUin = String(c.uin ?? '');
          const time = Number(c.time);
          const known = (c.replies || []).some(r => String(r.uin) === account);
          let candidateId = null;
          const action = replyRecord(cfg, account, { uin: target, tid: input.postId, commentId, commentUin }).key;
          const eligible = userId(commentUin) && commentUin !== account && allowed(cfg, commentUin)
            && Number.isSafeInteger(time) && time > 0 && time * 1000 <= at + 60000
            && at - time * 1000 <= cfg.maxPostAgeHours * 3600000 && !known && !state.actions[action];
          if (eligible) {
            candidateId = Object.entries(state.candidates).find(([, candidate]) => candidate.kind === 'reply'
              && candidate.account === accountKey(account) && candidate.source === sourceKey(cfg)
              && candidate.uin === target && candidate.tid === input.postId
              && candidate.commentId === commentId && candidate.commentUin === commentUin)?.[0] || randomUUID();
            state.candidates[candidateId] = {
              kind: 'reply', uin: target, tid: input.postId, commentId, commentUin, time,
              source: sourceKey(cfg), account: accountKey(account), seenAt: at, expiresAt: at + CANDIDATE_TTL_MS,
            };
          }
          return { commentId, commentUin, text: plain(c.content), candidateId, alreadyReplied: known || Boolean(state.actions[action]) };
        });
      return { targetUin: target, postId: input.postId, postText: plain(data.content), items, candidateTtlMinutes: 30 };
    }, { write: true });
  }
  async function reserve(kind, cfg, record, candidate, at) {
    return withState(stateDir, state => {
      if (candidate) {
        const saved = state.candidates[candidate.id];
        if (!saved || saved.expiresAt <= at || saved.account !== record.account
            || saved.source !== sourceKey(cfg) || saved.kind !== 'reply'
            || at - saved.time * 1000 > cfg.maxPostAgeHours * 3600000) fail('candidate_expired', '回复候选已过期或账号/来源改变');
        if (!allowed(cfg, saved.commentUin)
            || (accountKey(saved.uin) !== record.account && !allowed(cfg, saved.uin))) {
          fail('target_denied', '说说属主或评论者已不在允许范围内');
        }
      }
      if (state.actions[record.key]) fail('already_reserved', '该动作已处理或结果未明；不会重复提交');
      const used = counts(state, cfg, at);
      const limit = kind === 'reply' ? cfg.dailyReplyLimit : cfg.dailyPostLimit;
      if (!limit || !cfg.hourlyLimit) fail('quota_zero', '动作配额为零');
      if (used[kind === 'reply' ? 'replies' : 'posts'] >= limit || used.hourly >= cfg.hourlyLimit) fail('quota_exhausted', '空间动作配额已用完');
      if (used.lastActionAt && at - used.lastActionAt < cfg.cooldownMinutes * 60000) fail('cooldown', '空间动作仍在冷却时间内');
      const actions = Object.values(state.actions);
      if (kind === 'reply') {
        const replies = actions.filter(a => a.kind === 'reply' && a.account === record.account);
        if (replies.some(a => at - a.at < cfg.replyMinGapSeconds * 1000)) fail('cooldown', '精准回复间隔不足');
        if (replies.filter(a => a.postKey === record.postKey).length >= cfg.replyPerPostLimit
            || replies.filter(a => a.personKey === record.personKey).length >= cfg.replyPerPersonLimit) {
          fail('quota_exhausted', '同帖或同人回复配额已用完');
        }
      } else if (actions.filter(a => a.kind === 'post' && at - a.at < 60000).length >= cfg.postPerMinuteLimit) {
        fail('quota_exhausted', '发说说已达到分钟上限');
      }
      if (cfg.dryRun) state.dryRuns = [...state.dryRuns.slice(-99), { key: record.key, kind, at }];
      else {
        const { key, ...stored } = record;
        state.actions[key] = { ...stored, kind, at, status: 'reserved' };
      }
    }, { write: true });
  }
  async function finish(key, succeeded) {
    await withState(stateDir, state => {
      if (!state.actions[key]) fail('state_corrupt', '动作预占丢失；已停止操作');
      state.actions[key].status = succeeded ? 'succeeded' : 'unknown';
    }, { write: true });
  }
  async function reply(input = {}) {
    const cfg = await config();
    if (!cfg.allowReplies) fail('action_disabled', '精准回复未开启');
    const content = text(input.content, 40);
    const candidate = await withState(stateDir, state => state.candidates[input.candidateId]);
    if (!candidate || candidate.kind !== 'reply') fail('candidate_invalid', '必须使用评论扫描返回的回复 candidateId');
    const account = await self(cfg);
    if (candidate.account !== accountKey(account)) fail('candidate_account_changed', '回复候选不属于当前登录账号');
    if (input.targetUin !== undefined && input.targetUin !== candidate.uin) fail('candidate_target_changed', '指定的说说属主与回复候选不一致');
    const target = candidate.uin;
    if (target !== account && !allowed(cfg, target)) fail('target_denied', '说说属主已不在允许范围内');
    const latest = await detail(candidate.tid, target, cfg, target !== account);
    const parent = latest.comments.find(c => String(c.comment_id ?? c.commentId) === candidate.commentId && String(c.uin) === candidate.commentUin);
    if (!parent || (parent.replies || []).some(r => String(r.uin) === account)) fail('candidate_invalid', '评论不存在、作者变化或账号已回复');
    const record = replyRecord(cfg, account, candidate);
    let cookie = '';
    if (!cfg.dryRun) {
      const data = await request('get_cookies', { domain: 'qzone.qq.com' }, cfg);
      cookie = typeof data === 'string' ? data : data?.cookies;
      buildReplyRequest({ cookie, self: account, targetUin: target, tid: candidate.tid, commentId: candidate.commentId, commentUin: candidate.commentUin, content });
    }
    await unchanged(cfg, account);
    await reserve('reply', cfg, record, { ...candidate, id: input.candidateId }, now());
    if (cfg.dryRun) return { ok: true, dryRun: true, performed: false };
    let acknowledged = false, verified = false;
    try {
      await unchanged(cfg, account);
      if (candidate.expiresAt <= now()) fail('candidate_expired', '回复候选在提交前已过期');
      acknowledged = Boolean((await requestReply({ cookie, self: account, targetUin: target, tid: candidate.tid, commentId: candidate.commentId, commentUin: candidate.commentUin, content }))?.acknowledged);
    } catch (error) {
      if (error instanceof PatrolError && !['reply_unknown', 'gateway_failed'].includes(error.code)) throw error;
    } finally { await finish(record.key, acknowledged); }
    try {
      await unchanged(cfg, account);
      const data = await detail(candidate.tid, target, cfg, true);
      await unchanged(cfg, account);
      const row = data.comments.find(c => String(c.comment_id ?? c.commentId) === candidate.commentId && String(c.uin) === candidate.commentUin);
      verified = Boolean(row?.replies?.some(r => String(r.uin) === account && String(r.content).trim() === content));
    } catch {}
    if (verified && !acknowledged) await finish(record.key, true);
    return { ok: acknowledged || verified, acknowledged, verified, uncertain: !acknowledged && !verified, retryAllowed: false };
  }
  async function post(input = {}) {
    const cfg = await config();
    if (!cfg.allowPosts) fail('action_disabled', '发说说未开启');
    const content = text(input.content, 1000);
    const images = await imagesFor(input.images ?? [], cfg);
    await withState(stateDir, () => {});
    const account = await self(cfg);
    const record = { key: digest([sourceKey(cfg), accountKey(account), content, images.map(i => i.sha), 'post']), account: accountKey(account) };
    await unchanged(cfg, account);
    await reserve('post', cfg, record, null, now());
    if (cfg.dryRun) return { ok: true, dryRun: true, performed: false, imageCount: images.length };
    let acknowledged = false, verified = false, postId = '', snapshots = [];
    try {
      // Freeze already validated bytes in the protected state directory; the gateway never reopens the source.
      await withState(stateDir, async () => {
        for (const image of images) {
          const file = path.join(stateDir, `outbound-${randomUUID()}${image.extension}`);
          await fs.writeFile(file, image.bytes, { flag: 'wx', mode: 0o600 });
          snapshots.push(file);
        }
      });
      await unchanged(cfg, account);
      const result = await request('send_qzone_msg', { content, ...(snapshots.length ? { images: snapshots } : {}) }, cfg);
      postId = String(result?.tid ?? result?.t1_tid ?? '');
      acknowledged = id(postId);
    } catch (error) {
      if (error instanceof PatrolError && error.code !== 'gateway_failed') throw error;
    } finally {
      await finish(record.key, acknowledged);
      for (const file of snapshots) await fs.unlink(file).catch(() => {});
    }
    if (acknowledged) {
      try {
        const data = await request('get_qzone_msg_list', { target_uin: Number(account), pos: 0, num: 20 }, cfg);
        verified = list(data).some(p => String(p.tid) === postId);
      } catch {}
    }
    return { ok: acknowledged || verified, postId: acknowledged ? postId : null, acknowledged, verified,
      uncertain: !acknowledged && !verified, retryAllowed: false };
  }
  return { selfPosts: input => posts(input, true), userPosts: input => posts(input), postComments: comments, replyComment: reply, post };
}
