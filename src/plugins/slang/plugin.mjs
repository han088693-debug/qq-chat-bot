// 黑话库 —— 试点插件 3/3（第一个「由插件接手控制面」的存量功能）
//
// 为什么是它：黑话库是 console 里最重的一块状态型功能（state/slang.json ≈ 130 KB），
// 原来 254 行读改写逻辑全挤在 bridge.js 的路由 if 链里（旧 4336–4589）。这次把那批
// 路由体原样收进 bridge.js 的 `slangApi*` 函数（withSlangContext 之后），内置路由
// 退化成薄壳，本插件通过 `services.slang` 调用同一批函数 —— 两个入口读写的是同一份
// 内存 slangEntries，不会出现两份真相。
//
// 仍然留在桥接里的部分（不可搬）：slangWindows 收集、runSlangExtraction /
// runSlangResearch 的 DSH 会话编排、feedSlangWindow 的收消息钩子、withSlangContext
// 的提示词注入。它们与会话主循环绑定，搬出来只会制造一个需要回调宿主的大泥球。
//
// 学习任务（extract / research）在这里只做「入队」：queueSlangTask 保证串行，真正的
// 执行仍在桥接进程里，与本插件解耦失败（插件崩了不影响正在跑的学习任务）。
import { definePlugin } from '../../plugin-host/index.mjs';

/** 桥接的 slangApi* 统一返回 { status, body }，这里翻译成宿主的 { status, json }。 */
function http(result) {
  const status = Number(result?.status) || 200;
  return { status, json: result?.body ?? { ok: status < 400 } };
}

async function bodyOf(call) {
  const body = await call.body();
  return body && typeof body === 'object' ? body : {};
}

function idOf(body) {
  return String(body.id ?? '').trim();
}

const MISSING_ID = { status: 400, json: { ok: false, error: 'id 不能为空' } };

export default definePlugin({
  id: 'slang',
  title: '黑话库',
  version: '0.1.0',
  description: '黑话词条的增删改查 / 批量确认拒绝 / 触发提取与研究 / 学习参数。逻辑在桥接的 slangApi*，插件只做 HTTP 转发与参数校验。',
  surface: 'console',
  needs: ['slang'],
  state: ['slang.json', 'slang-session.json'],
  routes: [
    {
      method: 'GET',
      path: '/list',
      description: '列出词条；?status=candidate|confirmed|rejected 过滤。附带 config 与 writable 标志',
      handler: (ctx, call) => http(ctx.services.slang.list(call.query.get('status'))),
    },
    {
      method: 'POST',
      path: '/add',
      description: '新增词条：{ content, meaning, usage, example, risk, sources, evidence, status }',
      handler: async (ctx, call) => http(ctx.services.slang.add(await bodyOf(call))),
    },
    {
      method: 'POST',
      path: '/update',
      description: '按 id 局部更新：{ id, content?, meaning?, ... }',
      handler: async (ctx, call) => {
        const body = await bodyOf(call);
        const id = idOf(body);
        if (!id) return MISSING_ID;
        return http(ctx.services.slang.update(id, body));
      },
    },
    {
      method: 'POST',
      path: '/delete',
      description: '删除一条：{ id }',
      handler: async (ctx, call) => {
        const id = idOf(await bodyOf(call));
        if (!id) return MISSING_ID;
        return http(ctx.services.slang.remove(id));
      },
    },
    {
      method: 'POST',
      path: '/confirm',
      description: '确认候选（可顺带补字段）：{ id, meaning?, usage?, ... }',
      handler: async (ctx, call) => {
        const body = await bodyOf(call);
        const id = idOf(body);
        if (!id) return MISSING_ID;
        return http(ctx.services.slang.confirm(id, body));
      },
    },
    {
      method: 'POST',
      path: '/reject',
      description: '拒绝一条：{ id }',
      handler: async (ctx, call) => {
        const id = idOf(await bodyOf(call));
        if (!id) return MISSING_ID;
        return http(ctx.services.slang.reject(id));
      },
    },
    {
      method: 'POST',
      path: '/batch-confirm',
      description: '批量确认：{ ids }，缺含义/非候选的会跳过',
      handler: async (ctx, call) => http(ctx.services.slang.batchConfirm(await bodyOf(call))),
    },
    {
      method: 'POST',
      path: '/batch-reject',
      description: '批量拒绝：{ ids }',
      handler: async (ctx, call) => http(ctx.services.slang.batchReject(await bodyOf(call))),
    },
    {
      method: 'POST',
      path: '/batch-delete',
      description: '批量删除：{ ids } 或按状态 { status }',
      handler: async (ctx, call) => http(ctx.services.slang.batchDelete(await bodyOf(call))),
    },
    {
      method: 'POST',
      path: '/clear',
      description: '清空：{ status? }，留空 = 全删（同时清提取窗口与冷却）',
      handler: async (ctx, call) => http(ctx.services.slang.clear(await bodyOf(call))),
    },
    {
      method: 'POST',
      path: '/extract',
      description: '触发一次黑话提取：{ key? }，缺省取第一个待学习窗口。只入队，异步跑',
      handler: async (ctx, call) => http(ctx.services.slang.extract(await bodyOf(call))),
    },
    {
      method: 'POST',
      path: '/research',
      description: '研究候选词条（联网查证）：{ ids? }，缺省 = 全部候选',
      handler: async (ctx, call) => http(ctx.services.slang.research(await bodyOf(call))),
    },
    {
      method: 'POST',
      path: '/config',
      description: '改学习参数：{ enabled?, extractMinMessages?, injectMax?, autoResearch?, learnerPreset?, workspaceTitle?, inferenceThresholds? }',
      handler: async (ctx, call) => http(ctx.services.slang.config(await bodyOf(call))),
    },
  ],
});
