import "./environment.mjs";
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installFakeCodex, buildEnv } from './fake-codex-fixture.mjs';
import { cleanupCoordination, registerTestRoot, cleanupTestProcesses } from './cleanup.mjs';
import { initGitRepo } from './helpers.mjs';

const script = fileURLToPath(new URL('../plugins/codex/scripts/codex-companion.mjs', import.meta.url));
const hook = fileURLToPath(new URL('../plugins/codex/scripts/session-lifecycle-hook.mjs', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  do { const value = fn(); if (value) return value; await pause(25); } while (Date.now() < end);
  throw new Error('Timed out waiting for test condition');
}
function fixture(t, behavior = 'review-ok') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-reliability-'));
  registerTestRoot(root);
  const repo = path.join(root, 'repo'), bin = path.join(root, 'bin');
  fs.mkdirSync(repo); fs.mkdirSync(bin); initGitRepo(repo); installFakeCodex(bin, behavior);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'initial\n');
  spawnSync('git', ['add', '.'], { cwd: repo }); spawnSync('git', ['commit', '-m', 'initial'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'changed\n');
  const env = { ...buildEnv(bin), CLAUDE_PLUGIN_DATA: path.join(root, 'data'), CODEX_COMPANION_SESSION_ID: `session-${path.basename(root)}` };
  const jobs = () => {
    const state = path.join(root, 'data', 'state');
    if (!fs.existsSync(state)) return [];
    return fs.readdirSync(state).flatMap(dir => {
      const jobDir = path.join(state, dir, 'jobs');
      if (!fs.existsSync(jobDir)) return [];
      return fs.readdirSync(jobDir).filter(file => file.endsWith('.json')).map(file => JSON.parse(fs.readFileSync(path.join(jobDir, file), 'utf8')));
    });
  };
  t.after(async () => {
    for (const job of jobs()) for (const [pid, pgid] of [[job.appServerPid, job.appServerPgid], [job.pid, job.workerPgid]]) {
      if (pid && pid !== process.pid) try { process.kill(pgid ? -pgid : pid, 'SIGKILL'); } catch {}
    }
    await pause(100);
    await cleanupTestProcesses([root]);
    for (const job of jobs()) if (job.workspaceRoot) cleanupCoordination(job.workspaceRoot, env.CODEX_HOME);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const cli = (args, extra = {}) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: repo, env, encoding: 'utf8', timeout: 35000, ...extra });
    assert.ifError(result.error);
    return result;
  };
  return { root, repo, bin, env, jobs, cli, state: () => JSON.parse(fs.readFileSync(path.join(bin, 'fake-codex-state.json'), 'utf8')) };
}
const parsed = result => { assert.ok(result.stdout.trim(), result.stderr); return JSON.parse(result.stdout); };

test('root terminal errors, retryable notifications, subagent errors and transport death converge', async t => {
  for (const behavior of ['terminal-error', 'error-before-ack', 'retryable-error', 'subagent-error', 'connection-death', 'socket-close']) await t.test(behavior, t => {
    const f = fixture(t, behavior);
    const result = f.cli(['task', '--json', '--job-timeout-ms', '4000', 'inspect']);
    const data = parsed(result);
    const success = ['retryable-error', 'subagent-error'].includes(behavior);
    assert.equal(result.status, success ? 0 : 1, result.stderr);
    assert.equal(data.meta.jobStatus, success ? 'completed' : 'failed');
    assert.ok(data.meta.logFile); assert.ok(data.meta.resultFile);
    if (!success) assert.ok(data.meta.error);
  });
});

test('native and adversarial reviews use detached workers, native effort rejects and adversarial effort forwards', t => {
  const f = fixture(t);
  const unsupported = parsed(f.cli(['review', '--json', '--effort', 'high']));
  assert.match(unsupported.error.message, /does not support --effort/);
  assert.equal(fs.existsSync(path.join(f.bin, 'fake-codex-state.json')), false);
  const review = parsed(f.cli(['review', '--background', '--json']));
  assert.ok(review.jobId);
  const reviewed = parsed(f.cli(['await', review.jobId, '--json']));
  assert.equal(reviewed.meta.jobStatus, 'completed');
  assert.equal(reviewed.meta.resolved.effort, null);
  assert.match(reviewed.meta.resolved.sources.effort, /does-not-expose/);
  const adversarial = f.cli(['adversarial-review', '--json', '--model', 'known-model', '--effort', 'high']);
  assert.equal(adversarial.status, 0, adversarial.stderr);
  assert.equal(f.state().lastTurnStart.effort, 'high');
  assert.equal(parsed(adversarial).meta.resolved.effort, 'high');
  assert.equal(f.state().appServerStarts, 2);
});

