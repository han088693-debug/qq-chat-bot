// Explicitly enabled timer. It can scan and optionally like; it never generates comments.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../config.mjs';
import { createPatrol, DEFAULT_STATE_DIR, validatePatrolConfig } from './core.mjs';
import { PatrolError, withRunnerLock } from './state.mjs';

const fail = (code, message) => { throw new PatrolError(code, message); };
const skippedActions = new Set(['already_reserved', 'candidate_expired']);
const exhaustedActions = new Set(['quota_zero', 'quota_exhausted', 'cooldown']);

export function createPatrolRunner({
  getConfig = () => loadConfig().qzonePatrol,
  stateDir = DEFAULT_STATE_DIR, requestOneBot, now,
  sleep = (ms, signal) => delay(ms, undefined, { signal }),
  log = value => console.log(JSON.stringify(value)),
} = {}) {
  async function config() {
    try {
      const value = structuredClone(validatePatrolConfig(await getConfig()));
      const runner = value.runner;
      if (!runner || typeof runner.enabled !== 'boolean' || typeof runner.autoLike !== 'boolean'
          || !Number.isSafeInteger(runner.intervalMinutes) || runner.intervalMinutes < 5 || runner.intervalMinutes > 1440) {
        throw new Error();
      }
      return value;
    } catch { fail('config_invalid', '无法读取有效的巡逻定时配置；未执行操作'); }
  }

  function requireRunning(cfg, signal) {
    if (signal?.aborted) fail('stopped', '巡逻已收到停止信号');
    if (!cfg.enabled) fail('disabled', 'QQ 空间巡逻模块已关闭');
    if (!cfg.runner.enabled) fail('runner_disabled', '巡逻定时器已关闭');
  }

  async function cycle(signal) {
    const cfg = await config();
    requireRunning(cfg, signal);
    const policy = JSON.stringify(cfg);
    const guardedConfig = async (forLike = false) => {
      const current = await config();
      requireRunning(current, signal);
      if (JSON.stringify(current) !== policy) fail('config_changed', '巡逻配置已变更，已停止本轮');
      if (forLike && (!current.runner.autoLike || !current.allowLikes)) {
        fail('action_disabled', '自动点赞未获开启');
      }
      return current;
    };
    const options = { stateDir, requestOneBot, now };
    const scanner = createPatrol({ ...options, getConfig: () => guardedConfig() });
    const result = await scanner.scan();
    const summary = {
      event: 'cycle', ok: true, dryRun: cfg.dryRun,
      scanned: result.items.length, failedTargets: result.failedTargets ?? 0,
      likesSubmitted: 0, likePreviews: 0, skipped: 0,
    };
    if (result.reason) return { ...summary, reason: result.reason };
    if (!cfg.runner.autoLike || !cfg.allowLikes) return { ...summary, reason: 'scan_only' };
    const writer = createPatrol({ ...options, getConfig: () => guardedConfig(true) });
    for (const [index, item] of result.items.entries()) {
      await guardedConfig(true);
      try {
        const action = await writer.like({ candidateId: item.candidateId });
        if (action.performed) summary.likesSubmitted++;
        else if (action.dryRun) summary.likePreviews++;
      } catch (error) {
        if (skippedActions.has(error.code)) {
          summary.skipped++;
          continue;
        }
        if (exhaustedActions.has(error.code)) {
          summary.skipped += result.items.length - index;
          summary.reason = error.code;
          break;
        }
        throw error;
      }
    }
    return summary;
  }

  async function check() {
    const cfg = await config();
    return {
      event: 'check', ok: true, enabled: cfg.enabled, runnerEnabled: cfg.runner.enabled,
      autoLike: cfg.runner.autoLike, dryRun: cfg.dryRun, intervalMinutes: cfg.runner.intervalMinutes,
    };
  }

  async function status() {
    const cfg = await config();
    const local = createPatrol({ getConfig: () => cfg, stateDir, requestOneBot, now });
    return { event: 'status', ...await local.status(), runner: cfg.runner };
  }

  async function once({ signal } = {}) {
    requireRunning(await config(), signal);
    return withRunnerLock(stateDir, () => cycle(signal));
  }

  async function run({ signal } = {}) {
    requireRunning(await config(), signal);
    return withRunnerLock(stateDir, async () => {
      while (!signal?.aborted) {
        const current = await config();
        if (!current.enabled || !current.runner.enabled) {
          const result = { event: 'stopped', reason: !current.enabled ? 'disabled' : 'runner_disabled' };
          log(result);
          return result;
        }
        try {
          log(await cycle(signal));
          const next = await config();
          if (!next.enabled || !next.runner.enabled) continue;
          await sleep(next.runner.intervalMinutes * 60000, signal);
        } catch (error) {
          if (!signal?.aborted) {
            const latest = await config();
            if (latest.enabled && latest.runner.enabled) throw error;
            const result = { event: 'stopped', reason: !latest.enabled ? 'disabled' : 'runner_disabled' };
            log(result);
            return result;
          }
        }
      }
      const result = { event: 'stopped', reason: 'signal' };
      log(result);
      return result;
    });
  }

  return { check, status, once, run };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length && !['--once', '--status', '--check'].includes(args[0]))) {
      fail('arguments_invalid', '仅支持 --once、--status、--check 或不带参数常驻运行');
    }
    const runner = createPatrolRunner();
    if (!args.length) await runner.run({ signal: controller.signal });
    else {
      const method = { '--once': 'once', '--status': 'status', '--check': 'check' }[args[0]];
      console.log(JSON.stringify(await runner[method]({ signal: controller.signal })));
    }
  } catch (error) {
    if (controller.signal.aborted) console.log(JSON.stringify({ event: 'stopped', reason: 'signal' }));
    else {
      console.error(JSON.stringify({
        event: 'error', ok: false, code: error instanceof PatrolError ? error.code : 'runner_failed',
        message: '巡逻已停止，请在本机检查配置或状态；不会自动重试写操作。',
      }));
      process.exitCode = 1;
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}
