// 唤醒提示注入角色卡：端到端验证（真实 bridge 投递路径 + 临时角色文件）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'private:123';

async function fixture(run) {
  const h = await bridgeHarness({
    config: { socialV2: { roleOverrides: { [KEY]: '测试卡' } } },
    files: {
      'roles/测试卡.md': '# 测试卡\n\n你是测试卡。\n\n## 六、这个人（只有你知道）\n\n锚只有一条：测试卡正文标记XYZ。\n',
      'roles/换卡.md': '# 换卡\n\n换卡正文标记ABC。\n',
      'state/current-role.json': JSON.stringify({ role: '测试卡', mode: 'active' }),
    },
  });
  h.setMode('reserved2');
  try {
    await run(h);
  } finally {
    await h.close();
  }
}

function promptTextOf(call) {
  return call.content.map((part) => part.text || '').join('\n');
}

test('bootstrap 注入角色卡正文，随后同卡不再重复注入', () => fixture(async (h) => {
  const bootstrap = h.buildWakePromptV2(KEY, 'bootstrap');
  assert.match(bootstrap, /【当前角色】测试卡\n\n# 测试卡/, 'bootstrap 角色行后应紧跟卡正文');
  assert.ok(bootstrap.includes('锚只有一条：测试卡正文标记XYZ'), 'bootstrap 应带卡正文');
  assert.ok(!bootstrap.includes('完整角色卡请调用 qq_get_prompt 查看'), '卡已注入时不应再让模型去取卡');

  const before = h.calls.prompts.length;
  await h.deliverPrompt(KEY, 'ignored', { wakeReason: 'bootstrap' });
  assert.equal(h.calls.prompts.length, before + 1);
  const first = promptTextOf(h.calls.prompts[before]);
  assert.ok(first.includes('锚只有一条：测试卡正文标记XYZ'), '真实投递的 prompt 应带卡正文');
  assert.match(first, /【当前角色】测试卡\n\n# 测试卡/);

  const record = JSON.parse(fs.readFileSync(path.join(h.temp, 'state', 'wake-role-injections.json'), 'utf8'));
  assert.ok(record[KEY], '投递成功后应记录注入状态');
  assert.ok(record[KEY].sha, '记录应包含卡片 SHA');
  assert.ok(record[KEY].sessionId, '记录应包含 sessionId');

  const second = h.buildWakePromptV2(KEY, 'timeout');
  assert.ok(!second.includes('锚只有一条：测试卡正文标记XYZ'), '同卡第二次唤醒不应重复注入正文');
  assert.match(second, /【当前角色】测试卡（角色卡已注入/, '第二次唤醒应保留“已注入”提示');
  assert.match(second, /qq_get_prompt/, '短行仍应告诉模型可调 qq_get_prompt 看工具和状态');

  await h.deliverPrompt(KEY, 'ignored', { wakeReason: 'timeout' });
  const secondDelivered = promptTextOf(h.calls.prompts[h.calls.prompts.length - 1]);
  assert.ok(!secondDelivered.includes('锚只有一条：测试卡正文标记XYZ'), '第二次真实投递也不应重复注入');
  assert.match(secondDelivered, /【当前角色】测试卡（角色卡已注入/);
}));

test('换角色或改卡后重新注入', () => fixture(async (h) => {
  await h.deliverPrompt(KEY, 'ignored', { wakeReason: 'bootstrap' });
  assert.ok(promptTextOf(h.calls.prompts.at(-1)).includes('测试卡正文标记XYZ'));

  // 换角色：override 指向另一张卡。
  h.cfg.socialV2.roleOverrides[KEY] = '换卡';
  const switched = h.buildWakePromptV2(KEY, 'timeout');
  assert.ok(switched.includes('换卡正文标记ABC'), '换角色后应注入新卡');
  await h.deliverPrompt(KEY, 'ignored', { wakeReason: 'timeout' });
  assert.ok(promptTextOf(h.calls.prompts.at(-1)).includes('换卡正文标记ABC'));

  // 改卡：同一角色名，内容变化（SHA 变化）也应重新注入。
  fs.writeFileSync(path.join(h.temp, 'roles', '换卡.md'), '# 换卡\n\n换卡正文标记ABC2。\n');
  const edited = h.buildWakePromptV2(KEY, 'timeout');
  assert.ok(edited.includes('换卡正文标记ABC2'), '改卡后应注入新正文');
  await h.deliverPrompt(KEY, 'ignored', { wakeReason: 'timeout' });
  assert.ok(promptTextOf(h.calls.prompts.at(-1)).includes('换卡正文标记ABC2'));

  // 再次唤醒：内容没再变，回到短行。
  await h.deliverPrompt(KEY, 'ignored', { wakeReason: 'timeout' });
  const settled = promptTextOf(h.calls.prompts.at(-1));
  assert.ok(!settled.includes('换卡正文标记ABC2'), '内容未变时不应反复注入');
  assert.match(settled, /【当前角色】换卡（角色卡已注入/);
}));