test('model capability validation preserves choices and catalog auth errors', t => {
  const f = fixture(t);
  const bad = parsed(f.cli(['task', '--json', '--model', 'known-model', '--effort', 'ultra', 'inspect']));
  assert.match(bad.meta.error, /does not support effort ultra/);
  assert.equal(f.state().lastTurnStart, undefined);
  const unknown = f.cli(['task', '--json', '--model', 'custom-model', '--effort', 'ultra', 'inspect']);
  assert.equal(unknown.status, 0, unknown.stderr);
  assert.equal(f.state().lastTurnStart.effort, 'ultra');
  const auth = fixture(t, 'catalog-auth-fails');
  const rejected = parsed(auth.cli(['task', '--json', '--effort', 'high', 'inspect']));
  assert.match(rejected.meta.error, /catalog authentication failed/);
  assert.equal(auth.state().lastTurnStart, undefined);
  const old = fixture(t, 'catalog-unsupported');
  assert.equal(old.cli(['task', '--effort', 'high', 'inspect']).status, 0);
  const paged = fixture(t, 'catalog-paged');
  assert.equal(paged.cli(['task', '--model', 'known-model', '--effort', 'ultra', 'inspect']).status, 1);
  assert.equal(paged.state().catalogRequests, 2);
  const custom = fixture(t, 'provider-no-auth');
  assert.equal(custom.cli(['task', '--model', 'known-model', '--effort', 'ultra', 'inspect']).status, 0);
  assert.equal(custom.state().catalogRequests, undefined);
});

test('observer death leaves worker alive, await timeout preserves job, SessionEnd cancels with records', async t => {
  const f = fixture(t, 'interruptible-slow-task');
  const observer = spawn(process.execPath, [script, 'task', '--json', '--full-access', 'long task'], { cwd: f.repo, env: f.env, stdio: 'ignore' });
  t.after(() => { try { observer.kill('SIGKILL'); } catch {} });
  const job = await until(() => f.jobs().find(job => job.turnId));
  observer.kill('SIGKILL'); await pause(50);
  const timeout = f.cli(['await', job.id, '--timeout-ms', '0', '--json']);
  assert.equal(timeout.status, 124); assert.equal(parsed(timeout).waitTimedOut, true);
  const end = spawnSync(process.execPath, [hook, 'SessionEnd'], { cwd: f.repo, env: f.env, input: JSON.stringify({ session_id: f.env.CODEX_COMPANION_SESSION_ID, cwd: f.repo }), encoding: 'utf8', timeout: 10000 });
  assert.equal(end.status, 0, end.stderr);
  const final = parsed(f.cli(['await', job.id, '--json']));
  assert.equal(final.meta.jobStatus, 'cancelled');
  assert.equal(f.state().lastInterrupt.turnId, job.turnId);
  assert.ok(fs.existsSync(final.meta.resultFile)); assert.ok(fs.existsSync(final.meta.logFile));
  assert.match(final.meta.recoveryCommand, /--thread/);
});

test('foreground observer can disappear and the result is still retrievable', async t => {
  const f = fixture(t, 'slow-task');
  const observer = spawn(process.execPath, [script, 'task', '--json', 'inspect'], { cwd: f.repo, env: f.env, stdio: 'ignore' });
  t.after(() => { try { observer.kill('SIGKILL'); } catch {} });
  const job = await until(() => f.jobs().find(job => job.turnId)); observer.kill('SIGKILL');
  const result = f.cli(['await', job.id, '--json']);
  assert.equal(result.status, 0, result.stderr); assert.equal(parsed(result).meta.jobStatus, 'completed');
});

