import './environment.mjs';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeTempDir, run } from './helpers.mjs';
import { setConfig } from '../plugins/codex/scripts/lib/state.mjs';

const hook = fileURLToPath(new URL('../plugins/codex/scripts/stop-review-gate-hook.mjs', import.meta.url));
const companion = fileURLToPath(new URL('../plugins/codex/scripts/codex-companion.mjs', import.meta.url));

function runGate(result) {
  const cwd = makeTempDir();
  setConfig(cwd, 'stopReviewGate', true);
  const calls = path.join(cwd, 'calls.json');
  const preload = path.join(cwd, 'stop-review-spawn.mjs');
  fs.writeFileSync(preload, `import fs from 'node:fs';
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    const original = childProcess.spawnSync;
    childProcess.spawnSync = function(command, args, options) {
      if (command === 'codex') return { status: 0, stdout: 'fake Codex', stderr: '' };
      if (command === process.execPath && args[0] === ${JSON.stringify(companion)} && args[1] === 'task') {
        fs.writeFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, timeout: options.timeout }));
        return ${JSON.stringify(result)};
      }
      return original.call(this, command, args, options);
    };
    syncBuiltinESMExports();`);
  const output = run(process.execPath, ['--import', preload, hook], { cwd, input: JSON.stringify({ cwd }) });
  assert.equal(output.status, 0, output.stderr);
  return { ...output, call: JSON.parse(fs.readFileSync(calls, 'utf8')) };
}

test('stop gate gives its observer the full job timeout within the hook deadline', () => {
  const result = runGate({ status: 0, stdout: JSON.stringify({ rawOutput: 'ALLOW: Review clean.' }), stderr: '' });
  assert.equal(result.stdout, '');
  const { args, timeout } = result.call;
  assert.equal(args[1], 'task');
  assert.ok(args.includes('--json'));
  assert.equal(args[args.indexOf('--timeout-ms') + 1], '890000');
  assert.equal(args[args.indexOf('--job-timeout-ms') + 1], '890000');
  assert.equal(timeout, 900000);
});

for (const [name, result, expected] of [
  ['exit 124', { status: 124, stdout: JSON.stringify({ meta: { jobId: 'task-stop-waiting' }, rawOutput: 'ALLOW: Partial output.' }), stderr: 'observer timed out' }, '/codex:await task-stop-waiting'],
  ['waitTimedOut payload', { status: 0, stdout: JSON.stringify({ waitTimedOut: true, meta: { jobId: 'task-stop-payload' }, rawOutput: 'ALLOW: Partial output.' }), stderr: '' }, '/codex:await task-stop-payload'],
  ['exit 124 without JSON', { status: 124, stdout: '', stderr: 'observer timed out' }, '/codex:await <job-id>']
]) test(`stop gate reports still-running work for ${name}`, () => {
  const output = runGate(result);
  const decision = JSON.parse(output.stdout);
  assert.equal(decision.decision, 'block');
  assert.match(decision.reason, /is still running/);
  assert.ok(decision.reason.includes(expected));
  assert.doesNotMatch(decision.reason, /task failed|invalid JSON|found issues|Partial output/);
  if (!result.stdout) assert.match(decision.reason, /\/codex:status/);
});
