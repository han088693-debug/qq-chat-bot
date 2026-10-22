// 人味仪表盘（P2-9）
//
// 目的：把「AI 味重不重」变成可重复测量的数字，而不是靠感觉。
// 数据全部来自本地状态文件，不调模型、不联网：
//   state/social-v2.json   最近 100 条消息（判断乒乓结构、句长、重复）
//   state/tool-calls.jsonl 出站正文（qq_send_message 的 args.messages）
//   state/qq-activity.log  入站/发送/内部独白（判断延迟带、交接班日志）
//
// 两层：collectPersonaMetrics 读文件算数（路径可注入，便于测试）；
//       formatAuditReport 把数字变成人看的报告。CLI 在 scripts/persona-audit.mjs。

import fs from 'node:fs';
import path from 'node:path';

// 媒体/引用占位符不是「说出来的话」，算句长前要剔掉
const MEDIA_PREFIX_RE = /^\[(引用|图片|拍一拍|表情|动画表情|视频|语音|文件|转发)[^\]]*\]\s*/;

const TOOL_TRACE_RE =
  /\b(?:mcp__[a-z0-9_]+__[a-z0-9_]+|(?:qq|heybox|phone|iphone|bili|snowluma|web-search-safe)_[a-z0-9_]+|BV[0-9A-Za-z]{10})\b/i;
const URL_RE = /https?:\/\/\S+/i;

// 「交接班日志」：AI 把给自己看的念头写成了工作记录
const HANDOVER_RE = /(这轮没有新消息|这轮没新消息|已读停在|已读标到|不多打扰|安静够了|交接班|我这轮就安静)/;

const ACTIVITY_LINE_RE = /^\[(\d{2}):(\d{2}):(\d{2})\]\s+(\S+)\s+\[[^\]]*\]\s*(.*)$/;

function safeRead(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function charLen(text) {
  return [...String(text ?? '')].length;
}

function stripMedia(text) {
  return String(text ?? '')
    .replace(MEDIA_PREFIX_RE, '')
    .trim();
}

function mean(list) {
  if (!list.length) return 0;
  return list.reduce((a, b) => a + b, 0) / list.length;
}

function sd(list) {
  if (list.length < 2) return 0;
  const m = mean(list);
  return Math.sqrt(list.reduce((a, b) => a + (b - m) ** 2, 0) / (list.length - 1));
}

function percentile(list, p) {
  if (!list.length) return 0;
  const sorted = [...list].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function lengthStats(texts) {
  const lens = texts.map(charLen).filter((n) => n > 0);
  return {
    n: lens.length,
    mean: Number(mean(lens).toFixed(1)),
    sd: Number(sd(lens).toFixed(1)),
    p50: percentile(lens, 50),
    p90: percentile(lens, 90),
    max: Math.max(0, ...lens),
  };
}

// ---------- 出站正文（tool-calls） ----------

export function botTextsFromToolCalls(raw, { key = null, now = Date.now(), days = 1 } = {}) {
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  const out = [];
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (entry?.type !== 'call') continue;
    if (key && entry.key !== key) continue;
    if (!/qq_send_message/.test(String(entry.tool ?? ''))) continue;
    const at = Date.parse(entry.time);
    if (Number.isFinite(at) && at < cutoff) continue;
    let args;
    try {
      args = JSON.parse(entry.args);
    } catch {
      continue;
    }
    const messages = Array.isArray(args?.messages) ? args.messages : [];
    for (const text of messages) {
      const raw = String(text ?? '').trim();
      if (!raw) continue;
      // 保留原始正文（含 [图片] 这类占位符），句长统计时再用 plain 剥掉
      out.push({ text: raw, plain: stripMedia(raw), time: Number.isFinite(at) ? at : null });
    }
  }
  return out;
}

// ---------- 活动日志 ----------

export function parseActivityLog(raw) {
  const lines = [];
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const m = ACTIVITY_LINE_RE.exec(line.trim());
    if (!m) continue;
    const body = m[5] ?? '';
    const [eventRaw, ...rest] = body.split('：');
    lines.push({
      at: Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]),
      key: m[4],
      event: (eventRaw || '').trim(),
      detail: rest.join('：').trim(),
    });
  }
  return lines;
}

