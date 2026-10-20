// 群聊 @ 回复概率：正常 93%，同一人短时间内重复 @ 75%，管理员/私聊 100%。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'group:456';
const SELF = '10001';

function atEvent(userId) {
  return {
    user_id: userId,
    self_id: SELF,
    sender: { user_id: userId },
    message: [{ type: 'at', data: { qq: SELF } }]
  };
}

test('normal @ 93%, repeated same-sender @ 75%, owner always replies', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    const st = h.getSocialV2State(KEY);
    Object.assign(st.wakeConfig.triggers, {
      atMention: true,
      anyMessage: false,
      nameMention: false,
      question: true,
      keywords: [],
      probability: 0
    });
    const evalAt = (event, rng) => h.evaluateWakeTriggerV2(
      KEY, st, event, 'group', '在吗', '在吗', false, rng
    );

    // 正常 @：0.93 是分界线；低于它回复，高于它静默。
    assert.equal(evalAt(atEvent(1), () => 0.92), 'atMention');
    // 不回复时不能继续落到 question 触发上。
    assert.equal(evalAt(atEvent(2), () => 0.94), null);

    // 同一人连续 @：第一次按正常 93%，之后按 75%。
    assert.equal(evalAt(atEvent(3), () => 0.0), 'atMention');
    assert.equal(evalAt(atEvent(3), () => 0.74), 'atMention');
    assert.equal(evalAt(atEvent(3), () => 0.76), null);

    // 换一个人 @ 仍按正常 93%。
    assert.equal(evalAt(atEvent(4), () => 0.94), null);
    assert.equal(evalAt(atEvent(6), () => 0.92), 'atMention');

    // 管理员始终回复，不受概率影响。
    assert.equal(evalAt(atEvent(123), () => 0.999), 'atMention');

    // 超过重复窗口后恢复 93%。
    st.lastAtMention = { senderId: '5', at: Date.now() - 130000, count: 2 };
    assert.equal(evalAt(atEvent(5), () => 0.94), null);
    assert.equal(evalAt(atEvent(7), () => 0.92), 'atMention');
  } finally {
    await h.close();
  }
});
