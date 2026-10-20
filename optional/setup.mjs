// Installs only optional MCP entries. Does not start a device or call any service.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { ROOT, CONFIG_PATH, loadConfig } from './config.mjs';

const IDS = ['mcp-qq-optional-phone', 'mcp-qq-optional-iphone', 'mcp-qq-optional-bili', 'mcp-qq-optional-qzone'];

export function entriesFor(config, configPath = CONFIG_PATH) {
  const specs = [];
  if (config.phone.android.enabled || config.phone.qzone.enabled) specs.push(['phone', 'optional/phone/server.mjs']);
  if (config.iphone.enabled) specs.push(['iphone', 'optional/proxy.mjs', 'iphone']);
  if (config.bilibili.enabled) specs.push(['bili', 'optional/proxy.mjs', 'bilibili']);
  if (config.qzonePatrol?.enabled) specs.push(['qzone', 'optional/qzone-patrol/server.mjs']);
  return specs.map(([name, script, arg]) => ({
    id: `mcp-qq-optional-${name}`,
    name: '@deepseek-ai/dsh-mcp-client',
    config: {
      serverName: name,
      transport: 'stdio',
      command: process.execPath,
      args: [path.join(ROOT, script), ...(arg ? [arg] : [])],
      cwd: ROOT,
      env: { QQ_BOT_OPTIONAL_CONFIG: configPath },
      toolCallTimeoutMs: 180000,
    },
  }));
}

export function patchDocument(original, entries) {
  const doc = yaml.load(original.replace(/^\uFEFF/, '')) ?? [];
  if (!Array.isArray(doc)) throw new Error('cordis.patch.yml must contain a YAML array');
  const kept = [];
  for (const operation of doc) {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) throw new Error('Invalid patch operation');
    if (!Object.hasOwn(operation, 'insert')) { kept.push(operation); continue; }
    if (!Array.isArray(operation.insert)) throw new Error('insert must be an array');
    const insert = operation.insert.filter(e => !IDS.includes(e?.id));
    if (insert.length || Object.keys(operation).length > 1) kept.push({ ...operation, insert });
  }
  const names = new Set(entries.map(e => e.config.serverName));
  function check(value) {
    if (!value || typeof value !== 'object') return;
    if (value.name === '@deepseek-ai/dsh-mcp-client' && names.has(value.config?.serverName)) {
      throw new Error(`An unmanaged MCP already uses serverName=${value.config.serverName}; keep it or migrate it manually first`);
    }
    for (const child of Object.values(value)) if (typeof child === 'object') check(child);
  }
  check(kept);
  if (entries.length) kept.push({ insert: entries });
  return yaml.dump(kept, { lineWidth: -1, noRefs: true });
}

export function main(args = process.argv.slice(2)) {
  const known = new Set(['--check', '--remove']);
  if (args.some(a => a.startsWith('--') && !known.has(a))) throw new Error('Usage: node optional/setup.mjs [profile] [--check] [--remove]');
  const profiles = args.filter(a => !a.startsWith('--'));
  const profile = profiles[0] || 'web';
  if (profiles.length > 1 || profile === '.' || profile === '..' || profile === 'node_modules'
      || /[\\/\x00-\x1f<>:"|?*]/.test(profile) || /[. ]$/.test(profile)) throw new Error('Invalid profile name');
  const dir = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'profiles', profile);
  if (!fs.existsSync(dir)) throw new Error('DSH profile does not exist; finish the main DSH setup first');
  const file = path.join(dir, 'cordis.patch.yml');
  const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const entries = args.includes('--remove') ? [] : entriesFor(loadConfig());
  const output = patchDocument(original, entries);
  console.log(`Optional MCP: ${entries.map(e => e.config.serverName).join(', ') || 'none'}; profile=${profile}`);
  if (args.includes('--check')) {
    console.log('Check passed. No files changed, services started, or devices contacted.');
    return;
  }
  if (output !== original) {
    // A backup failure stops the edit. Backups can contain private environment settings.
    if (original) fs.copyFileSync(file, `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`, fs.constants.COPYFILE_EXCL);
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, output, { encoding: 'utf8', flag: 'wx' });
      fs.renameSync(temporary, file);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
  console.log('Optional MCP entries saved. Restart DSH to apply the change.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); }
  catch (error) { console.error(`[optional/setup] ${error.message}`); process.exitCode = 1; }
}