/**
 * 入站 → 后一条发送的秒差。日志没有日期，按文件顺序配对；
 * 跨零点时（差值 < -60s）按加了 24h 处理。
 * proactive = 前面 maxGapSec 内完全没有入站的发送（真·主动开口）；
 * 一次入站引出多条发送（补一句/表情）只按第一条算延迟。
 */
export function latencyFromActivity(entries, { key = null, maxGapSec = 600 } = {}) {
  const list = entries.filter((e) => !key || e.key === key);
  const samples = [];
  let proactive = 0;
  let lastInboundAt = null; // 最近一次入站（按文件顺序，日志不跨文件重排）
  let pendingAt = null; // 一次入站只配对第一条发送，后面的算补一句
  for (const entry of list) {
    if (entry.event === '消息已入未读') {
      lastInboundAt = entry.at;
      pendingAt = entry.at;
      continue;
    }
    if (entry.event !== '工具统一发送' && entry.event !== '工具发送表情') continue;

    if (lastInboundAt == null) {
      proactive += 1;
      continue;
    }
    let diff = entry.at - lastInboundAt;
    if (diff < -60) diff += 24 * 3600; // 跨零点：日志没有日期，只能按顺序补一天
    if (diff < 0) diff = 0; // 同一秒内的乱序行，不算主动也不留负数

    if (diff > maxGapSec) {
      proactive += 1; // 沉默够久之后自己开口
      pendingAt = null;
      continue;
    }
    if (pendingAt == null) continue; // 同一次入站之后的补发，不算延迟样本
    pendingAt = null;
    if (diff >= 0) samples.push(diff);
  }
  return { samples, proactive };
}

// ---------- 话轮结构 ----------

export function turnStructure(messages, { answerWindowMs = 10 * 60 * 1000 } = {}) {
  const runs = [];
  for (const msg of messages) {
    const side = msg?.isSelf ? 'bot' : 'human';
    const last = runs.at(-1);
    if (last && last.side === side) {
      last.count += 1;
      last.texts.push(msg);
    } else {
      runs.push({ side, count: 1, texts: [msg] });
    }
  }
  const humanRuns = runs.filter((r) => r.side === 'human').length;
  const botRuns = runs.filter((r) => r.side === 'bot').length;
  const humanMessages = runs.filter((r) => r.side === 'human').reduce((a, r) => a + r.count, 0);
  const botRunsSize = runs.filter((r) => r.side === 'bot').map((r) => r.count);
  const singleReplyRuns = botRunsSize.filter((n) => n === 1).length;

  // 必回率：一个真人话轮在 answerWindowMs 内有没有被接（接得慢也算接，这里只量「接不接」）
  let answered = 0;
  const answerGapsMs = [];
  for (let i = 0; i < runs.length; i += 1) {
    if (runs[i].side !== 'human') continue;
    const next = runs[i + 1];
    if (!next || next.side !== 'bot') continue;
    const lastHumanAt = runs[i].texts.at(-1)?.time;
    const firstBotAt = next.texts[0]?.time;
    if (!Number.isFinite(lastHumanAt) || !Number.isFinite(firstBotAt)) {
      answered += 1;
      continue;
    }
    const gap = firstBotAt - lastHumanAt;
    if (gap >= 0 && gap <= answerWindowMs) {
      answered += 1;
      answerGapsMs.push(gap);
    }
  }

  return {
    runs,
    humanRuns,
    botRuns,
    humanMessages,
    botMessages: botRunsSize.reduce((a, n) => a + n, 0),
    /** 必回率：被接的真人话轮 / 全部真人话轮 */
    replyRate: humanRuns ? Number((answered / humanRuns).toFixed(2)) : 0,
    /** 平均一条真人消息换来多少条 bot 消息（越接近 1 越像对练，<0.5 有留白） */
    repliesPerHumanMessage: humanMessages ? Number((botRuns / humanMessages).toFixed(2)) : 0,
    maxBurst: Math.max(0, ...botRunsSize),
    burstHistogram: botRunsSize.reduce((acc, n) => {
      acc[n] = (acc[n] || 0) + 1;
      return acc;
    }, {}),
    /** 单条回复占全部 bot 话轮的比例（越接近 1 越像乒乓） */
    singleReplyShare: botRuns ? Number((singleReplyRuns / botRuns).toFixed(2)) : 0,
    strictAlternation: runs.length > 1 && runs.every((r) => r.count === 1),
    answerGapsMs,
  };
}

