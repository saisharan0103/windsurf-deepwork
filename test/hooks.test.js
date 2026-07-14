import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { handleHook } from "../src/hooks.js";
import { DeepworkEngine } from "../src/core.js";
import { WorkspaceStateStore } from "../src/state/store.js";
import { temporaryWorkspace } from "./helpers.js";

async function bindTrajectory(root, trajectoryId, taskId) {
  const store = new WorkspaceStateStore(root);
  await store.appendHookEvent(trajectoryId, "MCP_TASK_BOUND", { taskId });
}

test("pre_write blocks until begin, inspection, and plan are present", async (t) => {
  const root = await temporaryWorkspace(t);
  const blocked = await handleHook({ phase: "pre_write", cwd: root, payload: { cwd: root, path: "src/new.js" } });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.exitCode, 2);
  assert.match(blocked.message, /task_begin/);
});

test("pre_run blocks risky commands and trips the persistent trajectory circuit breaker", async (t) => {
  const root = await temporaryWorkspace(t);
  const risky = await handleHook({ phase: "pre_run", cwd: root, payload: { cwd: root, trajectoryId: "t-risk", command: "git reset --hard" } });
  assert.equal(risky.allowed, false);
  for (let index = 1; index <= 2; index++) {
    const attempt = await handleHook({ phase: "pre_run", cwd: root, payload: { cwd: root, trajectoryId: "t-repeat", executionId: "run-1", command: "git status --short" } });
    assert.equal(attempt.allowed, true);
    assert.equal(attempt.data.attempt, index);
  }
  const third = await handleHook({ phase: "pre_run", cwd: root, payload: { cwd: root, trajectoryId: "t-repeat", executionId: "run-1", command: " git   status   --short " } });
  assert.equal(third.allowed, false);
  assert.match(third.message, /already ran twice/);
});

test("pre_mcp protects Windsurf and Devin control configuration", async (t) => {
  const root = await temporaryWorkspace(t);
  const blocked = await handleHook({
    phase: "pre_mcp",
    cwd: root,
    payload: { cwd: root, trajectoryId: "mcp-1", server: "filesystem", tool: "write_file", args: { path: ".windsurf/hooks.json" } }
  });
  assert.equal(blocked.allowed, false);
  const allowed = await handleHook({
    phase: "pre_mcp",
    cwd: root,
    payload: { cwd: root, trajectoryId: "mcp-1", server: "deepwork", tool: "task_begin", args: { taskId: "mcp-task", workspaceRoot: root } }
  });
  assert.equal(allowed.allowed, true);
  const readBlocked = await handleHook({
    phase: "pre_mcp",
    cwd: root,
    payload: { cwd: root, trajectoryId: "mcp-2", server: "filesystem", tool: "read_file", args: { path: ".devin/rules.md" } }
  });
  assert.equal(readBlocked.allowed, false);
  const explicitlyAllowed = await handleHook({
    phase: "pre_mcp",
    cwd: root,
    env: { ...process.env, DEEPWORK_ALLOWED_MCP_TOOLS: "filesystem/read_file" },
    payload: { cwd: root, trajectoryId: "mcp-3", server: "filesystem", tool: "read_file", args: { path: "README.md" } }
  });
  assert.equal(explicitlyAllowed.allowed, true, explicitlyAllowed.message);
});

test("post_response emits JSON and Markdown audit metadata without transcript secrets", async (t) => {
  const root = await temporaryWorkspace(t);
  const result = await handleHook({
    phase: "post_response",
    cwd: root,
    payload: {
      cwd: root,
      trajectoryId: "audit-1",
      response: "Here is api_key=supersecretvalue and Bearer abcdefghijklmnop",
      token: "another-secret-value",
      messages: [{ role: "assistant", content: "private content" }]
    }
  });
  assert.equal(result.allowed, true);
  const json = await fs.readFile(result.data.json, "utf8");
  const markdown = await fs.readFile(result.data.markdown, "utf8");
  assert.doesNotMatch(json, /supersecretvalue|another-secret-value|private content|abcdefghijklmnop/);
  assert.match(markdown, /Transcript content is intentionally omitted/);
});

