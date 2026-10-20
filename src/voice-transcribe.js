// 本地语音转写（whisper.cpp）+ 繁转简。
//
// 链路：任意音频 → ffmpeg 转 16kHz 单声道 wav → whisper-cli 转写 → opencc 繁转简。
// 默认从本仓库 tools/ 查找依赖，也可用下列环境变量指定自己的安装位置：
//   ffmpeg   tools\ffmpeg\bin\ffmpeg.exe
//   whisper  tools\whisper\bin\whisper-cli.exe + tools\whisper\models\ggml-small-q5_1.bin
// 环境变量（可选）：FFMPEG_PATH / WHISPER_CLI / WHISPER_MODEL
//
// 为什么要繁转简：whisper 的 small 模型经常吐繁体，不转的话她会突然变台湾腔。
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import * as OpenCC from 'opencc-js';

const execFileAsync = promisify(execFile);

const TOOLS = fileURLToPath(new URL('../tools/', import.meta.url));
const DEFAULT_FFMPEG = path.join(TOOLS, 'ffmpeg', 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const DEFAULT_WHISPER = path.join(TOOLS, 'whisper', 'bin', process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli');
const DEFAULT_MODEL = path.join(TOOLS, 'whisper', 'models', 'ggml-small-q5_1.bin');

const toSimplified = OpenCC.Converter({ from: 'tw', to: 'cn' });

function firstExisting(candidates, fallback) {
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return fallback;
}

/**
 * 转写一段音频。
 * @param {string} audioFile 本地音频路径（amr/wav/mp3/silk 转出来的 wav 都行）
 * @param {object} [opts]
 * @param {string} [opts.lang='zh'] 语言；'auto' 表示让 whisper 自己判断
 * @param {number} [opts.threads=8]
 * @param {string} [opts.prompt] 转写提示词
 * @param {string} [opts.ffmpegPath]
 * @param {string} [opts.whisperPath]
 * @param {string} [opts.modelPath]
 * @returns {Promise<{ok:boolean,text:string,rawText:string,elapsedMs:number,error?:string}>}
 */
export async function transcribeAudio(audioFile, opts = {}) {
  const startedAt = Date.now();
  const ffmpeg = firstExisting([opts.ffmpegPath, process.env.FFMPEG_PATH], DEFAULT_FFMPEG);
  const whisper = firstExisting([opts.whisperPath, process.env.WHISPER_CLI], DEFAULT_WHISPER);
  const model = firstExisting([opts.modelPath, process.env.WHISPER_MODEL], DEFAULT_MODEL);
  const lang = opts.lang || 'zh';
  const threads = Math.max(1, Math.min(32, Number(opts.threads) || 8));
  const prompt = opts.prompt || '以下是普通话的句子，请用简体中文转写。';

  if (!fs.existsSync(audioFile)) {
    return { ok: false, text: '', rawText: '', elapsedMs: 0, error: `音频不存在：${audioFile}` };
  }
  for (const [label, file] of [['ffmpeg', ffmpeg], ['whisper-cli', whisper], ['模型', model]]) {
    if (!fs.existsSync(file)) {
      return { ok: false, text: '', rawText: '', elapsedMs: 0, error: `${label} 没装：${file}` };
    }
  }

  const tmpWav = path.join(os.tmpdir(), `whisper-${process.pid}-${Date.now()}.wav`);
  try {
    await execFileAsync(
      ffmpeg,
      ['-y', '-hide_banner', '-loglevel', 'error', '-i', audioFile, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', tmpWav],
      { timeout: 120000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    );

    const args = ['-m', model, '-f', tmpWav, '-nt', '-np', '-t', String(threads), '--prompt', prompt];
    if (lang !== 'auto') args.push('-l', lang);
    const { stdout } = await execFileAsync(whisper, args, {
      timeout: 300000,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
      encoding: 'utf8',
    });

    const rawText = String(stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !/^(whisper_|read_audio_data|main:|system_info)/i.test(line))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    return {
      ok: true,
      text: toSimplified(rawText),
      rawText,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ok: false,
      text: '',
      rawText: '',
      elapsedMs: Date.now() - startedAt,
      error: String(error?.stderr || error?.message || error).slice(0, 800),
    };
  } finally {
    try { fs.unlinkSync(tmpWav); } catch {}
  }
}