// ---------- 汇总 ----------

function repeatedTexts(texts) {
  const counts = new Map();
  for (const text of texts) {
    counts.set(text, (counts.get(text) || 0) + 1);
  }
  const dup = [...counts.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
  const dupMessages = dup.reduce((a, [, n]) => a + n, 0);
  return {
    n: texts.length,
    unique: counts.size,
    dupRate: texts.length ? Number((dupMessages / texts.length).toFixed(3)) : 0,
    top: dup.slice(0, 5).map(([text, count]) => ({ text, count })),
  };
}

export function collectPersonaMetrics({
  stateDir = path.resolve('state'),
  key = '',
  now = Date.now(),
  days = 1,
  recentLimit = 100,
} = {}) {
  if (typeof key !== 'string' || !/^(private|group):[1-9]\d*$/.test(key)) {
    return { ok: false, error: '请提供有效的会话 key（private:账号 或 group:群号）', key };
  }
  const social = readJson(path.join(stateDir, 'social-v2.json'), null);
  const conversation = social?.conversations?.[key] ?? null;
  if (!conversation) {
    return { ok: false, error: `状态里没有这个会话：${key}`, key };
  }

  const messages = Array.isArray(conversation.recentMessages)
    ? conversation.recentMessages.slice(-recentLimit)
    : [];
  const turns = turnStructure(messages);

  const botSources = ['tool-calls.jsonl', 'tool-calls.jsonl.1']
    .map((name) => safeRead(path.join(stateDir, name)))
    .join('\n');
  const botTextEntries = botTextsFromToolCalls(botSources, { key, now, days });
  const botTexts = botTextEntries.map((e) => e.text);
  const botPlain = botTextEntries.map((e) => e.plain).filter(Boolean);
  const humanTexts = messages
    .filter((m) => !m?.isSelf)
    .map((m) => stripMedia(m?.plain ?? m?.text))
    .filter(Boolean);

  const activityEntries = parseActivityLog(
    ['qq-activity.log', 'qq-activity.log.1']
      .map((name) => safeRead(path.join(stateDir, name)))
      .join('\n'),
  );
  const { samples: latencies, proactive } = latencyFromActivity(activityEntries, { key });

  const traceHits = botTexts.filter((t) => TOOL_TRACE_RE.test(t) || URL_RE.test(t));
  const handoverLines = activityEntries
    .filter((e) => e.key === key && e.event === 'AI 内部输出' && HANDOVER_RE.test(e.detail))
    .map((e) => e.detail);
  const internalOutputs = activityEntries.filter(
    (e) => e.key === key && e.event === 'AI 内部输出',
  ).length;
  const sends = activityEntries.filter(
    (e) => e.key === key && (e.event === '工具统一发送' || e.event === '工具发送表情'),
  ).length;

  const memory = {
    styleNotes: Array.isArray(conversation.styleNotes) ? conversation.styleNotes.length : 0,
    styleAvoid: Array.isArray(conversation.styleAvoid) ? conversation.styleAvoid.length : 0,
    fewshots: Array.isArray(conversation.fewshots) ? conversation.fewshots.length : 0,
    memberImpressions: Object.keys(conversation.memberImpressions ?? {}).length,
    affection: Object.keys(conversation.affection ?? {}).length,
    activeTopics: Array.isArray(conversation.activeTopics) ? conversation.activeTopics.length : 0,
  };

  const latencyStats = {
    n: latencies.length,
    meanSec: Number(mean(latencies).toFixed(1)),
    p50Sec: percentile(latencies, 50),
    p90Sec: percentile(latencies, 90),
    maxSec: Math.max(0, ...latencies),
    under5: latencies.filter((s) => s <= 5).length,
    from5to15: latencies.filter((s) => s > 5 && s <= 15).length,
    from15to60: latencies.filter((s) => s > 15 && s <= 60).length,
    over60: latencies.filter((s) => s > 60).length,
    proactive,
  };

  const metrics = {
    ok: true,
    key,
    generatedAt: new Date(now).toISOString(),
    window: {
      messages: messages.length,
      botTexts: botTexts.length,
      days,
      activityEntries: activityEntries.filter((e) => e.key === key).length,
    },
    turns: {
      humanRuns: turns.humanRuns,
      botRuns: turns.botRuns,
      humanMessages: turns.humanMessages,
      botMessages: turns.botMessages,
      replyRate: turns.replyRate,
      repliesPerHumanMessage: turns.repliesPerHumanMessage,
      answerGapMedianMs: turns.answerGapsMs.length ? percentile(turns.answerGapsMs, 50) : null,
      maxBurst: turns.maxBurst,
      burstHistogram: turns.burstHistogram,
      singleReplyShare: turns.singleReplyShare,
      strictAlternation: turns.strictAlternation,
    },
    length: {
      bot: lengthStats(botPlain),
      human: lengthStats(humanTexts),
    },
    toolTrace: {
      n: botTexts.length,
      hits: traceHits.length,
      rate: botTexts.length ? Number((traceHits.length / botTexts.length).toFixed(3)) : 0,
      samples: traceHits.slice(0, 5),
    },
    repeat: repeatedTexts(botTexts),
    latency: latencyStats,
    monologue: {
      internalOutputs,
      sends,
      ratio: sends + internalOutputs ? Number((internalOutputs / (sends + internalOutputs)).toFixed(3)) : 0,
      handoverHits: handoverLines.length,
      handoverSamples: handoverLines.slice(0, 3),
    },
    memory,
  };

  metrics.verdicts = verdictsFor(metrics);
  return metrics;
}

function verdict(level, id, text) {
  return { level, id, text };
}

export function verdictsFor(m) {
  const out = [];
  if (m.turns.replyRate >= 0.95) {
    out.push(verdict('bad', 'reply-rate', `必回率 ${Math.round(m.turns.replyRate * 100)}%：每个真人话轮都接，像乒乓反射`));
  } else if (m.turns.replyRate >= 0.85) {
    out.push(verdict('warn', 'reply-rate', `必回率 ${Math.round(m.turns.replyRate * 100)}%：仍然偏高，可以偶尔已读划走`));
  } else {
    out.push(verdict('good', 'reply-rate', `必回率 ${Math.round(m.turns.replyRate * 100)}%：有留白`));
  }

  if (m.toolTrace.hits > 0) {
    out.push(verdict('bad', 'tool-trace', `出站正文里有 ${m.toolTrace.hits} 条工具名/链接：正常聊天不会出现`));
  } else {
    out.push(verdict('good', 'tool-trace', '出站正文没有工具名/链接'));
  }

  const l = m.latency;
  if (l.n >= 5) {
    const band = (l.from5to15 + l.under5) / l.n;
    if (band >= 0.8) {
      out.push(verdict('warn', 'latency-band', `${Math.round(band * 100)}% 的回复落在 15 秒内：延迟带太窄，像定时器`));
    } else if (l.over60 / l.n >= 0.15) {
      out.push(verdict('good', 'latency-band', `${Math.round((l.over60 / l.n) * 100)}% 的回复超过 1 分钟：有真实停顿`));
    } else {
      out.push(verdict('warn', 'latency-band', '延迟有波动但长停顿偏少，可以再加一点「忙完才回」'));
    }
  }

  if (m.monologue.handoverHits > 0) {
    out.push(verdict('bad', 'handover', `内部输出里有 ${m.monologue.handoverHits} 句交接班日志（“这轮没有新消息/已读停在…”）`));
  } else if (m.monologue.internalOutputs > 0) {
    out.push(verdict('good', 'handover', '内部输出没有交接班腔'));
  }

  if (m.turns.maxBurst >= 3) {
    out.push(verdict('warn', 'burst', `单次最多连发 ${m.turns.maxBurst} 条：碎嘴分条`));
  }

  if (m.repeat.dupRate >= 0.15) {
    out.push(verdict('warn', 'repeat', `重复正文占 ${Math.round(m.repeat.dupRate * 100)}%：口头禅固化了`));
  }

  if (m.memory.fewshots < 10) {
    out.push(verdict('warn', 'fewshots', `例句只有 ${m.memory.fewshots} 条：场景覆盖不足`));
  }
  if (m.memory.memberImpressions === 0) {
    out.push(verdict('warn', 'impressions', '还没积累成员印象：它记不住这个人'));
  }
  return out;
}

// ---------- 报告 ----------

const ICON = { good: '🟢', warn: '🟡', bad: '🔴' };

function bar(label, value) {
  return `${label.padEnd(14, ' ')} ${value}`;
}

export function formatAuditReport(m) {
  if (!m?.ok) return `人味仪表盘\n${m?.error ?? '采集失败'}`;
  const lines = [];
  lines.push(`人味仪表盘 · ${m.key}`);
  lines.push(`窗口：最近 ${m.window.messages} 条消息 / 出站 ${m.window.botTexts} 条 / 活动日志 ${m.window.activityEntries} 行`);
  lines.push('');
  lines.push('[话轮]');
  lines.push(bar('真人话轮', m.turns.humanRuns));
  lines.push(bar('bot 话轮', m.turns.botRuns));
  lines.push(bar('必回率', `${Math.round(m.turns.replyRate * 100)}%`));
  lines.push(bar('每条真人消息', `${m.turns.repliesPerHumanMessage} 条 bot 消息`));
  lines.push(bar('最大连发', m.turns.maxBurst));
  lines.push(bar('单条占比', `${Math.round(m.turns.singleReplyShare * 100)}%`));
  lines.push('');
  lines.push('[句长]');
  lines.push(bar('bot', `均值 ${m.length.bot.mean} 字 / 中位 ${m.length.bot.p50} / p90 ${m.length.bot.p90}`));
  lines.push(bar('真人', `均值 ${m.length.human.mean} 字 / 中位 ${m.length.human.p50} / p90 ${m.length.human.p90}`));
  lines.push('');
  lines.push('[痕迹]');
  lines.push(bar('工具名/链接', `${m.toolTrace.hits} 条（${Math.round(m.toolTrace.rate * 100)}%）`));
  lines.push(bar('重复正文', `${Math.round(m.repeat.dupRate * 100)}%`));
  if (m.repeat.top.length) {
    lines.push(bar('', m.repeat.top.map((t) => `“${t.text}”×${t.count}`).join('，')));
  }
  lines.push('');
  lines.push('[延迟]');
  lines.push(
    bar(
      '秒差',
      `样本 ${m.latency.n} / 中位 ${m.latency.p50Sec}s / p90 ${m.latency.p90Sec}s / 最长 ${m.latency.maxSec}s`,
    ),
  );
  lines.push(
    bar(
      '分布',
      `≤5s ${m.latency.under5} · 5–15s ${m.latency.from5to15} · 15–60s ${m.latency.from15to60} · >60s ${m.latency.over60}`,
    ),
  );
  lines.push(bar('主动开口', m.latency.proactive));
  lines.push('');
  lines.push('[内部独白]');
  lines.push(bar('独白/发送', `${m.monologue.internalOutputs} / ${m.monologue.sends}（${Math.round(m.monologue.ratio * 100)}%）`));
  lines.push(bar('交接班句子', m.monologue.handoverHits));
  for (const sample of m.monologue.handoverSamples) {
    lines.push(`  · ${sample}`);
  }
  lines.push('');
  lines.push('[记忆]');
  lines.push(
    bar(
      '',
      `风格 ${m.memory.styleNotes} · 避免 ${m.memory.styleAvoid} · 例句 ${m.memory.fewshots} · 印象 ${m.memory.memberImpressions} · 关系 ${m.memory.affection} · 话题 ${m.memory.activeTopics}`,
    ),
  );
  lines.push('');
  lines.push('[判断]');
  for (const v of m.verdicts) lines.push(`${ICON[v.level]} ${v.text}`);
  return lines.join('\n');
}
