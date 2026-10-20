// Real bridge handlers, fake clock/transports only. Never contacts QQ or a model.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const START = 2_000_000_000_000;
const INTERVAL = 120_000;
const KEY = 'private:123';
const textBody = { messages: 'fixture reply' };

async function fixture(run, { interval = INTERVAL, intervals = null, files = {}, mode = 'reserved2' } = {}) {
  let now = START;
  let transport = async () => {};
  const sent = [];
  class FixtureDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const send = async (action, body) => {
    sent.push({ action, body, at: now });
    await transport(action, body);
    return { message_id: sent.length };
  };
  const h = await bridgeHarness({
    config: { sendDelayMs: 0, socialV2: {
      autoReplyCheckMs: 3_600_000,
      proactive: { enabled: false },
      send: {
        ...(interval === null ? {} : { minIntervalMs: interval }),
        ...(intervals ? { intervalOverrides: intervals } : {}),
        maxSendPerMinute: 0,
        maxSendPerHour: 0
      },
      tools: { sendVoice: true },
      voice: { enabled: true, autoReadback: false, maxPerMinute: 0, maxPerHour: 0 },
    } },
    files: { 'audio/fixture.mp3': 'fake audio', ...files },
    globals: {
      Date: FixtureDate,
      inspectAudio: async () => ({ ok: true, size: 10, duration: 1, codec: 'fixture', warnings: [] }),
      safeFetchBuffer: async () => ({ buffer: Buffer.from('fixture image') }),
      fetch: async (url, init = {}) => {
        const action = new URL(url).pathname.split('/').pop();
        assert.ok(['send_private_msg', 'send_group_msg'].includes(action), `Unexpected fixture HTTP action: ${action}`);
        const data = await send(action, JSON.parse(init.body));
        return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data }) };
      },
    },
  });
  h.setMode(mode);
  h.bot.raw = (action, body) => send(action, body);
  h.bot.sendPrivateMessage = (id, message) => send('send_private_msg', { user_id: id, message });
  h.bot.sendGroupMessage = (id, message) => send('send_group_msg', { group_id: id, message });
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const request = (route = 'send-message', body = textBody, key = KEY) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
      path: `/api/socialV2/${route}`, method: 'POST', headers: {
        'content-type': 'application/json', 'x-console-token': 'fixture-console-token',
        'x-agent-token': h.getSocialV2State(key).agentToken,
      },
    }, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('Fixture request timed out')));
    req.end(JSON.stringify({ key, ...body }));
  });
  try {
    await run({ h, request, sent, setTime: value => { now = value; },
      setTransport: handler => { transport = handler; },
      ledger: () => JSON.parse(fs.readFileSync(path.join(h.temp, 'state/reply-send-times.json'), 'utf8')),
    });
    assert.equal(h.calls.prompts.length, 0, 'send policy tests must never create model work');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await h.close();
  }
}

function ok(result) { assert.equal(result.status, 200, JSON.stringify(result.data)); }
function cooldown(result, remaining) {
  assert.equal(result.status, 429, JSON.stringify(result.data));
  assert.equal(result.data.ok, false);
  assert.equal(result.data.retryAfterMs, remaining);
}

test('119999 ms is rejected, 120000 ms is allowed, rejected requests do not move the deadline', () => fixture(async ({ request, sent, setTime, ledger }) => {
  ok(await request());
  assert.deepEqual(ledger()[KEY], { attemptAt: START, completedAt: START });
  setTime(START + INTERVAL - 1);
  cooldown(await request(), 1);
  setTime(START + INTERVAL);
  ok(await request());
  assert.deepEqual(sent.map(call => call.at), [START, START + INTERVAL]);
}));

test('two concurrent calls can reach the transport only once', () => fixture(async ({ request, sent }) => {
  const results = await Promise.all([request(), request()]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 429]);
  cooldown(results.find(result => result.status === 429), INTERVAL);
  assert.equal(sent.length, 1);
}));

