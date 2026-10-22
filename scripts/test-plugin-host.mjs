// 插件宿主的契约测试：加载 / 依赖 / 分发 / 状态分片 / 失败隔离。
// 不碰真实 config、不连 QQ、不写项目 state —— 全部落在 os.tmpdir() 的临时目录里。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

// 用 fileURLToPath 而不是 URL.pathname：Windows 上 pathname 是 /E:/... 且中文会被百分号编码。
const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
const pluginsDir = path.join(srcDir, 'plugins');
const hostFile = path.join(srcDir, 'plugin-host', 'index.mjs');
const hostHref = pathToFileURL(hostFile).href;
const { createPluginHost, definePlugin } = await import(hostHref);

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-plugin-host-'));
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  return root;
}

// 假宿主服务：接口按真实模块的签名裁过，够跑通路由即可。
function fakeServices() {
  const reminders = [];
  const calls = [];
  return {
    calls,
    reminderStore: {
      list: (key) => reminders.filter((it) => it.key === key && !it.firedAt).sort((a, b) => a.dueAt - b.dueAt),
      all: () => reminders.slice(),
      add({ key, text, dueAt, createdBy }) {
        if (!key) return { ok: false, error: 'key 不能为空' };
        if (!String(text ?? '').trim()) return { ok: false, error: '提醒内容不能为空' };
        if (!Number.isFinite(Number(dueAt))) return { ok: false, error: 'dueAt 必须是毫秒时间戳' };
        const item = { id: `r${reminders.length + 1}`, key, text: String(text), dueAt: Number(dueAt), createdAt: Date.now(), createdBy, firedAt: 0 };
        reminders.push(item);
        return { ok: true, item };
      },
      cancel(key, id) {
        const idx = reminders.findIndex((it) => it.id === String(id) && it.key === key);
        if (idx < 0) return { ok: false, error: '找不到这条提醒（或不属于该会话）' };
        return { ok: true, item: reminders.splice(idx, 1)[0] };
      },
    },
    tokenLedger: {
      summary: ({ limit }) => ({ ok: true, limit, totals: { input: 0 }, entries: [] }),
      series: ({ hours, maxBuckets }) => ({ ok: true, hours, maxBuckets, points: [] }),
      conversation: (key) => (key ? { ok: true, key, turns: [] } : null),
      recent: (limit) => [{ limit, at: 1 }],
      reset: () => { calls.push('token-reset'); },
      stats: () => ({ lines: 12 }),
    },
    priceTable: { symbol: 'USD' },
    // 黑话库门面：这里只验「插件 → 服务」的参数搬运与 HTTP 映射，词条语义由桥接自己的测试覆盖。
    slang: {
      list: (status) => ({ status: 200, body: { ok: true, status: status ?? 'all', entries: [] } }),
      add: (body) => (String(body?.content ?? '').trim()
        ? { status: 200, body: { ok: true, id: 's1' } }
        : { status: 400, body: { ok: false, error: '内容不能为空' } }),
      update: (id, body) => { calls.push(`slang-update:${id}`); return { status: 200, body: { ok: true, id, patch: body } }; },
      confirm: (id) => ({ status: 200, body: { ok: true, id } }),
      reject: (id) => ({ status: 200, body: { ok: true, id } }),
      remove: (id) => ({ status: 200, body: { ok: true, id } }),
      batchConfirm: (body) => ({ status: 200, body: { ok: true, ids: body.ids } }),
      batchReject: (body) => ({ status: 200, body: { ok: true, ids: body.ids } }),
      batchDelete: (body) => ({ status: 200, body: { ok: true, ids: body.ids ?? null, status: body.status ?? null } }),
      clear: () => ({ status: 200, body: { ok: true, cleared: 2 } }),
      extract: (body) => (body?.key ? { status: 202, body: { ok: true, key: body.key } } : { status: 409, body: { ok: false, error: '没有待学习窗口' } }),
      research: (body) => ({ status: 202, body: { ok: true, ids: body?.ids ?? [] } }),
      config: (body) => ({ status: 200, body: { ok: true, config: body } }),
    },
  };
}

