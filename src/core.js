import os from "node:os";
import path from "node:path";
import { canonicalWorkspaceRoot } from "./security/path-guard.js";
import { WorkspaceStateStore } from "./state/store.js";
import { deriveGitDiffSummary, inspectRepository as buildInventory } from "./inventory.js";
import { runVerificationCommand } from "./verification.js";
import { DeepworkError, invariant } from "./errors.js";
import { contractPathViolation, normalizeScopePattern } from "./security/scope-policy.js";
import { validateVerificationCommand } from "./security/command-policy.js";
import {
  assertCompleteFingerprint,
  createWorkspaceFingerprint,
  fingerprintsEqual
} from "./fingerprint.js";

function samePath(left, right) {
  const a = process.platform === "win32" ? left.toLowerCase() : left;
  const b = process.platform === "win32" ? right.toLowerCase() : right;
  return a === b;
}

function runtimeRoots() {
  const candidates = [
    process.env.DEEPWORK_RUNTIME_ROOT,
    path.join(os.homedir(), ".codeium", "windsurf", "deepwork-runtime")
  ].filter(Boolean);
  return candidates.map((candidate) => path.resolve(candidate));
}

function isInsideRuntime(root) {
  return runtimeRoots().some((runtimeRoot) => {
    const relative = path.relative(runtimeRoot, root);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  });
}

function cleanStrings(values, field) {
  invariant(Array.isArray(values) && values.length > 0, "INVALID_INPUT", `${field} must contain at least one item`);
  const clean = values.map((value) => String(value || "").trim()).filter(Boolean);
  invariant(clean.length === values.length, "INVALID_INPUT", `${field} cannot contain blank items`);
  invariant(new Set(clean).size === clean.length, "INVALID_INPUT", `${field} cannot contain duplicates`);
  return clean;
}

function cleanOptionalStrings(values, field) {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length === 0) return [];
  return cleanStrings(values, field);
}

export class DeepworkEngine {
  static async create(options = {}) {
    const requested = options.baseRoot || process.env.DEEPWORK_WORKSPACE || process.cwd();
    const baseRoot = await canonicalWorkspaceRoot(requested, process.cwd());
    return new DeepworkEngine(baseRoot);
  }

  constructor(baseRoot) {
    this.baseRoot = baseRoot;
    this.registry = new WorkspaceStateStore(baseRoot);
    this.taskRoots = new Map();
  }

  async resolveChosenRoot(workspaceRoot) {
    return canonicalWorkspaceRoot(workspaceRoot || process.env.DEEPWORK_WORKSPACE || this.baseRoot, this.baseRoot);
  }

  async resolveTask(taskId, explicitRoot = undefined) {
    invariant(typeof taskId === "string" && taskId, "INVALID_TASK_ID", "taskId is required");
    let root;
    if (explicitRoot) {
      root = await this.resolveChosenRoot(explicitRoot);
      const known = this.taskRoots.get(taskId) || await this.registry.findTaskRoot(taskId);
      invariant(!known || samePath(root, known), "WORKSPACE_MISMATCH", "workspaceRoot does not match the task's persisted workspace");
    } else {
      root = this.taskRoots.get(taskId) || await this.registry.findTaskRoot(taskId);
      if (!root) {
        const baseStore = new WorkspaceStateStore(this.baseRoot);
        if (await baseStore.taskExists(taskId)) root = this.baseRoot;
      }
      invariant(root, "TASK_NOT_FOUND", `Unknown task: ${taskId}`);
      root = await canonicalWorkspaceRoot(root);
    }
    const store = new WorkspaceStateStore(root);
    invariant(await store.taskExists(taskId), "TASK_NOT_FOUND", `Unknown task: ${taskId}`);
    this.taskRoots.set(taskId, root);
    return { root, store };
  }

