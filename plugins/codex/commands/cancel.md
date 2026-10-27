---
description: Cancel an active Codex job while retaining its history
argument-hint: '[job-id] [--json]'
allowed-tools: Bash(node:*)
---

Only run this command when the user explicitly asked to cancel or stop the job. A wait timeout or a slow task is not permission to cancel.

Use the loaded absolute script path; do not depend on a shell environment variable or scan plugin caches. Pass the slash arguments as one properly quoted value to the explicit raw-argument decoder.

Entry-point template only: Claude substitutes `$ARGUMENTS` in Markdown before Bash runs; it is not guaranteed to be a shell variable. Build actual Bash arguments as literal single-quoted values (escape each embedded `'` as `'\''`), or use a prompt file for task text. Never use `eval` or assume double quotes alone protect substituted text.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" cancel --raw-args "$ARGUMENTS"
```

Return the runtime output unchanged. Cancellation retains the job record, partial output, and logs; it does not revert edits already made. Preserve actionable stderr if invocation fails.
