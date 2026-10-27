import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { atomicJson, processAlive, readJson, withFileLock } from "./atomic-store.mjs";
import { terminateProcessTree } from "./process.mjs";
import { listJobs, mutateJob, mutateJobUnlocked, resolveJobFile, readJobFile, resolveRuntimeRoot, resolveStateRoot, terminalJob, withWorkspaceLock } from "./state.mjs";
import { recoveryCommand, jobActions } from "./recovery.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";
import { processIdentity } from "./process-identity.mjs";

export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = text => crypto.createHash("sha256").update(text).digest("hex");

export function readJob(cwd, id) { return readJobFile(resolveJobFile(cwd, id)); }

function sessionFile(id) { return path.join(resolveRuntimeRoot(), "sessions", `${digest(id)}.json`); }

function activeSessionFile(id) { return `${sessionFile(id)}.active`; }

export function markSessionStarted(sessionId) {
  if (!sessionId) return;
  return withFileLock(`${sessionFile(sessionId)}.lock`, () => {
    const ended = readJson(sessionFile(sessionId), null);
    const active = readJson(activeSessionFile(sessionId), null);
    const next = ended || !active ? {
      sessionId, generation: crypto.randomUUID(), startedAt: new Date().toISOString(),
      previousEndedAt: ended?.endedAt ?? active?.previousEndedAt ?? null
    } : active;
    atomicJson(activeSessionFile(sessionId), next);
    fs.rmSync(sessionFile(sessionId), { force: true });
    return next;
  });
}

export function markSessionEnded(sessionId) {
  if (!sessionId) return;
  return withFileLock(`${sessionFile(sessionId)}.lock`, () => {
    const active = readJson(activeSessionFile(sessionId), null);
    const ended = { sessionId, generation: active?.generation ?? null, endedAt: new Date().toISOString() };
    atomicJson(sessionFile(sessionId), ended);
    return ended;
  });
}

export function endedSessionOwnsJob(job, ended) {
  if (!ended || job.sessionId !== ended.sessionId) return false;
  if (job.sessionGeneration != null) return job.sessionGeneration === ended.generation;
  return !job.createdAt || Date.parse(job.createdAt) <= Date.parse(ended.endedAt);
}

export function sessionHasEnded(job) {
  if (!job?.sessionId) return false;
  const marker = readJson(sessionFile(job.sessionId), null);
  const active = readJson(activeSessionFile(job.sessionId), null);
  if (job.sessionGeneration != null && active?.generation !== job.sessionGeneration) return true;
  if (marker && (job.sessionGeneration == null || marker.generation === job.sessionGeneration)) return true;
  return Boolean(job.sessionGeneration == null && active?.previousEndedAt &&
    Date.parse(job.createdAt) <= Date.parse(active.previousEndedAt));
}

