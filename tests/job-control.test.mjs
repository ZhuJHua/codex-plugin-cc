import "./environment.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { enrichJob, readJobProgressPreview } from "../plugins/codex/scripts/lib/job-control.mjs";
import { renderJobStatusReport, renderStatusReport } from "../plugins/codex/scripts/lib/render.mjs";

const START = "2026-10-27T12:00:00.000Z";
const NOW = "2026-10-27T12:02:14.000Z";
const COMMAND = "Running command: /bin/zsh -lc 'fvm flutter test test/widget_test.dart'";

function fixture(lines) {
  const logFile = path.join(makeTempDir(), "job.log");
  fs.writeFileSync(logFile, `${lines.join("\n")}\n`);
  return { id: "task-command", jobClass: "task", status: "running", logFile, startedAt: START };
}

function renderActive(job) {
  return renderStatusReport({
    sessionRuntime: { label: "private" }, config: {}, running: [job],
    latestFinished: null, recent: []
  });
}

test("status shows fixed command elapsed time in single-job and active table/details views", () => {
  for (const marker of ["[progress] ", ""]) {
    const job = enrichJob(fixture([`[${START}] ${marker}${COMMAND}`]), { now: NOW });
    assert.equal(job.current, `${COMMAND} (running 2m 14s)`);
    assert.deepEqual(job.progressPreview, [COMMAND]);
    assert.deepEqual(readJobProgressPreview(job.logFile), [COMMAND]);
    assert.match(renderJobStatusReport(job), /Current: Running command: .* \(running 2m 14s\)/);
    const output = renderActive(job);
    assert.match(output, /\| Summary \| Current \| Actions \|/);
    assert.ok(output.includes(`| ${job.current} |`));
    assert.ok(output.includes(`  Current: ${job.current}`));
  }
});

test("command elapsed time uses its start rather than job start or later diagnostics", () => {
  const job = fixture([
    `[${START}] [progress] Running command: previous test`,
    "[2026-10-27T12:01:00.000Z] [progress] Command completed: previous test (exit 0)",
    "[2026-10-27T12:02:00.000Z] [progress] Running command: current test",
    "[2026-10-27T12:02:10.000Z] [diagnostic] runtime stderr",
    "[2026-10-27T12:02:11.000Z] Assistant message",
    "body text, not a progress event"
  ]);
  const enriched = enrichJob(job, { now: NOW, maxProgressLines: 1 });
  assert.equal(enriched.elapsed, "2m 14s");
  assert.equal(enriched.current, "Running command: current test (running 14s)");
});

