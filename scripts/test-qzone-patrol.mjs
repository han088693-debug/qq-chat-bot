// Offline only: synthetic identities/content, injected gateway calls and temporary state.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createPatrol, isQuiet, CANDIDATE_TTL_MS } from '../optional/qzone-patrol/core.mjs';
import { withState } from '../optional/qzone-patrol/state.mjs';
import { createPatrolServer } from '../optional/qzone-patrol/server.mjs';
import { createPatrolRunner } from '../optional/qzone-patrol/runner.mjs';

const exec = promisify(execFile);
const initialTime = Date.parse('2026-10-20T04:00:00Z');
const defaults = () => ({
  enabled: true, dryRun: true, allowLikes: false, allowComments: false,
  allowedUsers: ['12345'], blockedUsers: [], baseUrl: 'http://127.0.0.1:9', accessTokenEnv: 'FIXTURE_TOKEN',
  dailyLikeLimit: 8, dailyCommentLimit: 3, hourlyLimit: 6, cooldownMinutes: 60,
  scanPageSize: 12, maxPostAgeHours: 72,
  quietHours: { start: '01:00', end: '08:00', timeZone: 'Asia/Shanghai' },
  runner: { enabled: false, intervalMinutes: 30, autoLike: false },
});
const code = expected => error => error.code === expected;

async function fixture(t, patch = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-patrol-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const f = { dir, config: { ...defaults(), ...patch }, time: initialTime, calls: [], writeHook: null, responseHook: null };
  f.file = path.join(dir, 'patrol-state.json');
  f.request = async (action, payload, config) => {
    f.calls.push({ action, payload });
    if (action === 'get_login_info') return f.loginHook ? f.loginHook() : { user_id: f.loginId ?? 99999 };
    if (action === 'get_qzone_msg_list') return f.responseHook
      ? f.responseHook(payload)
      : { msglist: [{ tid: `synthetic-post-${payload.target_uin}`, time: Math.floor(f.time / 1000) - 60, content: '合成动态正文' }] };
    assert.ok(['like_qzone', 'comment_qzone'].includes(action), 'unrecognized fixture action');
    if (f.writeHook) await f.writeHook(action, payload, config);
    return {};
  };
  f.make = () => createPatrol({ getConfig: () => f.getConfigHook ? f.getConfigHook() : f.config,
    stateDir: dir, requestOneBot: f.request, now: () => f.time });
  f.patrol = f.make();
  f.runner = options => createPatrolRunner({
    getConfig: () => f.getConfigHook ? f.getConfigHook() : f.config,
    stateDir: dir, requestOneBot: f.request, now: () => f.time, log() {}, ...options,
  });
  f.state = async () => JSON.parse(await fs.readFile(f.file, 'utf8'));
  f.writes = () => f.calls.filter(call => ['like_qzone', 'comment_qzone'].includes(call.action));
  return f;
}

test('disabled and invalid configuration fail closed without requests or persistent state', async t => {
  const f = await fixture(t, { enabled: false });
  await assert.rejects(f.patrol.scan, code('disabled'));
  f.config.enabled = 'false';
  await assert.rejects(f.patrol.scan, code('config_invalid'));
  const broken = createPatrol({ getConfig() { throw new Error('fixture-private-path'); }, stateDir: f.dir, requestOneBot: f.request });
  await assert.rejects(broken.status, error => error.code === 'config_invalid' && !error.message.includes('fixture-private-path'));
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await fs.readdir(f.dir), []);
});

test('empty or blocked allowlists and quiet periods make no gateway requests', async t => {
  const f = await fixture(t, { allowedUsers: [] });
  assert.equal((await f.patrol.scan()).reason, 'no_allowed_users');
  f.config.allowedUsers = ['12345'];
  f.config.blockedUsers = ['12345'];
  assert.equal((await f.patrol.scan()).reason, 'no_allowed_users');
  f.config.blockedUsers = [];
  f.time = Date.parse('2026-10-19T18:00:00Z'); // 02:00 in configured zone.
  assert.equal((await f.patrol.scan()).reason, 'quiet_hours');
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await fs.readdir(f.dir), []);
});

test('quiet hours use the configured zone, including a window across midnight', () => {
  const config = defaults();
  config.quietHours = { start: '22:00', end: '08:00', timeZone: 'Asia/Shanghai' };
  assert.equal(isQuiet(config, Date.parse('2026-10-20T14:00:00Z')), true);
  assert.equal(isQuiet(config, Date.parse('2026-10-20T23:59:00Z')), true);
  assert.equal(isQuiet(config, Date.parse('2026-10-21T00:00:00Z')), false);
  config.quietHours.end = config.quietHours.start;
  assert.equal(isQuiet(config, initialTime), false);
});

