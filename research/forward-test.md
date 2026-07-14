# Deep-build forward test

Date: 2026-07-10

An independent coding-agent run received only the `deep-build` skill and an isolated Git fixture. The request was to stop fixed-value promotions from making a cart total negative, preserve percentage behavior, and leave `package.json` untouched. The Deepwork MCP was intentionally unavailable to exercise the documented fallback.

## Observed process

1. Inspected clean Git state, `AGENTS.md`, the manifest, implementation, and tests.
2. Reproduced the defect: `npm test` exited 1 because a fixed discount returned `-10` instead of `0`.
3. Wrote the fallback contract/plan to an uncommitted `.deepwork/task.md`.
4. Changed one expression in `src/cart.js` to clamp the fixed-value result with `Math.max(0, ...)`.
5. Re-ran `npm test`: exit 0, 2/2 tests passed.
6. Ran `git diff --check`: passed.
7. Confirmed `package.json`, `AGENTS.md`, percentage behavior, and the test file were unchanged.

The agent correctly returned `Partially verified`, not `Verified`, because the deliberately unavailable MCP meant `deepwork.final_gate` and an Arena reviewer could not run. This exposed and led to an explicit skill rule: no-MCP fallback is useful, but it cannot self-award the authoritative status.
