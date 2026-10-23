// 联网搜索（MCP `web_search` 的实现）。
//
// 设计目标：**优先复用 DSH 原本的联网搜索能力**，而不是自己抓 Bing 的搜索结果页。
//
// DSH 的 `web_search` 工具背后是 `@deepseek-ai/dsh-web-search-deepseek`：
// 向 DeepSeek 的 Anthropic 兼容 Messages 端点发一次带 `web_search_20250305`
// 服务端工具的请求，从 `web_search_tool_result` 里取结构化结果。本模块照同一
// 端点/模型/工具参数实现一份最小客户端，于是 QQ 里的 AI 和 DSH 里的 AI 拿到的是
// **同一路搜索结果**；搜索词只发给 DeepSeek（也就是本来就在处理这段对话的同一家），
// 不再把群聊里提炼出来的词发给 Bing。
//
// 凭据解析顺序与 DSH 一致：
//   1. config.json 的 `webSearch.apiKey`（不推荐，明文）
//   2. 环境变量 `DEEPSEEK_API_KEY`（可用 `webSearch.apiKeyEnv` 改）
//   3. DSH 的 `$DSH_HOME/.credentials.yaml` → `refs.<ref>`（旧版 DSH 的 API key）
//   4. 同文件的 `records['deepseek-account-platform/default'].payload.token`
//      （DSH 登录 DeepSeek 的账号授权；用 `x-dsh-auth-token` 头发送，不是 API key）
// 都没有时：回退 DuckDuckGo（HTML 结果页，实测可用），再回退 Bing（RSS，失败再 HTML）。
//
// 安全边界：
// - API key / 账号 token 只发往**校验过**的 HTTPS 端点：必须是 https、必须解析到
//   非内网地址（防止把凭据发到 localhost/内网），且禁止跟随重定向（`redirect: error`）。
// - 凭据永远不写日志、不进错误信息、不进返回结果。
// - 响应体有大小上限；请求有总超时；查询词在 MCP 层已清洗。
// - Bing/DDG 走 safe-fetch（SSRF 防护 + 多地址故障切换 + 响应解压）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { URL } from 'node:url';
import YAML from 'js-yaml';
import { resolveSafeAddresses, safeFetch } from './safe-fetch.js';

const DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic/v1';
const DEFAULT_MODEL = 'deepseek-v4-flash';
const DEFAULT_API_VERSION = '2023-06-01';
const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY';
const DEFAULT_TIMEOUT_MS = 35000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 64;
// Anthropic 兼容响应里文本块/结果块都可能有；这里只要结构化结果。
const SEARCH_TOOL_TYPE = 'web_search_20250305';

const defaultConfig = Object.freeze({
  provider: 'auto',
  apiKey: '',
  apiKeyEnv: DEFAULT_API_KEY_ENV,
  baseURL: '',
  model: DEFAULT_MODEL,
  maxUses: 5,
  maxTokens: 4096,
  maxResults: 8,
  timeoutMs: DEFAULT_TIMEOUT_MS
});

