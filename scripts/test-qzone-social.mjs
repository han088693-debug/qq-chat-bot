// Offline fixtures only: injected transports, synthetic accounts, isolated temporary state.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSocial } from '../optional/qzone-patrol/social.mjs';
import { createPatrol, sourceKey, accountKey } from '../optional/qzone-patrol/core.mjs';
import { createPatrolServer } from '../optional/qzone-patrol/server.mjs';
import { buildReplyRequest, parseReplyResponse } from '../optional/qzone-patrol/native-reply.mjs';

const defaults = JSON.parse(await fs.readFile(new URL('../optional/config.example.json', import.meta.url))).qzonePatrol;
const code = expected => error => error.code === expected;
const fixture = async (t, patch = {}) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qzone-social-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const f = {
    dir, now: Date.parse('2026-10-22T04:00:00Z'), account: '101', calls: [], replyCalls: [],
    cfg: { ...structuredClone(defaults), enabled: true, allowedUsers: ['202'], cooldownMinutes: 0, ...patch },
    comments: [{ comment_id: 'c1', uin: '202', content: '合成评论', replies: [] }],
  };
  f.comments[0].time = f.now / 1000 - 60;
  f.request = async (action, payload) => {
    f.calls.push({ action, payload });
    if (f.hook) {
      const result = await f.hook(action, payload);
      if (result !== undefined) return result;
    }
    if (action === 'get_login_info') return { user_id: f.account };
    if (action === 'get_qzone_msg_list') return { msglist: [{ tid: 'own-post', time: f.now / 1000 - 60, content: '合成动态', comment_num: 1 }] };
    if (action === 'get_qzone_msg_detail') return { tid: payload.tid, uin: payload.target_uin, content: '合成动态上下文', comments: structuredClone(f.comments) };
    if (action === 'get_cookies') return { cookies: `uin=o${f.account}; p_skey=fixture-only` };
    if (action === 'send_qzone_msg') return { tid: 'own-post' };
    throw new Error(`Unmocked action: ${action}`);
  };
  f.reply = async input => {
    f.replyCalls.push(input);
    const saved = JSON.parse(await fs.readFile(path.join(dir, 'patrol-state.json')));
    assert.ok(Object.values(saved.actions).some(a => a.kind === 'reply' && a.status === 'reserved'));
    if (f.replyHook) return f.replyHook(input);
    f.comments[0].replies.push({ uin: f.account, content: input.content });
    return { acknowledged: true };
  };
  f.make = () => createSocial({ getConfig: () => f.cfg, stateDir: dir, requestOneBot: f.request, requestReply: f.reply, now: () => f.now });
  f.social = f.make();
  f.candidate = async () => (await f.social.postComments({ postId: 'own-post' })).items.find(i => i.candidateId)?.candidateId;
  f.state = async () => JSON.parse(await fs.readFile(path.join(dir, 'patrol-state.json')));
  return f;
};

test('new defaults are disabled, invalid configuration and quiet hours make no requests', async t => {
  assert.equal(defaults.allowReplies, false);
  assert.equal(defaults.allowPosts, false);
  const f = await fixture(t);
  await assert.rejects(f.social.post({ content: '合成动态' }), code('action_disabled'));
  await assert.rejects(f.social.replyComment({ content: '合成回复' }), code('action_disabled'));
  f.cfg.enabled = false;
  await assert.rejects(f.social.selfPosts(), code('disabled'));
  f.cfg.enabled = true; f.cfg.allowPosts = 'false';
  await assert.rejects(f.social.selfPosts(), code('config_invalid'));
  f.cfg.allowPosts = false; f.now = Date.parse('2026-10-21T18:00:00Z');
  await assert.rejects(f.social.selfPosts(), code('quiet_hours'));
  assert.equal(f.calls.length, 0);
});

