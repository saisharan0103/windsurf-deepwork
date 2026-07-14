import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { initializeGitRepository, temporaryWorkspace } from "./helpers.js";

function decode(result) {
  const text = result.content?.find((item) => item.type === "text")?.text;
  assert.equal(typeof text, "string", "MCP tool did not return text content");
  return JSON.parse(text);
}

test("stdio server rooted at its runtime completes a task in a separate project", { timeout: 30_000 }, async (t) => {
  const runtimeRoot = process.env.DEEPWORK_SMOKE_RUNTIME_ROOT
    ? path.resolve(process.env.DEEPWORK_SMOKE_RUNTIME_ROOT)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const cli = path.join(runtimeRoot, "src", "cli.js");
  const project = await temporaryWorkspace(t, "deepwork-stdio-project-");
  const stateHome = await temporaryWorkspace(t, "deepwork-stdio-state-");
  await fs.writeFile(path.join(project, "smoke.test.js"), [
    'import test from "node:test";',
    'test("stdio fixture", () => {});',
    ""
  ].join("\n"));
  initializeGitRepository(project);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "server", "--workspace", runtimeRoot],
    cwd: runtimeRoot,
    env: { ...getDefaultEnvironment(), DEEPWORK_STATE_HOME: stateHome },
    stderr: "pipe"
  });
  const client = new Client({ name: "deepwork-stdio-task-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  t.after(async () => { await client.close().catch(() => {}); });

  const taskId = "stdio-external-project";
  assert.equal(decode(await client.callTool({
    name: "task_begin",
    arguments: {
      taskId,
      workspaceRoot: project,
      objective: "Verify a project outside the installed runtime",
      acceptanceCriteria: ["Fixture tests pass"]
    }
  })).ok, true);
  assert.equal(decode(await client.callTool({ name: "inspect_repository", arguments: { taskId, workspaceRoot: project } })).ok, true);
  assert.equal(decode(await client.callTool({
    name: "record_plan",
    arguments: {
      taskId,
      steps: [{ description: "Run the fixture test without editing" }],
      filesToChange: [],
      verificationCommands: ["node --test"]
    }
  })).ok, true);
  assert.equal(decode(await client.callTool({ name: "run_verification", arguments: { taskId, command: "node --test" } })).ok, true);
  const gate = decode(await client.callTool({
    name: "final_gate",
    arguments: {
      taskId,
      acceptanceEvidence: [{ criterion: "Fixture tests pass", kind: "command", evidence: "node --test exited zero for the committed fixture" }],
      diffSummary: "Review-only verification left the committed fixture unchanged."
    }
  }));
  assert.equal(gate.decision, "PASS", gate.failures?.join("; "));
});
