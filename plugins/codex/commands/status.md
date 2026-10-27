---
description: Show Codex jobs and their progress in this repository
argument-hint: '[job-id] [--wait] [--timeout-ms <ms>] [--all] [--json]'
allowed-tools: Bash(node:*)
---

Query progress for a job involved in the current workflow or requested by the user.

Use the loaded absolute script path; do not depend on a shell environment variable or scan plugin caches. Pass the slash arguments as one properly quoted value to the explicit raw-argument decoder.

Entry-point template only: Claude substitutes `$ARGUMENTS` in Markdown before Bash runs; it is not guaranteed to be a shell variable. Build actual Bash arguments as literal single-quoted values (escape each embedded `'` as `'\''`), or use a prompt file for task text. Never use `eval` or assume double quotes alone protect substituted text.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" status --raw-args "$ARGUMENTS"
```

Present the runtime output unchanged, including job IDs, status, sandbox mode, result/log paths, errors, and follow-up commands. Do not infer completion from elapsed time. Preserve actionable stderr if invocation fails.
