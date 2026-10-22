# 插件契约（Bridge 侧）

`bridge.js` 已经 13,800 行，`startConsoleServer()` 一个函数就 4,500 行 / 146 个路由。
拆功能时缺的不是代码，是**挂点**。`src/plugin-host/` 提供这个挂点：插件声明
路由 / 钩子 / 状态，宿主管加载、鉴权之后的分发、以及失败隔离。

> 现状定位：**叠加式（additive）**。插件挂在 `/api/plugins/<id>/*`，旧路由一个没删，
> 两个入口读写同一份状态文件。等某个插件在控制台里用稳了，再把旧路由改成内联调用、
> 删掉旧代码。不要反过来——先删旧代码会同时失去回退路径和线上行为基线。

## 目录布局

```
src/plugin-host/index.mjs       宿主：definePlugin / createPluginHost / dispatch
src/plugin-host/CONTRACT.md     本文档
src/plugins/<id>/plugin.mjs     插件入口（也接受 index.mjs）
src/plugins/<id>/...            插件自己的其它文件
state/plugins/<id>/             插件状态分片（宿主给，自动建）
```

## 插件契约

```js
import { definePlugin } from '../../plugin-host/index.mjs';

export default definePlugin({
  id: 'reminders',            // 必填，^[a-z][a-z0-9-]{1,30}$，同时是 URL 段和状态目录名
  title: '到点提醒',           // 给人看
  version: '0.1.0',
  description: '一句话说明它管什么',
  surface: 'console',         // 'console'（默认）| 'agent' | 'both' —— 见「鉴权」
  deps: [],                   // 其它插件 id，先于本插件加载；成环会在启动时报错
  needs: ['reminderStore'],   // 需要的宿主服务，缺任何一个 ⇒ status='skipped'，不崩
  state: ['reminders.json'],  // 声明读写哪些状态文件（审计用；宿主不强制）
  routes: [
    { method: 'GET', path: '/list', description: '…', handler: (ctx, call) => ({ json: { ok: true } }) },
  ],
  hooks: {                    // 都可选，全部 async-safe
    async init(ctx) {},
    async start(ctx) {},
    async stop(ctx) {},
    async tick(ctx) {},       // 仅当宿主以 tickMs>0 创建时才会被调用
  },
});
```

校验在 `definePlugin()` 里做死：id 非法、method 非 GET/POST、path 不以 `/` 开头或含 `..`、
缺 handler、同一 method+path 重复 —— 全部直接抛，插件被判 `failed` 并隔离。

### ctx（宿主注入）

| 字段 | 说明 |
|---|---|
| `ctx.id` / `ctx.root` / `ctx.stateDir` | 插件 id、项目根、`state/` 绝对路径 |
| `ctx.services` | `needs` 里点名的服务，冻结后的副本。**宿主不 import bridge.js**，能力只能从这里进 |
| `ctx.state.dir(name?)` | `state/plugins/<id>/`（自动创建） |
| `ctx.state.file(rel)` | 分片目录下的路径（不创建） |
| `ctx.state.json(rel, { sharded })` | `{ file, read(fallback), write(value) }`；`sharded:false` 读 `state/rel`（老文件） |
| `ctx.state.legacy(rel)` | `state/rel` 的绝对路径，给还没搬家的老文件用 |
| `ctx.log(msg)` | 带 `[插件 <id>]` 前缀的日志 |

### call（每次请求一个）

| 字段 | 说明 |
|---|---|
| `call.method` / `call.path` / `call.query` | 方法、插件内路径（如 `/list`）、`URLSearchParams` |
| `await call.body()` | 解析后的 JSON 体；空体给 `{}`。超限/非 JSON 由桥接的 `readBody()` 负责抛 |
| `call.json(status, obj)` | 直接写响应（写完 return undefined） |

返回值：

- `{ json, status? }` → 写 JSON（默认 200）
- `{ text, status? }` → 写纯文本
- `undefined` 且已经 `call.json()` 过 → 什么都不做
- 抛异常 → 500 + `{ ok:false, error }`；带 `error.statusCode` 时用它当状态码

## 鉴权（重要）

分发点插在 `bridge.js` 的 **`x-agent-token` 白名单之后**、业务路由之前。意味着：

