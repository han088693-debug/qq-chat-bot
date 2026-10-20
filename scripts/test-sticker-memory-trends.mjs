// 自检：#1 图片记忆（sticker-memory）与 #2 热榜简报（hot-trends）。
//
// 分两层：
//   1) 模块级断言 —— 直接测 src/sticker-memory.js、src/hot-trends.js（不碰网络：fetch 用夹具替身）
//   2) 桥接级断言 —— 用 audit-bridge-harness 在 VM 里跑**真的** src/bridge.js，验证
//      「送图带 id= → qq_sticker_remember 记录 → 同图只给文字不再送图」与唤醒提示里的注入行。
//
// 运行：node scripts/test-sticker-memory-trends.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const { createStickerMemoryStore, stickerMemoryHash, normalizeStickerMemoryEntry } = await import(
  pathToFileURL(path.join(SRC, 'sticker-memory.js')).href
);
const { createHotTrendCache, startHotTrendScheduler } = await import(pathToFileURL(path.join(SRC, 'hot-trends.js')).href);

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try {
    const result = fn();
    if (result instanceof Promise) throw new Error('异步断言请用 okAsync');
    pass += 1;
    console.log(`  ✅ ${name}`);
  } catch (error) {
    fail += 1;
    console.error(`  ❌ ${name}: ${error?.message ?? error}`);
  }
}
async function okAsync(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ✅ ${name}`);
  } catch (error) {
    fail += 1;
    console.error(`  ❌ ${name}: ${error?.message ?? error}`);
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbridge-memory-trends-'));

try {
  // ── 1. sticker-memory 模块 ────────────────────────────────────────────────
  console.log('\n[sticker-memory]');
  ok('hash 稳定、12 位、空值安全', () => {
    const a = stickerMemoryHash(Buffer.from('hello'));
    assert.equal(a.length, 12);
    assert.match(a, /^[0-9a-f]{12}$/);
    assert.equal(a, stickerMemoryHash(Buffer.from('hello')));
    assert.notEqual(a, stickerMemoryHash(Buffer.from('hello!')));
    assert.equal(stickerMemoryHash(null), '');
    assert.equal(stickerMemoryHash(Buffer.alloc(0)), '');
  });
  ok('normalize 拒绝坏 hash、单行化 note', () => {
    assert.equal(normalizeStickerMemoryEntry({ hash: 'zzz', note: 'x' }), null);
    const entry = normalizeStickerMemoryEntry({ hash: 'A1B2C3D4E5F6', note: '第一行\n第二行', source: 'bogus' });
    assert.equal(entry.hash, 'a1b2c3d4e5f6');
    assert.equal(entry.note, '第一行 第二行');
    assert.equal(entry.source, 'model');
  });

  const memFile = path.join(tmpRoot, 'sticker-memory.json');
  const store = createStickerMemoryStore(memFile, { log: () => {} });
  ok('空库按 0 条处理', () => assert.equal(store.stats().count, 0));
  ok('remember 落库 + 大小写不敏感查找', () => {
    const entry = store.remember({ hash: 'A1B2C3D4E5F6', note: '竖大拇指\n表示赞成', chatKey: 'private:1' });
    assert.equal(entry.hash, 'a1b2c3d4e5f6');
    assert.equal(entry.note, '竖大拇指 表示赞成');
    assert.equal(store.lookup('a1b2c3d4e5f6').note, '竖大拇指 表示赞成');
  });
  ok('非法 hash / 空 note 被拒', () => {
    assert.throws(() => store.remember({ hash: 'zzz', note: 'x' }));
    assert.throws(() => store.remember({ hash: 'a1b2c3d4e5f6', note: '   ' }));
  });
  ok('touch 计数', () => {
    store.touch('a1b2c3d4e5f6');
    store.touch('a1b2c3d4e5f6');
    assert.equal(store.lookup('a1b2c3d4e5f6').useCount, 2);
  });
  ok('落盘后能重新加载', () => {
    store.save();
    const raw = JSON.parse(fs.readFileSync(memFile, 'utf8'));
    assert.equal(raw.version, 1);
    assert.equal(raw.entries.length, 1);
    const store2 = createStickerMemoryStore(memFile);
    assert.equal(store2.lookup('a1b2c3d4e5f6').note, '竖大拇指 表示赞成');
  });
  ok('超过 maxEntries 按最近使用淘汰', () => {
    const small = createStickerMemoryStore(path.join(tmpRoot, 'small.json'), { maxEntries: 50 });
    for (let i = 0; i < 60; i += 1) {
      small.remember({ hash: `deadbeef${String(i).padStart(4, '0')}`, note: `n${i}` });
    }
    assert.equal(small.stats().count, 50);
    assert.equal(small.lookup('deadbeef0059').note, 'n59');
    assert.equal(small.lookup('deadbeef0000'), null);
  });
  ok('坏文件读取时抛错（桥接据此整套停用记忆）', () => {
    const bad = path.join(tmpRoot, 'bad.json');
    fs.writeFileSync(bad, '{not json');
    const broken = createStickerMemoryStore(bad);
    assert.throws(() => broken.stats());
  });

  // ── 2. hot-trends 模块（fetch 用夹具替身，不联网）─────────────────────────
  console.log('\n[hot-trends]');
  const fixtures = {
    'https://tieba.baidu.com/hottopic/browse/topicList': {
      data: {
        bang_topic: {
          topic_list: [
            { topic_name: '贴吧热一', topic_desc: '描述', topic_url: 'https://tieba.baidu.com/p/1' },
            { topic_name: '贴吧热一', topic_desc: '重复项' },
            { topic_name: '贴吧热二\ntitle' }
          ]
        }
      }
    },
    'https://api.bilibili.com/x/web-interface/popular?ps=20&pn=1': {
      code: 0,
      data: {
        list: [
          { title: 'B站热一', bvid: 'BV1xx', short_link_v2: 'https://b23.tv/abc' },
          { title: 'B站热二', bvid: 'BV2xx' }
        ]
      }
    }
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const body = fixtures[String(url)];
    if (!body) return { ok: false, status: 404 };
    return { ok: true, status: 200, json: async () => body };
  };

  const cacheFile = path.join(tmpRoot, 'hot-trends.json');
  const cache = createHotTrendCache(cacheFile, { log: () => {} });
  await okAsync('collect 抓两个源、去重、落盘', async () => {
    const report = await cache.collect({ perSourceLimit: 5 });
    assert.deepEqual([...report.ok].sort(), ['bilibili', 'tieba']);
    assert.equal(report.failed.length, 0);
    const onDisk = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    assert.equal(onDisk.sources.tieba.items.length, 2); // 去重后 2 条
    assert.equal(onDisk.sources.bilibili.items[1].url, 'https://www.bilibili.com/video/BV2xx');
  });
  ok('brief 一行简报（带时间戳）', () => {
    const brief = cache.brief();
    assert.match(brief, /^【热榜（\d{2}-\d{2} \d{2}:\d{2}）】贴吧热议：贴吧热一、贴吧热二 title；B站热门：B站热一、B站热二$/);
    assert.ok(brief.length <= 480);
  });
  ok('brief 遵守 maxChars', () => {
    assert.ok(cache.brief({ maxChars: 100 }).length <= 100);
    assert.ok(cache.brief({ maxChars: 100 }).length > 0);
  });
  await okAsync('单个源失败保留旧条目', async () => {
    globalThis.fetch = async (url) =>
      String(url).includes('bilibili') ? { ok: false, status: 500 } : { ok: true, status: 200, json: async () => fixtures[String(url)] };
    const report = await cache.collect({});
    assert.deepEqual(report.ok, ['tieba']);
    assert.equal(report.failed.length, 1);
    assert.match(cache.brief(), /B站热门：B站热一/);
  });
  await okAsync('scheduler.tick 可用，enabled=false 时不动', async () => {
    globalThis.fetch = async (url) => ({ ok: true, status: 200, json: async () => fixtures[String(url)] });
    const sched = startHotTrendScheduler({ store: cache, getCfg: () => ({ enabled: true }), log: () => {} });
    assert.equal(await sched.tick('test'), true);
    sched.stop();
    const off = startHotTrendScheduler({ store: cache, getCfg: () => ({ enabled: false }), log: () => {} });
    assert.equal(await off.tick('test'), false);
    off.stop();
  });
  ok('缓存过期后不注入', () => {
    const data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    for (const source of Object.values(data.sources)) source.fetchedAt = Date.now() - 48 * 3600 * 1000;
    fs.writeFileSync(cacheFile, JSON.stringify(data));
    const stale = createHotTrendCache(cacheFile);
    assert.equal(stale.brief({ maxAgeMs: 3600 * 1000 }), '');
  });
  globalThis.fetch = realFetch;

  // ── 3. 桥接级：真 bridge.js（VM 夹具，不连 QQ / 不起 DSH）─────────────────
  console.log('\n[bridge 集成]');
  const HOT_CACHE = {
    version: 1,
    updatedAt: Date.now(),
    sources: {
      tieba: { label: '贴吧热议', fetchedAt: Date.now(), items: [{ title: '测试热一' }, { title: '测试热二' }] },
      bilibili: { label: 'B站热门', fetchedAt: Date.now(), items: [{ title: 'B站视频一' }] }
    }
  };
  const STICKER = [{ kind: 'sticker', file: 'fixture-sticker.png', url: '', subType: '1', summary: '' }];

  await okAsync('送图带 id= → 记录 → 同图只给文字；热榜行注入 prompt', async () => {
    const h = await bridgeHarness({
      config: { socialV2: { sticker: { enabled: true, memory: { enabled: true } }, hotTrends: { enabled: true } } },
      files: { 'state/hot-trends.json': HOT_CACHE }
    });
    try {
      const server = h.startConsoleServer();
      if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
      const base = `http://127.0.0.1:${server.address().port}`;

      const first = await h.resolveMediaList(STICKER);
      const firstText = first.find((p) => p.type === 'text')?.text ?? '';
      assert.match(firstText, /id=[0-9a-f]{12}/, '首次送图的文字标签应带 id=');
      assert.ok(first.some((p) => p.type === 'image'), '首次送图应附带 image part');
      const hash = /id=([0-9a-f]{12})/.exec(firstText)[1];

      const noted = await fetch(`${base}/api/socialV2/sticker-remember`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token' },
        body: JSON.stringify({ key: 'private:123', hash, note: '测试梗图' })
      });
      const notedBody = await noted.json().catch(() => ({}));
      assert.equal(noted.status, 200, `记录端点 HTTP ${noted.status}`);
      assert.equal(notedBody.ok, true);

      const second = await h.resolveMediaList(STICKER);
      assert.ok(!second.some((p) => p.type === 'image'), '命中记忆后不应再送图');
      assert.match(second.map((p) => p.text ?? '').join(' '), /已记忆：测试梗图/);

      const promptRes = await fetch(`${base}/api/socialV2/prompt?key=private%3A123&token=fixture-console-token`);
      const prompt = await promptRes.json().catch(() => ({}));
      assert.equal(promptRes.status, 200, `GET /api/socialV2/prompt HTTP ${promptRes.status}`);
      assert.ok(Array.isArray(prompt.enabledTools) && prompt.enabledTools.includes('qq_sticker_remember'), 'enabledTools 应含 qq_sticker_remember');
      assert.match(String(prompt.injectLines?.stickerMemory ?? ''), /【图片记忆】/);
      assert.match(String(prompt.injectLines?.hotTrends ?? ''), /【热榜[^】]*】贴吧热议：测试热一/);
    } finally {
      await h.close();
    }
  });

  await okAsync('记忆关闭 / applyToImages=false 时行为正确', async () => {
    const off = await bridgeHarness({ config: { socialV2: { sticker: { enabled: true, memory: { enabled: false } }, hotTrends: { enabled: false } } } });
    try {
      const parts = await off.resolveMediaList(STICKER);
      const text = parts.find((p) => p.type === 'text')?.text ?? '';
      assert.ok(!/id=[0-9a-f]{12}/.test(text), '记忆关闭时不应标 id=');
      assert.ok(parts.some((p) => p.type === 'image'), '记忆关闭时照常送图');
    } finally {
      await off.close();
    }
    const imagesOff = await bridgeHarness({
      config: { socialV2: { sticker: { enabled: true, memory: { enabled: true, applyToImages: false } }, hotTrends: { enabled: false } } }
    });
    try {
      const imageParts = await imagesOff.resolveMediaList([{ kind: 'image', file: 'fixture-image.png', url: '', subType: '0', summary: '' }]);
      const imageText = imageParts.find((p) => p.type === 'text')?.text ?? '';
      assert.ok(!/id=[0-9a-f]{12}/.test(imageText), 'applyToImages=false 时普通图片不应标 id=');
      const stickerParts = await imagesOff.resolveMediaList(STICKER);
      const stickerText = stickerParts.find((p) => p.type === 'text')?.text ?? '';
      assert.match(stickerText, /id=[0-9a-f]{12}/, '表情仍然标 id=');
    } finally {
      await imagesOff.close();
    }
  });
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