test('self posts and explicit user posts preserve unknown counts and deny unlisted targets', async t => {
  const f = await fixture(t);
  await assert.rejects(f.social.userPosts({ targetUin: '303' }), code('target_denied'));
  assert.equal(f.calls.length, 0);
  assert.equal((await f.social.selfPosts()).targetUin, '101');
  f.hook = action => action === 'get_qzone_msg_list' ? { msglist: [{ tid: 'fixture', content: '合成动态' }] } : undefined;
  assert.equal((await f.social.userPosts({ targetUin: '202' })).items[0].commentCount, null);
  f.cfg.blockedUsers = ['202'];
  await assert.rejects(f.social.userPosts({ targetUin: '202' }), code('target_denied'));
});

test('comment candidates bind account, allowed commenter, time, and exclude existing own replies', async t => {
  const f = await fixture(t);
  f.comments.push(
    { comment_id: 'c2', uin: '303', content: '非名单', time: f.now / 1000 },
    { comment_id: 'c3', uin: '101', content: '自己', time: f.now / 1000 },
    { comment_id: 'c4', uin: '202', content: '已回', time: f.now / 1000, replies: [{ uin: '101', content: '合成回复' }] },
  );
  const result = await f.social.postComments({ postId: 'own-post' });
  assert.equal(result.items.filter(x => x.candidateId).length, 1);
  const raw = await fs.readFile(path.join(f.dir, 'patrol-state.json'), 'utf8');
  assert.ok(!raw.includes('合成评论'));
  assert.ok(!raw.includes('合成回复'));
  assert.equal((await f.state()).candidates[result.items[0].candidateId].kind, 'reply');
  f.hook = action => action === 'get_qzone_msg_detail' ? { uin: '303', comments: f.comments } : undefined;
  await assert.rejects(f.social.postComments({ postId: 'own-post' }), code('gateway_format'));
});

test('dry reply does not fetch cookies, write externally, or consume actual action quota', async t => {
  const f = await fixture(t, { allowReplies: true });
  const candidateId = await f.candidate();
  assert.equal((await f.social.replyComment({ candidateId, content: '合成回复' })).dryRun, true);
  assert.equal(f.replyCalls.length, 0);
  assert.ok(!f.calls.some(c => c.action === 'get_cookies'));
  assert.deepEqual((await f.state()).actions, {});
});

test('reply reserves before dispatch, verifies author and content, and blocks repeat after restart', async t => {
  const f = await fixture(t, { allowReplies: true, dryRun: false });
  const candidateId = await f.candidate();
  const result = await f.social.replyComment({ candidateId, content: '合成回复' });
  assert.equal(result.acknowledged, true);
  assert.equal(result.verified, true);
  assert.equal(result.retryAllowed, false);
  f.comments[0].replies = [];
  await assert.rejects(f.make().replyComment({ candidateId, content: '合成回复' }), code('already_reserved'));
  assert.equal(f.replyCalls.length, 1);
});

test('timeout and missing acknowledgment keep unknown reservation; content-only matches are not verification', async t => {
  const f = await fixture(t, { allowReplies: true, dryRun: false });
  const candidateId = await f.candidate();
  f.replyHook = () => {
    f.comments[0].replies = [{ uin: '303', content: '合成回复' }];
    throw new Error('synthetic timeout');
  };
  const result = await f.social.replyComment({ candidateId, content: '合成回复' });
  assert.equal(result.uncertain, true);
  assert.equal(result.verified, false);
  assert.equal(Object.values((await f.state()).actions)[0].status, 'unknown');
  await assert.rejects(f.make().replyComment({ candidateId, content: '另一个说法' }), code('already_reserved'));
  assert.equal(f.replyCalls.length, 1);
});

test('explicit post owner binds candidates, reply transport and transient post context', async t => {
  const f = await fixture(t, { allowReplies: true, dryRun: false, allowedUsers: ['202', '303'] });
  const result = await f.social.postComments({ postId: 'other-post', targetUin: '303' });
  assert.equal(result.targetUin, '303');
  assert.equal(result.postText, '合成动态上下文');
  const candidateId = result.items[0].candidateId;
  assert.equal((await f.state()).candidates[candidateId].uin, '303');
  await assert.rejects(f.social.replyComment({ candidateId, targetUin: '202', content: '合成回复' }), code('candidate_target_changed'));
  const reply = await f.social.replyComment({ candidateId, targetUin: '303', content: '合成回复' });
  assert.equal(reply.verified, true);
  assert.equal(f.replyCalls[0].self, '101');
  assert.equal(f.replyCalls[0].targetUin, '303');
  assert.ok(f.calls.filter(c => c.action === 'get_qzone_msg_detail').every(c => c.payload.target_uin === 303));
  assert.ok(!(await fs.readFile(path.join(f.dir, 'patrol-state.json'), 'utf8')).includes('合成动态上下文'));
});

