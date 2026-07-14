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

async function readStdinBuffer() {
  if (process.stdin.isTTY) return Buffer.alloc(0);
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function swapUtf16Bytes(buffer) {
  const length = buffer.length - (buffer.length % 2);
  const swapped = Buffer.allocUnsafe(length);
  for (let index = 0; index < length; index += 2) {
    swapped[index] = buffer[index + 1];
    swapped[index + 1] = buffer[index];
  }
  return swapped;
}

function looksLikeUtf16(buffer, nullOffset) {
  const length = Math.min(buffer.length - (buffer.length % 2), 512);
  if (length < 4) return false;
  const pairs = length / 2;
  let expectedNulls = 0;
  let otherNulls = 0;
  for (let index = 0; index < length; index += 2) {
    if (buffer[index + nullOffset] === 0) expectedNulls += 1;
    if (buffer[index + (1 - nullOffset)] === 0) otherNulls += 1;
  }
  return expectedNulls / pairs >= 0.6 && otherNulls / pairs <= 0.2;
}

export function decodeStdinBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return "";
  let decoded;
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    decoded = buffer.subarray(3).toString("utf8");
  } else if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    decoded = buffer.subarray(2).toString("utf16le");
  } else if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    decoded = swapUtf16Bytes(buffer.subarray(2)).toString("utf16le");
  } else if (looksLikeUtf16(buffer, 1)) {
    decoded = buffer.toString("utf16le");
  } else if (looksLikeUtf16(buffer, 0)) {
    decoded = swapUtf16Bytes(buffer).toString("utf16le");
  } else {
    decoded = buffer.toString("utf8");
  }
  return decoded.replace(/^\uFEFF/, "");
}

function probeEncodingMetadata(buffer) {
  let evenNulls = 0;
  let oddNulls = 0;
  for (let index = 0; index < Math.min(buffer.length, 512); index += 1) {
    if (buffer[index] !== 0) continue;
    if (index % 2 === 0) evenNulls += 1;
    else oddNulls += 1;
  }
  return `bytes=${buffer.length},utf8Bom=${buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))},utf16leBom=${buffer.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))},utf16beBom=${buffer.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))},evenNulls=${evenNulls},oddNulls=${oddNulls},systemByteArray=${buffer.equals(Buffer.from("System.Byte[]"))},systemObject=${buffer.equals(Buffer.from("System.Object"))},systemString=${buffer.equals(Buffer.from("System.String"))}`;
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
    const inputBuffer = await readStdinBuffer();
    const raw = decodeStdinBuffer(inputBuffer);
    let payload = {};
    if (raw.trim()) {
      try {
        payload = JSON.parse(raw);
      } catch {
        if (process.env.DEEPWORK_INSTALL_PROBE === "1") {
          process.stderr.write(`Deepwork hook probe encoding: ${probeEncodingMetadata(inputBuffer)}\n`);
        }
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
