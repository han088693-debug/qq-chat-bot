// 出站文本的「别露机器味」闸门。
//
// 将内部工具标识转换为可读表述，避免把实现细节发送到聊天。
// 提示词之外增加确定性检查；不包含任何真实聊天样本。
//
// 设计取舍：
//  1. **改写优先，丢弃兜底**。直接丢整条会让模型以为自己发出去了，行为更诡异；
//     能替换成「那个」就替换，实在剩不下有效内容才丢，并把原因回传给调用方。
//  2. **纯函数**，不碰配置、不写日志。调用方决定怎么记录，这样测试不需要环境。
//  3. 只处理**工具标识**、**英文动词串**、**裸链接**三类机器痕迹；
//     不做语气改写（那是提示词和 fewshots 的事），避免越权修改模型的话。
//  4. 大小写不敏感，但保留原串其余部分——改写后的文本仍然是非空字符串时才算成功。

/** 已知工具名 → 人话。命中即替换，不区分大小写。 */
const TOOL_WORDS = new Map([
  ['heybox_post', '发帖'],
  ['heybox_reply', '回评论'],
  ['heybox_comment', '评论'],
  ['heybox_status', '小黑盒那边'],
  ['qq_send_message', '发消息'],
  ['qq_send_sticker', '发表情'],
  ['qq_get_unread_messages', '看未读'],
  ['qq_get_recent_messages', '翻聊天记录'],
  ['qq_mark_read', '已读'],
  ['qq_wait_for_messages', '等消息'],
  ['qq_get_prompt', '看设定'],
  ['qq_memory_append', '记事'],
  ['qq_knowledge_add', '记笔记'],
]);

/** 工具标识：mcp__服务器__方法、带前缀的 snake_case 名、B站 BV 号。 */
const TOOL_ID_RE = /\b(?:mcp__[a-z0-9_]+__[a-z0-9_]+|(?:qq|heybox|phone|iphone|bili|snowluma|web-search-safe)_[a-z0-9_]+|BV[0-9A-Za-z]{10})\b/gi;

/** 「用 / 拿 / 在 / 靠 + 工具名」→ 「用那个」，比直译自然。 */
const USE_BEFORE_TOOL_RE = /(用|拿|在|靠)\s*([a-z0-9_:]+)/gi;

/** 内部字段串：小黑盒状态串那种连续英文动词，≥3 个才算（避免误伤正常英文）。 */
const VERB_RUN_RE = /\b(?:feed|open|read|comment|like|post|reply|status|search|fetch|send|get|mark|view|list|recent|unread)(?:\s*[,，/]?\s+(?:feed|open|read|comment|like|post|reply|status|search|fetch|send|get|mark|view|list|recent|unread)){2,}\b/gi;

/** 裸链接（含 b23.tv / 图片直链）。只删 bot 自己说出来的链接。 */
const BARE_URL_RE = /\bhttps?:\/\/[^\s，。；、）)]+/gi;

/** 改写后剩这些就说明还有内容。「？」「…」单独一条在聊天里是有效回复，不能丢。 */
const MEANINGFUL_RE = /[\p{Script=Han}A-Za-z0-9？?！!…]/u;

function tidy(text, { collapseCjkSpace = false } = {}) {
  let out = text.replace(/[ \t]{2,}/g, ' ');
  // 替换工具名后常留下「回评论 有了」这种中日韩字之间的空格，中文里不该有。
  // 只在真的改写过之后才折叠，避免把用户/模型原本的空格断句也一并抹掉。
  if (collapseCjkSpace) {
    out = out.replace(/(?<=[\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, '');
  }
  return out
    .replace(/[，、]{2,}/g, '，')
    .replace(/^[，、.。:：;；\s]+/, '')
    .replace(/\s+([，。？！；：、])/g, '$1')
    .trim();
}

/**
 * 把一条出站文本洗成人话。
 *
 * @param {string} raw 模型生成的原文
 * @returns {{text: string, changed: boolean, dropped: boolean, reasons: string[]}}
 *   - text：改写后的文本（dropped 时为 ''）
 *   - changed：是否与原串不同
 *   - dropped：改写后已无有效内容，应当丢弃该条
 *   - reasons：命中的规则名，供日志/控制台统计
 */
export function sanitizeOutgoingText(raw) {
  const original = String(raw ?? '');
  if (!original.trim()) return { text: original, changed: false, dropped: false, reasons: [] };

  const reasons = [];
  let out = original;

  // 1) 「用 xxx_tool」→「用那个」。必须在逐词替换之前，
  //    否则 heybox_post 先被换成「发帖」，「用发帖」就又是机器腔。
  out = out.replace(USE_BEFORE_TOOL_RE, (match, verb, ident) => {
    if (!TOOL_ID_RE.test(ident)) return match;
    TOOL_ID_RE.lastIndex = 0;
    reasons.push('tool-reference');
    return `${verb}那个`;
  });
  TOOL_ID_RE.lastIndex = 0;

  // 2) 已知工具名 → 人话。
  out = out.replace(TOOL_ID_RE, (match) => {
    const mapped = TOOL_WORDS.get(match.toLowerCase());
    reasons.push(mapped ? 'tool-name' : 'tool-id');
    if (mapped) return mapped;
    const lower = match.toLowerCase();
    if (lower.startsWith('heybox_')) return '小黑盒';
    if (lower.startsWith('qq_')) return '聊天';
    if (lower.startsWith('mcp__') || lower.startsWith('phone_') || lower.startsWith('iphone_')
      || lower.startsWith('bili_') || lower.startsWith('snowluma_') || lower.startsWith('web-search-safe_')) {
      return '';
    }
    return ''; // BV 号等：念出来对聊天没有意义
  });

  // 3) 连续英文动词串（小黑盒状态串）→ 一句人话。
  out = out.replace(VERB_RUN_RE, () => {
    reasons.push('verb-run');
    return '发帖回评论那些功能';
  });

  // 4) 裸链接：真人几乎不会在聊天里贴长链接，尤其在「汇报」时。
  out = out.replace(BARE_URL_RE, () => {
    reasons.push('url');
    return '';
  });

  out = tidy(out, { collapseCjkSpace: reasons.length > 0 });

  if (!MEANINGFUL_RE.test(out)) {
    return { text: '', changed: true, dropped: true, reasons: [...new Set(reasons)] };
  }
  return { text: out, changed: out !== original, dropped: false, reasons: [...new Set(reasons)] };
}

/**
 * 批量版：给一次回复里的多条气泡做整体清洗。
 * 丢弃的气泡不进结果，但会记在 dropped 里，方便调用方在响应里告知模型。
 *
 * @param {string[]} messages
 */
export function sanitizeOutgoingMessages(messages) {
  const out = [];
  const dropped = [];
  const reasons = [];
  for (const raw of Array.isArray(messages) ? messages : []) {
    const res = sanitizeOutgoingText(raw);
    if (res.dropped) {
      dropped.push({ text: String(raw ?? ''), reasons: res.reasons });
      reasons.push(...res.reasons);
    } else {
      out.push(res.text);
      if (res.changed) reasons.push(...res.reasons);
    }
  }
  return { messages: out, dropped, reasons: [...new Set(reasons)] };
}