function num(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 读取 config.json 里的 webSearch 段（不存在就用默认值）。 */
export function loadSearchConfig(root) {
  let file = {};
  try {
    const text = fs.readFileSync(path.join(root, 'config.json'), 'utf8');
    file = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {}
  const raw = file?.webSearch && typeof file.webSearch === 'object' && !Array.isArray(file.webSearch) ? file.webSearch : {};
  const provider = raw.provider === 'deepseek' || raw.provider === 'ddg' || raw.provider === 'bing' ? raw.provider : 'auto';
  return {
    ...defaultConfig,
    provider,
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '',
    apiKeyEnv: typeof raw.apiKeyEnv === 'string' && raw.apiKeyEnv.trim() ? raw.apiKeyEnv.trim() : DEFAULT_API_KEY_ENV,
    baseURL: typeof raw.baseURL === 'string' ? raw.baseURL.trim().replace(/\/+$/, '') : '',
    model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : DEFAULT_MODEL,
    maxUses: num(raw.maxUses, defaultConfig.maxUses, 1, 5),
    maxTokens: num(raw.maxTokens, defaultConfig.maxTokens, 256, 8192),
    maxResults: num(raw.maxResults, defaultConfig.maxResults, 1, 20),
    timeoutMs: num(raw.timeoutMs, defaultConfig.timeoutMs, 5000, 120000)
  };
}

/** DSH home：与 dsh-client 的判定保持一致（`DSH_HOME` 优先）。 */
export function resolveDshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/**
 * 从 DSH 的凭据文件里取 key。
 * 结构：`refs: { <名称>: <明文值> }`（实测；不是记录 id）。只看指定 ref，绝不遍历其它凭据。
 */
export function readDshCredential(ref) {
  const name = String(ref ?? '').trim();
  if (!name) return '';
  try {
    const doc = YAML.load(fs.readFileSync(path.join(resolveDshHome(), '.credentials.yaml'), 'utf8'));
    const value = doc?.refs?.[name];
    return typeof value === 'string' ? value.trim() : '';
  } catch {
    return '';
  }
}

/** 解析搜索用的 DeepSeek key；返回 { key, source } —— key 只在这里出现，不落日志。 */
export function resolveSearchApiKey(config) {
  const literal = String(config?.apiKey ?? '').trim();
  if (literal) return { key: literal, source: 'config' };
  const envName = String(config?.apiKeyEnv || DEFAULT_API_KEY_ENV);
  const fromEnv = String(process.env[envName] ?? '').trim();
  if (fromEnv) return { key: fromEnv, source: 'env' };
  const fromDsh = readDshCredential(envName);
  if (fromDsh) return { key: fromDsh, source: 'dsh-credentials' };
  return { key: '', source: 'none' };
}

/**
 * 从 DSH 凭据文件里取 DeepSeek **账号授权**（登录 DSH 时写入的 grant）。
 * 结构：`records['deepseek-account-platform/default'].payload.token`。
 * 这个 token 不是 API key：DSH 的搜索 provider 用 `x-dsh-auth-token` 头发它。
 */
export function readDshAccountToken() {
  try {
    const doc = YAML.load(fs.readFileSync(path.join(resolveDshHome(), '.credentials.yaml'), 'utf8'));
    const records = doc?.records && typeof doc.records === 'object' ? doc.records : {};
    const keys = ['deepseek-account-platform/default', ...Object.keys(records).sort()];
    for (const key of keys) {
      const token = records?.[key]?.payload?.token;
      if (typeof token === 'string' && token.trim()) return { token: token.trim(), record: key };
    }
  } catch {}
  return { token: '', record: '' };
}

/**
 * 解析搜索鉴权：API key（config/env/refs）优先，其次 DSH 账号 token。
 * @returns {{kind:'api-key',key:string,source:string}|{kind:'account',token:string,source:string}|{kind:'none',source:string}}
 */
export function resolveSearchAuth(config) {
  const literal = String(config?.apiKey ?? '').trim();
  if (literal) return { kind: 'api-key', key: literal, source: 'config' };
  const envName = String(config?.apiKeyEnv || DEFAULT_API_KEY_ENV);
  const fromEnv = String(process.env[envName] ?? '').trim();
  if (fromEnv) return { kind: 'api-key', key: fromEnv, source: 'env' };
  const fromDsh = readDshCredential(envName);
  if (fromDsh) return { kind: 'api-key', key: fromDsh, source: 'dsh-credentials' };
  const account = readDshAccountToken();
  if (account.token) return { kind: 'account', token: account.token, source: `dsh-account:${account.record}` };
  return { kind: 'none', source: 'none' };
}

function normalizeSearchUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!/^https?:\/\//i.test(s)) return '';
  // DeepSeek 的结果 URL 会带 `#1` 这类"第几条"的锚点（不是页面真实片段），去掉更干净；
  // 但真实的 `#section` 也可能有意义，所以只去纯数字锚点。
  const cleaned = s.replace(/#\d+$/, '');
  try {
    const url = new URL(cleaned);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    if (url.username || url.password) return '';
    return url.toString();
  } catch {
    return '';
  }
}

/** 把 Anthropic Messages 响应映射成统一结果（参照 dsh-web-search-deepseek 的实现）。 */
export function mapDeepSeekResponse(response, maxResults = 8) {
  const blocks = Array.isArray(response?.content) ? response.content : [];
  const resultBlocks = blocks.filter((block) => block?.type === 'web_search_tool_result');
  if (!resultBlocks.length) {
    throw Object.assign(new Error('DeepSeek 没有返回 web_search_tool_result（可能未触发联网搜索）'), { code: 'NO_RESULT_BLOCK' });
  }
  const snippets = new Map();
  for (const block of blocks) {
    if (block?.type !== 'text') continue;
    for (const cite of block.citations ?? []) {
      const url = normalizeSearchUrl(cite?.url);
      if (!url || snippets.has(url)) continue;
      const text = String(cite?.cited_text ?? '').trim();
      if (text) snippets.set(url, text);
    }
  }
  const seen = new Set();
  const results = [];
  for (const block of resultBlocks) {
    for (const item of block?.content ?? []) {
      if (item?.type !== 'web_search_result') continue;
      const url = normalizeSearchUrl(item.url);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const title = String(item.title ?? '').trim().slice(0, 200);
      const snippet = String(snippets.get(url) ?? '').trim().slice(0, 500);
      results.push({
        title,
        url,
        ...(snippet ? { snippet } : {}),
        ...(item.page_age ? { publishedAt: String(item.page_age).slice(0, 40) } : {})
      });
      if (results.length >= maxResults) return results;
    }
  }
  return results;
}

/** 校验搜索端点：https + 公网地址。返回 { url, addresses }。 */
async function validateSearchEndpoint(baseURL) {
  let url;
  try {
    url = new URL(String(baseURL ?? '').trim());
  } catch {
    throw new Error('webSearch.baseURL 无效');
  }
  if (url.protocol !== 'https:') throw new Error('webSearch.baseURL 必须是 https（API key 只能发给加密端点）');
  if (url.username || url.password) throw new Error('webSearch.baseURL 不能包含凭据');
  const addresses = await resolveSafeAddresses(url.hostname);
  return { url, addresses };
}

/**
 * 向搜索端点 POST JSON（单个已校验地址）。
 * 不复用 safeFetch（它只做 GET）：这里需要 POST、禁止重定向，并把 key 只交给校验过的地址。
 * 网络层失败（连接/超时/中断）由 postJson() 换地址重试；HTTP 状态是结果，不在这里重试。
 */
function postJsonOnce(url, address, { headers, body, timeoutMs, maxBytes = MAX_RESPONSE_BYTES }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req;
    let response;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      const error = new Error(`联网搜索请求超时（${Math.round(timeoutMs / 1000)}s）`);
      finish(error);
      req?.destroy(error);
      response?.destroy();
    }, timeoutMs);
    try {
      req = https.request({
        hostname: address,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          ...headers,
          host: url.host,
          'content-length': Buffer.byteLength(body)
        },
        // 证书校验用真实域名（SNI/Host 与站点一致），连接目标才是固定 IP。
        servername: url.hostname,
        rejectUnauthorized: true,
        timeout: timeoutMs
      }, (res) => {
        response = res;
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400) {
          finish(new Error(`联网搜索端点返回重定向（HTTP ${status}），已拒绝跟随`));
          res.destroy();
          return;
        }
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          if (settled) return;
          size += chunk.length;
          if (size > maxBytes) {
            finish(new Error('联网搜索响应体过大，已中止'));
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', (error) => finish(error));
        res.on('aborted', () => finish(new Error('联网搜索响应中断')));
        res.on('close', () => { if (!res.complete) finish(new Error('联网搜索响应中断')); });
        res.on('end', () => {
          if (settled) return;
          const text = Buffer.concat(chunks).toString('utf8');
          finish(null, { status, text });
        });
      });
      req.on('timeout', () => {
        const error = new Error(`联网搜索请求超时（${Math.round(timeoutMs / 1000)}s）`);
        finish(error);
        req.destroy(error);
        response?.destroy();
      });
      req.on('error', (error) => finish(error));
      req.end(body);
    } catch (error) {
      finish(error);
      req?.destroy();
    }
  });
}

