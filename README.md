# Deepwork for Windsurf

[Documentation](https://saisharan0103.github.io/windsurf-deepwork/) · [Security policy](SECURITY.md) · [Research matrix](research/problem-matrix.md)

> Independent community project. Deepwork is not affiliated with or endorsed by Cognition, Windsurf, or Devin.

Deepwork is a quality-and-safety layer for Cascade. It makes difficult coding work follow an evidence-first cycle—inspect, contract, plan, implement, test, review, and only then claim completion—and uses Windsurf's native Arena mode for genuine multi-model execution.

It addresses the fixable parts of the recurring problems summarized in [`research/problem-matrix.md`](research/problem-matrix.md): shallow repository scans, lost requirements, broad edits, repair loops, missing tests, unsupported “done” claims, unsafe paths, MCP configuration risk, and weak durable state.

## Components

- `.windsurf/skills/deep-build/`: the reusable `@deep-build` procedure and focused playbooks.
- `.windsurf/workflows/deep-build.md`: the explicit `/deep-build` runbook.
- `.windsurf/workflows/deep-review.md`: an independent candidate-review runbook.
- `.windsurf/rules/deep-build.md`: short always-on behavioral constraints.
- `.windsurf/hooks.json`: fail-closed pre-action policy and metadata-only post-action audit hooks.
- `src/`: a six-tool local `deepwork` MCP plus CLI, user-global locked state, content-fingerprinted verifier, and hook engine.
- `scripts/install.ps1`: idempotent global installation with ownership metadata, predecessor restoration, atomic config writes, and path-link defenses.

## Honest boundary

An MCP can expose tools to Cascade; the documented interface cannot switch Cascade's selected Windsurf-hosted model, launch another Cascade, or start Arena. Native [Arena Mode](https://docs.devin.ai/desktop/cascade/arena) is the supported path that runs multiple Windsurf models and charges their credit multipliers additively.

Deepwork mitigates but cannot repair provider outages, editor crashes, billing/refund policy, finite model context, Enterprise allowlists, host MCP bugs, or editor vulnerabilities. The July 8, 2026 [GhostApproval disclosure](https://www.wiz.io/blog/ghostapproval-a-trust-boundary-gap-in-ai-coding-assistants) demonstrated a Windsurf trust-boundary failure; check the vendor's current remediation status before relying on any editor-level approval UI. Do not open untrusted repositories with privileged host access merely because these guards are installed. Hooks run before host actions and therefore cannot remove filesystem time-of-check/time-of-use races. Use low-privilege OS isolation for untrusted repositories.

## Build and test

```powershell
npm ci
npm test
node src/cli.js doctor
```

The current automated suite covers 46 cases, including real stdio initialization/tool discovery, an external-project task through stdio, official hook payloads, fail-closed internal errors, hardlink/link escapes, Windows short-path aliases, trajectory isolation, hostile command forms, repeat writes, verification-time mutations, stale same-file/untracked changes, every planned command, and final Git scope enforcement.

## Install globally

Clone and validate the package from PowerShell before opening the clone as a Windsurf workspace; the repository contains fail-closed hook configuration whose runtime dependencies must exist first.

```powershell
npm ci
npm run check
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

The installer:

1. stages and atomically installs a runtime under `~\.codeium\windsurf\deepwork-runtime`;
2. installs the global skill and workflows;
3. appends a bounded managed block to `global_rules.md`;
4. merges global hooks without removing existing hooks;
5. merges one `deepwork` entry into `mcp_config.json`;
6. stores an ownership manifest and predecessor backups under `~\.codeium\windsurf\deepwork-backups`, proves the Windows hook launcher, and runs the state/hook/stdio doctor.

Runtime task events and transcript metadata are stored outside projects under `~\.codeium\windsurf\deepwork-state`, keyed by the canonical workspace. A repository `.deepwork/task.md` is used only as the explicit fallback when the MCP is unavailable and should not be committed.

Uninstall intentionally retains `deepwork-state` as audit/continuity data. Review and remove that directory manually only when its retention is no longer wanted.

Enterprise administrators may still need to enable or allowlist the MCP. Windsurf was not installed in the machine environment where this package was built, so local MCP protocol, hooks, state, and verification can be tested here, while UI discovery and Enterprise policy must be checked in the photographed Windsurf installation.

## Use

For a normal complex task:

1. Ensure the repository is initialized in Git and preserve/commit the intended baseline.
2. Invoke `/deep-build` and mention `@deep-build` in Cascade. The workflow creates an explicit task ID and passes the exact project root; both are required.
3. Let the workflow call the `deepwork` tools and obey blocking hooks. Direct agent terminal execution is limited to read-only inspection; planned tests/builds run through the approval-bearing verifier. Foreign MCP tools are denied by default unless their exact `server/tool` identity is deliberately allowlisted.

For deliberate multi-model use of the Enterprise credit pool:

1. Open the model picker and enter Arena.
2. Select two strong, different models currently available to the account; avoid Adaptive when deliberate frontier-model comparison is the goal.
3. Send the same `/deep-build @deep-build` task to both isolated candidates.
4. Compare repository evidence, diffs, tests, and risk; select a winner.
5. Run `/deep-review` with the retained Arena models, resolve high-severity findings, and require `deepwork.final_gate` to pass.

Use additional prompts for distinct investigation, implementation, or adversarial-review phases—not for repetition without new evidence.

## Completion states

- `Verified`: the task contract, inspection, plan, actual Git scope, acceptance evidence, every planned command, and the current content fingerprint passed the final gate.
- `Partially verified`: useful work exists, but a relevant check was skipped, unavailable, or manual.
- `Blocked`: evidence contradicts completion or a required decision/platform capability is unavailable.

If the MCP/final gate is unavailable, the maximum honest status is `Partially verified`, even when repository-native tests pass.

## WhatsApp and remote control

This repository does not include a WhatsApp bot, hosted API, database, or remote Windsurf controller. The local MCP needs direct access to the repository filesystem, and native Arena is started manually in Windsurf. The [documentation site](https://saisharan0103.github.io/windsurf-deepwork/#whatsapp) explains a safe companion architecture for notifications or a separately built, authenticated job service without pretending those cloud components already exist here.

## License status

The repository is publicly visible, but no software license has been selected. Public visibility alone does not grant reuse, redistribution, or derivative-work rights. Keeping that legal decision explicit avoids silently choosing a license on the owner's behalf.
