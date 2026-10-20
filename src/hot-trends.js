// 热榜简报：定期抓「贴吧热议 + B站热门」，缓存到 state/hot-trends.json。
//
// 只抓不发：桥接在唤醒提示里注入一行「最近什么最热」，由模型自己决定要不要用。
// 抓取全在后台、不进入对话上下文；失败不重试轰炸，也不清掉旧缓存
// （宁可给几小时前的热榜，也不给空行）。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { truncateText } from './md-to-plain.js';

export const HOT_TRENDS_FILE_VERSION = 1;
export const HOT_TREND_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function oneLine(value, max) {
  return truncateText(
    String(value ?? '')
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim(),
    max
  );
}

function str(value) {
  return String(value ?? '').trim().replace(/&amp;/g, '&');
}

export const HOT_TREND_SOURCES = [
  {
    id: 'tieba',
    label: '贴吧热议',
    url: 'https://tieba.baidu.com/hottopic/browse/topicList',
    referer: 'https://tieba.baidu.com/',
    parse(json) {
      const topics = json?.data?.bang_topic?.topic_list;
      if (!Array.isArray(topics)) return [];
      const seen = new Set();
      const out = [];
      for (const topic of topics) {
        const title = oneLine(topic?.topic_name, 60);
        if (!title || seen.has(title)) continue;
        seen.add(title);
        out.push({
          title,
          desc: oneLine(topic?.topic_desc || topic?.abstract, 100),
          url:
            str(topic?.topic_url) ||
            `https://tieba.baidu.com/hottopic/browse/hottopic?topic_id=${encodeURIComponent(str(topic?.topic_id))}`
        });
      }
      return out;
    }
  },
  {
    id: 'bilibili',
    label: 'B站热门',
    url: 'https://api.bilibili.com/x/web-interface/popular?ps=20&pn=1',
    referer: 'https://www.bilibili.com/',
    parse(json) {
      if (json?.code !== 0) return [];
      const list = json?.data?.list;
      if (!Array.isArray(list)) return [];
      const out = [];
      for (const video of list) {
        const title = oneLine(video?.title, 60);
        if (!title) continue;
        out.push({
          title,
          desc: oneLine(video?.desc, 100),
          url: str(video?.short_link_v2) || `https://www.bilibili.com/video/${encodeURIComponent(str(video?.bvid))}`
        });
      }
      return out;
    }
  }
];

export const HOT_TREND_SOURCE_IDS = HOT_TREND_SOURCES.map((source) => source.id);

