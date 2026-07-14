import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { canonicalWorkspaceRoot, guardWorkspacePath } from "../security/path-guard.js";
import { redactText, sanitizeForAudit } from "./redact.js";

const TRANSCRIPT_KEYS = /^(?:response|output|transcript|messages|conversation|assistant_response|model_response)$/i;

function transcriptMetadata(payload) {
  const presentFields = [];
  const toolNames = new Set();
  let totalCharacters = 0;
  let messageCount = 0;

  function visit(value, key = "", depth = 0) {
    if (depth > 8 || value === null || value === undefined) return;
    if (typeof value === "string") {
      if (TRANSCRIPT_KEYS.test(key)) {
        presentFields.push(key);
        totalCharacters += value.length;
      }
      return;
    }
    if (Array.isArray(value)) {
      if (/messages|transcript|conversation/i.test(key)) messageCount += value.length;
      for (const item of value.slice(0, 500)) visit(item, key, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    for (const [childKey, child] of Object.entries(value)) {
      if (/^(?:tool|tool_name|toolName)$/i.test(childKey) && typeof child === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(child)) {
        toolNames.add(child);
      }
      visit(child, childKey, depth + 1);
    }
  }
  visit(payload);
  return {
    presentFields: [...new Set(presentFields)].sort(),
    totalCharacters,
    messageCount,
    toolNames: [...toolNames].sort()
  };
}

function addSafe(set, value) {
  if (set.size >= 200 || value === undefined || value === null) return;
  const clean = redactText(String(value)).replace(/[\r\n]/g, " ").slice(0, 300);
  if (clean) set.add(clean);
}

function extractStructuralFields(value, output, depth = 0, parentKey = "") {
  if (depth > 10 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 500)) extractStructuralFields(item, output, depth + 1, parentKey);
    return;
  }
  if (typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:type|event_type|eventType|kind|role)$/.test(key) && typeof child !== "object") addSafe(output.eventTypes, child);
    else if (/^(?:status|result_status|resultStatus)$/.test(key) && typeof child !== "object") addSafe(output.statuses, child);
    else if (/^(?:rule|rule_name|ruleName)$/.test(key) && typeof child !== "object") addSafe(output.rulesApplied, child);
    else if (/^(?:rules_applied|rulesApplied)$/.test(key) && child && typeof child === "object") {
      for (const rule of collectRuleNames(child)) addSafe(output.rulesApplied, rule);
    } else if ((/^(?:file_path|filePath|target_path|targetPath)$/.test(key)
      || (key === "path" && /^(?:code_action|codeAction)$/.test(parentKey))) && typeof child === "string") addSafe(output.filePaths, child);
    else if (/^(?:exit_code|exitCode)$/.test(key) && Number.isFinite(Number(child))) output.exitCodes.add(Number(child));
    else if (/^(?:tool_name|toolName|mcp_tool_name|mcpToolName)$/.test(key) && typeof child === "string") addSafe(output.toolNames, child);
    extractStructuralFields(child, output, depth + 1, key);
  }
}

function collectRuleNames(value, output = [], depth = 0) {
  if (depth > 6 || value === null || value === undefined || output.length >= 200) return output;
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) for (const item of value.slice(0, 200)) collectRuleNames(item, output, depth + 1);
  else if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === "boolean" && child) output.push(key);
      else collectRuleNames(child, output, depth + 1);
    }
  }
  return output;
}

