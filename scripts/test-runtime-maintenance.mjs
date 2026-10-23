// Run real handlers and the event consumer with synthetic state and fake QQ/DSH.
// HTTP is restricted to the fixture server on an ephemeral loopback port.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'group:456';
const DIVING = {
  mode: 'diving', infinite: true, batchWindowMs: 1000,
  triggers: { atMention: true, nameMention: false, anyMessage: false, question: false,
    poke: false, probability: 0, keywords: [], speakerIds: [] },
};
const success = (value) => ({ result: { ok: true, value } });
const pressure = () => success({ values: { contextPressure: {
  pressureTokens: 500000, projectedTokens: 500000, contextWindow: 800000,
} } });
const seqs = (messages) => Array.from(messages, (message) => message.seq);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await delay(10);
  }
  assert.ok(check(), 'fixture condition did not complete');
}

async function fixture(run) {
  let server;
  let clockOffset = 0;
  let sendHook = () => {};
  const sent = [];
  const h = await bridgeHarness({
    config: { socialV2: { wake: { preSleepWaitEnabled: true, preSleepWaitMs: 1000 },
      proactive: { enabled: false }, sticker: { enabled: false } } },
    globals: { Date: class extends Date { static now() { return Date.now() + clockOffset; } },
      fetch: async (url, init = {}) => {
      const parsed = new URL(url);
      if (server && parsed.origin === `http://127.0.0.1:${server.address().port}`
        && parsed.pathname === '/api/socialV2/wake-config') return fetch(url, init);
      assert.ok(['/send_group_msg', '/send_private_msg'].includes(parsed.pathname),
        `unexpected fixture network request: ${parsed.pathname}`);
      sent.push(JSON.parse(init.body));
      await sendHook();
      return { ok: true, status: 200, json: async () => ({
        status: 'ok', retcode: 0, data: { message_id: 9000 + sent.length },
      }) };
    } },
  });
  h.setMode('reserved2');
  const st = h.getSocialV2State(KEY);
  st.bootstrapSent = true;
  h.api.callUnary = async (method) => method === 'session/projections'
    ? pressure() : success({ accepted: true });
  server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const request = (route, { body, admin = false, headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: server.address().port,
      path: `${route.startsWith('/') ? route : `/api/socialV2/${route}`}?key=${encodeURIComponent(KEY)}`,
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-console-token': 'fixture-console-token',
        ...(!admin ? { 'x-agent-token': st.agentToken } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.setTimeout(4000, () => req.destroy(new Error('fixture request timed out')));
    req.end(body === undefined ? undefined : JSON.stringify({ key: KEY, ...body }));
  });
  const append = (text = 'synthetic message') =>
    h.appendSocialV2Message(KEY, 'fixture-person', text, text, false, false,
      `fixture-${st.lastUnreadSeq + 1}`, [], '789', []);
  const incoming = (text = 'synthetic continuation') => h.handleIncoming('group', '456', {
    group_id: 456, user_id: 789, self_id: 999, message_id: `incoming-${st.lastUnreadSeq + 1}`,
    sender: { nickname: 'fixture-person' }, message: [{ type: 'text', data: { text } }],
  }, h.cfg);
  try { await run({ h, st, request, append, incoming, sent,
    advance: (ms) => { clockOffset += ms; }, onSend: (fn) => { sendHook = fn; } }); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}

function stream(h, sid, events) {
  h.api.events.mux = async function* () {
    for (const event of events) yield { payload: { type: 'session/event', sessionId: sid, event } };
    await new Promise(() => {});
  };
  void h.pumpMux();
}

test('normal completed turns still deliver exactly one reply after the idle compact check', () => fixture(async ({ h }) => {
  h.setMode('chat');
  const sid = await h.ensureSession('private:123');
  stream(h, sid, [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'fixture reply' }] } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]);
  await until(() => h.calls.sent.length > 0);
  assert.equal(h.calls.sent.length, 1);
  assert.equal(h.calls.sent[0].text, 'fixture reply');
  assert.doesNotMatch(fs.readFileSync(path.join(h.temp, 'state/bridge.log'), 'utf8'),
    /maybeCompactIdleContextV2 is not defined/);
}));

