import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { canonicalWorkspaceRoot, guardWorkspacePath, isWithin } from "./security/path-guard.js";
import { classifyHookCommand } from "./security/command-policy.js";
import { normalizeCommand } from "./security/circuit-breaker.js";
import { isAgentControlPath } from "./security/protected-paths.js";
import { WorkspaceStateStore } from "./state/store.js";
import { writeTranscriptAudit } from "./audit/transcript-audit.js";
import { TOOL_NAMES } from "./server.js";
import { contractPathViolation } from "./security/scope-policy.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function firstDefined(payload, paths) {
  for (const keys of paths) {
    let cursor = payload;
    for (const key of keys) cursor = cursor?.[key];
    if (cursor !== undefined && cursor !== null && cursor !== "") return cursor;
  }
  return undefined;
}

function getTrajectory(payload) {
  return String(firstDefined(payload, [
    ["trajectory_id"], ["trajectoryId"], ["execution_id"], ["executionId"],
    ["conversation_id"], ["conversationId"], ["session_id"], ["sessionId"]
  ]) || "default");
}

function getExecution(payload) {
  return String(firstDefined(payload, [["execution_id"], ["executionId"], ["run_id"], ["runId"]]) || getTrajectory(payload));
}

function getTarget(payload) {
  const target = firstDefined(payload, [
    ["file_path"], ["filePath"], ["path"], ["target"],
    ["tool_info", "file_path"], ["tool_info", "filePath"], ["tool_info", "path"],
    ["tool_input", "file_path"], ["tool_input", "filePath"], ["tool_input", "path"], ["tool_input", "target"],
    ["input", "file_path"], ["input", "path"], ["args", "file_path"], ["args", "path"]
  ]);
  return typeof target === "string" ? target : undefined;
}

function getCommand(payload) {
  const command = firstDefined(payload, [
    ["command"], ["cmd"], ["tool_input", "command"], ["tool_input", "cmd"],
    ["tool_info", "command_line"], ["tool_info", "commandLine"], ["tool_info", "command"],
    ["input", "command"], ["args", "command"]
  ]);
  return typeof command === "string" ? command : undefined;
}

function normalizePhase(value) {
  const phase = String(value || "").trim().replace(/([a-z])([A-Z])/g, "$1_$2").replace(/[\s.-]+/g, "_").toLowerCase();
  const aliases = {
    before_read: "pre_read",
    pre_read_code: "pre_read",
    post_read_code: "post_read",
    before_write: "pre_write",
    pre_write_code: "pre_write",
    post_write_code: "post_write",
    before_run: "pre_run",
    pre_run_command: "pre_run",
    post_run_command: "post_run",
    before_mcp: "pre_mcp",
    pre_mcp_tool_use: "pre_mcp",
    post_mcp_tool_use: "post_mcp",
    after_response: "post_response",
    post_model_response: "post_response",
    post_cascade_response: "post_response",
    post_cascade_response_with_transcript: "post_response"
  };
  return aliases[phase] || phase;
}

function hookSucceeded(payload) {
  const success = firstDefined(payload, [["success"], ["tool_info", "success"], ["result", "success"]]);
  if (success === false) return false;
  const isError = firstDefined(payload, [["isError"], ["is_error"], ["tool_info", "isError"], ["result", "isError"]]);
  if (isError === true) return false;
  const error = firstDefined(payload, [["error"], ["tool_info", "error"], ["result", "error"]]);
  if (error) return false;
  const status = String(firstDefined(payload, [["status"], ["tool_info", "status"], ["result", "status"]]) || "").toLowerCase();
  if (["failed", "failure", "error", "cancelled", "canceled", "blocked"].includes(status)) return false;
  const exitCode = firstDefined(payload, [["exit_code"], ["exitCode"], ["tool_info", "exit_code"], ["tool_info", "exitCode"]]);
  if (exitCode !== undefined && Number(exitCode) !== 0) return false;
  return true;
}

async function boundTaskState(store, trajectoryId) {
  const taskId = await store.getTrajectoryTask(trajectoryId);
  if (!taskId) return null;
  return store.getTaskState(taskId);
}

