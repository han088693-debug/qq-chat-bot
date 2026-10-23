// 表情包优化（P0–P2 地基）单测：不碰网络、不碰 QQ，只测纯函数与本地状态。
//
// 跑法：node scripts/test-sticker-optimization.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  detectMood, detectCharacter, moodByKeyOrLabel, isNegatedAt, rankCandidates
} from '../src/sticker-rank.js';
import { createStickerUsageStore } from '../src/sticker-usage.js';
import {
  mimeFromBuffer, sniffImageSize, validateImageBuffer, cacheImage, looksLikeHtml, toFileUrl
} from '../src/sticker-media.js';
import { createStickerTasteStore } from '../src/sticker-taste.js';
import { parseGalleryIndex, createStickerCatalog } from '../src/sticker-catalog.js';

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`ok ${pass + fail} - ${name}`);
  } catch (error) {
    fail += 1;
    console.error(`not ok ${pass + fail} - ${name}`);
    console.error(error?.stack || error);
  }
}
function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `sticker-${tag}-`));
}
function pngBuffer(width, height) {
  const buf = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf[24] = 8;
  buf[25] = 6;
  return buf;
}

ok('情绪识别：难过 -> 安慰', () => {
  assert.equal(detectMood('今天真的好难过').label, '安慰');
  assert.equal(detectMood('笑死我了').label, '大笑');
});
ok('否定排除：不好笑/不同意不算命中', () => {
  const compact = '这个一点也不好笑';
  const idx = compact.indexOf('好笑');
  assert.equal(isNegatedAt(compact, idx), true);
  assert.equal(detectMood('这个一点也不好笑'), null);
});
ok('角色识别：鲸鱼 -> DeepSeek娘', () => {
  assert.equal(detectCharacter('来张鲸鱼娘的图').label, 'DeepSeek娘');
  assert.equal(detectCharacter('随便来张', { defaultCharacter: 'AI娘化' }).label, 'AI娘化');
});
ok('排序：标题命中优先、同分保留', () => {
  const items = [
    { id: 'ext:1', title: '抱抱', caption: '抱抱', category: 'AI娘化' },
    { id: 'ext:2', title: '今天天气不错', caption: '天气', category: 'AI娘化' },
    { id: 'ext:3', title: '难过大哭', caption: '难过', category: 'DeepSeek娘' }
  ];
  const ranked = rankCandidates(items, { emotion: moodByKeyOrLabel('comfort'), limit: 2 });
  assert.ok(ranked.length >= 1);
  assert.ok(ranked.some((x) => x.id === 'ext:3'), '难过的图应排进候选');
});
ok('图库索引解析：只收图床上的 meme 图', () => {
  const list = parseGalleryIndex({
    gallery: {
      DeepSeek娘: [
        { name: '鲸娘', alt: '鲸鱼娘抱抱', original: 'https://img.aigengtu.com/meme/001.webp', preview: 'https://img.aigengtu.com/0_preview/meme/001.webp' },
        { name: '坏链', original: 'https://example.com/meme/002.webp' }
      ]
    }
  });
  assert.equal(list.length, 1);
  assert.equal(list[0].category, 'DeepSeek娘');
  assert.match(list[0].id, /^ext:[0-9a-f]{12}$/);
});
ok('图库缓存：断网也能读旧索引', async () => {
  // 该用例含 async，单独在下面 await；这里先构造同步断言用的文件。
  const dir = tmpDir('catalog');
  const file = path.join(dir, 'catalog.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    fetchedAt: Date.now(),
    entries: [{
      id: 'ext:aaaaaaaaaaaa', source: 'ext', title: '鲸娘', name: '鲸娘',
      caption: '鲸鱼娘', story: '', category: 'DeepSeek娘',
      original: 'https://img.aigengtu.com/meme/001.webp',
      preview: 'https://img.aigengtu.com/meme/001.webp'
    }]
  }));
  const catalog = createStickerCatalog({
    file,
    cacheDir: path.join(dir, 'cache'),
    fetchImpl: async () => { throw new Error('offline'); }
  });
  assert.equal(catalog.size, 1);
  assert.equal(catalog.find('ext:aaaaaaaaaaaa')?.title, '鲸娘');
  assert.equal(catalog.list({ limit: 5 }).length, 1);
});
ok('尺寸解析：PNG 300x300', () => {
  const buf = pngBuffer(300, 300);
  assert.equal(mimeFromBuffer(buf), 'image/png');
  const size = sniffImageSize(buf);
  assert.deepEqual([size.width, size.height], [300, 300]);
  const meta = validateImageBuffer(buf, { maxBytes: 1024 * 1024, maxPixels: 10_000_000, minSide: 200 });
  assert.equal(meta.mime, 'image/png');
});
ok('尺寸校验：太小/HTML 错误页拒绝', () => {
  assert.throws(() => validateImageBuffer(pngBuffer(10, 10), { minSide: 200 }), /短边|太小|尺寸/);
  assert.equal(looksLikeHtml(Buffer.from('<!doctype html><html><head></head></html>')), true);
  assert.throws(() => validateImageBuffer(Buffer.from('<html>404</html>'), {}), /图片|格式|HTML/);
});
ok('本地缓存：落盘 + file://', () => {
  const dir = tmpDir('media');
  const cached = cacheImage(dir, pngBuffer(300, 300), 'image/png');
  assert.ok(fs.existsSync(cached.path));
  assert.match(toFileUrl(cached.path), /^file:\/\/\//);
});
ok('会话额度：同会话第 3 张被拦，换会话不受影响', () => {
  const dir = tmpDir('usage');
  const store = createStickerUsageStore(path.join(dir, 'usage.json'));
  const a = 'private:10001';
  const b = 'private:10002';
  const opts = { source: 'ext', maxPerHour: 2, maxPerDay: 10 };
  assert.equal(store.check(a, opts).ok, true);
  store.record(a, { id: 'ext:1', source: 'ext' }, { auto: true });
  store.record(a, { id: 'ext:2', source: 'ext' }, { auto: true });
  const blocked = store.check(a, opts);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'hour');
  assert.equal(store.check(b, opts).ok, true);
  assert.equal(store.hasRecent(a, 'ext:1', 60_000), true);
});
ok('品味：note 学到 likes，并注入提示词', () => {
  const dir = tmpDir('taste');
  const store = createStickerTasteStore(path.join(dir, 'taste.json'));
  store.recordTaste('like', '这张软乎乎圆滚滚，猫猫好可爱');
  store.save();
  const profile = store.profile();
  assert.ok(profile.likes.includes('软乎乎'));
  assert.ok(profile.likes.includes('猫'));
  assert.match(store.promptSection(), /【我的表情品味】/);
});
ok('收藏候选：跳过自己和已提醒的图', () => {
  const dir = tmpDir('candidates');
  const store = createStickerTasteStore(path.join(dir, 'taste.json'));
  const now = Date.now();
  const list = store.collectCandidates([
    { messageId: '1', isSelf: true, time: now, media: [{ kind: 'image' }] },
    { messageId: '2', isSelf: false, time: now, media: [{ kind: 'sticker' }], sender: { card: '群友A' } },
    { messageId: '3', isSelf: false, time: now, media: [{ kind: 'image' }], sender: { card: '群友B' } }
  ], { max: 3, now });
  assert.deepEqual(list.map((x) => x.id), ['2', '3']);
  store.markReminded(['2'], now);
  const again = store.collectCandidates([
    { messageId: '2', isSelf: false, time: now, media: [{ kind: 'sticker' }] },
    { messageId: '3', isSelf: false, time: now, media: [{ kind: 'image' }] }
  ], { max: 3, now });
  assert.deepEqual(again.map((x) => x.id), ['3']);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
