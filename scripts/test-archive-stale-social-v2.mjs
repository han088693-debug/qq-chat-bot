import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const source = new URL('./archive-stale-social-v2.mjs', import.meta.url);
const staleKey = 'private:100002';
const allowedKey = 'private:100001';
const oldConversation = {
  lastIncomingAt: Date.now() - 14 * 86400000,
  recentMessages: [{ text: 'synthetic archived conversation' }],
  unread: [],
  wakeConfig: { mode: 'diving' },
};

function isolated(run) {
  return () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-archive-test-'));
    const script = path.join(root, 'scripts', 'archive-stale-social-v2.mjs');
    const config = path.join(root, 'config.json');
    const state = path.join(root, 'state', 'social-v2.json');
    const now = new Date();
    const archive = path.join(root, 'state', 'archive', `social-v2-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}.json`);
    const write = (file, value) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(value));
    };
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.copyFileSync(source, script);
    write(config, { allow: { private: ['100001'], groups: [] } });
    write(state, { conversations: { [staleKey]: oldConversation, [allowedKey]: oldConversation } });
    const originalState = fs.readFileSync(state);
    const invoke = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });
    const archiveEntry = { key: staleKey, data: oldConversation };
    const failedWrite = (target, ...args) => {
      const hook = path.join(root, 'fail-write.mjs');
      fs.writeFileSync(hook, `import fs from 'node:fs'; const original = fs.renameSync; fs.renameSync = function(from, to) { if (to === ${JSON.stringify(target)}) { const error = new Error('fixture write failure'); error.code = 'EACCES'; throw error; } return original.call(this, from, to); };`);
      return spawnSync(process.execPath, ['--import', pathToFileURL(hook).href, script, ...args], { cwd: root, encoding: 'utf8' });
    };
    try {
      run({ root, config, state, archive, write, invoke, failedWrite, archiveEntry, originalState });
    } finally {
      assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
      assert.ok(path.basename(root).startsWith('qq-bridge-archive-test-'));
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

function unchanged(f, before = f.originalState) {
  assert.deepEqual(fs.readFileSync(f.state), before);
}

test('preview is read-only; apply and restore preserve whitelisted conversations', isolated((f) => {
  assert.equal(f.invoke('--preview').status, 0);
  unchanged(f);
  assert.equal(fs.existsSync(f.archive), false);
  assert.equal(f.invoke('--apply').status, 0);
  const applied = JSON.parse(fs.readFileSync(f.state, 'utf8'));
  assert.equal(applied.conversations[staleKey].archived, true);
  assert.deepEqual(applied.conversations[allowedKey], oldConversation);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.archive, 'utf8')).archived[0].data, oldConversation);
  assert.equal(f.invoke('--restore', staleKey).status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.state, 'utf8')).conversations[staleKey], oldConversation);
}));

for (const kind of ['missing', 'malformed', 'unreadable', 'invalid-shape']) {
  test(`invalid configuration fails closed (${kind})`, isolated((f) => {
    if (kind === 'missing' || kind === 'unreadable') fs.unlinkSync(f.config);
    if (kind === 'unreadable') fs.mkdirSync(f.config);
    if (kind === 'malformed') fs.writeFileSync(f.config, '{broken');
    if (kind === 'invalid-shape') f.write(f.config, { allow: { private: 'not-an-array', groups: [] } });
    assert.equal(f.invoke('--apply').status, 1);
    unchanged(f);
    assert.equal(fs.existsSync(f.archive), false);
  }));
}

for (const kind of ['malformed', 'invalid-shape']) {
  test(`existing archive is never replaced with an empty fallback (${kind})`, isolated((f) => {
    f.write(f.archive, { archived: 'invalid' });
    if (kind === 'malformed') fs.writeFileSync(f.archive, '{broken');
    const originalArchive = fs.readFileSync(f.archive);
    assert.equal(f.invoke('--apply').status, 1);
    unchanged(f);
    assert.deepEqual(fs.readFileSync(f.archive), originalArchive);
  }));
}

test('invalid state structure is rejected before modifying any archive', isolated((f) => {
  f.write(f.state, { conversations: [] });
  const before = fs.readFileSync(f.state);
  assert.equal(f.invoke('--apply').status, 1);
  unchanged(f, before);
  assert.equal(fs.existsSync(f.archive), false);
}));

test('restore refuses to overwrite a currently active conversation', isolated((f) => {
  f.write(f.archive, { version: 1, archived: [f.archiveEntry] });
  const originalArchive = fs.readFileSync(f.archive);
  assert.equal(f.invoke('--restore', staleKey).status, 1);
  unchanged(f);
  assert.deepEqual(fs.readFileSync(f.archive), originalArchive);
}));

test('restore rejects invalid archived conversation data', isolated((f) => {
  f.write(f.state, { conversations: { [staleKey]: { archived: true } } });
  f.write(f.archive, { version: 1, archived: [{ key: staleKey, data: null }] });
  const originalState = fs.readFileSync(f.state);
  const originalArchive = fs.readFileSync(f.archive);
  assert.equal(f.invoke('--restore', staleKey).status, 1);
  unchanged(f, originalState);
  assert.deepEqual(fs.readFileSync(f.archive), originalArchive);
}));

test('an archive write failure leaves the live state intact', isolated((f) => {
  assert.equal(f.failedWrite(f.archive, '--apply').status, 1);
  unchanged(f);
  assert.equal(fs.existsSync(f.archive), false);
}));

test('a live-state write failure retains both the original and its archived data', isolated((f) => {
  assert.equal(f.failedWrite(f.state, '--apply').status, 1);
  unchanged(f);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.archive, 'utf8')).archived[0].data, oldConversation);
}));

test('a restore state-write failure does not consume the archive entry', isolated((f) => {
  f.write(f.state, { conversations: { [staleKey]: { archived: true } } });
  f.write(f.archive, { version: 1, archived: [f.archiveEntry] });
  const originalState = fs.readFileSync(f.state);
  const originalArchive = fs.readFileSync(f.archive);
  assert.equal(f.failedWrite(f.state, '--restore', staleKey).status, 1);
  unchanged(f, originalState);
  assert.deepEqual(fs.readFileSync(f.archive), originalArchive);
}));