function mcpDetails(payload) {
  const server = String(firstDefined(payload, [
    ["server"], ["server_name"], ["serverName"], ["mcp_server"], ["mcpServer"],
    ["tool_info", "mcp_server_name"], ["tool_info", "mcpServerName"]
  ]) || "");
  const tool = String(firstDefined(payload, [
    ["tool"], ["tool_name"], ["toolName"], ["name"],
    ["tool_info", "mcp_tool_name"], ["tool_info", "mcpToolName"]
  ]) || "");
  const input = firstDefined(payload, [
    ["tool_info", "mcp_tool_arguments"], ["tool_info", "mcpToolArguments"],
    ["tool_input"], ["input"], ["args"], ["arguments"]
  ]);
  const taskId = input && typeof input === "object" && typeof input.taskId === "string" ? input.taskId : undefined;
  return { server, tool, input, taskId };
}

async function bindPendingTask(store, trajectoryId, details) {
  const events = await store.readHookEvents(trajectoryId);
  const pending = events.findLast((event) => event.type === "MCP_TASK_BIND_PENDING");
  if (!pending?.taskId || !(await store.taskExists(pending.taskId))) return null;
  await store.appendHookEvent(trajectoryId, "MCP_TASK_BOUND", { taskId: pending.taskId, server: details.server, tool: details.tool });
  return pending.taskId;
}

function discoverGitRoot(directory) {
  const result = spawnSync("git", ["-C", directory, "rev-parse", "--show-toplevel"], {
    encoding: "utf8", windowsHide: true, shell: false, timeout: 3_000
  });
  return result.status === 0 ? String(result.stdout || "").trim() : null;
}

async function bestEffortHookEvent(store, trajectoryId, type, data) {
  try { await store.appendHookEvent(trajectoryId, type, data); } catch {}
}

function testModeBypass(absoluteTarget, env) {
  if (env.DEEPWORK_TEST_MODE !== "1") return false;
  const configured = env.DEEPWORK_PACKAGE_ROOT ? path.resolve(env.DEEPWORK_PACKAGE_ROOT) : PACKAGE_ROOT;
  return isWithin(configured, absoluteTarget);
}

function collectStrings(value, output = [], depth = 0) {
  if (depth > 8 || value === null || value === undefined) return output;
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) for (const item of value.slice(0, 500)) collectStrings(item, output, depth + 1);
  else if (typeof value === "object") for (const child of Object.values(value)) collectStrings(child, output, depth + 1);
  return output;
}

function allow(message, data = undefined) {
  return { allowed: true, exitCode: 0, message, data };
}

function block(message) {
  return { allowed: false, exitCode: 2, message };
}

