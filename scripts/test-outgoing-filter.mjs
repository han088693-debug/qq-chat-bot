// 出站文本「别露机器味」闸门测试。
// 验证：
// 1. 合成工具标识样本被改写为可读表述；
// 2. 正常中文聊天一个字节都不动（不能因为过滤把话说没了）；
// 3. 只剩工具名/链接的气泡会被丢弃，而不是发出去；
// 4. 改写是幂等的（重复过闸不会继续变形）。
import { sanitizeOutgoingText, sanitizeOutgoingMessages } from '../src/outgoing-filter.mjs';

let failed = 0;
function assert(cond, label, extra) {
  if (cond) {
    console.log(`✅ ${label}`);
  } else {
    console.error(`❌ ${label}${extra === undefined ? '' : ` → ${JSON.stringify(extra)}`}`);
    failed = 1;
  }
}

// 1. 合成样本（不包含真实聊天记录）
const leaks = [
  ['操作用 heybox_post，附上测试文字', '操作用那个，附上测试文字'],
  ['测试功能 feed open read comment like post reply status', '测试功能发帖回评论那些功能'],
  ['heybox_reply 可以测试了', '回评论可以测试了'],
];
for (const [input, expected] of leaks) {
  const res = sanitizeOutgoingText(input);
  assert(res.text === expected, `改写「${input}」`, res);
  assert(!/heybox|feed|mcp__/i.test(res.text), `改写后不再含工具名：${input}`, res.text);
}

// 2. 正常中文不误伤
const normal = [
  '嗯',
  '早点睡',
  '今天发了1篇帖，评论1条',
  '我在看那个视频',
  '行吧 那你去忙',
  '没呢',
  '？',
  '看得见',
  'BV 号我不会念',
];
for (const input of normal) {
  const res = sanitizeOutgoingText(input);
  assert(res.text === input && res.changed === false, `原样保留「${input}」`, res);
}

// 3. 只有机器痕迹的气泡 → 丢弃
const shouldDrop = [
  'mcp__iphone__screenshot_file',
  'https://example.com/a/b',
  'BV1xx411c7mD',
];
for (const input of shouldDrop) {
  const res = sanitizeOutgoingText(input);
  assert(res.dropped === true && res.text === '', `丢弃「${input}」`, res);
}

// 4. 链接被摘掉但句子保留
const urlCase = sanitizeOutgoingText('看这个 https://b23.tv/abc123 挺好');
assert(!/https?:/.test(urlCase.text) && urlCase.text.includes('挺好'), '去掉裸链接、保留句子', urlCase);

// 5. 幂等
for (const [input] of leaks) {
  const once = sanitizeOutgoingText(input).text;
  const twice = sanitizeOutgoingText(once).text;
  assert(once === twice, `幂等：${input}`, { once, twice });
}

// 6. 批量版：丢弃的条目单独记
const batch = sanitizeOutgoingMessages(['早点睡', 'mcp__iphone__tap', 'heybox_post 我会了']);
assert(batch.messages.length === 2, '批量版保留 2 条', batch);
assert(batch.dropped.length === 1, '批量版记录 1 条丢弃', batch);
assert(batch.reasons.includes('tool-id') || batch.reasons.includes('tool-name'), '批量版汇总命中的规则', batch.reasons);

process.exit(failed ? 1 : 0);
