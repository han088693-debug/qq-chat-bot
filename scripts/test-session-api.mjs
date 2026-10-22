// Offline HTTP contracts against temporary state and mocked QQ/DSH peers.
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

async function fixture(run) {
  const h = await bridgeHarness();
  h.setMode('reserved2');
  const owner = h.getSocialV2State('private:123');
  const group = h.getSocialV2State('group:456');
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const request = (route, { method = 'GET', token, body, agent = false } = {}) =>
    new Promise((resolve, reject) => {
      const headers = { 'x-console-token': 'fixture-console-token' };
      if (token !== undefined) headers['x-agent-token'] = token;
      if (agent) headers['x-agent-call'] = '1';
      if (body !== undefined) headers['content-type'] = 'application/json';
      const req = http.request({
        host: '127.0.0.1', port: server.address().port, path: route, method, headers,
      }, res => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch (error) { reject(error); }
        });
      });
      req.on('error', reject);
      req.setTimeout(3000, () => req.destroy(new Error('fixture request timed out')));
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  try { await run({ h, request, ownerToken: owner.agentToken, groupToken: group.agentToken }); }
  finally {
    await new Promise(resolve => server.close(resolve));
    await h.close();
  }
}

test('diary HTTP routes derive scope from the token and reject stale access', () =>
  fixture(async ({ h, request, ownerToken, groupToken }) => {
    const first = await request('/api/socialV2/diary/write', {
      method: 'POST', token: ownerToken, agent: true,
      body: { text: 'owner fixture note', key: 'group:456' },
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.key, 'private:123', 'body key cannot redirect a diary write');

    const second = await request('/api/socialV2/diary/write', {
      method: 'POST', token: groupToken, agent: true,
      body: { text: 'group fixture note' },
    });
    assert.equal(second.status, 200);
    const own = await request('/api/socialV2/diary/read?key=group:456', { token: ownerToken, agent: true });
    assert.equal(own.status, 200);
    assert.equal(own.body.key, 'private:123');
    assert.match(own.body.entries[0].text, /owner fixture note/);
    assert.doesNotMatch(own.body.entries[0].text, /group fixture note/);
    const other = await request('/api/socialV2/diary/read', { token: groupToken, agent: true });
    assert.match(other.body.entries[0].text, /group fixture note/);
    assert.doesNotMatch(other.body.entries[0].text, /owner fixture note/);

    for (const headers of [{}, { agent: true }, { token: 'invalid-fixture', agent: true }]) {
      assert.equal((await request('/api/socialV2/diary/read', headers)).status, 403);
    }
    h.cfg.allow.groups = [];
    assert.equal((await request('/api/socialV2/diary/read', { token: groupToken, agent: true })).status, 403);
    h.setMode('chat');
    assert.equal((await request('/api/socialV2/diary/read', { token: ownerToken, agent: true })).status, 403);
    assert.equal(h.calls.sent.length, 0);
  }));

test('new administrative routes cannot be reached by a QQ agent', () =>
  fixture(async ({ h, request, ownerToken }) => {
    for (const route of ['/api/plugins', '/api/persona/audit?key=private:123', '/api/socialV2/policy?key=private:123']) {
      assert.equal((await request(route, { token: ownerToken, agent: true })).status, 403, route);
      assert.equal((await request(route, { agent: true })).status, 403, `${route}: tokenless`);
    }
    const changed = await request('/api/socialV2/policy', {
      method: 'POST', token: ownerToken, agent: true,
      body: { key: 'private:123', reasoningEffort: 'high' },
    });
    assert.equal(changed.status, 403);
    assert.deepEqual(Object.keys(h.cfg.socialV2.sessionPolicies ?? {}), []);
  }));

test('persona audit requires an explicit session and the console can set model/effort', () =>
  fixture(async ({ h, request }) => {
    assert.equal((await request('/api/persona/audit')).status, 400);
    assert.equal((await request('/api/persona/audit?key=../other')).status, 400);
    const missing = await request('/api/persona/audit?key=private:999');
    assert.equal(missing.body.ok, false);
    assert.match(missing.body.error, /没有这个会话/);
    const saved = await request('/api/socialV2/policy', {
      method: 'POST', body: { key: 'private:123', model: 'fixture-model', reasoningEffort: 'high' },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const policy = await request('/api/socialV2/policy?key=private:123');
    assert.equal(policy.body.effective.model, 'fixture-model');
    assert.equal(policy.body.effective.reasoningEffort, 'high');
    assert.equal(policy.body.globalMode, 'reserved2');
    const selected = [];
    h.api.sessions.selectModel = async params => {
      selected.push(params);
      return { result: { ok: true, value: { selected: params } } };
    };
    await h.ensureSession('private:123');
    assert.equal(selected.at(-1).model, 'fixture-model');
    assert.equal(selected.at(-1).reasoningEffort, 'high');
    assert.equal(h.calls.created.at(-1).agentPreset, 'qq-chat-v2');
  }));
