import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_PATH = path.resolve(process.env.QQ_BOT_OPTIONAL_CONFIG || path.join(ROOT, 'optional', 'config.json'));

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
}

function flag(section, key, name) {
  if (typeof section[key] !== 'boolean') throw new Error(`${name}.${key} must be true or false`);
}

function absolute(value, name, directory = false) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  const stat = fs.statSync(value);
  if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error(`${name} has the wrong file type`);
}

export function validateConfig(config) {
  object(config, 'config');
  object(config.iphone, 'iphone');
  object(config.phone, 'phone');
  object(config.phone.android, 'phone.android');
  object(config.phone.qzone, 'phone.qzone');
  object(config.qzonePatrol, 'qzonePatrol');
  object(config.qzonePatrol.quietHours, 'qzonePatrol.quietHours');
  object(config.qzonePatrol.runner, 'qzonePatrol.runner');
  object(config.bilibili, 'bilibili');
  for (const [name, section, flags] of [
    ['iphone', config.iphone, ['enabled', 'allowControl', 'saveScreenshots']],
    ['phone.android', config.phone.android, ['enabled', 'allowControl']],
    ['phone.qzone', config.phone.qzone, ['enabled', 'allowWrites']],
    ['qzonePatrol', config.qzonePatrol, ['enabled', 'dryRun', 'allowLikes', 'allowComments']],
    ['qzonePatrol.runner', config.qzonePatrol.runner, ['enabled', 'autoLike']],
    ['bilibili', config.bilibili, ['enabled']],
  ]) for (const key of flags) flag(section, key, name);

  // Patrol settings remain strict while disabled so a later enable cannot widen access.
  const patrol = config.qzonePatrol;
  for (const key of ['allowedUsers', 'blockedUsers']) {
    if (!Array.isArray(patrol[key]) || patrol[key].some(id => typeof id !== 'string'
        || !/^[1-9]\d{0,15}$/.test(id) || !Number.isSafeInteger(Number(id)))) {
      throw new Error(`qzonePatrol.${key} must contain canonical numeric ID strings`);
    }
  }
  const patrolUrl = new URL(patrol.baseUrl);
  if (!['http:', 'https:'].includes(patrolUrl.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(patrolUrl.hostname)
      || patrolUrl.username || patrolUrl.password || patrolUrl.search || patrolUrl.hash || patrolUrl.pathname !== '/') {
    throw new Error('qzonePatrol.baseUrl must be a local HTTP origin without credentials or path');
  }
  if (typeof patrol.accessTokenEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(patrol.accessTokenEnv)) {
    throw new Error('qzonePatrol.accessTokenEnv must name an environment variable');
  }
  for (const [key, min, max] of [
    ['dailyLikeLimit', 0, 200], ['dailyCommentLimit', 0, 50], ['hourlyLimit', 0, 100],
    ['cooldownMinutes', 0, 1440], ['scanPageSize', 1, 50], ['maxPostAgeHours', 1, 720],
  ]) {
    if (!Number.isSafeInteger(patrol[key]) || patrol[key] < min || patrol[key] > max) {
      throw new Error(`qzonePatrol.${key} must be an integer from ${min} to ${max}`);
    }
  }
  if (!Number.isSafeInteger(patrol.runner.intervalMinutes) || patrol.runner.intervalMinutes < 5 || patrol.runner.intervalMinutes > 1440) {
    throw new Error('qzonePatrol.runner.intervalMinutes must be an integer from 5 to 1440');
  }
  for (const key of ['start', 'end']) {
    if (typeof patrol.quietHours[key] !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(patrol.quietHours[key])) {
      throw new Error(`qzonePatrol.quietHours.${key} must use HH:mm`);
    }
  }
  if (typeof patrol.quietHours.timeZone !== 'string' || !patrol.quietHours.timeZone.trim()) {
    throw new Error('qzonePatrol.quietHours.timeZone is required');
  }
  try { new Intl.DateTimeFormat('en', { timeZone: patrol.quietHours.timeZone }).format(0); }
  catch { throw new Error('qzonePatrol.quietHours.timeZone is invalid'); }

  if (config.iphone.enabled) {
    absolute(config.iphone.pythonPath, 'iphone.pythonPath');
    absolute(config.iphone.appDir, 'iphone.appDir', true);
    absolute(path.join(config.iphone.appDir, 'src', 'phone_harness', 'mcp_server.py'), 'SideTap MCP entry');
  }
  if (config.phone.android.enabled) {
    if (typeof config.phone.android.adbPath !== 'string' || !config.phone.android.adbPath.trim()) {
      throw new Error('phone.android.adbPath is required');
    }
    if (typeof config.phone.android.serial !== 'string' || !config.phone.android.serial.trim()) {
      throw new Error('phone.android.serial must explicitly select one device');
    }
  }
  if (config.phone.qzone.enabled) {
    const q = config.phone.qzone;
    const url = new URL(q.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
        || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('phone.qzone.baseUrl must be a local HTTP origin without credentials or path');
    }
    if (typeof q.accessTokenEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(q.accessTokenEnv)) {
      throw new Error('phone.qzone.accessTokenEnv must name an environment variable');
    }
    if (!Array.isArray(q.imageDirs) || q.imageDirs.some(p => typeof p !== 'string' || !path.isAbsolute(p))) {
      throw new Error('phone.qzone.imageDirs must contain absolute directory paths');
    }
  }
  if (config.bilibili.enabled) {
    const b = config.bilibili;
    absolute(b.command, 'bilibili.command');
    absolute(b.cwd, 'bilibili.cwd', true);
    if (!Array.isArray(b.args) || b.args.some(a => typeof a !== 'string')) throw new Error('bilibili.args must be strings');
    object(b.env, 'bilibili.env');
    if (Object.entries(b.env).some(([k, v]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== 'string')) {
      throw new Error('bilibili.env must contain string environment variables');
    }
  }
  return config;
}

export function loadConfig(file = CONFIG_PATH) {
  const defaults = JSON.parse(fs.readFileSync(path.join(ROOT, 'optional', 'config.example.json'), 'utf8'));
  const input = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  object(input, 'config');
  for (const name of ['iphone', 'phone', 'bilibili', 'qzonePatrol']) if (Object.hasOwn(input, name)) object(input[name], name);
  for (const name of ['android', 'qzone']) if (Object.hasOwn(input.phone || {}, name)) object(input.phone[name], `phone.${name}`);
  for (const name of ['quietHours', 'runner']) if (Object.hasOwn(input.qzonePatrol || {}, name)) object(input.qzonePatrol[name], `qzonePatrol.${name}`);
  return validateConfig({
    iphone: { ...defaults.iphone, ...input.iphone },
    phone: {
      android: { ...defaults.phone.android, ...input.phone?.android },
      qzone: { ...defaults.phone.qzone, ...input.phone?.qzone },
    },
    bilibili: { ...defaults.bilibili, ...input.bilibili },
    qzonePatrol: {
      ...defaults.qzonePatrol, ...input.qzonePatrol,
      quietHours: { ...defaults.qzonePatrol.quietHours, ...input.qzonePatrol?.quietHours },
      runner: { ...defaults.qzonePatrol.runner, ...input.qzonePatrol?.runner },
    },
  });
}
