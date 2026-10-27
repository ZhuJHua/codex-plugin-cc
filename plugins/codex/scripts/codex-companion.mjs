#!/usr/bin/env node

import { spawn } from "node:child_process";
import { sanitizeStderr } from "./lib/diagnostics.mjs";
import { StringDecoder } from "node:string_decoder";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs } from "./lib/args.mjs";
import {
    buildPersistentTaskThreadName,
    DEFAULT_CONTINUE_PROMPT,
    findLatestTaskThread,
    getCodexAuthStatus,
    getCodexAvailability,
    getSessionRuntimeStatus,
    importExternalAgentSession,
    parseStructuredOutput,
    readOutputSchema,
    runAppServerReview,
    runAppServerTurn
  } from "./lib/codex.mjs";
import { resolveClaudeSessionPath } from "./lib/claude-session-transfer.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { binaryAvailable } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  generateJobId,
  getConfig,
  listJobs,
  setConfig,
  mutateJob, resolveJobFile, resolveJobLogFile, terminalJob
} from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  appendLogLine,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  renderNativeReviewResult,
  renderReviewResult,
  renderStoredJobResult,
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderTaskResult
} from "./lib/render.mjs";

import { recoveryCommand } from "./lib/recovery.mjs";
import { processIdentity } from "./lib/process-identity.mjs";
import { acquireThread, cancelJob, claimJob, delay, jobMeta, readJob, reconcileJob, requestCancellation, releaseThread, reserveJob, sessionHasEnded, waitForJob } from "./lib/job-lifecycle.mjs";

let activeJob = null;
let jsonRequested = process.argv.includes("--json");
process.stderr.on("error", error => { if (error.code !== "EPIPE") throw error; });

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const VALID_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const MODEL_ALIASES = new Map([["spark", "gpt-5.3-codex-spark"]]);
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/codex-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--json]",
      "  node scripts/codex-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]",
      "  node scripts/codex-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [focus text]",
      "  node scripts/codex-companion.mjs task [--background] [--write|--network|--full-access] [--thread <id>|--resume-last|--resume|--fresh] [--model <model|spark>] [--effort <effort>] [--job-timeout-ms <ms>] [--raw-args <string>] [prompt]",
      "  node scripts/codex-companion.mjs transfer [--source <claude-jsonl>] [--json]",
      "  node scripts/codex-companion.mjs status [job-id] [--all] [--json]",
      "  node scripts/codex-companion.mjs result [job-id] [--json]",
      "  node scripts/codex-companion.mjs await <job-id> [--timeout-ms <ms>] [--json]",
      "  node scripts/codex-companion.mjs cancel [job-id] [--json]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeRequestedModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized;
}

function normalizeReasoningEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    throw new Error(
      `Unsupported reasoning effort "${effort}". Use one of: none, minimal, low, medium, high, xhigh, max, ultra (subject to model support).`
    );
  }
  return normalized;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(argv, {
    allowRawArgs: true,
    onOption(key, value) { if (key === "json") jsonRequested = value; },
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const codexStatus = getCodexAvailability(cwd);
  const authStatus = await getCodexAuthStatus(cwd);
  const config = getConfig(workspaceRoot);

  const nextSteps = [];
  if (!codexStatus.available) {
    nextSteps.push("Install Codex with `npm install -g @openai/codex`.");
  }
  if (codexStatus.available && !authStatus.loggedIn && authStatus.requiresOpenaiAuth) {
    nextSteps.push("Run `!codex login`.");
    nextSteps.push("If browser login is blocked, retry with `!codex login --device-auth` or `!codex login --with-api-key`.");
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/codex:setup --enable-review-gate` to require a fresh review before stop.");
  }

  return {
    ready: nodeStatus.available && codexStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    codex: codexStatus,
    auth: authStatus,
    sessionRuntime: getSessionRuntimeStatus(),
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

function buildAdversarialReviewPrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
  return interpolateTemplate(template, {
    REVIEW_KIND: "Adversarial Review",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}

function ensureCodexAvailable(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }
}

function buildNativeReviewTarget(target) {
  if (target.mode === "working-tree") {
    return { type: "uncommittedChanges" };
  }

  if (target.mode === "branch") {
    return { type: "baseBranch", branch: target.baseRef };
  }

  return null;
}

function validateNativeReviewRequest(target, focusText) {
  if (focusText.trim()) {
    throw new Error(
      `\`/codex:review\` now maps directly to the built-in reviewer and does not support custom focus text. Retry with \`/codex:adversarial-review ${focusText.trim()}\` for focused review instructions.`
    );
  }

  const nativeTarget = buildNativeReviewTarget(target);
  if (!nativeTarget) {
    throw new Error("This `/codex:review` target is not supported by the built-in reviewer. Retry with `/codex:adversarial-review` for custom targeting.");
  }

  return nativeTarget;
}

