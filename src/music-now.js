// 读取本机 QQ 音乐当前播放（Windows 媒体会话 / GSMTC）。
//
// 为什么不用教程里网易云的 CDP：QQ 音乐不是 Chromium，没有 --remote-debugging-port；
// 但 Windows 10/11 会把 QQ 音乐的播放信息登记到系统媒体会话，WinRT 的 GSMTC 可直接读，
// 不需要装任何软件、也不需要改 QQ 音乐启动参数。
//
// 返回字段：ok / hasSession / playing / app / title / artist / album / status /
//           positionSec / durationSec（没有歌词——系统媒体会话不提供歌词）。
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, 'music-now.ps1');

function parseJsonLoose(text) {
  const raw = String(text ?? '').replace(/^\uFEFF/, '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('QQ 音乐状态输出为空或格式无法解析');
  return JSON.parse(raw.slice(start, end + 1));
}

/**
 * 读取当前 QQ 音乐播放状态（只读）。
 * @param {{timeoutMs?:number}} [options]
 * @returns {Promise<{ok:boolean,hasSession:boolean,playing:boolean,app:string|null,title:string,artist:string,album:string,status:string,positionSec:number,durationSec:number}>}
 */
export async function nowPlaying(options = {}) {
  if (process.platform !== 'win32') {
    return { ok: false, error: '仅 Windows 支持读取系统媒体会话', hasSession: false, playing: false };
  }
  const timeoutMs = Math.max(2000, Math.min(30000, Number(options.timeoutMs) || 12000));
  let stdout = '';
  try {
    const result = await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT
    ], { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024, encoding: 'utf8' });
    stdout = result.stdout;
  } catch (error) {
    throw new Error(`读取 QQ 音乐播放状态失败：${error?.message ?? error}`);
  }
  return parseJsonLoose(stdout);
}
