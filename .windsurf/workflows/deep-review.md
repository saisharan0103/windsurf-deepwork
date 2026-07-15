# Deep Review Panel

Review a candidate independently. Do not edit until the review and finding-validation passes are complete.

1. Create a review task with a measurable completion condition, review-only scope, and at least `thorough` effort.
2. Read the task contract, acceptance criteria, repository instructions, candidate diff, and verification record. Do not trust the implementation summary as evidence.
3. Reconstruct affected call paths and state/data transformations from repository files.
4. Run separate review lanes for correctness, tests/regressions, security/permissions, error handling/observability, and simplicity/conventions.
5. Search specifically for missing imports/assets/migrations, stale callers, partial implementations, duplicated behavior, silent catches, cleanup failures, portability issues, dependency churn, and scope violations.
6. Report only issues with confidence 80 or higher and cite exact file/symbol evidence.
7. For every critical/high candidate finding, run a fresh validation pass that tries to disprove it. Mark false positives explicitly.
8. Record all five lenses with `deepwork.record_review` when a Deepwork task is active.
9. Re-run the smallest decisive planned checks independently, then broader checks proportionate to risk.
10. Require critical/high findings to be resolved or proven false positives. Accepted unresolved high findings cannot earn `Verified`.
11. If fixes are authorized, make bounded edits, then rerun affected verification and the complete five-lens review against the new fingerprint.
12. Return `Accept`, `Revise`, or `Reject`, with criterion coverage, validated findings, commands/exit codes, uncertainty, and exact next actions.
