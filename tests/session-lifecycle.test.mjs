import "./environment.mjs";
import { registerTestRoot, cleanupTestProcesses } from "./cleanup.mjs";
import { testEnvironment } from "./environment.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

import { processAlive } from "../plugins/codex/scripts/lib/atomic-store.mjs";
import { processIdentity } from "../plugins/codex/scripts/lib/process-identity.mjs";
import { readJob, sessionHasEnded } from "../plugins/codex/scripts/lib/job-lifecycle.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  listReconciledJobs,
  readStoredJob,
  resolveResultJob
} from "../plugins/codex/scripts/lib/job-control.mjs";
import { mutateJob, resolveJobFile, resolveStateDir, resolveStateFile } from "../plugins/codex/scripts/lib/state.mjs";

const HOOK = fileURLToPath(new URL("../plugins/codex/scripts/session-lifecycle-hook.mjs", import.meta.url));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-session-lifecycle-"));
  registerTestRoot(root);
  const oldData = process.env.CLAUDE_PLUGIN_DATA;
  const oldSession = process.env.CODEX_COMPANION_SESSION_ID;
  process.env.CLAUDE_PLUGIN_DATA = path.join(root, "plugin-data");
  delete process.env.CODEX_COMPANION_SESSION_ID;
  const children = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise(resolve => child.once("exit", resolve))));
    await cleanupTestProcesses([root]);
    if (oldData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = oldData;
    if (oldSession === undefined) delete process.env.CODEX_COMPANION_SESSION_ID;
    else process.env.CODEX_COMPANION_SESSION_ID = oldSession;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    repo(name) {
      const directory = path.join(root, name);
      fs.mkdirSync(directory);
      return directory;
    },
    child(cwd) {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        cwd, stdio: "ignore", detached: process.platform !== "win32"
      });
      children.push(child);
      return child;
    }
  };
}

function putJob(cwd, id, patch = {}) {
  const createdAt = new Date(Date.now() - 1000).toISOString();
  return mutateJob(cwd, id, () => ({
    id, workspaceRoot: cwd, sessionId: "owner-a", jobClass: "task",
    status: "queued", phase: "queued", createdAt, updatedAt: createdAt,
    ...patch
  }));
}

function runHook(input, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK, input.hook_event_name ?? "SessionEnd"], {
      cwd: input.cwd, env: testEnvironment({ CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA, ...extraEnv }), stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("SessionEnd hook did not finish within its configured budget."));
    }, 10000);
    child.on("error", error => { clearTimeout(timeout); reject(error); });
    child.on("close", code => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
    child.stdin.end(JSON.stringify(input));
  });
}

test("SessionEnd cancels owner jobs across working directories and retains artifacts", async t => {
  const f = fixture(t);
  const first = f.repo("first");
  const second = f.repo("second");
  const worker = f.child(second);
  const appServer = f.child(second);
  const otherOwner = f.child(first);
  const [workerIdentity, appServerIdentity] = await Promise.all([worker, appServer].map(async child => {
    await once(child, "spawn");
    const identity = processIdentity(child.pid);
    assert.ok(identity, "spawned test runtime must have an inspectable process identity");
    return identity;
  }));
  const firstLog = path.join(f.root, "queued.log");
  const activeLog = path.join(f.root, "active.log");
  fs.writeFileSync(firstLog, "queued output\n");
  fs.writeFileSync(activeLog, "partial output\n");
  putJob(first, "queued-owner", { logFile: firstLog });
  putJob(second, "running-owner", {
    status: "running", pid: worker.pid, workerIdentity,
    workerPgid: process.platform === "win32" ? null : worker.pid,
    appServerPid: appServer.pid, appServerIdentity,
    appServerPgid: process.platform === "win32" ? null : appServer.pid,
    threadId: "thread-owner", logFile: activeLog, result: { rawOutput: "partial result" }
  });
  putJob(first, "other-owner", { sessionId: "owner-b", status: "running", pid: otherOwner.pid });
  putJob(first, "completed-owner", { status: "completed", result: { rawOutput: "finished result" } });
  const completedBefore = fs.readFileSync(resolveJobFile(first, "completed-owner"), "utf8");

  const result = await runHook({ cwd: first, session_id: "owner-a" }, { CODEX_COMPANION_SESSION_ID: "owner-b" });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(readJob(first, "queued-owner").status, "cancelled");
  const cancelled = readJob(second, "running-owner");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.errorMessage, "Claude session ended.");
  assert.equal(cancelled.threadId, "thread-owner");
  assert.equal(cancelled.result.rawOutput, "partial result");
  assert.equal(sessionHasEnded(cancelled), true);
  assert.equal(fs.readFileSync(firstLog, "utf8"), "queued output\n");
  assert.equal(fs.readFileSync(activeLog, "utf8"), "partial output\n");
  assert.equal(fs.readFileSync(resolveJobFile(first, "completed-owner"), "utf8"), completedBefore);
  assert.equal(readJob(first, "other-owner").status, "running");
  assert.equal(processAlive(otherOwner.pid), true);
  assert.equal(processAlive(worker.pid), false);
  assert.equal(processAlive(appServer.pid), false);
});