function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report);
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentClaudeSession(jobs) {
  const sessionId = getCurrentClaudeSessionId();
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.threadId &&
        job.status !== "queued" &&
        job.status !== "running"
    ) ?? null
  );
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = positiveDuration(options.timeoutMs, "--timeout-ms", true) ?? DEFAULT_STATUS_WAIT_TIMEOUT_MS;
  const pollIntervalMs = positiveDuration(options.pollIntervalMs, "--poll-interval-ms") ?? DEFAULT_STATUS_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

async function resolveLatestTrackedTaskThread(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot).map(job => reconcileJob(workspaceRoot, job))).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && (job.status === "queued" || job.status === "running"));
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /codex:status before continuing it.`);
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs);
  if (trackedTask) {
    return { id: trackedTask.threadId };
  }

  if (sessionId) {
    return null;
  }

  return findLatestTaskThread(workspaceRoot);
}

async function executeReviewRun(request) {
  ensureCodexAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";
  if (reviewName === "Review") {
    const reviewTarget = validateNativeReviewRequest(target, focusText);
    const result = await runAppServerReview(request.cwd, {
      target: reviewTarget,
      model: request.model,
      signal: request.signal,
      onProgress: request.onProgress
    });
    const payload = {
      review: reviewName,
      target,
      threadId: result.threadId,
      sourceThreadId: result.sourceThreadId,
      error: result.error ?? null, resolved: result.resolved,
      codex: {
        status: result.status,
        stderr: result.error?.message ?? result.stderr,
        stdout: result.reviewText,
        reasoning: result.reasoningSummary
      }
    };
    const rendered = renderNativeReviewResult(
      {
        status: result.status,
        stdout: result.reviewText,
        stderr: [result.error?.message, result.stderr].filter(Boolean).join("\n")
      },
      { reviewLabel: reviewName, targetLabel: target.label, reasoningSummary: result.reasoningSummary }
    );

    return {
      exitStatus: result.status,
      threadId: result.threadId,
      turnId: result.turnId,
      payload,
      rendered,
      summary: firstMeaningfulLine(result.reviewText, `${reviewName} completed.`),
      jobTitle: `Codex ${reviewName}`,
      jobClass: "review",
      targetLabel: target.label
    };
  }

  const context = collectReviewContext(request.cwd, target);
  const prompt = buildAdversarialReviewPrompt(context, focusText);
  const result = await runAppServerTurn(context.repoRoot, {
    prompt,
    model: request.model,
    effort: request.effort, signal: request.signal,
    sandbox: "read-only",
    outputSchema: readOutputSchema(REVIEW_SCHEMA),
    onProgress: request.onProgress
  });
  const parsed = parseStructuredOutput(result.finalMessage, {
    status: result.status,
    failureMessage: result.error?.message ?? (result.status ? result.stderr : "")
  });
  const payload = {
    review: reviewName,
    target,
    error: result.error ?? null, resolved: result.resolved,
    threadId: result.threadId,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    codex: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.finalMessage,
      reasoning: result.reasoningSummary
    },
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel: reviewName,
      targetLabel: context.target.label,
      reasoningSummary: result.reasoningSummary
    }) + (result.status ? `\nReview failed: ${result.error?.message ?? result.stderr ?? "No terminal success."}\n` : ""),
    summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
    jobTitle: `Codex ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target.label
  };
}