test('health, context and compact remain admin-only with no agent-token fallback', () => fixture(async ({ request }) => {
  for (const [route, body] of [['/api/health', undefined], ['context', undefined], ['compact', {}]]) {
    assert.equal((await request(route, { body })).status, 403);
    assert.equal((await request(route, { body, admin: true, headers: { 'x-agent-call': '1' } })).status, 403);
    assert.equal((await request(route, { body, headers: { 'x-agent-token': '' } })).status, 403);
  }
  assert.equal((await request('/api/health', { admin: true })).status, 200);
}));

test('send throughSeq cannot bypass a disabled mark-read tool', () => fixture(async ({ h, st, request, append, sent }) => {
  append();
  const read = await request('unread');
  h.cfg.socialV2.tools.markRead = false;
  assert.equal((await request('mark-read', { body: { throughSeq: read.data.readThroughSeq } })).status, 403);
  const result = await request('send-message', { body: { messages: 'fixture reply', throughSeq: read.data.readThroughSeq } });
  assert.equal(result.status, 200);
  assert.equal(result.data.sent, 1);
  assert.equal(result.data.acked, false);
  assert.deepEqual(seqs(st.unread), [1]);
  assert.equal(sent.length, 1);
}));

test('send watermark and nextWake preserve later unread and never repeat an accepted send', () => fixture(async ({ st, request, append, sent }) => {
  append();
  const read = await request('unread');
  append('later unseen arrival');
  const result = await request('send-message', { body: {
    messages: 'fixture reply', throughSeq: read.data.readThroughSeq, nextWake: DIVING,
  } });
  assert.equal(result.status, 200);
  assert.equal(result.data.sent, 1);
  assert.equal(result.data.acked, true);
  assert.equal(result.data.wakeSet, true);
  assert.deepEqual(seqs(st.unread), [2]);
  assert.equal(sent.length, 1);
}));

test('disabled nextWake reports only the follow-up failure without resending or clearing unread', () => fixture(async ({ h, st, request, append, sent }) => {
  append();
  await request('unread');
  h.cfg.socialV2.tools.setWakeConfig = false;
  const result = await request('send-message', { body: { messages: 'fixture reply', throughSeq: 1, nextWake: DIVING } });
  assert.equal(result.status, 200);
  assert.equal(result.data.sent, 1);
  assert.equal(result.data.wakeSet, false);
  assert.equal(result.data.wake.status, 403);
  assert.equal(result.data.acked, false);
  assert.deepEqual(seqs(st.unread), [1]);
  assert.equal(sent.length, 1);
}));

test('nextWake can succeed while disabled mark-read remains unacknowledged', () => fixture(async ({ h, st, request, append, sent }) => {
  append();
  await request('unread');
  h.cfg.socialV2.tools.markRead = false;
  const result = await request('send-message', { body: { messages: 'fixture reply', throughSeq: 1, nextWake: DIVING } });
  assert.equal(result.status, 200);
  assert.equal(result.data.wakeSet, true);
  assert.equal(result.data.acked, false);
  assert.deepEqual(seqs(st.unread), [1]);
  assert.equal(sent.length, 1);
}));

test('send follow-up rechecks an agent token revoked while delivery was in flight', () => fixture(async ({ st, request, append, sent, onSend }) => {
  append();
  await request('unread');
  onSend(() => { st.agentToken = 'fixture-revoked-token'; });
  const result = await request('send-message', { body: { messages: 'fixture reply', throughSeq: 1 } });
  assert.equal(result.status, 200);
  assert.equal(result.data.sent, 1);
  assert.equal(result.data.acked, false);
  assert.deepEqual(seqs(st.unread), [1]);
  assert.equal(sent.length, 1);
}));

test('disabling socialV2 during delivery preserves unread while reporting the accepted send', () => fixture(async ({ h, st, request, append, sent, onSend }) => {
  append();
  await request('unread');
  onSend(() => { h.cfg.socialV2.enabled = false; });
  const result = await request('send-message', { body: { messages: 'fixture reply', throughSeq: 1 } });
  assert.equal(result.status, 200);
  assert.equal(result.data.sent, 1);
  assert.equal(result.data.acked, false);
  assert.deepEqual(seqs(st.unread), [1]);
  assert.equal(sent.length, 1);
}));

