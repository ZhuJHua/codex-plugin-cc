---
description: Challenge a change and its design assumptions using Codex
argument-hint: '[--wait|--background] [--timeout-ms <ms>] [--base <ref>] [--scope auto|working-tree|branch] [--model <model|spark>] [--effort <effort>] [focus ...]'
allowed-tools: Bash(node:*)
---

Run only when the user requested this Codex review or an accepted task plan includes it. This command is review-only: do not edit files, fix findings, or add an independent Claude review.

Original arguments:
$ARGUMENTS

Use the same working-tree or branch targets as `/codex:review`, including `--base <ref>`. Preserve optional focus text after the flags. Forward selected `--model` and `--effort`; leave them unset otherwise. Staged-only and unstaged-only scopes are unsupported.

Use the loaded absolute script path below; do not depend on a shell environment variable or search plugin caches. Preserve the argument string with proper shell quoting. `--raw-args` explicitly decodes slash-command controls; task/focus text remains literal after its boundary.

Entry-point template only: Claude substitutes `$ARGUMENTS` in Markdown before Bash runs; it is not guaranteed to be a shell variable. Build actual Bash arguments as literal single-quoted values (escape each embedded `'` as `'\''`), or use a prompt file for task text. Never use `eval` or assume double quotes alone protect substituted text.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" adversarial-review --raw-args "$ARGUMENTS"
```

Wait by default, including with `--wait`. Forward `--background` only when selected; the runner owns detaching its worker. Do not wrap the companion in a second Claude background shell or infer the mode from task size.

Set Bash tool `timeout` to `600000`. Observers default to 9 minutes; forward selected `--timeout-ms`. Exit 124 means still running: await again when the result is needed, never report failure or completion.

Return stdout unchanged and preserve actionable stderr on failure. A launch report is not a completed review. If the workflow needs a background result, use `/codex:await <job-id>`; never fabricate findings or claim success from the launching process exiting.
