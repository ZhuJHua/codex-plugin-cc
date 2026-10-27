import "./environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { renderJobStatusReport, renderReviewResult, renderStoredJobResult } from "../plugins/codex/scripts/lib/render.mjs";

test("renderReviewResult degrades gracefully when JSON is missing required review fields", () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: "approve",
        summary: "Looks fine."
      },
      rawOutput: JSON.stringify({
        verdict: "approve",
        summary: "Looks fine."
      }),
      parseError: null
    },
    {
      reviewLabel: "Adversarial Review",
      targetLabel: "working tree diff"
    }
  );

  assert.match(output, /Codex returned JSON with an unexpected review shape\./);
  assert.match(output, /Missing array `findings`\./);
  assert.match(output, /Raw final message:/);
});

test("job status suggests reviews only for completed tasks that changed files", () => {
  for (const status of ["queued", "running", "cancelled", "failed", "completed"]) {
    for (const touchedFiles of [[], ["changed.txt"]]) {
      const output = renderJobStatusReport({ id: "task-status", status, jobClass: "task", write: true, result: { touchedFiles } });
      if (status === "completed" && touchedFiles.length) {
        assert.match(output, /Review changes: \/codex:review --wait/);
        assert.match(output, /Stricter review: \/codex:adversarial-review --wait/);
      } else {
        assert.doesNotMatch(output, /Review changes:|Stricter review:/);
      }
    }
  }
});

test("renderStoredJobResult prefers rendered output for structured review jobs", () => {
  const output = renderStoredJobResult(
    {
      id: "review-123",
      status: "completed",
      title: "Codex Adversarial Review",
      jobClass: "review",
      threadId: "thr_123"
    },
    {
      threadId: "thr_123",
      rendered: "# Codex Adversarial Review\n\nTarget: working tree diff\nVerdict: needs-attention\n",
      result: {
        result: {
          verdict: "needs-attention",
          summary: "One issue.",
          findings: [],
          next_steps: []
        },
        rawOutput:
          '{"verdict":"needs-attention","summary":"One issue.","findings":[],"next_steps":[]}'
      }
    }
  );

  assert.match(output, /^# Codex Adversarial Review/);
  assert.doesNotMatch(output, /^\{/);
  assert.match(output, /Codex session ID: thr_123/);
  assert.match(output, /Resume in Codex: codex resume thr_123/);
});
