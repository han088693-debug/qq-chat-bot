// 收到的 QQ 语音 → 本地转写（whisper.cpp）。
//
// 链路：record 段 → SnowLuma get_record(out_format=wav) 转码拿 base64
//       → 落临时文件 → whisper.cpp 转写 → opencc 繁转简 → 回给 bridge 拼进提示词。
//
// 为什么要让网关转码：QQ 语音是 SILK，普通 ffmpeg 解不开；SnowLuma 自带能解的 native 模块。
// 为什么要缓存：同一条消息会被渲染多次（正文 / 纯净正文 / 引用解析），不缓存一次语音要转写三遍。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { transcribeAudio } from './voice-transcribe.js';

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 200;

/**
 * @param {object} deps
 * @param {() => {httpUrl?: string, accessToken?: string}} [deps.getSnowluma]
 * @param {() => {enabled?: boolean, maxSeconds?: number, timeoutMs?: number}} [deps.getAsrConfig]
 * @param {(...args:any[]) => void} [deps.log]
 * @param {(text: string, max: number) => string} [deps.truncate]
 */
export function createRecordAsr({ getSnowluma = () => ({}), getAsrConfig = () => ({}), log = () => {}, truncate = (s) => s } = {}) {
  const cache = new Map();

  function asrCfg() {
    const a = getAsrConfig() ?? {};
    return {
      enabled: a.enabled !== false,
      maxSeconds: Number(a.maxSeconds) > 0 ? Number(a.maxSeconds) : 120,
      timeoutMs: Number(a.timeoutMs) > 0 ? Number(a.timeoutMs) : 90000
    };
  }

  async function callAction(action, payload) {
    const sl = getSnowluma() ?? {};
    const httpUrl = String(sl.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const res = await fetch(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(sl.accessToken ? { authorization: `Bearer ${sl.accessToken}` } : {})
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      throw new Error(body?.wording || body?.message || `HTTP ${res.status}`);
    }
    return body.data ?? {};
  }

  /**
   * 把一条 record 段转成 wav（base64）。
   * 优先一步到位（SnowLuma ≥1.14.22 支持 file + out_format）；失败再走教程里的两步：
   * 先拿一次新鲜下载地址，再拿那个地址转码 —— 缓存里的 url 过期（rkey）时只有这条能救。
   */
  async function fetchRecordWavBase64(d) {
    const ref = String(d?.file || d?.file_id || d?.url || '').trim();
    if (!ref) throw new Error('语音段没有可用的文件名');
    try {
      const data = await callAction('get_record', { file: ref, out_format: 'wav' });
      if (data.base64) return String(data.base64);
    } catch { /* 走下面的两步兜底 */ }
    const info = await callAction('get_record', { file: ref });
    const source = String(info.url || info.file || '').trim();
    if (!source) throw new Error('拿不到语音的下载地址');
    const data = await callAction('get_record', { file: source, out_format: 'wav' });
    if (!data.base64) throw new Error('网关没返回转码后的音频');
    return String(data.base64);
  }

  /** 转写一条收到的语音。失败一律返回空串（宁可退回「[语音]」也不要让整条消息挂掉）。 */
  async function transcribeRecordSegment(d) {
    const a = asrCfg();
    if (!a.enabled) return '';
    const duration = Number(d?.duration) || 0;
    if (duration > a.maxSeconds) return '';
    const key = `${d?.file || d?.file_id || ''}|${duration}|${d?.file_size || ''}`;
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && now - hit.at < CACHE_TTL_MS) return hit.text;

    let text = '';
    let tmp = '';
    try {
      const base64 = await fetchRecordWavBase64(d);
      tmp = path.join(os.tmpdir(), `qq-voice-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.wav`);
      fs.writeFileSync(tmp, Buffer.from(base64, 'base64'));
      const threads = Math.max(4, Math.min(16, (os.cpus()?.length || 8) - 2));
      const result = await Promise.race([
        transcribeAudio(tmp, { lang: 'zh', threads }),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`转写超时(${a.timeoutMs}ms)`)), a.timeoutMs))
      ]);
      if (result?.ok && result.text) {
        text = result.text;
        log(`[asr] 语音转写 ${duration ? `${duration}s ` : ''}${result.elapsedMs}ms：${truncate(text, 60)}`);
      } else if (result && !result.ok) {
        log(`[asr] 转写失败：${truncate(String(result.error || ''), 200)}`);
      }
    } catch (error) {
      log(`[asr] 处理语音失败：${truncate(String(error?.message ?? error), 200)}`);
    } finally {
      if (tmp) { try { fs.unlinkSync(tmp); } catch {} }
    }

    if (cache.size >= CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { text, at: now });
    return text;
  }

  return { transcribeRecordSegment, cacheSize: () => cache.size };
}
