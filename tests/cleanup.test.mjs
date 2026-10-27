import { testEnvironment } from './environment.mjs';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnTestProcess as spawn } from './cleanup.mjs';
import { once } from 'node:events';
import { makeTempDir, run } from './helpers.mjs';
import { testProcesses, assertNoTestProcesses, cleanupTestProcesses, spawnSyncTestProcess } from './cleanup.mjs';

test('cleanup detects and removes a detached test process', async t => {
  const root = makeTempDir();
  const file = path.join(root, 'leaked-test-process.mjs');
  fs.writeFileSync(file, 'setInterval(()=>{},1000);');
  const child = spawn(process.execPath, [file], { detached: true, stdio: 'ignore' });
  t.after(() => cleanupTestProcesses([root]));
  await once(child, 'spawn');
  assert.ok(testProcesses([root]).some(row => row.pid === child.pid));
  assert.throws(() => assertNoTestProcesses([root]), /Leaked test processes/);
  await cleanupTestProcesses([root]);
  assertNoTestProcesses([root]);
});


test('an assertion failure still runs process-group fixture teardown', () => {
  const root = makeTempDir();
  const script = path.join(root, 'failing-fixture.test.mjs');
  const sleeper = path.join(root, 'sleeper.mjs');
  fs.writeFileSync(sleeper, 'setInterval(()=>{},1000);');
  const cleanupUrl = new URL('./cleanup.mjs', import.meta.url).href;
  fs.writeFileSync(script, `import test from 'node:test';
    import assert from 'node:assert/strict';
    import { spawnTestProcess as spawn } from ${JSON.stringify(cleanupUrl)};
    import { once } from 'node:events';
    import { cleanupTestProcesses } from ${JSON.stringify(cleanupUrl)};
    test('expected fixture failure', async t => {
      const child = spawn(process.execPath, [${JSON.stringify(sleeper)}], { detached:true, stdio:'ignore' });
      t.after(() => cleanupTestProcesses([${JSON.stringify(root)}]));
      await once(child, 'spawn');
      assert.fail('intentional failure to verify teardown');
    });`);
  const env = testEnvironment();
  delete env.NODE_TEST_CONTEXT;
  const result = run(process.execPath, ['--test', script], { cwd: root, env });
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /intentional failure to verify teardown/);
  assertNoTestProcesses([root]);
});

for (const code of ['EPERM', 'ENOENT']) test(`cleanup detects and removes tracked leaks when ps fails with ${code}`, async t => {
  const root = makeTempDir();
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', root], { detached: true, stdio: 'ignore' });
  const unavailable = { readTable() { throw Object.assign(new Error('ps unavailable'), { code }); } };
  t.after(() => cleanupTestProcesses([root]));
  await once(child, 'spawn');
  assert.ok(testProcesses([root], unavailable).some(row => row.pid === child.pid));
  assert.throws(() => assertNoTestProcesses([root], unavailable), /Leaked test processes/);
  await cleanupTestProcesses([root], unavailable);
  assertNoTestProcesses([root], unavailable);
});

test('unavailable leak probes warn once while detectable leaks still fail', async t => {
  const root = makeTempDir();
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', root], { detached: true, stdio: 'ignore' });
  t.after(() => cleanupTestProcesses([root]));
  await once(child, 'spawn');
  const options = {
    readTable() { throw Object.assign(new Error('ps unavailable'), { code: 'EPERM' }); },
    kill() { throw Object.assign(new Error('kill unavailable'), { code: 'ENOSYS' }); }
  };
  let warnings = '';
  const original = process.stderr.write;
  process.stderr.write = text => { warnings += text; return true; };
  try { assertNoTestProcesses([root], options); assertNoTestProcesses([root], options); }
  finally { process.stderr.write = original; }
  assert.equal(warnings.match(/WARNING:/g)?.length, 1);
  assert.match(warnings, /Skipping unavailable test process leak probes/);
  assert.throws(() => assertNoTestProcesses([root], { ...options, kill: () => { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }); } }), /Leaked test processes/);
});

test('ps fallback also verifies detached runtimes recorded by a test CLI', async t => {
  const root = makeTempDir();
  // Simulate a worker launched inside a CLI, beyond the test's direct spawn tracker.
  const { spawn: launchWorker } = await import('node:child_process');
  const { writeJobFile } = await import('../plugins/codex/scripts/lib/state.mjs');
  const child = launchWorker(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: root, detached: true, stdio: 'ignore' });
  const unavailable = { readTable() { throw Object.assign(new Error('ps unavailable'), { code: 'EPERM' }); } };
  t.after(() => cleanupTestProcesses([root]));
  await once(child, 'spawn');
  writeJobFile(root, 'recorded-runtime', { id: 'recorded-runtime', workspaceRoot: root, status: 'running', appServerPid: child.pid, appServerPgid: process.platform === 'win32' ? null : child.pid });
  const broken = writeJobFile(root, 'broken-record', { id: 'broken-record', workspaceRoot: root });
  fs.writeFileSync(broken, '{broken');
  assert.ok(testProcesses([root], unavailable).some(row => row.pid === child.pid && row.command.includes('tracked job recorded-runtime')));
  assert.throws(() => assertNoTestProcesses([root], unavailable), /Leaked test processes/);
  await cleanupTestProcesses([root], unavailable);
  assertNoTestProcesses([root], unavailable);
});

test('ps fallback never probes completed synchronous or reaped child PIDs', async () => {
  const root = makeTempDir();
  const completed = spawnSyncTestProcess(process.execPath, ['-e', '', root], { cwd: root });
  assert.equal(completed.status, 0);
  const child = spawn(process.execPath, ['-e', '', root], { cwd: root });
  await once(child, 'exit');
  const unavailable = {
    readTable() { throw Object.assign(new Error('ps unavailable'), { code: 'EPERM' }); },
    kill(pid) { assert.fail(`Must not probe potentially reused PID ${pid}`); }
  };
  assert.deepEqual(testProcesses([root], unavailable), []);
});
