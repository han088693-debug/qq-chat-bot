// 用 DSH 自身的 dsh-persona 配置 schema 与 dsh-system-prompt 的严格装配校验 preset persona。
// 说明：直接加载 DSH 安装目录里的模块做 schema 校验与模板渲染，不依赖 YAML 解析器版本，
// 也不需要 DSH 进程在跑。DSH 安装位置可用 DSH_INSTALL_MODULES 覆盖，未设置时自动探测。
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dshModulesDir } from './dsh-modules.mjs';

const DSH_MODULES = dshModulesDir();

const persona = await import(pathToFileURL(path.join(DSH_MODULES, '@deepseek-ai/dsh-persona/lib/index.js')).href);
const prompt = await import(pathToFileURL(path.join(DSH_MODULES, '@deepseek-ai/dsh-system-prompt/lib/index.js')).href);

// DSH 0.2.1 的 agent loop 只注册这两个提示词变量（见 dsh-agent-loop/lib/index.js 的
// ctx.systemPrompt.variable("provider"/"model")），装配时其它 {{name}} 一律抛错。
const LOOP_VARIABLES = { provider: 'deepseek-official', model: 'deepseek-flash' };

let failed = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✅ ${label}`); }
  catch (e) { console.log(`  ❌ ${label}: ${e?.message ?? e}`); failed += 1; }
}

console.log('persona Config schema 校验：\n');

// 旧写法（DSH 0.1.2 时代的 text 字段）—— 期望被拒绝
check('旧配置 {text} 被拒绝（复现原故障）', () => {
  let threw = false;
  try { persona.Config({ text: 'hello' }); } catch { threw = true; }
  if (!threw) throw new Error('旧配置竟然通过了校验，说明本次改动前提不成立');
});

// 新写法 —— 期望通过
check('新配置 {prefix} 通过（个人前缀）', () => {
  const v = persona.Config({ prefix: 'You are a coding agent powered by the {{model}} model.' });
  if (v.prefix.length === 0) throw new Error('prefix 为空');
});

// 新写法 —— 期望通过（suffix 可以留空：DSH 0.2.1 只注册 provider / model，suffix 里不能再写 {{cwd}}）
check('新配置 {prefix, suffix} 通过（suffix 留空）', () => {
  const v = persona.Config({
    prefix: 'You are a coding agent powered by the {{model}} model.',
    suffix: '',
  });
  if (v.suffix !== '') throw new Error('suffix 未保留为空');
  if (v.complete !== false) throw new Error('complete 默认值异常');
  if (v.includeRuntimeContext !== true) throw new Error('includeRuntimeContext 默认值异常');
});

// 校验仓库里两个 preset 的 persona 配置块
const YAML = await import(pathToFileURL(path.join(DSH_MODULES, 'js-yaml/index.js')).href);
const yaml = YAML.default ?? YAML;

for (const preset of ['qq-chat', 'qq-chat-v2']) {
  const file = path.resolve(process.cwd(), 'dsh/agent-presets', preset, 'agent.cordis.yml');
  console.log(`\n${preset} (${path.relative(process.cwd(), file)}):`);
  const doc = yaml.load(fs.readFileSync(file, 'utf8'));
  const row = doc.find((r) => r.id === 'persona');
  check('存在 persona 行', () => { if (!row) throw new Error('缺少 persona 行'); });
  check('persona 行名正确', () => {
    if (row.name !== '@deepseek-ai/dsh-persona') throw new Error(`name=${row.name}`);
  });
  check('persona.config 通过 DSH schema', () => { persona.Config(row.config); });
  check('保留了 {{model}} 变量', () => {
    if (!/\{\{model\}\}/.test(row.config.prefix)) throw new Error('prefix 缺少 {{model}}');
  });
  check('只引用 DSH 0.2.1 注册的提示词变量', () => {
    const text = `${row.config.prefix ?? ''}\n${row.config.suffix ?? ''}`;
    const unknown = [...text.matchAll(/\{\{([^{}]*)\}\}/g)]
      .map((match) => match[1])
      .filter((name) => name !== 'provider' && name !== 'model');
    if (unknown.length > 0) throw new Error(`引用了未注册变量：${[...new Set(unknown)].join(', ')}`);
  });
  check('persona.suffix 留空（DSH 0.2.1 不再注册 {{cwd}}）', () => {
    if ((row.config.suffix ?? '') !== '') throw new Error(`suffix=${JSON.stringify(row.config.suffix)}`);
  });
  check('不再包含已废弃的 text 字段', () => {
    if (Object.hasOwn(row.config, 'text')) throw new Error('仍有 text 字段');
  });
  check('persona 正文（除头句）完整保留', () => {
    const body = row.config.prefix.split('\n').slice(1).join('\n');
    if (body.length < 500) throw new Error(`正文疑似丢失，仅 ${body.length} 字符`);
  });
  check('persona 段在 DSH 0.2.1 的变量集下可装配', () => {
    prompt.renderPrompt({
      sections: [
        { name: prompt.PERSONA_PREFIX_SECTION, order: 0, text: row.config.prefix },
        { name: prompt.PERSONA_SUFFIX_SECTION, order: 10200, text: row.config.suffix ?? '' },
      ],
      variables: LOOP_VARIABLES,
    });
  });
}

// 修复前提：旧 suffix 在 DSH 0.2.1 的变量集下必然抛错，否则本脚本拦不住回归。
check('旧 suffix「Your working directory is {{cwd}}.」复现原故障', () => {
  let threw = false;
  try {
    prompt.renderPrompt({
      sections: [{ name: prompt.PERSONA_SUFFIX_SECTION, order: 10200, text: 'Your working directory is {{cwd}}.' }],
      variables: LOOP_VARIABLES,
    });
  } catch (error) {
    threw = /unknown prompt variable "\{\{cwd\}\}"/.test(String(error?.message));
  }
  if (!threw) throw new Error('旧模板没有复现 unknown prompt variable，说明断言前提不成立');
});

console.log(failed === 0 ? '\n✅ 全部通过' : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