test("hook CLI exits 2 with a clear stderr message when blocking", async (t) => {
  const root = await temporaryWorkspace(t);
  const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/cli.js");
  const child = spawnSync(process.execPath, [cli, "hook", "pre_read"], {
    cwd: root,
    input: JSON.stringify({ cwd: root, path: "../escape.txt" }),
    encoding: "utf8",
    windowsHide: true
  });
  assert.equal(child.status, 2);
  assert.match(child.stderr, /Deepwork hook blocked: Path escapes the workspace/);
});

test("documented Windsurf agent_action_name and tool_info payloads are recognized", async (t) => {
  const root = await temporaryWorkspace(t);
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "future.js"), "export {};\n");
  const fakeHome = await temporaryWorkspace(t, "deepwork-home-");
  const transcripts = path.join(fakeHome, ".windsurf", "transcripts");
  await fs.mkdir(transcripts, { recursive: true });
  const transcript = path.join(transcripts, "official.jsonl");
  await fs.writeFile(transcript, [
    JSON.stringify({ status: "done", type: "user_input", user_input: { rules_applied: { always_on: ["deep-build"] }, user_response: "private prompt" } }),
    JSON.stringify({ status: "done", type: "code_action", code_action: { path: "src/future.js", new_content: "api_key=must-not-copy" } }),
    JSON.stringify({ type: "tool_result", exit_code: 0, tool_name: "read_file" })
  ].join("\n"));
  const read = await handleHook({
    cwd: root,
    payload: {
      agent_action_name: "pre_read_code",
      trajectory_id: "official-shape",
      execution_id: "official-read",
      tool_info: { cwd: root, file_path: path.join(root, "src", "future.js") }
    }
  });
  assert.equal(read.allowed, true, read.message);
  assert.equal(read.data.recorded, false);
  const completedRead = await handleHook({
    cwd: root,
    payload: {
      agent_action_name: "post_read_code",
      trajectory_id: "official-shape",
      execution_id: "official-read",
      tool_info: { cwd: root, file_path: path.join(root, "src", "future.js"), success: true }
    }
  });
  assert.equal(completedRead.data.recorded, true);

  const run = await handleHook({
    cwd: root,
    payload: {
      agent_action_name: "pre_run_command",
      trajectory_id: "official-shape",
      execution_id: "official-run",
      tool_info: { cwd: root, command_line: "git status --short" }
    }
  });
  assert.equal(run.allowed, true, run.message);

  const mcp = await handleHook({
    cwd: root,
    payload: {
      agent_action_name: "pre_mcp_tool_use",
      trajectory_id: "official-shape",
      tool_info: {
        cwd: root,
        mcp_server_name: "filesystem",
        mcp_tool_name: "write_file",
        mcp_tool_arguments: { path: ".devin/rules.md" }
      }
    }
  });
  assert.equal(mcp.allowed, false);

  const response = await handleHook({
    cwd: root,
    env: { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome },
    payload: {
      agent_action_name: "post_cascade_response_with_transcript",
      trajectory_id: "official-shape",
      tool_info: { cwd: root, transcript_path: transcript }
    }
  });
  assert.equal(response.allowed, true, response.message);
  assert.ok(response.data.json);
  const audit = await fs.readFile(response.data.json, "utf8");
  assert.match(audit, /code_action/);
  assert.match(audit, /deep-build/);
  assert.match(audit, /src\/future\.js/);
  assert.doesNotMatch(audit, /must-not-copy/);
});