test('comment reads reject unlisted owners and cannot turn ambiguous ownership into a reply candidate', async t => {
  const f = await fixture(t, { allowReplies: true });
  await assert.rejects(f.social.postComments({ postId: 'other-post', targetUin: '303' }), code('target_denied'));
  assert.ok(!f.calls.some(c => c.action === 'get_qzone_msg_detail'));
  f.cfg.allowedUsers.push('303');
  for (const patch of [{ uin: undefined }, { tid: undefined }, { uin: '404' }, { tid: 'wrong-post' }, { is_private: true }]) {
    f.hook = (action, payload) => action === 'get_qzone_msg_detail'
      ? { tid: payload.tid, uin: payload.target_uin, comments: f.comments, ...patch } : undefined;
    await assert.rejects(f.social.postComments({ postId: 'other-post', targetUin: '303' }), code('gateway_format'));
  }
  await assert.rejects(f.state(), error => error.code === 'ENOENT');
  assert.equal(f.replyCalls.length, 0);
});

test('reply rechecks a bound owner and policy changes before dispatch', async t => {
  const f = await fixture(t, { allowReplies: true, dryRun: false, allowedUsers: ['202', '303'] });
  const candidateId = (await f.social.postComments({ postId: 'other-post', targetUin: '303' })).items[0].candidateId;
  f.cfg.blockedUsers = ['303'];
  await assert.rejects(f.social.replyComment({ candidateId, content: '合成回复' }), code('target_denied'));
  f.cfg.blockedUsers = [];
  f.hook = (action, payload) => action === 'get_qzone_msg_detail'
    ? { tid: payload.tid, uin: '404', comments: f.comments } : undefined;
  await assert.rejects(f.social.replyComment({ candidateId, content: '合成回复' }), code('gateway_format'));
  f.hook = async action => {
    if (action === 'get_login_info' && Object.values((await f.state()).actions).some(a => a.status === 'reserved')) {
      f.cfg.allowedUsers = ['202'];
    }
  };
  await assert.rejects(f.social.replyComment({ candidateId, content: '合成回复' }), code('config_changed'));
  assert.equal(Object.values((await f.state()).actions)[0].status, 'unknown');
  assert.equal(f.replyCalls.length, 0);
});

test('same identifiers on distinct allowed post owners keep separate durable reply identities', async t => {
  const f = await fixture(t, { allowReplies: true, dryRun: false, allowedUsers: ['202', '303', '404'] });
  f.replyHook = () => ({ acknowledged: true });
  for (const targetUin of ['303', '404']) {
    const candidateId = (await f.social.postComments({ postId: 'same-post', targetUin })).items[0].candidateId;
    await f.social.replyComment({ candidateId, targetUin, content: '合成回复' });
    f.now += 61000;
  }
  assert.equal(f.replyCalls.length, 2);
  assert.equal(Object.keys((await f.state()).actions).length, 2);
});

test('own-post reservations from the previous release still prevent a duplicate reply', async t => {
  const f = await fixture(t, { allowReplies: true, dryRun: false });
  const candidateId = await f.candidate();
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const account = accountKey(f.account);
  const state = await f.state();
  state.actions[hash([sourceKey(f.cfg), account, 'own-post', 'c1', 'reply'])] = {
    kind: 'reply', account, postKey: hash([account, 'own-post']), personKey: hash([account, 'own-post', '202']),
    status: 'unknown', at: f.now,
  };
  await fs.writeFile(path.join(f.dir, 'patrol-state.json'), JSON.stringify(state));
  await assert.rejects(f.make().replyComment({ candidateId, content: '合成回复' }), code('already_reserved'));
  assert.equal(f.replyCalls.length, 0);
  assert.equal(Object.keys((await f.state()).actions).length, 1);
});

