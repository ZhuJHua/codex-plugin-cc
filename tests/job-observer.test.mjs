import './environment.mjs';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDir } from './helpers.mjs';
import { createJobProgressReader, DEFAULT_OBSERVER_TIMEOUT_MS } from '../plugins/codex/scripts/lib/job-observer.mjs';

const progress = text => `[2026-10-27T00:00:00.000Z] [progress] ${text}\n`;

test('attach replays only the last 20 progress lines then streams every new line', () => {
  const logFile = path.join(makeTempDir(), 'progress.log');
  fs.writeFileSync(logFile, Array.from({ length: 45 }, (_, i) => progress(`old-${i}`) + `raw output ${i}\n`).join(''));
  let output = '';
  const read = createJobProgressReader({ write: text => { output += text; } });
  read({ logFile });
  assert.equal(output.split('\n')[0], `… 25 earlier progress lines in ${logFile}`);
  assert.equal(output.match(/old-/g).length, 20);
  assert.doesNotMatch(output, /old-(?:[0-9]|1[0-9]|2[0-4])\n|raw output/);
  assert.match(output, /old-25\n/);
  output = '';
  fs.appendFileSync(logFile, Array.from({ length: 30 }, (_, i) => progress(`live-${i}`)).join(''));
  read({ logFile });
  assert.equal(output.match(/live-/g).length, 30);
  assert.doesNotMatch(output, /earlier|old-/);
  read({ logFile });
  assert.equal(output.match(/live-/g).length, 30);
});

test('progress replay handles chunk boundaries, split UTF-8 and partial live lines', () => {
  const logFile = path.join(makeTempDir(), 'progress.log');
  fs.writeFileSync(logFile, 'x'.repeat(65534 - Buffer.byteLength(progress('').trimEnd() + ' ')) + '\n' + progress('调查进度') + progress('partial').trimEnd());
  let output = '';
  const read = createJobProgressReader({ write: text => { output += text; } });
  read({ logFile });
  assert.match(output, /调查进度\n/);
  assert.doesNotMatch(output, /partial/);
  fs.appendFileSync(logFile, '继续\n');
  read({ logFile });
  assert.match(output, /partial继续\n/);
  assert.doesNotMatch(output, /�/);
});

test('foreground progress streams from the start and observer default is nine minutes', () => {
  assert.equal(DEFAULT_OBSERVER_TIMEOUT_MS, 540000);
  const logFile = path.join(makeTempDir(), 'progress.log');
  fs.writeFileSync(logFile, progress('Queued Codex Task.') + Array.from({ length: 40 }, (_, i) => progress(`line-${i}`)).join(''));
  let output = '';
  createJobProgressReader({ replayLimit: Infinity, write: text => { output += text; } })({ logFile });
  assert.match(output, /Queued Codex Task\./);
  assert.equal(output.match(/line-/g).length, 40);
  assert.doesNotMatch(output, /earlier/);
});