async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureCodexAvailable(request.cwd);

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast
  });

  let resumeThreadId = request.resumeThreadId ?? null;
  if (request.resumeLast && !resumeThreadId) {
    const latestThread = await resolveLatestTrackedTaskThread(workspaceRoot, {
      excludeJobId: request.jobId
    });
    if (!latestThread) {
      throw new Error("No previous Codex task thread was found for this repository.");
    }
    resumeThreadId = latestThread.id;
  }

  if (!request.prompt && !resumeThreadId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  let result;
  let model = request.model;
  let effort = request.effort;
  let modelProvider;
  let frozenSandboxPolicy;
  let frozenApprovalPolicy;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    request.signal?.throwIfAborted();
    try { result = await runAppServerTurn(workspaceRoot, {
      resumeThreadId,
      prompt: attempt ? "Continue the interrupted task from this thread. Inspect already applied changes before proceeding; do not repeat completed actions." :
        request.prompt && !resumeThreadId && !request.prompt.startsWith(STOP_REVIEW_TASK_MARKER)
          ? interpolateTemplate(loadPromptTemplate(ROOT_DIR, "task").replace(/\r?\n$/, ""), { TASK_REQUEST: request.prompt }) : request.prompt,
      defaultPrompt: DEFAULT_CONTINUE_PROMPT,
      model, effort, modelProvider, sandboxPolicy: frozenSandboxPolicy, approvalPolicy: frozenApprovalPolicy, network: request.network, sandbox: resolveTaskSandbox(request),
      signal: request.signal, onProgress: request.onProgress,
      persistThread: true,
      threadName: resumeThreadId ? null : buildPersistentTaskThreadName(request.prompt || DEFAULT_CONTINUE_PROMPT)
    }); } catch (error) {
      const current = request.jobId ? readJob(workspaceRoot, request.jobId) : null;
      if (!error.rpcCode || !/at capacity|server.?overload/i.test(JSON.stringify(error.data ?? error.message)) || !current?.threadId) throw error;
      result = { status: 1, threadId: current.threadId, turnId: current.turnId, resolved: current.resolved, error: { message: error.message, data: error.data }, finalMessage: current.partialOutput ?? "", stderr: "", touchedFiles: [], reasoningSummary: [] };
    }
    const capacity = result.status !== 0 && /at capacity|server.?overload/i.test(JSON.stringify(result.error ?? {}));
    if (!capacity || attempt === 2 || !result.threadId) break;
    resumeThreadId = result.threadId;
    model = result.resolved?.model ?? model;
    effort = request.effort ?? result.resolved?.effort ?? effort;
    modelProvider = result.resolved?.modelProvider ?? modelProvider;
    frozenSandboxPolicy = request.fullAccess ? { type: "dangerFullAccess" } : request.network ? { ...result.resolved?.sandbox, type: "workspaceWrite", networkAccess: true } : result.resolved?.sandbox ?? frozenSandboxPolicy;
    frozenApprovalPolicy = request.fullAccess ? "never" : result.resolved?.approvalPolicy ?? frozenApprovalPolicy;
    const retryDelay = attempt ? 15000 : 5000;
    request.onProgress?.({ message: `Capacity failure; retry ${attempt + 1}/2 on thread ${resumeThreadId} after ${retryDelay}ms.`, phase: "retrying" });
    if (request.jobId) mutateJob(workspaceRoot, request.jobId, job => ({ ...job, attempts: [...(job.attempts ?? []), { threadId: resumeThreadId, error: result.error, retryDelay }] }));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(done, retryDelay);
      function done() { request.signal?.removeEventListener("abort", abort); resolve(); }
      function abort() { clearTimeout(timer); reject(request.signal.reason); }
      request.signal?.addEventListener("abort", abort, { once: true });
      if (request.signal?.aborted) abort();
    });
  }

  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage = sanitizeStderr(result.error?.message ?? (result.status ? result.stderr : ""));
  const rendered = renderTaskResult(
    {
      rawOutput,
      failureMessage,
      reasoningSummary: result.reasoningSummary
    },
    {
      title: taskMetadata.title,
      jobId: request.jobId ?? null,
      write: Boolean(request.write)
    }
  );
  const payload = {
    status: result.status,
    threadId: result.threadId,
    sandbox: resolveTaskSandbox(request),
    error: result.error ?? null, resolved: result.resolved,
    commandExecutions: result.commandExecutions, fileChanges: result.fileChanges,
    rawOutput,
    touchedFiles: result.touchedFiles,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    recoveryCommand: result.status && result.threadId ? `task --thread ${result.threadId}${request.fullAccess ? " --full-access" : request.write ? " --write" : ""} -- "Continue after inspecting partial changes."` : null,
    payload,
    rendered: result.status ? `${rendered.trimEnd()}\nTask failed: ${failureMessage || "No successful terminal result."}\n` : rendered,
    summary: firstMeaningfulLine(result.status ? failureMessage : rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: Boolean(request.write)
  };
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: reviewName === "Review" ? "Codex Review" : `Codex ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  if (!resumeLast && String(prompt ?? "").startsWith(STOP_REVIEW_TASK_MARKER)) {
    return {
      title: "Codex Stop Gate Review",
      summary: "Stop-gate review of previous Claude turn"
    };
  }

  const title = resumeLast ? "Codex Resume" : "Codex Task";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /codex:status ${payload.jobId} for progress or /codex:await ${payload.jobId} for the result.\nResult: ${payload.meta.resultFile}\nLog: ${payload.logFile}\n`;
}