test('quiet-window group continuation schedules one wake despite disabled ordinary triggers', () => fixture(async ({ st, request, append, incoming }) => {
  append();
  await request('unread');
  const close = await request('wake-config', { body: { config: DIVING, throughSeq: 1 } });
  assert.equal(close.data.sleepPending, true);
  await incoming();
  assert.equal(st.sleepIntent, null);
  assert.ok(st.pendingWakeTimer);
  const firstTimer = st.pendingWakeTimer;
  await incoming('another synthetic continuation');
  assert.equal(st.pendingWakeTimer, firstTimer);
  assert.deepEqual(seqs(st.unread), [2, 3]);
}));

test('a non-triggering group message retains a scheduled reply check', () => fixture(async ({ st, request, incoming }) => {
  assert.equal((await request('wake-config', { body: { config: DIVING } })).status, 200);
  const timer = setTimeout(() => {}, 30000);
  st.replyCheckTimer = timer;
  try {
    await incoming();
    assert.equal(st.pendingWakeTimer, null);
    assert.equal(st.replyCheckTimer, timer);
  } finally { clearTimeout(timer); }
}));

test('quiet-window poke schedules a wake despite its disabled ordinary trigger', () => fixture(async ({ h, st, request, append }) => {
  append();
  await request('unread');
  await request('wake-config', { body: { config: DIVING, throughSeq: 1 } });
  await h.handlePokeNotice({ sub_type: 'poke', group_id: 456, user_id: 789, target_id: 999, self_id: 999 });
  assert.equal(st.sleepIntent, null);
  assert.ok(st.pendingWakeTimer);
}));

test('pause prevents a quiet-window message or poke from waking the model', () => fixture(async ({ h, st, request, append, incoming }) => {
  for (const kind of ['message', 'poke']) {
    append();
    await request('wake-config', { body: { config: DIVING } });
    assert.ok(st.sleepIntent);
    h.socialV2.paused = true;
    if (kind === 'message') await incoming();
    else await h.handlePokeNotice({ sub_type: 'poke', group_id: 456, user_id: 789, target_id: 999, self_id: 999 });
    assert.equal(st.pendingWakeTimer, null);
    assert.equal(h.calls.prompts.length, 0);
    h.socialV2.paused = false;
  }
}));

test('compact keeps its reservation until compaction/end and then unlocks', () => fixture(async ({ h, request }) => {
  const sid = await h.ensureSession(KEY);
  let commands = 0;
  h.api.callUnary = async (method) => {
    if (method === 'session/projections') return pressure();
    commands++;
    return success({ commandId: `fixture-command-${commands}`, result: { kind: 'success' } });
  };
  assert.equal((await request('compact', { body: {}, admin: true })).status, 200);
  assert.equal((await request('compact', { body: {}, admin: true })).status, 409);
  assert.equal(commands, 1);
  stream(h, sid, [{ type: 'compaction/end', data: { sourceCommandId: 'fixture-command-1' } }]);
  await delay(30);
  assert.equal((await request('compact', { body: {}, admin: true })).status, 200);
  assert.equal(commands, 2);
}));

test('concurrent compact checks dispatch only one command', () => fixture(async ({ h, request }) => {
  await h.ensureSession(KEY);
  let projections = 0;
  let release;
  let commands = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  h.api.callUnary = async (method) => {
    if (method === 'session/projections') { projections++; await gate; return pressure(); }
    commands++;
    return success({ accepted: true });
  };
  const first = request('compact', { body: {}, admin: true });
  const second = request('compact', { body: {}, admin: true });
  await until(() => projections === 2);
  release();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal(commands, 1);
}));

test('a turn starting during a compact pressure read prevents the command', () => fixture(async ({ h, request }) => {
  const sid = await h.ensureSession(KEY);
  let entered = false;
  let release;
  let commands = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  h.api.callUnary = async (method) => {
    if (method === 'session/projections') { entered = true; await gate; return pressure(); }
    commands++;
    return success({ accepted: true });
  };
  const pending = request('compact', { body: {}, admin: true });
  await until(() => entered);
  stream(h, sid, [{ type: 'turn/start', data: { turn: 1 } }]);
  await until(() => h.v2TurnStartAt.has(sid));
  release();
  assert.equal((await pending).status, 409);
  assert.equal(commands, 0);
}));

test('compact failure unlocks the reservation and is never reported as queued', () => fixture(async ({ h, request }) => {
  await h.ensureSession(KEY);
  let commands = 0;
  h.api.callUnary = async (method) => {
    if (method === 'session/projections') return pressure();
    commands++;
    return commands === 1 ? { result: { ok: false, error: { message: 'fixture rejection' } } }
      : success({ accepted: true });
  };
  const failed = await request('compact', { body: {}, admin: true });
  assert.equal(failed.status, 500);
  assert.equal(failed.data.ok, false);
  assert.equal(failed.data.queued, undefined);
  assert.equal((await request('compact', { body: {}, admin: true })).status, 200);
  assert.equal(commands, 2);
}));

