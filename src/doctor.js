import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { canonicalWorkspaceRoot, guardWorkspacePath } from "./security/path-guard.js";
import { safeError } from "./audit/redact.js";
import { WorkspaceStateStore } from "./state/store.js";
import { handleHook } from "./hooks.js";

const CLI_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.js");

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function stateAndHookSelfTest(root, stateHome) {
  const store = new WorkspaceStateStore(root, { stateHome });
  const taskId = `doctor-${randomUUID()}`;
  await store.appendTaskEvent(taskId, "TASK_BEGUN", {
    taskId,
    objective: "Doctor state round-trip",
    acceptanceCriteria: ["State can be written and read"],
    workspaceRoot: root
  });
  const events = await store.readTaskEvents(taskId);
  if (events.length !== 1 || events[0].taskId !== taskId) throw new Error("state round-trip returned unexpected data");
  const hook = await handleHook({
    phase: "pre_run_command",
    cwd: root,
    env: { ...getDefaultEnvironment(), DEEPWORK_STATE_HOME: stateHome },
    payload: {
      agent_action_name: "pre_run_command",
      trajectory_id: `doctor-${randomUUID()}`,
      tool_info: { cwd: root, command_line: "rm -rf doctor-must-block" }
    }
  });
  if (hook.allowed || hook.exitCode !== 2) throw new Error("official-shape pre-hook did not fail closed");
}

async function mcpSelfTest(root, stateHome) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI_PATH, "server", "--workspace", root],
    cwd: root,
    env: { ...getDefaultEnvironment(), DEEPWORK_STATE_HOME: stateHome },
    stderr: "pipe"
  });
  const client = new Client({ name: "deepwork-doctor", version: "0.2.0" }, { capabilities: {} });
  try {
    await withTimeout(client.connect(transport), 5_000, "MCP initialize");
    const listed = await withTimeout(client.listTools(), 5_000, "MCP listTools");
    const names = (listed.tools || []).map((tool) => tool.name).sort();
    const expected = ["final_gate", "inspect_repository", "record_checkpoint", "record_design", "record_plan", "record_research", "record_review", "run_verification", "task_begin", "task_status"];
    if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error(`unexpected MCP tools: ${names.join(", ")}`);
  } finally {
    await withTimeout(client.close(), 3_000, "MCP close").catch(() => transport.close().catch(() => {}));
  }
}

function commandCheck(command, args = ["--version"]) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, shell: false, timeout: 5_000 });
  return {
    ok: result.status === 0,
    version: result.status === 0 ? String(result.stdout || result.stderr).trim().split(/\r?\n/)[0].slice(0, 200) : null
  };
}

export async function runDoctor({ workspaceRoot } = {}) {
  const checks = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({ name: "node", ok: nodeMajor >= 22, required: true, detail: process.version });
  for (const dependency of ["@modelcontextprotocol/sdk", "zod"]) {
    try {
      checks.push({ name: dependency, ok: Boolean(import.meta.resolve(dependency)), required: true, detail: "resolvable" });
    } catch {
      checks.push({ name: dependency, ok: false, required: true, detail: "not resolvable" });
    }
  }
  let root = null;
  let temporaryState = null;
  try {
    root = await canonicalWorkspaceRoot(workspaceRoot || process.env.DEEPWORK_WORKSPACE || process.cwd());
    await fs.access(root, fsConstants.R_OK | fsConstants.W_OK);
    await guardWorkspacePath(root, ".", { allowProtected: true, mustExist: true });
    checks.push({ name: "workspace", ok: true, required: true, detail: root });
  } catch (error) {
    checks.push({ name: "workspace", ok: false, required: true, detail: safeError(error).message });
  }
  if (root) {
    try {
      temporaryState = await fs.mkdtemp(path.join(os.tmpdir(), "deepwork-doctor-"));
      await stateAndHookSelfTest(root, temporaryState);
      checks.push({ name: "state-and-hook", ok: true, required: true, detail: "global state round-trip and official pre-hook block passed" });
    } catch (error) {
      checks.push({ name: "state-and-hook", ok: false, required: true, detail: safeError(error).message });
    }
    try {
      if (!temporaryState) temporaryState = await fs.mkdtemp(path.join(os.tmpdir(), "deepwork-doctor-"));
      await mcpSelfTest(root, temporaryState);
      checks.push({ name: "mcp-stdio", ok: true, required: true, detail: "initialize, listTools, and close passed" });
    } catch (error) {
      checks.push({ name: "mcp-stdio", ok: false, required: true, detail: safeError(error).message });
    } finally {
      if (temporaryState) await fs.rm(temporaryState, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    }
  }
  const rg = commandCheck("rg");
  checks.push({ name: "ripgrep", ok: rg.ok, required: false, detail: rg.version || "not found; filesystem fallback will be used" });
  const git = commandCheck("git");
  checks.push({ name: "git", ok: git.ok, required: false, detail: git.version || "not found; VCS metadata will be omitted" });
  return {
    ok: checks.filter((check) => check.required).every((check) => check.ok),
    workspaceRoot: root,
    checks
  };
}