1. 全局关卡全部先生效：控制台令牌、`x-agent-call` 校验、CSRF/Content-Type、只读降级。
2. 带会话令牌的 AI 调用在**到达插件之前**就被 403（`/api/plugins/` 不在 `agentAllowed` 里）。
3. 所以 `surface: 'console'` 是**默认且唯一被强制执行**的行为。`agent`/`both` 目前只是
   给未来留的声明位：真要让 AI 调旧插件面，得同时改 `agentAllowed` 白名单 + 在插件里
   自己按 `key` 校验 `agentToken`。**不要在没改白名单的情况下给插件加 AI 可调路由**——
   那等于把「管理面」和「会话面」重新混在一起。

## 失败隔离

- import / `definePlugin` 校验失败 → 记 `failures[]`，其它插件照常加载。
- `needs` 缺失 → `status='skipped'`，路由返回 503，不崩。
- `init/start/tick/stop` 抛异常 → `status='failed'`，只记日志。
- 路由抛异常 → 该请求 500，进程不受影响。
- 宿主自身 import 失败（例如把 bridge.js 拷进临时目录跑 VM 的测试环境）→ 桥接
  `try/catch` 后只记一行日志，控制台照常起。

## 迁移路线

| 阶段 | 做什么 | 回退成本 |
|---|---|---|
| 0（已完成） | 宿主 + 两个零风险试点（reminders / token-ledger）挂 `/api/plugins/*` | 删目录即可 |
| 1（已完成） | 第一个存量功能：**黑话库**。路由体收进 `slangApi*`，内置路由变薄壳，插件经 `services.slang` 调同一批函数 | 删插件目录，旧路由不受影响 |
| 2 | 控制台 `console.html` 先接 `/api/plugins/*`，旧路由保留 | 改回去只是换个 fetch 地址 |
| 3 | 旧路由改成内联调插件 handler，删掉 bridge.js 里的重复实现 | git revert 单段 |
| 4 | 按 section 拆控制台：stickers / voice / memory / social-V2 → 每块一个插件 | 同上 |

阶段 3 的判定标准：插件接口连续跑稳 **一周**、`state/` 下没有出现两份互相覆盖的写法。

## 存量功能的拆法：门面服务（以 slang 为例）

存量功能不能「整块搬进插件」——它的逻辑一半在路由里、一半在主循环里（黑话库的
`slangWindows` 收集、`runSlangExtraction` 的 DSH 会话编排、`withSlangContext` 的提示词
注入都绑在会话主循环上）。可搬的只有**控制面**，做法是把路由体原样提成
`slangApiXxx()` 纯函数，内置路由和插件都调它：

```
bridge.js 旧路由 ─┐
                  ├─→ slangApiXxx() ─→ slangEntries / state/slang.json
插件 /api/plugins/slang/* ─┘
```

好处：搬的时候零行为变化（旧路由只是少了一层 if）、两份入口天然同源、插件的失败边界
只在 HTTP 层。代价：`bridge.js` 里多出一批 `slangApi*` 函数和一个 `services.slang` 门面。

路由对照（左边是既有 RESTful 面，右边是插件面；语义相同，只是插件面统一成了 POST）：

| 旧路由 | 插件路由 |
|---|---|
| `GET /api/slang?status=` | `GET /api/plugins/slang/list?status=` |
| `POST /api/slang` | `POST /api/plugins/slang/add` |
| `PATCH /api/slang/:id` | `POST /api/plugins/slang/update`（body 带 `id`） |
| `POST /api/slang/:id/confirm` | `POST /api/plugins/slang/confirm` |
| `POST /api/slang/:id/reject` | `POST /api/plugins/slang/reject` |
| `DELETE /api/slang/:id` | `POST /api/plugins/slang/delete` |
| `POST /api/slang/batch-*` `clear` `extract` `research` `config` | 同名（去掉 `slang` 段） |

只读降级（启动时 `slang.json` 加载失败）由 `slangReadonlyBlock()` 在服务层统一挡住：
9 个写入口一律 503，不再依赖路由层白名单——那条白名单漏掉了 PATCH/DELETE，也管不到插件面。

## 加一个新插件

1. 建 `src/plugins/<id>/plugin.mjs`，`export default definePlugin({...})`。
2. 需要宿主能力就在 `needs` 里点名，并在 `bridge.js` 创建宿主时的 `services` 里补上。
3. `node scripts/test-plugin-host.mjs` 跑契约测试；控制台访问 `/api/plugins` 看是否 `running`。

插件不需要改 `bridge.js`——除了新增 `needs` 服务时要在宿主创建处加一行。

## 测试

```bash
node --test scripts/test-plugin-host.mjs   # 契约 + 分发 + 状态分片 + 失败隔离（4 例）
```

测试不碰真实 `config.json`、不连 QQ、不写项目 `state/`，全部落在 `os.tmpdir()`。
