# Codex plugin for Claude Code — ZhuJHua fork

Use Codex from inside Claude Code for code reviews or to delegate tasks to Codex.

This fork is maintained by [ZhuJHua](https://github.com/ZhuJHua/codex-plugin-cc) and is based on [OpenAI’s plugin](https://github.com/openai/codex-plugin-cc). The command namespace remains `codex`; the independent marketplace is `zhujhua-codex`.

This plugin is for Claude Code users who want an easy way to start using Codex from the workflow
they already have.

<video src="./docs/plugin-demo.webm" controls muted playsinline autoplay></video>

## What You Get

- `/codex:review` for a normal read-only Codex review
- `/codex:adversarial-review` for a steerable challenge review
- `/codex:rescue`, `/codex:transfer`, `/codex:status`, `/codex:await`, `/codex:result`, and `/codex:cancel` to delegate work, hand off sessions, and manage background jobs

## Requirements

- **ChatGPT subscription (incl. Free) or OpenAI API key.**
  - Usage will contribute to your Codex usage limits. [Learn more](https://developers.openai.com/codex/pricing).
- **Node.js 18.18 or later**

## Install

If the official plugin is enabled, disable it with `/plugin disable codex@openai-codex` before enabling this fork, so only one plugin supplies `/codex:*`. Existing jobs should finish or be cancelled before switching installations. See [Claude’s marketplace documentation](https://code.claude.com/docs/en/plugin-marketplaces) for install IDs.

Add the marketplace in Claude Code:

```bash
/plugin marketplace add ZhuJHua/codex-plugin-cc
```

Install the plugin:

```bash
/plugin install codex@zhujhua-codex
```

Reload plugins:

```bash
/reload-plugins
```

Then run:

```bash
/codex:setup
```

`/codex:setup` will tell you whether Codex is ready. If Codex is missing and npm is available, it can offer to install Codex for you.

If you prefer to install Codex yourself, use:

```bash
npm install -g @openai/codex
```

If Codex is installed but not logged in yet, run:

```bash
!codex login
```

After install, you should see:

- the slash commands listed below
- the `codex:codex-rescue` subagent in `/agents`

One simple first run is:

```bash
/codex:review --background
/codex:status
/codex:result
```

## Usage

### `/codex:review`

Runs a normal Codex review on your current work. It gives you the same quality of code review as running `/review` inside Codex directly.

> [!NOTE]
> Code review especially for multi-file changes might take a while. It's generally recommended to run it in the background.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review. It also supports `--wait`, `--background`, and `--model`. Native review explicitly rejects `--effort`; use adversarial review for a per-run effort selection. It is not steerable and does not take custom focus text. Use [`/codex:adversarial-review`](#codexadversarial-review) when you want to challenge a specific decision or risk area.

Examples:

```bash
/codex:review
/codex:review --base main
/codex:review --background
```

This command is read-only and will not perform any changes. When run in the background you can use [`/codex:status`](#codexstatus) to check on the progress and [`/codex:cancel`](#codexcancel) to cancel the ongoing task.

### `/codex:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

It uses the same review target selection as `/codex:review`, including `--base <ref>` for branch review.
It also supports `--wait`, `--background`, `--model`, and `--effort`. Unlike `/codex:review`, it can take extra focus text after the flags. The runtime validates a selected effort against available model capabilities instead of assuming every model supports the same values.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or reliability

Examples:

```bash
/codex:adversarial-review
/codex:adversarial-review --base main challenge whether this was the right caching and retry design
/codex:adversarial-review --background look for race conditions and question the chosen approach
/codex:adversarial-review --model gpt-6.1-sol --effort high --base main inspect the retry design
```

This command is read-only. It does not fix code.

### `/codex:rescue`

Runs a Codex task directly from the main Claude session by default. The `codex:codex-rescue` subagent remains available for independent parallel work or useful context isolation; both paths use the same runner and result format.

Use it when you want Codex to:

- investigate a bug
- try a fix
- continue a previous Codex task
- take a faster or cheaper pass with a smaller model

> [!NOTE]
> Long tasks run in the runner's private detached worker. Choose `--background` when Claude should continue other work immediately; the default waits for the result without tying the worker's lifetime to that waiting process.

It supports `--background`, `--wait`, `--network`, `--full-access`, `--resume`, and `--fresh`. If you omit `--resume` and `--fresh`, the plugin can offer to continue the latest rescue thread for this repo.

Examples:

```bash
/codex:rescue investigate why the tests started failing
/codex:rescue fix the failing test with the smallest safe patch
/codex:rescue --resume apply the top fix from the last run
/codex:rescue --model gpt-6.1-sol --effort medium investigate the flaky integration test
/codex:rescue --model spark fix the issue quickly
/codex:rescue --background investigate the regression
/codex:rescue --full-access fix the Flutter tests and run flutter pub get, flutter analyze, and flutter test
/codex:rescue --resume --full-access continue the implementation and run the full test suite
```

You can also just ask for a task to be delegated to Codex:

```text
Ask Codex to redesign the database connection to be more resilient.
```

**Notes:**

- if you do not pass `--model` or `--effort`, Codex chooses its own defaults.
- if you say `spark`, the plugin maps that to `gpt-5.3-codex-spark`
- follow-up rescue requests can continue the latest Codex task in the repo

#### Workspace writes with networking

`--network` selects workspace-write with networking enabled; it implies `--write`. It is an intermediate tier between `--write` and `--full-access`, and cannot be combined with `--full-access`. It is forwarded only when explicitly selected. The runner applies a per-thread configuration override and a per-turn sandbox policy, and records requested networking plus the accepted sandbox in metadata. It never modifies your `config.toml`.

```bash
/codex:rescue --network fetch dependencies and run the tests
```

On macOS with Codex CLI 0.164.0, a real `command/exec` probe confirmed TCP loopback bind/connect fails with networking disabled (`EPERM`) and succeeds when enabled. This covers the socket operation needed by Flutter's test runner. Parent/administrator policies can still restrict networking; other platforms and Unix-domain sockets were not tested. Writes to an SDK or cache outside the allowed roots remain restricted. See the [App Server sandbox protocol](https://learn.chatgpt.com/docs/app-server) and [network configuration](https://learn.chatgpt.com/docs/config-file/config-reference).

#### Full access

`--full-access` disables the Codex sandbox and uses `approvalPolicy: never`. Codex can use the network, open local sockets, and write outside the repository, subject to the permissions of the current OS user and any restrictions imposed by the parent process or administrator. This can help with SDKs, package caches, and test runners such as Flutter that need access beyond the workspace. It implies write access; you do not need `--write` as well.

Put the flag before the task text. Mentioning `--full-access` inside a task description does not enable it. Pass `--` before a prompt that starts with option-like text.

For direct CLI calls, use the absolute path to the checkout or installation you intend to run. `CLAUDE_PLUGIN_ROOT` is substituted in plugin Markdown when Claude loads it; it is not a shell variable available in ordinary main-session or subagent Bash calls.

```bash
CODEX_CC_SCRIPT="/absolute/path/to/codex-plugin-cc/plugins/codex/scripts/codex-companion.mjs"
node "$CODEX_CC_SCRIPT" task --cwd /absolute/path/to/project --full-access -- "fix the failing tests and run the full suite"
node "$CODEX_CC_SCRIPT" task --cwd /absolute/path/to/project --background --full-access -- "run the integration tests"
node "$CODEX_CC_SCRIPT" task --cwd /absolute/path/to/project --resume-last --full-access -- "continue the prior task"
```

Direct callers pass controls as argv before the request and use `--` for literal text. A single prompt argument is not reparsed as a shell-like argument string. Plugin slash-command adapters use the explicit `--raw-args` transport; ordinary callers should not need it.

Full access must be requested on each invocation, including resumes. The plugin explicitly applies it at `turn/start`, so an existing read-only or workspace-write thread can continue with full access. When resuming without the flag, the plugin checks the server's reported sandbox and refuses to run if it differs from the requested read-only or workspace-write mode; use `--fresh` to start with those permissions. It never silently retries with full access.

Without the flag, rescue implementation tasks use `workspace-write`; diagnosis, planning, research, and explicitly read-only requests omit `--write`. Direct `task` calls use `read-only` unless `--write` is supplied. Review commands and the stop-time review gate stay read-only. Task status, JSON results, and logs record the requested sandbox mode.

### Delegation and prompts

Task and review commands wait by default. Select `--background` explicitly when Claude should continue independent work; task size does not change that choice. A background launch acknowledges queued or running work, not completion. When a workflow needs that job's result, Claude can call `/codex:await <job-id>` and relay the stored result.

`review`, `adversarial-review`, `status`, `result`, and `await` are model-callable. Reviews require the user's request or an accepted plan that includes them. Cancellation requires an explicit request to stop a job; transfer stays a manual command. A routine handoff runs directly from the main session. For independent parallel tasks or useful context isolation, Claude can still invoke `Agent(subagent_type: "codex:codex-rescue")`; the agent is a forwarding compatibility entrypoint, not a separate runtime.

The `codex-prompting` skill carries version-neutral delegation guidance. A complete request and agreed plan are preserved. Fresh tasks receive a short handoff contract asking for the outcome, changed files, verification results, and remaining blockers; resumed tasks receive only the new instruction. Explicit user output formats take precedence. Models and effort continue to come from your Codex configuration or explicit flags. The legacy `spark` alias is resolved by the runtime.

Adversarial reviews require evidence for material findings and report limitations when inspection is incomplete. The optional stop gate considers only changes attributable to the previous turn; if the runtime has no evidence to attribute edits to that turn, it allows the stop with a limitation instead of treating all dirty files as new changes.

See [prompt design and validation](docs/prompting.md) for official sources, the prompt surfaces, and representative evaluation cases.

### Job lifetime and recovery

Every task and review runs in a private detached worker with its own Codex app-server. A foreground command observes that worker; a host timeout or disconnected observer does not by itself cancel the job. Keep the reported job ID, result path, log path, and resume command to recover the result through `status`, `await`, or `result`.

There is no default wall-clock timeout for a job. An explicit `await --timeout-ms <ms>` limits only how long that invocation waits: exit code 124 means the job is still running, and does not authorize cancellation. Repeat the wait or continue independent work. Actual failed and cancelled jobs return their recorded terminal outcome instead of looking like a successful launch.

Closing the owning Claude session cancels its active jobs and preserves their job records, partial results, and logs. It does not revert edits already applied. Other sessions' jobs and completed history are retained.

### `/codex:transfer`

Creates a persistent Codex thread from the current Claude Code session and prints a `codex resume <session-id>` command.

Use it when you started a debugging or implementation conversation in Claude Code and want to continue that same context directly in Codex.

Examples:

```bash
/codex:transfer
/codex:transfer --source ~/.claude/projects/-Users-me-repo/<session-id>.jsonl
```

The plugin's existing `SessionStart` hook supplies the current transcript path automatically; `--source` is available as a manual override. The transfer uses Codex's external-agent session importer, so it follows the same conversion rules as importing Claude history in the Codex App and creates visible turns that can be continued in the App or TUI. The source must be under `~/.claude/projects`, and older Codex versions that do not expose session import must be upgraded before using this command.

### `/codex:status`

Shows running and recent Codex jobs for the current repository.

Examples:

```bash
/codex:status
/codex:status task-abc123
```

Use it to:

- check progress on background work
- see the latest completed job
- confirm whether a task is still running

### `/codex:result`

Shows the final stored Codex output for a finished job.
When available, it also includes the Codex session ID so you can reopen that run directly in Codex with `codex resume <session-id>`.

Examples:

```bash
/codex:result
/codex:result task-abc123
```

### `/codex:await`

Waits for a specific job and returns its stored terminal result. Claude can use it to collect the result of work the current workflow depends on.

```bash
/codex:await task-abc123
/codex:await task-abc123 --timeout-ms 60000
```

A wait that reaches its limit exits 124 while the job continues running. It does not cancel the worker or change the job to failed. Use the same job ID to wait again, query status, or retrieve the eventual result.

### `/codex:cancel`

Cancels an active Codex job only when explicitly requested. The job record, partial result, and logs remain available; cancellation does not revert edits.

Examples:

```bash
/codex:cancel
/codex:cancel task-abc123
```

### `/codex:setup`

Checks whether Codex is installed and authenticated.
If Codex is missing and npm is available, it can offer to install Codex for you.

You can also use `/codex:setup` to manage the optional review gate.

#### Enabling review gate

```bash
/codex:setup --enable-review-gate
/codex:setup --disable-review-gate
```

When the review gate is enabled, the plugin uses a `Stop` hook to run a targeted Codex review based on Claude's response. If that review finds issues, the stop is blocked so Claude can address them first.

> [!WARNING]
> The review gate can create a long-running Claude/Codex loop and may drain usage limits quickly. Only enable it when you plan to actively monitor the session.

## Typical Flows

### Review Before Shipping

```bash
/codex:review
```

### Hand A Problem To Codex

```bash
/codex:rescue investigate why the build is failing in CI
```

### Start Something Long-Running

```bash
/codex:adversarial-review --background
/codex:rescue --background investigate the flaky test
```

Then collect the launch's job ID and check or await it:

```bash
/codex:status task-abc123
/codex:await task-abc123
/codex:result task-abc123
```

## Codex Integration

The Codex plugin wraps the [Codex app server](https://developers.openai.com/codex/app-server). It uses the global `codex` binary installed in your environment and [applies the same configuration](https://developers.openai.com/codex/config-basic).

### Common Configurations

If you want to change the default reasoning effort or the default model that gets used by the plugin, you can define that inside your user-level or project-level `config.toml`. For example to always use `gpt-6.1-sol` on `high` for a specific project you can add the following to a `.codex/config.toml` file at the root of the directory you started Claude in:

```toml
model = "gpt-6.1-sol"
model_reasoning_effort = "high"
```

Your configuration will be picked up based on:

- user-level config in `~/.codex/config.toml`
- project-level overrides in `.codex/config.toml`
- project-level overrides only load when the [project is trusted](https://developers.openai.com/codex/config-advanced#project-config-files-codexconfigtoml)

Check out the Codex docs for more [configuration options](https://developers.openai.com/codex/config-reference).

### Moving The Work Over To Codex

Delegated tasks and any [stop gate](#what-does-the-review-gate-do) run can also be directly resumed inside Codex by running `codex resume` either with the specific session ID you received from running `/codex:result` or `/codex:status` or by selecting it from the list.

This way you can review the Codex work or continue the work there.

## FAQ

### Do I need a separate Codex account for this plugin?

If you are already signed into Codex on this machine, that account should work immediately here too. This plugin uses your local Codex CLI authentication.

If you only use Claude Code today and have not used Codex yet, you will also need to sign in to Codex with either a ChatGPT account or an API key. [Codex is available with your ChatGPT subscription](https://developers.openai.com/codex/pricing/), and [`codex login`](https://developers.openai.com/codex/cli/reference/#codex-login) supports both ChatGPT and API key sign-in. Run `/codex:setup` to check whether Codex is ready, and use `!codex login` if it is not.

### Does the plugin use a separate Codex runtime?

No. This plugin delegates through your local [Codex CLI](https://developers.openai.com/codex/cli/) and [Codex app server](https://developers.openai.com/codex/app-server/) on the same machine.

That means:

- it uses the same Codex install you would use directly
- it uses the same local authentication state
- it uses the same repository checkout and machine-local environment

### Will it use the same Codex config I already have?

Yes. If you already use Codex, the plugin picks up the same [configuration](#common-configurations).

### Can I keep using my current API key or base URL setup?

Yes. Because the plugin uses your local Codex CLI, your existing sign-in method and config still apply.

If you need to point the built-in OpenAI provider at a different endpoint, set `openai_base_url` in your [Codex config](https://developers.openai.com/codex/config-advanced/#config-and-state-locations).

Execution state, recovery boundaries, and the paired live evaluation procedure are documented in [docs/reliability.md](docs/reliability.md).

For development, tests isolate Claude session/plugin variables and verify that no processes associated with the current run's temporary roots survive teardown. Both `npm test` and `CODEX_COMPANION_SESSION_ID=ended-x CLAUDE_PLUGIN_DATA=/tmp/x npm test` must pass; the process audit requires permission to inspect the process table.

Each operation owns its Codex app-server through stdio, including setup's temporary authentication check. Status displays `private per-job`. Shared daemon transports and their endpoint/state configuration are not supported.
