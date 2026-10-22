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
  { sender: '示例角色2', text: '我去你咋能用了woc', time: 1 },
  { isSelf: true, text: '？我吃的是 token，不是白饭', time: 2 },
  { sender: '示例角色乙', text: '草，这也行', time: 3 }
];

ok('prompt 带转写与 JSON 契约', () => {
  const prompt = buildStyleLearningPrompt({ messages, knownStyle: ['句子很短'] });
  assert.match(prompt, /\[示例角色2\] 我去你咋能用了woc/);
  assert.match(prompt, /\[我\] \？我吃的是 token/);
  assert.match(prompt, /只输出 JSON/);
  assert.match(prompt, /已有风格/);
});

ok('prompt 清洗尖括号与换行', () => {
  const prompt = buildStyleLearningPrompt({ messages: [{ sender: '<b>', text: 'a\nb' }] });
  assert.ok(!prompt.includes('<b>'));
  assert.ok(!/[^\n]a\nb/.test(prompt));
});

ok('解析带解释文字/代码块的 JSON', () => {
  const raw = '好的，我学到了：\n```json\n{"style":["群友爱用草表示无语"],"avoid":["不要长篇大论"],"fewshot":[{"user":"这也行？","bot":"草，行吧"}],"affection":[{"name":"示例角色2","note":"爱吐槽","score":2}]}\n```';
  const parsed = parseStyleLearningJson(raw);
  assert.deepEqual(parsed.style, ['群友爱用草表示无语']);
  assert.deepEqual(parsed.avoid, ['不要长篇大论']);
  assert.equal(parsed.fewshot.length, 1);
  assert.deepEqual(parsed.affection[0], { name: '示例角色2', note: '爱吐槽', score: 2 });
});

ok('非法输出返回空结构', () => {
  assert.deepEqual(parseStyleLearningJson('没有 JSON'), { style: [], avoid: [], fewshot: [], affection: [], impressions: [] });
  assert.deepEqual(parseStyleLearningJson(''), { style: [], avoid: [], fewshot: [], affection: [], impressions: [] });
});

ok('解析并合并 impressions（事实性印象，进 memberImpressions.traits）', () => {
  const raw = '{"impressions":[{"name":"示例角色2","trait":"在玩血源诅咒"},{"name":"示例角色2","trait":"在玩血源诅咒"},{"name":"","trait":"空名丢弃"},{"name":"示例角色乙","note":"在准备考试"}]}';
  const parsed = parseStyleLearningJson(raw);
  assert.deepEqual(parsed.impressions, [
    { name: '示例角色2', trait: '在玩血源诅咒' },
    { name: '示例角色2', trait: '在玩血源诅咒' },
    { name: '示例角色乙', trait: '在准备考试' }
  ]);
  const st = {};
  const counts = applyStyleLearning(st, parsed, 1000);
  assert.equal(counts.impressions, 2);
  assert.deepEqual(st.memberImpressions['示例角色2'].traits, ['在玩血源诅咒']);
  assert.equal(st.memberImpressions['示例角色2'].lastSeenAt, 1000);
  // 重复印象不新增，但 lastSeenAt 会刷新
  const again = applyStyleLearning(st, parsed, 2000);
  assert.equal(again.impressions, 0);
  assert.deepEqual(st.memberImpressions['示例角色2'].traits, ['在玩血源诅咒']);
  assert.equal(st.memberImpressions['示例角色2'].lastSeenAt, 2000);
  // traits 上限 10 条，最旧的被挤掉
  for (let i = 0; i < 15; i += 1) {
    applyStyleLearning(st, { impressions: [{ name: '示例角色2', trait: `事实${i}` }] }, 3000 + i);
  }
  assert.equal(st.memberImpressions['示例角色2'].traits.length, 10);
  assert.equal(st.memberImpressions['示例角色2'].traits.at(-1), '事实14');
  // 危险键与超长 trait 在合并阶段被处理（解析阶段只做裁剪）
  const risky = parseStyleLearningJson(JSON.stringify({
    impressions: [{ name: '__proto__', trait: 'x' }, { name: '甲', trait: '数'.repeat(120) }]
  }));
  assert.equal(risky.impressions.length, 2);
  const st2 = {};
  applyStyleLearning(st2, risky, 4000);
  assert.ok(!Object.prototype.hasOwnProperty.call(st2.memberImpressions, '__proto__'));
  assert.equal(st2.memberImpressions['甲'].traits[0].length, 50);
});

ok('合并去重/裁剪/好感上限', () => {
  const st = {};
  const r1 = applyStyleLearning(st, { style: ['a', 'a', 'b'], avoid: [], fewshot: [{ user: 'u', bot: 'b' }], affection: [{ name: 'A', note: 'n1', score: 9 }] });
  assert.equal(r1.style, 2);
  assert.equal(st.affection.A.score, 5);
  const r2 = applyStyleLearning(st, { style: ['a'], avoid: [], fewshot: [{ user: 'u', bot: 'b' }], affection: [] });
  assert.equal(r2.style, 0);
  assert.equal(r2.fewshot, 0);
  for (let i = 0; i < 30; i += 1) applyStyleLearning(st, { style: [`s${i}`], avoid: [], fewshot: [{ user: `u${i}`, bot: 'b' }], affection: [] });
  assert.equal(st.styleNotes.length, STYLE_MAX);
  assert.equal(st.fewshots.length, FEWSHOT_MAX);
});

ok('注入只含已有内容并受长度限制', () => {
  const st = {};
  applyStyleLearning(st, { style: ['短句'], avoid: ['别说教'], fewshot: [{ user: 'u', bot: 'b' }], affection: [{ name: '示例角色2', note: '爱吐槽', score: 2 }] });
  const text = formatStyleInjection(st, 1000);
  assert.match(text, /【学到的说话风格（本群）】/);
  assert.match(text, /示例角色2：爱吐槽（好感 \+2）/);
  assert.ok(formatStyleInjection({}, 1000) === '');
  const cut = formatStyleInjection(st, 30);
  assert.ok(cut.length <= 30);
});

console.log('done');
