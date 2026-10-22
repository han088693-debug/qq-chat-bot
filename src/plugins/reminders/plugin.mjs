// 到点提醒 —— 试点插件 1/2
//
// 为什么拿它打头：src/reminders.js 早就抽成了纯库（无状态、原子落盘、有上限校验），
// 只剩「列 / 加 / 取消」三个 HTTP 路由埋在 bridge.js:7702-7734 里，动作与会话主循环无关。
// 触发（runReminderTick，bridge.js:12209）**仍留在桥接里** —— 插件只接管管理面，
// 否则两个定时器会抢着投递同一条提醒。
//
// 老路由不动：本插件挂在 /api/plugins/reminders/*，与 /api/socialV2/reminder-* 并存，
// 之后再让旧路由内联到这里、删掉旧代码。迁移期间两个入口读写的是同一份 state/reminders.json。
import { definePlugin } from '../../plugin-host/index.mjs';

function project(item) {
  return {
    id: item.id,
    text: item.text,
    dueAt: Number(item.dueAt),
    dueText: new Date(Number(item.dueAt)).toLocaleString('zh-CN'),
    inMs: Math.max(0, Number(item.dueAt) - Date.now()),
  };
}

export default definePlugin({
  id: 'reminders',
  title: '到点提醒',
  version: '0.1.0',
  description: 'state/reminders.json 的管理面：列 / 加 / 取消。到点触发由桥接的 runReminderTick() 负责。',
  surface: 'console',
  needs: ['reminderStore'],
  state: ['reminders.json'],
  routes: [
    {
      method: 'GET',
      path: '/list',
      description: '某个会话未触发的提醒（?key=private:123）',
      handler: (ctx, call) => {
        const key = String(call.query.get('key') ?? '').trim();
        if (!key) return { status: 400, json: { ok: false, error: 'key 不能为空' } };
        return { json: { ok: true, key, items: ctx.services.reminderStore.list(key).map(project) } };
      },
    },
    {
      method: 'GET',
      path: '/all',
      description: '全部提醒（含已触发，控制台用）',
      handler: (ctx) => ({ json: { ok: true, items: ctx.services.reminderStore.all().map(project) } }),
    },
    {
      method: 'POST',
      path: '/add',
      description: '新增一条：{ key, text, dueAt(毫秒) }',
      handler: async (ctx, call) => {
        const body = await call.body();
        const key = String(body.key ?? '').trim();
        if (!key) return { status: 400, json: { ok: false, error: 'key 不能为空' } };
        const result = ctx.services.reminderStore.add({
          key,
          text: body.text,
          dueAt: body.dueAt,
          createdBy: 'console',
        });
        if (!result.ok) return { status: 400, json: { ok: false, error: result.error } };
        return {
          json: {
            ok: true,
            item: project(result.item),
            pending: ctx.services.reminderStore.list(key).map(project),
          },
        };
      },
    },
    {
      method: 'POST',
      path: '/cancel',
      description: '取消一条：{ key, id }',
      handler: async (ctx, call) => {
        const body = await call.body();
        const key = String(body.key ?? '').trim();
        if (!key) return { status: 400, json: { ok: false, error: 'key 不能为空' } };
        const result = ctx.services.reminderStore.cancel(key, body.id);
        if (!result.ok) return { status: 404, json: { ok: false, error: result.error } };
        return {
          json: {
            ok: true,
            canceled: project(result.item),
            pending: ctx.services.reminderStore.list(key).map(project),
          },
        };
      },
    },
  ],
});
