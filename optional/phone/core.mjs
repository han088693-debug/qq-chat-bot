// Derived from AI Companion Kit packages/phone-mcp (24a9a0c + local modifications).
// Copyright (c) 2026 AI Companion Kit contributors. MIT: LICENSE.ai-companion-kit.
// This is a reduced, adapted module, not an unchanged mirror of that project.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

const exec = promisify(execFile);
const id = z.union([
  z.string().regex(/^[1-9]\d{0,15}$/).refine((value) => Number.isSafeInteger(Number(value)), '账号必须是安全范围内的整数'),
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
]);
const coordinate = z.number().int().min(0).max(10000);
const textResult = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const plain = (value) => String(value ?? '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ').trim();
function listFrom(data) {
  const list = Array.isArray(data) ? data : (data?.msglist ?? data?.list ?? data?.feeds);
  if (!Array.isArray(list)) throw new Error('网关返回了不支持的动态列表格式；无法据此判断空间是否为空');
  return list;
}
const quote = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'";

export function loopbackUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Qzone baseUrl 必须是有效的本机 HTTP 地址'); }
  if (!['http:', 'https:'].includes(url.protocol)
      || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Qzone baseUrl 仅允许不带凭据、路径或查询参数的环回 HTTP 地址');
  }
  return url.origin;
}

function imageFiles(inputs, roots) {
  if (!inputs?.length) return [];
  const allowed = roots.map((root) => {
    if (!path.isAbsolute(root)) throw new Error('qzone.imageDirs 必须使用绝对路径');
    try { return fs.realpathSync(root); } catch { throw new Error('无法读取 qzone.imageDirs 中的目录'); }
  });
  return inputs.map((input) => {
    if (/^[a-z]+:\/\//i.test(input)) throw new Error('配图只接受允许目录内的本地图片，不接受 URL');
    const candidates = path.isAbsolute(input) ? [input] : allowed.map((root) => path.join(root, input));
    for (const candidate of candidates) {
      let file;
      try { file = fs.realpathSync(candidate); } catch { continue; }
      if (!allowed.some((root) => {
        const rel = path.relative(root, file);
        return rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
      })) continue;
      let stat;
      let bytes;
      try { stat = fs.statSync(file); } catch { throw new Error('无法读取配图文件'); }
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error('配图必须是 8 MB 以内的图片文件');
      try { bytes = fs.readFileSync(file); } catch { throw new Error('无法读取配图文件'); }
      const png = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
      const jpg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
      const gif = /^GIF8[79]a/.test(bytes.subarray(0, 6).toString());
      const webp = bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
      if (!png && !jpg && !gif && !webp) throw new Error('配图内容不是支持的 PNG/JPEG/GIF/WebP 图片');
      return file;
    }
    throw new Error('配图不在 qzone.imageDirs 允许范围内或文件不存在');
  });
}

function parseUi(xml) {
  const nodes = [];
  for (const match of String(xml).matchAll(/<node\b([^>]*?)(?:\/>|>)/g)) {
    const attrs = Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], plain(m[2])]));
    const bounds = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(attrs.bounds ?? '');
    if (!bounds) continue;
    const [, x1, y1, x2, y2] = bounds.map(Number);
    nodes.push({ text: attrs.text ?? '', description: attrs['content-desc'] ?? '',
      clickable: attrs.clickable === 'true', x: Math.floor((x1 + x2) / 2), y: Math.floor((y1 + y2) / 2) });
    if (nodes.length === 200) break;
  }
  return nodes;
}

