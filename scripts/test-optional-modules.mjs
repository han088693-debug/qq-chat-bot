// Offline tests: fake upstream tools and a temporary DSH profile, never real devices/accounts.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import yaml from 'js-yaml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ROOT, loadConfig, validateConfig } from '../optional/config.mjs';
import { entriesFor, patchDocument } from '../optional/setup.mjs';
import { makeProxy, upstreamParameters } from '../optional/proxy.mjs';

const template = JSON.parse(await fs.readFile(path.join(ROOT, 'optional', 'config.example.json'), 'utf8'));
const fresh = () => structuredClone(template);
const tool = name => ({ name, inputSchema: { type: 'object', properties: {} } });

test('disabled sample registers no optional MCP, string booleans fail closed', () => {
  assert.deepEqual(entriesFor(validateConfig(fresh())), []);
  const cfg = fresh();
  cfg.iphone.enabled = 'false';
  assert.throws(() => validateConfig(cfg), /true or false/);
});

test('Qzone origin refuses remote hosts, credentials and URL suffixes', () => {
  for (const url of ['https://example.com', 'http://192.0.2.1:3000', 'http://user:pass@127.0.0.1:3000',
    'http://127.0.0.1:3000/api', 'http://127.0.0.1:3000/?token=x']) {
    const cfg = fresh();
    cfg.phone.qzone.enabled = true;
    cfg.phone.qzone.baseUrl = url;
    assert.throws(() => validateConfig(cfg), /local HTTP origin/);
  }
});

test('Android requires an explicit device selection', () => {
  const cfg = fresh();
  cfg.phone.android.enabled = true;
  assert.throws(() => validateConfig(cfg), /select one device/);
});

test('setup preserves unrelated operations, replaces own entries and removes only own IDs', () => {
  const cfg = fresh();
  cfg.phone.qzone.enabled = true;
  const entries = entriesFor(cfg);
  const original = yaml.dump([{ insert: [{ id: 'keep', name: 'other', config: { note: 'keep me' } }], after: 'custom' }]);
  const installed = patchDocument(original, entries);
  assert.deepEqual(yaml.load(installed)[0], yaml.load(original)[0]);
  assert.equal(patchDocument(installed, entries), installed);
  assert.deepEqual(yaml.load(patchDocument(installed, [])), yaml.load(original));
});

test('setup refuses to replace an existing manually installed service', () => {
  const cfg = fresh();
  cfg.phone.qzone.enabled = true;
  const original = yaml.dump([{ insert: [{ id: 'my-phone', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'phone' } }] }]);
  assert.throws(() => patchDocument(original, entriesFor(cfg)), /unmanaged MCP/);
  assert.throws(() => patchDocument('not: an array', []), /YAML array/);
});

test('iPhone filters list and calls, including unknown or high-level send tools', async () => {
  const calls = [];
  const upstream = {
    listTools: async () => ({ tools: ['screenshot', 'ocr', 'tap', 'act', 'unlock', 'send_message', 'get_clipboard', 'new_tool', 'screenshot_file'].map(tool) }),
    callTool: async p => { calls.push(p); return { content: [{ type: 'text', text: 'ok' }] }; },
  };
  const proxy = makeProxy('iphone', { allowControl: false, saveScreenshots: false }, upstream);
  assert.deepEqual((await proxy.list()).tools.map(t => t.name), ['screenshot', 'ocr']);
  for (const name of ['tap', 'act', 'unlock', 'send_message', 'get_clipboard', 'new_tool', 'screenshot_file']) {
    assert.equal((await proxy.call(name)).isError, true);
  }
  assert.equal(calls.length, 0);
  await proxy.call('ocr', { full: false });
  assert.deepEqual(calls[0], { name: 'ocr', arguments: { full: false } });
  const control = makeProxy('iphone', { allowControl: true, saveScreenshots: false }, upstream);
  assert((await control.list()).tools.some(t => t.name === 'tap'));
  assert.equal((await control.call('act')).isError, true);
});

test('upstream pagination is filtered, new tools do not gain access', async () => {
  const proxy = makeProxy('bilibili', {}, {
    listTools: async args => args?.cursor
      ? { tools: [tool('bili_comments'), tool('bili_send_message')] }
      : { tools: [tool('bili_video_info')], nextCursor: 'next' },
  });
  assert.deepEqual((await proxy.list()).tools.map(t => t.name), ['bili_video_info', 'bili_comments']);
  assert.equal((await proxy.call('bili_send_message')).isError, true);
});

