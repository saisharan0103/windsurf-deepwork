# Deep Debug Max

Diagnose and repair a defect through competing hypotheses and reproducible evidence.

1. Invoke `@deep-build`. Create a max-effort task whose completion condition includes the before/after reproduction and regression check.
2. Capture Git and environment state; call `deepwork.inspect_repository`.
3. Reproduce the defect. Record exact input, command, environment, expected result, actual result, exit code, and error fingerprint.
4. Run three research lanes: failing control flow; analogous working path; tests, recent history, environment, and boundary conditions.
5. Generate at least three falsifiable root-cause hypotheses. For each, state supporting evidence, contradicting evidence, and the cheapest discriminating check.
6. Execute read-only discriminating checks one variable at a time. Do not edit while multiple hypotheses remain equally plausible.
7. Call `deepwork.record_research` with the lanes, contradictions, and remaining uncertainty.
8. Design three repair alternatives: minimal root-cause fix, defensive boundary fix, and broader architectural correction.
9. Select the smallest repair that addresses the proven cause and regression surface. Call `deepwork.record_design`.
10. Record at least eight steps covering reproduction, implementation units, focused regression, negative path, broader checks, review, and rollback.
11. Call `deepwork.record_plan` and record an initial checkpoint.
12. Implement the proven fix in bounded units. If the same failure repeats twice, stop and replace the hypothesis rather than retrying blindly.
13. Run the original reproduction, focused regression, adjacent path, negative/error path, and applicable broad checks through `deepwork.run_verification`.
14. Run the five-lens review panel and validate every critical/high finding independently.
15. Resolve findings, rerun invalidated evidence, record the final checkpoint, and call `deepwork.final_gate`.
16. Return root cause, why competing hypotheses were rejected, changed files, before/after evidence, regression coverage, remaining uncertainty, and rollback.