test('readback can promote an unknown reply without retransmitting it', async t => {
  const f = await fixture(t, { allowReplies: true, dryRun: false });
  const candidateId = await f.candidate();
  f.replyHook = input => {
    f.comments[0].replies.push({ uin: f.account, content: input.content });
    throw new Error('synthetic timeout');
  };
  const result = await f.social.replyComment({ candidateId, content: '合成回复' });
  assert.equal(result.acknowledged, false);
  assert.equal(result.verified, true);
  assert.equal(result.uncertain, false);
  assert.equal(result.retryAllowed, false);
  assert.equal(Object.values((await f.state()).actions)[0].status, 'succeeded');
  f.comments[0].replies = [];
  await assert.rejects(f.make().replyComment({ candidateId, content: '另一种说法' }), code('already_reserved'));
  assert.equal(f.replyCalls.length, 1);
});

test('readback rejects changed parent identity, missing ownership and a changed login account', async t => {
  for (const change of ['parent', 'owner', 'account']) {
    const f = await fixture(t, { allowReplies: true, dryRun: false });
    const candidateId = await f.candidate();
    f.replyHook = input => {
      f.comments[0].replies.push({ uin: f.account, content: input.content });
      if (change === 'parent') f.comments[0].uin = '303';
      else if (change === 'owner') f.hook = action => action === 'get_qzone_msg_detail'
        ? { tid: 'own-post', comments: f.comments } : undefined;
      else f.account = '303';
      return { acknowledged: false };
    };
    const result = await f.social.replyComment({ candidateId, content: '合成回复' });
    assert.equal(result.verified, false);
    assert.equal(result.uncertain, true);
    assert.equal(Object.values((await f.state()).actions)[0].status, 'unknown');
    assert.equal(f.replyCalls.length, 1);
  }
});

test('reply rejects account changes, removed allowlists, expired candidates and comment identity changes', async t => {
  const f = await fixture(t, { allowReplies: true, dryRun: false });
  const candidateId = await f.candidate();
  f.account = '404';
  await assert.rejects(f.social.replyComment({ candidateId, content: '合成回复' }), code('candidate_account_changed'));
  f.account = '101'; f.cfg.allowedUsers = [];
  await assert.rejects(f.social.replyComment({ candidateId, content: '合成回复' }), code('target_denied'));
  f.cfg.allowedUsers = ['202']; f.comments[0].uin = '303';
  await assert.rejects(f.social.replyComment({ candidateId, content: '合成回复' }), code('candidate_invalid'));
  f.comments[0].uin = '202'; f.now += 31 * 60000;
  await assert.rejects(f.social.replyComment({ candidateId, content: '合成回复' }), code('candidate_expired'));
  assert.equal(f.replyCalls.length, 0);
});

test('reply candidates cannot be used as top-level comments', async t => {
  const f = await fixture(t, { allowComments: true });
  const candidateId = await f.candidate();
  const patrol = createPatrol({ getConfig: () => f.cfg, stateDir: f.dir, requestOneBot: f.request, now: () => f.now });
  await assert.rejects(patrol.comment({ candidateId, content: '合成回复' }), code('candidate_invalid'));
});

test('per-person, daily reply and per-post quotas are persisted', async t => {
  const f = await fixture(t, { allowReplies: true, dryRun: false });
  const first = await f.candidate();
  f.replyHook = () => ({ acknowledged: true });
  await f.social.replyComment({ candidateId: first, content: '第一条回复' });
  f.now += 61000;
  f.comments = [{ comment_id: 'c2', uin: '202', content: '第二条评论', time: f.now / 1000 }];
  const second = await f.candidate();
  await assert.rejects(f.make().replyComment({ candidateId: second, content: '第二条回复' }), code('quota_exhausted'));
  f.cfg.replyPerPersonLimit = 2; f.cfg.dailyReplyLimit = 1;
  await assert.rejects(f.social.replyComment({ candidateId: second, content: '第二条回复' }), code('quota_exhausted'));
  f.cfg.dailyReplyLimit = 10; f.cfg.replyPerPostLimit = 1;
  await assert.rejects(f.social.replyComment({ candidateId: second, content: '第二条回复' }), code('quota_exhausted'));
});

