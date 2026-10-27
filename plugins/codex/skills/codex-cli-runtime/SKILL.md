---
name: codex-cli-runtime
description: Invoke the Codex companion task interface from a direct handoff or compatibility rescue agent.
user-invocable: false
---

# Codex Task Runtime

Use the loaded absolute script path:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task ...
```

Claude substitutes this path in plugin Markdown when it loads. It is not a shell environment variable to discover. Do not scan caches, infer an installed version, or select another plugin installation.

## Arguments

- Markdown substitutes `$ARGUMENTS` before Bash runs; the placeholder is not guaranteed to be a shell variable. The Bash blocks are entry-point templates. Encode each actual argument with reliable single quotes (escape an embedded `'` as `'\''`), or use a prompt file for task text. Never use `eval` or trust double quotes alone to protect substituted text. Content inside a real quoted shell variable is not evaluated again, but that does not make Markdown substitution safe.
- For a slash-command argument string, use `task --raw-args "<arguments>"` and quote the entire value as data. For structured callers, pass controls as argv followed by `--` and the literal request, or use a supplied `--prompt-file`. Do not rely on automatic reparsing of a single prompt argument.
- Pass task text verbatim; never reword it. Prefer a prompt file or literal argv, preserving the complete request and agreed plan. In a resumed thread, send only the new instruction and changed constraints verbatim.
- Leave `--model` and `--effort` unset unless selected. Pass values unchanged; the runtime resolves aliases such as `spark` and validates model capabilities.
- `--resume` maps to `--resume-last`; `--fresh` starts a new task. Respect an explicit choice. For an unambiguous follow-up, resume unless `--fresh` was selected.
- For authorized implementation, add `--write`; diagnosis, research, planning, or explicitly read-only requests omit it. Write capability does not authorize scope expansion.
- Forward `--network` only when explicitly selected. It implies workspace-write and requests network access per thread/turn; writes outside allowed roots remain restricted. It cannot be combined with `--full-access`, and must not be added automatically after a failure.
- Forward `--full-access` only when explicitly supplied before task text for this invocation. It implies write access and disables the Codex sandbox, permitting network access and writes outside the repository without approval prompts. Never infer it from earlier work or add it after a failure. A mention inside task text stays text. Report incompatible resumed permissions and the `--fresh` option instead of escalating.
- Wait by default; `--wait` is an explicit equivalent. Forward selected `--background` to the companion. The runner creates its own private detached worker, so do not also wrap the command in a Claude background shell.

## Return

Invoke `task` once per handoff and return companion stdout verbatim, including job/thread IDs, result/log paths, actual status, errors, and recovery commands. Either omit stderr progress lines or copy them verbatim; never summarise or annotate them. Copy actionable failure stderr verbatim. A queued launch or lost observer is not completion. The main session can call `/codex:await <job-id>` when it needs the result; timeout exit 124 ends only that wait and does not cancel the job.

The compatibility rescue agent does no independent repository work or polling. Closing the owning Claude session cancels its active jobs while retaining their records and logs.
