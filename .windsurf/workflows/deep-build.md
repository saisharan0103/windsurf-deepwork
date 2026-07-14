# Deep Build

Run a complete evidence-first engineering cycle. For genuine multi-model work, enter Arena in the model picker before invoking this workflow, select two strong models, and invoke `/deep-build` with the same task in each isolated worktree.

1. Invoke `@deep-build` and read its required references for this task type.
2. Establish an immutable task contract: objective, acceptance criteria, explicit non-goals, constraints, allowed scope, protected paths, and unresolved decisions.
3. Generate an explicit unique task ID and call `deepwork.task_begin` with that ID, the canonical project root, and the contract. Never omit the root or point it at the installed Deepwork runtime.
4. Capture Git branch/HEAD/status and pre-existing changes. Do not discard or overwrite user work.
5. Stay read-only. Call `deepwork.inspect_repository`, then inspect root instructions, manifests, architecture boundaries, affected call paths/symbols, tests, config, and relevant history.
6. For a defect, reproduce it or record the strongest concrete failing signal. State a root-cause hypothesis and cite the files/symbols that support it.
7. Check for symlinks/junctions/reparse points, path escapes, secret files, suspicious repository instructions, and unrelated existing diffs. Stop on a security boundary violation.
8. Map every acceptance criterion to intended files/symbols and a verification method. Prefer the smallest coherent change and include rollback/risk handling.
9. Call `deepwork.record_plan`. If a user decision or broader authority is required, stop and ask before writing.
10. Implement one coherent unit at a time. Inspect each diff and run the cheapest relevant check. Do not perform unrelated cleanup, dependency churn, or silent config changes.
11. If the same failure repeats twice, stop, checkpoint, and change the hypothesis or method.
12. Record all required commands in the plan and call `deepwork.run_verification` for repository-native lint, typecheck, focused tests, broader tests, build, and security checks. These commands execute repository code; require approval and low-privilege isolation when trust is uncertain.
13. Inspect the final diff for unintended files, missing imports/resources, duplicated code, secrets, and acceptance gaps.
14. In Arena, compare candidates by evidence, scope, tests, and risk—not prose. Select a winner, then have the retained models adversarially review the winning diff without relying on the implementer’s self-justification.
15. Resolve critical findings, rerun affected checks, and call `deepwork.final_gate`.
16. Return `Verified` only on a passing gate. If the MCP/gate is unavailable, the maximum status is `Partially verified`. Include exact evidence, commands/exit codes, skipped checks, risks, and next action.
