import './environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexAppServerClient } from '../plugins/codex/scripts/lib/app-server.mjs';
import { processAlive } from '../plugins/codex/scripts/lib/atomic-store.mjs';
import { makeTempDir } from './helpers.mjs';
import { installFakeCodex, buildEnv } from './fake-codex-fixture.mjs';

function fixture(behavior) {
  const cwd = makeTempDir(), bin = makeTempDir();
  installFakeCodex(bin, behavior);
  return { cwd, env: buildEnv(bin) };
}

test('default clients own separate process groups and closing one preserves the other', async t => {
  const f = fixture();
  let firstProcess, secondProcess;
  const first = await CodexAppServerClient.connect(f.cwd, { env: f.env, onProcess: value => { firstProcess = value; } });
  t.after(() => first.close());
  const second = await CodexAppServerClient.connect(f.cwd, { env: f.env, onProcess: value => { secondProcess = value; } });
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
      timer ??= setTimeout(() => controller.abort(new Error('cancel initialization')), 100);
    }
  }), /cancel initialization/);
  assert.equal(processAlive(pid), false);
});

test('default client reports a missing executable without hanging or leaking', async () => {
  const cwd = makeTempDir(), emptyBin = makeTempDir();
  await assert.rejects(CodexAppServerClient.connect(cwd, { env: { ...buildEnv(emptyBin), PATH: emptyBin }, requestTimeoutMs: 1000 }), /ENOENT|not recognized|not found/i);
});
