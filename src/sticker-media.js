// 表情/梗图的字节校验、尺寸解析与本地缓存。
//
// 为什么单独一层：
// - 图床 404 经常返回 HTML（梗鲸实测 27KB 错误页），只嗅探魔数还不够；
// - QQ 对“图片炸弹”敏感，发送前要知道宽高/像素；
// - 把图落盘后可以传 file://，避免每次几 MB 的 base64 走 HTTP。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function mimeFromBuffer(buf) {
  if (!buf || buf.length < 12) return '';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
  return '';
}

export function looksLikeHtml(buf) {
  if (!buf || !buf.length) return false;
  const head = buf.subarray(0, Math.min(buf.length, 512)).toString('utf8').trimStart().toLowerCase();
  return head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml') || head.includes('<head>');
}

export function sniffImageSize(buf) {
  if (!buf || buf.length < 24) return null;
  try {
    // PNG
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), type: 'image/png' };
    }
    // GIF
    const sig = buf.toString('ascii', 0, 6);
    if (sig === 'GIF87a' || sig === 'GIF89a') {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), type: 'image/gif' };
    }
    // JPEG：扫描 SOF 段
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let off = 2;
      while (off + 9 < buf.length) {
        if (buf[off] !== 0xff) { off += 1; continue; }
        const marker = buf[off + 1];
        if (marker === 0xd8 || marker === 0xd9) { off += 2; continue; }
        const len = buf.readUInt16BE(off + 2);
        if (len < 2 || off + 2 + len > buf.length) break;
        if ((marker >= 0xc0 && marker <= 0xc3)
          || (marker >= 0xc5 && marker <= 0xc7)
          || (marker >= 0xc9 && marker <= 0xcb)
          || (marker >= 0xcd && marker <= 0xcf)) {
          return { width: buf.readUInt16BE(off + 7), height: buf.readUInt16BE(off + 5), type: 'image/jpeg' };
        }
        off += 2 + len;
      }
      return null;
    }
    // WebP
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const chunk = buf.toString('ascii', 12, 16);
      if (chunk === 'VP8X') {
        return {
          width: 1 + buf.readUIntLE(24, 3),
          height: 1 + buf.readUIntLE(27, 3),
          type: 'image/webp'
        };
      }
      if (chunk === 'VP8L') {
        const b1 = buf[21];
        const b2 = buf[22];
        const b3 = buf[23];
        const b4 = buf[24];
        return {
          width: 1 + (((b2 & 0x3f) << 8) | b1),
          height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)),
          type: 'image/webp'
        };
      }
      if (chunk === 'VP8 ') {
        return {
          width: buf.readUInt16LE(26) & 0x3fff,
          height: buf.readUInt16LE(28) & 0x3fff,
          type: 'image/webp'
        };
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function validateImageBuffer(buf, {
  maxBytes = 8 * 1024 * 1024,
  maxPixels = 64_000_000,
  minSide = 24,
  label = '图片'
} = {}) {
  if (!buf || !buf.length) throw new Error(`${label}为空`);
  if (buf.length > maxBytes) throw new Error(`${label}过大（${buf.length} 字节）`);
  if (looksLikeHtml(buf)) throw new Error(`${label}是网页而不是图片（可能是图床错误页）`);
  const mime = mimeFromBuffer(buf);
  if (!mime) throw new Error(`${label}格式不支持（只支持 PNG/JPEG/GIF/WebP）`);
  const size = sniffImageSize(buf);
  if (!size || !size.width || !size.height) throw new Error(`${label}尺寸无法识别`);
  if (size.width < minSide || size.height < minSide) {
    throw new Error(`${label}太小（${size.width}x${size.height}，短边至少 ${minSide}）`);
  }
  if (size.width * size.height > maxPixels) {
    throw new Error(`${label}像素过多（${size.width}x${size.height}）`);
  }
  return { mime, width: size.width, height: size.height, bytes: buf.length };
}

export function extForMime(mime) {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/gif') return 'gif';
  if (mime === 'image/webp') return 'webp';
  return 'jpg';
}

export function imageHash(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// 返回落盘路径；内容相同则复用已有文件。
export function cacheImage(cacheDir, buf, mime) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const hash = imageHash(buf);
  const file = path.join(cacheDir, `${hash}.${extForMime(mime)}`);
  try {
    const st = fs.statSync(file);
    if (st.size === buf.length) return { path: file, hash, reused: true };
  } catch {}
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, buf, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
  return { path: file, hash, reused: false };
}

export function sweepCache(cacheDir, maxAgeMs = 48 * 60 * 60 * 1000, now = Date.now()) {
  let removed = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(cacheDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = path.join(cacheDir, entry.name);
    try {
      const st = fs.statSync(file);
      if (now - st.mtimeMs > maxAgeMs) {
        fs.unlinkSync(file);
        removed += 1;
      }
    } catch {}
  }
  return removed;
}

export function toFileUrl(file) {
  return pathToFileURL(path.resolve(file)).href;
}
