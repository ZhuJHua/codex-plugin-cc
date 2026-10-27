import fs from "node:fs";
import process from "node:process";

import { resolveJobLogFile, mutateJob, terminalJob } from "./state.mjs";

import { sessionHasEnded } from "./job-lifecycle.mjs";
import { recoveryCommand } from "./recovery.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";

export function nowIso() {
  return new Date().toISOString();
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : null,
      turnId: typeof value.turnId === "string" && value.turnId.trim() ? value.turnId.trim() : null,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd(),
      resolved: value.resolved,
      diagnostic: value.diagnostic,
      logOnly: value.logOnly,
      partialOutput: value.partialOutput,
      observation: value.observation,
      appServerPid: value.appServerPid,
      appServerIdentity: value.appServerIdentity,
      appServerPgid: value.appServerPgid
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    threadId: null,
    turnId: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null
  };
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`, "utf8");
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

export function createJobProgressUpdater(workspaceRoot, jobId) {
  return event => {
    const value = normalizeProgressEvent(event);
    const patch = Object.fromEntries(["phase", "threadId", "turnId", "resolved", "partialOutput", "appServerPid", "appServerPgid", "appServerIdentity"]
      .filter(key => value[key] != null).map(key => [key, value[key]]));
    if (Object.keys(patch).length || value.observation || value.diagnostic) mutateJob(workspaceRoot, jobId, job => job && ({ ...job, ...patch, ...(value.diagnostic ? { errorDetails: { ...job.errorDetails, ...value.diagnostic } } : {}), ...(value.observation ? { observations: [...(job.observations ?? []), value.observation] } : {}) }));
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    onEvent?.(event);
    if (event.logOnly) {
      appendLogLine(logFile, `[diagnostic] ${JSON.stringify(event.diagnostic)}`);
      return;
    }
    if (stderr && stderrMessage && !process.stderr.destroyed) {
      try { process.stderr.write(`[codex] ${stderrMessage}\n`); } catch {}
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
  };
}


export async function runTrackedJob(job, runner, options = {}) {
  const running = mutateJob(job.workspaceRoot, job.id, current => ({
    ...job, ...current, status: "running", startedAt: current?.startedAt ?? nowIso(),
    phase: "starting", pid: process.pid, logFile: options.logFile ?? current?.logFile ?? job.logFile ?? null
  }));
  if (terminalJob(running)) return null;
  try {
    const execution = await runner();
    const finished = mutateJob(job.workspaceRoot, job.id, current => ({
      ...current,
      status: (current.cancelRequestedAt || sessionHasEnded(current)) ? "cancelled" : execution.exitStatus === 0 ? "completed" : "failed",
      phase: (current.cancelRequestedAt || sessionHasEnded(current)) ? "cancelled" : execution.exitStatus === 0 ? "done" : "failed",
      threadId: execution.threadId ?? current.threadId ?? null,
      turnId: execution.turnId ?? current.turnId ?? null,
      pid: null, completedAt: nowIso(), result: execution.payload, rendered: execution.rendered,
      summary: execution.summary,
      errorMessage: (current.cancelRequestedAt || sessionHasEnded(current)) ? current.cancelReason ?? "Claude session ended." : execution.exitStatus ? execution.payload?.error?.message ?? execution.summary : null,
      recoveryCommand: execution.exitStatus || current.cancelRequestedAt || sessionHasEnded(current) ? recoveryCommand({ ...current, threadId: execution.threadId ?? current.threadId }) : null
    }));
    appendLogBlock(running.logFile, "Final output", execution.rendered);
    return { ...execution, job: finished };
  } catch (error) {
    const finished = mutateJob(job.workspaceRoot, job.id, current => ({
      ...current, status: error.code === "TERMINATION_UNCONFIRMED" ? "failed" : current.cancelRequestedAt || error.code === "JOB_CANCELLED" ? "cancelled" : "failed",
      phase: error.code === "TERMINATION_UNCONFIRMED" ? "failed" : current.cancelRequestedAt || error.code === "JOB_CANCELLED" ? "cancelled" : "failed",
      terminationUnconfirmed: error.code === "TERMINATION_UNCONFIRMED",
      errorDetails: { ...current.errorDetails, name: error.name, code: error.code, rpcCode: error.rpcCode, data: error.data, message: error.message },
      errorMessage: error.code === "TERMINATION_UNCONFIRMED" ? error.message : current.cancelReason ?? error.message, pid: null, completedAt: nowIso(),
      recoveryCommand: recoveryCommand(current)
    }));
    appendLogLine(running.logFile, `Failed: ${finished.errorMessage}`);
    throw error;
  }
}