test("writes require three successful unique reads while edit scope does not restrict dependency reads", async (t) => {
  const root = await temporaryWorkspace(t);
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  for (const name of ["a.js", "b.js", "c.js", "d.js"]) {
    await fs.writeFile(path.join(root, "src", name), `export const ${name[0]} = true;\n`);
  }
  await fs.writeFile(path.join(root, "dependency.js"), "export const dependency = true;\n");
  const engine = await DeepworkEngine.create({ baseRoot: root });
  await engine.taskBegin({
    taskId: "read-depth",
    objective: "Require repository reading before editing",
    acceptanceCriteria: ["Three files are inspected"],
    allowedPaths: ["src/**"],
    protectedPaths: ["src/d.js"],
    workspaceRoot: root
  });
  await engine.inspectRepository({ taskId: "read-depth" });
  await engine.recordPlan({
    taskId: "read-depth",
    steps: [{ id: "edit", description: "Read dependencies and edit the target" }],
    filesToChange: ["src/out.js"],
    verificationCommands: ["node --test"]
  });
  await bindTrajectory(root, "depth-trajectory", "read-depth");

  const dependencyRead = await handleHook({
    phase: "pre_read_code",
    cwd: root,
    payload: { cwd: root, trajectoryId: "depth-trajectory", path: "dependency.js" }
  });
  assert.equal(dependencyRead.allowed, true, dependencyRead.message);
  const outsideWrite = await handleHook({
    phase: "pre_write_code",
    cwd: root,
    payload: { cwd: root, trajectoryId: "depth-trajectory", path: "dependency.js" }
  });
  assert.equal(outsideWrite.allowed, false);
  assert.match(outsideWrite.message, /allowedPaths/);
  const protectedRead = await handleHook({
    phase: "pre_read_code",
    cwd: root,
    payload: { cwd: root, trajectoryId: "depth-trajectory", path: "src/d.js" }
  });
  assert.equal(protectedRead.allowed, false);

  const unsuccessful = await handleHook({
    phase: "post_read_code",
    cwd: root,
    payload: { cwd: root, trajectoryId: "depth-trajectory", path: "src/a.js", success: false }
  });
  assert.equal(unsuccessful.data.recorded, false);
  const tooSoon = await handleHook({
    phase: "pre_write_code",
    cwd: root,
    payload: { cwd: root, trajectoryId: "depth-trajectory", path: "src/out.js" }
  });
  assert.equal(tooSoon.allowed, false);
  assert.match(tooSoon.message, /at least 3 unique/);

  for (const name of ["a.js", "b.js", "c.js"]) {
    const read = await handleHook({
      phase: "post_read_code",
      cwd: root,
      payload: { cwd: root, trajectoryId: "depth-trajectory", path: `src/${name}`, success: true }
    });
    assert.equal(read.data.recorded, true);
  }
  const outsidePlan = await handleHook({
    phase: "pre_write_code",
    cwd: root,
    payload: { cwd: root, trajectoryId: "depth-trajectory", path: "src/a.js" }
  });
  assert.equal(outsidePlan.allowed, false);
  assert.match(outsidePlan.message, /Current plan scope/);
  const ready = await handleHook({
    phase: "pre_write_code",
    cwd: root,
    payload: { cwd: root, trajectoryId: "depth-trajectory", path: "src/out.js" }
  });
  assert.equal(ready.allowed, true, ready.message);
});

test("trajectory binding isolates task evidence and denies unknown MCP during a task", async (t) => {
  const root = await temporaryWorkspace(t);
  await fs.writeFile(path.join(root, "target.js"), "export const value = 1;\n");
  const engine = await DeepworkEngine.create({ baseRoot: root });
  await engine.taskBegin({
    taskId: "bound-task",
    objective: "Change only the bound target",
    acceptanceCriteria: ["Target is changed"],
    allowedPaths: ["target.js"],
    workspaceRoot: root
  });
  await engine.inspectRepository({ taskId: "bound-task", workspaceRoot: root });
  await engine.recordPlan({
    taskId: "bound-task",
    steps: [{ description: "Change and verify target" }],
    filesToChange: ["target.js"],
    verificationCommands: ["node --test"]
  });
  await bindTrajectory(root, "owner", "bound-task");
  await handleHook({ phase: "post_read", cwd: root, payload: { cwd: root, trajectoryId: "owner", path: "target.js", success: true } });

  const owner = await handleHook({ phase: "pre_write", cwd: root, payload: { cwd: root, trajectoryId: "owner", path: "target.js" } });
  assert.equal(owner.allowed, true, owner.message);
  const stranger = await handleHook({ phase: "pre_write", cwd: root, payload: { cwd: root, trajectoryId: "stranger", path: "target.js" } });
  assert.equal(stranger.allowed, false);
  const mcp = await handleHook({
    phase: "pre_mcp", cwd: root,
    payload: { cwd: root, trajectoryId: "owner", server: "filesystem", tool: "write_file", args: { path: "target.js" } }
  });
  assert.equal(mcp.allowed, false);
  assert.match(mcp.message, /not explicitly allowlisted/);
});

