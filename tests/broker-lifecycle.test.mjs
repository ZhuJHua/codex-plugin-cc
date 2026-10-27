import './environment.mjs';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeTempDir, run } from './helpers.mjs';
import { installFakeCodex, buildEnv } from './fake-codex-fixture.mjs';
import { ensureBrokerSession, sendBrokerShutdown } from '../plugins/codex/scripts/lib/broker-lifecycle.mjs';
import { cleanupTestProcesses, assertNoTestProcesses } from './cleanup.mjs';
const runner = fileURLToPath(new URL('../plugins/codex/scripts/codex-companion.mjs', import.meta.url));

test('setup reuses the compatibility broker and teardown removes its app-server', async t => {
  const cwd = makeTempDir(), bin = makeTempDir();
  installFakeCodex(bin);
  const env = buildEnv(bin);
  t.after(() => cleanupTestProcesses([cwd, bin]));
  const broker = await ensureBrokerSession(cwd, { env });
  assert.ok(broker);
  const result = run(process.execPath, [runner, 'setup', '--json'], { cwd, env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ready, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(bin, 'fake-codex-state.json'), 'utf8')).appServerStarts, 1);
  await sendBrokerShutdown(broker.endpoint);
  await cleanupTestProcesses([cwd, bin]);
  assertNoTestProcesses([cwd, bin]);
});

test('failed compatibility broker startup terminates its entire owned process group', async t => {
  const cwd = makeTempDir(), bin = makeTempDir();
  installFakeCodex(bin, 'initialize-hangs');
  t.after(() => cleanupTestProcesses([cwd, bin]));
  assert.equal(await ensureBrokerSession(cwd, { env: buildEnv(bin), timeoutMs: 250 }), null);
  await new Promise(resolve => setTimeout(resolve, 100));
  assertNoTestProcesses([cwd, bin]);
});
