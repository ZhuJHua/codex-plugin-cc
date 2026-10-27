import fs from "node:fs";

import { getSessionRuntimeStatus } from "./codex.mjs";
import { findJobWorkspace, getConfig, listJobs, readJobFile, resolveJobFile } from "./state.mjs";
import { reconcileJob } from "./job-lifecycle.mjs";
import { SESSION_ID_ENV } from "./tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

export const DEFAULT_MAX_STATUS_JOBS = 8;
export const DEFAULT_MAX_PROGRESS_LINES = 4;

export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}

export function listReconciledJobs(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  return listJobs(workspaceRoot).map(job => reconcileJob(workspaceRoot, job));
}

function getCurrentSessionId(options = {}) {
  return options.env?.[SESSION_ID_ENV] ?? process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentSession(jobs, options = {}) {
  const sessionId = getCurrentSessionId(options);
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function getJobTypeLabel(job) {
  if (typeof job.kindLabel === "string" && job.kindLabel) {
    return job.kindLabel;
  }
  if (job.kind === "adversarial-review") {
    return "adversarial-review";
  }
  if (job.jobClass === "review") {
    return "review";
  }
  if (job.jobClass === "task") {
    return "task";
  }
  if (job.kind === "review") {
    return "review";
  }
  if (job.kind === "task") {
    return "task";
  }
  return "job";
}

function stripLogPrefix(line) {
  return line.replace(/^\[[^\]]+\]\s*/, "").replace(/^\[progress\]\s*/, "").trim();
}

function isProgressBlockTitle(line) {
  return (
    ["Final output", "Assistant message", "Reasoning summary", "Review output"].includes(line) ||
    /^Subagent .+ message$/.test(line) ||
    /^Subagent .+ reasoning summary$/.test(line)
  );
}

function readJobProgressEntries(logFile) {
  if (!logFile || !fs.existsSync(logFile)) {
    return [];
  }

  return fs
    .readFileSync(logFile, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => line.startsWith("["))
    .map((line) => ({
      message: stripLogPrefix(line),
      timestamp: line.match(/^\[([^\]]+)\]/)?.[1] ?? null,
      progress: /^\[[^\]]+\]\s+\[progress\]\s/.test(line)
    }))
    .filter((entry) => entry.message && !isProgressBlockTitle(entry.message));
}

export function readJobProgressPreview(logFile, maxLines = DEFAULT_MAX_PROGRESS_LINES) {
  return readJobProgressEntries(logFile).slice(-maxLines).map((entry) => entry.message);
}

function currentCommandProgress(entries, now) {
  // Modern logs mark progress explicitly, so diagnostics and log block bodies
  // cannot introduce command events. Retain support for older unmarked logs.
  const progress = entries.filter((entry) => entry.progress);
  const unfinished = [];
  for (const entry of progress.length ? progress : entries) {
    const message = entry.message.replace(/\s+/g, " ");
    if (message.startsWith("Running command:")) {
      unfinished.push({ ...entry, command: message.slice("Running command:".length).trim() });
      continue;
    }
    const completion = message.match(/^Command (?:completed|failed|declined):\s*(.*)$/);
    if (!completion) continue;
    const command = completion[1].replace(/ \(exit [^()]+\)$/, "").trim();
    const index = unfinished.findIndex((entry) => entry.command === command);
    if (index !== -1) unfinished.splice(index, 1);
  }
  const latest = unfinished.at(-1);
  if (!latest) return null;
  const elapsed = formatElapsedDuration(latest.timestamp, now);
  if (!elapsed) return null;
  const command = latest.command;
  const shortCommand = command.length > 96 ? `${command.slice(0, 93)}...` : command;
  return `Running command: ${shortCommand} (running ${elapsed})`;
}

function formatElapsedDuration(startValue, endValue = null) {
  const start = Date.parse(startValue ?? "");
  if (!Number.isFinite(start)) {
    return null;
  }

  const end = endValue ? Date.parse(endValue) : Date.now();
  if (!Number.isFinite(end) || end < start) {
    return null;
  }

  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function looksLikeVerificationCommand(line) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    line
  );
}

function inferLegacyJobPhase(job, progressPreview = []) {
  switch (job.status) {
    case "queued":
      return "queued";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    case "completed":
      return "done";
    default:
      break;
  }

  for (let index = progressPreview.length - 1; index >= 0; index -= 1) {
    const line = progressPreview[index].toLowerCase();
    if (line.startsWith("starting codex") || line.startsWith("thread ready") || line.startsWith("turn started")) {
      return "starting";
    }
    if (line.startsWith("reviewer started") || line.includes("review mode")) {
      return "reviewing";
    }
    if (line.startsWith("searching:") || line.startsWith("calling ") || line.startsWith("running tool:")) {
      return "investigating";
    }
    if (line.startsWith("starting collaboration tool:")) {
      return "investigating";
    }
    if (line.startsWith("running command:")) {
      return looksLikeVerificationCommand(line)
        ? "verifying"
        : job.jobClass === "review"
          ? "reviewing"
          : "investigating";
    }
    if (line.startsWith("command completed:")) {
      return looksLikeVerificationCommand(line) ? "verifying" : "running";
    }
    if (line.startsWith("applying ") || line.startsWith("file changes ")) {
      return "editing";
    }
    if (line.startsWith("turn completed")) {
      return "finalizing";
    }
    if (line.startsWith("codex error:") || line.startsWith("failed:")) {
      return "failed";
    }
  }

  return job.jobClass === "review" ? "reviewing" : "running";
}

