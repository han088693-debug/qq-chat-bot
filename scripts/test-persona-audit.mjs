// 人味仪表盘测试：全部用临时目录里的小样本，不碰真实 state
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  botTextsFromToolCalls,
  collectPersonaMetrics,
  formatAuditReport,
  latencyFromActivity,
  parseActivityLog,
  turnStructure,
} from '../src/persona-audit.mjs';

function makeStateDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-audit-'));
  return dir;
}

// Synthetic session and messages; no production chat data.
const KEY = 'private:10001';

function message(seq, isSelf, text, time = 1700000000000 + seq * 60000) {
  return { seq, isSelf, text, plain: text, time, media: [], hasMedia: false };
}

// 1. 话轮结构：严格 H-B 交替 → replyRate 1.0、strictAlternation
{
  const runs = turnStructure([
    message(1, false, '早'),
    message(2, true, '早'),
    message(3, false, '在干嘛'),
    message(4, true, '看你'),
  ]);
  assert.equal(runs.humanRuns, 2);
  assert.equal(runs.botRuns, 2);
  assert.equal(runs.replyRate, 1);
  assert.equal(runs.maxBurst, 1);
  assert.equal(runs.strictAlternation, true);
  assert.equal(runs.singleReplyShare, 1);
}

// 2. 真人连发 3 条只回 1 条 → replyRate 0.5，burts 里有 3 条连发
{
  const runs = turnStructure([
    message(1, false, 'a'),
    message(2, false, 'b'),
    message(3, false, 'c'),
    message(4, true, '嗯'),
    message(5, true, ''),
  ]);
  assert.equal(runs.humanRuns, 1);
  assert.equal(runs.botRuns, 1);
  assert.equal(runs.humanMessages, 3);
  assert.equal(runs.botMessages, 2);
  assert.equal(runs.repliesPerHumanMessage, 0.33);
  assert.equal(runs.replyRate, 1);
  assert.deepEqual(runs.burstHistogram, { 2: 1 });
}

// 3. 出站正文从 tool-calls 恢复，支持滚动文件拼接，过滤时间窗与别的会话
{
  const now = Date.parse('2026-10-21T10:00:00Z');
  const raw = [
    JSON.stringify({
      type: 'call',
      time: '2026-10-21T09:00:00Z',
      key: KEY,
      tool: 'mcp__snowluma__qq_send_message',
      args: JSON.stringify({ key: KEY, messages: ['嗯', '[图片]'] }),
    }),
    JSON.stringify({ type: 'result', time: '2026-10-21T09:00:01Z', key: KEY, tool: 'mcp__snowluma__qq_send_message', ok: true }),
    JSON.stringify({
      type: 'call',
      time: '2026-10-21T09:00:00Z',
      key: 'private:999',
      tool: 'mcp__snowluma__qq_send_message',
      args: JSON.stringify({ messages: ['不该被算进来'] }),
    }),
    JSON.stringify({
      type: 'call',
      time: '2026-10-18T09:00:00Z',
      key: KEY,
      tool: 'mcp__snowluma__qq_send_message',
      args: JSON.stringify({ messages: ['太旧了'] }),
    }),
  ].join('\n');
  const texts = botTextsFromToolCalls(raw, { key: KEY, now, days: 1 });
  assert.deepEqual(texts.map((t) => t.text), ['嗯', '[图片]']);
}

// 4. 活动日志解析 + 入站→发送秒差配对
{
  const raw = [
    '[08:30:34] private:10001 [reserved2] 消息已入未读：早',
    '[08:30:40] private:10001 [reserved2] 工具统一发送：成功 1/1 条',
    '[08:31:12] private:10001 [reserved2] 消息已入未读：晕了',
    '[08:33:30] private:10001 [reserved2] 工具统一发送：成功 2/2 条',
    '[08:31:00] private:10001 [reserved2] 工具发送表情：',
  ].join('\n');
  const entries = parseActivityLog(raw);
  assert.equal(entries.length, 5);
  assert.equal(entries[1].event, '工具统一发送');
  assert.equal(entries[1].detail, '成功 1/1 条');
  const { samples, proactive } = latencyFromActivity(entries, { key: KEY });
  assert.deepEqual(samples, [6, 138]);
  assert.equal(proactive, 0);
}