test('scan uses explicit targets, filters old/private/future posts, and does not persist content', async t => {
  const f = await fixture(t, { allowedUsers: ['12345', '67890', '99999'], blockedUsers: ['67890'] });
  f.responseHook = () => ({ msglist: [
    { tid: 'fresh', time: f.time / 1000 - 60, content: '<b>合成正文</b><script>injected</script>', cookie: 'fixture-private-cookie' },
    { tid: 'old', time: f.time / 1000 - 100 * 3600, content: 'expired' },
    { tid: 'private', time: f.time / 1000 - 60, content: 'private', is_private: true },
    { tid: 'future', time: f.time / 1000 + 3600, content: 'future' },
  ] });
  const result = await f.patrol.scan();
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].text, '合成正文');
  assert.equal(result.items[0].uin, '12345');
  assert.deepEqual(f.calls.map(call => call.action), ['get_login_info', 'get_qzone_msg_list']);
  assert.equal(f.calls[1].payload.target_uin, 12345);
  const stored = await fs.readFile(f.file, 'utf8');
  for (const excluded of ['合成正文', 'injected', 'fixture-private-cookie', 'content', 'nickname']) assert.ok(!stored.includes(excluded));
  assert.equal((await f.patrol.status()).activeCandidates, 1);
});

test('invalid gateway list formats fail clearly; a legal empty list remains empty', async t => {
  const f = await fixture(t);
  f.responseHook = () => ({ unsupported: [] });
  await assert.rejects(f.patrol.scan, code('scan_failed'));
  f.responseHook = () => [];
  assert.deepEqual((await f.patrol.scan()).items, []);
});

test('per-target responses cannot exceed the requested page or admit a future/private post', async t => {
  const f = await fixture(t);
  f.responseHook = () => Array.from({ length: 8 }, (_, index) => ({
    tid: `synthetic-bounded-${index}`, time: f.time / 1000 - 60, content: '合成动态',
  }));
  assert.equal((await f.patrol.scan()).items.length, 3);
  f.responseHook = () => [
    { tid: 'future', time: f.time / 1000 + 3600 },
    { tid: 'private', time: f.time / 1000 - 60, is_private: true },
  ];
  assert.deepEqual((await f.patrol.scan()).items, []);
});

test('writes require a fresh scanned candidate and the current target permissions', async t => {
  const f = await fixture(t, { dryRun: false, allowLikes: true });
  await assert.rejects(() => f.patrol.like({ candidateId: randomUUID() }), code('candidate_expired'));
  await assert.rejects(() => f.patrol.like({ candidateId: 'not-a-candidate' }), code('candidate_invalid'));
  const { candidateId } = (await f.patrol.scan()).items[0];
  f.config.blockedUsers = ['12345'];
  await assert.rejects(() => f.patrol.like({ candidateId }), code('target_denied'));
  f.config.blockedUsers = [];
  f.time += CANDIDATE_TTL_MS;
  await assert.rejects(() => f.patrol.like({ candidateId }), code('candidate_expired'));
  assert.equal(f.writes().length, 0);
});

test('dry-run previews stay separate from real quotas and deduplication', async t => {
  const f = await fixture(t, { allowLikes: true, allowComments: true });
  const { candidateId } = (await f.patrol.scan()).items[0];
  assert.deepEqual(await f.patrol.like({ candidateId }), { ok: true, dryRun: true, performed: false, action: 'like', candidateId });
  assert.equal((await f.patrol.comment({ candidateId, content: '这是合成评论' })).performed, false);
  assert.equal(f.writes().length, 0);
  assert.equal(Object.keys((await f.state()).actions).length, 0);
  assert.equal((await f.patrol.status()).dryRunCount, 2);
  f.config.dryRun = false;
  assert.equal((await f.patrol.like({ candidateId })).performed, true);
  assert.equal(f.writes().length, 1);
  assert.equal((await f.patrol.status()).counts.likes, 1);
  const stored = await fs.readFile(f.file, 'utf8');
  assert.ok(!stored.includes('这是合成评论'));
});

