# Arena strategy

Use Arena because it is Windsurf's supported mechanism for executing the same prompt with multiple Windsurf-hosted models and charging their credits additively. An MCP cannot select those models or launch Arena.

## Before invoking `@deep-build`

1. Ensure Git is initialized and the intended baseline is tracked. Arena worktrees omit untracked files by default.
2. Keep `.env`, credentials, private keys, local databases, and machine-specific state out of the worktree. Do not copy them merely to satisfy an agent.
3. Open the model picker, choose Arena, and select two strong but different models from the models actually available in the UI. Avoid Adaptive when the goal is deliberate frontier-model comparison; Adaptive is designed to optimize routing/cost.
4. Send the same task contract and invoke `@deep-build` in Arena.

If the photographed catalog is still what the picker offers, start with **Claude Sonnet 4.5 Thinking** for architecture/root-cause depth and **GPT-5.1-Codex Max High** for implementation/tool discipline. For a separate review round, use **GPT-5.1 High Thinking** or **o3 High Reasoning** if still available. Treat this only as a starting profile: the live picker is authoritative, and model behavior/availability can change.

## Assign independent roles

- Candidate A: prioritize root-cause accuracy, architecture fit, and minimal scope.
- Candidate B: prioritize alternative hypotheses, regression resistance, security, and edge cases.

Do not let one candidate read the other’s narrative before each has produced its own plan and evidence. Compare:

- repository coverage and cited symbols;
- assumptions and unresolved risks;
- diff size and scope discipline;
- verification depth and actual exit codes;
- security and rollback quality.

Select the better candidate only after reviewing its diff and evidence. After convergence, send a new adversarial-review prompt to the retained models: ask them to search for counterexamples, missing tests, unsafe paths, and unsupported completion claims. Re-run the final gate after addressing findings.

## Credit use

Arena charges each selected model's displayed multiplier per prompt. Use additional prompts because they buy a distinct phase or independent challenge—not merely to make a model repeat itself. Tool calls inside a legacy-credit prompt do not consume separate prompt credits according to Windsurf's current legacy Enterprise documentation.

## Limitations

- Arena activation and model selection are manual; no documented MCP API controls them.
- Model availability and multipliers in the UI are authoritative and may change.
- Worktree isolation does not remove the need for canonical-path and command guards.
