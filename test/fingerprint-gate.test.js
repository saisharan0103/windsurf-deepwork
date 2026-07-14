import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { DeepworkEngine } from "../src/core.js";
import { createWorkspaceFingerprint } from "../src/fingerprint.js";
import { initializeGitRepository, temporaryWorkspace } from "./helpers.js";

const acceptanceEvidence = [
  { criterion: "Verification is trustworthy", kind: "command", evidence: "Every planned verification command passed against the current fingerprint." }
];

async function createPlannedTask(t, options = {}) {
  const root = await temporaryWorkspace(t, options.prefix || "deepwork-fingerprint-");
  await fs.writeFile(path.join(root, "package.json"), `${JSON.stringify({
    name: "fingerprint-fixture",
    private: true,
    type: "module",
    scripts: { test: "node --test" }
  })}\n`);
  await fs.writeFile(path.join(root, "source.js"), "export const value = 1;\n");
  initializeGitRepository(root);
  const engine = await DeepworkEngine.create({ baseRoot: root });
  const taskId = options.taskId || "fingerprint-task";
  await engine.taskBegin({
    taskId,
    objective: "Verify the current workspace state",
    acceptanceCriteria: ["Verification is trustworthy"],
    workspaceRoot: root
  });
  await engine.inspectRepository({ taskId, workspaceRoot: root });
  await engine.recordPlan({
    taskId,
    steps: [{ id: "verify", description: "Run every planned verification against stable content" }],
    filesToChange: ["source.js"],
    verificationCommands: options.verificationCommands || ["node --test"]
  });
  return { root, engine, taskId };
}

async function gate(engine, taskId) {
  return engine.finalGate({
    taskId,
    acceptanceEvidence,
    diffSummary: "Verified the complete current fixture workspace state."
  });
}

test("task_begin requires an explicit workspace root", async (t) => {
  const root = await temporaryWorkspace(t);
  const engine = await DeepworkEngine.create({ baseRoot: root });
  await assert.rejects(
    engine.taskBegin({
      taskId: "missing-root",
      objective: "Reject an implicit workspace",
      acceptanceCriteria: ["Workspace is explicit"]
    }),
    (error) => error?.code === "INVALID_WORKSPACE" && /explicit workspaceRoot/.test(error.message)
  );
});

test("task_begin requires an explicit task id for trajectory binding", async (t) => {
  const root = await temporaryWorkspace(t);
  const engine = await DeepworkEngine.create({ baseRoot: root });
  await assert.rejects(
    engine.taskBegin({
      objective: "Reject an implicit task identity",
      acceptanceCriteria: ["Task identity is explicit"],
      workspaceRoot: root
    }),
    (error) => error?.code === "INVALID_TASK_ID" && /explicit safe taskId/.test(error.message)
  );
});

test("task_begin rejects the installed runtime as a user workspace", async (t) => {
  const root = await temporaryWorkspace(t, "deepwork-runtime-fixture-");
  const previous = process.env.DEEPWORK_RUNTIME_ROOT;
  process.env.DEEPWORK_RUNTIME_ROOT = root;
  t.after(() => {
    if (previous === undefined) delete process.env.DEEPWORK_RUNTIME_ROOT;
    else process.env.DEEPWORK_RUNTIME_ROOT = previous;
  });
  const engine = await DeepworkEngine.create({ baseRoot: root });
  await assert.rejects(
    engine.taskBegin({
      taskId: "runtime-root",
      objective: "Reject the runtime root",
      acceptanceCriteria: ["Runtime is rejected"],
      workspaceRoot: root
    }),
    (error) => error?.code === "INVALID_WORKSPACE" && /runtime/.test(error.message)
  );
});

test("a same-file content change after verification invalidates final_gate", async (t) => {
  const { root, engine, taskId } = await createPlannedTask(t, { taskId: "same-file" });
  assert.equal((await engine.runVerification({ taskId, command: "node --test" })).ok, true);
  await fs.writeFile(path.join(root, "source.js"), "export const value = 2;\n");
  const result = await gate(engine, taskId);
  assert.equal(result.decision, "REFUSE");
  assert.match(result.failures.join(" "), /workspace changed after planned verification/);
});

test("new untracked content after verification invalidates final_gate", async (t) => {
  const { root, engine, taskId } = await createPlannedTask(t, { taskId: "untracked-file" });
  assert.equal((await engine.runVerification({ taskId, command: "node --test" })).ok, true);
  await fs.writeFile(path.join(root, "untracked.txt"), "new untracked content\n");
  const result = await gate(engine, taskId);
  assert.equal(result.decision, "REFUSE");
  assert.match(result.failures.join(" "), /workspace changed after planned verification/);
});

