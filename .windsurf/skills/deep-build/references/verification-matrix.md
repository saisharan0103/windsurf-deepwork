# Verification matrix

Select checks from repository evidence; do not blindly run every command.

| Change | Minimum evidence | Additional evidence for high risk |
| --- | --- | --- |
| Bug fix | Reproduction before/after, focused regression test | Adjacent integration test and root-cause review |
| Feature | Acceptance-path test, lint/typecheck, build where applicable | Negative/permission/error-path tests and independent review |
| Refactor | Existing focused tests and unchanged public behavior | Full suite, performance/compatibility comparison |
| Dependency/config | Parse/validate config, lockfile consistency, build | Vulnerability/license check and clean install |
| Database/migration | Migration validation and application test on disposable data | Rollback/forward-compatibility and backup plan |
| API/auth/security | Permission and negative tests; secret scan | Threat-model review, dependency scan, manual boundary check |
| UI | Component/interaction test and production build | Browser flow, accessibility and responsive checks |
| Documentation only | Link/example/command validation | Independent technical accuracy review |

Record the command in the plan before execution, plus working directory, timestamp, exit code, bounded stdout/stderr, and the post-command workspace fingerprint. Repository verification code is untrusted: approve/sandbox it proportionately and remove secrets from the environment. Never report a check as passed when it was skipped, timed out, mutated source, or was inferred from code inspection.

If no automated tests exist, document that fact, run the strongest available build/static/manual check, and keep the status `Partially verified` unless every acceptance criterion is otherwise directly demonstrated.
