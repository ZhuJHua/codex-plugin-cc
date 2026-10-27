---
name: codex-prompting
description: Shape a Codex delegation request when its outcome, scope, or verification requirements need clarification.
user-invocable: false
---

# Codex Delegation

Preserve a complete request as written. When clarification helps, carry forward only relevant facts already supplied by the user or current conversation:

- **Outcome:** the requested result and, when supplied, the implementation plan and acceptance criteria.
- **Context:** relevant paths, observed failures, and decisions Codex will not otherwise have. Let Codex inspect the repository itself.
- **Constraints:** scope, compatibility requirements, and explicit action boundaries. A plan or diagnosis request does not authorize implementation.
- **Verification:** the checks that demonstrate success. Use relevant checks proportional to the change; report failures, skipped checks, and environmental blockers distinctly.

Use plain language; no mandatory XML blocks or repeated generic instructions. Do not invent requirements, tools, paths, evidence, or permissions. Keep related implementation and verification together when they serve one outcome.

For a resumed task, send the new instruction and changed constraints; rely on the existing thread for prior context. Leave model, effort, and execution controls to the runtime skill. Do not change the selected model to fit these instructions.

Read [request examples](references/codex-prompt-recipes.md) only when a request needs shaping. The runtime supplies the initial handoff contract and the review commands supply their own review contracts; do not paste those contracts into every request.
