import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDeepworkServer, TOOL_NAMES } from "../src/server.js";
import { runDoctor } from "../src/doctor.js";
import { temporaryWorkspace } from "./helpers.js";

test("MCP server identifies as deepwork and exposes exactly six tools", async (t) => {
  const root = await temporaryWorkspace(t);
  const { server } = await createDeepworkServer({ baseRoot: root });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "deepwork-test", version: "1.0.0" });
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  assert.equal(client.getServerVersion().name, "deepwork");
  const response = await client.listTools();
  assert.deepEqual(response.tools.map((tool) => tool.name), [...TOOL_NAMES]);
  assert.equal(response.tools.length, 6);
  const taskBegin = response.tools.find((tool) => tool.name === "task_begin");
  assert.ok(taskBegin.inputSchema.required.includes("workspaceRoot"));
  assert.ok(taskBegin.inputSchema.required.includes("taskId"));
  const verifier = response.tools.find((tool) => tool.name === "run_verification");
  assert.equal(verifier.annotations.readOnlyHint, false);
  assert.equal(verifier.annotations.destructiveHint, true);
  assert.equal(verifier.annotations.openWorldHint, true);
});

test("doctor reports required runtime, dependencies, and workspace", async (t) => {
  const root = await temporaryWorkspace(t);
  const report = await runDoctor({ workspaceRoot: root });
  assert.equal(report.ok, true);
  assert.equal(report.workspaceRoot, root);
  assert.equal(report.checks.find((check) => check.name === "node").ok, true);
  assert.equal(report.checks.find((check) => check.name === "@modelcontextprotocol/sdk").ok, true);
  assert.equal(report.checks.find((check) => check.name === "zod").ok, true);
  assert.equal(report.checks.find((check) => check.name === "state-and-hook").ok, true);
  assert.equal(report.checks.find((check) => check.name === "mcp-stdio").ok, true);
});
