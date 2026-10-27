import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { atomicJson, readJson, withFileLock } from "./atomic-store.mjs";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "codex-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const stateRoot = resolveStateRoot();
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateRoot() {
  return process.env[PLUGIN_DATA_ENV] ? path.join(process.env[PLUGIN_DATA_ENV], "state") : FALLBACK_STATE_ROOT_DIR;
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  const parsed = readJson(stateFile, defaultState());
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.jobs) || parsed.jobs.some(job => !job || typeof job !== "object" || typeof job.id !== "string") || (parsed.config != null && (typeof parsed.config !== "object" || Array.isArray(parsed.config)))) throw new Error(`Invalid state structure: ${stateFile}`);
  return {
    ...defaultState(), ...parsed,
    config: { ...defaultState().config, ...(parsed.config ?? {}) },
    jobs: parsed.jobs
  };
}

export function resolveRuntimeRoot() {
  return process.env[PLUGIN_DATA_ENV] ? path.join(process.env[PLUGIN_DATA_ENV], "runtime") : path.join(FALLBACK_STATE_ROOT_DIR, "runtime");
}

export function withWorkspaceLock(cwd, fn) {
  return withFileLock(path.join(resolveStateDir(cwd), ".transaction"), fn);
}

function saveIndex(cwd, state) {
  ensureStateDir(cwd);
  const sorted = [...(state.jobs ?? [])].sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  let retained = 0;
  const jobs = sorted.filter(job => ["queued", "running"].includes(job.status) || retained++ < MAX_JOBS);
  const next = { version: STATE_VERSION, config: { ...defaultState().config, ...state.config }, jobs };
  atomicJson(resolveStateFile(cwd), next);
  return next;
}

export function saveState(cwd, state) {
  return withWorkspaceLock(cwd, () => saveIndex(cwd, state));
}

export function updateState(cwd, mutate) {
  return withWorkspaceLock(cwd, () => {
    const state = loadState(cwd);
    mutate(state);
    return saveIndex(cwd, state);
  });
}

export const terminalJob = job => ["completed", "failed", "cancelled"].includes(job?.status);

// Caller already holds the workspace transaction. Job files are authoritative;
// the index is a compact, recoverable view and never owns artifact deletion.
export function mutateJobUnlocked(cwd, jobId, mutate) {
  const file = resolveJobFile(cwd, jobId);
  const state = loadState(cwd);
  const previous = fs.existsSync(file) ? readJobFile(file) : state.jobs.find(job => job.id === jobId) ?? null;
  const next = mutate(previous);
  if (!next) return previous;
  if (terminalJob(previous)) return previous;
  const updated = { ...next, id: jobId, updatedAt: nowIso() };
  atomicJson(file, updated);
  const summary = { ...updated };
  delete summary.result; delete summary.rendered; delete summary.request;
  state.jobs = [summary, ...state.jobs.filter(job => job.id !== jobId)];
  saveIndex(cwd, state);
  return updated;
}

export function mutateJob(cwd, jobId, mutate) {
  return withWorkspaceLock(cwd, () => mutateJobUnlocked(cwd, jobId, mutate));
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd) {
  const state = loadState(cwd);
  const jobs = new Map(state.jobs.map(job => [job.id, job]));
  const directory = resolveJobsDir(cwd);
  if (fs.existsSync(directory)) {
    for (const name of fs.readdirSync(directory).filter(name => name.endsWith(".json"))) {
      const job = readJobFile(path.join(directory, name));
      if (job?.id) jobs.set(job.id, { ...jobs.get(job.id), ...job });
    }
  }
  return [...jobs.values()];
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  atomicJson(jobFile, payload);
  return jobFile;
}

export function readJobFile(jobFile) {
  const job = readJson(jobFile, null);
  if ((job === null && fs.existsSync(jobFile)) || (job !== null && (typeof job !== "object" || Array.isArray(job) || typeof job.id !== "string"))) throw new Error(`Invalid job structure: ${jobFile}`);
  return job;
}

export function findJobWorkspace(cwd, jobId) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const localFile = resolveJobFile(workspaceRoot, jobId);
  if (fs.existsSync(localFile)) return { workspaceRoot, job: readJobFile(localFile) };
  const root = resolveStateRoot();
  if (!fs.existsSync(root)) return null;
  const matches = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, entry.name, JOBS_DIR_NAME, `${jobId}.json`);
    if (file === localFile || !fs.existsSync(file)) continue;
    const job = readJobFile(file);
    if (job?.id === jobId && job.workspaceRoot && path.join(resolveJobsDir(job.workspaceRoot), `${jobId}.json`) === file) {
      matches.push({ workspaceRoot: job.workspaceRoot, job });
    }
  }
  if (matches.length > 1) throw new Error(`Job ID "${jobId}" is ambiguous across workspaces. Pass --cwd to select its workspace.`);
  return matches[0] ?? null;
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  if (!/^[a-zA-Z0-9_-]+$/.test(jobId)) throw new Error("Invalid job ID.");
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
