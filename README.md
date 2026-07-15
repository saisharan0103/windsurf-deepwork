# Deepwork for Windsurf

[Documentation](https://saisharan0103.github.io/windsurf-deepwork/) | [Security policy](SECURITY.md) | [Windsurf problem matrix](research/problem-matrix.md) | [Claude Code pattern study](research/claude-code-patterns.md)

> Independent community project. Deepwork is not affiliated with or endorsed by Cognition, Windsurf, Devin, or Anthropic.

Deepwork is a max-effort quality-and-safety layer for Cascade. It makes difficult coding work follow an evidence-first cycle: contract, inspect, research, compare designs, plan, checkpoint, implement, verify, review, and only then claim completion. Windsurf's native Arena mode supplies genuine multi-model execution.

It addresses the fixable parts of the recurring problems summarized in [`research/problem-matrix.md`](research/problem-matrix.md): shallow repository scans, lost requirements, broad edits, repair loops, missing tests, unsupported completion claims, unsafe paths, MCP configuration risk, and weak durable state. The [`Claude Code pattern study`](research/claude-code-patterns.md) records the official Anthropic mechanisms adapted into the max-effort design.

## Components

- `.windsurf/skills/deep-build/`: the reusable `@deep-build` procedure and focused references.
- `.windsurf/workflows/deep-build.md`: the 22-step `/deep-build` max-effort runbook.
- `.windsurf/workflows/deep-plan.md`, `deep-debug.md`, and `deep-review.md`: plan-only, reproduce-first, and review-panel routes.
- `.windsurf/rules/deep-build.md`: short always-on behavioral constraints.
- `.windsurf/hooks.json`: fail-closed pre-action policy and metadata-only post-action audit hooks.
- `src/`: a ten-tool local `deepwork` MCP, three effort profiles, user-global locked state, content-fingerprinted checkpoints/reviews, constrained verifier, and hook engine.
- `scripts/install.ps1`: idempotent global installation with ownership metadata, predecessor restoration, atomic config writes, and path-link defenses.

## Max-effort gates

For a non-trivial task, `effortProfile: "max"` requires:

1. one measurable completion condition;
2. three distinct repository-research lanes and eight successful unique file reads, or the complete inventory when the repository has fewer than eight files;
3. three architecture alternatives and no unresolved design question;
4. at least eight plan steps, three risks, acceptance-to-test mapping, exact file scope, and rollback;
5. two content-fingerprinted checkpoints, with every plan step complete in the final checkpoint;
6. every planned verification command against the current workspace;
7. correctness, tests, security, error-handling, and simplicity review passes;
8. only findings at confidence 80-100, with every critical/high issue resolved or disproved;
9. a passing final gate against current Git scope and acceptance evidence.

## Honest boundary

An MCP can expose tools to Cascade; the documented interface cannot switch Cascade's selected Windsurf-hosted model, launch another Cascade, or start Arena. Native [Arena Mode](https://docs.windsurf.com/windsurf/cascade/arena) is the supported path that runs multiple Windsurf models in isolated sessions/worktrees and charges their credit multipliers additively.

Deepwork mitigates but cannot repair provider outages, editor crashes, billing policy, finite model context, Enterprise allowlists, host MCP bugs, or editor vulnerabilities. The July 8, 2026 [GhostApproval disclosure](https://www.wiz.io/blog/ghostapproval-a-trust-boundary-gap-in-ai-coding-assistants) demonstrated a Windsurf trust-boundary failure; check the vendor's current remediation status before relying on editor-level approval UI. Hooks cannot remove filesystem time-of-check/time-of-use races. Use low-privilege OS isolation for untrusted repositories.

The public `anthropics/claude-code` repository was used as an official workflow reference. Its license is all rights reserved; Deepwork does not copy Claude Code core code or claim to reproduce its private agent loop.

## Build and test

```powershell
npm ci
npm test
node src/cli.js doctor
```

The automated suite covers max-effort depth gates, real stdio initialization/tool discovery, an external-project task through stdio, official hook payloads, fail-closed internal errors, hardlink/link escapes, Windows short-path aliases and PowerShell encodings, trajectory isolation, hostile command forms, repeat writes, verification-time mutations, stale same-file/untracked changes, every planned command, high-confidence review filtering, and final Git scope enforcement.

## Install globally

Clone and validate the package from PowerShell before opening the clone as a Windsurf workspace:

```powershell
npm ci
npm run check
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

The installer:

1. stages and atomically installs a runtime under `~\.codeium\windsurf\deepwork-runtime`;
2. installs the global skill plus `/deep-build`, `/deep-plan`, `/deep-debug`, and `/deep-review`;
3. appends a bounded managed block to `global_rules.md`;
4. merges global hooks without removing existing hooks;
5. merges one `deepwork` entry into `mcp_config.json`;
6. stores an ownership manifest and predecessor backups, proves the Windows hook launcher, and runs the state/hook/stdio doctor.

Runtime task events and transcript metadata are stored outside projects under `~\.codeium\windsurf\deepwork-state`, keyed by the canonical workspace. A repository `.deepwork/task.md` is used only when the MCP is unavailable and should remain uncommitted. Uninstall intentionally retains `deepwork-state` as audit/continuity data.

Enterprise administrators may still need to enable or allowlist the MCP. The runtime, skill, workflows, hooks, and MCP configuration are installed and protocol-tested locally; restart Windsurf to reload them, then confirm UI discovery under the account's live Enterprise policy.

## Use

For a normal complex task:

1. Initialize Git and preserve or commit the intended baseline.
2. Invoke `/deep-build` and mention `@deep-build`. Use `/deep-plan` for no-edit architecture, `/deep-debug` for a defect, or `/deep-review` for an independent candidate review.
3. Let the workflow call the ten `deepwork` tools and obey blocking hooks. Planned tests/builds run through the approval-bearing verifier; non-Deepwork MCP tools are denied unless their exact `server/tool` identity is deliberately allowlisted.

For deliberate multi-model use of the Enterprise credit pool:

1. Open the model picker and enter Arena.
2. Select two strong, different models currently available; avoid Adaptive when deliberate comparison is the goal.
3. Send the identical `/deep-build @deep-build` contract to both isolated candidates.
4. Compare research coverage, architecture, diff, tests, risks, and evidence; select a winner.
5. Run `/deep-review` with retained Arena models, resolve high-severity findings, and require `deepwork.final_gate` to pass.

Spend additional prompts on different research hypotheses, architecture challenge, repeated-failure diagnosis, specialized review, and finding validation - not interchangeable summaries.

## Completion states

- `Verified`: contract, research, design, traceable plan, completed checkpoints, five-lens review, Git scope, acceptance evidence, every planned command, and current fingerprint passed.
- `Partially verified`: useful work exists, but a relevant check is skipped, unavailable, or manual.
- `Blocked`: evidence contradicts completion or a required decision/platform capability is unavailable.

If the MCP/final gate is unavailable, the maximum honest status is `Partially verified`.

## WhatsApp and remote control

This repository does not include a WhatsApp bot, hosted API, database, or remote Windsurf controller. The local MCP needs direct repository access, and native Arena is started manually. The [documentation site](https://saisharan0103.github.io/windsurf-deepwork/#whatsapp) explains a safe notification companion or separately built authenticated job service.

## License status

The repository is publicly visible, but no software license has been selected. Public visibility alone does not grant reuse, redistribution, or derivative-work rights.