/** 依次尝试前两个已校验地址（同一失败形态：DNS 先给 IPv6、本机没有 IPv6 出口）。 */
async function postJson(url, addresses, options) {
  const list = (Array.isArray(addresses) ? addresses : [addresses]).filter(Boolean);
  if (!list.length) throw new Error('没有任何可用地址');
  const deadline = Date.now() + options.timeoutMs;
  const attempts = Math.min(list.length, 2);
  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 500) break;
    const budget = attempts === 1 ? options.timeoutMs : Math.min(remaining, Math.ceil(options.timeoutMs / 2));
    try {
      return await postJsonOnce(url, list[i], { ...options, timeoutMs: budget });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('联网搜索请求失败');
}

/** DeepSeek 原生联网搜索。失败时抛出带稳定 code 的错误，由调用方决定是否回退。 */
export async function deepseekSearch(query, config = defaultConfig) {
  const auth = resolveSearchAuth(config);
  if (auth.kind === 'none') {
    throw Object.assign(new Error('没有可用的 DeepSeek 搜索凭据（API key 或 DSH 账号登录）'), { code: 'NO_KEY' });
  }
  const baseURL = config.baseURL || process.env.DEEPSEEK_SEARCH_BASE_URL || DEFAULT_BASE_URL;
  const { url, addresses } = await validateSearchEndpoint(baseURL);
  const endpoint = new URL(`${url.toString().replace(/\/+$/, '')}/messages`);
  const body = JSON.stringify({
    model: config.model || DEFAULT_MODEL,
    max_tokens: config.maxTokens || defaultConfig.maxTokens,
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: `Perform a web search for the query: ${query}` }]
    }],
    tools: [{
      type: SEARCH_TOOL_TYPE,
      name: 'web_search',
      max_uses: config.maxUses || defaultConfig.maxUses
    }],
    thinking: { type: 'disabled' }
  });
  // DSH 的账号登录用 x-dsh-auth-token；旧式 API key 用 x-api-key + Bearer。
  const authHeaders = auth.kind === 'account'
    ? { 'x-dsh-auth-token': auth.token }
    : { 'x-api-key': auth.key, authorization: `Bearer ${auth.key}` };
  const response = await postJson(endpoint, addresses, {
    headers: {
      ...authHeaders,
      'anthropic-version': DEFAULT_API_VERSION,
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': 'qq-bridge-web-search/0.2.0'
    },
    body,
    timeoutMs: config.timeoutMs || DEFAULT_TIMEOUT_MS
  });
  if (response.status < 200 || response.status >= 300) {
    // 只回显 HTTP 状态与主体里的简短错误，绝不拼接请求头（里面是凭据）。
    let detail = '';
    try {
      const parsed = JSON.parse(response.text);
      const message = typeof parsed?.error === 'string' ? parsed.error : parsed?.error?.message ?? parsed?.message;
      if (typeof message === 'string') detail = message.slice(0, 200);
    } catch {}
    if (response.status === 401 && auth.kind === 'account') {
      detail = `${detail ? `${detail}；` : ''}DSH 的 DeepSeek 账号授权被拒绝，需要重新登录 DeepSeek`;
    }
    throw Object.assign(
      new Error(`DeepSeek 搜索接口 HTTP ${response.status}${detail ? `：${detail}` : ''}`),
      { code: 'HTTP_ERROR', status: response.status }
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    throw Object.assign(new Error('DeepSeek 搜索接口返回了无法解析的响应'), { code: 'BAD_BODY' });
  }
  return mapDeepSeekResponse(parsed, config.maxResults || defaultConfig.maxResults);
}