test('upstream errors omit private details and failed list refresh revokes cached tools', async () => {
  let failList = false;
  const privateDetail = 'fixture-private-device-detail';
  const proxy = makeProxy('iphone', {}, {
    listTools: async () => { if (failList) throw new Error(privateDetail); return { tools: [tool('ocr')] }; },
    callTool: async () => ({ isError: true, content: [{ type: 'text', text: privateDetail }] }),
  });
  await proxy.list();
  assert.equal(JSON.stringify(await proxy.call('ocr')).includes(privateDetail), false);
  failList = true;
  await assert.rejects(proxy.list(), error => !error.message.includes(privateDetail));
  assert.equal((await proxy.call('ocr')).isError, true);
});

test('screenshot export never calls an upstream file helper or uses the supplied note as a path', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-optional-shots-test-'));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jvZkAAAAASUVORK5CYII=', 'base64');
  const calls = [];
  const proxy = makeProxy('iphone', { saveScreenshots: true }, {
    listTools: async () => ({ tools: [tool('screenshot'), tool('screenshot_file')] }),
    callTool: async p => { calls.push(p.name); return { content: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }] }; },
  }, { shotDir: dir });
  assert.equal((await proxy.list()).tools.filter(t => t.name === 'screenshot_file').length, 1);
  const result = await proxy.call('screenshot_file', { note: '../../outside' });
  const file = JSON.parse(result.content[0].text).path;
  assert.equal(path.dirname(file), dir);
  assert.match(path.basename(file), /^[0-9a-f-]{36}\.png$/);
  assert.deepEqual(await fs.readFile(file), png);
  assert.deepEqual(calls, ['screenshot']);
  await fs.unlink(file);
  await fs.rmdir(dir);
});

test('screenshot export rejects error and non-PNG results', async () => {
  for (const response of [{ isError: true, content: [] },
    { content: [{ type: 'image', mimeType: 'image/png', data: 'bm90LXBuZw==' }] },
    { content: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=??' }] }]) {
    const proxy = makeProxy('iphone', { saveScreenshots: true }, {
      listTools: async () => ({ tools: [tool('screenshot')] }),
      callTool: async () => response,
    });
    await proxy.list();
    assert.equal((await proxy.call('screenshot_file')).isError, true);
  }
});

test('screenshot export rejects a pre-existing directory link', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-optional-link-test-'));
  const target = path.join(dir, 'target');
  const link = path.join(dir, 'shots');
  await fs.mkdir(target);
  await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    const proxy = makeProxy('iphone', { saveScreenshots: true }, {
      listTools: async () => ({ tools: [tool('screenshot')] }),
      callTool: async () => ({ content: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }] }),
    }, { shotDir: link });
    await proxy.list();
    await assert.rejects(proxy.call('screenshot_file'), /must not contain links/);
    assert.deepEqual(await fs.readdir(target), []);
  } finally {
    await fs.unlink(link);
    await fs.rmdir(target);
    await fs.rmdir(dir);
  }
});

test('SideTap uses argv/cwd, and does not inherit unrelated credentials', () => {
  process.env.QQ_OPTIONAL_TEST_SECRET = 'not-for-child';
  try {
    const params = upstreamParameters('iphone', { pythonPath: 'python', appDir: path.join(ROOT, 'a path with spaces') });
    assert.deepEqual(params.args, ['-m', 'phone_harness', 'mcp']);
    assert.equal(params.env.QQ_OPTIONAL_TEST_SECRET, undefined);
    assert.equal(params.env.PYTHONPATH, path.join(ROOT, 'a path with spaces', 'src'));
  } finally { delete process.env.QQ_OPTIONAL_TEST_SECRET; }
});

