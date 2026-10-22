// Token 用量账本 —— 试点插件 2/2
//
// 为什么是它：全链路只读（只有 reset 会写），会话/发送/DSH 一概不碰，
// 是「最安全的首个试点」。逻辑原样搬自 bridge.js:7254-7288，参数钳制保持一致，
// 免得控制台的图表画出界。
//
// 注意这条业务规则（原注释在 bridge.js:7250）：路径刻意不放在 /api/socialV2/ 下，
// 因为那一整个前缀对持有 x-agent-token 的 QQ 侧 AI 是放行的，而跨群花费属于管理信息。
// 本插件的 surface 是 console，宿主又挂在 agent 白名单之后，所以这条规则自动满足 ——
// 但仍然保留这里的一句注释，别哪天顺手把 surface 改成 'both'。
import { definePlugin } from '../../plugin-host/index.mjs';

const clamp = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

export default definePlugin({
  id: 'token-ledger',
  title: 'Token 用量账本',
  version: '0.1.0',
  description: '读 token-usage.jsonl 的投影：汇总 / 时间序列 / 单会话回合 / 最近条目，外加 reset。',
  surface: 'console',
  needs: ['tokenLedger', 'priceTable'],
  state: ['token-usage.jsonl'],
  routes: [
    {
      method: 'GET',
      path: '/summary',
      description: '汇总（?limit=200）',
      handler: (ctx, call) => {
        const limit = clamp(call.query.get('limit'), 1, 500, 200);
        const ledger = ctx.services.tokenLedger;
        return { json: { ...ledger.summary({ limit }), ledger: ledger.stats() } };
      },
    },
    {
      method: 'GET',
      path: '/series',
      description: '时间序列（?hours=24&buckets=48）',
      handler: (ctx, call) => {
        const hours = clamp(call.query.get('hours'), 1, 24 * 90, 24);
        const maxBuckets = clamp(call.query.get('buckets'), 6, 120, 48);
        return { json: ctx.services.tokenLedger.series({ hours, maxBuckets }) };
      },
    },
    {
      method: 'GET',
      path: '/turns',
      description: '单个会话的回合明细（?key=&limit=200）',
      handler: (ctx, call) => {
        const key = String(call.query.get('key') ?? '').trim();
        if (!key) return { status: 400, json: { ok: false, error: 'key 不能为空' } };
        const limit = clamp(call.query.get('limit'), 1, 1000, 200);
        const detail = ctx.services.tokenLedger.conversation(key, { turnLimit: limit });
        if (!detail) return { status: 404, json: { ok: false, error: '未找到该会话的用量记录' } };
        return { json: detail };
      },
    },
    {
      method: 'GET',
      path: '/recent',
      description: '最近条目（?limit=50）',
      handler: (ctx, call) => {
        const limit = clamp(call.query.get('limit'), 1, 500, 50);
        return {
          json: {
            ok: true,
            symbol: ctx.services.priceTable?.symbol ?? '',
            entries: ctx.services.tokenLedger.recent(limit),
          },
        };
      },
    },
    {
      method: 'POST',
      path: '/reset',
      description: '清空账本（账本自己落盘，宿主不碰文件）',
      handler: (ctx) => {
        ctx.services.tokenLedger.reset();
        ctx.log('token 用量账本已重置');
        return { json: { ok: true } };
      },
    },
  ],
});