test('real writes have a durable reservation before the gateway call and survive a new instance', async t => {
  const f = await fixture(t, { dryRun: false, allowLikes: true });
  const item = (await f.patrol.scan()).items[0];
  f.writeHook = async (_action, payload) => {
    assert.deepEqual(Object.values((await f.state()).actions).map(action => action.status), ['reserved']);
    assert.deepEqual(payload, { tid: item.tid, target_uin: Number(item.uin), abstime: item.time });
  };
  await f.patrol.like({ candidateId: item.candidateId });
  assert.equal(Object.values((await f.state()).actions)[0].status, 'succeeded');
  await assert.rejects(() => f.make().like({ candidateId: item.candidateId }), code('already_reserved'));
  assert.equal(f.writes().length, 1);
});

test('uncertain gateway outcomes retain reservations, omit raw errors and never retry', async t => {
  const f = await fixture(t, { dryRun: false, allowLikes: true });
  const { candidateId } = (await f.patrol.scan()).items[0];
  f.writeHook = () => { throw new Error('fixture-private-token-and-body'); };
  await assert.rejects(() => f.patrol.like({ candidateId }), error =>
    error.code === 'gateway_failed' && !error.message.includes('fixture-private'));
  assert.equal(Object.values((await f.state()).actions)[0].status, 'unknown');
  await assert.rejects(() => f.make().like({ candidateId }), code('already_reserved'));
  assert.equal(f.writes().length, 1);
  assert.equal((await f.patrol.status()).counts.likes, 1);
});

test('policy changes between reservation and sending stop the write, including zero quotas and gateway changes', async t => {
  for (const changed of [{ dailyLikeLimit: 0 }, { hourlyLimit: 0 },
    { baseUrl: 'http://127.0.0.1:10' }, { accessTokenEnv: 'ANOTHER_FIXTURE_TOKEN' }]) {
    const f = await fixture(t, { dryRun: false, allowLikes: true });
    const { candidateId } = (await f.patrol.scan()).items[0];
    let reads = 0;
    f.getConfigHook = () => {
      reads++;
      return reads >= 2 ? { ...f.config, ...changed } : f.config;
    };
    await assert.rejects(() => f.patrol.like({ candidateId }), code('config_changed'));
    assert.equal(f.writes().length, 0);
    assert.equal(Object.values((await f.state()).actions)[0].status, 'unknown');
  }
});

test('candidates are bound to the gateway configuration that produced them', async t => {
  const f = await fixture(t, { dryRun: false, allowLikes: true });
  const { candidateId } = (await f.patrol.scan()).items[0];
  f.config.baseUrl = 'http://127.0.0.1:10';
  await assert.rejects(() => f.patrol.like({ candidateId }), code('candidate_source_changed'));
  assert.equal(f.writes().length, 0);
});

test('account switches invalidate scanned candidates before a write and preserve the reservation', async t => {
  for (const loginId of [88888, 12345]) {
    const f = await fixture(t, { dryRun: false, allowLikes: true });
    const { candidateId } = (await f.patrol.scan()).items[0];
    f.loginId = loginId;
    await assert.rejects(() => f.patrol.like({ candidateId }), code('candidate_account_changed'));
    assert.equal(f.writes().length, 0);
    assert.equal(Object.values((await f.state()).actions)[0].status, 'unknown');
    f.loginId = 99999;
    await assert.rejects(() => f.make().like({ candidateId }), code('already_reserved'));
  }
});

test('legacy candidates require a new scan without discarding historical reservations', async t => {
  const f = await fixture(t, { dryRun: false, allowLikes: true, cooldownMinutes: 0 });
  const { candidateId } = (await f.patrol.scan()).items[0];
  await withState(f.dir, state => { delete state.candidates[candidateId].account; }, { write: true });
  await assert.rejects(() => f.patrol.like({ candidateId }), code('candidate_source_changed'));
  assert.equal(f.writes().length, 0);
  const refreshed = (await f.patrol.scan()).items[0];
  await f.patrol.like({ candidateId: refreshed.candidateId });
  assert.equal(f.writes().length, 1);
});

test('policy changes during account verification prevent the following outbound write', async t => {
  const f = await fixture(t, { dryRun: false, allowLikes: true });
  const { candidateId } = (await f.patrol.scan()).items[0];
  f.loginHook = () => {
    f.config.dryRun = true;
    return { user_id: 99999 };
  };
  await assert.rejects(() => f.patrol.like({ candidateId }), code('config_changed'));
  assert.equal(f.writes().length, 0);
  assert.equal(Object.values((await f.state()).actions)[0].status, 'unknown');
});