function decodeEntities(text) {
  return String(text ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number(dec);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pickTag(block, tag) {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  return match ? decodeEntities(match[1]) : '';
}

/** Bing 的 RSS 结果（比 HTML 页面稳定：没有 JS、结构固定）。 */
export function parseBingRss(xml, maxResults = 8) {
  const results = [];
  const seen = new Set();
  for (const match of String(xml ?? '').matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const block = match[1];
    const url = normalizeSearchUrl(pickTag(block, 'link'));
    if (!url || seen.has(url)) continue;
    const title = pickTag(block, 'title').slice(0, 200);
    const snippet = pickTag(block, 'description').slice(0, 500);
    seen.add(url);
    results.push({ title: title || url, url, ...(snippet ? { snippet } : {}) });
    if (results.length >= maxResults) break;
  }
  return results;
}

/** Bing 的 HTML 结果页（RSS 不可用时的兜底，保持旧实现的解析口径）。 */
export function parseBingHtml(html, maxResults = 8) {
  const results = [];
  const seen = new Set();
  const blocks = String(html ?? '').split('<li class="b_algo"').slice(1);
  for (const block of blocks) {
    const hrefMatch = block.match(/<a[^>]+href="(https?:\/\/[^"]+)"/i);
    if (!hrefMatch) continue;
    const url = normalizeSearchUrl(decodeEntities(hrefMatch[1]));
    if (!url || seen.has(url)) continue;
    const titleMatch = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const title = titleMatch ? decodeEntities(titleMatch[1]).slice(0, 200) : '';
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch ? decodeEntities(snippetMatch[1]).slice(0, 500) : '';
    seen.add(url);
    results.push({ title: title || url, url, ...(snippet ? { snippet } : {}) });
    if (results.length >= maxResults) break;
  }
  return results;
}

/** Bing 搜索（RSS 优先，HTML 兜底）。 */
export async function bingSearch(query, config = defaultConfig) {
  const maxResults = config.maxResults || defaultConfig.maxResults;
  const rss = new URL('https://cn.bing.com/search');
  rss.searchParams.set('q', query);
  rss.searchParams.set('format', 'rss');
  rss.searchParams.set('count', String(Math.min(20, maxResults)));
  rss.searchParams.set('setlang', 'zh-hans');
  rss.searchParams.set('cc', 'CN');
  try {
    const res = await safeFetch(rss.toString(), 512000);
    if (res.statusCode >= 200 && res.statusCode < 300) {
      const results = parseBingRss(res.body, maxResults);
      if (results.length) return results;
    }
  } catch {}
  const html = new URL('https://cn.bing.com/search');
  html.searchParams.set('q', query);
  html.searchParams.set('count', String(Math.min(20, maxResults)));
  html.searchParams.set('setlang', 'zh-hans');
  html.searchParams.set('cc', 'CN');
  const res = await safeFetch(html.toString(), 512000);
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`Bing 搜索 HTTP ${res.statusCode}`);
  return parseBingHtml(res.body, maxResults);
}

