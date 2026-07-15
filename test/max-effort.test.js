import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { DeepworkEngine } from "../src/core.js";
import { initializeGitRepository, temporaryWorkspace } from "./helpers.js";

const stepIds = Array.from({ length: 8 }, (_, index) => `p${index + 1}`);
const verificationCommand = "node --test";

function researchLanes() {
  return [
    { id: "flow", focus: "Trace runtime control flow", findings: ["The entry point delegates to the core module."], keyFiles: ["src.js"] },
    { id: "tests", focus: "Map verification and regression coverage", findings: ["The fixture has a dedicated smoke test."], keyFiles: ["test/smoke.test.js"] },
    { id: "boundaries", focus: "Inspect configuration and scope boundaries", findings: ["The package manifest defines the runtime boundary."], keyFiles: ["package.json"] }
  ];
}

function designs() {
  return [
    { id: "minimal", title: "Minimal extension", summary: "Extend the existing entry point without adding a new layer.", tradeoffs: ["Small diff", "Tighter coupling"], files: ["src.js"] },
    { id: "modular", title: "Dedicated module", summary: "Introduce a focused module and preserve a thin entry point.", tradeoffs: ["Clear boundary", "One extra file"], files: ["src.js"] },
    { id: "adapter", title: "Adapter boundary", summary: "Add an adapter that isolates the behavior behind an explicit interface.", tradeoffs: ["Testable seam", "More structure"], files: ["src.js"] }
  ];
}

function planInput(taskId) {
  return {
    taskId,
    steps: stepIds.map((id, index) => ({ id, description: `Complete max-effort engineering phase ${index + 1}`, status: index === 0 ? "in_progress" : "pending" })),
    risks: ["A regression could escape focused coverage", "The design could exceed the approved scope", "Verification could pass against stale files"],
    filesToChange: ["src.js"],
    verificationCommands: [verificationCommand],
    acceptanceMap: [
      { criterion: "Behavior is verified", stepIds: ["p7"], verificationCommands: [verificationCommand] },
      { criterion: "Scope remains bounded", stepIds: ["p8"] }
    ],
    rollbackPlan: "Restore src.js from the Git baseline and rerun the complete verification command."
  };
}

function passingReviews(overrides = {}) {
  return ["correctness", "tests", "security", "error-handling", "simplicity"].map((focus) => ({
    focus,
    reviewer: `independent-${focus}-pass`,
    verdict: "pass",
    findings: [],
    uncertainties: [],
    ...overrides[focus]
  }));
}