test('scanning stops before another target if the policy changes during a response', async t => {
  const f = await fixture(t, { allowedUsers: ['12345', '67890'] });
  f.responseHook = () => {
    f.config.allowedUsers = [];
    return [];
  };
  await assert.rejects(f.patrol.scan, code('config_changed'));
  assert.equal(f.calls.filter(call => call.action === 'get_qzone_msg_list').length, 1);
  assert.equal(await fs.stat(f.file).then(() => true, () => false), false);
});

test('zero quotas mean forbidden, and comments reject mentions rather than changing submitted text', async t => {
  const f = await fixture(t, { dryRun: false, allowLikes: true, allowComments: true, dailyLikeLimit: 0 });
  const { candidateId } = (await f.patrol.scan()).items[0];
  await assert.rejects(() => f.patrol.like({ candidateId }), code('quota_zero'));
  await assert.rejects(() => f.patrol.comment({ candidateId, content: '@某人 合成内容' }), code('comment_private'));
  await assert.rejects(() => f.patrol.comment({ candidateId, content: '账号 12345' }), code('comment_private'));
  f.config.hourlyLimit = 0;
  await assert.rejects(() => f.patrol.comment({ candidateId, content: '合成评论' }), code('quota_zero'));
  assert.equal(f.writes().length, 0);
});

test('cooldown, rolling hourly quotas and configured-zone calendar day limits are persistent', async t => {
  const f = await fixture(t, {
    dryRun: false, allowLikes: true, allowComments: true, allowedUsers: ['12345', '67890'],
    dailyLikeLimit: 1, hourlyLimit: 1,
  });
  let items = (await f.patrol.scan()).items;
  await f.patrol.like({ candidateId: items[0].candidateId });
  await assert.rejects(() => f.patrol.comment({ candidateId: items[1].candidateId, content: '合成评论' }), code('quota_exhausted'));
  f.config.hourlyLimit = 6;
  await assert.rejects(() => f.patrol.comment({ candidateId: items[1].candidateId, content: '合成评论' }), code('cooldown'));
  f.config.cooldownMinutes = 0;
  await assert.rejects(() => f.patrol.like({ candidateId: items[1].candidateId }), code('quota_exhausted'));
  f.time = Date.parse('2026-10-20T16:01:00Z'); // Next calendar day in Shanghai; UTC still same date.
  items = (await f.make().scan()).items;
  await f.make().like({ candidateId: items[1].candidateId });
  assert.equal((await f.patrol.status()).counts.likes, 1);
  assert.equal(f.writes().length, 2);
});

