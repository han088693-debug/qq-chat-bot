// 离线自测：style-learner 的 prompt / 解析 / 合并 / 注入（不启动桥接、不碰网络）。
// 运行：node scripts/test-style-learner.mjs
import assert from 'node:assert/strict';
import {
  buildStyleLearningPrompt,
  parseStyleLearningJson,
  applyStyleLearning,
  formatStyleInjection,
  STYLE_MAX,
  FEWSHOT_MAX
} from '../src/style-learner.js';

const ok = (name, fn) => {
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (error) {
    console.error(`❌ ${name}: ${error?.message ?? error}`);
    process.exitCode = 1;
  }
};

const messages = [
  { sender: '测试用户甲', text: '今天我们测试简短回复', time: 1 },
  { isSelf: true, text: '收到这条测试消息', time: 2 },
  { sender: '测试用户乙', text: '下一条也是合成内容', time: 3 }
];

ok('prompt 带转写与 JSON 契约', () => {
  const prompt = buildStyleLearningPrompt({ messages, knownStyle: ['用简短句子回答'] });
  assert.match(prompt, /\[测试用户甲\] 今天我们测试简短回复/);
  assert.match(prompt, /\[我\] 收到这条测试消息/);
  assert.match(prompt, /只输出 JSON/);
  assert.match(prompt, /已有风格/);
});

ok('prompt 清洗尖括号与换行', () => {
  const prompt = buildStyleLearningPrompt({ messages: [{ sender: '<b>', text: 'a\nb' }] });
  assert.ok(!prompt.includes('<b>'));
  assert.ok(!/[^\n]a\nb/.test(prompt));
});

ok('解析带解释文字/代码块的 JSON', () => {
const raw = '```json\n{"style":["用简短句子回答"],"avoid":["避免重复措辞"],"fewshot":[{"user":"示例问题","bot":"示例回答"}],"affection":[{"name":"测试用户甲","note":"合成测试标签","score":2}]}\n```';
  const parsed = parseStyleLearningJson(raw);
  assert.deepEqual(parsed.style, ['用简短句子回答']);
  assert.deepEqual(parsed.avoid, ['避免重复措辞']);
  assert.equal(parsed.fewshot.length, 1);
  assert.deepEqual(parsed.affection[0], { name: '测试用户甲', note: '合成测试标签', score: 2 });
});

ok('非法输出返回空结构', () => {
  assert.deepEqual(parseStyleLearningJson('没有 JSON'), { style: [], avoid: [], fewshot: [], affection: [] });
  assert.deepEqual(parseStyleLearningJson(''), { style: [], avoid: [], fewshot: [], affection: [] });
});

ok('合并去重/裁剪/好感上限', () => {
  const st = {};
  const r1 = applyStyleLearning(st, { style: ['简短句子', '合成风格', '简短句子'], avoid: [], fewshot: [{ user: '示例问题', bot: '示例回答' }], affection: [{ name: 'A', note: '合成测试标签', score: 9 }] });
  assert.equal(r1.style, 2);
  assert.equal(st.affection.A.score, 5);
  const r2 = applyStyleLearning(st, { style: ['简短句子'], avoid: [], fewshot: [{ user: '示例问题', bot: '示例回答' }], affection: [] });
  assert.equal(r2.style, 0);
  assert.equal(r2.fewshot, 0);
  for (let i = 0; i < 30; i += 1) applyStyleLearning(st, { style: [`s${i}`], avoid: [], fewshot: [{ user: `u${i}`, bot: 'b' }], affection: [] });
  assert.equal(st.styleNotes.length, STYLE_MAX);
  assert.equal(st.fewshots.length, FEWSHOT_MAX);
});

ok('注入只含已有内容并受长度限制', () => {
  const st = {};
  applyStyleLearning(st, { style: ['用简短句子回答'], avoid: ['避免重复措辞'], fewshot: [{ user: '示例问题', bot: '示例回答' }], affection: [{ name: '测试用户甲', note: '合成测试标签', score: 2 }] });
  const text = formatStyleInjection(st, 1000);
  assert.match(text, /【学到的说话风格（本群）】/);
  assert.match(text, /测试用户甲：合成测试标签（好感 \+2）/);
  assert.ok(formatStyleInjection({}, 1000) === '');
  const cut = formatStyleInjection(st, 30);
  assert.ok(cut.length <= 30);
});

console.log('done');