test('compact reservation can recover after its timeout without a completion event', () => fixture(async ({ h, request, advance }) => {
  await h.ensureSession(KEY);
  h.cfg.socialV2.context.timeoutMs = 10000;
  let commands = 0;
  h.api.callUnary = async (method) => {
    if (method === 'session/projections') return pressure();
    commands++;
    return success({ accepted: true });
  };
  assert.equal((await request('compact', { body: {}, admin: true })).status, 200);
  advance(10001);
  assert.equal((await request('compact', { body: {}, admin: true })).status, 200);
  assert.equal(commands, 2);
}));

test('a delayed old compact completion cannot release a newer reservation', () => fixture(async ({ h, request, advance }) => {
  const sid = await h.ensureSession(KEY);
  h.cfg.socialV2.context.timeoutMs = 10000;
  let commands = 0;
  h.api.callUnary = async (method) => {
    if (method === 'session/projections') return pressure();
    return success({ commandId: `fixture-command-${++commands}`, result: { kind: 'success' } });
  };
  assert.equal((await request('compact', { body: {}, admin: true })).status, 200);
  advance(10001);
  assert.equal((await request('compact', { body: {}, admin: true })).status, 200);
  stream(h, sid, [{ type: 'compaction/end', data: { sourceCommandId: 'fixture-command-1' } }]);
  await delay(30);
  assert.equal((await request('compact', { body: {}, admin: true })).status, 409);
  assert.equal(commands, 2);
}));

test('a compact response without a command ID keeps uncorrelated completions locked until timeout', () => fixture(async ({ h, request, advance }) => {
  const sid = await h.ensureSession(KEY);
  h.cfg.socialV2.context.timeoutMs = 10000;
  h.api.callUnary = async (method) => method === 'session/projections'
    ? pressure() : success(undefined);
  assert.equal((await request('compact', { body: {}, admin: true })).status, 200);
  stream(h, sid, [{ type: 'compaction/end', data: { sourceCommandId: 'fixture-unknown-command' } }]);
  await delay(30);
  assert.equal((await request('compact', { body: {}, admin: true })).status, 409);
  const context = await request('context', { admin: true });
  assert.equal(context.data.contexts[0].compacting, true);
  assert.equal(context.data.contexts[0].lastCompactionResult, 'queued-unverified');
  advance(10001);
  assert.equal((await request('compact', { body: {}, admin: true })).status, 200);
}));

test('a compact completion arriving before the command response cannot release an uncorrelated reservation', () => fixture(async ({ h, request }) => {
  const sid = await h.ensureSession(KEY);
  let entered = false;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  h.api.callUnary = async (method) => {
    if (method === 'session/projections') return pressure();
    entered = true;
    await gate;
    return success({ commandId: 'fixture-current-command', result: { kind: 'success' } });
  };
  const pending = request('compact', { body: {}, admin: true });
  await until(() => entered);
  stream(h, sid, [{ type: 'compaction/end', data: { sourceCommandId: 'fixture-current-command' } }]);
  await delay(30);
  release();
  assert.equal((await pending).status, 200);
  assert.equal((await request('compact', { body: {}, admin: true })).status, 409);
  const context = await request('context', { admin: true });
  assert.equal(context.data.contexts[0].lastCompactionResult, 'queued-unverified');
}));

test('an inner command error is rejected and releases only its reservation', () => fixture(async ({ h, request }) => {
  await h.ensureSession(KEY);
  let commands = 0;
  h.api.callUnary = async (method) => {
    if (method === 'session/projections') return pressure();
    commands++;
    return success({ commandId: `fixture-command-${commands}`, result: commands === 1
      ? { kind: 'error', text: 'fixture command rejection' } : { kind: 'success' } });
  };
  const failed = await request('compact', { body: {}, admin: true });
  assert.equal(failed.status, 500);
  assert.equal(failed.data.ok, false);
  assert.equal(failed.data.queued, undefined);
  assert.equal((await request('compact', { body: {}, admin: true })).status, 200);
  assert.equal(commands, 2);
}));
