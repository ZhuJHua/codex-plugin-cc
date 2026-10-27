import { testEnvironment } from './environment.mjs';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { makeTempDir, run } from './helpers.mjs';
import { testProcesses, assertNoTestProcesses, cleanupTestProcesses } from './cleanup.mjs';

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
    import { spawn } from 'node:child_process';
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
