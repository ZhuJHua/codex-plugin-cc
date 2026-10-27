# Prompt design and validation

Reviewed against official OpenAI guidance on 2026-10-27:

- [GPT-6 prompting best practices](https://developers.openai.com/api/docs/guides/latest-model#prompting-best-practices): keep task scope and completion clear, respect existing authorization, and scale verification to the change. The guidance is a starting point for the GPT-6 family; evaluate it with the actual selected model, including GPT-6.1 Sol.
- [Rethinking skills and prompts](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra): use short, precise skill descriptions, disclose references only when needed, and retire accumulated instructions that no longer help.

These are design principles, not a claim that every workload improves. The plugin uses the local Codex harness, so it does not duplicate the harness's full system prompt or prescribe model-specific reasoning rituals. It preserves model configuration and existing compatibility aliases.

## Prompt surfaces

| Surface | Responsibility |
| --- | --- |
| `commands/rescue.md` | Call the runner directly by default; preserve the agreed task, context, and execution choices. |
| `agents/codex-rescue.md` | Use the same runner for independent parallel work or context isolation; forward once and relay results or failures. |
| `skills/codex-cli-runtime` | Translate CLI controls and enforce explicit permission selection. |
| `skills/codex-prompting` | Clarify incomplete task requests without adding scope or mandatory block templates. |
| `prompts/task.md` | Add a brief initial task handoff contract; subsequent resumed turns send only the new instruction. |
| `prompts/adversarial-review.md` | Challenge changes with evidence and the existing JSON output schema. |
| `prompts/stop-review-gate.md` | Emit the existing ALLOW/BLOCK protocol for work attributable to the immediately previous turn. |
| `skills/codex-result-handling` | Preserve output, uncertainty, verification limits, and job references. |

The stop gate receives the last Claude response and repository access, not a per-turn diff snapshot. It cannot reliably prove edit attribution from a dirty tree alone. Its prompt therefore reports attribution limits rather than blocking on unrelated earlier work; improving that guarantee would require runtime provenance tracking.

The command Bash blocks are entry-point templates. Claude substitutes Markdown placeholders before Bash runs, so substituted `$ARGUMENTS` text must still be encoded as literal shell arguments; double quotes alone do not prevent command substitution in generated shell code. Use reliable single-quote escaping or a prompt file, and never `eval` the request.

## Validation

Deterministic tests verify skill references, Claude command transport, preservation of task text, fresh/resumed prompt assembly, review JSON rendering, and the stop-gate protocol. They also cover the separate full-access permission paths. Fixtures do not prove model behavior or a reduction in token usage.

For a live comparison, keep the same model, effort, repository state, and task input between versions. Use disposable repositories and include these cases:

| Request | Expected behavior |
| --- | --- |
| Execute an agreed implementation plan | Carry the plan and acceptance criteria into Codex; return changes, actual verification, and blockers. |
| Diagnose a failure without edits | Inspect and report evidence without adding `--write` or implementation scope. |
| Follow up on an existing task | Reuse the thread and send the delta instruction without repeating the initial contract. |
| Wait for a complex task | Wait by default; the runner owns its private worker and explicit background launches. |
| Run independent tasks in parallel | Use the optional rescue Agent entrypoint with the same permission and result rules as direct calls. |
| Runtime failure or background launch | Report the failure or launch references, without claiming successful completion. |
| Review a safe change or incomplete evidence | Do not manufacture findings; distinguish approval from review limitations. |
| Stop after a status-only turn with an already dirty tree | Allow without auditing old changes. |
| Stop after attributable edits with a concrete defect | Block with inspected code evidence and the required correction. |

Compare task completion, correctness, unauthorized edits, handoff completeness, false findings, skipped verification, elapsed time, and tokens. No live model A/B benchmark is included in this change.
