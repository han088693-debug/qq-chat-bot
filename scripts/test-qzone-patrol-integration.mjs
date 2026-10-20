// Offline integration: local configuration, temporary DSH profiles and stdio only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ROOT, loadConfig, validateConfig } from '../optional/config.mjs';
import { entriesFor, patchDocument } from '../optional/setup.mjs';

const template = JSON.parse(await fs.readFile(path.join(ROOT, 'optional/config.example.json'), 'utf8'));
const fresh = () => structuredClone(template);
async function fixture(t, input = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-patrol-integration-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const file = path.join(dir, 'config.json');
  await fs.writeFile(file, JSON.stringify(input));
  return { dir, file };
}

test('new and legacy optional configs keep patrol, runner and all writes disabled', async t => {
  const { file } = await fixture(t, { phone: { qzone: { enabled: false } } });
  const cfg = loadConfig(file);
  assert.deepEqual(cfg.qzonePatrol, template.qzonePatrol);
  assert.equal(cfg.qzonePatrol.enabled, false);
  assert.equal(cfg.qzonePatrol.runner.enabled, false);
  assert.equal(cfg.qzonePatrol.runner.autoLike, false);
  assert.equal(cfg.qzonePatrol.dryRun, true);
  assert.equal(cfg.qzonePatrol.allowLikes, false);
  assert.equal(cfg.qzonePatrol.allowComments, false);
  assert.deepEqual(cfg.qzonePatrol.allowedUsers, []);
  assert.deepEqual(entriesFor(cfg), []);
});

test('partial nested config preserves conservative defaults and rejects malformed sections', async t => {
  const { file } = await fixture(t, { qzonePatrol: { runner: { intervalMinutes: 20 }, quietHours: { start: '23:00' } } });
  const p = loadConfig(file).qzonePatrol;
  assert.deepEqual(p.runner, { enabled: false, intervalMinutes: 20, autoLike: false });
  assert.equal(p.quietHours.timeZone, 'Asia/Shanghai');
  for (const input of [{ qzonePatrol: null }, { qzonePatrol: { runner: [] } }, { qzonePatrol: { quietHours: null } }]) {
    await fs.writeFile(file, JSON.stringify(input));
    assert.throws(() => loadConfig(file), /must be an object/);
  }
});

test('patrol config rejects unsafe values even while disabled, while zero quotas remain valid', () => {
  for (const patch of [
    { enabled: 'false' }, { dryRun: 0 }, { allowLikes: 'true' },
    { allowedUsers: [12345] }, { allowedUsers: ['012345'] }, { blockedUsers: ['9007199254740992'] },
    { baseUrl: 'https://example.com' }, { baseUrl: 'http://127.0.0.1:3000/path' },
    { accessTokenEnv: 'TOKEN=value' }, { dailyLikeLimit: -1 }, { hourlyLimit: 1.5 },
    { scanPageSize: 0 }, { maxPostAgeHours: 721 },
    { runner: { enabled: false, autoLike: 'false', intervalMinutes: 30 } },
    { runner: { enabled: false, autoLike: false, intervalMinutes: 4 } },
    { quietHours: { start: '25:00', end: '08:00', timeZone: 'Asia/Shanghai' } },
    { quietHours: { start: '01:00', end: '08:00', timeZone: '' } },
    { quietHours: { start: '01:00', end: '08:00', timeZone: 'Invalid/Fixture' } },
  ]) {
    const cfg = fresh();
    Object.assign(cfg.qzonePatrol, patch);
    assert.throws(() => validateConfig(cfg));
  }
  const cfg = fresh();
  Object.assign(cfg.qzonePatrol, { dailyLikeLimit: 0, dailyCommentLimit: 0, hourlyLimit: 0 });
  assert.equal(validateConfig(cfg), cfg);
});

test('setup installs and removes only owned qzone entries, preserves phone and rejects name collisions', () => {
  const cfg = fresh();
  cfg.qzonePatrol.enabled = true;
  const entries = entriesFor(validateConfig(cfg));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, 'mcp-qq-optional-qzone');
  assert.equal(entries[0].config.serverName, 'qzone');
  assert.match(entries[0].config.args[0], /qzone-patrol[/\\]server\.mjs$/);
  const original = yaml.dump([{ insert: [{ id: 'keep-phone', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'phone' } }] }]);
  const installed = patchDocument(original, entries);
  assert.equal(patchDocument(installed, entries), installed);
  assert.deepEqual(yaml.load(patchDocument(installed, [])), yaml.load(original));
  const collision = yaml.dump([{ insert: [{ id: 'unmanaged-qzone', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'qzone' } }] }]);
  assert.throws(() => patchDocument(collision, entries), /unmanaged MCP/);
});

test('setup check, install, repeat and removal work through the CLI without starting services', async t => {
  const cfg = fresh();
  cfg.qzonePatrol.enabled = true;
  const { dir, file } = await fixture(t, cfg);
  const profile = path.join(dir, 'profiles/web');
  await fs.mkdir(profile, { recursive: true });
  const patchFile = path.join(profile, 'cordis.patch.yml');
  const original = yaml.dump([{ insert: [{ id: 'preserve-me', name: 'fixture-plugin' }] }]);
  await fs.writeFile(patchFile, original);
  const run = args => spawnSync(process.execPath, [path.join(ROOT, 'optional/setup.mjs'), ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 15000, windowsHide: true,
    env: { ...process.env, DSH_HOME: dir, QQ_BOT_OPTIONAL_CONFIG: file },
  });
  for (const args of [['--check'], [], [], ['--remove']]) {
    const result = run(args);
    assert.equal(result.status, 0, result.stderr);
    const current = await fs.readFile(patchFile, 'utf8');
    if (args.length) assert.deepEqual(yaml.load(current), yaml.load(original));
    else assert(current.includes('mcp-qq-optional-qzone'));
  }
});

test('real stdio MCP starts disabled, lists no tools and denies scanning without gateway calls', async t => {
  const { file } = await fixture(t, fresh());
  const client = new Client({ name: 'offline-patrol-integration', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(ROOT, 'optional/qzone-patrol/server.mjs')],
    cwd: ROOT, env: { ...process.env, QQ_BOT_OPTIONAL_CONFIG: file }, stderr: 'pipe',
  });
  t.after(() => client.close());
  await client.connect(transport);
  assert.deepEqual((await client.listTools()).tools, []);
  const denied = await client.callTool({ name: 'qzone_scan', arguments: {} });
  assert.equal(denied.isError, true);
  assert.equal(JSON.parse(denied.content[0].text).error.code, 'disabled');
});
