// qq-bridge 插件宿主（Bridge 侧插件层）
//
// 存在理由：bridge.js 已 13,800 行、逻辑几乎全在 main() 里，startConsoleServer()
// 一个函数就占 4,500 行 / 146 个 /api 路由。想拆功能时缺的不是代码，是「挂点」——
// 拆出来的模块没有地方注册（证据：src/core/session-router.mjs 写完 28KB+16KB 测试，
// bridge.js 一次都没 import 过）。这个宿主就是那个挂点。
//
// 四条设计约束，改之前先看：
//  1. 加载失败绝不影响桥接：import / 校验 / hook 的任何异常都只记日志，宿主继续跑。
//  2. 插件路由默认**只对控制台开放**：分发点挂在 bridge.js 的 x-agent-token 白名单之后，
//     带会话令牌的 AI 调用在到达插件之前就被 403 了。要放开必须改白名单并显式声明 surface。
//  3. 状态分片：新插件用 state/plugins/<id>/；老插件可以继续读写 state/ 下的平铺文件
//     （ctx.state.json('reminders.json')）。迁移是渐进的，不强制搬家 —— 因为正在跑的
//     桥接进程还在用那些平铺文件。
//  4. 宿主不 import bridge.js，只认 ctx.services 里显式传进来的东西，所以可以在
//     没有桥接的环境里单独测（见 scripts/test-plugin-host.mjs）。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ID_RE = /^[a-z][a-z0-9-]{1,30}$/;
const METHODS = new Set(['GET', 'POST']);
const SURFACES = new Set(['console', 'agent', 'both']);
const PLUGIN_FILES = ['plugin.mjs', 'index.mjs'];

function asNameList(value, field, id) {
  if (value === undefined || value === null) return Object.freeze([]);
  if (!Array.isArray(value)) throw new Error(`插件 ${id} 的 ${field} 必须是字符串数组`);
  return Object.freeze(value.map((v) => {
    const s = String(v ?? '').trim();
    if (!s) throw new Error(`插件 ${id} 的 ${field} 里有空项`);
    return s;
  }));
}

/** 把一个插件定义校验并冻结。校验刻意写死：插件是往 24/7 进程里塞代码，宁可启动时报错。 */
export function definePlugin(def) {
  if (!def || typeof def !== 'object') throw new Error('插件定义必须是对象');
  const id = String(def.id ?? '');
  if (!ID_RE.test(id)) throw new Error(`插件 id 不合法：${id || '(空)'}（要求 ${ID_RE}）`);
  const surface = String(def.surface ?? 'console');
  if (!SURFACES.has(surface)) throw new Error(`插件 ${id} 的 surface 不合法：${surface}（可选 ${[...SURFACES].join('/')}）`);

  const seen = new Set();
  const routes = (Array.isArray(def.routes) ? def.routes : []).map((route, i) => {
    const method = String(route?.method ?? '').toUpperCase();
    if (!METHODS.has(method)) throw new Error(`插件 ${id} 路由#${i} 的 method 不合法：${route?.method}`);
    const p = String(route?.path ?? '');
    if (!p.startsWith('/') || p.includes('..') || p.includes('?')) throw new Error(`插件 ${id} 路由#${i} 的 path 不合法：${p}`);
    if (typeof route.handler !== 'function') throw new Error(`插件 ${id} 路由 ${method} ${p} 缺 handler`);
    const signature = `${method} ${p}`;
    if (seen.has(signature)) throw new Error(`插件 ${id} 路由重复：${signature}`);
    seen.add(signature);
    return Object.freeze({ method, path: p, handler: route.handler, description: String(route.description ?? '') });
  });

  const hooks = (def.hooks && typeof def.hooks === 'object') ? { ...def.hooks } : {};
  for (const [name, fn] of Object.entries(hooks)) {
    if (typeof fn !== 'function') throw new Error(`插件 ${id} 的 hooks.${name} 不是函数`);
  }

  return Object.freeze({
    id,
    title: String(def.title ?? id),
    version: String(def.version ?? '0.1.0'),
    description: String(def.description ?? ''),
    surface,
    deps: asNameList(def.deps, 'deps', id),
    needs: asNameList(def.needs, 'needs', id),
    state: asNameList(def.state, 'state', id),
    routes: Object.freeze(routes),
    hooks: Object.freeze(hooks),
  });
}

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * @param {object} options
 * @param {string} options.root         项目根（qq-bridge）
 * @param {string} [options.stateDir]   默认 <root>/state
 * @param {string} [options.pluginsDir] 默认 <root>/src/plugins
 * @param {(msg: string) => void} [options.log]
 * @param {object} [options.services]   显式交给插件的能力（reminderStore / tokenLedger / priceTable …）
 * @param {number} [options.tickMs]     >0 时每 tickMs 调一次 hooks.tick；默认 0（不装定时器）
 */
