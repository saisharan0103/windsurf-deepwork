import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { DeepworkEngine } from "../src/core.js";
import { handleHook } from "../src/hooks.js";
import { initializeGitRepository, temporaryWorkspace } from "./helpers.js";
import { WorkspaceStateStore } from "../src/state/store.js";
import { canonicalWorkspaceRoot } from "../src/security/path-guard.js";

async function plannedTask(t, taskId = "task-1") {
  const root = await temporaryWorkspace(t);
  await fs.writeFile(path.join(root, "package.json"), '{"name":"fixture"}\n');
  initializeGitRepository(root);
  const engine = await DeepworkEngine.create({ baseRoot: root });
  await engine.taskBegin({
    taskId,
    objective: "Make a verified change",
    acceptanceCriteria: ["Tests pass", "Change is documented"],
    nonGoals: ["Do not publish or deploy"],
    constraints: ["Use only safe local verification commands"],
    allowedPaths: ["package.json", "changed.js"],
    protectedPaths: ["private/**"],
    assumptions: ["The fixture workspace is writable"],
    workspaceRoot: root
  });
  const inspection = await engine.inspectRepository({ taskId, workspaceRoot: root });
  assert.equal(inspection.inventory.fileInventory.sample.includes("package.json"), true);
  await engine.recordPlan({
    taskId,
    steps: [{ id: "inspect", description: "Implement and verify the requested change", status: "in_progress" }],
    risks: ["Regression risk"],
    filesToChange: ["changed.js"],
    verificationCommands: ["node --test"]
  });
  return { root, engine, taskId };
}

const acceptanceEvidence = [
  { criterion: "Tests pass", kind: "command", evidence: "The constrained test command exited successfully." },
  { criterion: "Change is documented", kind: "file", evidence: "The diff summary identifies the changed behavior." }
];

test("state transitions refuse a premature final gate and pass with complete evidence", async (t) => {
  const { engine, taskId } = await plannedTask(t);
  const refused = await engine.finalGate({ taskId, acceptanceEvidence, diffSummary: "Implemented the requested fixture behavior." });
  assert.equal(refused.decision, "REFUSE");
  assert.match(refused.failures.join(" "), /verification/);

  const verification = await engine.runVerification({ taskId, command: "node --test", timeoutMs: 30_000 });
  assert.equal(verification.ok, true, verification.result?.stderr);
  const passed = await engine.finalGate({ taskId, acceptanceEvidence, diffSummary: "Implemented the requested fixture behavior." });
  assert.equal(passed.decision, "PASS");
  assert.equal((await engine.taskStatus({ taskId })).state.stage, "passed");
});

test("a tracked write invalidates earlier verification until verification runs again", async (t) => {
  const { root, engine, taskId } = await plannedTask(t, "write-task");
  await engine.runVerification({ taskId, noTestsEvidence: "This fixture contains only metadata and has no executable behavior." });
  assert.equal((await engine.finalGate({ taskId, acceptanceEvidence, diffSummary: "Updated fixture metadata and documented the behavior." })).decision, "REFUSE");

  await new WorkspaceStateStore(await canonicalWorkspaceRoot(root)).appendHookEvent("trajectory-1", "MCP_TASK_BOUND", { taskId });
  const read = await handleHook({
    phase: "post_read_code",
    cwd: root,
    payload: { workspaceRoot: root, cwd: root, trajectoryId: "trajectory-1", path: "package.json", success: true }
  });
  assert.equal(read.data.recorded, true);

  const write = await handleHook({
    phase: "pre_write",
    cwd: root,
    payload: { workspaceRoot: root, cwd: root, trajectoryId: "trajectory-1", path: "changed.js" }
  });
  assert.equal(write.allowed, true, write.message);
  assert.equal(write.data.recorded, false);
  await fs.writeFile(path.join(root, "changed.js"), "export const changed = true;\n");
  const completedWrite = await handleHook({
    phase: "post_write_code",
    cwd: root,
    payload: { workspaceRoot: root, cwd: root, trajectoryId: "trajectory-1", path: "changed.js", success: true }
  });
  assert.equal(completedWrite.data.recorded, true);
  const invalidated = await engine.finalGate({ taskId, acceptanceEvidence, diffSummary: "Updated fixture metadata and documented the behavior." });
  assert.equal(invalidated.decision, "REFUSE");
  assert.match(invalidated.failures.join(" "), /current baseline/);

  await engine.runVerification({ taskId, noTestsEvidence: "The new file is a static fixture with no executable test surface." });
  assert.equal((await engine.finalGate({ taskId, acceptanceEvidence, diffSummary: "Updated fixture metadata and documented the behavior." })).decision, "REFUSE");
});

test("task root remains usable when the MCP server cwd differs from the chosen workspace", async (t) => {
  const base = await temporaryWorkspace(t, "deepwork-base-");
  const chosen = await temporaryWorkspace(t, "deepwork-chosen-");
  const engine = await DeepworkEngine.create({ baseRoot: base });
  await engine.taskBegin({
    taskId: "external-root",
    objective: "Inspect an explicitly selected workspace",
    acceptanceCriteria: ["Workspace is inspected"],
    workspaceRoot: chosen
  });
  await engine.inspectRepository({ taskId: "external-root" });
  const status = await engine.taskStatus({ taskId: "external-root" });
  assert.equal(status.state.workspaceRoot, await fs.realpath(chosen));
  assert.equal(status.state.stage, "inspected");
});