  async taskBegin({
    objective,
    acceptanceCriteria,
    nonGoals,
    constraints,
    allowedPaths,
    protectedPaths,
    assumptions,
    workspaceRoot,
    taskId
  }) {
    invariant(typeof workspaceRoot === "string" && workspaceRoot.trim(), "INVALID_WORKSPACE", "task_begin requires an explicit workspaceRoot");
    invariant(typeof taskId === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(taskId), "INVALID_TASK_ID", "task_begin requires an explicit safe taskId");
    const root = await this.resolveChosenRoot(workspaceRoot);
    invariant(!isInsideRuntime(root), "INVALID_WORKSPACE", "The installed deepwork runtime cannot be used as the user workspace");
    const store = new WorkspaceStateStore(root);
    invariant(!(await store.taskExists(taskId)), "TASK_EXISTS", `Task already exists: ${taskId}`);
    const cleanObjective = String(objective || "").trim();
    invariant(cleanObjective.length >= 3, "INVALID_INPUT", "objective must be at least 3 characters");
    const criteria = cleanStrings(acceptanceCriteria, "acceptanceCriteria");
    const contract = {
      nonGoals: cleanOptionalStrings(nonGoals, "nonGoals"),
      constraints: cleanOptionalStrings(constraints, "constraints"),
      allowedPaths: cleanOptionalStrings(allowedPaths, "allowedPaths").map((value) => normalizeScopePattern(value, "allowedPaths")),
      protectedPaths: cleanOptionalStrings(protectedPaths, "protectedPaths").map((value) => normalizeScopePattern(value, "protectedPaths")),
      assumptions: cleanOptionalStrings(assumptions, "assumptions")
    };
    const baselineGit = deriveGitDiffSummary(root);
    await store.appendTaskEvent(taskId, "TASK_BEGUN", {
      taskId,
      objective: cleanObjective,
      acceptanceCriteria: criteria,
      ...contract,
      baselineGit,
      workspaceRoot: root
    });
    await store.setActiveTask(taskId);
    await this.registry.registerTaskRoot(taskId, root);
    if (!samePath(root, this.baseRoot)) await store.registerTaskRoot(taskId, root);
    this.taskRoots.set(taskId, root);
    return { ok: true, taskId, workspaceRoot: root, stage: "begun", acceptanceCriteria: criteria, contract };
  }

  async inspectRepository({ taskId, workspaceRoot }) {
    const { root, store } = await this.resolveTask(taskId, workspaceRoot);
    const state = await store.getTaskState(taskId);
    invariant(state.begun, "INVALID_STATE", "task_begin must run before inspection");
    const inventory = await buildInventory(root);
    await store.appendTaskEvent(taskId, "INSPECTION_COMPLETED", { inventory });
    return { ok: true, taskId, inventory };
  }

  async recordPlan({ taskId, steps, risks = [], filesToChange, verificationCommands }) {
    const { store } = await this.resolveTask(taskId);
    const state = await store.getTaskState(taskId);
    invariant(state.inspection, "INVALID_STATE", "inspect_repository must complete before record_plan");
    invariant(Array.isArray(steps) && steps.length > 0, "INVALID_INPUT", "steps must contain at least one plan step");
    const normalizedSteps = steps.map((step, index) => ({
      id: String(step.id || index + 1).trim(),
      description: String(step.description || "").trim(),
      status: step.status || "pending"
    }));
    invariant(normalizedSteps.every((step) => step.id && step.description), "INVALID_INPUT", "Every plan step needs an id and description");
    invariant(new Set(normalizedSteps.map((step) => step.id)).size === normalizedSteps.length, "INVALID_INPUT", "Plan step ids must be unique");
    invariant(normalizedSteps.filter((step) => step.status === "in_progress").length <= 1, "INVALID_INPUT", "At most one plan step may be in progress");
    const normalizedRisks = Array.isArray(risks) ? risks.map((risk) => String(risk).trim()).filter(Boolean) : [];
    invariant(Array.isArray(filesToChange), "INVALID_INPUT", "filesToChange must be an array; use an empty array for review-only work");
    const normalizedFiles = filesToChange.length
      ? cleanStrings(filesToChange, "filesToChange").map((value) => normalizeScopePattern(value, "filesToChange"))
      : [];
    for (const file of normalizedFiles) {
      const violation = contractPathViolation(file, state.begun);
      invariant(!violation, "SCOPE_VIOLATION", violation);
    }
    const normalizedCommands = cleanStrings(verificationCommands, "verificationCommands")
      .map((command) => validateVerificationCommand(command).normalized);
    invariant(new Set(normalizedCommands).size === normalizedCommands.length, "INVALID_INPUT", "verificationCommands cannot contain normalized duplicates");
    await store.appendTaskEvent(taskId, "PLAN_RECORDED", {
      steps: normalizedSteps,
      risks: normalizedRisks,
      filesToChange: normalizedFiles,
      verificationCommands: normalizedCommands
    });
    return {
      ok: true,
      taskId,
      stage: "planned",
      steps: normalizedSteps,
      risks: normalizedRisks,
      filesToChange: normalizedFiles,
      verificationCommands: normalizedCommands
    };
  }

