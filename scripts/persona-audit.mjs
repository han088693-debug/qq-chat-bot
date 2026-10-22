// 人味仪表盘 CLI
//
//   node scripts/persona-audit.mjs --key private:10001
//   node scripts/persona-audit.mjs --key private:10001 --days 1
//   node scripts/persona-audit.mjs --key group:10002 --json
//
// 指标说明见 src/persona-audit.mjs 顶部注释。

import path from 'node:path';
import { collectPersonaMetrics, formatAuditReport } from '../src/persona-audit.mjs';

function argOf(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith('--')) return fallback;
  return value;
}

const key = argOf('--key', '');
const days = Number(argOf('--days', '1')) || 1;
const asJson = process.argv.includes('--json');

const metrics = collectPersonaMetrics({
  stateDir: path.resolve(argOf('--state-dir', 'state')),
  key,
  days,
});

if (asJson) {
  console.log(JSON.stringify(metrics, null, 2));
} else {
  console.log(formatAuditReport(metrics));
}

if (!metrics.ok) process.exitCode = 1;