function makeClient(host) {
  return async function request({ method = 'GET', pathname, query = '', body = null }) {
    const url = new URL(`http://127.0.0.1${pathname}${query ? `?${query}` : ''}`);
    const out = { status: 0, body: null };
    const res = { headersSent: false };
    const sendJson = (obj, status = 200) => { out.status = status; out.body = obj; res.headersSent = true; };
    const readBody = async () => body ?? {};
    const handled = await host.dispatch({ method, headers: {} }, res, url, { sendJson, readBody });
    return { handled, ...out };
  };
}

function writePlugin(dir, id, source) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.mjs'), source, 'utf8');
}

test('definePlugin 拒绝不合法的定义', () => {
  assert.throws(() => definePlugin(null), /必须是对象/);
  assert.throws(() => definePlugin({ id: 'Bad Id' }), /id 不合法/);
  assert.throws(() => definePlugin({ id: 'ok', surface: 'root' }), /surface 不合法/);
  assert.throws(() => definePlugin({ id: 'ok', routes: [{ method: 'PUT', path: '/x', handler() {} }] }), /method 不合法/);
  assert.throws(() => definePlugin({ id: 'ok', routes: [{ method: 'GET', path: '../x', handler() {} }] }), /path 不合法/);
  assert.throws(() => definePlugin({ id: 'ok', routes: [{ method: 'GET', path: '/x' }] }), /缺 handler/);
  assert.throws(
    () => definePlugin({ id: 'ok', routes: [{ method: 'GET', path: '/x', handler() {} }, { method: 'GET', path: '/x', handler() {} }] }),
    /路由重复/,
  );
  const ok = definePlugin({ id: 'ok', routes: [{ method: 'get', path: '/x', handler() {} }] });
  assert.equal(ok.routes[0].method, 'GET');
  assert.equal(ok.surface, 'console');
  assert.ok(Object.isFrozen(ok));
});

test('加载试点插件：索引、路由分发、参数校验', async () => {
  const root = tempRoot();
  const services = fakeServices();
  const host = await createPluginHost({ root, pluginsDir, services });
  const request = makeClient(host);

  const index = await request({ pathname: '/api/plugins' });
  assert.equal(index.handled, true);
  assert.equal(index.status, 200);
  const ids = index.body.plugins.map((p) => p.id).sort();
  assert.deepEqual(ids, ['reminders', 'slang', 'token-ledger']);
  assert.ok(index.body.plugins.every((p) => p.status === 'running'));

  // slang：入参校验在插件层就挡住；查询串原样交给服务
  const slangBad = await request({ method: 'POST', pathname: '/api/plugins/slang/add', body: {} });
  assert.equal(slangBad.status, 400);
  const slangNoId = await request({ method: 'POST', pathname: '/api/plugins/slang/update', body: { meaning: 'x' } });
  assert.equal(slangNoId.status, 400);
  const slangList = await request({ pathname: '/api/plugins/slang/list', query: 'status=candidate' });
  assert.equal(slangList.status, 200);
  assert.equal(slangList.body.status, 'candidate');

  // 未注入 sendJson/readBody 时必须大声失败，而不是静默 200
  await assert.rejects(
    () => host.dispatch({ method: 'GET' }, {}, new URL('http://127.0.0.1/api/plugins'), {}),
    /必须注入/,
  );

  // reminders：参数校验 → 新增 → 列表 → 取消
  const noKey = await request({ pathname: '/api/plugins/reminders/list' });
  assert.equal(noKey.status, 400);

  const added = await request({
    method: 'POST',
    pathname: '/api/plugins/reminders/add',
    body: { key: 'private:123', text: '开会', dueAt: Date.now() + 60000 },
  });
  assert.equal(added.status, 200);
  assert.equal(added.body.ok, true);
  assert.equal(added.body.pending.length, 1);

  const listed = await request({ pathname: '/api/plugins/reminders/list', query: 'key=private%3A123' });
  assert.equal(listed.body.items.length, 1);
  assert.match(listed.body.items[0].dueText, /\d/);

  const canceled = await request({
    method: 'POST',
    pathname: '/api/plugins/reminders/cancel',
    body: { key: 'private:123', id: added.body.item.id },
  });
  assert.equal(canceled.body.ok, true);
  assert.equal(canceled.body.pending.length, 0);

  // token-ledger：参数钳制 + reset 会打到账本上
  const series = await request({ pathname: '/api/plugins/token-ledger/series', query: 'hours=99999&buckets=1' });
  assert.equal(series.body.hours, 24 * 90);
  assert.equal(series.body.maxBuckets, 6);
  const recent = await request({ pathname: '/api/plugins/token-ledger/recent' });
  assert.equal(recent.body.symbol, 'USD');
  await request({ method: 'POST', pathname: '/api/plugins/token-ledger/reset' });
  assert.deepEqual(services.calls, ['token-reset']);

  // 未知插件 / 未知路由
  assert.equal((await request({ pathname: '/api/plugins/nope/list' })).status, 404);
  assert.equal((await request({ pathname: '/api/plugins/reminders/nope' })).status, 404);

  await host.close();
});