test("final_gate rejects actual changed paths outside the current plan", async (t) => {
  const { root, engine, taskId } = await createPlannedTask(t, { taskId: "out-of-plan" });
  await fs.writeFile(path.join(root, "outside.js"), "export const outside = true;\n");
  assert.equal((await engine.runVerification({ taskId, command: "node --test" })).ok, true);
  const result = await gate(engine, taskId);
  assert.equal(result.decision, "REFUSE");
  assert.match(result.failures.join(" "), /actual diff violates current plan/);
});

test("final_gate requires the latest run of every normalized planned command", async (t) => {
  const { engine, taskId } = await createPlannedTask(t, {
    taskId: "all-planned",
    verificationCommands: ["node --test", "npm test"]
  });
  assert.equal((await engine.runVerification({ taskId, command: "node --test" })).ok, true);
  const missing = await gate(engine, taskId);
  assert.equal(missing.decision, "REFUSE");
  assert.match(missing.failures.join(" "), /npm test/);

  assert.equal((await engine.runVerification({ taskId, command: "npm test", timeoutMs: 30_000 })).ok, true);
  assert.equal((await gate(engine, taskId)).decision, "PASS");
});

test("a passing command cannot mask another planned command's latest failure", async (t) => {
  const root = await temporaryWorkspace(t, "deepwork-required-command-");
  await fs.writeFile(path.join(root, "package.json"), "{\"type\":\"module\"}\n");
  await fs.writeFile(path.join(root, "required.test.js"), "import test from 'node:test'; import assert from 'node:assert/strict'; test('required', () => assert.equal(1, 2));\n");
  await fs.writeFile(path.join(root, "passing.test.js"), "import test from 'node:test'; test('passing', () => {});\n");
  initializeGitRepository(root);
  const engine = await DeepworkEngine.create({ baseRoot: root });
  const taskId = "failed-required";
  await engine.taskBegin({ taskId, objective: "Run all planned tests", acceptanceCriteria: ["Verification is trustworthy"], workspaceRoot: root });
  await engine.inspectRepository({ taskId, workspaceRoot: root });
  await engine.recordPlan({
    taskId,
    steps: [{ description: "Run required and passing test commands" }],
    filesToChange: ["required.test.js"],
    verificationCommands: ["node --test required.test.js", "node --test passing.test.js"]
  });
  assert.equal((await engine.runVerification({ taskId, command: "node --test required.test.js" })).ok, false);
  assert.equal((await engine.runVerification({ taskId, command: "node --test passing.test.js" })).ok, true);
  const result = await gate(engine, taskId);
  assert.equal(result.decision, "REFUSE");
  assert.match(result.failures.join(" "), /required\.test\.js/);
});

test("run_verification rejects commands outside the current normalized plan", async (t) => {
  const { engine, taskId } = await createPlannedTask(t, { taskId: "not-planned" });
  await assert.rejects(
    engine.runVerification({ taskId, command: "npm test" }),
    (error) => error?.code === "COMMAND_NOT_PLANNED"
  );
});

test("a verification command that mutates source fails despite exiting zero", async (t) => {
  const root = await temporaryWorkspace(t, "deepwork-mutating-command-");
  await fs.writeFile(path.join(root, "package.json"), "{\"type\":\"module\"}\n");
  await fs.writeFile(path.join(root, "source.js"), "export const value = 1;\n");
  await fs.writeFile(path.join(root, "mutate.test.js"), [
    "import test from 'node:test';",
    "import fs from 'node:fs';",
    "import { fileURLToPath } from 'node:url';",
    "test('mutates', () => fs.writeFileSync(fileURLToPath(new URL('./source.js', import.meta.url)), 'export const value = 2;\\n'));"
  ].join("\n"));
  initializeGitRepository(root);
  const engine = await DeepworkEngine.create({ baseRoot: root });
  const taskId = "mutating-command";
  await engine.taskBegin({ taskId, objective: "Detect test mutations", acceptanceCriteria: ["Verification is trustworthy"], workspaceRoot: root });
  await engine.inspectRepository({ taskId, workspaceRoot: root });
  await engine.recordPlan({
    taskId,
    steps: [{ description: "Run the mutating test" }],
    filesToChange: ["source.js"],
    verificationCommands: ["node --test mutate.test.js"]
  });
  const verification = await engine.runVerification({ taskId, command: "node --test mutate.test.js" });
  assert.equal(verification.result.commandPassed, true, verification.result.stderr);
  assert.equal(verification.result.workspaceMutationDetected, true);
  assert.equal(verification.ok, false);
  const result = await gate(engine, taskId);
  assert.equal(result.decision, "REFUSE");
  assert.match(result.failures.join(" "), /mutated fingerprinted workspace state/);
});

test("bounded fingerprinting rejects an incomplete oversized tree", async (t) => {
  const root = await temporaryWorkspace(t, "deepwork-fingerprint-bound-");
  await fs.writeFile(path.join(root, "large.txt"), "12345");
  await assert.rejects(
    createWorkspaceFingerprint(root, { maxFileBytes: 4 }),
    (error) => error?.code === "FINGERPRINT_LIMIT"
  );
});
