import assert from 'node:assert/strict';
import { composeRoleLine, roleCardRecordMatches, shouldInjectRoleCard } from '../src/wake-role-card.mjs';

const card = '# 测试卡\n\n正文';
const rec = { role: 'fixture-long-role-name', sha: 'a'.repeat(64), sessionId: 's1' };

assert.equal(roleCardRecordMatches(rec, { roleName: 'fixture-long-role-name', sha: 'a'.repeat(64), sessionId: 's1' }), true);
assert.equal(roleCardRecordMatches(rec, { roleName: 'fixture-long-role-name', sha: 'a'.repeat(64), sessionId: 's2' }), false);
assert.equal(roleCardRecordMatches(rec, { roleName: '别的', sha: 'a'.repeat(64), sessionId: 's1' }), false);
assert.equal(roleCardRecordMatches(rec, { roleName: 'fixture-long-role-name', sha: 'b'.repeat(64), sessionId: 's1' }), false);
assert.equal(roleCardRecordMatches(null, { roleName: 'x', sha: '', sessionId: '' }), false);

assert.equal(shouldInjectRoleCard({ reason: 'bootstrap', hasCompactionNotice: false, recorded: true }), true);
assert.equal(shouldInjectRoleCard({ reason: 'timeout', hasCompactionNotice: true, recorded: true }), true);
assert.equal(shouldInjectRoleCard({ reason: 'timeout', hasCompactionNotice: false, recorded: true }), false);
assert.equal(shouldInjectRoleCard({ reason: 'timeout', hasCompactionNotice: false, recorded: false }), true);

assert.equal(composeRoleLine({ roleName: '', text: card, inject: true }), '');
const injected = composeRoleLine({ roleName: 'R', text: card, inject: true });
assert.ok(injected.startsWith('【当前角色】R'));
assert.ok(injected.includes(card));
const recordedLine = composeRoleLine({ roleName: 'R', text: card, inject: false, recorded: true });
assert.ok(recordedLine.includes('已注入'));
assert.ok(!recordedLine.includes(card));
const hint = composeRoleLine({ roleName: 'R', text: card, inject: false, recorded: false });
assert.ok(hint.includes('qq_get_prompt'));
const emptyInject = composeRoleLine({ roleName: 'R', text: '', inject: true, recorded: false });
assert.ok(emptyInject.includes('qq_get_prompt'));

console.log('test-wake-role-card: ok');