test('same thread recovery and workspace read/write conflicts reject with owner ID', async t => {
  const f = fixture(t, 'interruptible-slow-task');
  const launched = parsed(f.cli(['task', '--background', '--json', 'inspect']));
  const live = await until(() => f.jobs().find(job => job.id === launched.jobId && job.turnId));
  const collision = f.cli(['task', '--json', '--thread', live.threadId, 'continue']);
  assert.equal(collision.status, 1); assert.match(parsed(collision).error.message, new RegExp(live.id));
  const writer = f.cli(['task', '--json', '--write', 'edit']);
  assert.equal(writer.status, 1); assert.match(parsed(writer).error.message, new RegExp(live.id));
  assert.equal(f.cli(['cancel', live.id, '--json']).status, 0);
});

test('capacity retry resumes exact thread with a delta and fixed effective configuration', t => {
  const f = fixture(t, 'capacity-once');
  const result = f.cli(['task', '--json', '--full-access', '--model', 'known-model', '--effort', 'high', 'implement original unique request']);
  assert.equal(result.status, 0, result.stderr);
  const state = f.state(); assert.equal(state.turnHistory.length, 2); assert.equal(state.resumeHistory.length, 1);
  assert.equal(state.turnHistory[0].threadId, state.turnHistory[1].threadId);
  assert.doesNotMatch(state.turnHistory[1].prompt, /original unique request|Request:/);
  assert.equal(state.turnHistory[1].model, 'known-model'); assert.equal(state.turnHistory[1].effort, 'high');
  assert.deepEqual(state.turnHistory[1].sandboxPolicy, { type: 'dangerFullAccess' });
  assert.equal(fs.readFileSync(path.join(f.repo, 'partial-edit.txt'), 'utf8'), 'applied once');
  assert.equal(parsed(result).meta.resolved.sources.sandbox, 'accepted-turn-override');
});

test('capacity retry exhaustion offers exact recovery, cancellation interrupts backoff', async t => {
  const f = fixture(t, 'capacity-always');
  const result = f.cli(['task', '--json', '--full-access', '--model', 'known-model', '--effort', 'high', 'implement']);
  assert.equal(result.status, 1, result.stderr); assert.equal(f.state().turnHistory.length, 3);
  const failure = parsed(result); assert.match(failure.meta.recoveryCommand, /--thread.*thr_1/); assert.match(failure.meta.recoveryCommand, /--model.*known-model/);
  assert.match(failure.meta.recoveryCommand, /--full-access/);
  const other = fixture(t, 'capacity-always');
  const launch = parsed(other.cli(['task', '--background', '--json', 'inspect']));
  await until(() => other.jobs().find(job => job.phase === 'retrying'));
  const before = Date.now(); assert.equal(other.cli(['cancel', launch.jobId, '--json']).status, 0);
  assert.ok(Date.now() - before < 3000); assert.equal(other.state().turnHistory.length, 1);
});

test('two sessions execute in different worktrees and ending A preserves B', async t => {
  const f = fixture(t, 'interruptible-slow-task');
  const second = path.join(f.root, 'second-worktree');
  const added = spawnSync('git', ['worktree', 'add', '-b', 'second', second], { cwd: f.repo, encoding: 'utf8' });
  assert.equal(added.status, 0, added.stderr);
  const a = parsed(f.cli(['task', '--background', '--json', 'inspect A']));
  const root = await until(() => f.jobs().find(job => job.id === a.jobId && job.turnId));
  const envB = { ...f.env, CODEX_COMPANION_SESSION_ID: `${f.env.CODEX_COMPANION_SESSION_ID}-B` };
  const b = parsed(f.cli(['task', '--cwd', second, '--background', '--full-access', '--json', 'implement B'], { env: envB }));
  await until(() => f.jobs().find(job => job.id === b.jobId && job.turnId));
  const ended = spawnSync(process.execPath, [hook, 'SessionEnd'], { cwd: f.repo, env: f.env, encoding: 'utf8', input: JSON.stringify({ session_id: f.env.CODEX_COMPANION_SESSION_ID, cwd: f.repo }), timeout: 10000 });
  assert.equal(ended.status, 0, ended.stderr);
  assert.equal(parsed(f.cli(['await', a.jobId, '--json'])).meta.jobStatus, 'cancelled');
  const resultB = f.cli(['await', b.jobId, '--cwd', second, '--json'], { env: envB });
  assert.equal(resultB.status, 0, resultB.stderr); assert.equal(parsed(resultB).meta.jobStatus, 'completed');
  assert.deepEqual(f.state().lastInterrupt, { threadId: root.threadId, turnId: root.turnId });
});

