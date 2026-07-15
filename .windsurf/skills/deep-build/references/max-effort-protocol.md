# Max-effort protocol

Max effort deliberately spends more model turns on independent evidence, decision quality, and falsification. It does not reward verbose restatement.

## Enforced minimums

| Gate | Max-effort minimum |
| --- | --- |
| Completion contract | One measurable end condition plus acceptance criteria |
| Research | Three distinct lanes and eight successful unique file reads, or every file in a smaller repository |
| Architecture | Three alternatives, one selected rationale, no unresolved question |
| Plan | Eight steps, three risks, acceptance mapping, exact files, rollback plan |
| Checkpoints | Two durable workspace fingerprints; an earlier one preserves remaining work and the final one completes every step |
| Verification | Every planned command after the latest plan/write baseline |
| Review | Correctness, tests, security, error-handling, and simplicity lenses |
| Finding quality | Confidence 80-100 only; critical/high must resolve or be false positive |
| Completion | Current fingerprint must match checkpoint, review, and verification evidence |

## Efficient credit allocation

Spend extra prompts at decision boundaries:

1. three exploration lanes before design;
2. an architecture challenger before selecting an approach;
3. a second opinion after two repeated failures;
4. five focused review passes after implementation;
5. validation of each high-severity finding before repair;
6. a final completion challenge against acceptance criteria.

Do not spend credits asking multiple models for interchangeable summaries. Give each pass a different hypothesis, scope, or falsification target.

## Review evidence format

For each lens, record the reviewer identity or pass label, verdict, uncertainty, and only high-confidence findings. Each finding needs severity, confidence, precise evidence, status, and resolution. A review narrative without repository evidence does not count.

## Recovery discipline

After two identical failures, preserve the current diff and checkpoint, write a new hypothesis, and change one variable at a time. Distinguish source defects from environment, provider, editor, and MCP failures. Resume from the last good fingerprint rather than rebuilding from chat memory.
