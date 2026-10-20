// QQ 音乐当前播放自检（Windows 媒体会话）。只读，不控制播放器。
import assert from 'node:assert/strict';
import { nowPlaying } from '../src/music-now.js';

const data = await nowPlaying();
console.log(JSON.stringify(data, null, 2));
assert.equal(data.ok, true, 'nowPlaying 应返回 ok:true');
assert.equal(typeof data.hasSession, 'boolean');
assert.equal(typeof data.playing, 'boolean');
assert.equal(typeof data.title, 'string');
assert.equal(typeof data.artist, 'string');
assert.equal(typeof data.status, 'string');
assert.ok(Number.isFinite(data.positionSec) && Number.isFinite(data.durationSec));
console.log(data.hasSession ? `当前：${data.title} - ${data.artist}（${data.status}）` : '当前没有 QQ 音乐会话');