test('simultaneous writers cannot duplicate one action or exceed a shared quota', async t => {
  const f = await fixture(t, {
    dryRun: false, allowLikes: true, allowedUsers: ['12345', '67890'], cooldownMinutes: 0, dailyLikeLimit: 1,
  });
  const items = (await f.patrol.scan()).items;
  f.writeHook = () => new Promise(resolve => setTimeout(resolve, 50));
  const results = await Promise.allSettled([
    f.patrol.like({ candidateId: items[0].candidateId }),
    f.make().like({ candidateId: items[0].candidateId }),
    f.make().like({ candidateId: items[1].candidateId }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  // Either candidate may acquire the lock first; B winning exhausts the quota for both A attempts.
  const expectedErrors = results[2].status === 'fulfilled'
    ? ['quota_exhausted', 'quota_exhausted']
    : ['already_reserved', 'quota_exhausted'];
  assert.deepEqual(results.filter(result => result.status === 'rejected').map(result => result.reason.code).sort(), expectedErrors);
  assert.equal(f.writes().length, 1);
});

test('corrupt state stays intact and blocks scanning or writing instead of resetting quotas', async t => {
  const f = await fixture(t, { dryRun: false, allowLikes: true });
  const { candidateId } = (await f.patrol.scan()).items[0];
  await fs.writeFile(f.file, '{broken-fixture');
  const before = f.calls.length;
  await assert.rejects(f.patrol.scan, code('state_corrupt'));
  await assert.rejects(() => f.patrol.like({ candidateId }), code('state_corrupt'));
  assert.equal(f.calls.length, before);
  assert.equal(await fs.readFile(f.file, 'utf8'), '{broken-fixture');
});

test('failed atomic writes reject the transaction and leave a fail-closed state', async t => {
  const f = await fixture(t);
  await assert.rejects(() => withState(f.dir, async state => {
    state.lastScanAt = initialTime;
    // A directory cannot be replaced by the atomic state-file rename.
    await fs.mkdir(f.file);
  }, { write: true }), code('state_write_failed'));
  assert.equal((await fs.stat(f.file)).isDirectory(), true);
  await assert.rejects(f.patrol.scan, code('state_path_unsafe'));
  assert.deepEqual(f.calls, []);
  assert.ok(!(await fs.readdir(f.dir)).some(name => name.endsWith('.tmp') || name.endsWith('.lock')));
});

test('state directories cannot redirect persistence through a directory link', async t => {
  const f = await fixture(t);
  const linked = path.join(f.dir, 'linked');
  const actual = path.join(f.dir, 'actual');
  await fs.mkdir(actual);
  await fs.symlink(actual, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const patrol = createPatrol({ getConfig: () => f.config, stateDir: linked, requestOneBot: f.request, now: () => f.time });
  await assert.rejects(patrol.scan, code('state_path_unsafe'));
  assert.deepEqual(await fs.readdir(actual), []);
  assert.deepEqual(f.calls, []);
});

test('an independent process cannot acquire an already held state lock', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const moduleUrl = new URL('../optional/qzone-patrol/state.mjs', import.meta.url).href;
  const script = `import {withState} from ${JSON.stringify(moduleUrl)};
    try { await withState(process.argv[1], () => {}); process.exitCode = 2; }
    catch (error) { if (error.code !== 'state_busy') process.exitCode = 3; }`;
  await withState(f.dir, async () => {
    await exec(process.execPath, ['--input-type=module', '-e', script, f.dir], { windowsHide: true, timeout: 6000 });
  });
  assert.deepEqual(f.calls, []);
});

test('MCP tool discovery follows live flags and calls recheck disabled state', async t => {
  const f = await fixture(t);
  const server = createPatrolServer({ getConfig: () => f.config, patrol: f.patrol });
  const client = new Client({ name: 'offline-patrol-fixture', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name),
      ['qzone_scan', 'qzone_status', 'qzone_self_posts', 'qzone_user_posts', 'qzone_post_comments']);
    f.config.allowLikes = true;
    f.config.allowComments = true;
    assert.equal((await client.listTools()).tools.length, 7);
    f.config.enabled = false;
    assert.deepEqual((await client.listTools()).tools, []);
    assert.equal((await client.callTool({ name: 'qzone_scan', arguments: {} })).isError, true);
    assert.equal((await client.callTool({ name: 'qzone_like', arguments: { candidateId: randomUUID(), targetUin: '12345' } })).isError, true);
    assert.deepEqual(f.calls, []);
  } finally {
    await client.close();
    await server.close();
  }
});

test('runner checks are effect-free and local status remains available while disabled', async t => {
  const f = await fixture(t, { enabled: false });
  const runner = f.runner();
  assert.equal((await runner.check()).enabled, false);
  assert.deepEqual(await fs.readdir(f.dir), []);
  await assert.rejects(runner.once, code('disabled'));
  await assert.rejects(runner.run, code('disabled'));
  assert.equal((await runner.status()).enabled, false);
  f.config.enabled = true;
  await assert.rejects(runner.once, code('runner_disabled'));
  f.config.runner.intervalMinutes = 1;
  await assert.rejects(runner.check, code('config_invalid'));
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await fs.readdir(f.dir), []);
});

test('runner scans without interaction unless both automatic and write switches are enabled', async t => {
  const f = await fixture(t, { runner: { enabled: true, intervalMinutes: 30, autoLike: false } });
  assert.equal((await f.runner().once()).reason, 'scan_only');
  f.config.runner.autoLike = true;
  assert.equal((await f.runner().once()).reason, 'scan_only');
  assert.equal(f.writes().length, 0);
});

test('runner auto-like previews and real writes share durable quotas without calling comments', async t => {
  const f = await fixture(t, {
    allowLikes: true, allowedUsers: ['12345', '67890'],
    runner: { enabled: true, intervalMinutes: 30, autoLike: true },
  });
  const preview = await f.runner().once();
  assert.equal(preview.likePreviews, 2);
  assert.equal(preview.likesSubmitted, 0);
  assert.equal(f.writes().length, 0);
  f.config.dryRun = false;
  const real = await f.runner().once();
  assert.equal(real.likesSubmitted, 1);
  assert.equal(real.skipped, 1);
  assert.equal(real.reason, 'cooldown');
  const repeated = await f.runner().once();
  assert.equal(repeated.likesSubmitted, 0);
  assert.equal(repeated.skipped, 2);
  assert.deepEqual(f.writes().map(call => call.action), ['like_qzone']);
  for (const value of ['12345', '67890', '合成动态', 'synthetic-post', 'candidateId']) {
    assert.ok(!JSON.stringify([preview, real, repeated]).includes(value));
  }
});

test('runner rechecks automatic permission and dry-run policy between candidates', async t => {
  for (const change of [
    f => { f.config.runner.autoLike = false; },
    f => { f.config.dryRun = true; },
  ]) {
    const f = await fixture(t, {
      dryRun: false, allowLikes: true, cooldownMinutes: 0, allowedUsers: ['12345', '67890'],
      runner: { enabled: true, intervalMinutes: 30, autoLike: true },
    });
    f.writeHook = () => change(f);
    await assert.rejects(f.runner().once, code('config_changed'));
    assert.equal(f.writes().length, 1);
  }
});

test('disabling the runner after reservation blocks the send and preserves its unknown outcome', async t => {
  const f = await fixture(t, {
    dryRun: false, allowLikes: true,
    runner: { enabled: true, intervalMinutes: 30, autoLike: true },
  });
  f.getConfigHook = async () => {
    const state = await f.state().catch(() => null);
    if (state && Object.values(state.actions).some(action => action.status === 'reserved')) f.config.runner.enabled = false;
    return f.config;
  };
  await assert.rejects(f.runner().once, code('config_invalid'));
  assert.equal(f.writes().length, 0);
  assert.equal(Object.values((await f.state()).actions)[0].status, 'unknown');
});

test('runner starts immediately, hot-loads its interval and stops after a disabled switch', async t => {
  const f = await fixture(t, { runner: { enabled: true, intervalMinutes: 30, autoLike: false } });
  const events = [];
  let sleeps = 0;
  const result = await f.runner({
    log(event) {
      events.push(event);
      if (event.event === 'cycle') f.config.runner.intervalMinutes = 7;
    },
    async sleep(ms) {
      assert.equal(ms, 7 * 60000);
      assert.equal(events[0].event, 'cycle');
      sleeps++;
      f.config.runner.enabled = false;
    },
  }).run();
  assert.equal(result.reason, 'runner_disabled');
  assert.equal(sleeps, 1);
  assert.deepEqual(events.map(event => event.event), ['cycle', 'stopped']);
  assert.ok(!(await fs.readdir(f.dir)).some(name => name.endsWith('.lock')));
});

test('runner failures stop without a timer retry and errors omit private gateway details', async t => {
  const f = await fixture(t, { runner: { enabled: true, intervalMinutes: 30, autoLike: false } });
  f.responseHook = () => { throw new Error('fixture-secret-token-and-post'); };
  let sleeps = 0;
  await assert.rejects(f.runner({ async sleep() { sleeps++; } }).run, error =>
    error.code === 'scan_failed' && !error.message.includes('fixture-secret'));
  assert.equal(sleeps, 0);
  assert.equal(f.calls.filter(call => call.action === 'get_qzone_msg_list').length, 1);
  assert.ok(!(await fs.readdir(f.dir)).some(name => name.endsWith('.lock')));
});

test('disabling a running cycle is a clean stop before the next target', async t => {
  const f = await fixture(t, {
    allowedUsers: ['12345', '67890'],
    runner: { enabled: true, intervalMinutes: 30, autoLike: false },
  });
  f.responseHook = () => {
    f.config.runner.enabled = false;
    return [];
  };
  const events = [];
  const result = await f.runner({ log: event => events.push(event) }).run();
  assert.deepEqual(result, { event: 'stopped', reason: 'runner_disabled' });
  assert.deepEqual(events, [result]);
  assert.equal(f.calls.filter(call => call.action === 'get_qzone_msg_list').length, 1);
  assert.ok(!(await fs.readdir(f.dir)).some(name => name.endsWith('.lock')));
});

test('runner lock prevents overlap and an abort releases it without another cycle', { timeout: 10000 }, async t => {
  const f = await fixture(t, { runner: { enabled: true, intervalMinutes: 30, autoLike: false } });
  const controller = new AbortController();
  let sleeping;
  const started = new Promise(resolve => { sleeping = resolve; });
  const running = f.runner({
    sleep(_ms, signal) {
      sleeping();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    },
  }).run({ signal: controller.signal });
  await started;
  try {
    await assert.rejects(f.runner().once, code('state_busy'));
  } finally {
    controller.abort();
  }
  assert.equal((await running).reason, 'signal');
  assert.equal(f.calls.filter(call => call.action === 'get_qzone_msg_list').length, 1);
  assert.ok(!(await fs.readdir(f.dir)).some(name => name.endsWith('.lock')));
});