export function enrichJob(job, options = {}) {
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;
  const entries = ["queued", "running", "failed"].includes(job.status) ? readJobProgressEntries(job.logFile) : [];
  const now = options.now ?? new Date().toISOString();
  const enriched = {
    ...job,
    kindLabel: getJobTypeLabel(job),
    progressPreview: entries.slice(-maxProgressLines).map((entry) => entry.message),
    current: job.status === "running" ? currentCommandProgress(entries, now) : null,
    elapsed: formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? now),
    duration:
      job.status === "completed" || job.status === "failed" || job.status === "cancelled"
        ? formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? job.updatedAt)
        : null
  };

  return {
    ...enriched,
    phase: enriched.phase ?? inferLegacyJobPhase(enriched, enriched.progressPreview)
  };
}

export function readStoredJob(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return reconcileJob(workspaceRoot, readJobFile(jobFile));
}

function matchJobReference(jobs, reference, predicate = () => true) {
  const filtered = jobs.filter(predicate);
  if (!reference) {
    return filtered[0] ?? null;
  }

  const exact = filtered.find((job) => job.id === reference);
  if (exact) {
    return exact;
  }

  const prefixMatches = filtered.filter((job) => job.id.startsWith(reference));
  if (prefixMatches.length === 1) {
    return prefixMatches[0];
  }
  if (prefixMatches.length > 1) {
    throw new Error(`Job reference "${reference}" is ambiguous. Use a longer job id.`);
  }

  throw new Error(`No job found for "${reference}". Run /codex:status to list known jobs.`);
}

export function buildStatusSnapshot(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(listReconciledJobs(workspaceRoot), options));
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_STATUS_JOBS;
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;

  const running = jobs
    .filter((job) => job.status === "queued" || job.status === "running")
    .map((job) => enrichJob(job, { maxProgressLines }));

  const latestFinishedRaw = jobs.find((job) => job.status !== "queued" && job.status !== "running") ?? null;
  const latestFinished = latestFinishedRaw ? enrichJob(latestFinishedRaw, { maxProgressLines }) : null;

  const recent = (options.all ? jobs : jobs.slice(0, maxJobs))
    .filter((job) => job.status !== "queued" && job.status !== "running" && job.id !== latestFinished?.id)
    .map((job) => enrichJob(job, { maxProgressLines }));

  return {
    workspaceRoot,
    config,
    sessionRuntime: getSessionRuntimeStatus(),
    running,
    latestFinished,
    recent,
    needsReview: Boolean(config.stopReviewGate)
  };
}

export function buildSingleJobSnapshot(cwd, reference, options = {}) {
  const exact = reference ? findJobWorkspace(cwd, reference) : null;
  const workspaceRoot = exact?.workspaceRoot ?? resolveWorkspaceRoot(cwd);
  const jobs = exact ? [reconcileJob(workspaceRoot, exact.job)] : sortJobsNewestFirst(listReconciledJobs(workspaceRoot));
  const selected = matchJobReference(jobs, reference);
  if (!selected) {
    throw new Error(`No job found for "${reference}". Run /codex:status to inspect known jobs.`);
  }

  return {
    workspaceRoot,
    job: enrichJob(selected, { maxProgressLines: options.maxProgressLines })
  };
}

export function resolveResultJob(cwd, reference) {
  const exact = reference ? findJobWorkspace(cwd, reference) : null;
  const workspaceRoot = exact?.workspaceRoot ?? resolveWorkspaceRoot(cwd);
  const reconciled = exact ? [reconcileJob(workspaceRoot, exact.job)] : listReconciledJobs(workspaceRoot);
  const jobs = sortJobsNewestFirst(reference ? reconciled : filterJobsForCurrentSession(reconciled));
  const finished = job => job.status === "completed" || job.status === "failed" || job.status === "cancelled";
  const selected = reference ? matchJobReference(jobs, reference) : matchJobReference(jobs, null, finished);

  if (selected && finished(selected)) {
    return { workspaceRoot, job: selected };
  }

  const active = matchJobReference(jobs, reference, (job) => job.status === "queued" || job.status === "running");
  if (active) {
    throw new Error(`Job ${active.id} is still ${active.status}. Check /codex:status and try again once it finishes.`);
  }

  if (reference) {
    throw new Error(`No finished job found for "${reference}". Run /codex:status to inspect active jobs.`);
  }

  throw new Error("No finished Codex jobs found for this repository yet.");
}

export function resolveCancelableJob(cwd, reference, options = {}) {
  const exact = reference ? findJobWorkspace(cwd, reference) : null;
  const workspaceRoot = exact?.workspaceRoot ?? resolveWorkspaceRoot(cwd);
  const jobs = exact ? [reconcileJob(workspaceRoot, exact.job)] : sortJobsNewestFirst(listReconciledJobs(workspaceRoot));
  const activeJobs = jobs.filter((job) => job.status === "queued" || job.status === "running");

  if (reference) {
    const selected = matchJobReference(activeJobs, reference);
    if (!selected) {
      throw new Error(`No active job found for "${reference}".`);
    }
    return { workspaceRoot, job: selected };
  }

  const sessionScopedActiveJobs = filterJobsForCurrentSession(activeJobs, options);

  if (sessionScopedActiveJobs.length === 1) {
    return { workspaceRoot, job: sessionScopedActiveJobs[0] };
  }
  if (sessionScopedActiveJobs.length > 1) {
    throw new Error("Multiple Codex jobs are active. Pass a job id to /codex:cancel.");
  }

  if (getCurrentSessionId(options)) {
    throw new Error("No active Codex jobs to cancel for this session.");
  }

  throw new Error("No active Codex jobs to cancel.");
}