function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  return jobClass === "review" ? "review" : "task";
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write
  });
}


function resolveTaskSandbox({ write, fullAccess, network }) {
  return fullAccess ? "danger-full-access" : write || network ? "workspace-write" : "read-only";
}

function buildTaskJob(workspaceRoot, taskMetadata, write, fullAccess, network) {
  return {
    ...createCompanionJob({
      prefix: "task",
      kind: "task",
      title: taskMetadata.title,
      workspaceRoot,
      jobClass: "task",
      summary: taskMetadata.summary,
      write
    }),
    sandbox: resolveTaskSandbox({ write, fullAccess, network })
  };
}


function renderTransferResult(payload) {
  const lines = [
    "Transferred the Claude session into a Codex thread with visible turn history.",
    `Codex session ID: ${payload.threadId}`,
    `Resume in Codex: ${payload.resumeCommand}`
  ];
  return `${lines.join("\n")}\n`;
}

async function executeTransfer(cwd, options = {}) {
  const sourcePath = resolveClaudeSessionPath(cwd, {
    source: options.source
  });
  const result = await importExternalAgentSession(cwd, { sourcePath });
  const payload = {
    threadId: result.threadId,
    resumeCommand: `codex resume ${result.threadId}`,
    sourcePath,
    sessionId: path.basename(sourcePath, ".jsonl")
  };

  return {
    payload,
    rendered: renderTransferResult(payload)
  };
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

function requireTaskRequest(prompt, resumeLast) {
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
}

function positiveDuration(value, name, allowZero = false) {
  if (value == null) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < (allowZero ? 0 : 1)) throw new Error(`${name} must be a ${allowZero ? "non-negative" : "positive"} integer.`);
  return number;
}

async function observeJob(cwd, id, options = {}) {
  activeJob = readJob(cwd, id);
  let offset = 0;
  let pendingLog = "";
  const decoder = new StringDecoder("utf8");
  const result = await waitForJob(cwd, id, {
    timeoutMs: options.timeoutMs,
    onUpdate(job) {
      if (!job.logFile || !fs.existsSync(job.logFile)) return;
      const size = fs.statSync(job.logFile).size;
      if (size < offset) offset = 0;
      if (size > offset && !process.stderr.destroyed) {
        const fd = fs.openSync(job.logFile, "r");
        try {
          const chunk = Buffer.alloc(Math.min(65536, size - offset));
          while (offset < size) {
            const bytes = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - offset), offset);
            if (!bytes) break;
            pendingLog += decoder.write(chunk.subarray(0, bytes));
            const lines = pendingLog.split("\n");
            pendingLog = lines.pop();
            for (const line of lines) {
              const progress = line.match(/^(\[[^\]]+\]) \[progress\] (.*)$/);
              if (progress) process.stderr.write(`${progress[1]} ${progress[2]}\n`);
            }
            offset += bytes;
          }
        } finally { fs.closeSync(fd); }
      }
    }
  });
  const { job, timedOut } = result;
  const payload = { ...(job.result ?? { status: job.status === "completed" ? 0 : 1, threadId: job.threadId ?? null, rawOutput: job.partialOutput ?? "", error: job.errorMessage ? { message: job.errorMessage } : null }), meta: jobMeta(job) };
  if (job.status !== "completed" && !timedOut) {
    payload.status = 1;
    if (payload.codex) payload.codex = { ...payload.codex, status: 1 };
  }
  if (timedOut) payload.waitTimedOut = true;
  outputCommandResult(payload, timedOut ? `Job ${id} is still ${job.status}. Resume waiting with /codex:await ${id} or check /codex:status ${id}.\n` : ["failed", "cancelled"].includes(job.status) ? renderStoredJobResult(job, job) : job.rendered || `${job.errorMessage ?? "No final output recorded."}\n`, options.json);
  if (job.status === "failed" || job.status === "cancelled") process.stderr.write(`${job.errorMessage ?? job.status}\n`);
  process.exitCode = timedOut ? 124 : job.status === "completed" ? 0 : 1;
}

