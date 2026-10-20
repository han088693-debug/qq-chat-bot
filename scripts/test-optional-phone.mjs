// Offline fixtures only: injected HTTP/ADB, synthetic identities, temporary files and listTools.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadConfig, ROOT } from '../optional/config.mjs';
import { entriesFor } from '../optional/setup.mjs';
import { createPhoneTools, loopbackUrl } from '../optional/phone/core.mjs';

const secret = 'fixture-only-credential';
const qconfig = (extra = {}) => ({ phone: { qzone: {
  enabled: true, baseUrl: 'http://127.0.0.1:3000', accessTokenEnv: 'TEST_TOKEN', ...extra,
} } });
const aconfig = (extra = {}) => ({ phone: { android: {
  enabled: true, adbPath: 'fixture-adb', serial: 'fixture-device', ...extra,
} } });
const get = (tools, name) => {
  const tool = tools.find((item) => item.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool;
};
const data = (result) => JSON.parse(result.content[0].text);
const ok = (value = {}) => ({ ok: true, json: async () => ({ status: 'ok', retcode: 0, data: value }) });

test('disabled modules neither register tools nor touch services', () => {
  assert.deepEqual(createPhoneTools({}, {
    fetchImpl: () => assert.fail('unexpected network'), run: () => assert.fail('unexpected ADB'),
    readBridgeConfig: () => assert.fail('unexpected real configuration read'),
  }), []);
});

test('Qzone URL only accepts a clean loopback origin', () => {
  for (const url of ['http://127.0.0.1:3000', 'http://localhost:3000/', 'http://[::1]:3000']) {
    assert.ok(loopbackUrl(url));
  }
  for (const url of ['https://example.invalid', 'file:///tmp/x', 'http://u:p@127.0.0.1:3000',
    'http://127.0.0.1:3000/path', 'http://127.0.0.1:3000/?token=x', 'http://127.0.0.1:3000/#fragment']) {
    assert.throws(() => loopbackUrl(url));
  }
});

test('Qzone is read-only by default and maps read actions without exposing credentials', async () => {
  const calls = [];
  const tools = createPhoneTools(qconfig(), {
    env: { TEST_TOKEN: secret }, fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return ok({ msglist: [{ tid: 'fixture-post', uin: 123, nickname: '测试用户',
        content: '<b>合成动态</b>', cookie: 'must-not-return', private_key: 'must-not-return' }] });
    },
  });
  assert.deepEqual(tools.map((item) => item.name), ['qzone_feeds', 'qzone_my_posts', 'qzone_user_posts']);
  assert.ok(tools.every((item) => item.annotations.readOnlyHint));
  const result = await get(tools, 'qzone_feeds').invoke({ count: 2, page: 3 });
  assert.deepEqual(JSON.parse(calls[0].options.body), { count: 2, page_num: 3 });
  assert.equal(calls[0].url, 'http://127.0.0.1:3000/get_qzone_feeds');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${secret}`);
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(data(result).items[0].text, '合成动态');
  assert.ok(!JSON.stringify(result).includes('must-not-return'));
  assert.ok(!JSON.stringify(result).includes(secret));
  await get(tools, 'qzone_my_posts').invoke({});
  await get(tools, 'qzone_user_posts').invoke({ targetUin: '123', num: 2 });
  assert.deepEqual(JSON.parse(calls[2].options.body), { target_uin: 123, num: 2 });
  await assert.rejects(() => get(tools, 'qzone_user_posts').invoke({ targetUin: '999999999999999999999' }));
  assert.equal(calls.length, 3);
});

test('existing bridge token can be reused, but upstream error bodies are never echoed', async () => {
  let header;
  const tools = createPhoneTools(qconfig(), {
    env: {}, readBridgeConfig: () => ({ snowluma: { accessToken: secret } }),
    fetchImpl: async (_url, options) => {
      header = options.headers.Authorization;
      return { ok: false, json: async () => ({ status: 'failed', wording: secret }) };
    },
  });
  await assert.rejects(() => get(tools, 'qzone_feeds').invoke({}), (error) => {
    assert.ok(!error.message.includes(secret)); return true;
  });
  assert.equal(header, `Bearer ${secret}`);
});

test('empty lists are valid, while unknown gateway response formats are explicit errors', async () => {
  let payload = [];
  const tools = createPhoneTools(qconfig(), {
    env: { TEST_TOKEN: secret }, fetchImpl: async () => ok(payload),
  });
  assert.deepEqual(data(await get(tools, 'qzone_feeds').invoke({})), { items: [] });
  payload = { unexpected: 'synthetic payload' };
  await assert.rejects(() => get(tools, 'qzone_feeds').invoke({}), /不支持的动态列表格式/);
});

test('Qzone write opt-in maps posting, likes and comments; budgets are reserved before requests', async () => {
  let clock = 2000000000000;
  const calls = [];
  const tools = createPhoneTools(qconfig({ allowWrites: true }), {
    env: { TEST_TOKEN: secret }, now: () => clock,
    fetchImpl: async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return ok({ tid: 'posted' }); },
  });
  assert.equal(tools.length, 7);
  assert.equal(data(await get(tools, 'qzone_post').invoke({ content: '合成说说' })).tid, 'posted');
  await assert.rejects(() => get(tools, 'qzone_like').invoke({ tid: 'fixture-post' }), /频率/);
  assert.equal(calls.length, 1);
  clock += 60001;
  await get(tools, 'qzone_like').invoke({ tid: 'fixture-post', targetUin: '123', abstime: 1 });
  assert.deepEqual(calls[1].body, { tid: 'fixture-post', target_uin: 123, abstime: 1 });
  await get(tools, 'qzone_comment').invoke({ tid: 'fixture-post', content: '合成评论', targetUin: 123 });
  assert.ok(calls[2].url.endsWith('/comment_qzone'));
  await assert.rejects(() => get(tools, 'qzone_comment').invoke({ tid: 'fixture-post', content: '第二条' }), /频率/);
  assert.equal(calls.length, 3);
});

test('recent-like requires an exact target and reports partial success without retrying', async () => {
  const calls = [];
  const tools = createPhoneTools(qconfig({ allowWrites: true }), {
    env: { TEST_TOKEN: secret }, fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      if (url.endsWith('/get_qzone_feeds')) return ok([{ tid: 'fixture-post', uin: 123, nickname: '完整名字', abstime: 1234 }]);
      if (url.endsWith('/comment_qzone')) throw new Error(secret);
      return ok();
    },
  });
  await assert.rejects(() => get(tools, 'qzone_recent_like').invoke({ who: '完整' }), /没有匹配/);
  assert.equal(calls.length, 1);
  const result = data(await get(tools, 'qzone_recent_like').invoke({ who: '完整名字', comment: '合成评论' }));
  assert.deepEqual({ ok: result.ok, liked: result.liked, commented: result.commented }, { ok: false, liked: true, commented: false });
  const likes = calls.filter((item) => item.url.endsWith('/like_qzone'));
  assert.equal(likes.length, 1);
  assert.equal(likes[0].body.abstime, 1234);
  assert.ok(!JSON.stringify(result).includes(secret));
});

test('Qzone images require real-path containment and supported image bytes', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-phone-images-'));
  const allowed = path.join(temp, 'allowed');
  fs.mkdirSync(allowed);
  fs.writeFileSync(path.join(allowed, 'fixture.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  fs.writeFileSync(path.join(allowed, 'text.png'), 'not an image');
  fs.writeFileSync(path.join(temp, 'outside.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  let calls = 0;
  const tools = createPhoneTools(qconfig({ allowWrites: true, imageDirs: [allowed] }), {
    env: { TEST_TOKEN: secret }, fetchImpl: async () => { calls++; return ok(); },
  });
  try {
    for (const image of ['../outside.png', 'text.png', 'https://example.invalid/image.png']) {
      await assert.rejects(() => get(tools, 'qzone_post').invoke({ content: '合成配图', images: [image] }));
    }
    assert.equal(calls, 0);
    await get(tools, 'qzone_post').invoke({ content: '合成配图', images: ['fixture.png'] });
    assert.equal(calls, 1);
  } finally {
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('Android read-only tools use only the configured device and return useful UI data', async () => {
  const calls = [];
  const tools = createPhoneTools(aconfig(), { run: async (file, args, options) => {
    calls.push({ file, args, options });
    if (args.includes('screencap')) return { stdout: Buffer.from('89504e470d0a1a0a', 'hex') };
    if (args.includes('uiautomator')) return { stdout: '<hierarchy><node text="测试按钮" content-desc="" clickable="true" bounds="[10,20][30,40]"/></hierarchy>' };
    return { stdout: 'device\n' };
  } });
  assert.deepEqual(tools.map((item) => item.name), ['phone_status', 'phone_screenshot', 'phone_dump']);
  assert.equal(data(await get(tools, 'phone_status').invoke({})).state, 'connected');
  assert.equal((await get(tools, 'phone_screenshot').invoke({})).content[0].type, 'image');
  assert.deepEqual(data(await get(tools, 'phone_dump').invoke({})).nodes[0], {
    text: '测试按钮', description: '', clickable: true, x: 20, y: 30,
  });
  assert.ok(calls.every((call) => call.args[0] === '-s' && call.args[1] === 'fixture-device' && call.options.windowsHide));
  assert.ok(calls.every((call) => !call.args.includes('devices') && !call.args.includes('connect')));
});

test('Android refuses absent serial before any process is started', async () => {
  const tools = createPhoneTools(aconfig({ serial: '' }), { run: () => assert.fail('must not execute') });
  await assert.rejects(() => get(tools, 'phone_status').invoke({}), /显式指定/);
});

test('Android controls are explicit, validated and do not expose arbitrary shell or pairing', async () => {
  const calls = [];
  const tools = createPhoneTools(aconfig({ allowControl: true }), { run: async (_file, args) => {
    calls.push(args);
    if (args.includes('uiautomator')) return { stdout: '<node text="测试" bounds="[0,0][20,20]"/>' };
    return { stdout: '' };
  } });
  for (const name of ['phone_shell', 'phone_pair', 'phone_connect', 'phone_devices', 'phone_macro']) {
    assert.equal(tools.find((item) => item.name === name), undefined);
  }
  await get(tools, 'phone_tap').invoke({ x: 10, y: 20 });
  await get(tools, 'phone_swipe').invoke({ x1: 1, y1: 2, x2: 3, y2: 4 });
  await get(tools, 'phone_key').invoke({ key: 'back' });
  await get(tools, 'phone_open_app').invoke({ packageName: 'com.example.fixture' });
  await get(tools, 'phone_tap_text').invoke({ text: '测试' });
  const count = calls.length;
  await assert.rejects(() => get(tools, 'phone_open_app').invoke({ packageName: 'x;echo injected' }));
  await assert.rejects(() => get(tools, 'phone_tap').invoke({ x: -1, y: 20 }));
  assert.equal(calls.length, count);
  await get(tools, 'phone_text').invoke({ text: "a'; echo literal $(fixture)" });
  assert.equal(calls.at(-1).at(-1), "input text 'a'\\'';%secho%sliteral%s$(fixture)'");
});

test('Chinese input requires a manually enabled IME and sends only base64 text', async () => {
  const calls = [];
  const tools = createPhoneTools(aconfig({ allowControl: true }), { run: async (_file, args) => {
    calls.push(args);
    return { stdout: args.includes('settings') ? 'com.android.adbkeyboard/.AdbIME' : '' };
  } });
  await get(tools, 'phone_text').invoke({ text: '合成输入' });
  assert.ok(calls.at(-1).includes('ADB_INPUT_B64'));
  assert.equal(calls.at(-1).at(-1), Buffer.from('合成输入').toString('base64'));
  const unavailable = createPhoneTools(aconfig({ allowControl: true }), { run: async () => ({ stdout: 'other/.Ime' }) });
  await assert.rejects(() => get(unavailable, 'phone_text').invoke({ text: '合成输入' }), /手动启用/);
});

test('installer entries start one phone MCP with matching schemas and opt-in tool lists', { timeout: 15000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-phone-mcp-'));
  const file = path.join(temp, 'config.json');
  try {
    for (const writable of [false, true]) {
      fs.writeFileSync(file, JSON.stringify({ phone: {
        qzone: { enabled: true, baseUrl: 'http://127.0.0.1:9', accessTokenEnv: 'FIXTURE_TOKEN', allowWrites: writable },
        android: { enabled: true, adbPath: 'fixture-adb-does-not-exist', serial: 'fixture-device', allowControl: writable },
      } }));
      const entries = entriesFor(loadConfig(file), file);
      assert.equal(entries.length, 1);
      const entry = entries[0].config;
      assert.equal(entry.serverName, 'phone');
      assert.equal(entry.cwd, ROOT);
      const client = new Client({ name: 'offline-phone-fixture', version: '1.0.0' });
      const transport = new StdioClientTransport({
        command: entry.command, args: entry.args, cwd: entry.cwd, env: entry.env, stderr: 'pipe',
      });
      try {
        await client.connect(transport);
        assert.equal(client.getServerVersion().name, 'phone');
        // Deliberately do not call tools: no QQ request, real token read, or ADB process.
        const result = await client.listTools();
        assert.equal(result.tools.length, writable ? 16 : 6);
        assert.ok(result.tools.every((tool) => tool.inputSchema.type === 'object'));
        assert.equal(result.tools.filter((tool) => tool.annotations.readOnlyHint).length, 6);
        const account = result.tools.find((tool) => tool.name === 'qzone_user_posts');
        assert.equal(account.inputSchema.additionalProperties, false);
        assert.deepEqual(account.inputSchema.properties.targetUin.anyOf.map((branch) => branch.type), ['string', 'integer']);
        assert.ok(!result.tools.some((tool) => /shell|pair|devices|macro/.test(tool.name)));
      } finally {
        await client.close();
      }
    }
  } finally {
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
