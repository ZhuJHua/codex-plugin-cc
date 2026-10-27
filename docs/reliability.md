# Execution and recovery protocol

All three execution commands (`task`, `review`, `adversarial-review`) persist a queued request before launching a detached worker. The foreground process observes that record and streams its log. Killing the observer does not kill the worker. Each worker starts and closes its own Codex app-server; task threads remain in the user's existing Codex home. Authentication is shared with the installed Codex CLI. The plugin never copies credentials or performs OAuth recovery.

The normal route is direct invocation from Claude. Use the compatible `codex:codex-rescue` Agent when separate context is useful. Parallel jobs use the same worker protocol with either route.

## State and coordination

Job JSON is authoritative. It contains the request, owner session, worker/runtime credentials, cancellation intent, resolved configuration, observed events and terminal result. The workspace index retains active jobs and 50 recent terminal summaries, while job files and logs are retained. Queries scan job files, so removing an index does not remove history. Invalid JSON or invalid ownership data produces an explicit diagnostic.

State updates use same-directory temporary files and rename under a process lock. A worker claims queued work atomically. Terminal states are immutable; a late completion cannot resurrect cancellation. Locks whose owner has exited are recovered by an exclusive owner-token reaper that rechecks ownership before retiring the lock. Stale snapshots cannot remove a replacement owner. If the reaper itself is interrupted or ownership data is corrupt/missing, recovery fails with a path and diagnostic; inspect the reported owner before manual cleanup.

Global coordination references point to authoritative job files. They cover canonical worktree roots across plugin data directories and Codex homes: readers may overlap; a writer conflicts with any active job. `--full-access` is a writer for coordination purposes. Thread leases are global within the canonical Codex home. Different worktrees can execute concurrently. These leases coordinate the plugin's jobs; they do not isolate filesystem access or coordinate unrelated external editors. Finish existing jobs before upgrading from a version that did not register global leases.

## End states and cancellation

Only a root terminal acknowledgement completes a turn. A final-looking message, silent reasoning, or a drained subagent does not establish success. A root error with `willRetry: false`, connection closure or process death produces failure. Errors with `willRetry: true` remain waitable; subagent errors do not replace the root result.

SessionEnd publishes a session cancellation marker before scanning jobs, including jobs launched with another `--cwd`. SessionStart clears that marker and advances the session generation after an end, so resuming the same Claude session ID permits new jobs while old queued/running jobs remain cancelled. A start without a preceding end preserves the generation. Ending-session scans are bounded to their captured generation. Workers check it before dispatch and during execution/backoff. Cancellation targets the recorded turn first, then only verified owned processes if needed. It retains partial output, observations, logs and recovery instructions. It does not revert edits.

Persisted process signals require matching process start identity. Unavailable identity checks or surviving process groups produce an explicit unconfirmed-termination failure and retain conflicting leases. The macOS start identity has second-level precision; portable PID checks reduce reuse risk but are not native OS process handles. Windows and Linux adapters require validation on their respective hosts.

Tasks have no default total deadline. `--job-timeout-ms` sets one explicitly; control RPCs have a separate 60-second timeout. The optional stop gate passes its own explicit deadline within the existing 15-minute hook budget.

## Interfaces and metadata

- `await <job-id>` waits for that exact job without resubmission. `--timeout-ms` exits 124 while work continues. Without a wait timeout it waits indefinitely.
- `task --thread <thread-id>` resumes the selected persistent thread. `--resume-last` remains a convenience that selects within the current Claude session.
- Normal argv task text and text after `--` stay literal. `--raw-args` explicitly decodes a slash-command control prefix while preserving the remaining task text. Use reliable shell quoting or a prompt file for substituted Markdown arguments.
- Native `review --effort` is rejected because its protocol does not expose that control. Adversarial review sends effort in `turn/start`. Model capability validation uses runtime model catalogs, with server validation for unknown models, custom providers and older CLIs without `model/list`. Authentication/network errors remain visible.