test("SessionEnd without an owner ID does not cancel standalone or other-session work", async t => {
  const f = fixture(t);
  const cwd = f.repo("repo");
  putJob(cwd, "standalone", { sessionId: null, status: "running", pid: process.pid });
  putJob(cwd, "other-session", { sessionId: "owner-b", status: "running", pid: process.pid });
  const result = await runHook({ cwd });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(readJob(cwd, "standalone").status, "running");
  assert.equal(readJob(cwd, "other-session").status, "running");
});

test("status and result reconcile a dead worker while preserving its recovery handle", t => {
  const f = fixture(t);
  const cwd = f.repo("repo");
  putJob(cwd, "dead-worker", { status: "running", pid: 2147483647, threadId: "thread-dead", request: { fullAccess: true } });
  const snapshot = buildSingleJobSnapshot(cwd, "dead-worker");
  assert.equal(snapshot.job.status, "failed");
  assert.match(snapshot.job.errorMessage, /Worker exited before recording a result/);
  assert.match(snapshot.job.recoveryCommand, /--thread/);
  assert.match(snapshot.job.recoveryCommand, /thread-dead/);
  assert.match(snapshot.job.recoveryCommand, /--full-access/);
  assert.equal(buildStatusSnapshot(cwd).running.length, 0);
  assert.equal(resolveResultJob(cwd, "dead-worker").job.status, "failed");
  assert.equal(readStoredJob(cwd, "dead-worker").threadId, "thread-dead");
  assert.equal(listReconciledJobs(cwd)[0].status, "failed");
});

test("result distinguishes an existing live job from an unknown job", t => {
  const f = fixture(t);
  const cwd = f.repo("repo");
  putJob(cwd, "live-worker", { status: "running", pid: process.pid });
  assert.throws(() => resolveResultJob(cwd, "live-worker"), /Job live-worker is still running/);
  assert.throws(() => resolveResultJob(cwd, "missing-job"), /No job found for "missing-job"/);
});

test("status and result report corrupt state instead of an empty task list", t => {
  const f = fixture(t);
  const cwd = f.repo("repo");
  putJob(cwd, "finished", { status: "completed" });
  fs.writeFileSync(resolveStateFile(cwd), "{broken");
  assert.throws(() => buildStatusSnapshot(cwd), /Cannot read state/);
  assert.throws(() => resolveResultJob(cwd, "finished"), /Cannot read state/);
});

test("SessionEnd reports corrupt job artifacts and still publishes the owner ending marker", async t => {
  const f = fixture(t);
  const cwd = f.repo("repo");
  const job = putJob(cwd, "broken-job", { sessionId: "owner-a" });
  const file = resolveJobFile(cwd, job.id);
  fs.writeFileSync(file, "{broken");
  const result = await runHook({ cwd, session_id: "owner-a" });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Cannot read state/);
  assert.match(result.stderr, /broken-job\.json/);
  assert.equal(fs.readFileSync(file, "utf8"), "{broken");
  assert.equal(sessionHasEnded(job), true);
});