function processGroupAlive(pgid) {
  if (process.platform === "win32" || !Number.isInteger(pgid) || pgid <= 0) return false;
  try { process.kill(-pgid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; if (error.code === "EPERM") return true; throw error; }
}

function runtimeAlive(job) {
  return processAlive(job?.appServerPid) || processGroupAlive(job?.appServerPgid);
}

function workerAlive(job) {
  return processAlive(job?.pid) || processGroupAlive(job?.workerPgid);
}

function jobOwnsLiveWork(job) {
  return workerAlive(job) || runtimeAlive(job) || (job?.status === "queued" && processAlive(job.launcherPid));
}

// Thread IDs belong to CODEX_HOME, not a plugin install or its state directory.
// Distinct installs that share the same Codex home must share this lease store.
function threadLeaseFile(threadId) {
  let codexHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
  try { codexHome = fs.realpathSync.native(codexHome); } catch (error) { if (error.code !== "ENOENT") throw error; }
  return path.join(os.tmpdir(), "codex-companion", "thread-leases", digest(codexHome), `${digest(threadId)}.json`);
}

function workspaceLeaseFile(cwd) {
  const canonicalRoot = fs.realpathSync.native(resolveWorkspaceRoot(path.resolve(cwd)));
  return path.join(os.tmpdir(), "codex-companion", "workspace-leases", `${digest(canonicalRoot)}.json`);
}

function activeWorkspaceReferences(file) {
  const index = readJson(file, { schemaVersion: 1, jobs: [] });
  if (!index || index.schemaVersion !== 1 || !Array.isArray(index.jobs)) {
    throw new Error(`Workspace coordination index is corrupt: ${file}`);
  }
  const active = [];
  for (const reference of index.jobs) {
    if (!reference || typeof reference.jobFile !== "string" || !path.isAbsolute(reference.jobFile) || typeof reference.claimToken !== "string") {
      throw new Error(`Workspace coordination reference is corrupt: ${file}`);
    }
    const owner = readJson(reference.jobFile, null);
    if (!owner || owner.claimToken !== reference.claimToken) {
      throw new Error(`Workspace coordination owner is missing or changed; inspect ${reference.jobFile} before dispatching work.`);
    }
    if (!["queued", "running", "completed", "failed", "cancelled"].includes(owner.status) || typeof owner.write !== "boolean") throw new Error(`Workspace owner state is corrupt: ${reference.jobFile}`);
    if (!terminalJob(owner) || (owner.terminationUnconfirmed && jobOwnsLiveWork(owner))) active.push({ reference, owner });
  }
  return active;
}

export function requestCancellation(cwd, id, reason = "Cancelled by user.") {
  return mutateJob(cwd, id, job => job && ({ ...job, cancelRequestedAt: job.cancelRequestedAt ?? new Date().toISOString(), cancelReason: job.cancelReason ?? reason, phase: "cancelling" }));
}

export function stopOwnedProcesses(job, signal = "SIGTERM") {
  const errors = [];
  for (const [pid, group, identity] of [[job.appServerPid, job.appServerPgid, job.appServerIdentity], [job.pid, job.workerPgid, job.workerIdentity]]) {
    if (pid === process.pid) continue;
    const alive = processAlive(pid);
    if (!alive && !processGroupAlive(group)) continue;
    // Persisted PIDs can be reused after an owner exits. A live group whose
    // original leader is gone cannot be authenticated by its numeric PGID.
    if (!alive || !identity || processIdentity(pid) !== identity || (group && group !== pid)) {
      errors.push(`Process ownership for PID ${pid ?? "unknown"}${group ? ` / group ${group}` : ""} cannot be verified; runtime termination is unconfirmed.`);
      continue;
    }
    try { terminateProcessTree(group ?? pid, { processGroup: Boolean(group), signal }); }
    catch (error) { if (error.code !== "ESRCH") errors.push(error.message); }
  }
  return errors.length ? errors.join(" ") : null;
}

export function reconcileJob(cwd, job) {
  if (!job?.id) return job;
  const token = crypto.randomUUID();
  // Re-read the authoritative record under its transaction: the caller's queued
  // snapshot may predate a worker claiming the job and the launcher exiting.
  const observed = mutateJob(cwd, job.id, current => {
    if (!current || terminalJob(current) || workerAlive(current) || (current.status === "queued" && processAlive(current.launcherPid))) return null;
    if (current.reconcileToken && processAlive(current.reconcilerPid)) return null;
    return { ...current, reconcileToken: token, reconcilerPid: process.pid, phase: "reconciling" };
  });
  if (!observed || observed.reconcileToken !== token || terminalJob(observed)) return observed;

  // No wait or process termination occurs while the workspace transaction is
  // held. The reconcile token prevents a late-starting worker claiming the job.
  const stopping = stopOwnedProcesses(observed, "SIGKILL");
  return mutateJob(cwd, job.id, current => {
    if (!current || current.reconcileToken !== token) return null;
    const unconfirmed = runtimeAlive(current) || workerAlive(current) || Boolean(stopping);
    const cancelled = Boolean(current.cancelRequestedAt || sessionHasEnded(current)) && !unconfirmed;
    const { reconcileToken, reconcilerPid, ...remaining } = current;
    return {
      ...remaining, status: cancelled ? "cancelled" : "failed", phase: cancelled ? "cancelled" : "failed",
      pid: null, completedAt: new Date().toISOString(), terminationUnconfirmed: unconfirmed,
      errorMessage: cancelled ? (current.cancelReason ?? "Claude session ended.") :
        `Worker exited before recording a result.${unconfirmed ? " Runtime termination is unconfirmed." : ""}${stopping ? ` ${stopping}` : ""} Inspect partial edits before resuming.`,
      recoveryCommand: recoveryCommand(current)
    };
  });
}

export function reserveJob(job, request) {
  job = { ...job, write: Boolean(job.write), ...(job.sessionId ? { sessionGeneration: job.sessionGeneration ?? readJson(activeSessionFile(job.sessionId), null)?.generation ?? null } : {}) };
  for (const other of listJobs(job.workspaceRoot)) reconcileJob(job.workspaceRoot, other);
  const leaseFile = workspaceLeaseFile(job.workspaceRoot);
  // Coordination spans plugin installations and Codex homes: they all write to
  // the same canonical worktree. Always acquire this lock before a local one.
  return withFileLock(`${leaseFile}.lock`, () => {
    const active = activeWorkspaceReferences(leaseFile);
    for (const { owner, reference } of active) {
      if (job.write || owner.write) {
        throw new Error(`Workspace conflict with ${owner.id}. ${jobActions(owner, reference.jobFile)}`);
      }
    }
    return withWorkspaceLock(job.workspaceRoot, () => {
      if (sessionHasEnded(job)) throw new Error(`Claude session ${job.sessionId} has ended; no new work may be dispatched.`);
      // Retain compatibility with records created before the global index.
      for (const other of listJobs(job.workspaceRoot)) {
        const blocks = !terminalJob(other) || (other.terminationUnconfirmed && jobOwnsLiveWork(other));
        if (blocks && (job.write || other.write)) {
          throw new Error(`Workspace conflict with ${other.id}. ${jobActions(other, resolveJobFile(job.workspaceRoot, other.id))}`);
        }
      }
      const reserved = mutateJobUnlocked(job.workspaceRoot, job.id, previous => {
        if (previous) throw new Error(`Job ${job.id} already exists.`);
        return { ...job, pluginDataRoot: process.env.CLAUDE_PLUGIN_DATA ?? null, request, runtimeKind: "private", status: "queued", phase: "queued", launcherPid: process.pid, pid: null, claimToken: crypto.randomUUID() };
      });
      // Publish before reserve returns, so a worker cannot start unregistered.
      atomicJson(leaseFile, { schemaVersion: 1, jobs: [...active.map(({ reference }) => reference), { jobFile: resolveJobFile(job.workspaceRoot, job.id), claimToken: reserved.claimToken }] });
      return reserved;
    });
  });
}

export function claimJob(cwd, id) {
  const workerIdentity = processIdentity(process.pid);
  let claimed = false;
  const job = mutateJob(cwd, id, current => {
    if (!current || current.status !== "queued" || current.reconcileToken) return null;
    if (current.cancelRequestedAt || sessionHasEnded(current)) {
      return { ...current, status: "cancelled", phase: "cancelled", pid: null, completedAt: new Date().toISOString(), errorMessage: current.cancelReason ?? "Claude session ended before dispatch.", recoveryCommand: recoveryCommand(current) };
    }
    if (current.request?.jobTimeoutMs && Date.now() - Date.parse(current.createdAt) >= current.request.jobTimeoutMs) {
      return { ...current, status: "failed", phase: "failed", pid: null, completedAt: new Date().toISOString(), errorMessage: "Job exceeded --job-timeout-ms before dispatch.", recoveryCommand: recoveryCommand(current) };
    }
    claimed = true;
    return { ...current, status: "running", phase: "starting", pid: process.pid, workerIdentity, workerPgid: process.platform !== "win32" && current.workerPgid === process.pid ? current.workerPgid : null, startedAt: new Date().toISOString() };
  });
  if (!claimed) return null;
  return job;
}

export function acquireThread(job, threadId) {
  const file = threadLeaseFile(threadId);
  withFileLock(`${file}.lock`, () => {
    const lease = readJson(file, null);
    if (lease && lease.claimToken !== job.claimToken) {
      const owner = lease.jobFile ? readJson(lease.jobFile, null) : readJob(lease.workspaceRoot, lease.jobId);
      if (!owner) throw new Error(`Thread ${threadId} has a lease whose owner record is missing; inspect ${file} before resuming.`);
      if (jobOwnsLiveWork(owner) || (!terminalJob(owner) && processAlive(owner.launcherPid))) {
        throw new Error(`Thread ${threadId} is owned by job ${owner.id} (session ${owner.sessionId ?? "standalone"}). Await or cancel that job before resuming.`);
      }
    }
    atomicJson(file, { jobId: job.id, workspaceRoot: job.workspaceRoot, jobFile: resolveJobFile(job.workspaceRoot, job.id), claimToken: job.claimToken });
  });
}

export function releaseThread(job, threadId) {
  if (!threadId) return false;
  const file = threadLeaseFile(threadId);
  return withFileLock(`${file}.lock`, () => {
    if (readJson(file, null)?.claimToken !== job.claimToken) return false;
    const current = readJob(job.workspaceRoot, job.id) ?? job;
    if (runtimeAlive(current)) return false;
    fs.rmSync(file, { force: true });
    return true;
  });
}

export function sessionJobs(sessionId, fallbackCwd) {
  const jobs = new Map();
  const root = resolveStateRoot();
  if (fs.existsSync(root)) {
    for (const directory of fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
      const jobDirectory = path.join(root, directory.name, "jobs");
      if (!fs.existsSync(jobDirectory)) continue;
      for (const file of fs.readdirSync(jobDirectory).filter(file => file.endsWith(".json"))) {
        const job = readJson(path.join(jobDirectory, file), null);
        if (job?.sessionId === sessionId && job.workspaceRoot) jobs.set(job.id, job);
      }
    }
  }
  if (fallbackCwd) for (const job of listJobs(fallbackCwd)) if (job.sessionId === sessionId) jobs.set(job.id, { ...job, workspaceRoot: job.workspaceRoot ?? fallbackCwd });
  return [...jobs.values()];
}

export async function cancelJob(cwd, id, reason = "Cancelled by user.") {
  let job = requestCancellation(cwd, id, reason);
  if (!job || terminalJob(job)) return job;
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline && !terminalJob(job)) {
    await delay(50);
    job = reconcileJob(cwd, readJob(cwd, id));
  }
  if (!terminalJob(job)) {
    stopOwnedProcesses(job);
    await delay(250);
    stopOwnedProcesses(job, "SIGKILL");
    await delay(100);
    job = reconcileJob(cwd, readJob(cwd, id));
    if (!terminalJob(job)) job = mutateJob(cwd, id, current => ({ ...current, status: "failed", phase: "failed", terminationUnconfirmed: true, completedAt: new Date().toISOString(), errorMessage: `${reason} Could not confirm process termination; inspect the workspace and runtime.` }));
  }
  return job;
}

export function jobMeta(job) {
  return {
    schemaVersion: 1, jobId: job?.id ?? null, turnId: job?.turnId ?? null, jobStatus: job?.status ?? "failed",
    logFile: job?.logFile ?? null, resultFile: job ? resolveJobFile(job.workspaceRoot, job.id) : null,
    requested: job?.requested ?? null, resolved: job?.resolved ?? null,
    recoveryCommand: job?.recoveryCommand ?? null, error: job?.errorMessage ?? null, diagnostic: job?.errorDetails ?? null
  };
}

export async function waitForJob(cwd, id, { timeoutMs = null, onUpdate = null } = {}) {
  const deadline = timeoutMs == null ? Infinity : Date.now() + timeoutMs;
  for (;;) {
    let job = readJob(cwd, id);
    if (!job) throw new Error(`No job found for ${id}.`);
    job = reconcileJob(cwd, job);
    onUpdate?.(job);
    if (terminalJob(job) || Date.now() >= deadline) return { job, timedOut: !terminalJob(job) };
    await delay(50);
  }
}