for (const [route, body] of [
  ['send-voice', { voice: 'fixture.mp3', verify: false }],
  ['send-poke', {}],
]) {
  test(`text and ${route} share the same cooldown in both directions`, () => fixture(async ({ request, sent, setTime }) => {
    ok(await request());
    setTime(START + INTERVAL - 1);
    cooldown(await request(route, body), 1);
    assert.equal(sent.length, 1);
    setTime(START + INTERVAL);
    ok(await request(route, body));
    cooldown(await request(), INTERVAL);
    assert.equal(sent.length, 2);
  }));
}

test('text and sticker share one overall reply cooldown (both directions)', () => fixture(async ({ request, sent, setTime }) => {
  ok(await request());
  cooldown(await request('send-sticker', { stickerId: 'fixture-sticker' }), INTERVAL);
  assert.equal(sent.length, 1);
  setTime(START + INTERVAL - 1);
  cooldown(await request('send-sticker', { stickerId: 'fixture-sticker' }), 1);
  setTime(START + INTERVAL);
  ok(await request('send-sticker', { stickerId: 'fixture-sticker' }));
  cooldown(await request(), INTERVAL);
  assert.equal(sent.length, 2);
}));

test('one call with multiple texts sends every bubble, then starts a single cooldown after the last bubble', () => fixture(async ({ request, sent, setTime, setTransport, ledger }) => {
  let t = START;
  setTransport(async () => { t += 1000; setTime(t); });
  ok(await request('send-message', {
    messages: ['第一句', '第二句'],
    gapMode: 'fixed',
    gapMs: 100
  }));
  assert.equal(sent.length, 2, 'both text bubbles should be sent');
  assert.deepEqual(
    sent.map(call => call.body.message.find(part => part.type === 'text').data.text),
    ['第一句', '第二句']
  );
  assert.deepEqual(ledger()[KEY], { attemptAt: START, completedAt: START + 2000 });
  cooldown(await request(), INTERVAL);
  setTime(START + 2000 + INTERVAL - 1);
  cooldown(await request(), 1);
  setTime(START + 2000 + INTERVAL);
  ok(await request());
  assert.equal(sent.length, 3);
}));

test('one call can send text plus a sticker, with one cooldown after the sticker', () => fixture(async ({ request, sent, setTime, setTransport, ledger }) => {
  let t = START;
  setTransport(async () => { t += 1000; setTime(t); });
  ok(await request('send-message', {
    messages: ['说完这句配张图'],
    stickerId: 'fixture-sticker',
    gapMode: 'fixed',
    gapMs: 100
  }));
  assert.equal(sent.length, 2, 'text bubble and sticker bubble should both be sent');
  assert.equal(sent[0].body.message.find(part => part.type === 'text').data.text, '说完这句配张图');
  const stickerPart = sent[1].body.message.find(part => part.type === 'image');
  assert.ok(stickerPart, 'second bubble should contain an image segment');
  assert.ok(stickerPart.data.file.startsWith('base64://'), 'sticker bytes must be embedded, not a URL');
  assert.deepEqual(ledger()[KEY], { attemptAt: START, completedAt: START + 2000 });
  cooldown(await request(), INTERVAL);
}));

test('legacy #sticker / #image records are merged into the per-conversation cooldown', () => fixture(async ({ request, sent }) => {
  cooldown(await request(), 115_000);
  assert.equal(sent.length, 0);
}, { files: { 'state/reply-send-times.json': {
  'private:123#sticker': { attemptAt: START - 10_000, completedAt: START - 5_000 },
  'private:123#image': { attemptAt: START - 20_000, completedAt: START - 15_000 }
} } }));

test('intervalOverrides: private 30s while group keeps the global 120s', () => fixture(async ({ request, sent, setTime }) => {
  ok(await request());
  ok(await request('send-message', textBody, 'group:456'));
  assert.equal(sent.length, 2);
  cooldown(await request(), 30_000);
  cooldown(await request('send-message', textBody, 'group:456'), INTERVAL);
  setTime(START + 29_999);
  cooldown(await request(), 1);
  setTime(START + 30_000);
  ok(await request());
  setTime(START + INTERVAL);
  ok(await request('send-message', textBody, 'group:456'));
  assert.equal(sent.length, 4);
}, { intervals: { 'private:123': 30_000 } }));