test('worker death converges to failed and native review failure offers re-review', async t => {
  const f = fixture(t, 'interruptible-slow-task');
  const launched = parsed(f.cli(['task', '--background', '--json', 'inspect']));
  const job = await until(() => f.jobs().find(job => job.id === launched.jobId && job.turnId));
  process.kill(job.pid, 'SIGKILL');
  await pause(100);
  const result = f.cli(['await', job.id, '--json']);
  assert.equal(result.status, 1); assert.equal(parsed(result).meta.jobStatus, 'failed');
  assert.equal(typeof parsed(result).meta.recoveryCommand, 'string', JSON.stringify({ data: parsed(result), jobs: f.jobs() }));
  assert.match(parsed(result).meta.recoveryCommand, /--thread/);
  const review = fixture(t, 'terminal-error');
  const failed = review.cli(['review', '--json']);
  assert.equal(failed.status, 1, failed.stderr); const data = parsed(failed);
  assert.match(data.meta.error, /review terminal failure/);
  assert.match(data.meta.recoveryCommand, /'review'/);
  assert.doesNotMatch(data.meta.recoveryCommand, /--thread/);
});


test('task argv preserves the complete literal request, including whitespace and JSON', t => {
  const f = fixture(t);
  const request = '  Inspect {"path":"C:\\\\tmp", "flag":"--full-access", "quote":"a\\\"b"} and literal $(touch should-not-exist)\n';
  const result = f.cli(['task', '--json', '--', request]);
  assert.equal(result.status, 0, result.stderr);
  const prompt = f.state().lastTurnStart.prompt;
  assert.equal(prompt.slice(prompt.indexOf('\nRequest:\n') + '\nRequest:\n'.length), request);
  assert.equal(fs.existsSync(path.join(f.repo, 'should-not-exist')), false);
  const flagLike = '--full-access inspect the literal flag';
  const literal = f.cli(['task', '--json', flagLike]);
  assert.equal(literal.status, 0, literal.stderr);
  assert.equal(parsed(literal).sandbox, 'read-only');
  assert.ok(f.state().lastTurnStart.prompt.endsWith(flagLike));
});


