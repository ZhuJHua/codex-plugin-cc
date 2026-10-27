---
description: Transfer the current Claude session into a resumable Codex thread
argument-hint: '[--source <claude-jsonl>] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Transfer only the current user-requested Claude session.

Use the loaded absolute script path; do not depend on a shell environment variable or scan plugin caches. Pass the slash arguments as one properly quoted value to the explicit raw-argument decoder.

Entry-point template only: Claude substitutes `$ARGUMENTS` in Markdown before Bash runs; it is not guaranteed to be a shell variable. Build actual Bash arguments as literal single-quoted values (escape each embedded `'` as `'\''`), or use a prompt file for task text. Never use `eval` or assume double quotes alone protect substituted text.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" transfer --raw-args "$ARGUMENTS"
```

Present the runtime output unchanged, including the Codex thread ID and exact resume command. Preserve actionable stderr if invocation fails.
