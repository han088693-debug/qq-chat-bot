// 发图工具的文件解析与白名单（纯函数 + 同步文件操作，便于离线测试）。
//
// 安全边界：
// - 只允许 socialV2.image.allowDirs 里的文件；相对名会在每个允许目录里查找；
// - 绝对路径必须落在允许目录内（realpath 之后再比较，防符号链接/.. 逃逸）；
// - 只接受 png/jpeg/gif/webp 且按魔数校验，扩展名只用于筛选候选；
// - 超过 maxBytes 直接拒绝，避免把大文件塞进 OneBot / 模型上下文。
import fs from 'node:fs';
import path from 'node:path';

export const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

export function isImageExt(file) {
  return IMAGE_EXTS.has(path.extname(String(file ?? '')).toLowerCase());
}

/** 按魔数识别图片 MIME；识别不出返回空字符串。 */
export function detectImageMime(buffer) {
  const b = buffer;
  if (!b || b.length < 12) return '';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.toString('ascii', 0, 6) === 'GIF87a' || b.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
      && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return '';
}

function realDirectory(dir) {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 归一化允许目录：去重、只保留存在的目录。 */
export function allowedImageDirs(allowDirs) {
  const list = Array.isArray(allowDirs) ? allowDirs : [];
  const out = [];
  for (const raw of list) {
    const dir = String(raw ?? '').trim();
    if (!dir) continue;
    const real = realDirectory(dir);
    try {
      if (!fs.statSync(real).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!out.includes(real)) out.push(real);
  }
  return out;
}

/**
 * 解析并读取一张允许发送的图片。
 * @param {string|string[]} allowDirs
 * @param {string} requested 文件名或绝对路径
 * @param {{maxBytes?:number}} [options]
 * @returns {{name:string,path:string,buffer:Buffer,bytes:number,mimeType:string}}
 */
export function resolveImageFile(allowDirs, requested, options = {}) {
  const maxBytes = Math.max(1, Number(options.maxBytes) || 8 * 1024 * 1024);
  const name = String(requested ?? '').trim();
  if (!name) throw new Error('图片路径不能为空');
  const dirs = allowedImageDirs(allowDirs);
  if (!dirs.length) throw new Error('没有可用的图片目录（socialV2.image.allowDirs 未配置或目录不存在）');
  const candidates = [];
  if (path.isAbsolute(name)) {
    candidates.push(path.resolve(name));
  } else {
    for (const dir of dirs) candidates.push(path.join(dir, name));
  }
  let target = null;
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) { target = candidate; break; }
    } catch { /* 换下一个目录 */ }
  }
  if (!target) throw new Error('图片不存在，或不在允许目录内');
  const real = fs.realpathSync(target);
  const allowed = dirs.some((dir) => isInside(dir, real));
  if (!allowed) throw new Error('图片不在允许目录内（socialV2.image.allowDirs）');
  if (!isImageExt(real)) throw new Error('只允许发送 png/jpg/jpeg/gif/webp 图片');
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw new Error('目标不是文件');
  if (stat.size <= 0) throw new Error('图片为空');
  if (stat.size > maxBytes) throw new Error(`图片过大（${stat.size} > ${maxBytes} 字节）`);
  const buffer = fs.readFileSync(real);
  const mimeType = detectImageMime(buffer);
  if (!mimeType) throw new Error('文件内容不是有效图片（按魔数校验失败）');
  return { name: path.basename(real), path: real, buffer, bytes: buffer.length, mimeType };
}

/**
 * 列出允许目录里的图片（只读，浅层，不递归）。
 * @param {string|string[]} allowDirs
 * @param {{maxFiles?:number}} [options]
 * @returns {{dirs:string[], files:Array<{name:string,dir:string,bytes:number,mtimeMs:number}>}}
 */
export function listImageFiles(allowDirs, options = {}) {
  const maxFiles = Math.min(500, Math.max(1, Math.round(Number(options.maxFiles) || 100)));
  const dirs = allowedImageDirs(allowDirs);
  const files = [];
  for (const dir of dirs) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !isImageExt(entry.name)) continue;
      const file = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(file);
        // 按魔数抽检文件头，避免把 .png 的文本/损坏文件列给模型。
        const fd = fs.openSync(file, 'r');
        const head = Buffer.alloc(12);
        const read = fs.readSync(fd, head, 0, 12, 0);
        fs.closeSync(fd);
        if (!detectImageMime(head.subarray(0, read))) continue;
        files.push({ name: entry.name, dir: path.basename(dir), bytes: stat.size, mtimeMs: stat.mtimeMs });
      } catch { /* 文件刚被删除/读不了，跳过 */ }
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { dirs: dirs.map((dir) => path.basename(dir)), files: files.slice(0, maxFiles) };
}