async function dispatchJob(job, request, options) {
  ensureCodexAvailable(request.cwd);
  job.logFile = resolveJobLogFile(job.workspaceRoot, job.id);
  job.requested = { model: request.requestedModel ?? request.model ?? null, effort: request.requestedEffort ?? request.effort ?? null, sandbox: job.sandbox ?? "read-only", networkAccess: request.network || request.fullAccess ? true : null, approvalPolicy: "never" };
  const reserved = reserveJob(job, request);
  activeJob = reserved;
  appendLogLine(job.logFile, `Queued ${job.title}.`);
  try {
    if (request.resumeThreadId) acquireThread(reserved, request.resumeThreadId);
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "task-worker", "--cwd", request.cwd, "--job-id", job.id], {
      cwd: request.cwd, env: process.env, detached: true, stdio: "ignore", windowsHide: true
    });
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
    mutateJob(job.workspaceRoot, job.id, current => ["queued", "running"].includes(current.status) && (!current.pid || current.pid === child.pid) ? { ...current, pid: child.pid, workerIdentity: processIdentity(child.pid), workerPgid: process.platform === "win32" ? null : child.pid } : null);
  } catch (error) {
    mutateJob(job.workspaceRoot, job.id, current => ({ ...current, status: "failed", phase: "failed", errorMessage: error.message, completedAt: nowIso() }));
    releaseThread(reserved, request.resumeThreadId);
    throw error;
  }
  const current = readJob(job.workspaceRoot, job.id);
  process.stderr.write(`[codex] Job ${job.id}; result: ${resolveJobFile(job.workspaceRoot, job.id)}; log: ${job.logFile}\n`);
  if (options.background) {
    const payload = { jobId: job.id, status: current.status, title: job.title, summary: job.summary, sandbox: job.sandbox, logFile: job.logFile, meta: jobMeta(current) };
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
  } else await observeJob(job.workspaceRoot, job.id, options);
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "effort", "cwd", "job-timeout-ms"],
    booleanOptions: ["json", "background", "wait"], stopAtPositional: true, aliasMap: { m: "model" }
  });
  jsonRequested = Boolean(options.json);
  if (options.background && options.wait) throw new Error("Choose --wait or --background.");
  if (config.reviewName === "Review" && options.effort != null) throw new Error("Native review does not support --effort. Use adversarial-review --effort instead.");
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ");
  const target = resolveReviewTarget(cwd, { base: options.base, scope: options.scope });
  config.validateRequest?.(target, focusText);
  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({ prefix: "review", kind: metadata.kind, title: metadata.title, workspaceRoot, jobClass: "review", summary: metadata.summary });
  job.sandbox = "read-only";
  const request = { cwd, base: options.base, scope: options.scope, requestedModel: options.model ?? null, requestedEffort: options.effort ?? null, model: normalizeRequestedModel(options.model), effort: normalizeReasoningEffort(options.effort), focusText, reviewName: config.reviewName,
    jobTimeoutMs: positiveDuration(options["job-timeout-ms"], "--job-timeout-ms"), jobId: job.id, kind: "review" };
  await dispatchJob(job, request, options);
}

