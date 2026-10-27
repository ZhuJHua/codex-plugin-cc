---
name: codex-result-handling
description: Relay Codex results, background launches, wait limits, and failures accurately.
user-invocable: false
---

# Codex Results

Relay helper output unchanged when required. Preserve findings, evidence, uncertainty, changed files, verification limits, job/thread IDs, result/log paths, errors, and exact resume commands. The recorded job status is authoritative; a launcher or observer exiting does not by itself prove task completion.

A background launch reports queued or running work. When the current workflow depends on its result, the main session uses `/codex:await <job-id>` and returns the stored terminal result. Exit 124 means the wait timed out while the job continues; retain its references, continue independent work or wait again, and do not cancel without the user's explicit request. Closing the owning Claude session separately applies the configured cancel-and-retain lifecycle policy.

Preserve partial output and actual invocation errors, including actionable stderr. Do not recast failed or cancelled work as success, fabricate a Codex answer, or replace a failed delegation with an unrequested implementation. Cancellation preserves history and does not revert edits.

For a review-only request, end after reporting the review. If the user already authorized fixing reviewed issues, continue within that authorization; otherwise obtain it before editing. Follow the runtime's setup/login guidance when prerequisites are missing.
