#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { cancelJob, markSessionEnded, markSessionStarted, endedSessionOwnsJob, sessionJobs } from "./lib/job-lifecycle.mjs";
import { terminalJob } from "./lib/state.mjs";
import { TRANSCRIPT_PATH_ENV } from "./lib/claude-session-transfer.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

function handleSessionStart(input) {
  markSessionStarted(input.session_id);
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(TRANSCRIPT_PATH_ENV, input.transcript_path);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
}

async function handleSessionEnd(input) {
  const sessionId = input.session_id || process.env[SESSION_ID_ENV];
  if (!sessionId) {
    return;
  }

  // Publish the owner boundary before enumerating jobs so a concurrently
  // starting worker also observes the session ending and cannot dispatch work.
  const ended = markSessionEnded(sessionId);
  const cwd = input.cwd || process.cwd();
  const jobs = sessionJobs(sessionId, resolveWorkspaceRoot(cwd)).filter(job => !terminalJob(job) && endedSessionOwnsJob(job, ended));
  const results = await Promise.allSettled(jobs.map(job =>
    cancelJob(job.workspaceRoot, job.id, "Claude session ended.")
  ));
  const failures = results.flatMap((result, index) => {
    if (result.status === "rejected") {
      return [`${jobs[index].id}: ${result.reason?.message ?? String(result.reason)}`];
    }
    return result.value?.terminationUnconfirmed
      ? [`${jobs[index].id}: ${result.value.errorMessage ?? "Runtime termination is unconfirmed."}`]
      : [];
  });
  if (failures.length) {
    throw new Error(`Session cleanup incomplete:\n${failures.join("\n")}`);
  }
  // Keep results and recovery handles. Legacy workspace brokers may serve
  // other sessions, so this hook must not shut down or delete their state.
}

async function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    await handleSessionEnd(input);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
