// 发图工具的文件白名单/魔数/大小离线回归；不联网、不发 QQ。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { detectImageMime, isImageExt, resolveImageFile, listImageFiles } from '../src/image-send-lib.js';

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(16, 1)]);
const JPEG = Buffer.concat([Buffer.from('ffd8ffe000104a464946', 'hex'), Buffer.alloc(16, 2)]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(16, 3)]);
const WEBP = Buffer.concat([Buffer.from('524946460000000057454250', 'hex'), Buffer.alloc(16, 4)]);

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-image-'));
  const allow = path.join(root, 'images');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(allow, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(allow, 'a.png'), PNG);
  fs.writeFileSync(path.join(allow, 'b.jpg'), JPEG);
  fs.writeFileSync(path.join(allow, 'c.gif'), GIF);
  fs.writeFileSync(path.join(allow, 'd.webp'), WEBP);
  fs.writeFileSync(path.join(allow, 'note.txt'), 'hello');
  fs.writeFileSync(path.join(allow, 'fake.png'), Buffer.from('not an image at all!!', 'utf8'));
  fs.writeFileSync(path.join(outside, 'secret.png'), PNG);
  return { root, allow, outside };
}

test('魔数与扩展名识别', () => {
  assert.equal(detectImageMime(PNG), 'image/png');
  assert.equal(detectImageMime(JPEG), 'image/jpeg');
  assert.equal(detectImageMime(GIF), 'image/gif');
  assert.equal(detectImageMime(WEBP), 'image/webp');
  assert.equal(detectImageMime(Buffer.from('nope')), '');
  assert.equal(isImageExt('x.PNG'), true);
  assert.equal(isImageExt('x.txt'), false);
});

test('相对文件名在允许目录内可解析', () => {
  const { allow } = setup();
  const png = resolveImageFile([allow], 'a.png');
  assert.equal(png.mimeType, 'image/png');
  assert.equal(png.bytes, PNG.length);
  const jpg = resolveImageFile([allow], 'b.jpg');
  assert.equal(jpg.mimeType, 'image/jpeg');
});

test('绝对路径必须在允许目录内', () => {
  const { allow, outside } = setup();
  assert.equal(resolveImageFile([allow], path.join(allow, 'a.png')).name, 'a.png');
  assert.throws(() => resolveImageFile([allow], path.join(outside, 'secret.png')), /允许目录|不存在/);
  assert.throws(() => resolveImageFile([allow], '../outside/secret.png'), /允许目录|不存在/);
});

test('非图片、伪装图片、超大文件被拒绝', () => {
  const { allow } = setup();
  assert.throws(() => resolveImageFile([allow], 'note.txt'), /只允许|不存在/);
  assert.throws(() => resolveImageFile([allow], 'fake.png'), /不是有效图片/);
  assert.throws(() => resolveImageFile([allow], 'a.png', { maxBytes: 10 }), /过大/);
  assert.throws(() => resolveImageFile([], 'a.png'), /没有可用的图片目录/);
});

test('列出允许目录里的图片（不含 txt），并限制数量', () => {
  const { allow } = setup();
  const all = listImageFiles([allow], { maxFiles: 100 });
  assert.deepEqual(all.files.map((f) => f.name).sort(), ['a.png', 'b.jpg', 'c.gif', 'd.webp']);
  assert.equal(all.dirs.length, 1);
  const limited = listImageFiles([allow], { maxFiles: 2 });
  assert.equal(limited.files.length, 2);
  assert.ok(limited.files.every((f) => /\.(png|jpe?g|gif|webp)$/i.test(f.name)));
});