export async function createPluginHost(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const stateDir = path.resolve(options.stateDir ?? path.join(root, 'state'));
  const pluginsDir = path.resolve(options.pluginsDir ?? path.join(root, 'src', 'plugins'));
  const log = typeof options.log === 'function' ? options.log : () => {};
  const services = (options.services && typeof options.services === 'object') ? options.services : {};
  const tickMs = Math.max(0, Number(options.tickMs) || 0);

  /** @type {Map<string, any>} */
  const entries = new Map();
  const failures = [];
  let timer = null;
  let closed = false;

  const hostLog = (id, message) => {
    try { log(`[插件 ${id}] ${message}`); } catch { /* 日志通道坏了也不能让插件层崩 */ }
  };

  // ── 状态访问 ──────────────────────────────────────────────────────────────
  function stateFor(id) {
    const shardDir = path.join(stateDir, 'plugins', id);
    const api = {
      shardDir,
      /** 分片目录（自动创建）。新插件用它。 */
      dir(name = '') {
        const dir = name ? path.join(shardDir, name) : shardDir;
        fs.mkdirSync(dir, { recursive: true });
        return dir;
      },
      /** 分片目录下的绝对路径（不创建）。 */
      file(rel = '') { return path.join(shardDir, rel); },
      /** state/ 下的平铺路径：给还没搬家的老文件用（reminders.json 这类）。 */
      legacy(rel) { return path.join(stateDir, rel); },
      /** 一个 JSON 存取器。sharded=true 走 state/plugins/<id>/，否则走 state/。 */
      json(rel, { sharded = false } = {}) {
        const file = sharded ? path.join(shardDir, rel) : path.join(stateDir, rel);
        return {
          file,
          read(fallback = null) {
            try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
          },
          write(value) {
            atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
            return file;
          },
        };
      },
    };
    return api;
  }

  // ── 发现与加载 ────────────────────────────────────────────────────────────
  async function discover() {
    let dirents;
    try {
      dirents = fs.readdirSync(pluginsDir, { withFileTypes: true });
    } catch (error) {
      hostLog('-', `插件目录不可读，跳过插件层：${pluginsDir}（${error?.message ?? error}）`);
      return;
    }
    for (const dirent of dirents) {
      if (!dirent.isDirectory()) continue;
      const dir = path.join(pluginsDir, dirent.name);
      const file = PLUGIN_FILES.map((name) => path.join(dir, name)).find((f) => fs.existsSync(f));
      if (!file) continue; // 不是插件目录（README 之类），静默跳过
      try {
        // 带时间戳的 query 是为了让改完的插件不用重启整个桥接就能重新加载（未来 reload 用）。
        const mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
        const def = definePlugin(mod.default ?? mod.plugin);
        if (entries.has(def.id)) throw new Error(`插件 id 与其它插件重复：${def.id}`);
        entries.set(def.id, { def, dir, file, status: 'loaded', error: null, ctx: null });
      } catch (error) {
        const detail = String(error?.stack ?? error?.message ?? error);
        failures.push({ dir: dirent.name, error: detail });
        hostLog(dirent.name, `加载失败（已隔离，不影响其它插件）：${error?.message ?? error}`);
      }
    }
  }

  /** 依赖拓扑：被依赖的先加载。环直接抛，让配置问题在启动时暴露。 */
  function resolveOrder() {
    const order = [];
    const state = new Map(); // id -> 'visiting' | 'done'
    const visit = (id, chain = []) => {
      if (state.get(id) === 'done') return;
      if (state.get(id) === 'visiting') throw new Error(`插件依赖成环：${[...chain, id].join(' -> ')}`);
      const entry = entries.get(id);
      if (!entry) throw new Error(`依赖的插件不存在：${id}`);
      state.set(id, 'visiting');
      for (const dep of entry.def.deps) visit(dep, [...chain, id]);
      state.set(id, 'done');
      order.push(entry);
    };
    for (const id of entries.keys()) visit(id);
    return order;
  }

  function makeContext(def) {
    const missing = def.needs.filter((name) => services[name] === undefined || services[name] === null);
    const ctx = {
      id: def.id,
      root,
      stateDir,
      state: stateFor(def.id),
      log: (message) => hostLog(def.id, typeof message === 'string' ? message : String(message)),
      services: Object.freeze(Object.fromEntries(def.needs
        .filter((name) => !missing.includes(name))
        .map((name) => [name, services[name]]))),
    };
    return { ctx, missing };
  }

  async function boot() {
    await discover();
    let order;
    try {
      order = resolveOrder();
    } catch (error) {
      hostLog('-', `依赖解析失败，本次只加载彼此独立的插件：${error?.message ?? error}`);
      order = [...entries.values()].filter((e) => e.def.deps.length === 0);
    }
    for (const entry of order) {
      const { def } = entry;
      const { ctx, missing } = makeContext(def);
      if (missing.length) {
        entry.status = 'skipped';
        entry.error = `缺少宿主服务：${missing.join(', ')}`;
        hostLog(def.id, `已跳过（${entry.error}）`);
        continue;
      }
      entry.ctx = ctx;
      try {
        if (def.hooks.init) await def.hooks.init(ctx);
        if (def.hooks.start) await def.hooks.start(ctx);
        entry.status = 'running';
      } catch (error) {
        entry.status = 'failed';
        entry.error = String(error?.message ?? error);
        hostLog(def.id, `启动失败（已隔离）：${error?.stack ?? error}`);
      }
    }
    if (tickMs > 0) {
      timer = setInterval(() => { void runTick(); }, tickMs);
      if (typeof timer.unref === 'function') timer.unref();
    }
  }

  async function runTick() {
    if (closed) return;
    for (const entry of entries.values()) {
      if (entry.status !== 'running' || !entry.def.hooks.tick) continue;
      try {
        await entry.def.hooks.tick(entry.ctx);
      } catch (error) {
        hostLog(entry.def.id, `tick 异常：${error?.stack ?? error}`);
      }
    }
  }

  // ── 分发 ──────────────────────────────────────────────────────────────────
  function list() {
    return [...entries.values()].map((entry) => ({
      id: entry.def.id,
      title: entry.def.title,
      version: entry.def.version,
      description: entry.def.description,
      surface: entry.def.surface,
      status: entry.status,
      error: entry.error,
      needs: [...entry.def.needs],
      state: [...entry.def.state],
      routes: entry.def.routes.map((r) => ({ method: r.method, path: `/api/plugins/${entry.def.id}${r.path}`, description: r.description })),
    }));
  }

  function makeCall(req, url, subPath, sendJson, readBody) {
    return {
      method: String(req.method ?? 'GET').toUpperCase(),
      path: subPath,
      query: url.searchParams,
      req,
      /** 直接写响应（之后 return undefined 即可）。 */
      json(status, obj) { sendJson(obj, status); },
      /** 读请求体；空体返回 {}。 */
      async body() {
        const raw = await readBody();
        return (raw && typeof raw === 'object') ? raw : {};
      },
    };
  }

  /**
   * 处理一次 /api/plugins 请求。
   * @returns {Promise<boolean>} true = 已处理（调用方直接 return）
   */
  async function dispatch(req, res, url, helpers = {}) {
    const sendJson = helpers.sendJson;
    const readBody = helpers.readBody;
    if (typeof sendJson !== 'function' || typeof readBody !== 'function') {
      throw new Error('插件宿主：dispatch 必须注入 sendJson / readBody');
    }
    const matched = /^\/api\/plugins(?:\/([a-z0-9-]+))?(\/.*)?$/.exec(url.pathname);
    if (!matched) return false;
    const id = matched[1] ?? '';
    const subPath = (matched[2] ?? '').replace(/\/+$/, '') || '/';

    if (!id) {
      sendJson({ ok: true, pluginsDir, stateDir, plugins: list(), failures });
      return true;
    }

    const entry = entries.get(id);
    if (!entry) {
      sendJson({ ok: false, error: `没有这个插件：${id}` }, 404);
      return true;
    }
    if (entry.status !== 'running' && entry.status !== 'loaded') {
      sendJson({ ok: false, error: `插件 ${id} 未就绪（${entry.status}${entry.error ? `：${entry.error}` : ''}）` }, 503);
      return true;
    }
    if (subPath === '/') {
      sendJson({ ok: true, plugin: list().find((p) => p.id === id) });
      return true;
    }

    const method = String(req.method ?? 'GET').toUpperCase();
    const route = entry.def.routes.find((r) => r.method === method && r.path === subPath);
    if (!route) {
      sendJson({ ok: false, error: `插件 ${id} 没有路由 ${method} ${subPath}` }, 404);
      return true;
    }

    try {
      const result = await route.handler(entry.ctx, makeCall(req, url, subPath, sendJson, readBody));
      if (result && typeof result === 'object' && !(res && res.headersSent)) {
        const status = Number.isFinite(Number(result.status)) ? Number(result.status) : 200;
        if ('json' in result) sendJson(result.json, status);
        else if ('text' in result) { res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }); res.end(String(result.text)); }
      }
    } catch (error) {
      hostLog(id, `路由 ${method} ${subPath} 出错：${error?.stack ?? error}`);
      if (!(res && res.headersSent)) {
        sendJson({ ok: false, error: String(error?.message ?? error) }, Number(error?.statusCode) || 500);
      }
    }
    return true;
  }

  async function close() {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    timer = null;
    for (const entry of [...entries.values()].reverse()) {
      if (entry.status !== 'running' || !entry.def.hooks.stop) continue;
      try { await entry.def.hooks.stop(entry.ctx); } catch (error) { hostLog(entry.def.id, `stop 异常：${error?.message ?? error}`); }
    }
  }

  await boot();

  return {
    dispatch,
    list,
    close,
    get failures() { return [...failures]; },
    get ids() { return [...entries.keys()]; },
  };
}

export default { definePlugin, createPluginHost };
