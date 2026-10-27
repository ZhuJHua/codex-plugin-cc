import './environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexAppServerClient } from '../plugins/codex/scripts/lib/app-server.mjs';
import { processAlive } from '../plugins/codex/scripts/lib/atomic-store.mjs';
import { makeTempDir } from './helpers.mjs';
import { installFakeCodex, buildEnv } from './fake-codex-fixture.mjs';
import { registerTestProcess } from './cleanup.mjs';

function fixture(behavior) {
  const cwd = makeTempDir(), bin = makeTempDir();
  installFakeCodex(bin, behavior);
  return { cwd, env: buildEnv(bin) };
}

test('rollout thread-not-found diagnostics are suppressed only after initiated shutdown', async () => {
  const noise = '\u001b[31m2026-10-27T00:00:00Z ERROR codex_core::session: failed to record rollout items: thread thr_1 not found\u001b[0m';
  const client = new CodexAppServerClient('unused');
  client.handleStderrLine(noise);
  assert.match(client.stderr, /thread thr_1 not found/);
  client.stderr = '';
  client.sendMessage = message => client.handleLine(JSON.stringify({ id: message.id, result: {} }));
  await client.request('turn/interrupt', { threadId: 'thr_1', turnId: 'turn_1' });
  client.handleStderrLine(noise);
  client.handleStderrLine('ERROR codex_core::session: failed to record rollout items: disk full');
  client.handleStderrLine('ERROR other_module: thread thr_1 not found');
  assert.doesNotMatch(client.stderr, /rollout items: thread thr_1 not found/);
  assert.match(client.stderr, /disk full/);
  assert.match(client.stderr, /other_module/);

  const controller = new AbortController();
  const cancelled = new CodexAppServerClient('unused', { signal: controller.signal });
  controller.abort();
  cancelled.handleStderrLine(noise);
  assert.equal(cancelled.stderr, '');
  const closed = new CodexAppServerClient('unused');
  await closed.close();
  closed.handleStderrLine(noise);
  assert.equal(closed.stderr, '');
});

test('default clients own separate process groups and closing one preserves the other', async t => {
  const f = fixture();
  let firstProcess, secondProcess;
  const first = await CodexAppServerClient.connect(f.cwd, { env: f.env, onProcess: value => { firstProcess = value; registerTestProcess(value.appServerPid, value.appServerPgid, f.cwd); } });
  t.after(() => first.close());
  const second = await CodexAppServerClient.connect(f.cwd, { env: f.env, onProcess: value => { secondProcess = value; registerTestProcess(value.appServerPid, value.appServerPgid, f.cwd); } });
  t.after(() => second.close());
  assert.notEqual(firstProcess.appServerPid, secondProcess.appServerPid);
  if (process.platform !== 'win32') {
    assert.equal(firstProcess.appServerPgid, firstProcess.appServerPid);
    assert.equal(secondProcess.appServerPgid, secondProcess.appServerPid);
  }
  await first.close();
  assert.equal(processAlive(firstProcess.appServerPid), false);
  assert.equal(processAlive(secondProcess.appServerPid), true);
  const config = await second.request('config/read', { cwd: f.cwd, includeLayers: false });
  assert.equal(config.config.model_provider, 'openai');
  await second.close();
  assert.equal(processAlive(secondProcess.appServerPid), false);
});

test('default client cancellation cleans up an app-server awaiting initialization', async t => {
  const f = fixture('initialize-hangs');
  const controller = new AbortController();
  let pid, timer;
  t.after(() => clearTimeout(timer));
  await assert.rejects(CodexAppServerClient.connect(f.cwd, {
    env: f.env, signal: controller.signal,
    onProcess(value) {
      pid = value.appServerPid;
      registerTestProcess(value.appServerPid, value.appServerPgid, f.cwd);
      timer ??= setTimeout(() => controller.abort(new Error('cancel initialization')), 100);
    }
  }), /cancel initialization/);
  assert.equal(processAlive(pid), false);
});

test('default client reports a missing executable without hanging or leaking', async () => {
  const cwd = makeTempDir(), emptyBin = makeTempDir();
  await assert.rejects(CodexAppServerClient.connect(cwd, { env: { ...buildEnv(emptyBin), PATH: emptyBin }, requestTimeoutMs: 1000 }), /ENOENT|not recognized|not found/i);
});
