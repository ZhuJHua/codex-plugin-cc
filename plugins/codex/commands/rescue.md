---
description: Run a Codex task or follow-up, directly from the current Claude session
argument-hint: "[--background|--wait] [--network|--full-access] [--resume|--fresh] [--model <model|spark>] [--effort <effort>] [request]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Run the companion directly from the current Claude session by default. This avoids a forwarding-agent call for ordinary handoffs. Preserve the request, agreed plan, relevant context, and acceptance criteria; do not inspect the repository or replan the task before dispatch. Ask what Codex should do if no task was supplied.

Original request:
$ARGUMENTS

Use the absolute script path substituted into this Markdown when the plugin loads. Do not depend on a `CLAUDE_PLUGIN_ROOT` shell environment variable or scan plugin caches or installation registries.

Entry-point template only: Claude substitutes `$ARGUMENTS` in Markdown before Bash runs; it is not guaranteed to be a shell variable. Build actual Bash arguments as literal single-quoted values (escape each embedded `'` as `'\''`), or use a prompt file for task text. Never use `eval` or assume double quotes alone protect substituted text.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --raw-args "$ARGUMENTS"
```

`--raw-args` explicitly decodes slash-command arguments. Quote its value as one shell argument; do not execute the request as shell code. For an authorized implementation, add `--write` before `--raw-args` unless `--full-access` was supplied. For diagnosis, planning, research, or explicitly read-only work, omit `--write`. When adding agreed context, pass the complete request as literal argv after `--`, or use an existing `--prompt-file`; do not silently reinterpret prompt text as flags.

## Controls

- Forward `--network` only when explicitly selected. It enables workspace-write with networking, including permitted loopback sockets, while retaining filesystem restrictions. It implies write and cannot be combined with `--full-access`. Never add either permission flag merely to recover from a failure.

- Wait for the result by default, including when `--wait` is supplied. Forward `--background` to the companion only when the user selected it; the runner owns background execution. Do not also put the companion inside a Claude background shell to detach it.
- Preserve selected `--model` and `--effort`; leave them unset otherwise. The runtime resolves aliases and validates model capabilities.
- Forward `--full-access` only when explicitly supplied before the task text for this invocation. It disables the Codex sandbox and permits network access and writes outside the repository without approval prompts. Never infer it from an earlier task or add it after a failure; mentions inside task text remain text.
- Honor `--resume` and `--fresh`. The runtime maps `--resume` to `--resume-last`; use only the new instruction when continuing a thread. For an unambiguous follow-up, resume; for clearly independent work, start fresh.
- If the relationship to earlier work is genuinely ambiguous, query the helper below. If `available: true`, ask once whether to continue or start fresh. Do not repeat an already resolved choice.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task-resume-candidate --json
```

## Parallel or isolated handoffs

Keep `Agent(subagent_type: "codex:codex-rescue")` as a compatibility option for independent parallel tasks or useful context isolation. Include the complete task and applicable controls in its prompt. It invokes the same runner and follows the same permission, wait, and result rules as the direct path. Keep this command inline; do not use `context: fork`, call `Skill(codex:codex-rescue)`, or recursively invoke `Skill(codex:rescue)`.

## Results

Return companion output unchanged, preserving job IDs, result/log paths, and recovery commands. A background launch or an interrupted observer is not completion. When the current workflow needs the result, use `/codex:await <job-id>`; otherwise report the launch and continue independent work. Preserve actual failure output, including actionable stderr. Direct missing setup/authentication to `/codex:setup`.
