# Codex Request Examples

Use an example only when it adds missing task context. Replace placeholders with known facts; omit unknown details rather than inventing them.

## Diagnosis

```text
Investigate why [observed command] fails with [actual error]. Explain the root cause with evidence and the next useful action. Diagnose only; do not edit files.
```

## Implementation

```text
Implement [agreed outcome] using this plan: [decisions and relevant paths]. Preserve [required behavior]. Run [applicable checks] and address failures caused by the change. Hand back the changed files, verification results, and any remaining blockers.
```

## Follow-up

```text
Apply the fix identified in the previous run and run [relevant regression check]. New constraint: [changed requirement].
```

## Research

```text
Compare [options] for [decision and constraints]. Use inspected primary sources for claims that affect the recommendation; distinguish established facts, inferences, and unresolved questions.
```

For local git reviews, use `review` or `adversarial-review` instead of restating their contracts. A request to challenge a design should identify the decision or failure scenario worth investigating, not demand a fixed number of findings.