async function beginMaxTask(t, taskId = "max-task") {
  const root = await temporaryWorkspace(t, "deepwork-max-");
  await fs.mkdir(path.join(root, "test"));
  await fs.writeFile(path.join(root, "package.json"), '{"name":"max-fixture","type":"module"}\n');
  await fs.writeFile(path.join(root, "src.js"), "export const value = 1;\n");
  await fs.writeFile(path.join(root, "test", "smoke.test.js"), 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { value } from "../src.js";\ntest("value",()=>assert.equal(value,1));\n');
  initializeGitRepository(root);
  const engine = await DeepworkEngine.create({ baseRoot: root });
  await engine.taskBegin({
    taskId,
    objective: "Complete a deliberately high-effort verified fixture task",
    acceptanceCriteria: ["Behavior is verified", "Scope remains bounded"],
    completionCondition: "node --test exits zero and no path outside src.js changes",
    effortProfile: "max",
    allowedPaths: ["src.js"],
    workspaceRoot: root
  });
  await engine.inspectRepository({ taskId, workspaceRoot: root });
  return { root, engine, taskId };
}

async function prepareMaxPlan(t, taskId = "max-plan") {
  const fixture = await beginMaxTask(t, taskId);
  await fixture.engine.recordResearch({ taskId, lanes: researchLanes(), contradictions: [], openQuestions: [] });
  await fixture.engine.recordDesign({
    taskId,
    alternatives: designs(),
    selectedId: "modular",
    selectionRationale: "The modular design creates a testable seam while remaining inside the approved file scope.",
    approvalEvidence: "The user explicitly authorized implementation and delegated the architecture choice.",
    resolvedQuestions: ["The existing module format remains unchanged."],
    unresolvedQuestions: []
  });
  await fixture.engine.recordPlan(planInput(taskId));
  for (const relativePath of ["package.json", "src.js", "test/smoke.test.js"]) {
    await fixture.engine.appendTrackedPath(taskId, "HOOK_READ", relativePath, "test-max-effort");
  }
  return fixture;
}

async function completeMaxEvidence(fixture) {
  const { engine, taskId } = fixture;
  await engine.recordCheckpoint({
    taskId,
    label: "design-ready",
    summary: "Research and design are complete; implementation and verification remain.",
    completedStepIds: ["p1", "p2", "p3"],
    remainingStepIds: ["p4", "p5", "p6", "p7", "p8"]
  });
  const verification = await engine.runVerification({ taskId, command: verificationCommand, timeoutMs: 30_000 });
  assert.equal(verification.ok, true, verification.result?.stderr);
  await engine.recordCheckpoint({
    taskId,
    label: "completion-candidate",
    summary: "All planned phases and the repository-native verification command are complete.",
    completedStepIds: stepIds,
    remainingStepIds: []
  });
  await engine.recordReview({
    taskId,
    reviews: passingReviews(),
    summary: "Five independent review lenses found no high-confidence issue in the current fingerprint."
  });
}

const acceptanceEvidence = [
  { criterion: "Behavior is verified", kind: "command", evidence: "node --test exited successfully against the current workspace fingerprint." },
  { criterion: "Scope remains bounded", kind: "file", evidence: "Git reports no path outside the approved fixture scope." }
];

test("max effort refuses shallow research, design, and planning", async (t) => {
  const { engine, taskId } = await beginMaxTask(t, "max-depth");
  await assert.rejects(
    engine.recordResearch({ taskId, lanes: researchLanes().slice(0, 1) }),
    (error) => error.code === "INSUFFICIENT_EFFORT"
  );
  await engine.recordResearch({ taskId, lanes: researchLanes() });
  await assert.rejects(
    engine.recordDesign({
      taskId,
      alternatives: designs().slice(0, 1),
      selectedId: "minimal",
      selectionRationale: "This rationale is intentionally long enough for the gate.",
      approvalEvidence: "The user authorized this architecture decision explicitly."
    }),
    (error) => error.code === "INSUFFICIENT_EFFORT"
  );
  await engine.recordDesign({
    taskId,
    alternatives: designs(),
    selectedId: "minimal",
    selectionRationale: "The minimal design best matches the intentionally small fixture change.",
    approvalEvidence: "The user explicitly authorized implementation and delegated the architecture choice."
  });
  await assert.rejects(
    engine.recordPlan({ ...planInput(taskId), steps: planInput(taskId).steps.slice(0, 2) }),
    (error) => error.code === "INSUFFICIENT_EFFORT"
  );
});

test("max effort passes only after research, design, two checkpoints, five reviews, and verification", async (t) => {
  const fixture = await prepareMaxPlan(t, "max-complete");
  const premature = await fixture.engine.finalGate({ taskId: fixture.taskId, acceptanceEvidence, diffSummary: "Validated the complete max-effort fixture workflow." });
  assert.equal(premature.decision, "REFUSE");
  assert.match(premature.failures.join(" "), /checkpoint|review|verification/);

  await completeMaxEvidence(fixture);
  const passed = await fixture.engine.finalGate({ taskId: fixture.taskId, acceptanceEvidence, diffSummary: "Validated the complete max-effort fixture workflow." });
  assert.equal(passed.decision, "PASS", passed.failures.join("\n"));
  assert.equal(passed.effortProfile, "max");
  const status = await fixture.engine.taskStatus({ taskId: fixture.taskId });
  assert.equal(status.effortRequirements.researchLanes, 3);
  assert.equal(status.effortRequirements.reviewFoci.length, 5);
  assert.equal(status.state.stage, "passed");
});

test("max effort rejects low-confidence review noise", async (t) => {
  const fixture = await prepareMaxPlan(t, "max-confidence");
  const reviews = passingReviews({
    correctness: {
      reviewer: "correctness-reviewer",
      verdict: "issues",
      findings: [{ severity: "medium", confidence: 79, issue: "Possible problem", evidence: "Speculative evidence", status: "open" }]
    }
  });
  await assert.rejects(
    fixture.engine.recordReview({ taskId: fixture.taskId, reviews, summary: "This review contains a deliberately low-confidence report." }),
    (error) => error.code === "LOW_CONFIDENCE_FINDING"
  );
});

test("max effort final gate blocks an unresolved high-severity finding", async (t) => {
  const fixture = await prepareMaxPlan(t, "max-review-block");
  await completeMaxEvidence(fixture);
  const reviews = passingReviews({
    security: {
      reviewer: "independent-security-validator",
      verdict: "issues",
      findings: [{
        severity: "high",
        confidence: 95,
        issue: "Untrusted input reaches a protected operation",
        evidence: "The current review fixture intentionally records a validated security finding.",
        status: "open"
      }]
    }
  });
  await fixture.engine.recordReview({ taskId: fixture.taskId, reviews, summary: "The final security pass found one unresolved high-severity issue." });
  const blocked = await fixture.engine.finalGate({ taskId: fixture.taskId, acceptanceEvidence, diffSummary: "Validated the complete max-effort fixture workflow." });
  assert.equal(blocked.decision, "REFUSE");
  assert.match(blocked.failures.join(" "), /unresolved high security finding/);
});

test("max effort final gate requires repository read evidence", async (t) => {
  const fixture = await beginMaxTask(t, "max-read-evidence");
  await fixture.engine.recordResearch({ taskId: fixture.taskId, lanes: researchLanes() });
  await fixture.engine.recordDesign({
    taskId: fixture.taskId,
    alternatives: designs(),
    selectedId: "modular",
    selectionRationale: "The modular design creates a testable seam while remaining inside the approved file scope.",
    approvalEvidence: "The user explicitly authorized implementation and delegated the architecture choice."
  });
  await fixture.engine.recordPlan(planInput(fixture.taskId));
  await completeMaxEvidence(fixture);
  const blocked = await fixture.engine.finalGate({ taskId: fixture.taskId, acceptanceEvidence, diffSummary: "Validated all max-effort evidence except repository read tracking." });
  assert.equal(blocked.decision, "REFUSE");
  assert.match(blocked.failures.join(" "), /unique repository reads/);
});

test("max effort rejects two completion-only checkpoints", async (t) => {
  const fixture = await prepareMaxPlan(t, "max-checkpoint-progress");
  const verification = await fixture.engine.runVerification({ taskId: fixture.taskId, command: verificationCommand, timeoutMs: 30_000 });
  assert.equal(verification.ok, true, verification.result?.stderr);
  for (const label of ["completion-one", "completion-two"]) {
    await fixture.engine.recordCheckpoint({
      taskId: fixture.taskId,
      label,
      summary: "This deliberately completion-only checkpoint contains no intermediate recovery state.",
      completedStepIds: stepIds,
      remainingStepIds: []
    });
  }
  await fixture.engine.recordReview({
    taskId: fixture.taskId,
    reviews: passingReviews(),
    summary: "Five independent review lenses found no high-confidence issue in the current fingerprint."
  });
  const blocked = await fixture.engine.finalGate({ taskId: fixture.taskId, acceptanceEvidence, diffSummary: "Validated duplicate completion-only checkpoint rejection." });
  assert.equal(blocked.decision, "REFUSE");
  assert.match(blocked.failures.join(" "), /earlier checkpoint.*remaining plan work/);
});
