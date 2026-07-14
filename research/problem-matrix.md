# Windsurf/Cascade problem matrix

Research snapshot: 2026-07-10. Recurrence is qualitative, based on repeated independent reports and first-party release notes; it is not a measured defect rate.

## What can and cannot be fixed locally

| Priority | Failure class | Evidence pattern | Local response in this project | Residual platform limit |
| --- | --- | --- | --- | --- |
| P0 | Unsafe or over-broad edits | Unrequested rewrites, file corruption, weak diff/revert boundaries | Git baseline and final changed-path comparison, contract plus plan scope, content fingerprints, trajectory-bound evidence, worktree isolation | Host UI/revert defects and same-inode races outside an OS sandbox |
| P0 | Symlink escape and poisoned repositories | GhostApproval demonstrated writes outside the workspace before Windsurf's Accept/Reject UI | Canonical-path guard; reject escaping links, reparse redirects, and hardlinks; fail-closed command/MCP policy; treat repo text as untrusted | Hooks are pre-action checks, not atomic filesystem mediation; a vendor patch and low-privilege sandbox remain necessary |
| P0 | Premature “done” claims | Missing imports/resources, compile errors, circular repairs, tests skipped | Machine-verifiable final gate, required acceptance evidence, test/lint/build records | A response hook cannot retract an already emitted answer |
| P1 | Shallow repository investigation | Repeated partial reads, missed cross-file dependencies, rules dropped in long sessions | Repository inventory, evidence ledger, read-before-write gate, durable task contract | Model context and retrieval remain finite |
| P1 | Retry/edit/terminal loops | Identical failed edits or commands repeat and waste time/credits | Retry budget, repeated-command circuit breaker, checkpoints and handoffs | Provider/editor outages and billing are host-controlled |
| P1 | MCP reliability and trust | Startup hangs, zero tools, config regressions, malicious STDIO registration | Small six-tool server, real stdio doctor lifecycle, required workspace/task identity, default-deny foreign MCP during bound tasks, config protection | Host MCP parsing/OAuth bugs remain |
| P2 | Credit/model opacity | Users cannot reliably predict cost or force model routing | Local task/outcome ledger and explicit Arena playbook | MCP cannot select Windsurf-hosted models or alter billing |
| P2 | Context/history loss | Crashes and long sessions lose decisions and prior constraints | Locked append-only user-global state keyed by workspace, task handoff, and metadata-only transcript audit | Private Cascade history remains host-managed |
| P2 | CPU/RAM/session degradation | Large repositories and long sessions can slow or crash | Ignore generated/vendor trees, concise inventories, bounded output | Electron/model-provider resource defects remain |
| P3 | Remote/WSL/extension incompatibility | Environment-specific startup and terminal issues | Doctor and evidence bundle | Host integration bugs require vendor fixes |

## Sources

### Current first-party capabilities and limits

- [Arena Mode](https://docs.devin.ai/desktop/cascade/arena): the supported multi-model route. Each selected model gets an isolated session/worktree and its credit multiplier is charged additively. Git initialization is required.
- [Plans and Usage](https://docs.devin.ai/desktop/accounts/usage): legacy Enterprise credits are charged per premium-model prompt, not per internal file/tool action; balances reset monthly.
- [MCP](https://docs.devin.ai/desktop/cascade/mcp): Cascade exposes MCP tools, resources, and prompts through stdio/HTTP/SSE, but documents no API for switching the host model or launching Arena. Enterprise access may be admin-controlled.
- [Hooks](https://docs.devin.ai/desktop/cascade/hooks): pre-read, pre-write, pre-command, pre-prompt, and pre-MCP hooks can block with exit code 2. Post-response hooks are asynchronous.
- [Skills](https://docs.devin.ai/desktop/cascade/skills), [Workflows](https://docs.devin.ai/desktop/cascade/workflows), and [Rules](https://docs.devin.ai/desktop/cascade/memories): these supply progressive procedures, manual runbooks, and persistent behavior constraints respectively.
- [Worktrees](https://docs.devin.ai/desktop/cascade/worktrees): isolate parallel sessions; untracked files are not copied by default.

### Security findings

- [Wiz GhostApproval disclosure, 2026-07-08](https://www.wiz.io/blog/ghostapproval-a-trust-boundary-gap-in-ai-coding-assistants): tested Windsurf followed a repository symlink and wrote outside the workspace before Accept/Reject appeared; status was still in progress at disclosure.
- [OX Security MCP supply-chain advisory, 2026-04-15](https://www.ox.security/blog/mcp-supply-chain-advisory-rce-vulnerabilities-across-the-ai-ecosystem/): describes malicious content steering MCP configuration toward attacker-controlled command execution.

### Developer reports used to define the gates

- [Repeated reads, ignored rules and broken diffs](https://www.reddit.com/r/Codeium/comments/1i4jk42/windsurf_issues/)
- [Partial-file context and broken tool calls](https://www.reddit.com/r/windsurf/comments/1kg2axp/context_issues_and_tool_calls_broken/)
- [Confident “fixed” claims followed by compile failures](https://www.reddit.com/r/windsurf/comments/1l0yjbs/are_you_annoyed_when_cascade_says_i_found_the/)
- [Edit loops and repeated file failures](https://www.reddit.com/r/Codeium/comments/1j9eott/anyone_else_having_issues_with_windsurf_editing/)
- [Overwriting a template while violating explicit rules](https://github.com/Exafunction/codeium/issues/127)
- [Windows model-call freezes/internal errors](https://github.com/Exafunction/codeium/issues/181)
- [Sequential Thinking MCP hanging](https://www.reddit.com/r/windsurf/comments/1km6q63/sequential_thinking_mcp_stuck_in_windsurf/)
- [Context7 MCP breaking Windsurf MCP discovery on Windows](https://github.com/upstash/context7/issues/829)
- [Current credit/model-practicality discussion, 2026-07-09](https://www.reddit.com/r/windsurf/comments/1urncyp/is_windsurf_still_practical/)

## Architecture decision

Use five cooperating layers:

1. A short always-on rule for non-negotiable behavior.
2. An explicit `@deep-build` skill and `/deep-build` workflow for the full engineering procedure.
3. A local MCP for task state, repository evidence, verification, and the final gate.
4. Blocking hooks for canonical paths, protected files, dangerous/repeated commands, and MCP-config tampering.
5. Native Arena mode for actual multi-model Windsurf-credit consumption.

The promise is deliberately bounded: detect, constrain, verify, and recover from the major fixable failure classes. Do not claim to repair provider outages, billing policy, private model access, finite model context, host MCP regressions, unpatched editor vulnerabilities, or the hook-to-write time-of-check/time-of-use gap. For untrusted repositories, low-privilege OS isolation remains the real security boundary.