async function handleReview(argv) {
  return handleReviewCommand(argv, { reviewName: "Review", validateRequest: validateNativeReviewRequest });
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file", "thread", "job-timeout-ms"],
    booleanOptions: ["json", "write", "full-access", "network", "resume-last", "resume", "fresh", "background", "wait"],
    stopAtPositional: true, aliasMap: { m: "model" }
  });
  jsonRequested = Boolean(options.json);
  if (options.background && options.wait) throw new Error("Choose --wait or --background.");
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const resumeLast = Boolean(options["resume-last"] || options.resume);
  if (Number(resumeLast) + Number(Boolean(options.fresh)) + Number(Boolean(options.thread)) > 1) throw new Error("Choose one of --thread, --resume/--resume-last, or --fresh.");
  const prompt = readTaskPrompt(cwd, options, positionals);
  if (options["prompt-file"] && positionals.length) throw new Error("Use either --prompt-file or task text.");
  requireTaskRequest(prompt, resumeLast || options.thread);
  const fullAccess = Boolean(options["full-access"]);
  const network = Boolean(options.network);
  if (network && fullAccess) throw new Error("Choose --network or --full-access; full access already includes networking.");
  const write = Boolean(options.write || fullAccess || network);
  let resumeThreadId = options.thread ?? null;
  if (resumeLast) {
    resumeThreadId = (await resolveLatestTrackedTaskThread(workspaceRoot))?.id ?? null;
    if (!resumeThreadId) throw new Error("No previous Codex task thread was found for this repository.");
  }
  const metadata = buildTaskRunMetadata({ prompt, resumeLast: Boolean(resumeThreadId) });
  const job = buildTaskJob(workspaceRoot, metadata, write, fullAccess, network);
  if (resumeThreadId) job.threadId = resumeThreadId;
  const request = { cwd, prompt, requestedModel: options.model ?? null, requestedEffort: options.effort ?? null, model: normalizeRequestedModel(options.model), effort: normalizeReasoningEffort(options.effort), write, fullAccess, network, resumeThreadId,
    jobTimeoutMs: positiveDuration(options["job-timeout-ms"], "--job-timeout-ms"), jobId: job.id, kind: "task" };
  await dispatchJob(job, request, options);
}

