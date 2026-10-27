---
description: Wait for a Codex job and return its stored result
argument-hint: '<job-id> [--timeout-ms <ms>] [--json]'
allowed-tools: Bash(node:*)
---

Wait for the identified job when the current workflow needs its result.

Use the loaded absolute script path; do not depend on a shell environment variable or scan plugin caches. Pass the slash arguments as one properly quoted value to the explicit raw-argument decoder.

Entry-point template only: Claude substitutes `$ARGUMENTS` in Markdown before Bash runs; it is not guaranteed to be a shell variable. Build actual Bash arguments as literal single-quoted values (escape each embedded `'` as `'\''`), or use a prompt file for task text. Never use `eval` or assume double quotes alone protect substituted text.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" await --raw-args "$ARGUMENTS"
```

Set Bash tool `timeout` to `600000`. Observers default to 9 minutes; forward selected `--timeout-ms`. Exit 124 means still running: await again when the result is needed, never report failure or completion.

Return the terminal result and exit status unchanged. Exit 124 means only that this wait timed out: the job continues running. Report its job ID and the await/status/result commands; do not cancel it or claim completion because the wait ended. Preserve actionable stderr if invocation fails.