test('CLI check changes no profile; real install is idempotent and removal works without config', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-optional-setup-test-'));
  const profile = path.join(dir, 'profiles', 'web');
  await fs.mkdir(profile, { recursive: true });
  const file = path.join(profile, 'cordis.patch.yml');
  const configFile = path.join(dir, 'config.json');
  const cfg = fresh();
  cfg.phone.qzone.enabled = true;
  await fs.writeFile(configFile, JSON.stringify(cfg));
  await fs.writeFile(file, '# keep in backup\n[]\n');
  const run = args => spawnSync(process.execPath, [path.join(ROOT, 'optional', 'setup.mjs'), ...args], {
    env: { ...process.env, DSH_HOME: dir, QQ_BOT_OPTIONAL_CONFIG: configFile },
    encoding: 'utf8', timeout: 15000,
  });
  try {
    assert.equal(run(['--check']).status, 0);
    assert.equal(await fs.readFile(file, 'utf8'), '# keep in backup\n[]\n');
    assert.equal(run([]).status, 0);
    const before = await fs.readFile(file, 'utf8');
    assert.equal(run([]).status, 0);
    assert.equal(await fs.readFile(file, 'utf8'), before);
    assert.equal(loadConfig(configFile).phone.qzone.enabled, true);
    await fs.unlink(configFile);
    assert.equal(run(['--remove']).status, 0);
    assert.deepEqual(yaml.load(await fs.readFile(file, 'utf8')), []);
  } finally {
    for (const name of await fs.readdir(profile)) await fs.unlink(path.join(profile, name));
    await fs.rmdir(profile);
    await fs.rmdir(path.dirname(profile));
    await fs.unlink(configFile).catch(() => {});
    await fs.rmdir(dir);
  }
});

test('stdio integration filters tools and shuts down on upstream exit or closed stdin', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-optional-stdio-test-'));
  const mock = path.join(dir, 'mock.mjs');
  const configFile = path.join(dir, 'config.json');
  const sdk = suffix => new URL(`../node_modules/@modelcontextprotocol/sdk/dist/esm/${suffix}`, import.meta.url).href;
  await fs.writeFile(mock, `
import {Server} from ${JSON.stringify(sdk('server/index.js'))};
import {StdioServerTransport} from ${JSON.stringify(sdk('server/stdio.js'))};
import {ListToolsRequestSchema,CallToolRequestSchema} from ${JSON.stringify(sdk('types.js'))};
const s = new Server({name:'mock',version:'1'},{capabilities:{tools:{}}});
s.setRequestHandler(ListToolsRequestSchema,async()=>({tools:['bili_video_info','bili_post'].map(name=>({name,inputSchema:{type:'object',properties:{}}}))}));
s.setRequestHandler(CallToolRequestSchema,async r=>{
  if(r.params.arguments?.fixtureExit) setTimeout(()=>process.exit(0),50);
  return {content:[{type:'text',text:r.params.name}]};
});
await s.connect(new StdioServerTransport());
`);
  const cfg = fresh();
  cfg.bilibili = { enabled: true, command: process.execPath, cwd: dir, args: [mock], env: {} };
  await fs.writeFile(configFile, JSON.stringify(cfg));
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(ROOT, 'optional', 'proxy.mjs'), 'bilibili'],
    env: { ...process.env, QQ_BOT_OPTIONAL_CONFIG: configFile }, stderr: 'pipe',
  });
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'offline-test', version: '1' });
  try {
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools.map(t => t.name), ['bili_video_info']);
    assert.equal((await client.callTool({ name: 'bili_post', arguments: {} })).isError, true);
    assert.equal((await client.callTool({ name: 'bili_video_info', arguments: {} })).content[0].text, 'bili_video_info');
    const disconnected = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Proxy stayed alive after upstream exit')), 8000);
      client.onclose = () => { clearTimeout(timer); resolve(); };
    });
    await client.callTool({ name: 'bili_video_info', arguments: { fixtureExit: true } });
    await disconnected;
    const child = spawn(process.execPath, [path.join(ROOT, 'optional', 'proxy.mjs'), 'bilibili'], {
      env: { ...process.env, QQ_BOT_OPTIONAL_CONFIG: configFile },
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    child.stderr.resume();
    const exit = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('Proxy stayed alive after closed stdin')); }, 8000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); resolve(code); });
    });
    let output = '';
    child.stdout.on('data', data => {
      output += data.toString();
      if (output.includes('"id":1')) child.stdin.end();
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'offline-eof-test', version: '1' } } }) + '\n');
    assert.equal(await exit, 0);
  } finally {
    await client.close();
    await fs.unlink(mock);
    await fs.unlink(configFile);
    await fs.rmdir(dir);
  }
});