async function transcriptFileMetadata(transcriptPath, homeDirectory) {
  if (!transcriptPath) return { provided: false };
  const home = path.resolve(homeDirectory || os.homedir());
  const transcriptRoot = await canonicalWorkspaceRoot(path.join(home, ".windsurf", "transcripts"), home);
  const guarded = await guardWorkspacePath(transcriptRoot, transcriptPath, { allowProtected: true, mustExist: true });
  const stat = await fs.stat(guarded.absolute);
  if (!stat.isFile()) throw new Error("Windsurf transcript_path must point to a regular file.");

  if (stat.size > 25 * 1024 * 1024) {
    return {
      provided: true,
      sourceFile: redactText(path.basename(guarded.absolute)).slice(0, 300),
      sizeBytes: stat.size,
      lineCount: 0,
      malformedLines: 0,
      truncated: true,
      note: "Transcript exceeded the 25 MiB metadata-audit limit; content was not loaded.",
      eventTypes: [], statuses: [], rulesApplied: [], filePaths: [], exitCodes: [], toolNames: []
    };
  }

  const output = {
    eventTypes: new Set(),
    statuses: new Set(),
    rulesApplied: new Set(),
    filePaths: new Set(),
    exitCodes: new Set(),
    toolNames: new Set()
  };
  let lineCount = 0;
  let malformedLines = 0;
  let truncated = false;
  const input = createReadStream(guarded.absolute, { encoding: "utf8", highWaterMark: 64 * 1024 });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    lineCount += 1;
    if (lineCount > 20_000) {
      truncated = true;
      lines.close();
      input.destroy();
      break;
    }
    if (!line.trim()) continue;
    try {
      extractStructuralFields(JSON.parse(line), output);
    } catch {
      malformedLines += 1;
    }
  }
  return {
    provided: true,
    sourceFile: redactText(path.basename(guarded.absolute)).slice(0, 300),
    sizeBytes: stat.size,
    lineCount: Math.min(lineCount, 20_000),
    malformedLines,
    truncated,
    eventTypes: [...output.eventTypes].sort(),
    statuses: [...output.statuses].sort(),
    rulesApplied: [...output.rulesApplied].sort(),
    filePaths: [...output.filePaths].sort(),
    exitCodes: [...output.exitCodes].sort((a, b) => a - b),
    toolNames: [...output.toolNames].sort()
  };
}

export async function writeTranscriptAudit({ root, auditDirectory, payload, trajectoryId, taskState, transcriptPath, transcriptHome }) {
  auditDirectory ||= path.join(root, ".deepwork", "audits");
  await fs.mkdir(auditDirectory, { recursive: true, mode: 0o700 });
  const createdAt = new Date().toISOString();
  const stem = `${createdAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const audit = sanitizeForAudit({
    version: 1,
    createdAt,
    hook: "post_response",
    trajectoryId: String(trajectoryId || "default").slice(0, 256),
    taskId: taskState?.taskId || null,
    taskStage: taskState?.stage || "not_started",
    repositoryEvidence: {
      inspected: Boolean(taskState?.inspection),
      planRecorded: Boolean(taskState?.plan),
      verificationCount: taskState?.verifications?.length || 0,
      uniqueReads: taskState?.reads?.length || 0,
      uniqueWrites: taskState?.writes?.length || 0,
      finalGate: taskState?.gate?.decision || null
    },
    hookPayloadMetadata: transcriptMetadata(payload),
    transcriptMetadata: await transcriptFileMetadata(transcriptPath, transcriptHome)
  });
  const jsonPath = path.join(auditDirectory, `${stem}.json`);
  const markdownPath = path.join(auditDirectory, `${stem}.md`);
  const markdown = [
    "# Deepwork transcript audit",
    "",
    `- Created: ${audit.createdAt}`,
    `- Trajectory: ${audit.trajectoryId}`,
    `- Task: ${audit.taskId || "none"}`,
    `- Stage: ${audit.taskStage}`,
    `- Inspected: ${audit.repositoryEvidence.inspected}`,
    `- Plan recorded: ${audit.repositoryEvidence.planRecorded}`,
    `- Verifications: ${audit.repositoryEvidence.verificationCount}`,
    `- Unique reads: ${audit.repositoryEvidence.uniqueReads}`,
    `- Unique writes: ${audit.repositoryEvidence.uniqueWrites}`,
    `- Final gate: ${audit.repositoryEvidence.finalGate || "not evaluated"}`,
    "",
    "Transcript content is intentionally omitted. Only redacted structural metadata is recorded.",
    ""
  ].join("\n");
  await fs.writeFile(jsonPath, `${JSON.stringify(audit, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.writeFile(markdownPath, markdown, { encoding: "utf8", mode: 0o600 });
  return {
    json: jsonPath,
    markdown: markdownPath
  };
}