/** DuckDuckGo HTML 结果页里的 `//duckduckgo.com/l/?uddg=...` 跳转还原成真实 URL。 */
export function decodeDdgHref(href) {
  const s = String(href ?? '').trim();
  if (!s) return '';
  try {
    if (/^(?:\/\/)?duckduckgo\.com\/l\//i.test(s)) {
      const u = new URL(s.startsWith('//') ? `https:${s}` : s);
      const target = u.searchParams.get('uddg');
      if (target) return decodeURIComponent(target);
    }
  } catch {}
  return s;
}

/** 解析 DuckDuckGo HTML 结果页（无 JS、结构稳定；链接是 uddg 跳转）。 */
export function parseDdgHtml(html, maxResults = 8) {
  const text = String(html ?? '');
  const results = [];
  const seen = new Set();
  const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const matches = [...text.matchAll(linkRe)];
  for (let i = 0; i < matches.length && results.length < maxResults; i += 1) {
    const m = matches[i];
    const url = normalizeSearchUrl(decodeDdgHref(decodeEntities(m[1])));
    if (!url || seen.has(url)) continue;
    const end = i + 1 < matches.length ? matches[i + 1].index : m.index + 4000;
    const chunk = text.slice(m.index, end);
    const snip = chunk.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div)>/i);
    seen.add(url);
    results.push({
      title: decodeEntities(m[2]).slice(0, 200) || url,
      url,
      ...(snip ? { snippet: decodeEntities(snip[1]).slice(0, 500) } : {})
    });
  }
  return results;
}

