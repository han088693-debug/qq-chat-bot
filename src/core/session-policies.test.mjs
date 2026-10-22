// Unit tests for the config → router translation (no bridge, no IO).
// 运行：node --test src/core/session-policies.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSessionRouterFromOverrides, sessionPolicyFingerprint } from './session-policies.mjs';

const OWNER = 10001;
const OWNER_KEY = `private:${OWNER}`;
const OTHER_KEY = 'private:10002';

test('no overrides: behaviour is unchanged (default mode, no per-key model/effort)', () => {
  const router = buildSessionRouterFromOverrides({ ownerQQ: OWNER, currentMode: 'reserved2', overrides: {} });
  const policy = router.policyFor(OWNER_KEY);
  assert.equal(policy.mode, 'simulation'); // reserved2 在 router 内部规范化为 simulation
  assert.equal(policy.preset, 'qq-chat-v2'); // 本机安装的仿真 preset，而不是 QSH 默认名
  assert.equal(policy.hasOverride, false);
  assert.equal(policy.model, null);
  assert.equal(policy.reasoningEffort, null);
  // 群聊会话同样走默认（这条链路其实只服务私聊，但路由层不该假设）
  assert.equal(router.policyFor('group:987654').hasOverride, false);
});

test('model/effort-only override inherits the mode and its first preset', () => {
  const router = buildSessionRouterFromOverrides({
    ownerQQ: OWNER,
    currentMode: 'reserved2',
    overrides: { [OWNER_KEY]: { model: 'deepseek-v4-pro', reasoningEffort: 'max' } },
  });
  const policy = router.policyFor(OWNER_KEY);
  assert.equal(policy.mode, 'reserved2');
  assert.equal(policy.preset, 'qq-chat-v2');
  assert.equal(policy.model, 'deepseek-v4-pro');
  assert.equal(policy.reasoningEffort, 'max');
  assert.equal(policy.hasOverride, true);
  // 覆盖只影响这一个会话
  assert.equal(router.policyFor(OTHER_KEY).hasOverride, false);
  assert.equal(router.policyFor(OTHER_KEY).model, null);
});

test('group override can pin a different effort without touching private chat', () => {
  const router = buildSessionRouterFromOverrides({
    ownerQQ: OWNER,
    currentMode: 'reserved2',
    overrides: { 'group:987654': { reasoningEffort: 'low' } },
  });
  assert.equal(router.policyFor('group:987654').reasoningEffort, 'low');
  assert.equal(router.policyFor(OWNER_KEY).reasoningEffort, null);
});

test('unknown preset for the mode is refused, not silently swapped', () => {
  assert.throws(
    () => buildSessionRouterFromOverrides({
      ownerQQ: OWNER,
      currentMode: 'reserved2',
      overrides: { [OWNER_KEY]: { preset: 'standard' } },
    }),
    /unknown or unsafe preset/,
  );
});

test('closed-agent is only ever granted to the owner private conversation', () => {
  assert.throws(
    () => buildSessionRouterFromOverrides({
      ownerQQ: OWNER,
      currentMode: 'reserved2',
      overrides: { [OTHER_KEY]: { mode: 'closed-agent' } },
    }),
    /restricted to the owner private conversation/,
  );
  // owner 自己那条：允许，且默认 preset 取该 mode 的第一项
  const router = buildSessionRouterFromOverrides({
    ownerQQ: OWNER,
    currentMode: 'reserved2',
    overrides: { [OWNER_KEY]: { mode: 'closed-agent' } },
  });
  assert.equal(router.policyFor(OWNER_KEY).mode, 'closed-agent');
  assert.equal(router.policyFor(OWNER_KEY).preset, 'qsh-closed');
  assert.equal(router.modeAllowsKey(OWNER_KEY), true);
});

test('malformed override entries are refused instead of ignored', () => {
  assert.throws(() => buildSessionRouterFromOverrides({ ownerQQ: OWNER, currentMode: 'reserved2', overrides: [] }), /must be an object/);
  assert.throws(
    () => buildSessionRouterFromOverrides({ ownerQQ: OWNER, currentMode: 'reserved2', overrides: { [OWNER_KEY]: { mode: 'nonsense' } } }),
    /unknown mode/,
  );
});

test('fingerprint changes when an override appears, so the session is rebuilt on purpose', () => {
  const plain = buildSessionRouterFromOverrides({ ownerQQ: OWNER, currentMode: 'reserved2', overrides: {} });
  const pinned = buildSessionRouterFromOverrides({
    ownerQQ: OWNER,
    currentMode: 'reserved2',
    overrides: { [OWNER_KEY]: { reasoningEffort: 'max' } },
  });
  assert.notEqual(plain.policyFingerprint(OWNER_KEY), pinned.policyFingerprint(OWNER_KEY));
});

// 回归：第 4 项（override 指纹）曾经被无条件追加成空串，导致所有历史三元组指纹失配，
// 下一条消息退役并重建 DSH 会话 —— 10:14 那次上下文清零就是这么发生的。
test('no override keeps the legacy THREE-element fingerprint byte-for-byte', () => {
  assert.equal(
    sessionPolicyFingerprint({ mode: 'reserved2', preset: 'qq-chat-v2', ownerQQ: OWNER }),
    JSON.stringify(['reserved2', 'qq-chat-v2', null]),
  );
  // preset 缺失时也保持三元素（空串占位，与旧实现一致）
  assert.equal(
    sessionPolicyFingerprint({ mode: 'chat', preset: null }),
    JSON.stringify(['chat', '', null]),
  );
});

test('closed-agent puts the owner in the third slot; other modes ignore ownerQQ', () => {
  assert.equal(
    sessionPolicyFingerprint({ mode: 'closed-agent', preset: 'qsh-closed', ownerQQ: OWNER }),
    JSON.stringify(['closed-agent', 'qsh-closed', OWNER]),
  );
  assert.equal(
    sessionPolicyFingerprint({ mode: 'reserved2', preset: 'qq-chat-v2', ownerQQ: OWNER }),
    JSON.stringify(['reserved2', 'qq-chat-v2', null]),
  );
});

test('an override appends exactly one element and is otherwise stable', () => {
  const override = { mode: 'simulation', preset: 'qq-chat-v2', model: 'deepseek-flash', reasoningEffort: 'high' };
  const withOverride = sessionPolicyFingerprint({ mode: 'reserved2', preset: 'qq-chat-v2', ownerQQ: OWNER, override });
  assert.equal(
    withOverride,
    JSON.stringify(['reserved2', 'qq-chat-v2', null, JSON.stringify(['simulation', 'qq-chat-v2', 'deepseek-flash', 'high'])]),
  );
  // 同样输入必须逐字节可复现，否则每次启动都会退役会话
  assert.equal(
    withOverride,
    sessionPolicyFingerprint({ mode: 'reserved2', preset: 'qq-chat-v2', ownerQQ: OWNER, override: { ...override } }),
  );
  assert.notEqual(withOverride, sessionPolicyFingerprint({ mode: 'reserved2', preset: 'qq-chat-v2', ownerQQ: OWNER }));
});