test('cancellation closes a private runtime whose initialize RPC never answers', async t => {
  const f = fixture(t, 'initialize-hangs');
  const launch = parsed(f.cli(['task', '--background', '--json', 'inspect']));
  const job = await until(() => f.jobs().find(job => job.id === launch.jobId && job.appServerPid));
  const cancelled = f.cli(['cancel', job.id, '--json']);
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.equal(parsed(cancelled).status, 'cancelled');
  assert.equal(f.state().threads.length, 0);
  await until(() => { try { process.kill(job.appServerPid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } });
});

test('capacity RPC rejection keeps explicit effort rather than the unaccepted thread default', t => {
  const f = fixture(t, 'capacity-rpc-once');
  const result = f.cli(['task', '--json', '--model', 'known-model', '--effort', 'high', '--full-access', 'implement']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.state().turnHistory.length, 2);
  assert.deepEqual(f.state().turnHistory.map(turn => turn.effort), ['high', 'high']);
  assert.deepEqual(f.state().turnHistory.map(turn => turn.sandboxPolicy), [{ type: 'dangerFullAccess' }, { type: 'dangerFullAccess' }]);
  assert.equal(parsed(result).meta.resolved.effort, 'high');
});

test('a resumed Claude session dispatches new work while ended jobs remain terminal', async t => {
  const f = fixture(t, 'interruptible-slow-task');
  const lifecycle = (event, id = f.env.CODEX_COMPANION_SESSION_ID, source = undefined) => {
    const result = spawnSync(process.execPath, [hook, event], { cwd: f.repo, env: f.env, encoding: 'utf8', timeout: 10000,
      input: JSON.stringify({ session_id: id, cwd: f.repo, source }) });
    assert.equal(result.status, 0, result.stderr);
  };
  lifecycle('SessionStart');
  const old = parsed(f.cli(['task', '--background', '--json', 'old work']));
  await until(() => f.jobs().find(job => job.id === old.jobId && job.turnId));
  lifecycle('SessionEnd');
  assert.equal(f.jobs().find(job => job.id === old.jobId).status, 'cancelled');
  const otherId = `${f.env.CODEX_COMPANION_SESSION_ID}-other`;
  lifecycle('SessionEnd', otherId);
  lifecycle('SessionStart', f.env.CODEX_COMPANION_SESSION_ID, 'resume');
  installFakeCodex(f.bin);
  const next = f.cli(['task', '--json', 'new work']);
  assert.equal(next.status, 0, next.stderr);
  assert.equal(parsed(next).meta.jobStatus, 'completed');
  assert.equal(f.jobs().find(job => job.id === old.jobId).status, 'cancelled');
  const other = f.cli(['task', '--json', 'inspect'], { env: { ...f.env, CODEX_COMPANION_SESSION_ID: otherId } });
  assert.equal(other.status, 1); assert.match(parsed(other).error.message, /has ended/);
});

test('network tier sets per-thread and per-turn policy and survives a resume', t => {
  const f = fixture(t);
  const first = f.cli(['task', '--network', '--json', 'run network tests']);
  assert.equal(first.status, 0, first.stderr);
  const data = parsed(first);
  assert.equal(data.sandbox, 'workspace-write');
  assert.equal(data.meta.requested.networkAccess, true);
  assert.equal(data.meta.resolved.sandbox.type, 'workspaceWrite');
  assert.equal(data.meta.resolved.sandbox.networkAccess, true);
  assert.equal(f.state().lastThreadStart.config['sandbox_workspace_write.network_access'], true);
  assert.equal(f.state().lastTurnStart.sandboxPolicy.networkAccess, true);
  const resumed = f.cli(['task', '--thread', data.threadId, '--network', '--json', 'continue']);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(f.state().lastThreadResume.config['sandbox_workspace_write.network_access'], true);
  assert.equal(parsed(resumed).meta.resolved.sandbox.networkAccess, true);
  assert.equal(f.cli(['task', '--network', '--full-access', '--json', 'inspect']).status, 1);
});

test('successful runs hide ANSI stderr noise while retaining diagnostic JSON and logs', async t => {
  for (const command of ['review', 'adversarial-review', 'task']) await t.test(command, t => {
    const f = fixture(t, 'stderr-ok');
    const args = command === 'task' ? ['inspect'] : [];
    const result = f.cli([command, '--json', ...args]);
    assert.equal(result.status, 0, result.stderr);
    const data = parsed(result);
    assert.match(data.meta.diagnostic.stderr, /ERROR rmcp/);
    assert.doesNotMatch(data.meta.diagnostic.stderr, /\u001b/);
    assert.doesNotMatch(result.stderr, /ERROR rmcp/);
    assert.match(fs.readFileSync(data.meta.logFile, 'utf8'), /ERROR rmcp/);
    const job = f.jobs().find(job => job.id === data.meta.jobId);
    assert.doesNotMatch(job.rendered, /ERROR rmcp|\u001b/);
  });
});

test('failed review renders sanitized stderr and retains complete diagnostics', t => {
  const f = fixture(t, 'stderr-failed');
  const result = f.cli(['review', '--json']);
  assert.equal(result.status, 1, result.stderr);
  const data = parsed(result);
  assert.match(data.meta.diagnostic.stderr, /ERROR rmcp/);
  assert.doesNotMatch(data.meta.diagnostic.stderr, /\u001b/);
  const job = f.jobs().find(job => job.id === data.meta.jobId);
  assert.doesNotMatch(job.rendered, /\u001b/);
  assert.match(job.rendered, /review terminal failure/);
  assert.match(job.rendered, /ERROR rmcp/);
});

test('status uses a neutral task label and running phase once the turn starts', async t => {
  const f = fixture(t, 'interruptible-slow-task');
  const launched = f.cli(['task', '--background', 'inspect']);
  assert.match(launched.stdout, /\/codex:await task-/);
  const job = await until(() => f.jobs().find(job => job.phase === 'running'));
  const status = parsed(f.cli(['status', job.id, '--json']));
  assert.equal(status.job.kindLabel, 'task'); assert.equal(status.job.phase, 'running');
  const conflict = parsed(f.cli(['task', '--write', '--json', 'edit']));
  assert.match(conflict.error.message, new RegExp(`/codex:await ${job.id}`));
  assert.match(conflict.error.message, new RegExp(`/codex:cancel ${job.id}`));
  assert.match(conflict.error.message, /CLI await:.*'await'/);
  assert.equal(f.cli(['cancel', job.id, '--json']).status, 0);
});