/** DuckDuckGo 搜索（HTML 结果页，无需 key；本机实测比 Bing RSS 稳定得多）。 */
export async function ddgSearch(query, config = defaultConfig) {
  const url = new URL('https://html.duckduckgo.com/html/');
  url.searchParams.set('q', query);
  const res = await safeFetch(url.toString(), 512000);
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`DuckDuckGo 搜索 HTTP ${res.statusCode}`);
  const results = parseDdgHtml(res.body, config.maxResults || defaultConfig.maxResults);
  if (!results.length) throw new Error('DuckDuckGo 没有解析到结果');
  return results;
}

const cache = new Map(); // `${provider}|${query}` -> { at, value }

export function clearSearchCache() {
  cache.clear();
}

/**
 * 统一入口：按配置选择 provider；`auto` 先试 DeepSeek（与 DSH 同源），
 * 失败回退 DuckDuckGo（HTML），再失败回退 Bing（RSS→HTML）。
 * @returns {{query:string, provider:'deepseek'|'duckduckgo'|'bing', results:object[], fallbackFrom?:string, note?:string}}
 */
export async function webSearch(query, options = {}) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('查询词为空');
  const config = { ...loadSearchConfig(options.root ?? process.cwd()), ...(options.config ?? {}) };
  const wanted = options.provider ?? config.provider;
  const cacheKey = `${wanted}|${q}|${config.maxResults}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const attemptDeepSeek = async () => {
    const results = await deepseekSearch(q, config);
    return { query: q, provider: 'deepseek', results };
  };
  const attemptDdg = async () => {
    const results = await ddgSearch(q, config);
    return { query: q, provider: 'duckduckgo', results };
  };
  const attemptBing = async () => {
    const results = await bingSearch(q, config);
    return { query: q, provider: 'bing', results };
  };

  let value;
  if (wanted === 'deepseek') {
    value = await attemptDeepSeek();
  } else if (wanted === 'ddg') {
    value = await attemptDdg();
  } else if (wanted === 'bing') {
    value = await attemptBing();
  } else {
    try {
      value = await attemptDeepSeek();
    } catch (error) {
      const reason = error?.code === 'NO_KEY' ? '未配置 DeepSeek 搜索凭据' : `DeepSeek 搜索不可用：${error?.message ?? error}`;
      try {
        value = await attemptDdg();
        value = { ...value, fallbackFrom: 'deepseek', note: `${reason}，已回退 DuckDuckGo` };
      } catch (ddgError) {
        try {
          value = await attemptBing();
          value = { ...value, fallbackFrom: 'deepseek', note: `${reason}，DuckDuckGo 也失败（${ddgError?.message ?? ddgError}），已回退 Bing` };
        } catch (bingError) {
          // 全部失败时把三边原因都带出来，否则调用方不知道卡在哪一步。
          throw new Error(`${reason}；DuckDuckGo 也失败：${ddgError?.message ?? ddgError}；Bing 兜底也失败：${bingError?.message ?? bingError}`);
        }
      }
    }
  }
  // 空结果必须显式说明：以前直接返回 `results: []`，模型分不清「真没搜到」和
  // 「搜索接口静默失效」，会一直换关键词重试（issue #17）。现在给出可操作的下一步。
  // ⚠️ 这段必须在 `cache.set` **之前**：note 走的是「新建对象」而不是原地改，
  // 而缓存里存的是**引用**。反过来写（先缓存、后加 note）时，5 分钟内的重复查询会命中
  // 那个没有 note 的旧对象 —— 恰好是模型最容易开始重试的场景（同一句 query 连着问）。
  if (Array.isArray(value.results) && value.results.length === 0) {
    value = { ...value, note: [value.note, '没有搜到结果（可换个说法/加限定词；仍为空就不要再重复搜索）'].filter(Boolean).join('；') };
  }
  cache.set(cacheKey, { at: Date.now(), value });
  if (cache.size > CACHE_MAX_ENTRIES) {
    for (const key of [...cache.keys()].slice(0, cache.size - CACHE_MAX_ENTRIES)) cache.delete(key);
  }
  return value;
}
