// 唤醒提示里的「这轮可以不回」标记（私聊专用）。
//
// 为什么单独一个模块：atReplyProbability 只作用于群聊被 @ 的场合，
// 私聊是「始终回复」。要在私聊打断 H-B 严格交替，只能每轮掷一次骰子
// 决定要不要把「可以不回」写进提示词。抽成纯函数是为了能测：
// 概率、豁免条件（bootstrap）、key 前缀都不会在改提示词时被顺手改坏。

export const PRIVATE_SKIP_LINE =
  '【这轮可以不回】他这番话没有必须接的东西。你可以只看不回：qq_mark_read 之后该干嘛干嘛，不解释、不道歉，也不必补一句“刚才没看”。回头想说了再说。\n\n';

/** 把配置里的概率夹到 [0,1]，非法值回落到默认 0.15。 */
export function privateSkipProbabilityOf(wakeCfg, fallback = 0.15) {
  const raw = Number(wakeCfg?.privateSkipProbability);
  const base = Number.isFinite(raw) ? raw : fallback;
  return Math.max(0, Math.min(1, base));
}

/**
 * @param {object} opts
 * @param {string} opts.key       会话 key，如 private:10001
 * @param {string} opts.reason    唤醒原因（bootstrap 豁免）
 * @param {number} opts.probability
 * @param {number} [opts.roll]    0~1 的随机数，注入以便测试
 * @returns {string} 要拼进提示词的文本；空串表示这轮照常接话
 */
export function privateSkipLine({ key, reason, probability, roll = Math.random() }) {
  const p = Math.max(0, Math.min(1, Number.isFinite(Number(probability)) ? Number(probability) : 0));
  if (!p) return '';
  if (reason === 'bootstrap') return '';
  if (typeof key !== 'string' || !key.startsWith('private:')) return '';
  return Number(roll) < p ? PRIVATE_SKIP_LINE : '';
}