test('successful transport completion, not request start, anchors the next deadline', () => fixture(async ({ request, setTime, setTransport, ledger, sent }) => {
  let release;
  let enter;
  const entered = new Promise(resolve => { enter = resolve; });
  setTransport(async () => { enter(); await new Promise(resolve => { release = resolve; }); });
  const first = request();
  await entered;
  setTime(START + 30_000);
  release();
  ok(await first);
  assert.deepEqual(ledger()[KEY], { attemptAt: START, completedAt: START + 30_000 });
  setTime(START + INTERVAL);
  cooldown(await request(), 30_000);
  setTime(START + 30_000 + INTERVAL - 1);
  cooldown(await request(), 1);
  setTransport(async () => {});
  setTime(START + 30_000 + INTERVAL);
  ok(await request());
  assert.equal(sent.length, 2);
}));

test('restart restores the persisted completion time', () => fixture(async ({ request, sent, setTime }) => {
  cooldown(await request(), 60_000);
  assert.equal(sent.length, 0);
  setTime(START + 60_000);
  ok(await request());
}, { files: { 'state/reply-send-times.json': { [KEY]: { attemptAt: START - 90_000, completedAt: START - 60_000 } } } }));

test('a different conversation does not inherit the first conversation cooldown', () => fixture(async ({ request, sent }) => {
  ok(await request());
  ok(await request('send-message', textBody, 'group:456'));
  assert.equal(sent.length, 2);
  cooldown(await request(), INTERVAL);
}));

for (const interval of [null, 0]) {
  test(`missing or zero minIntervalMs preserves immediate sending (${interval})`, () => fixture(async ({ request, sent }) => {
    ok(await request());
    ok(await request('send-message', { messages: 'a different fixture reply' }));
    assert.equal(sent.length, 2);
  }, { interval }));
}

test('other modes do not acquire the reserved2 cooldown', () => fixture(async ({ h, sent }) => {
  await h.sendToQQ(KEY, 'fixture one');
  await h.sendToQQ(KEY, 'fixture two');
  assert.equal(sent.length, 2);
}, { mode: 'chat' }));

test('sendToQQ and agent text share the cooldown despite the legacy swallowed error', () => fixture(async ({ h, request, sent, setTime }) => {
  await h.sendToQQ(KEY, 'fixture system reply');
  assert.equal(sent.length, 1);
  cooldown(await request(), INTERVAL);
  setTime(START + INTERVAL);
  ok(await request());
  await h.sendToQQ(KEY, 'fixture blocked system reply');
  assert.equal(sent.length, 2, 'the swallowed cooldown error must still prevent transport');
}));

test('operator voice guard:false neither acquires nor observes the agent cooldown', () => fixture(async ({ h, request, sent }) => {
  const audio = path.join(h.temp, 'audio/fixture.mp3');
  await h.sendVoiceV2(KEY, audio, { guard: false });
  ok(await request());
  await h.sendVoiceV2(KEY, audio, { guard: false });
  assert.equal(sent.length, 3);
  cooldown(await request(), INTERVAL);
  assert.equal(sent.length, 3);
}));

test('failed transport conservatively retains its attempt cooldown', () => fixture(async ({ request, sent, setTransport, setTime, ledger }) => {
  setTransport(async () => { throw new Error('fixture uncertain transport failure'); });
  assert.equal((await request()).status, 500);
  assert.equal(ledger()[KEY].attemptAt, START);
  cooldown(await request(), INTERVAL);
  assert.equal(sent.length, 1);
  setTransport(async () => {});
  setTime(START + INTERVAL);
  ok(await request());
  assert.equal(sent.length, 2);
}));
