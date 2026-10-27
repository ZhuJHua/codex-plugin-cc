import "./environment.mjs";
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { atomicJson, readJson, withFileLock } from '../plugins/codex/scripts/lib/atomic-store.mjs';
import { acquireThread, claimJob, markSessionEnded, readJob, reconcileJob, releaseThread, requestCancellation, reserveJob, stopOwnedProcesses } from '../plugins/codex/scripts/lib/job-lifecycle.mjs';
import { mutateJob, resolveStateDir, writeJobFile } from '../plugins/codex/scripts/lib/state.mjs';
import { createJobProgressUpdater, runTrackedJob } from '../plugins/codex/scripts/lib/tracked-jobs.mjs';
import { cleanupCoordination, registerTestRoot, cleanupTestProcesses } from './cleanup.mjs';
import { initGitRepo } from './helpers.mjs';
import { processIdentity } from '../plugins/codex/scripts/lib/process-identity.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-atomic-lifecycle-'));
  registerTestRoot(root);
  const previous = { CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA, CODEX_HOME: process.env.CODEX_HOME };
  process.env.CLAUDE_PLUGIN_DATA = path.join(root, 'data');
  process.env.CODEX_HOME = path.join(root, 'codex-home');
  fs.mkdirSync(process.env.CODEX_HOME);
  const cwd = path.join(root, 'workspace'); fs.mkdirSync(cwd);
  t.after(async () => {
    await cleanupTestProcesses([root]);
    for (const name of fs.readdirSync(root)) if (fs.statSync(path.join(root, name)).isDirectory()) cleanupCoordination(path.join(root, name), path.join(root, "codex-home"));
    for (const [name, value] of Object.entries(previous)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, cwd, job: (id, extra = {}) => ({ id, workspaceRoot: cwd, sessionId: `session-${id}`, createdAt: new Date().toISOString(), write: false, ...extra }) };
}

test('lock ownership recovers a dead owner and fails closed for empty or corrupt directories', t => {
  const f = fixture(t), lock = path.join(f.root, 'lock');
  fs.mkdirSync(lock);
  assert.throws(() => withFileLock(lock, () => assert.fail('empty lock acquired'), 0), /missing ownership/);
  atomicJson(path.join(lock, 'owner.json'), { pid: 2147483647, token: 'dead' });
  assert.equal(withFileLock(lock, () => 'recovered', 0), 'recovered');
  fs.mkdirSync(lock);
  atomicJson(path.join(lock, 'owner.json'), { pid: 'invalid', token: 'bad' });
  assert.throws(() => withFileLock(lock, () => assert.fail('corrupt lock acquired'), 0), /corrupt ownership/);
});

test('stale dead-owner snapshot cannot remove a replacement live lock', t => {
  const f = fixture(t), lock = path.join(f.root, 'lock'), ownerFile = path.join(lock, 'owner.json');
  fs.mkdirSync(lock); atomicJson(ownerFile, { pid: 2147483647, token: 'old' });
  const original = fs.readFileSync;
  let replaced = false;
  fs.readFileSync = function(file, ...args) {
    const value = original.call(this, file, ...args);
    if (file === ownerFile && !replaced) {
      replaced = true;
      fs.renameSync(lock, `${lock}.old`);
      fs.mkdirSync(lock); atomicJson(ownerFile, { pid: process.pid, token: 'replacement' });
    }
    return value;
  };
  try { assert.throws(() => withFileLock(lock, () => assert.fail('replacement lock stolen'), 0), /State lock is busy/); }
  finally { fs.readFileSync = original; }
  assert.equal(readJson(ownerFile).token, 'replacement');
});

test('a child killed inside its critical section releases its lock through recovery', async t => {
  const f = fixture(t), lock = path.join(f.root, 'killed-lock');
  const moduleUrl = new URL('../plugins/codex/scripts/lib/atomic-store.mjs', import.meta.url).href;
  const program = `import { withFileLock } from ${JSON.stringify(moduleUrl)};
    withFileLock(process.argv[1],()=>{ process.stdout.write('locked\\n'); for(;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1000); });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', program, lock], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve); child.once('error', reject);
    child.once('exit', code => reject(new Error(`Lock holder exited before locking: ${code}`)));
  });
  child.kill('SIGKILL'); await exited;
  assert.equal(withFileLock(lock, () => 'recovered after SIGKILL'), 'recovered after SIGKILL');
  assert.equal(fs.existsSync(lock), false);
});

test('a dead or uninitialized reaper fails closed instead of stealing recovery', t => {
  const f = fixture(t), lock = path.join(f.root, 'reaping-lock');
  fs.mkdirSync(lock); atomicJson(path.join(lock, 'owner.json'), { pid: 2147483647, token: 'dead' });
  const generation = createHash('sha256').update('dead').digest('hex');
  const reaper = path.join(lock, `reap-${generation}`);
  fs.mkdirSync(reaper);
  assert.throws(() => withFileLock(lock, () => assert.fail('uninitialized reaper stolen'), 0), /reaper ownership/);
  atomicJson(path.join(reaper, 'owner.json'), { pid: 2147483647, token: 'dead-reaper' });
  assert.throws(() => withFileLock(lock, () => assert.fail('dead reaper stolen'), 0), /reaper ownership/);
  assert.equal(readJson(path.join(lock, 'owner.json')).token, 'dead');
});

test('concurrent dead-lock recovery waits for reaper initialization and serializes both observers', async t => {
  for (const initialization of ['pause', 'partial']) await t.test(initialization, async t => {
  const f = fixture(t), lock = path.join(f.root, 'concurrent-recovery'), counter = path.join(f.root, 'recovery-counter.json');
  fs.mkdirSync(lock); atomicJson(path.join(lock, 'owner.json'), { pid: 2147483647, token: 'dead-owner' }); atomicJson(counter, 0);
  const moduleUrl = new URL('../plugins/codex/scripts/lib/atomic-store.mjs', import.meta.url).href;
  const program = `import fs from 'node:fs'; import { withFileLock,readJson,atomicJson } from ${JSON.stringify(moduleUrl)};
    if(process.argv[3]==='pause') { const original=fs.mkdirSync; fs.mkdirSync=function(file,...args) {
      const result=original.call(this,file,...args); if(String(file).includes('/reap-')) {
        process.stdout.write('initializing\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,250);
      } return result;
    }; }
    if(process.argv[3]==='partial') { const original=fs.writeFileSync; fs.writeFileSync=function(file,data,...args) {
      if(String(file).includes('/reap-')) { const fd=fs.openSync(file,'wx',0o600);
        process.stdout.write('initializing\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,250);
        try { original.call(this,fd,data); } finally { fs.closeSync(fd); } return;
      } return original.call(this,file,data,...args);
    }; }
    withFileLock(process.argv[1],()=>{const n=readJson(process.argv[2]); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25); atomicJson(process.argv[2],n+1);});`;
  const launch = mode => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', program, lock, counter, mode], { stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = '';
    child.stderr.on('data', chunk => { errors += chunk; });
    const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(errors || `exit ${code}`))); });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    return { child, done };
  };
  const first = launch(initialization);
  await new Promise((resolve, reject) => { first.child.stdout.once('data', resolve); first.done.then(() => reject(new Error('First observer did not initialize a reaper')), reject); });
  const second = launch('normal');
  await Promise.all([first.done, second.done]);
  assert.equal(readJson(counter), 2); assert.equal(fs.existsSync(lock), false);
  });
});

test('release retires its lock before recursively deleting contents', t => {
  const f = fixture(t), lock = path.join(f.root, 'lock'), original = fs.rmSync;
  fs.rmSync = function(file, options) {
    assert.ok(file !== lock || !options?.recursive, 'published lock must never be recursively removed');
    return original.call(this, file, options);
  };
  try { assert.equal(withFileLock(lock, () => 42), 42); }
  finally { fs.rmSync = original; }
  assert.equal(fs.existsSync(lock), false);
});

test('independent processes serialize concurrent state changes', async t => {
  const f = fixture(t), counter = path.join(f.root, 'counter.json'); atomicJson(counter, 0);
  const moduleUrl = new URL('../plugins/codex/scripts/lib/atomic-store.mjs', import.meta.url).href;
  const program = `import { atomicJson, readJson, withFileLock } from ${JSON.stringify(moduleUrl)};
    for(let i=0;i<30;i++) withFileLock(process.argv[1]+'.lock',()=>{ const n=readJson(process.argv[1]); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1); atomicJson(process.argv[1],n+1); });`;
  await Promise.all(Array.from({ length: 3 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', program, counter], { stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = ''; child.stderr.on('data', chunk => { errors += chunk; });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(errors || `exit ${code}`)));
  })));
  assert.equal(readJson(counter), 90);
});

test('reconciliation rereads current worker state and claim respects reconciliation ownership', t => {
  const f = fixture(t), job = reserveJob(f.job('reread'), { kind: 'task' });
  mutateJob(f.cwd, job.id, current => ({ ...current, status: 'running', pid: process.pid }));
  const result = reconcileJob(f.cwd, { ...job, launcherPid: 2147483647, pid: null });
  assert.equal(result.status, 'running'); assert.equal(result.pid, process.pid);
  const queued = reserveJob(f.job('reconciling'), { kind: 'task' });
  mutateJob(f.cwd, queued.id, current => ({ ...current, reconcileToken: 'token', reconcilerPid: process.pid }));
  assert.equal(claimJob(f.cwd, queued.id), null); assert.equal(readJob(f.cwd, queued.id).status, 'queued');
});

test('SessionEnd blocks both later reservation and queued claiming, preserving recovery', t => {
  const f = fixture(t), job = reserveJob(f.job('ended', { threadId: 'existing-thread' }), { kind: 'task', model: 'fixed-model', effort: 'high', fullAccess: true });
  markSessionEnded(job.sessionId);
  assert.equal(claimJob(f.cwd, job.id), null);
  const cancelled = readJob(f.cwd, job.id);
  assert.equal(cancelled.status, 'cancelled'); assert.match(cancelled.recoveryCommand, /existing-thread/);
  assert.match(cancelled.recoveryCommand, /fixed-model/);
  assert.throws(() => reserveJob(f.job('after-end', { sessionId: job.sessionId, createdAt: '2099-01-01T00:00:00.000Z' }), {}), /has ended/);
});

test('reconciliation refuses to kill an unauthenticated runtime and prevents a late claim', t => {
  const f = fixture(t), job = reserveJob(f.job('late-claim'), {}), runtimePid = 2147483646;
  mutateJob(f.cwd, job.id, current => ({ ...current, launcherPid: 2147483647, appServerPid: runtimePid }));
  const original = process.kill; let alive = true, terminated = false;
  process.kill = function(pid, signal) {
    if (pid !== runtimePid) return original.call(this, pid, signal);
    if (!alive) { const error = new Error('dead'); error.code = 'ESRCH'; throw error; }
    if (signal === 'SIGKILL') {
      assert.equal(fs.existsSync(path.join(resolveStateDir(f.cwd), '.transaction')), false);
      assert.equal(claimJob(f.cwd, job.id), null);
      alive = false; terminated = true;
    }
    return true;
  };
  let result;
  try { result = reconcileJob(f.cwd, job); }
  finally { process.kill = original; }
  assert.equal(terminated, false); assert.equal(result.status, 'failed');
  assert.equal(result.terminationUnconfirmed, true);
  assert.match(result.errorMessage, /ownership.*cannot be verified/);
  assert.equal(claimJob(f.cwd, job.id), null);
});

test('persisted process cleanup validates identity before signalling', async t => {
  const f = fixture(t);
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const exited = new Promise(resolve => child.once('exit', resolve));
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  const identity = processIdentity(child.pid);
  assert.match(stopOwnedProcesses({ appServerPid: child.pid }), /cannot be verified/);
  assert.match(stopOwnedProcesses({ appServerPid: child.pid, appServerIdentity: 'different-process-identity' }), /cannot be verified/);
  assert.equal(child.exitCode, null);
  if (!identity) { t.diagnostic('OS process identity inspection is restricted; authenticated kill branch was not exercised.'); return; }
  const original = process.kill;
  process.kill = function(pid, signal) {
    if (pid === child.pid && signal === 'SIGKILL') assert.equal(fs.existsSync(path.join(resolveStateDir(f.cwd), '.transaction')), false);
    return original.call(this, pid, signal);
  };
  try { assert.equal(stopOwnedProcesses({ appServerPid: child.pid, appServerIdentity: identity }, 'SIGKILL'), null); }
  finally { process.kill = original; }
  await exited;
});

test('claim records process identity without assuming a detached worker group', t => {
  const f = fixture(t), job = reserveJob(f.job('manual-worker'), {});
  const claimed = claimJob(f.cwd, job.id);
  assert.equal(claimed.workerPgid, null); assert.equal(claimed.workerIdentity, processIdentity(process.pid));
});

test('a rejected duplicate claim cannot terminalize a running job after SessionEnd', t => {
  const f = fixture(t), job = reserveJob(f.job('running-ended'), {});
  mutateJob(f.cwd, job.id, current => ({ ...current, status: 'running', pid: process.pid }));
  markSessionEnded(job.sessionId);
  assert.equal(claimJob(f.cwd, job.id), null);
  assert.equal(readJob(f.cwd, job.id).status, 'running');
});

test('terminal unconfirmed runtime continues to block a workspace writer', t => {
  const f = fixture(t), job = reserveJob(f.job('unconfirmed', { write: true }), {});
  mutateJob(f.cwd, job.id, current => ({ ...current, status: 'failed', terminationUnconfirmed: true, appServerPid: process.pid }));
  assert.throws(() => reserveJob(f.job('new-writer', { write: true }), {}), /Workspace conflict with unconfirmed/);
  writeJobFile(f.cwd, job.id, { ...readJob(f.cwd, job.id), appServerPid: null });
  assert.equal(reserveJob(f.job('new-writer', { write: true }), {}).status, 'queued');
});

test('thread leases span plugin data roots, isolate Codex homes and retain live runtime ownership', t => {
  const f = fixture(t), dataA = process.env.CLAUDE_PLUGIN_DATA, homeA = process.env.CODEX_HOME;
  const owner = reserveJob(f.job('owner'), {});
  mutateJob(f.cwd, owner.id, current => ({ ...current, status: 'running', pid: process.pid, appServerPid: process.pid }));
  const threadId = `thread-${path.basename(f.root)}`;
  acquireThread(owner, threadId);
  assert.equal(releaseThread(owner, threadId), false);
  process.env.CLAUDE_PLUGIN_DATA = path.join(f.root, 'other-data');
  const contender = reserveJob(f.job('contender'), {});
  assert.throws(() => acquireThread(contender, threadId), /owned by job owner/);
  process.env.CODEX_HOME = path.join(f.root, 'other-home'); fs.mkdirSync(process.env.CODEX_HOME);
  acquireThread(contender, threadId); assert.equal(releaseThread(contender, threadId), true);
  process.env.CODEX_HOME = homeA; process.env.CLAUDE_PLUGIN_DATA = dataA;
  writeJobFile(f.cwd, owner.id, { ...readJob(f.cwd, owner.id), appServerPid: null });
  assert.equal(releaseThread(owner, threadId), true);
});

test('queued cancellation rejects claiming and preserves its recovery configuration', t => {
  const f = fixture(t), job = reserveJob(f.job('queued-cancel', { threadId: 'resume-cancelled' }), { kind: 'task', model: 'fixed-model', effort: 'high' });
  requestCancellation(f.cwd, job.id, 'Stop before dispatch.');
  assert.equal(claimJob(f.cwd, job.id), null);
  const cancelled = readJob(f.cwd, job.id);
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.pid, null);
  assert.equal(cancelled.errorMessage, 'Stop before dispatch.');
  assert.match(cancelled.recoveryCommand, /resume-cancelled/);
  assert.match(cancelled.recoveryCommand, /fixed-model/);
});

test('completed records survive cancellation, late progress and a stale runner', async t => {
  const f = fixture(t), job = reserveJob(f.job('completed'), {});
  mutateJob(f.cwd, job.id, current => ({ ...current, status: 'completed', phase: 'done', result: { answer: 'original' }, threadId: 'original-thread', turnId: 'original-turn', summary: 'Original result' }));
  const completed = readJob(f.cwd, job.id);
  requestCancellation(f.cwd, job.id, 'Too late.');
  createJobProgressUpdater(f.cwd, job.id)({ phase: 'editing', threadId: 'late-thread', turnId: 'late-turn', resolved: { model: 'wrong' }, partialOutput: 'late output' });
  let ran = false;
  const execution = await runTrackedJob(job, () => { ran = true; throw new Error('must not run'); });
  assert.equal(execution, null); assert.equal(ran, false);
  assert.deepEqual(readJob(f.cwd, job.id), completed);
});

test('cancellation after claiming and before a simulated turn records cancellation without dispatch', async t => {
  const f = fixture(t), reserved = reserveJob(f.job('claimed-cancel', { threadId: 'claimed-thread' }), { kind: 'task' });
  const claimed = claimJob(f.cwd, reserved.id); assert.equal(claimed.status, 'running');
  requestCancellation(f.cwd, claimed.id, 'Cancelled before turn.');
  let dispatched = false;
  await assert.rejects(runTrackedJob(claimed, async () => {
    // Models the worker's pre-turn cancellation guard without starting Codex.
    const current = readJob(f.cwd, claimed.id);
    if (current.cancelRequestedAt) throw Object.assign(new Error(current.cancelReason), { code: 'JOB_CANCELLED' });
    dispatched = true;
    return { exitStatus: 0 };
  }), /Cancelled before turn/);
  assert.equal(dispatched, false);
  const cancelled = readJob(f.cwd, claimed.id);
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.pid, null);
  assert.match(cancelled.recoveryCommand, /claimed-thread/);
});

test('canonical workspace aliases conflict while independent git worktrees can write', t => {
  const f = fixture(t); initGitRepo(f.cwd);
  const committed = spawnSync('git', ['commit', '--allow-empty', '-m', 'initial'], { cwd: f.cwd, encoding: 'utf8' });
  assert.equal(committed.status, 0, committed.stderr);
  const other = path.join(f.root, 'other-worktree');
  const added = spawnSync('git', ['worktree', 'add', '--detach', other, 'HEAD'], { cwd: f.cwd, encoding: 'utf8' });
  assert.equal(added.status, 0, added.stderr);
  const alias = path.join(f.root, 'workspace-alias'); fs.symlinkSync(f.cwd, alias, 'dir');
  reserveJob(f.job('main-writer', { write: true }), {});
  assert.throws(() => reserveJob(f.job('alias-writer', { workspaceRoot: alias, write: true }), {}), /Workspace conflict with main-writer/);
  assert.equal(reserveJob(f.job('other-writer', { workspaceRoot: other, write: true }), {}).status, 'queued');
});

test('two independent readers can reserve the same workspace', t => {
  const f = fixture(t);
  assert.equal(reserveJob(f.job('reader-one'), {}).status, 'queued');
  assert.equal(reserveJob(f.job('reader-two'), {}).status, 'queued');
});

test('canonical worktree write exclusion spans plugin data roots and Codex homes', t => {
  const f = fixture(t), dataA = process.env.CLAUDE_PLUGIN_DATA;
  const owner = reserveJob(f.job('global-owner', { write: true }), {});
  process.env.CLAUDE_PLUGIN_DATA = path.join(f.root, 'other-data');
  process.env.CODEX_HOME = path.join(f.root, 'other-home'); fs.mkdirSync(process.env.CODEX_HOME);
  assert.throws(() => reserveJob(f.job('global-contender', { write: true }), {}), /Workspace conflict with global-owner/);
  assert.throws(() => reserveJob(f.job('global-reader'), {}), /Workspace conflict with global-owner/);
  process.env.CLAUDE_PLUGIN_DATA = dataA;
  mutateJob(f.cwd, owner.id, current => ({ ...current, status: 'completed', pid: null }));
  process.env.CLAUDE_PLUGIN_DATA = path.join(f.root, 'other-data');
  assert.equal(reserveJob(f.job('global-contender', { write: true }), {}).status, 'queued');
});

test('missing global coordination owner fails closed across plugin data roots', t => {
  const f = fixture(t), owner = reserveJob(f.job('missing-owner'), {});
  const directory = resolveStateDir(f.cwd);
  fs.rmSync(path.join(directory, 'jobs', `${owner.id}.json`));
  process.env.CLAUDE_PLUGIN_DATA = path.join(f.root, 'other-data');
  assert.throws(() => reserveJob(f.job('unsafe-writer', { write: true }), {}), /coordination owner is missing or changed/);
});

test('simultaneous thread resumptions admit exactly one lease owner', async t => {
  const f = fixture(t), jobs = [reserveJob(f.job('resume-one'), {}), reserveJob(f.job('resume-two'), {})];
  const threadId = `concurrent-thread-${path.basename(f.root)}`;
  const moduleUrl = new URL('../plugins/codex/scripts/lib/job-lifecycle.mjs', import.meta.url).href;
  const program = `import { acquireThread } from ${JSON.stringify(moduleUrl)};
    const job=JSON.parse(process.argv[1]);
    try { acquireThread(job,process.argv[2]); process.stdout.write(JSON.stringify({id:job.id,acquired:true})); }
    catch(error) { process.stdout.write(JSON.stringify({id:job.id,acquired:false,error:error.message})); }`;
  const results = await Promise.all(jobs.map(job => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', program, JSON.stringify(job), threadId], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
    child.on('error', reject); child.on('exit', code => {
      if (code !== 0) return reject(new Error(errors || `exit ${code}`));
      try { resolve(JSON.parse(output)); } catch (error) { reject(error); }
    });
  })));
  const winner = results.filter(result => result.acquired), rejected = results.filter(result => !result.acquired);
  assert.equal(winner.length, 1); assert.equal(rejected.length, 1);
  assert.match(rejected[0].error, new RegExp(`owned by job ${winner[0].id}`));
  assert.equal(releaseThread(jobs.find(job => job.id === winner[0].id), threadId), true);
});

test('session restart permits a new generation without reviving old queued work', async t => {
  const { markSessionStarted, sessionHasEnded, endedSessionOwnsJob } = await import('../plugins/codex/scripts/lib/job-lifecycle.mjs');
  const f = fixture(t);
  markSessionStarted('same-owner');
  const old = reserveJob(f.job('before-end', { sessionId: 'same-owner' }), { kind: 'task' });
  const ended = markSessionEnded('same-owner');
  assert.equal(sessionHasEnded(old), true);
  markSessionStarted('same-owner');
  assert.equal(claimJob(f.cwd, old.id), null);
  assert.equal(readJob(f.cwd, old.id).status, 'cancelled');
  const next = reserveJob(f.job('after-restart', { sessionId: 'same-owner' }), { kind: 'task' });
  assert.notEqual(next.sessionGeneration, old.sessionGeneration);
  assert.equal(sessionHasEnded(next), false);
  assert.equal(endedSessionOwnsJob(next, ended), false);
  markSessionStarted('same-owner');
  assert.equal(sessionHasEnded(next), false);
});