  async runVerification({ taskId, command, timeoutMs, noTestsEvidence }) {
    const { root, store } = await this.resolveTask(taskId);
    const state = await store.getTaskState(taskId);
    invariant(state.plan, "INVALID_STATE", "record_plan must complete before run_verification");
    const hasCommand = typeof command === "string" && command.trim();
    const hasEvidence = typeof noTestsEvidence === "string" && noTestsEvidence.trim();
    invariant(Boolean(hasCommand) !== Boolean(hasEvidence), "INVALID_INPUT", "Provide exactly one of command or noTestsEvidence");
    if (hasEvidence) {
      const evidence = noTestsEvidence.trim();
      invariant(evidence.length >= 20, "INSUFFICIENT_EVIDENCE", "No-tests evidence must be a specific explanation of at least 20 characters");
      const fingerprintBefore = await createWorkspaceFingerprint(root);
      const fingerprintAfter = await createWorkspaceFingerprint(root);
      invariant(fingerprintsEqual(fingerprintBefore, fingerprintAfter), "FINGERPRINT_UNSTABLE", "Workspace changed while no-tests evidence was recorded");
      await store.appendTaskEvent(taskId, "VERIFICATION_SKIPPED", {
        noTestsEvidence: evidence,
        fingerprintBefore,
        fingerprintAfter
      });
      return { ok: true, taskId, skipped: true, noTestsEvidence: evidence, fingerprint: fingerprintAfter };
    }
    const requestedCommand = command.trim();
    const normalizedCommand = validateVerificationCommand(requestedCommand).normalized;
    invariant(
      state.plan.verificationCommands.includes(normalizedCommand),
      "COMMAND_NOT_PLANNED",
      `Verification command is not in the current plan: ${normalizedCommand}`
    );
    const fingerprintBefore = await createWorkspaceFingerprint(root);
    const commandResult = await runVerificationCommand({ command: requestedCommand, cwd: root, timeoutMs });
    let fingerprintAfter;
    try {
      fingerprintAfter = await createWorkspaceFingerprint(root);
    } catch (error) {
      const result = {
        ...commandResult,
        normalizedCommand,
        commandPassed: commandResult.passed,
        passed: false,
        workspaceMutationDetected: null,
        fingerprintComplete: false,
        fingerprintBefore,
        fingerprintAfter: null,
        fingerprintError: { code: error?.code || "FINGERPRINT_INCOMPLETE", message: error?.message || "Fingerprint failed" }
      };
      await store.appendTaskEvent(taskId, "VERIFICATION_COMPLETED", { result });
      throw error;
    }
    const workspaceMutationDetected = !fingerprintsEqual(fingerprintBefore, fingerprintAfter);
    const result = {
      ...commandResult,
      normalizedCommand,
      commandPassed: commandResult.passed,
      passed: commandResult.passed && !workspaceMutationDetected,
      workspaceMutationDetected,
      fingerprintComplete: true,
      fingerprintBefore,
      fingerprintAfter
    };
    await store.appendTaskEvent(taskId, "VERIFICATION_COMPLETED", { result });
    return { ok: result.passed, taskId, skipped: false, result };
  }

  async taskStatus({ taskId }) {
    const { store } = await this.resolveTask(taskId);
    return { ok: true, state: await store.getTaskState(taskId) };
  }

