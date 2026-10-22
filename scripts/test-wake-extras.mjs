// 「这轮可以不回」标记：把概率和豁免条件钉死，防止改提示词时改坏。
import assert from 'node:assert/strict';
import {
  PRIVATE_SKIP_LINE,
  privateSkipLine,
  privateSkipProbabilityOf,
} from '../src/wake-extras.mjs';

// 1. 概率夹取
assert.equal(privateSkipProbabilityOf({ privateSkipProbability: 0.3 }), 0.3);
assert.equal(privateSkipProbabilityOf({ privateSkipProbability: '0.5' }), 0.5);
assert.equal(privateSkipProbabilityOf({ privateSkipProbability: -1 }), 0);
assert.equal(privateSkipProbabilityOf({ privateSkipProbability: 9 }), 1);
assert.equal(privateSkipProbabilityOf({}), 0.15);
assert.equal(privateSkipProbabilityOf({ privateSkipProbability: 'abc' }), 0.15);
assert.equal(privateSkipProbabilityOf({}, 0.4), 0.4);

// 2. 私聊命中 → 给出标记文本
assert.equal(
  privateSkipLine({ key: 'private:10001', reason: 'message', probability: 0.15, roll: 0.1 }),
  PRIVATE_SKIP_LINE,
);

// 3. 没命中 / 群聊 / bootstrap / 概率 0 → 空串
assert.equal(privateSkipLine({ key: 'private:1', reason: 'message', probability: 0.15, roll: 0.5 }), '');
assert.equal(privateSkipLine({ key: 'group:1', reason: 'message', probability: 1, roll: 0 }), '');
assert.equal(privateSkipLine({ key: 'private:1', reason: 'bootstrap', probability: 1, roll: 0 }), '');
assert.equal(privateSkipLine({ key: 'private:1', reason: 'message', probability: 0, roll: 0 }), '');

// 4. roll 边界与非法值
assert.equal(privateSkipLine({ key: 'private:1', reason: 'message', probability: 0.15, roll: 0.15 }), '');
assert.equal(privateSkipLine({ key: 'private:1', reason: 'message', probability: 0.15, roll: 0.1499 }), PRIVATE_SKIP_LINE);
assert.equal(privateSkipLine({ key: 'private:1', reason: 'message', probability: 'x', roll: 0 }), '');

// 5. 统计意义：p=0.15 时约 15% 命中
let hits = 0;
for (let i = 0; i < 2000; i += 1) {
  if (privateSkipLine({ key: 'private:1', reason: 'message', probability: 0.15, roll: i / 2000 })) hits += 1;
}
assert.ok(hits >= 280 && hits <= 320, `命中数 ${hits} 不在 280~320`);

console.log('wake-extras: 5 项通过');