test('缺少宿主服务时插件被跳过而不是崩掉', async () => {
  const root = tempRoot();
  const host = await createPluginHost({ root, pluginsDir });
  const request = makeClient(host);
  const index = await request({ pathname: '/api/plugins' });
  assert.ok(index.body.plugins.every((p) => p.status === 'skipped'));
  const call = await request({ pathname: '/api/plugins/reminders/list', query: 'key=x' });
  assert.equal(call.status, 503);
  await host.close();
});

test('坏插件被隔离，好插件照常工作；状态落在 state/plugins/<id>/', async () => {
  const root = tempRoot();
  const pluginsDir = path.join(root, 'my-plugins');

  writePlugin(path.join(pluginsDir, 'broken'), 'broken', "throw new Error('import 期就炸');\n");
  writePlugin(path.join(pluginsDir, 'bad-def'), 'bad-def', `import { definePlugin } from ${JSON.stringify(hostHref)};\nexport default definePlugin({ id: 'Bad Id' });\n`);
  writePlugin(path.join(pluginsDir, 'good'), 'good', [
    `import { definePlugin } from ${JSON.stringify(hostHref)};`,
    'export default definePlugin({',
    "  id: 'good', title: '好插件', state: ['note.json'],",
    '  hooks: { start(ctx) { ctx.startedAt = 42; } },',
    '  routes: [{',
    "    method: 'GET', path: '/ping',",
    '    handler: (ctx) => ({ json: { ok: true, startedAt: ctx.startedAt } }),',
    '  }, {',
    "    method: 'POST', path: '/write',",
    '    async handler(ctx, call) {',
    '      const body = await call.body();',
    "      const store = ctx.state.json('note.json', { sharded: true });",
    '      store.write({ note: body.note });',
    '      return { json: { ok: true, file: store.file, readBack: store.read() } };',
    '    },',
    '  }],',
    '});',
    '',
  ].join('\n'));

  const host = await createPluginHost({ root, pluginsDir });
  const request = makeClient(host);
  const index = await request({ pathname: '/api/plugins' });
  assert.deepEqual(index.body.plugins.map((p) => p.id), ['good']);
  assert.equal(index.body.failures.length, 2);

  const ping = await request({ pathname: '/api/plugins/good/ping' });
  assert.deepEqual(ping.body, { ok: true, startedAt: 42 });

  const written = await request({ method: 'POST', pathname: '/api/plugins/good/write', body: { note: 'hello' } });
  assert.equal(written.body.readBack.note, 'hello');
  const expected = path.join(root, 'state', 'plugins', 'good', 'note.json');
  assert.equal(fs.existsSync(expected), true, `分片状态应落在 ${expected}`);
  assert.equal(fs.existsSync(path.join(root, 'state', 'note.json')), false, '不应写进平铺 state/');

  await host.close();
  assert.equal((await request({ pathname: '/api/plugins' })).handled, true, 'close 之后仍应是「已处理」而不是漏到 404');
});
