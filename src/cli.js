#!/usr/bin/env node
import process from "node:process";
import { pathToFileURL } from "node:url";
import { startStdioServer } from "./server.js";
import { runDoctor } from "./doctor.js";
import { canonicalWorkspaceRoot } from "./security/path-guard.js";
import { inspectRepository } from "./inventory.js";
import { DeepworkEngine } from "./core.js";
import { WorkspaceStateStore } from "./state/store.js";
import { handleHook } from "./hooks.js";
import { redactText, safeError } from "./audit/redact.js";

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function parseWorkspace(args) {
  const index = args.findIndex((arg) => arg === "--workspace" || arg === "-w");
  if (index < 0) return { workspaceRoot: undefined, remaining: args };
  return { workspaceRoot: args[index + 1], remaining: args.filter((_, itemIndex) => itemIndex !== index && itemIndex !== index + 1) };
}

export async function runCli(argv = process.argv.slice(2)) {
  const [command = "doctor", ...rawArgs] = argv;
  const { workspaceRoot, remaining } = parseWorkspace(rawArgs);
  if (command === "server") {
    await startStdioServer({ baseRoot: workspaceRoot });
    return 0;
  }
  if (command === "doctor") {
    const report = await runDoctor({ workspaceRoot: workspaceRoot || remaining[0] });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.ok ? 0 : 1;
  }
  if (command === "inspect") {
    const root = await canonicalWorkspaceRoot(workspaceRoot || remaining[0] || process.env.DEEPWORK_WORKSPACE || process.cwd());
    process.stdout.write(`${JSON.stringify(await inspectRepository(root), null, 2)}\n`);
    return 0;
  }
  if (command === "status") {
    const root = await canonicalWorkspaceRoot(workspaceRoot || process.env.DEEPWORK_WORKSPACE || process.cwd());
    let taskIdValue = remaining[0];
    if (!taskIdValue) taskIdValue = (await new WorkspaceStateStore(root).getActiveTask())?.taskId;
    if (!taskIdValue) throw new Error("status requires a taskId or an active task in this workspace");
    const engine = await DeepworkEngine.create({ baseRoot: root });
    process.stdout.write(`${JSON.stringify(await engine.taskStatus({ taskId: taskIdValue }), null, 2)}\n`);
    return 0;
  }
  if (command === "hook") {
    const raw = await readStdin();
    let payload = {};
    if (raw.trim()) {
      try {
        payload = JSON.parse(raw);
      } catch {
        process.stderr.write("Deepwork hook blocked: stdin is not valid JSON.\n");
        return 2;
      }
    }
    let hookResult;
    try {
      hookResult = await handleHook({
        phase: remaining[0] || payload.agent_action_name || payload.agentActionName,
        payload,
        cwd: process.cwd(),
        env: process.env
      });
    } catch (error) {
      const phase = String(remaining[0] || payload.agent_action_name || payload.agentActionName || "").toLowerCase();
      const preAction = phase.startsWith("pre_") || phase.startsWith("before_");
      process.stderr.write(`Deepwork hook ${preAction ? "blocked" : "failed"}: ${safeError(error).message}\n`);
      return preAction ? 2 : 0;
    }
    if (!hookResult.allowed) {
      process.stderr.write(`Deepwork hook blocked: ${redactText(hookResult.message)}\n`);
      return 2;
    }
    process.stdout.write(`${JSON.stringify({ allowed: true, message: hookResult.message, data: hookResult.data })}\n`);
    return 0;
  }
  process.stderr.write("Usage: deepwork <server|doctor|inspect|status|hook> [options]\n");
  return 1;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  runCli().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    const safe = safeError(error);
    process.stderr.write(`deepwork: ${safe.message}\n`);
    process.exitCode = 1;
  });
}