test('concurrent reply attempts share durable reservation', async t => {
  const f = await fixture(t, { allowReplies: true, dryRun: false });
  const candidateId = await f.candidate();
  f.replyHook = () => ({ acknowledged: true });
  const results = await Promise.allSettled([f.social, f.make()].map(s => s.replyComment({ candidateId, content: '合成回复' })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(f.replyCalls.length, 1);
});

test('post acknowledges separately from readback and deduplicates after restart', async t => {
  const f = await fixture(t, { allowPosts: true, dryRun: false });
  f.hook = async action => {
    if (action === 'send_qzone_msg') {
      assert.equal(Object.values((await f.state()).actions)[0].status, 'reserved');
      return { tid: 'own-post' };
    }
  };
  const result = await f.social.post({ content: '合成动态' });
  assert.equal(result.verified, true);
  await assert.rejects(f.make().post({ content: '合成动态' }), code('already_reserved'));
  assert.equal(f.calls.filter(c => c.action === 'send_qzone_msg').length, 1);
  assert.ok(!(await fs.readFile(path.join(f.dir, 'patrol-state.json'), 'utf8')).includes('合成动态'));
});

test('post dry run, unknown outcomes and zero quota do not permit repeats', async t => {
  const f = await fixture(t, { allowPosts: true });
  assert.equal((await f.social.post({ content: '合成动态' })).dryRun, true);
  assert.equal(f.calls.filter(c => c.action === 'send_qzone_msg').length, 0);
  f.cfg.dryRun = false;
  f.hook = action => { if (action === 'send_qzone_msg') throw new Error('synthetic timeout'); };
  assert.equal((await f.social.post({ content: '合成动态' })).uncertain, true);
  await assert.rejects(f.social.post({ content: '合成动态' }), code('already_reserved'));
  f.cfg.dailyPostLimit = 0;
  await assert.rejects(f.social.post({ content: '另一条动态' }), code('quota_zero'));
});

test('local images are validated and frozen; URL, outside-root, text files and symlinks are rejected', async t => {
  const f = await fixture(t, { allowPosts: true, dryRun: false });
  const images = path.join(f.dir, 'images');
  await fs.mkdir(images);
  f.cfg.imageDirs = [images];
  const png = path.join(images, 'fixture.png');
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  await fs.writeFile(png, bytes);
  await fs.writeFile(path.join(images, 'note.txt'), 'not an image');
  await assert.rejects(f.social.post({ content: '合成动态', images: ['https://example.invalid/image.png'] }), code('image_invalid'));
  await assert.rejects(f.social.post({ content: '合成动态', images: [path.join(f.dir, 'outside.png')] }), code('image_denied'));
  await assert.rejects(f.social.post({ content: '合成动态', images: [path.join(images, 'note.txt')] }), code('image_invalid'));
  const link = path.join(images, 'linked');
  await fs.symlink(f.dir, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.social.post({ content: '合成动态', images: [path.join(link, 'images', 'fixture.png')] }), code('image_path_unsafe'));
  f.hook = async (action, payload) => {
    if (action === 'send_qzone_msg') {
      assert.notEqual(payload.images[0], png);
      assert.deepEqual(await fs.readFile(payload.images[0]), bytes);
      return { tid: 'own-post' };
    }
  };
  assert.equal((await f.social.post({ content: '合成图文', images: [png] })).verified, true);
  assert.ok(!(await fs.readdir(f.dir)).some(n => n.startsWith('outbound-')));
});

test('corrupt state stops read and write paths without clearing quota', async t => {
  const f = await fixture(t, { allowPosts: true, dryRun: false });
  await fs.writeFile(path.join(f.dir, 'patrol-state.json'), '{broken');
  await assert.rejects(f.social.post({ content: '合成动态' }), code('state_corrupt'));
  await assert.rejects(f.social.selfPosts(), code('state_corrupt'));
  assert.equal(f.calls.length, 0);
});

test('incomplete identities in new persistent state are treated as corruption', async t => {
  const f = await fixture(t);
  const candidateId = await f.candidate();
  const state = await f.state();
  delete state.candidates[candidateId].account;
  await fs.writeFile(path.join(f.dir, 'patrol-state.json'), JSON.stringify(state));
  await assert.rejects(f.social.selfPosts(), code('state_corrupt'));
  state.candidates = {};
  state.actions['a'.repeat(64)] = { kind: 'reply', at: f.now, status: 'unknown' };
  await fs.writeFile(path.join(f.dir, 'patrol-state.json'), JSON.stringify(state));
  await assert.rejects(f.social.selfPosts(), code('state_corrupt'));
  state.actions['a'.repeat(64)] = { kind: 'post', at: f.now, status: 'unknown' };
  await fs.writeFile(path.join(f.dir, 'patrol-state.json'), JSON.stringify(state));
  await assert.rejects(f.social.selfPosts(), code('state_corrupt'));
});

test('native reply protocol requires matching cookie account and exact comment fields', () => {
  const input = { cookie: 'uin=o101; p_skey=fixture-only', self: '101', tid: 'fixture-post', commentId: 'c1', commentUin: '202', content: '合成回复' };
  const request = buildReplyRequest(input);
  const body = new URLSearchParams(request.body);
  assert.equal(body.get('paramstr'), '2');
  assert.equal(body.get('commentId'), 'c1');
  assert.equal(body.get('commentUin'), '202');
  assert.equal(body.get('hostUin'), '101');
  const targeted = new URLSearchParams(buildReplyRequest({ ...input, targetUin: '303' }).body);
  assert.equal(targeted.get('uin'), '101');
  assert.equal(targeted.get('hostUin'), '303');
  assert.equal(targeted.get('topicId'), '303_fixture-post__1');
  assert.equal(targeted.get('qzreferrer'), 'https://user.qzone.qq.com/303/main');
  assert.throws(() => buildReplyRequest({ ...input, targetUin: 'invalid' }), code('target_invalid'));
  assert.throws(() => buildReplyRequest({ ...input, self: '303' }), code('cookie_account_invalid'));
  assert.deepEqual(parseReplyResponse(200, '{"code":0,"commentid":1}'), { acknowledged: true });
  assert.deepEqual(parseReplyResponse(200, '<html></html>'), { acknowledged: false });
  assert.deepEqual(parseReplyResponse(500, '{"commentid":1}'), { acknowledged: false });
  assert.deepEqual(parseReplyResponse(200, '{"commentid":1}'), { acknowledged: false });
  assert.deepEqual(parseReplyResponse(200, '{"code":0,"commentid":0}'), { acknowledged: false });
  assert.deepEqual(parseReplyResponse(200, '{"code":0,"subcode":1,"commentid":1}'), { acknowledged: false });
});

test('MCP lists five reads and gates each added write independently', async t => {
  const f = await fixture(t);
  const server = createPatrolServer({ getConfig: () => f.cfg, patrol: f.social });
  const client = new Client({ name: 'synthetic-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    assert.equal((await client.listTools()).tools.length, 5);
    f.cfg.allowReplies = true;
    assert.ok((await client.listTools()).tools.some(x => x.name === 'qzone_reply_comment'));
    assert.ok(!(await client.listTools()).tools.some(x => x.name === 'qzone_post'));
    f.cfg.allowPosts = true;
    assert.equal((await client.listTools()).tools.length, 7);
    const invalid = await client.callTool({ name: 'qzone_reply_comment', arguments: { postId: 'guessed', content: '合成回复' } });
    assert.equal(invalid.isError, true);
    const comments = await client.callTool({ name: 'qzone_post_comments', arguments: { postId: 'own-post', targetUin: '101' } });
    assert.notEqual(comments.isError, true);
    const candidateId = JSON.parse(comments.content[0].text).items[0].candidateId;
    const reply = await client.callTool({ name: 'qzone_reply_comment', arguments: { candidateId, targetUin: '101', content: '合成回复' } });
    assert.notEqual(reply.isError, true);
  } finally { await client.close(); await server.close(); }
});