async function handleTransfer(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "source"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const { payload, rendered } = await executeTransfer(cwd, {
    source: options.source
  });
  outputCommandResult(payload, rendered, options.json);
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, { valueOptions: ["cwd", "job-id"] });
  if (!options["job-id"]) throw new Error("Missing required --job-id.");
  const cwd = resolveCommandWorkspace(options);
  const job = claimJob(cwd, options["job-id"]);
  if (!job) {
    const stored = readJob(cwd, options["job-id"]);
    if (!stored) throw new Error(`No job found for ${options["job-id"]}.`);
    if (!terminalJob(stored) && stored.status !== "running") throw new Error(`Job ${stored.id} cannot be claimed from status ${stored.status ?? "missing"}.`);
    return;
  }
  if (!job.request || typeof job.request !== "object") {
    const message = `Stored job ${job.id} is missing its task request payload.`;
    mutateJob(cwd, job.id, current => ({ ...current, status: "failed", phase: "failed", pid: null, errorMessage: message, completedAt: nowIso() }));
    throw new Error(message);
  }
  const controller = new AbortController();
  let leasedThread = job.threadId ?? job.request.resumeThreadId ?? null;
  const cancel = reason => {
    if (!controller.signal.aborted) controller.abort(Object.assign(new Error(reason), { code: "JOB_CANCELLED" }));
  };
  const onSignal = signal => {
    mutateJob(cwd, job.id, current => ({ ...current, cancelRequestedAt: nowIso(), cancelReason: `Worker received ${signal}; inspect partial changes.`, phase: "cancelling" }));
    cancel(`Worker received ${signal}.`);
  };
  const handlers = new Map(["SIGTERM", "SIGINT", "SIGHUP"].map(signal => [signal, () => onSignal(signal)]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  const started = Date.parse(job.createdAt) || Date.now();
  const watch = setInterval(() => {
    try {
      const current = readJob(cwd, job.id);
      if (current.cancelRequestedAt || sessionHasEnded(current)) {
        if (!current.cancelRequestedAt) mutateJob(cwd, job.id, value => ({ ...value, cancelRequestedAt: nowIso(), cancelReason: "Claude session ended.", phase: "cancelling" }));
        cancel(current.cancelReason ?? "Claude session ended.");
      } else if (job.request.jobTimeoutMs && Date.now() - started >= job.request.jobTimeoutMs) {
        controller.abort(Object.assign(new Error("Job exceeded --job-timeout-ms; inspect partial changes before resuming."), { code: "JOB_TIMEOUT" }));
      }
    } catch (error) { controller.abort(error); }
  }, 100);
  const checkCancellation = () => {
    const current = readJob(cwd, job.id);
    if (current.cancelRequestedAt || sessionHasEnded(current)) {
      if (!current.cancelRequestedAt) requestCancellation(cwd, job.id, "Claude session ended.");
      cancel(current.cancelReason ?? "Claude session ended.");
    }
  };
  const update = createJobProgressUpdater(cwd, job.id);
  const progress = createProgressReporter({ logFile: job.logFile, onEvent(event) {
    checkCancellation();
    if (event.threadId && event.threadId !== leasedThread) { acquireThread(job, event.threadId); leasedThread = event.threadId; }
    update(event);
  } });
  try {
    checkCancellation();
    controller.signal.throwIfAborted();
    if (leasedThread) acquireThread(job, leasedThread);
    await runTrackedJob(job, () => (job.request.kind === "review" ? executeReviewRun : executeTaskRun)({ ...job.request, onProgress: progress, signal: controller.signal }), { logFile: job.logFile });
  } catch (error) {
    mutateJob(cwd, job.id, current => ({ ...current, status: current.cancelRequestedAt ? "cancelled" : "failed", phase: "failed", pid: null, errorMessage: current.cancelReason ?? error.message, completedAt: nowIso() }));
    throw error;
  } finally {
    clearInterval(watch);
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    releaseThread(job, leasedThread);
  }
}

async function handleAwait(argv) {
  const { options, positionals } = parseCommandInput(argv, { valueOptions: ["cwd", "timeout-ms"], booleanOptions: ["json"] });
  jsonRequested = Boolean(options.json);
  if (positionals.length !== 1) throw new Error("await requires exactly one job ID.");
  await observeJob(resolveCommandWorkspace(options), positionals[0], { json: options.json, timeoutMs: positiveDuration(options["timeout-ms"], "--timeout-ms", true) });
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult({ ...snapshot, meta: jobMeta({ ...snapshot.job, workspaceRoot: snapshot.workspaceRoot }) }, renderJobStatusReport(snapshot.job), options.json);
    if (snapshot.waitTimedOut) process.exitCode = 124;
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(renderStatusPayload(report, options.json), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = { job, storedJob, meta: jobMeta({ ...job, workspaceRoot }) };

  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot).map(job => reconcileJob(workspaceRoot, job))));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, { valueOptions: ["cwd"], booleanOptions: ["json"] });
  jsonRequested = Boolean(options.json);
  const { workspaceRoot, job } = resolveCancelableJob(resolveCommandCwd(options), positionals[0], { env: process.env });
  activeJob = { ...job, workspaceRoot };
  const cancelled = await cancelJob(workspaceRoot, job.id);
  const payload = { jobId: job.id, status: cancelled.status, title: cancelled.title, meta: jobMeta(cancelled) };
  outputCommandResult(payload, renderCancelReport(cancelled), options.json);
  if (cancelled.status !== "cancelled") process.exitCode = 1;
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, {
        reviewName: "Adversarial Review"
      });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "transfer":
      await handleTransfer(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "await":
      await handleAwait(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  if (jsonRequested) {
    let job = activeJob;
    try { if (activeJob) job = readJob(activeJob.workspaceRoot, activeJob.id) ?? activeJob; } catch {}
    if (job?.threadId && !job.recoveryCommand) job = { ...job, recoveryCommand: recoveryCommand(job) };
    console.log(JSON.stringify({ status: 1, error: { message }, meta: jobMeta(job) }));
  }
  process.exitCode = 1;
});