export function createPhoneTools(config, {
  fetchImpl = globalThis.fetch, run = exec, now = Date.now, env = process.env, readBridgeConfig = () => ({}),
} = {}) {
  const qzone = config.phone?.qzone ?? {};
  const android = config.phone?.android ?? {};
  const definitions = [];
  const hits = { write: [], comment: [], visit: [] };
  function budget(kind) {
    const time = now();
    hits[kind] = hits[kind].filter((at) => time - at < 86400000);
    const [window, maximum, daily] = { write: [60000, 1, 8], comment: [600000, 1, 3], visit: [180000, 5, 40] }[kind];
    if (hits[kind].length >= daily || hits[kind].filter((at) => time - at < window).length >= maximum) {
      throw new Error('该类 QQ 空间操作已达到本进程频率上限，请稍后再试');
    }
    hits[kind].push(time);
  }
  function add(name, description, shape, readOnly, handler) {
    const schema = z.object(shape).strict();
    definitions.push({ name, description, schema, annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly },
      invoke: async (input = {}) => {
        const args = schema.parse(input);
        return handler(args);
      } });
  }
  async function onebot(action, payload = {}) {
    let bridge = {};
    try { bridge = readBridgeConfig()?.snowluma ?? {}; } catch {}
    const base = loopbackUrl(qzone.baseUrl || bridge.httpUrl || 'http://127.0.0.1:3000');
    const envName = qzone.accessTokenEnv || 'SNOWLUMA_ACCESS_TOKEN';
    const token = String(env[envName] || bridge.accessToken || '').trim();
    if (!token) throw new Error('未配置 SnowLuma HTTP 访问令牌；请设置指定环境变量或根 config.json');
    let response;
    try {
      response = await fetchImpl(`${base}/${action}`, { method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) });
    } catch { throw new Error('SnowLuma HTTP 请求失败；请检查本机服务地址与连接'); }
    let result;
    try { result = await response.json(); } catch { throw new Error('SnowLuma 返回了非 JSON 响应'); }
    if (!response.ok || result?.status !== 'ok' || (result.retcode != null && result.retcode !== 0)) {
      throw new Error('SnowLuma 拒绝了请求；请在本机检查 HTTP 令牌、空间权限与网关接口支持');
    }
    return result.data;
  }
  function rows(data, limit) {
    const list = listFrom(data);
    return list.slice(0, limit).map((item) => ({
      tid: String(item.tid ?? item.key ?? item.id ?? ''),
      uin: String(item.uin ?? item.user_id ?? ''), nickname: String(item.nickname ?? item.name ?? ''),
      text: plain(item.content ?? item.summary ?? item.html ?? item.text).slice(0, 2000),
      time: item.abstime ?? item.time ?? null,
    }));
  }
  const target = (value) => value === undefined ? {} : { target_uin: Number(value) };
  if (qzone.enabled === true) {
    loopbackUrl(qzone.baseUrl || 'http://127.0.0.1:3000');
    add('qzone_feeds', '按需读取 QQ 空间好友动态，不会自动巡逻或互动。', {
      count: z.number().int().min(1).max(20).default(8), page: z.number().int().min(1).max(5).default(1),
    }, true, async ({ count, page }) => textResult({ items: rows(await onebot('get_qzone_feeds', { page_num: page, count }), count) }));
    add('qzone_my_posts', '读取当前登录账号自己的 QQ 空间说说。', {
      num: z.number().int().min(1).max(20).default(5),
    }, true, async ({ num }) => textResult({ items: rows(await onebot('get_qzone_msg_list', { num }), num) }));
    add('qzone_user_posts', '读取指定账号可见的 QQ 空间说说；尊重对方空间权限。', {
      targetUin: id, num: z.number().int().min(1).max(20).default(5),
    }, true, async ({ targetUin, num }) => {
      budget('visit');
      return textResult({ items: rows(await onebot('get_qzone_msg_list', { ...target(targetUin), num }), num) });
    });
    if (qzone.allowWrites === true) {
      add('qzone_post', '发布 QQ 空间说说；只在用户要求或明确授权的范围内使用。', {
        content: z.string().trim().min(1).max(2000), images: z.array(z.string().min(1).max(1024)).max(9).optional(),
      }, false, async ({ content, images }) => {
        const files = imageFiles(images, qzone.imageDirs ?? []);
        budget('write');
        const result = await onebot('send_qzone_msg', { content, ...(files.length ? { images: files } : {}) });
        return textResult({ ok: true, action: 'posted', tid: result?.tid ?? result?.id ?? null });
      });
      add('qzone_like', '给指定说说点赞；tid 和账号应来自刚读取的动态。', {
        tid: z.string().min(1).max(200), targetUin: id.optional(), abstime: z.number().int().nonnegative().optional(),
      }, false, async ({ tid, targetUin, abstime }) => {
        budget('write');
        await onebot('like_qzone', { tid, ...target(targetUin), ...(abstime === undefined ? {} : { abstime }) });
        return textResult({ ok: true, action: 'liked', tid });
      });
      add('qzone_comment', '评论指定说说；需要用户授权，提交后不会自动撤销。', {
        tid: z.string().min(1).max(200), content: z.string().trim().min(1).max(500), targetUin: id.optional(),
      }, false, async ({ tid, content, targetUin }) => {
        budget('comment');
        await onebot('comment_qzone', { tid, content, ...target(targetUin) });
        return textResult({ ok: true, action: 'commented', tid });
      });
      add('qzone_recent_like', '给最新一条动态点赞，可按完整昵称或账号精确筛选；可选评论。', {
        who: z.string().trim().min(1).max(100).optional(), comment: z.string().trim().min(1).max(500).optional(),
      }, false, async ({ who, comment }) => {
        const list = rows(await onebot('get_qzone_feeds', { page_num: 1, count: 20 }), 20);
        const found = who ? list.filter((item) => item.nickname === who || item.uin === who) : list;
        if (!found.length) throw new Error('最近动态里没有匹配项；请先读取动态并确认目标');
        if (who && new Set(found.map((item) => item.uin)).size > 1) throw new Error('昵称对应多个账号，请改用明确账号');
        const item = found[0];
        if (!item.tid) throw new Error('该动态缺少 tid，未执行点赞');
        const targetUin = item.uin ? id.parse(item.uin) : undefined;
        budget('write');
        if (comment) budget('comment');
        const abstime = Number(item.time);
        await onebot('like_qzone', { tid: item.tid, ...target(targetUin),
          ...(Number.isSafeInteger(abstime) && abstime > 0 ? { abstime } : {}) });
        if (comment) {
          try { await onebot('comment_qzone', { tid: item.tid, content: comment, ...target(targetUin) }); }
          catch { return textResult({ ok: false, liked: true, commented: false, tid: item.tid, note: '点赞成功，但评论未确认；不要自动重试' }); }
        }
        return textResult({ ok: true, liked: true, commented: Boolean(comment), tid: item.tid });
      });
    }
  }
  async function adb(args, binary = false) {
    const serial = String(android.serial ?? '').trim();
    if (!serial || serial.startsWith('-') || /[\s\x00-\x1f]/.test(serial)) {
      throw new Error('请先在 android.serial 显式指定一个已授权设备，不会自动选择设备');
    }
    try {
      const result = await run(android.adbPath || 'adb', ['-s', serial, ...args],
        { timeout: 15000, maxBuffer: 12 * 1024 * 1024, encoding: binary ? 'buffer' : 'utf8', windowsHide: true });
      return result.stdout;
    } catch { throw new Error('ADB 操作失败；请在本机检查 adb、设备连接和调试授权'); }
  }
  const ui = async () => parseUi(await adb(['shell', 'uiautomator', 'dump', '/dev/tty']));
  const control = async (args) => { await adb(args); return textResult({ ok: true, action: 'command_completed' }); };
  if (android.enabled === true) {
    add('phone_status', '检查配置中指定的 Android 设备连接，不枚举其他设备。', {}, true,
      async () => textResult({ state: String(await adb(['get-state'])).trim() === 'device' ? 'connected' : 'not_ready' }));
    add('phone_screenshot', '读取指定 Android 设备当前屏幕；截图只通过本次工具返回，不保存到仓库。', {}, true,
      async () => {
        const bytes = Buffer.from(await adb(['exec-out', 'screencap', '-p'], true));
        if (!bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new Error('设备没有返回 PNG 截图');
        return { content: [{ type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' }] };
      });
    add('phone_dump', '读取当前 Android 界面的文本、可点击元素和坐标。', {}, true,
      async () => textResult({ nodes: await ui() }));
    if (android.allowControl === true) {
      add('phone_tap', '点击刚查看的界面坐标。', { x: coordinate, y: coordinate }, false,
        ({ x, y }) => control(['shell', 'input', 'tap', String(x), String(y)]));
      add('phone_tap_text', '按完整界面文字或描述点击；多处匹配时拒绝猜测。', { text: z.string().min(1).max(200) }, false,
        async ({ text }) => {
          const matches = (await ui()).filter((item) => item.text === text || item.description === text);
          if (matches.length !== 1) throw new Error('界面文字未唯一匹配，请重新查看并选择明确坐标');
          return control(['shell', 'input', 'tap', String(matches[0].x), String(matches[0].y)]);
        });
      add('phone_swipe', '在已查看的界面滑动。', {
        x1: coordinate, y1: coordinate, x2: coordinate, y2: coordinate, ms: z.number().int().min(100).max(2000).default(300),
      }, false, ({ x1, y1, x2, y2, ms }) => control(['shell', 'input', 'swipe', ...[x1, y1, x2, y2, ms].map(String)]));
      add('phone_key', '按返回、主页等固定 Android 按键。', {
        key: z.enum(['back', 'home', 'enter', 'recent', 'delete', 'volume_up', 'volume_down']),
      }, false, ({ key }) => control(['shell', 'input', 'keyevent', String({
        back: 4, home: 3, enter: 66, recent: 187, delete: 67, volume_up: 24, volume_down: 25,
      }[key])]));
      add('phone_open_app', '启动指定 Android 应用包名，不安装应用或接受任意命令。', {
        packageName: z.string().regex(/^[A-Za-z]\w*(?:\.[A-Za-z]\w*)+$/).max(200),
      }, false, ({ packageName }) => control(['shell', 'monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1']));
      add('phone_text', '在已确认的输入框输入文本；中文需要手动启用 ADBKeyboard。', {
        text: z.string().min(1).max(1000),
      }, false, async ({ text }) => {
        if (/^[\x20-\x7e]+$/.test(text)) {
          return control(['shell', `input text ${quote(text.replaceAll(' ', '%s'))}`]);
        }
        const ime = String(await adb(['shell', 'settings', 'get', 'secure', 'default_input_method'])).trim();
        if (!/^com\.android\.adbkeyboard\//.test(ime)) throw new Error('中文输入需要先在设备上手动启用 ADBKeyboard 输入法');
        return control(['shell', 'am', 'broadcast', '-a', 'ADB_INPUT_B64', '--es', 'msg', Buffer.from(text).toString('base64')]);
      });
    }
  }
  return definitions;
}