New task records use the neutral `task` kind label. The root turn-start notification changes phase to `running`; subagent starts do not reset it to `starting`. Workspace conflicts include job IDs, `/codex:await` and `/codex:cancel` actions and direct CLI equivalents, with the record path as secondary information. Background receipts mention both status and await.

Text stdout retains the result format. JSON stdout contains one result object. Progress and early job/result/log credentials go to stderr. Captured stderr is ANSI-stripped and kept in the log and `meta.diagnostic.stderr`; successful rendered results and their progress stream suppress stderr noise. Failed reviews retain sanitized failure diagnostics. Existing JSON fields remain; additive `meta` includes `schemaVersion`, `jobId`, `turnId`, `jobStatus`, `logFile`, `resultFile`, requested/resolved configuration and sources, diagnostics and a recovery command. Native reviewer effort is explicitly unexposed. File/command observations are evidence, not a complete Git diff or proof that all verification passed.

Persistent tasks retry only explicit capacity/server-overloaded failures, at most twice after 5 and 15 seconds. Each retry uses the same thread and effective configuration with a continuation instruction. Authentication errors, disconnects and uncertain timeouts are not replayed. Review failures offer a fresh review command rather than promising same-thread recovery.

## Paired live evaluation

Deterministic fixtures validate lifecycle and transport, not token savings or model quality. For live evaluation, create paired disposable worktrees at the same commit and uncommitted snapshot; fix the Claude model, Codex model, effort, permissions, input and acceptance criteria. Alternate direct/Agent order across repeated pairs. Include a small edit, a multi-step edit with tests, review, and a resumed follow-up.

Record each attempt, including failures, in this format:

```text
pair_id,route,repository_snapshot,task_id,claude_model,codex_model,effort,sandbox,
claude_input_tokens,claude_cache_read_tokens,claude_output_tokens,
codex_input_tokens,codex_cached_input_tokens,codex_output_tokens,
job_id,thread_id,started_at,completed_at,elapsed_ms,
acceptance_passed,result_retrievable,retries,error
```

Use each product's actual usage records, with unavailable fields left empty. Do not equate Markdown word counts with tokens or combine Claude and Codex token totals. Record whether usage includes resumed history or subagents, and use the same definition for each pair. Compare completion rate, result retrieval rate, per-product usage and elapsed time, including worker startup and failed attempts. No live paired benchmark or predetermined saving percentage is included in this implementation.

## Permission tiers and compatibility

`task --network` selects workspace-write with network enabled, implying write capability while retaining filesystem restrictions. It uses the app-server per-thread `config` override and `turn/start.sandboxPolicy.networkAccess`; model execution never needs a global config edit. It is explicit per invocation and preserved by background execution, resume commands, and capacity retries. Do not combine it with `--full-access`.

A real macOS Codex CLI 0.164.0 `command/exec` probe (no model invocation) returned `EPERM` for TCP loopback bind under `networkAccess: false`, and `loopback-ok` under `true`. This validates the local TCP operation Flutter uses, not an entire Flutter project or unrestricted external SDK/cache access. Linux, Windows, Unix-domain sockets and administrator proxy policies need their own validation. Protocol: [App Server](https://learn.chatgpt.com/docs/app-server).

Private job workers do not use the broker. `app-server-broker.mjs`, `broker-lifecycle.mjs` and `broker-endpoint.mjs` remain active compatibility code: low-level clients can connect to a broker, setup can reuse an existing broker, and status exposes legacy broker state. SessionEnd does not terminate a shared broker that another session may use.

Tests remove inherited Claude session/transcript/plugin-data/env-file and broker variables before loading library code, saving and restoring the parent values within each test process. Each test process receives its own temporary plugin-data root, so persistent session markers cannot contaminate another run. Fixtures supply only the session values they exercise. Cleanup audits the live process table for each run's actual temporary roots, terminates owned process groups/descendants on failed assertions too, and fails if any matching process survives. Historical processes outside those roots are not killed. Run both the normal and deliberately polluted environment commands shown in README.
