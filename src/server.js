import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DeepworkEngine } from "./core.js";
import { safeError } from "./audit/redact.js";

export const TOOL_NAMES = Object.freeze([
  "task_begin",
  "inspect_repository",
  "record_research",
  "record_design",
  "record_plan",
  "record_checkpoint",
  "run_verification",
  "record_review",
  "task_status",
  "final_gate"
]);

const taskId = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
const requiredWorkspaceRoot = z.string().min(1).max(4096);
const optionalWorkspaceRoot = requiredWorkspaceRoot.optional();
const boundedStrings = z.array(z.string().min(1).max(4_000)).max(100).optional();

function result(value, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {})
  };
}

function handler(callback) {
  return async (input) => {
    try {
      return result(await callback(input));
    } catch (error) {
      return result({ ok: false, error: safeError(error) }, true);
    }
  };
}

export async function createDeepworkServer(options = {}) {
  const engine = options.engine || await DeepworkEngine.create(options);
  const server = new McpServer(
    { name: "deepwork", version: "0.2.0" },
    {
      capabilities: { tools: { listChanged: false } },
      instructions: "Use the ten Deepwork tools as an evidence pipeline: begin, inspect, research, design, plan, checkpoint, verify, review, status, final gate. Max effort intentionally requires multiple independent passes. final_gate is authoritative and may refuse a premature answer."
    }
  );

  server.registerTool("task_begin", {
    title: "Begin a quality-gated task",
    description: "Record the objective, acceptance criteria, and canonical workspace before repository work begins.",
    inputSchema: z.object({
      objective: z.string().min(3).max(20_000),
      acceptanceCriteria: z.array(z.string().min(1).max(4_000)).min(1).max(100),
      nonGoals: boundedStrings,
      constraints: boundedStrings,
      allowedPaths: boundedStrings,
      protectedPaths: boundedStrings,
      assumptions: boundedStrings,
      completionCondition: z.string().min(1).max(4_000).optional(),
      effortProfile: z.enum(["standard", "thorough", "max"]).optional(),
      workspaceRoot: requiredWorkspaceRoot,
      taskId
    }),
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, handler((input) => engine.taskBegin(input)));

  server.registerTool("inspect_repository", {
    title: "Inspect the repository",
    description: "Create a deterministic, concise inventory using ripgrep, Git, manifests, and a symlink/junction scan.",
    inputSchema: z.object({ taskId, workspaceRoot: optionalWorkspaceRoot }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, handler((input) => engine.inspectRepository(input)));

  server.registerTool("record_research", {
    title: "Record independent research lanes",
    description: "Persist distinct codebase exploration passes, their key files, contradictions, and open questions before architecture selection.",
    inputSchema: z.object({
      taskId,
      lanes: z.array(z.object({
        id: z.union([z.string().min(1).max(128), z.number().int().nonnegative()]).optional(),
        focus: z.string().min(3).max(4_000),
        findings: z.array(z.string().min(1).max(4_000)).min(1).max(100),
        keyFiles: z.array(z.string().min(1).max(4_000)).min(1).max(100),
        unknowns: boundedStrings
      })).min(1).max(10),
      contradictions: boundedStrings,
      openQuestions: boundedStrings
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, handler((input) => engine.recordResearch(input)));

  server.registerTool("record_design", {
    title: "Record an architecture decision",
    description: "Compare concrete implementation alternatives and persist the selected design, trade-offs, resolved questions, and approval basis.",
    inputSchema: z.object({
      taskId,
      alternatives: z.array(z.object({
        id: z.union([z.string().min(1).max(128), z.number().int().nonnegative()]).optional(),
        title: z.string().min(3).max(4_000),
        summary: z.string().min(10).max(20_000),
        tradeoffs: z.array(z.string().min(1).max(4_000)).min(1).max(100),
        files: boundedStrings
      })).min(1).max(10),
      selectedId: z.union([z.string().min(1).max(128), z.number().int().nonnegative()]),
      selectionRationale: z.string().min(3).max(20_000),
      approvalEvidence: z.string().min(3).max(20_000),
      resolvedQuestions: boundedStrings,
      unresolvedQuestions: boundedStrings
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, handler((input) => engine.recordDesign(input)));

  server.registerTool("record_plan", {
    title: "Record an implementation plan",
    description: "Persist a concrete plan after inspection and before any write is allowed.",
    inputSchema: z.object({
      taskId,
      steps: z.array(z.object({
        id: z.union([z.string().min(1).max(128), z.number().int().nonnegative()]).optional(),
        description: z.string().min(1).max(4_000),
        status: z.enum(["pending", "in_progress", "completed"]).optional()
      })).min(1).max(200),
      risks: z.array(z.string().min(1).max(4_000)).max(100).optional(),
      filesToChange: z.array(z.string().min(1).max(4_000)).max(500),
      verificationCommands: z.array(z.string().min(1).max(8_000)).min(1).max(100),
      acceptanceMap: z.array(z.object({
        criterion: z.string().min(1).max(4_000),
        stepIds: z.array(z.string().min(1).max(128)).min(1).max(200),
        verificationCommands: z.array(z.string().min(1).max(8_000)).max(100).optional()
      })).max(200).optional(),
      rollbackPlan: z.string().max(20_000).optional()
    }),
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, handler((input) => engine.recordPlan(input)));

  server.registerTool("record_checkpoint", {
    title: "Record a durable task checkpoint",
    description: "Snapshot the workspace fingerprint, Git state, completed plan steps, remaining work, and a recovery summary after a coherent unit.",
    inputSchema: z.object({
      taskId,
      label: z.string().min(3).max(256),
      summary: z.string().min(20).max(20_000),
      completedStepIds: z.array(z.string().min(1).max(128)).max(200),
      remainingStepIds: z.array(z.string().min(1).max(128)).max(200)
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, handler((input) => engine.recordCheckpoint(input)));

  server.registerTool("run_verification", {
    title: "Run a constrained verification command",
    description: "Execute one planned test/lint/check/build command from the untrusted repository without a shell, fingerprinting the workspace before and after. Repository-controlled code can spawn processes, access the network, or destructively mutate files; a detected mutation makes verification fail. Alternatively, record specific evidence that no executable tests apply.",
    inputSchema: z.object({
      taskId,
      command: z.string().min(1).max(8_000).optional(),
      timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
      noTestsEvidence: z.string().min(20).max(20_000).optional()
    }).refine((value) => Boolean(value.command) !== Boolean(value.noTestsEvidence), {
      message: "Provide exactly one of command or noTestsEvidence"
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }, handler((input) => engine.runVerification(input)));

  server.registerTool("record_review", {
    title: "Record specialized review passes",
    description: "Persist high-confidence correctness, test, security, error-handling, and simplicity reviews against the current workspace fingerprint.",
    inputSchema: z.object({
      taskId,
      reviews: z.array(z.object({
        focus: z.enum(["correctness", "tests", "security", "error-handling", "simplicity"]),
        reviewer: z.string().min(3).max(4_000),
        verdict: z.enum(["pass", "issues"]),
        findings: z.array(z.object({
          severity: z.enum(["critical", "high", "medium", "low", "info"]),
          confidence: z.number().int().min(80).max(100),
          issue: z.string().min(5).max(4_000),
          evidence: z.string().min(5).max(20_000),
          status: z.enum(["open", "resolved", "accepted", "false-positive"]),
          resolution: z.string().max(20_000).optional()
        })).max(100),
        uncertainties: boundedStrings
      })).min(1).max(10),
      summary: z.string().min(20).max(20_000)
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, handler((input) => engine.recordReview(input)));

  server.registerTool("task_status", {
    title: "Read task status",
    description: "Return the append-only evidence state and current quality-gate stage for a task.",
    inputSchema: z.object({ taskId }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, handler((input) => engine.taskStatus(input)));

  server.registerTool("final_gate", {
    title: "Evaluate the final quality gate",
    description: "Refuse PASS unless inspection, plan, post-change verification, diff summary, and every acceptance-evidence item exist.",
    inputSchema: z.object({
      taskId,
      acceptanceEvidence: z.array(z.object({
        criterion: z.string().min(1).max(4_000),
        kind: z.enum(["command", "file", "manual"]),
        evidence: z.string().min(3).max(20_000)
      })).max(200),
      diffSummary: z.string().min(1).max(20_000)
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, handler((input) => engine.finalGate(input)));

  return { server, engine };
}

export async function startStdioServer(options = {}) {
  const { server } = await createDeepworkServer(options);
  await server.connect(new StdioServerTransport());
  return server;
}
