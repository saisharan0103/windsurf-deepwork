# Claude Code patterns transferred to Deepwork

Research refreshed: 2026-07-15. Sources are Anthropic's official public repository and documentation plus Windsurf's first-party documentation.

## Source boundary

The public [`anthropics/claude-code`](https://github.com/anthropics/claude-code) repository contains official plugins, commands, agents, examples, release history, and installation material. Its root license says all rights are reserved, so this report treats it as an official public reference, not an open-source codebase. Deepwork transfers workflow ideas in an original implementation; it does not copy Claude Code core code.

Repository snapshot reviewed: commit [`b7784f2c63ed4585c32bc20b94d3b64cf4fe6df3`](https://github.com/anthropics/claude-code/commit/b7784f2c63ed4585c32bc20b94d3b64cf4fe6df3), dated 2026-07-14.

## High-value mechanisms

| Official pattern | Evidence | Deepwork transfer |
| --- | --- | --- |
| Explore, plan, then code | Anthropic recommends verification and an explicit explore/plan/code separation in [Claude Code best practices](https://code.claude.com/docs/en/best-practices). | Writes remain blocked until inspection, research, design, and a recorded plan exist. |
| Parallel exploration | The official [`feature-dev`](https://github.com/anthropics/claude-code/tree/main/plugins/feature-dev) plugin launches 2-3 explorers, reads their key files, then runs architecture agents and reviewers. | Max effort requires three research lanes and at least eight successful unique reads. |
| Architecture tournament | `feature-dev` compares minimal, clean, and pragmatic approaches before implementation. | `record_design` requires three alternatives, trade-offs, a selected rationale, approval evidence, and no unresolved question. |
| Plan-only mode | [Plan mode](https://code.claude.com/docs/en/common-workflows#plan-before-editing) reads and proposes without touching disk. | `/deep-plan` produces a decision-ready research/design/implementation map without edits. |
| Isolated context | [Subagents](https://code.claude.com/docs/en/sub-agents) keep investigation context separate and return focused results. | Windsurf Arena supplies isolated worktrees/models; single-model fallback uses distinct sequential lanes without claiming model independence. |
| Strong-model escalation | The [advisor tool](https://code.claude.com/docs/en/advisor) consults a second model before hard decisions, recurring failures, and completion. | Arena consultation is required at architecture, repeated-failure, and final-review decision points when available. |
| Measurable autonomous goal | [`/goal`](https://code.claude.com/docs/en/goal) keeps working until a fresh evaluator accepts a measurable condition. | `task_begin` stores a measurable completion condition; `final_gate` evaluates current machine evidence instead of self-judgment. |
| Durable checkpoints | [Checkpointing](https://code.claude.com/docs/en/checkpointing) enables recovery from bad turns but does not replace Git. | `record_checkpoint` stores workspace fingerprint, Git scope, completed steps, remaining steps, and a recovery summary. |
| Persistent project guidance | [CLAUDE.md and rules](https://code.claude.com/docs/en/memory) keep concise always-loaded facts while procedures move to skills. | A short Windsurf always-on rule invokes a progressively disclosed `@deep-build` skill and focused references. |
| Multi-lens review | The official `pr-review-toolkit` splits tests, silent failures, types, comments, correctness, and simplification across reviewers. | Max effort requires correctness, tests, security, error-handling, and simplicity review passes. |
| High-signal finding validation | The official `code-review` command runs parallel reviewers, then launches additional validators and filters unconfirmed issues. | Deepwork records only findings at confidence 80-100 and blocks unresolved critical/high findings. |
| Completion loop | The official `ralph-wiggum` plugin uses a stop hook and truthful completion promise to prevent premature exit. | Deepwork's fail-closed state gate refuses `Verified` until current fingerprints, checkpoints, reviews, commands, Git scope, and acceptance evidence align. |
| Shared task ledger | [Agent teams](https://code.claude.com/docs/en/agent-teams) coordinate through pending, in-progress, completed, and dependency-aware tasks. | Plan steps and checkpoints form a durable append-only task ledger outside the repository. |

## Windsurf-native composition

Windsurf documents complementary extension surfaces:

- [Skills](https://docs.windsurf.com/windsurf/cascade/skills) load multi-step procedures progressively.
- [Workflows](https://docs.windsurf.com/windsurf/cascade/workflows) expose explicit slash-command runbooks and can call other workflows.
- [Arena](https://docs.windsurf.com/windsurf/cascade/arena) runs selected models in isolated sessions/worktrees and charges each model's multiplier.
- [MCP](https://docs.windsurf.com/windsurf/cascade/mcp) exposes local tools to Cascade.

Deepwork therefore uses a short always-on rule for behavior, a skill for detailed procedure, four workflows for explicit routes, Arena for real model independence, hooks for deterministic boundaries, and a ten-tool MCP for durable evidence.

## What this does not copy or claim

- Deepwork does not implement Claude Code's private agent loop, context compaction, UI, hosted advisor, subagent scheduler, or model router.
- An MCP cannot force Windsurf to spend hidden reasoning tokens, select a hosted model, or launch Arena.
- More steps do not automatically mean better work. The gates require distinct evidence, alternatives, falsification, and current machine checks so additional credits buy different reasoning roles instead of duplicated prose.
- Hooks are not an operating-system sandbox. Untrusted repositories still require low-privilege isolation.