test("official pre/post MCP hooks bind a successful task_begin to its trajectory", async (t) => {
  const root = await temporaryWorkspace(t);
  const payloadBase = {
    trajectory_id: "official-binding",
    tool_info: {
      cwd: root,
      mcp_server_name: "deepwork",
      mcp_tool_name: "task_begin",
      mcp_tool_arguments: { taskId: "official-task", workspaceRoot: root }
    }
  };
  const pending = await handleHook({ cwd: root, payload: { ...payloadBase, agent_action_name: "pre_mcp_tool_use" } });
  assert.equal(pending.allowed, true, pending.message);
  const engine = await DeepworkEngine.create({ baseRoot: root });
  await engine.taskBegin({ taskId: "official-task", objective: "Bind this exact task", acceptanceCriteria: ["Binding succeeds"], workspaceRoot: root });
  const completed = await handleHook({ cwd: root, payload: { ...payloadBase, agent_action_name: "post_mcp_tool_use" } });
  assert.equal(completed.allowed, true, completed.message);
  const next = await handleHook({
    cwd: root,
    payload: {
      agent_action_name: "pre_mcp_tool_use",
      trajectory_id: "official-binding",
      tool_info: { cwd: root, mcp_server_name: "deepwork", mcp_tool_name: "inspect_repository", mcp_tool_arguments: { taskId: "official-task", workspaceRoot: root } }
    }
  });
  assert.equal(next.allowed, true, next.message);
  const crossTask = await handleHook({
    cwd: root,
    payload: {
      agent_action_name: "pre_mcp_tool_use",
      trajectory_id: "official-binding",
      tool_info: { cwd: root, mcp_server_name: "deepwork", mcp_tool_name: "task_status", mcp_tool_arguments: { taskId: "other-task" } }
    }
  });
  assert.equal(crossTask.allowed, false);
  assert.match(crossTask.message, /different trajectory binding/);
});

test("every successful repeated write is recorded", async (t) => {
  const root = await temporaryWorkspace(t);
  await fs.writeFile(path.join(root, "target.js"), "export const value = 1;\n");
  const engine = await DeepworkEngine.create({ baseRoot: root });
  await engine.taskBegin({ taskId: "repeat-write", objective: "Track every write", acceptanceCriteria: ["Writes are tracked"], workspaceRoot: root });
  await engine.inspectRepository({ taskId: "repeat-write", workspaceRoot: root });
  await engine.recordPlan({ taskId: "repeat-write", steps: [{ description: "Edit target" }], filesToChange: ["target.js"], verificationCommands: ["node --test"] });
  await bindTrajectory(root, "repeat-owner", "repeat-write");
  for (let index = 0; index < 2; index++) {
    const result = await handleHook({ phase: "post_write", cwd: root, payload: { cwd: root, trajectoryId: "repeat-owner", path: "target.js", success: true } });
    assert.equal(result.data.recorded, true);
  }
  const events = await new WorkspaceStateStore(root).readTaskEvents("repeat-write");
  assert.equal(events.filter((event) => event.type === "HOOK_WRITE").length, 2);
});

test("review-only plans accept an empty write set and block edits", async (t) => {
  const root = await temporaryWorkspace(t);
  await fs.writeFile(path.join(root, "review.js"), "export const review = true;\n");
  const engine = await DeepworkEngine.create({ baseRoot: root });
  await engine.taskBegin({ taskId: "review-only", objective: "Review without editing", acceptanceCriteria: ["No files change"], workspaceRoot: root });
  await engine.inspectRepository({ taskId: "review-only", workspaceRoot: root });
  await engine.recordPlan({ taskId: "review-only", steps: [{ description: "Inspect and report" }], filesToChange: [], verificationCommands: ["node --test"] });
  await bindTrajectory(root, "review-owner", "review-only");
  const result = await handleHook({ phase: "pre_write", cwd: root, payload: { cwd: root, trajectoryId: "review-owner", path: "review.js" } });
  assert.equal(result.allowed, false);
  assert.match(result.message, /review-only/);
});

test("pre-hook state failures exit 2 instead of failing open", async (t) => {
  const root = await temporaryWorkspace(t);
  const badStateHome = path.join(root, "state-is-a-file");
  await fs.writeFile(badStateHome, "not a directory\n");
  const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/cli.js");
  const child = spawnSync(process.execPath, [cli, "hook", "pre_run_command"], {
    cwd: root,
    env: { ...process.env, DEEPWORK_STATE_HOME: badStateHome },
    input: JSON.stringify({ agent_action_name: "pre_run_command", trajectory_id: "fail-closed", tool_info: { cwd: root, command_line: "rm -rf important" } }),
    encoding: "utf8",
    windowsHide: true
  });
  assert.equal(child.status, 2, child.stderr);
});