// 5. 主动开口：没有前驱入站的发送单独计数
{
  const entries = parseActivityLog(
    [
      '[09:00:00] private:1 [reserved2] 工具统一发送：成功 1/1 条',
      '[09:10:00] private:1 [reserved2] 消息已入未读：在吗',
      '[09:10:05] private:1 [reserved2] 工具统一发送：成功 1/1 条',
    ].join('\n'),
  );
  const { samples, proactive } = latencyFromActivity(entries, { key: 'private:1' });
  assert.deepEqual(samples, [5]);
  assert.equal(proactive, 1);
}

// 6. 全量指标：乒乓结构 + 工具痕迹 + 交接班日志 + 记忆计数一起报出来
{
  const dir = makeStateDir();
  const now = Date.parse('2026-10-21T10:00:00Z');
  const messages = [];
  let seq = 0;
  for (let i = 0; i < 6; i += 1) {
    seq += 1;
    messages.push(message(seq, false, ['早', '在干嘛', '好捏', '我出门了', '？', '睡了吗'][i]));
    seq += 1;
    messages.push(message(seq, true, ['早', '看你', '嗯', '路上小心', '没', '还没'][i]));
  }

  fs.writeFileSync(
    path.join(dir, 'social-v2.json'),
    JSON.stringify({
      conversations: {
        [KEY]: {
          recentMessages: messages,
          styleNotes: ['短'],
          styleAvoid: [],
          fewshots: [{ user: '睡了没', bot: '没' }],
          memberImpressions: {},
          affection: {},
          activeTopics: ['a'],
        },
      },
    }),
  );
  fs.writeFileSync(
    path.join(dir, 'tool-calls.jsonl'),
    [
      JSON.stringify({
        type: 'call',
        time: '2026-10-21T09:00:00Z',
        key: KEY,
        tool: 'mcp__snowluma__qq_send_message',
        args: JSON.stringify({ messages: ['发帖用 heybox_post', '早点睡'] }),
      }),
      JSON.stringify({
        type: 'call',
        time: '2026-10-21T09:01:00Z',
        key: KEY,
        tool: 'mcp__snowluma__qq_send_message',
        args: JSON.stringify({ messages: ['早点睡'] }),
      }),
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(dir, 'qq-activity.log'),
    [
      '[09:00:00] private:10001 [reserved2] 消息已入未读：早',
      '[09:00:06] private:10001 [reserved2] 工具统一发送：成功 1/1 条',
      '[09:05:00] private:10001 [reserved2] AI 内部输出：这轮没有新消息，已读停在 12，我不多打扰。',
      '[09:10:00] private:10001 [reserved2] 工具统一发送：成功 1/1 条',
    ].join('\n'),
  );

  fs.mkdirSync(path.join(dir, 'empty'), { recursive: true });
  const m = collectPersonaMetrics({ stateDir: dir, now, key: KEY, days: 7 });
  assert.equal(m.ok, true);
  assert.equal(m.window.messages, 12);
  assert.equal(m.turns.replyRate, 1);
  assert.equal(m.turns.strictAlternation, true);
  assert.equal(m.toolTrace.hits, 1);
  assert.equal(m.repeat.top[0].text, '早点睡');
  assert.equal(m.monologue.handoverHits, 1);
  assert.equal(m.monologue.internalOutputs, 1);
  assert.equal(m.latency.under5 + m.latency.from5to15, 1);
  assert.equal(m.memory.fewshots, 1);

  const ids = m.verdicts.map((v) => v.id);
  for (const id of ['reply-rate', 'tool-trace', 'handover', 'fewshots', 'impressions']) {
    assert.ok(ids.includes(id), `缺少判断项 ${id}`);
  }

  const report = formatAuditReport(m);
  assert.match(report, /人味仪表盘 · private:10001/);
  assert.match(report, /🔴 必回率 100%/);
  assert.match(report, /工具名\/链接\s+1 条/);

  const noKey = collectPersonaMetrics({ stateDir: dir });
  assert.equal(noKey.ok, false);
  assert.match(noKey.error, /请提供有效的会话 key/);
  const invalidKey = collectPersonaMetrics({ stateDir: dir, key: '../other' });
  assert.equal(invalidKey.ok, false);

  const missing = collectPersonaMetrics({ stateDir: dir, key: 'private:404' });
  assert.equal(missing.ok, false);
  assert.match(formatAuditReport(missing), /没有这个会话/);

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('persona-audit: 6 项通过');
