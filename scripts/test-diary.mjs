// 日记本离线回归：不联网、不碰真实 state。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { writeDiary, readDiary, dayKey, isValidDay, MAX_ENTRIES_PER_DAY } from '../src/diary-lib.js';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-diary-'));
}

test('写入后能按天读回，正文与元数据都在', () => {
  const root = tempRoot();
  const saved = writeDiary(root, { text: '今天他把语音修好了。', title: '修好了', mood: '开心', tags: ['日常', '他'] });
  assert.equal(saved.ok, true);
  assert.equal(saved.day, dayKey());
  const file = path.join(root, 'state', 'diary', `${saved.day}.md`);
  const raw = fs.readFileSync(file, 'utf8');
  assert.match(raw, /今天他把语音修好了。/);
  assert.match(raw, /心情：开心/);
  assert.match(raw, /标签：日常、他/);
  const read = readDiary(root, { n: 2 });
  assert.equal(read.days, 1);
  assert.match(read.entries[0].text, /今天他把语音修好了。/);
});

test('指定 day 只读那一天；非法 day 被拒绝', () => {
  const root = tempRoot();
  writeDiary(root, { text: '第一天的记录' }, new Date('2026-10-17T10:00:00'));
  writeDiary(root, { text: '第二天的记录' }, new Date('2026-10-18T10:00:00'));
  const one = readDiary(root, { day: '2026-10-17' });
  assert.equal(one.days, 1);
  assert.match(one.entries[0].text, /第一天的记录/);
  assert.doesNotMatch(one.entries[0].text, /第二天的记录/);
  for (const bad of ['../etc/passwd', '2026-13-01', '2026-02-30', 'x']) {
    assert.throws(() => readDiary(root, { day: bad }), /day 必须|有效日期/);
    assert.equal(isValidDay(bad), false);
  }
});

test('正文为空/超长被拒绝，且不产生半截文件', () => {
  const root = tempRoot();
  assert.throws(() => writeDiary(root, { text: '   ' }), /不能为空/);
  assert.throws(() => writeDiary(root, { text: 'x'.repeat(4001) }), /过长/);
  const dir = path.join(root, 'state', 'diary');
  assert.equal(fs.existsSync(dir), false, '失败时不创建目录');
});

test('同一天超过条数上限后拒绝继续写', () => {
  const root = tempRoot();
  for (let i = 0; i < MAX_ENTRIES_PER_DAY; i += 1) {
    writeDiary(root, { text: `第 ${i + 1} 条` }, new Date(`2026-10-18T0${Math.floor(i / 10)}:${String(i % 60).padStart(2, '0')}:00`));
  }
  assert.throws(() => writeDiary(root, { text: '第 21 条' }, new Date('2026-10-18T23:00:00')), /上限/);
  const read = readDiary(root, { day: '2026-10-18' });
  assert.match(read.entries[0].text, /第 20 条/);
});

test('标签数量与长度被收敛，坏索引行不影响写入', () => {
  const root = tempRoot();
  const dir = path.join(root, 'state', 'diary');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.jsonl'), 'not-json\n');
  const saved = writeDiary(root, {
    text: '测试标签',
    tags: Array.from({ length: 12 }, (_, i) => `tag-${i}`),
    title: 'x'.repeat(100),
  });
  assert.equal(saved.ok, true);
  const raw = fs.readFileSync(path.join(dir, `${saved.day}.md`), 'utf8');
  const tagLine = raw.split('\n').find((line) => line.startsWith('- 标签：')) ?? '';
  assert.ok((tagLine.match(/tag-/g) ?? []).length <= 8, '标签最多 8 个');
  assert.ok(saved.title.length <= 60, '标题被截断');
});
