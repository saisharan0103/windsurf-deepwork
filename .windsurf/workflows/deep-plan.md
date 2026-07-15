# Deep Plan Max

Produce a decision-ready implementation plan without editing repository files.

1. Invoke `@deep-build` and create a max-effort task with a measurable completion condition.
2. Capture Git state and call `deepwork.inspect_repository`.
3. Run three research lanes: control flow, established patterns, and failure/test/security surfaces.
4. Read every essential file returned by the lanes and trace relevant symbols end to end.
5. Record findings, contradictions, and questions with `deepwork.record_research`.
6. Resolve requirements, edge cases, compatibility, permissions, performance, migration, observability, and rollback decisions.
7. Produce three concrete architecture alternatives with files, interfaces, data flow, testing, and trade-offs.
8. Select the best alternative and call `deepwork.record_design` with evidence and no unresolved question.
9. Create at least eight ordered implementation steps with exact files, dependencies, three risks, and rollback.
10. Map every acceptance criterion to step IDs and planned verification commands.
11. Call `deepwork.record_plan` and `deepwork.record_checkpoint` for the stable plan baseline.
12. Adversarially challenge the plan for missing call sites, hidden migrations, error paths, security boundaries, operational gaps, and over-engineering.
13. Revise and re-record the design or plan when the challenge finds a real gap.
14. Return the selected architecture, rejected alternatives, complete file/symbol map, criterion traceability, verification matrix, risks, rollback, and decisions still requiring the user.

Do not write implementation code in this workflow.