test("a matching command completion clears the current command", () => {
  const command = COMMAND.slice("Running command: ".length);
  for (const message of [
    `Command completed: ${command} (exit 0)`,
    `Command failed: ${command} (exit 1)`,
    `Command declined: ${command} (exit ?)`
  ]) {
    const job = enrichJob(fixture([
      `[${START}] [progress] ${COMMAND}`,
      `[${NOW}] [progress] ${message}`,
      `[${NOW}] Observed command execution`,
      `[${NOW}] Running command: text in a log block`
    ]), { now: NOW });
    assert.equal(job.current, null, message);
    assert.doesNotMatch(renderJobStatusReport(job), /Current:|\(running /);
    assert.doesNotMatch(renderActive(job), /\(running /);
  }
});

test("interim assistant messages and unrelated progress preserve the unfinished command", () => {
  for (const marker of ["[progress] ", ""]) {
    const base = fixture([`[${START}] ${marker}${COMMAND}`]);
    for (const message of [
      "Assistant message captured: npm test is still running.",
      "Applying 1 file change(s).",
      "Turn started (turn-2).",
      "Command completed: unrelated command (exit 0)"
    ]) {
      fs.appendFileSync(base.logFile, `[2026-10-27T12:01:00.000Z] ${marker}${message}\n`);
      const job = enrichJob(base, { now: NOW, maxProgressLines: 1 });
      assert.equal(job.current, `${COMMAND} (running 2m 14s)`, message);
      assert.ok(renderJobStatusReport(job).includes(`Current: ${job.current}`));
      assert.ok(renderActive(job).includes(`| ${job.current} |`));
    }
  }
});

test("overlapping commands show the latest unfinished command in either completion order", () => {
  const first = COMMAND.slice("Running command: ".length);
  const second = "/bin/zsh -lc 'npm test'";
  for (const marker of ["[progress] ", ""]) {
    for (const finishLatestFirst of [false, true]) {
      const base = fixture([
        `[${START}] ${marker}${COMMAND}`,
        `[2026-10-27T12:01:00.000Z] ${marker}Running command: ${second}`
      ]);
      assert.equal(enrichJob(base, { now: NOW }).current, `Running command: ${second} (running 1m 14s)`);
      const finished = finishLatestFirst ? second : first;
      const remaining = finishLatestFirst ? first : second;
      fs.appendFileSync(base.logFile, `[2026-10-27T12:01:30.000Z] ${marker}Command completed: ${finished} (exit 0)\n`);
      const job = enrichJob(base, { now: NOW });
      assert.equal(job.current, `Running command: ${remaining} (running ${finishLatestFirst ? "2m 14s" : "1m 14s"})`);
      assert.ok(renderJobStatusReport(job).includes(`Current: ${job.current}`));
      assert.ok(renderActive(job).includes(`| ${job.current} |`));
      fs.appendFileSync(base.logFile, `[${NOW}] ${marker}Command failed: ${remaining} (exit 1)\n`);
      assert.equal(enrichJob(base, { now: NOW }).current, null);
    }
  }
});

test("command completions match the same truncated command text", () => {
  const command = `/bin/zsh -lc 'npm test ${"test/path ".repeat(20)}`;
  const truncated = `${command.slice(0, 93)}...`;
  const base = fixture([
    `[${START}] [progress] Running command: ${truncated}`,
    `[2026-10-27T12:01:00.000Z] [progress] Command completed: ${truncated.replace("npm test", "npm lint")} (exit 0)`
  ]);
  assert.equal(enrichJob(base, { now: NOW }).current, `Running command: ${truncated} (running 2m 14s)`);
  fs.appendFileSync(base.logFile, `[${NOW}] [progress] Command completed: ${truncated} (exit 0)\n`);
  assert.equal(enrichJob(base, { now: NOW }).current, null);
});

test("terminal and queued jobs never show current command elapsed time", () => {
  const base = fixture([`[${START}] [progress] ${COMMAND}`]);
  for (const status of ["completed", "cancelled", "failed", "queued"]) {
    const job = enrichJob({ ...base, status, completedAt: NOW }, { now: NOW });
    assert.equal(job.current, null, status);
    // Renderers also guard against stale caller-supplied current fields.
    assert.doesNotMatch(renderJobStatusReport({ ...job, current: "stale (running 2m 14s)" }), /Current:|\(running /);
    assert.doesNotMatch(renderActive({ ...job, current: "stale (running 2m 14s)" }), /\(running /);
  }
});

test("current command ignores missing, invalid and future timestamps", () => {
  for (const lines of [[], [COMMAND], [`[invalid] [progress] ${COMMAND}`], [`[2026-10-27T13:00:00.000Z] [progress] ${COMMAND}`]]) {
    assert.equal(enrichJob(fixture(lines), { now: NOW }).current, null);
  }
  assert.equal(enrichJob({ status: "running" }, { now: NOW }).current, null);
});

test("current command stays short and escapes markdown table cells", () => {
  const job = enrichJob(fixture([`[${START}] [progress] Running command: echo a | cat ${"long-command ".repeat(30)}`]), { now: NOW });
  assert.ok(job.current.length <= 132, job.current);
  assert.match(job.current, /\.\.\. \(running 2m 14s\)$/);
  assert.match(renderActive(job), /echo a \\\| cat/);
});

test("current command formats fixed second, minute and hour durations", () => {
  const base = fixture([`[${START}] [progress] ${COMMAND}`]);
  for (const [now, duration] of [
    [START, "0s"],
    ["2026-10-27T12:00:59.000Z", "59s"],
    ["2026-10-27T12:01:00.000Z", "1m 0s"],
    ["2026-10-27T13:05:00.000Z", "1h 5m"]
  ]) {
    assert.equal(enrichJob(base, { now }).current, `${COMMAND} (running ${duration})`);
  }
});
