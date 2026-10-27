---
description: Show the stored final output for a Codex job
argument-hint: '[job-id] [--json]'
allowed-tools: Bash(node:*)
---

Retrieve a completed or failed result for the current workflow or a job requested by the user.

Use the loaded absolute script path; do not depend on a shell environment variable or scan plugin caches. Pass the slash arguments as one properly quoted value to the explicit raw-argument decoder.

Entry-point template only: Claude substitutes `$ARGUMENTS` in Markdown before Bash runs; it is not guaranteed to be a shell variable. Build actual Bash arguments as literal single-quoted values (escape each embedded `'` as `'\''`), or use a prompt file for task text. Never use `eval` or assume double quotes alone protect substituted text.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" result --raw-args "$ARGUMENTS"
```

Present the full runtime output unchanged. Preserve findings, uncertainty, files, verification limits, job/thread IDs, result/log paths, errors, and recovery commands. Preserve actionable stderr if invocation fails.