export async function handleHook({ phase, payload = {}, cwd = process.cwd(), env = process.env }) {
  const hookPhase = normalizePhase(phase || payload.agent_action_name || payload.agentActionName || payload.hook || payload.phase || payload.event);
  const processRoot = await canonicalWorkspaceRoot(cwd, cwd);
  const payloadCwd = firstDefined(payload, [["cwd"], ["working_directory"], ["workingDirectory"], ["tool_info", "cwd"]]);
  const workingRoot = await canonicalWorkspaceRoot(payloadCwd || processRoot, processRoot);
  const workspaceInput = firstDefined(payload, [["workspace_root"], ["workspaceRoot"], ["project_root"], ["projectRoot"]]);
  const discoveredRoot = workspaceInput || env.DEEPWORK_WORKSPACE || discoverGitRoot(workingRoot)
    || (isWithin(processRoot, workingRoot) ? processRoot : workingRoot);
  const stateRoot = await canonicalWorkspaceRoot(discoveredRoot, processRoot);
  if (!isWithin(stateRoot, workingRoot)) return block("Working directory is outside the declared workspace root.");
  const store = new WorkspaceStateStore(stateRoot, { stateHome: env.DEEPWORK_STATE_HOME });
  const trajectoryId = getTrajectory(payload);

  if (["pre_read", "pre_write", "post_read", "post_write"].includes(hookPhase)) {
    const target = getTarget(payload);
    if (!target) return block(`${hookPhase} requires a target file path.`);
    let guarded;
    try {
      const absoluteTarget = path.isAbsolute(target) ? target : path.resolve(workingRoot, target);
      guarded = await guardWorkspacePath(stateRoot, absoluteTarget, {
        allowProtected: false,
        mustExist: hookPhase === "pre_read" || hookPhase === "post_read" || hookPhase === "post_write"
      });
      if (!isWithin(stateRoot, guarded.absolute)) return block("Target path is outside the declared workspace root.");
    } catch (error) {
      return block(error.message);
    }
    const relative = path.relative(stateRoot, guarded.absolute).split(path.sep).join("/");
    let state = null;
    try {
      state = await boundTaskState(store, trajectoryId);
    } catch (error) {
      return block(error.message);
    }
    if (state?.contract) {
      const writePhase = hookPhase === "pre_write" || hookPhase === "post_write";
      const violation = contractPathViolation(relative, state.contract, { enforceAllowed: writePhase });
      if (violation) return block(`Task scope blocked: ${violation}.`);
      if (writePhase && state.plan?.filesToChange?.length) {
        const planViolation = contractPathViolation(relative, { allowedPaths: state.plan.filesToChange }, { enforceAllowed: true });
        if (planViolation) return block(`Current plan scope blocked: ${planViolation}.`);
      }
      if (writePhase && state.plan && !state.plan.filesToChange?.length) {
        return block("Current plan is review-only and permits no file writes.");
      }
    }
    const prior = await store.readHookEvents(trajectoryId);
    if (hookPhase === "pre_write" && !testModeBypass(guarded.absolute, env)) {
      if (!state?.begun || !state?.inspection || !state?.plan) {
        return block("Write blocked: task_begin, inspect_repository, and record_plan must complete first.");
      }
      const repositoryFileCount = Number(state.inspection?.inventory?.fileInventory?.count || 0);
      const requiredReads = Math.min(3, repositoryFileCount);
      const successfulReads = new Set(state.reads || []).size;
      if (successfulReads < requiredReads) {
        return block(`Write blocked: inspect at least ${requiredReads} unique repository file(s) successfully first (${successfulReads} recorded).`);
      }
    }
    if (hookPhase === "pre_read" || hookPhase === "pre_write") {
      return allow(`${hookPhase} allowed`, { path: relative, recorded: false });
    }
    if (!hookSucceeded(payload)) {
      return allow(`${hookPhase} observed an unsuccessful operation; no evidence was recorded.`, { path: relative, recorded: false });
    }
    const eventType = hookPhase === "post_read" ? "HOOK_READ" : "HOOK_WRITE";
    if (eventType === "HOOK_WRITE" || !prior.some((event) => event.type === eventType && event.path === relative)) {
      await store.appendHookEvent(trajectoryId, eventType, { path: relative });
      if (state?.taskId) await store.appendTaskEvent(state.taskId, eventType, { path: relative, trajectoryId });
    }
    return allow(`${hookPhase} recorded successful evidence`, { path: relative, recorded: true });
  }

  if (hookPhase === "pre_run") {
    const command = getCommand(payload);
    const policy = classifyHookCommand(command);
    if (!policy.allowed) {
      await bestEffortHookEvent(store, trajectoryId, "RUN_BLOCKED", { reason: policy.reason });
      return block(`Command blocked: ${policy.reason}.`);
    }
    const executionId = getExecution(payload);
    const normalized = normalizeCommand(command);
    const events = await store.readHookEvents(trajectoryId);
    const attempts = events.filter((event) => event.type === "RUN_ATTEMPT" && event.executionId === executionId && event.normalizedCommand === normalized).length;
    if (attempts >= 2) {
      await bestEffortHookEvent(store, trajectoryId, "RUN_BLOCKED", { executionId, normalizedCommand: normalized, reason: "repeat-command circuit breaker" });
      return block("Command blocked: the same normalized command already ran twice in this execution.");
    }
    await store.appendHookEvent(trajectoryId, "RUN_ATTEMPT", { executionId, normalizedCommand: normalized, attempt: attempts + 1 });
    return allow("pre_run allowed", { attempt: attempts + 1 });
  }

  if (hookPhase === "pre_mcp") {
    const { server, tool, taskId, input } = mcpDetails(payload);
    const deepworkCall = server.toLowerCase() === "deepwork" || (!server && TOOL_NAMES.includes(tool));
    if (deepworkCall) {
      if (tool === "task_begin") {
        if (!taskId) return block("deepwork.task_begin requires an explicit taskId so the Cascade trajectory can be bound safely.");
        const requestedWorkspace = input && typeof input === "object" ? input.workspaceRoot : undefined;
        if (!requestedWorkspace) return block("deepwork.task_begin requires an explicit workspaceRoot.");
        let requestedRoot;
        try { requestedRoot = await canonicalWorkspaceRoot(requestedWorkspace, stateRoot); }
        catch (error) { return block(`deepwork.task_begin workspace blocked: ${error.message}`); }
        if (path.normalize(requestedRoot).toLowerCase() !== path.normalize(stateRoot).toLowerCase()) {
          return block("deepwork.task_begin workspaceRoot must match the hook's current workspace root.");
        }
        await store.appendHookEvent(trajectoryId, "MCP_TASK_BIND_PENDING", { taskId, server, tool });
        return allow("Deepwork task begin allowed; trajectory binding is pending successful completion.");
      }
      let boundTaskId = await store.getTrajectoryTask(trajectoryId);
      if (!boundTaskId) boundTaskId = await bindPendingTask(store, trajectoryId, { server, tool });
      if (!boundTaskId) return block("Deepwork MCP call blocked: this trajectory must successfully call task_begin first.");
      if (!taskId) return block(`Deepwork MCP call blocked: ${tool || "tool"} requires the bound taskId.`);
      if (taskId && taskId !== boundTaskId) return block("Deepwork MCP call blocked: taskId belongs to a different trajectory binding.");
      return allow("Bound Deepwork MCP call allowed.", { taskId: boundTaskId });
    }
    const allowlist = String(env.DEEPWORK_ALLOWED_MCP_TOOLS || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
    const identity = `${server}/${tool}`.toLowerCase();
    if (!allowlist.includes(identity)) {
      await bestEffortHookEvent(store, trajectoryId, "MCP_BLOCKED", { server, tool, reason: "foreign MCP denied by default" });
      return block(`Foreign MCP call blocked by default: ${identity || "unknown tool"} is not explicitly allowlisted.`);
    }
    const touchesControl = collectStrings(payload).some((value) => isAgentControlPath(value));
    if (touchesControl) {
      await bestEffortHookEvent(store, trajectoryId, "MCP_BLOCKED", { server, tool, reason: "protected agent control configuration" });
      return block("MCP call blocked: non-deepwork tools may not modify Windsurf or Devin MCP, hook, or rules configuration.");
    }
    return allow("Explicitly allowlisted foreign MCP call allowed.");
  }

  if (hookPhase === "post_run") {
    await store.appendHookEvent(trajectoryId, "RUN_RESULT", {
      executionId: getExecution(payload),
      success: hookSucceeded(payload),
      exitCode: firstDefined(payload, [["exit_code"], ["exitCode"], ["tool_info", "exit_code"], ["tool_info", "exitCode"]]) ?? null
    });
    return allow("post_run result recorded");
  }

  if (hookPhase === "post_mcp") {
    const details = mcpDetails(payload);
    const server = details.server.slice(0, 128);
    const tool = details.tool.slice(0, 128);
    if ((server.toLowerCase() === "deepwork" || (!server && TOOL_NAMES.includes(tool))) && tool === "task_begin" && hookSucceeded(payload)) {
      await bindPendingTask(store, trajectoryId, details);
    }
    await store.appendHookEvent(trajectoryId, "MCP_RESULT", { server, tool, success: hookSucceeded(payload) });
    return allow("post_mcp result recorded");
  }

  if (hookPhase === "post_response") {
    let state = null;
    try {
      state = await boundTaskState(store, trajectoryId);
    } catch {}
    const transcriptPath = firstDefined(payload, [["transcript_path"], ["transcriptPath"], ["tool_info", "transcript_path"], ["tool_info", "transcriptPath"]]);
    let files;
    try {
      await store.ensureAudit();
      files = await writeTranscriptAudit({
        root: stateRoot,
        auditDirectory: store.auditDir,
        payload,
        trajectoryId,
        taskState: state,
        transcriptPath: typeof transcriptPath === "string" ? transcriptPath : undefined,
        transcriptHome: env.USERPROFILE || env.HOME
      });
    } catch (error) {
      return block(`Transcript audit blocked: ${error.message}`);
    }
    await store.appendHookEvent(trajectoryId, "TRANSCRIPT_AUDITED", { files, taskId: state?.taskId || null });
    return allow("Redacted transcript audit written.", files);
  }

  if (hookPhase.startsWith("pre_")) return block(`Unknown pre-action hook phase: ${hookPhase}.`);
  return allow(`No deepwork policy is registered for hook phase: ${hookPhase || "unknown"}.`);
}
