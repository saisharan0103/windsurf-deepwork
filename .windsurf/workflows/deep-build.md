# Deep Build Max

Run a max-effort, evidence-gated engineering cycle. Invoke `@deep-build` first. For genuine multi-model work, enter Arena before running this workflow and send the identical contract to every isolated candidate.

1. Restate the objective, measurable completion condition, acceptance criteria, non-goals, constraints, allowed paths, protected paths, and assumptions.
2. Generate a unique task ID. Call `deepwork.task_begin` with the canonical project root and `effortProfile: "max"`.
3. Capture Git branch, HEAD, status, untracked files, and pre-existing changes. Preserve them.
4. Call `deepwork.inspect_repository`. Inspect all applicable repository instructions, manifests, entry points, boundaries, tests, config, and relevant history.
5. For defects, reproduce the failure or record the strongest concrete failing signal before proposing edits.
6. Run three read-only research lanes: control/data flow; analogous patterns/architecture; tests/security/error paths. Each lane must cite essential files and unknowns.
7. Read the key files returned by every lane. Max effort requires at least eight successful unique reads before writing.
8. Reconcile contradictions and clarify edge cases, permissions, compatibility, performance, migration, observability, and rollback. Ask only for decisions that materially change behavior or authority.
9. Call `deepwork.record_research` with all three lanes, contradictions, and remaining questions.
10. Design three alternatives: minimal reuse, clean boundary, and pragmatic/adversarial. Specify files, interfaces, flow, tests, and trade-offs.
11. Select one evidence-backed design. Call `deepwork.record_design` with the alternatives, selection rationale, resolved questions, no unresolved questions, and approval evidence.
12. Build at least eight concrete plan steps. Map every acceptance criterion to step IDs and planned verification commands; include exact files, three risks, and rollback.
13. Call `deepwork.record_plan`, then record the first `deepwork.record_checkpoint` for the stable research/design/plan baseline.
14. Implement one coherent unit at a time. Inspect every diff and avoid unrelated cleanup or dependency churn.
15. After each meaningful unit, update the task ledger with `deepwork.record_checkpoint`. After two identical failures, change the hypothesis or consult another Arena candidate.
16. Run every planned focused and broad check through `deepwork.run_verification`. Include negative/error-path and adjacent-regression evidence.
17. Inspect the final diff for scope drift, stale callers, missing imports/assets/migrations, secrets, silent failures, dependency drift, and generated files.
18. Run five distinct review passes: correctness, tests, security, error-handling/observability, and simplicity/conventions. Prefer independent Arena reviewers and report only findings at confidence 80 or higher.
19. Call `deepwork.record_review`. Resolve or disprove every critical/high finding. Any fix invalidates old evidence, so rerun affected checks and all review lenses.
20. Record the final checkpoint with every plan step completed and no remaining step.
21. Call `deepwork.task_status`, satisfy every required next action, then call `deepwork.final_gate` with criterion-by-criterion evidence.
22. Return `Verified` only on `PASS`. Include outcome, changed files, architecture decision, exact commands/exit codes, review disposition, remaining risks, and rollback.