  async finalGate({ taskId, acceptanceEvidence, diffSummary }) {
    const { root, store } = await this.resolveTask(taskId);
    const events = await store.readTaskEvents(taskId);
    const state = await store.getTaskState(taskId);
    const failures = [];
    if (!state.inspection) failures.push("repository inspection is missing");
    if (!state.plan) failures.push("recorded plan is missing");

    const summary = String(diffSummary || "").trim();
    if (summary.length < 10) failures.push("diff summary must specifically describe the resulting changes");

    const evidenceItems = Array.isArray(acceptanceEvidence) ? acceptanceEvidence.map((item) => ({
      criterion: String(item.criterion || "").trim(),
      kind: String(item.kind || "").trim(),
      evidence: String(item.evidence || "").trim()
    })) : [];
    for (const criterion of state.acceptanceCriteria) {
      const match = evidenceItems.find((item) => item.criterion === criterion && item.evidence.length >= 3);
      if (!match) failures.push(`acceptance criterion lacks evidence: ${criterion}`);
    }

    const lastWriteIndex = events.findLastIndex((event) => event.type === "HOOK_WRITE");
    const planIndex = events.findLastIndex((event) => event.type === "PLAN_RECORDED");
    const baseline = Math.max(lastWriteIndex, planIndex);
    const partialReasons = [];
    for (const item of evidenceItems) {
      if (!["command", "file", "manual"].includes(item.kind)) failures.push(`acceptance evidence has an invalid kind: ${item.criterion}`);
      if (item.kind === "manual") partialReasons.push(`acceptance criterion relies on manual evidence: ${item.criterion}`);
    }
    const currentFingerprint = await createWorkspaceFingerprint(root);
    assertCompleteFingerprint(currentFingerprint);
    const plannedCommands = state.plan?.verificationCommands || [];
    for (const plannedCommand of plannedCommands) {
      const latest = events
        .map((event, index) => ({ event, index }))
        .filter(({ event, index }) => index > baseline
          && event.type === "VERIFICATION_COMPLETED"
          && event.result?.normalizedCommand === plannedCommand)
        .at(-1)?.event;
      if (!latest) {
        failures.push(`planned verification has not run after the current baseline: ${plannedCommand}`);
        continue;
      }
      if (!latest.result?.passed) {
        failures.push(latest.result?.workspaceMutationDetected
          ? `planned verification mutated fingerprinted workspace state: ${plannedCommand}`
          : `latest planned verification did not pass: ${plannedCommand}`);
        continue;
      }
      assertCompleteFingerprint(latest.result.fingerprintBefore);
      assertCompleteFingerprint(latest.result.fingerprintAfter);
      if (!fingerprintsEqual(latest.result.fingerprintBefore, latest.result.fingerprintAfter)) {
        failures.push(`planned verification changed fingerprinted workspace state: ${plannedCommand}`);
        continue;
      }
      if (!fingerprintsEqual(latest.result.fingerprintAfter, currentFingerprint)) {
        failures.push(`workspace changed after planned verification: ${plannedCommand}`);
      }
    }
    const skipped = events
      .map((event, index) => ({ event, index }))
      .filter(({ event, index }) => index > baseline && event.type === "VERIFICATION_SKIPPED")
      .at(-1)?.event;
    if (skipped) {
      if (String(skipped.noTestsEvidence || "").length < 20) failures.push("no-tests evidence is insufficient");
      else partialReasons.push("no-tests evidence cannot replace any verification command recorded in the current plan");
    }

    const actualDiff = deriveGitDiffSummary(root);
    if (!actualDiff.detected) {
      partialReasons.push("Git is unavailable; final changed-path scope cannot be independently verified");
    } else if (!actualDiff.scopeComplete || actualDiff.truncated) {
      failures.push("Git changed-path scope is incomplete or truncated");
    } else {
      const baselinePaths = new Set(state.begun?.baselineGit?.changedPaths || []);
      const newChangedPaths = actualDiff.changedPaths.filter((changedPath) => !baselinePaths.has(changedPath));
      for (const changedPath of newChangedPaths) {
        const contractViolation = contractPathViolation(changedPath, state.contract || {}, { enforceAllowed: true });
        if (contractViolation) failures.push(`actual diff violates task contract: ${contractViolation}`);
        if (!(state.plan?.filesToChange || []).length) failures.push(`actual diff violates review-only plan: ${changedPath}`);
        else {
          const planViolation = contractPathViolation(changedPath, { allowedPaths: state.plan.filesToChange }, { enforceAllowed: true });
          if (planViolation) failures.push(`actual diff violates current plan: ${planViolation}`);
        }
      }
    }
    const decision = failures.length ? "REFUSE" : partialReasons.length ? "PARTIAL" : "PASS";
    await store.appendTaskEvent(taskId, "FINAL_GATE_EVALUATED", {
      decision,
      failures,
      partialReasons,
      diffSummary: summary,
      actualDiff,
      acceptanceEvidence: evidenceItems,
      currentFingerprint
    });
    return {
      ok: decision === "PASS",
      decision,
      taskId,
      failures,
      partialReasons,
      actualDiff,
      message: decision === "PASS"
        ? "Quality gate passed."
        : decision === "PARTIAL"
          ? "Evidence is partial. Run an executable verification command to earn PASS."
          : "Final answer refused until every quality gate is satisfied."
    };
  }

  async appendTrackedPath(taskId, type, relativePath, trajectoryId) {
    const { store } = await this.resolveTask(taskId);
    invariant(type === "HOOK_READ" || type === "HOOK_WRITE", "INVALID_EVENT", "Unsupported tracked path event");
    return store.appendTaskEvent(taskId, type, { path: relativePath, trajectoryId });
  }
}

export { DeepworkError };
