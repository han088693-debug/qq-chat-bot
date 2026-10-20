// 私聊专用改进的离线回归：提醒库、发送去重、图片预处理、记忆整理解析。
// 全部跑在 audit-bridge-harness 的临时目录里，不碰生产 config / state / QQ。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'private:123';

test('提醒库：加、查、到点、只触发一次、取消', async () => {
  const bridge = await bridgeHarness();
  try {
    const t0 = Date.now();
    const added = bridge.reminderStore.add({ key: KEY, text: '提醒他喝口水', dueAt: t0 + 1000 }, t0);
    assert.equal(added.ok, true);
    assert.ok(added.item && added.item.id, '应返回带 id 的提醒');
    assert.equal(bridge.reminderStore.list(KEY).length, 1);
    assert.equal(bridge.reminderStore.due(t0).length, 0, '没到点不应出现在 due 里');

    const due = bridge.reminderStore.due(t0 + 2000);
    assert.equal(due.length, 1);
    assert.equal(bridge.reminderStore.markFired(added.item.id, t0 + 2000), true);
    assert.equal(bridge.reminderStore.list(KEY).length, 0, '已触发的不该留在待办里');
    assert.equal(bridge.reminderStore.due(t0 + 60_000).length, 0, '已触发的不能重复到点');
    assert.equal(bridge.reminderStore.lastFired(KEY, 10 * 60_000, t0 + 60_000).length, 1, '刚触发的内容要能被唤醒提示取到');

    const second = bridge.reminderStore.add({ key: KEY, text: '再说一句', dueAt: t0 + 5000 }, t0);
    assert.equal(second.ok, true);
    const cancelled = bridge.reminderStore.cancel(KEY, second.item.id, t0);
    assert.equal(cancelled.ok, true);
    assert.equal(bridge.reminderStore.list(KEY).length, 0, '取消后不应再出现');
    assert.equal(bridge.reminderStore.cancel(KEY, second.item.id, t0).ok, false, '重复取消应失败');
    assert.equal(bridge.reminderStore.cancel('private:456', second.item.id, t0).ok, false, '不能取消别的会话的提醒');
  } finally {
    await bridge.close();
  }
});

test('提醒库：空内容/过去时间/数量上限都被挡住，超长文本被裁剪', async () => {
  const bridge = await bridgeHarness();
  try {
    const t0 = Date.now();
    assert.equal(bridge.reminderStore.add({ key: KEY, text: '', dueAt: t0 + 1000 }, t0).ok, false, '空内容应拒绝');
    assert.equal(bridge.reminderStore.add({ key: '', text: 'x', dueAt: t0 + 1000 }, t0).ok, false, '空 key 应拒绝');
    assert.equal(bridge.reminderStore.add({ key: KEY, text: '过去', dueAt: t0 - 120_000 }, t0).ok, false, '过去时间应拒绝');
    assert.equal(bridge.reminderStore.add({ key: KEY, text: '太远', dueAt: t0 + 61 * 24 * 3600_000 }, t0).ok, false, '超 60 天应拒绝');

    const long = bridge.reminderStore.add({ key: KEY, text: 'x'.repeat(500), dueAt: t0 + 1000 }, t0);
    assert.equal(long.ok, true);
    assert.equal(long.item.text.length, 200, '超长文本裁剪到 200 字而不是整条拒绝');
    bridge.reminderStore.cancel(KEY, long.item.id, t0);

    for (let i = 0; i < 20; i += 1) {
      assert.equal(bridge.reminderStore.add({ key: KEY, text: `第${i}条`, dueAt: t0 + (i + 1) * 1000 }, t0).ok, true);
    }
    const overflow = bridge.reminderStore.add({ key: KEY, text: '第21条', dueAt: t0 + 99_000 }, t0);
    assert.equal(overflow.ok, false);
    assert.match(overflow.error, /上限/);
    assert.equal(bridge.reminderStore.list(KEY).length, 20);
  } finally {
    await bridge.close();
  }
});

test('发送去重：20 秒窗口内同文只发一次，空白与大小写不影响判定', async () => {
  const bridge = await bridgeHarness();
  try {
    const t0 = Date.now();
    assert.equal(bridge.isDuplicateSendV2(KEY, '在的在的', t0), false, '第一次不算重复');
    bridge.noteSentV2(KEY, '在的在的', t0);
    assert.equal(bridge.isDuplicateSendV2(KEY, '  在的 在的 ', t0 + 5000), true, '空白差异仍算同一条');
    assert.equal(bridge.isDuplicateSendV2(KEY, '在的在的', t0 + 21_000), false, '窗口外可以再发');
    assert.equal(bridge.isDuplicateSendV2('private:456', '在的在的', t0 + 5000), false, '不同会话互不影响');
    bridge.noteSentV2(KEY, 'Hello', t0);
    assert.equal(bridge.isDuplicateSendV2(KEY, 'hello', t0 + 1000), true, '大小写差异仍算同一条');
  } finally {
    await bridge.close();
  }
});

test('图片预处理：小图原样返回，压缩失败不挡发送', async () => {
  const bridge = await bridgeHarness();
  try {
    const small = Buffer.from('not-a-real-image');
    const same = await bridge.prepareImageForModel(small, 'image/png');
    assert.equal(same.buffer, small, '低于阈值应原样返回');
    assert.equal(same.mimeType, 'image/png');

    // 超大 + ffmpeg 桩成失败：必须回退原图，不能抛。
    const big = Buffer.alloc(bridge.IMAGE_INLINE_MAX_BYTES + 1024, 7);
    const fallback = await bridge.prepareImageForModel(big, 'image/jpeg');
    assert.equal(fallback.buffer, big, '压缩不可用时应回退原图');
    assert.equal(fallback.mimeType, 'image/jpeg');
  } finally {
    await bridge.close();
  }
});

test('记忆整理：提示词包含规则与标签，解析只保留去重后的短句且不超过上限', async () => {
  const bridge = await bridgeHarness();
  try {
    const cfg = bridge.memoryConsolidationConfig();
    assert.equal(cfg.enabled, true);
    assert.ok(cfg.minTraits >= 4 && cfg.maxTraits >= 2 && cfg.maxTraits <= 8);

    const prompt = bridge.buildMemoryConsolidationPrompt({
      target: '群友A',
      traits: ['爱喝冰美式', '经常熬夜', '在玩原神'],
      maxTraits: 2,
    });
    assert.match(prompt, /只做合并/);
    assert.match(prompt, /"traits"/);
    assert.ok(prompt.includes('- 爱喝冰美式'));

    const longLine = `熬夜写代码${'很长'.repeat(40)}`;
    const parsed = bridge.parseMemoryConsolidationJson(
      `好的：\`\`\`json\n{"traits":[" 爱喝冰美式 ","经常熬夜","爱喝冰美式","","${longLine}"]}\n\`\`\``,
      3,
    );
    assert.equal(parsed.length, 3);
    assert.equal(parsed[0], '爱喝冰美式');
    assert.equal(parsed[1], '经常熬夜');
    assert.ok(parsed.every((line) => line.length <= 50), '单条不超过 50 字');
    assert.equal(bridge.parseMemoryConsolidationJson('不是 JSON', 3).length, 0, '非 JSON 应返回空数组');
  } finally {
    await bridge.close();
  }
});
