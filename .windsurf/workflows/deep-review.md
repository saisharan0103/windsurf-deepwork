# Deep Review

Review a candidate implementation independently. Do not edit until the review is complete.

1. Read the task contract, acceptance criteria, repository instructions, candidate diff, and verification record.
2. Reconstruct the affected call paths from repository evidence. Do not trust the implementation summary as proof.
3. Search for counterexamples: missing imports/assets/migrations, partial implementations, duplicated code, stale callers, permission bypasses, error-path gaps, portability problems, hidden dependency churn, and path/security violations.
4. Check that every changed hunk maps to an acceptance criterion and that no protected or unrelated file changed.
5. Re-run the smallest decisive checks independently, then broader checks proportionate to risk.
6. Classify each finding as critical, high, medium, low, or informational; cite file/symbol and evidence.
7. Require critical/high findings to be resolved or explicitly accepted before `deepwork.final_gate` may pass.
8. Return a verdict of Accept, Revise, or Reject, plus remaining uncertainty and exact verification commands/exit codes.