async function fetchSource(source, { timeoutMs = 12000 } = {}) {
  const response = await fetch(source.url, {
    headers: {
      'user-agent': HOT_TREND_UA,
      referer: source.referer,
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9'
    },
    signal: AbortSignal.timeout(Math.max(3000, Math.floor(Number(timeoutMs) || 12000)))
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const json = await response.json();
  const items = source.parse(json).slice(0, 30);
  if (!items.length) throw new Error('解析不到条目');
  return items;
}

export function createHotTrendCache(file, { log } = {}) {
  let cache = { version: HOT_TRENDS_FILE_VERSION, updatedAt: 0, sources: {} };
  let loaded = false;

  function ensureLoaded() {
    if (loaded) return cache;
    loaded = true;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data && typeof data === 'object' && data.sources && typeof data.sources === 'object') cache = data;
    } catch (error) {
      if (error?.code !== 'ENOENT') log?.(`⚠️ 热榜缓存读取失败（会重建）：${error?.message ?? error}`);
    }
    return cache;
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(cache)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, file);
      return true;
    } catch (error) {
      log?.(`⚠️ 热榜缓存写入失败：${error?.message ?? error}`);
      return false;
    }
  }

  // 抓一轮所有源。单个源失败保留它的旧条目，不整体作废。
  async function collect({ perSourceLimit = 20, timeoutMs = 12000 } = {}) {
    ensureLoaded();
    const results = await Promise.allSettled(HOT_TREND_SOURCES.map((source) => fetchSource(source, { timeoutMs })));
    const sources = { ...cache.sources };
    const report = { ok: [], failed: [] };
    results.forEach((result, index) => {
      const source = HOT_TREND_SOURCES[index];
      if (result.status === 'fulfilled') {
        sources[source.id] = {
          label: source.label,
          fetchedAt: Date.now(),
          items: result.value.slice(0, Math.max(1, Math.floor(Number(perSourceLimit) || 20)))
        };
        report.ok.push(source.id);
      } else {
        report.failed.push(`${source.id}: ${result.reason?.message ?? result.reason}`);
        if (!sources[source.id]) sources[source.id] = { label: source.label, fetchedAt: 0, items: [] };
      }
    });
    if (report.ok.length) {
      cache = { version: HOT_TRENDS_FILE_VERSION, updatedAt: Date.now(), sources };
      save();
    }
    return report;
  }

  // 给唤醒提示用的单行简报；过期或空就返回 ''。
  function brief({ maxChars = 480, maxAgeMs = 24 * 3600 * 1000, topPerSource = 3 } = {}) {
    ensureLoaded();
    const limit = Math.max(80, Math.floor(Number(maxChars) || 480));
    const ageLimit = Math.max(60 * 1000, Number(maxAgeMs) || 24 * 3600 * 1000);
    const top = Math.max(1, Math.floor(Number(topPerSource) || 3));
    const now = Date.now();
    const parts = [];
    for (const source of HOT_TREND_SOURCES) {
      const entry = cache.sources?.[source.id];
      if (!entry || !Array.isArray(entry.items) || !entry.items.length) continue;
      if (!entry.fetchedAt || now - entry.fetchedAt > ageLimit) continue;
      const titles = entry.items
        .slice(0, top)
        .map((item) => oneLine(item?.title, 40))
        .filter(Boolean);
      if (titles.length) parts.push(`${entry.label}：${titles.join('、')}`);
    }
    if (!parts.length) return '';
    const when = new Date(Number(cache.updatedAt) || 0);
    const stamp =
      Number.isFinite(when.getTime()) && Number(cache.updatedAt)
        ? `（${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')} ${String(
            when.getHours()
          ).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}）`
        : '';
    const text = `【热榜${stamp}】${parts.join('；')}`;
    return text.length > limit ? truncateText(text, limit) : text;
  }

  return {
    file,
    collect,
    brief,
    read() {
      return ensureLoaded();
    },
    stats() {
      ensureLoaded();
      return {
        updatedAt: Number(cache.updatedAt) || 0,
        sources: Object.fromEntries(
          Object.entries(cache.sources ?? {}).map(([id, entry]) => [id, Array.isArray(entry?.items) ? entry.items.length : 0])
        )
      };
    }
  };
}

// 后台定时器：启动后先看一眼缓存年龄（太旧就补抓），之后按 intervalMs 循环。
export function startHotTrendScheduler({ store, getCfg = () => ({}), log } = {}) {
  if (!store) throw new Error('startHotTrendScheduler 需要 store');
  let stopped = false;
  let running = false;
  let timer = null;

  function intervalMs() {
    return Math.max(10 * 60 * 1000, Number(getCfg()?.intervalMs) || 6 * 3600 * 1000);
  }

  async function tick(reason) {
    if (running) return false;
    if (getCfg()?.enabled === false) return false;
    running = true;
    const startedAt = Date.now();
    try {
      const report = await store.collect({
        perSourceLimit: Number(getCfg()?.perSourceLimit) || 20,
        timeoutMs: Number(getCfg()?.timeoutMs) || 12000
      });
      log?.(
        `[hot-trends] ${reason}：成功 ${report.ok.join(',') || '无'}；失败 ${
          report.failed.length ? report.failed.join(' | ') : '无'
        }；${Date.now() - startedAt}ms`
      );
      return true;
    } catch (error) {
      log?.(`[hot-trends] ${reason} 失败：${error?.message ?? error}`);
      return false;
    } finally {
      running = false;
    }
  }

  function schedule(delayMs) {
    if (stopped) return;
    timer = setTimeout(async () => {
      await tick('定时抓取');
      schedule(intervalMs() + Math.floor(Math.random() * 60 * 1000));
    }, Math.max(1000, delayMs));
    timer.unref?.();
  }

  const updatedAt = Number(store.read()?.updatedAt) || 0;
  const staleAfterMs = Math.min(12 * 3600 * 1000, intervalMs());
  const bootDelayMs = !updatedAt || Date.now() - updatedAt > staleAfterMs ? 8000 : intervalMs();
  schedule(bootDelayMs);

  return {
    tick,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    }
  };
}
